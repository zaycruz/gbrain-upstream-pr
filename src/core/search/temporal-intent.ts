/**
 * Temporal intent parser (raava/prod WS5a).
 *
 * The post-ontology eval left 21 misses; the dominant cluster is
 * date-scoped queries that match on word overlap instead of resolving
 * against the corpus's date structure (2,473 date-stamped slugs, typed
 * pages with effective_date). This parser extracts a deterministic
 * temporal resolution from the original query. Zero LLM, never throws.
 *
 * Shapes (resolution is the recall arm's job — see temporal-recall.ts):
 *
 *  1. exact_date — "daily report august 3 2026", "brain ops daily report
 *     july 20 2026". A specific calendar date plus an optional type or
 *     slug-family hint.
 *  2. month_window — "decisions in july 2026", "which reports are about
 *     brain health in july". A [month, month+1) window plus optional type
 *     hint.
 *  3. superlative — "newest decision", "most recent brain daily report",
 *     "latest brain health status". Order by effective_date desc within an
 *     optional type.
 *  4. relative_window — "what changed in the brain this week", "recent
 *     gbrain escalations". A trailing N-day window ending today.
 *
 * Everything else returns null and the caller falls through unchanged.
 */

export interface TemporalQuery {
  kind: 'exact_date' | 'month_window' | 'superlative' | 'relative_window';
  /** exact_date / month_window: ISO bounds [since, until) — until exclusive. */
  since?: string;
  until?: string;
  /** relative_window: trailing window length in days (ends at now). */
  days?: number;
  /**
   * Optional type hint resolved against the pack's declared page types
   * (e.g. 'decision' from "newest decision"). Undefined when the query
   * names a slug family ("daily report") instead of a pack type.
   */
  pageType?: string;
  /**
   * Optional slug-family hint for exact_date probes ("daily report" →
   * probe `%daily-report-2026-08-03%`). Lowercase, space-normalized; the
   * recall arm hyphenates for the LIKE probe.
   */
  slugFamily?: string;
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8,
  oct: 9, nov: 10, dec: 11,
};

/** Slug families that carry ISO dates in the slug (date-addressable). */
const SLUG_FAMILY_RE =
  /\b(daily\s+reports?|brain\s+health|run-?logs?|journals?|meeting\s+notes?|meetings?|escalations?)\b/i;

/** Type-hint nouns that resolve against the pack vocabulary. */
function extractTypeHint(q: string, packTypes: ReadonlySet<string>): string | undefined {
  const m = q.match(
    /\b(decisions?|lessons?|meetings?|reports?|run-?logs?|escalations?|theses|atoms?|notes?|plans?|reviews?|memos?)\b/i,
  );
  if (!m || !m[1]) return undefined;
  const w = m[1].toLowerCase().replace(/-/g, '_');
  // Naive singular forms, most-specific first (theses→thesis before s-strip).
  const forms = [w];
  if (w.endsWith('ies') && w.length > 3) forms.push(`${w.slice(0, -3)}y`);
  if (w.endsWith('ses') && w.length > 3) forms.push(`${w.slice(0, -3)}sis`);
  if (w.endsWith('es') && w.length > 2) forms.push(w.slice(0, -2));
  if (w.endsWith('s') && w.length > 1) forms.push(w.slice(0, -1));
  for (const f of forms) {
    if (packTypes.has(f)) return f;
  }
  // "escalations" etc. may not be a pack type; report → run-log/daily-report
  // slug families are handled by SLUG_FAMILY_RE instead.
  return undefined;
}

function isoDate(y: number, m: number, d: number): string {
  return `${y.toString().padStart(4, '0')}-${(m + 1).toString().padStart(2, '0')}-${d
    .toString()
    .padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

// "august 3 2026" / "august 3, 2026" / "august 3" (year inferred below)
const MONTH_DAY_YEAR_RE =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i;
// ISO in the query itself: "2026-08-03"
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
// "in july 2026" / "in july" — month window (not exact when a day follows)
const MONTH_WINDOW_RE =
  /\b(?:in|during|from)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s+(\d{4}))?\b/i;
// "newest decision" / "most recent report" / "latest status"
const SUPERLATIVE_RE = /\b(newest|most\s+recent|latest|current|last)\b/i;
// "this week" / "this month" / "recent" / "recently" / "today"
const RELATIVE_RE =
  /\b(this\s+week|this\s+month|this\s+year|recent(?:ly)?|today|yesterday|lately)\b/i;

/**
 * Parse a query into a TemporalQuery, or null when it isn't temporal.
 * `packTypes` is the active schema pack's declared page_types (lowercase).
 * `now` is injectable for tests.
 */
export function parseTemporalQuery(
  query: string,
  packTypes: ReadonlySet<string>,
  now: Date = new Date(),
): TemporalQuery | null {
  const q = (query ?? '').trim();
  if (q.length === 0 || q.length > 200) return null;

  const typeHint = extractTypeHint(q, packTypes);
  const fam = q.match(SLUG_FAMILY_RE);
  const slugFamily = fam?.[1]?.toLowerCase().replace(/\s+/g, ' ');

  // 1. ISO date in the query — unambiguous exact date.
  const iso = q.match(ISO_DATE_RE);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]) - 1;
    const d = Number(iso[3]);
    if (m >= 0 && m < 12 && d >= 1 && d <= daysInMonth(y, m)) {
      const since = isoDate(y, m, d);
      const until = isoDate(...nextDay(y, m, d));
      return { kind: 'exact_date', since, until, pageType: typeHint, slugFamily };
    }
  }

  // 2. "month day [year]" — exact date. When the year is omitted, infer the
  // most recent year in which that date is not in the future.
  const mdy = q.match(MONTH_DAY_YEAR_RE);
  if (mdy) {
    const m = MONTHS[mdy[1]!.toLowerCase()];
    const d = Number(mdy[2]);
    if (m !== undefined && d >= 1 && d <= 31) {
      let y = mdy[3] ? Number(mdy[3]) : now.getUTCFullYear();
      // Infer-year rule: if month/day this year is still in the future,
      // the query means last year ("daily report july 20" asked in March).
      if (!mdy[3]) {
        const candidate = new Date(Date.UTC(y, m, d));
        if (candidate.getTime() > now.getTime()) y -= 1;
      }
      if (d <= daysInMonth(y, m)) {
        const since = isoDate(y, m, d);
        const until = isoDate(...nextDay(y, m, d));
        return { kind: 'exact_date', since, until, pageType: typeHint, slugFamily };
      }
    }
  }

  // 3. "in july [2026]" — month window. Guard: MONTH_DAY_YEAR_RE already
  // consumed "july 20 [2026]" above, so a bare month here has no day.
  const mw = q.match(MONTH_WINDOW_RE);
  if (mw) {
    const m = MONTHS[mw[1]!.toLowerCase()];
    if (m !== undefined) {
      let y = mw[2] ? Number(mw[2]) : now.getUTCFullYear();
      if (!mw[2] && m > now.getUTCMonth()) y -= 1;
      const since = isoDate(y, m, 1);
      const until = m === 11 ? isoDate(y + 1, 0, 1) : isoDate(y, m + 1, 1);
      return { kind: 'month_window', since, until, pageType: typeHint, slugFamily };
    }
  }

  // 4. Superlative — "newest decision", "most recent report".
  const sup = q.match(SUPERLATIVE_RE);
  if (sup) {
    return { kind: 'superlative', pageType: typeHint, slugFamily };
  }

  // 5. Relative window — "this week", "recent", "today".
  const rel = q.match(RELATIVE_RE);
  if (rel) {
    const token = rel[1]!.toLowerCase().replace(/\s+/g, ' ');
    const days =
      token === 'today' || token === 'yesterday'
        ? 2
        : token === 'this week'
          ? 7
          : token === 'this month'
            ? 31
            : token === 'this year'
              ? 366
              : 14; // recent(ly)/lately
    return { kind: 'relative_window', days, pageType: typeHint, slugFamily };
  }

  return null;
}

function nextDay(y: number, m: number, d: number): [number, number, number] {
  const dt = new Date(Date.UTC(y, m, d + 1));
  return [dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()];
}
