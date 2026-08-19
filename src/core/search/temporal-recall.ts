/**
 * Temporal recall arm (raava/prod WS5a).
 *
 * Turns a temporal query into a ranked list of SearchResult rows that
 * hybridSearch injects as a SIXTH RRF arm (alongside keyword + vector +
 * title + relational + nav), so a date-addressable page competes for
 * ranking instead of relying on lexical overlap with body text. This is a
 * candidate-INJECTION arm: the recency boost only re-ranks a pool that
 * already contains the right candidates; it cannot inject a date-addressed
 * page the vector/keyword arms never surfaced.
 *
 * Shapes (from temporal-intent.ts):
 *  - exact_date + slug family: direct slug probe
 *    (`%daily-report-2026-08-03%`) first, then a [since, until) windowed
 *    read as fallback.
 *  - month_window (+ type): effective_date-bounded enumeration, with a
 *    slug-date fallback for pages whose effective_date is null.
 *  - superlative (+ type): newest-first enumeration by effective_date
 *    (updated_at tiebreak).
 *  - relative_window: pages touched within the trailing window. Fused as
 *    an RRF arm, never a filter — bare recency can't flood generic queries
 *    because the reranker + floor still gate the final set.
 *
 * Determinism: parses the ORIGINAL query; all resolutions are
 * deterministic DB reads. Fail-open: any error returns an empty arm + a
 * meta row, never breaking the search hot path.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult, PageType } from '../types.ts';
import { parseTemporalQuery, type TemporalQuery } from './temporal-intent.ts';
import { resolveArmSources } from './scope-sources.ts';

export interface TemporalArmOpts {
  sourceId?: string;
  sourceIds?: string[];
  /** Declared page types from the active schema pack (lowercase). */
  packTypes: ReadonlySet<string>;
  /** Cap on arm rows (default 20, hard-capped at 50). */
  limit?: number;
  /** Injectable clock for tests. */
  now?: Date;
  onMeta?: (meta: TemporalArmMeta) => void;
}

export interface TemporalArmMeta {
  fired: boolean;
  kind: TemporalQuery['kind'] | null;
  candidates: number;
  errored: boolean;
  duration_ms: number;
}

interface PageRow {
  id: number;
  slug: string;
  title: string;
  type: string;
  compiled_truth: string;
  source_id: string;
}

function toResults(rows: PageRow[], kind: TemporalQuery['kind']): SearchResult[] {
  return rows.map((p) => ({
    slug: p.slug,
    page_id: p.id,
    title: p.title,
    type: p.type as PageType,
    chunk_text: (p.compiled_truth ?? '').slice(0, 240) || p.slug,
    chunk_source: 'compiled_truth' as const,
    chunk_id: 0, // page-level key, mirrors the relational/nav arm convention
    chunk_index: 0,
    score: 0, // rank-based: RRF derives score from list position
    stale: false,
    source_id: p.source_id ?? 'default',
    temporal_kind: kind,
  }));
}

const PAGE_COLS =
  `p.id, p.slug, p.title, p.type, LEFT(p.compiled_truth, 240) AS compiled_truth, p.source_id`;

// Namespaces that carry TYPE-CONFORMING rows but are not content answers:
// `_templates/` pages are structural scaffolding (a `decision` template is a
// decision-typed page that is never "the newest decision"). Excluded from every
// temporal shape so the arm's top rank is real content, not scaffolding.
// `.archive/` exclusion stays per-query.
const TEMPLATE_EXCLUDE = `AND p.slug NOT LIKE '%/_templates/%'`;

/**
 * Build the temporal recall arm. Returns an empty list (pure no-op) when
 * the query isn't temporal or nothing resolves. Never throws.
 */
export async function buildTemporalArm(
  engine: BrainEngine,
  query: string,
  opts: TemporalArmOpts,
): Promise<SearchResult[]> {
  const startedAt = Date.now();
  const meta: TemporalArmMeta = {
    fired: false, kind: null, candidates: 0, errored: false, duration_ms: 0,
  };
  const finish = (list: SearchResult[]) => {
    meta.candidates = list.length;
    meta.duration_ms = Date.now() - startedAt;
    opts.onMeta?.(meta);
    return list;
  };

  const parsed = parseTemporalQuery(query, opts.packTypes, opts.now);
  if (!parsed) return finish([]);
  meta.kind = parsed.kind;

  try {
    const sources = await resolveArmSources(engine, opts);
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 50);

    if (parsed.kind === 'exact_date' && parsed.since && parsed.until) {
      // Slug probe first when the query names a date-stamped family:
      // "daily report august 3 2026" → %daily-report-2026-08-03%. This is
      // deterministic and rank-1-exact when the convention holds.
      if (parsed.slugFamily) {
        const stem = parsed.slugFamily.replace(/\s+/g, '-').replace(/_/g, '-');
        const day = parsed.since; // YYYY-MM-DD
        const rows = await engine.executeRaw<PageRow>(
          `SELECT ${PAGE_COLS}
           FROM pages p
           WHERE p.slug LIKE $1
             AND p.source_id = ANY($2::text[])
             AND p.deleted_at IS NULL
             AND p.slug NOT LIKE '.archive/%'
             ${TEMPLATE_EXCLUDE}
           ORDER BY p.slug ASC
           LIMIT $3`,
          [`%${stem}-${day}%`, sources, limit],
        );
        if (rows.length > 0) {
          meta.fired = true;
          return finish(toResults(rows, parsed.kind));
        }
      }
      // Fallback: any page whose effective_date lands on the day.
      const rows = await engine.executeRaw<PageRow>(
        `SELECT ${PAGE_COLS}
         FROM pages p
         WHERE p.effective_date >= $1::timestamptz
           AND p.effective_date < $2::timestamptz
           AND p.source_id = ANY($3::text[])
           AND p.deleted_at IS NULL
           AND p.slug NOT LIKE '.archive/%'
           ${TEMPLATE_EXCLUDE}
         ORDER BY p.effective_date DESC, p.updated_at DESC
         LIMIT $4`,
        [parsed.since, parsed.until, sources, limit],
      );
      meta.fired = rows.length > 0;
      return finish(toResults(rows, parsed.kind));
    }

    if (parsed.kind === 'month_window' && parsed.since && parsed.until) {
      // effective_date window, plus slug-date fallback for undated pages.
      // The slug fallback uses the YYYY-MM prefix form, which covers
      // daily-report-2026-07-20 and 2026-07-19-gbrain-stays-on-gcp alike.
      const yyyymm = parsed.since.slice(0, 7);
      const slugRe = `${yyyymm}-\\d{2}([-/]|$)`;
      const params: unknown[] = [parsed.since, parsed.until, sources, slugRe];
      // Type-match via column OR slug namespace (same two-channel
      // contract as superlative): decisions/* pages typed `note` still
      // belong in "decisions made in july".
      const typeClause = parsed.pageType
        ? `AND (p.type = $${params.length + 1} OR p.slug LIKE $${params.length + 2})`
        : '';
      if (parsed.pageType) {
        params.push(parsed.pageType);
        params.push(`${parsed.pageType}s/%`);
      }
      const rows = await engine.executeRaw<PageRow>(
        `SELECT ${PAGE_COLS}
         FROM pages p
         WHERE (
             (p.effective_date >= $1::timestamptz AND p.effective_date < $2::timestamptz)
             OR (p.effective_date IS NULL AND p.slug ~ $4)
           )
           AND p.source_id = ANY($3::text[])
           AND p.deleted_at IS NULL
           AND p.slug NOT LIKE '.archive/%'
           ${TEMPLATE_EXCLUDE}
           ${typeClause}
         ORDER BY p.effective_date DESC NULLS LAST, p.updated_at DESC
         LIMIT ${limit}`,
        params,
      );
      meta.fired = rows.length > 0;
      return finish(toResults(rows, parsed.kind));
    }

    if (parsed.kind === 'superlative') {
      const params: unknown[] = [sources];
      // When the query names a date-addressable slug family ("daily
      // report", "brain health", "run-log"), the family rows ARE the
      // answer — "most recent brain daily report" must lead with the
      // newest daily-report page, not the newest page of any type
      // (agents/*/runs run-logs updated yesterday outrank last week's
      // daily report on updated_at). NULLS LAST keeps non-family rows
      // as tail context instead of filtering them out. The slug family
      // is a STRONGER signal than the type hint: "daily report"
      // extracts pageType 'report', but the daily-report pages are
      // typed `ops-note` in the raava-base pack — a hard type filter
      // would zero the arm's answer. So when a slug family is present,
      // drop the type clause and let the family rank lead.
      //
      // Type-match is two-channel: the declared `p.type` column AND the
      // slug's namespace directory. Some pages carry the type only in
      // the slug (e.g. decisions/2026-07-19-gbrain-stays-on-gcp is typed
      // `note` but is unambiguously a decision by location) — the strict
      // p.type filter alone would drop them from "newest decision".
      const effectivePageType = parsed.slugFamily ? undefined : parsed.pageType;
      const typeClause = effectivePageType
        ? `AND (p.type = $${params.length + 1} OR p.slug LIKE $${params.length + 2})`
        : '';
      if (effectivePageType) {
        params.push(effectivePageType);
        params.push(`${effectivePageType}s/%`);
      }
      const familyRank = parsed.slugFamily
        ? `CASE WHEN p.slug LIKE '%' || $${params.length + 1} || '%' THEN 0 ELSE 1 END,`
        : '';
      if (parsed.slugFamily) params.push(parsed.slugFamily.replace(/\s+/g, '-'));
      // LIMIT is inlined (not a bind param): postgres infers $n types
      // from context and a non-trailing numeric param binds as text,
      // which LIMIT rejects ("argument of LIMIT must be type bigint").
      // `limit` is already clamped to [1, 50] above, so inlining is
      // safe and keeps every bind param unambiguously typed.
      const rows = await engine.executeRaw<PageRow>(
        `SELECT ${PAGE_COLS}
         FROM pages p
         WHERE p.source_id = ANY($1::text[])
           AND p.deleted_at IS NULL
           AND p.slug NOT LIKE '.archive/%'
           ${TEMPLATE_EXCLUDE}
           ${typeClause}
         ORDER BY ${familyRank} p.effective_date DESC NULLS LAST, p.updated_at DESC
         LIMIT ${limit}`,
        params,
      );
      meta.fired = rows.length > 0;
      return finish(toResults(rows, parsed.kind));
    }

    if (parsed.kind === 'relative_window' && parsed.days) {
      const now = opts.now ?? new Date();
      const since = new Date(now.getTime() - parsed.days * 86_400_000).toISOString();
      const params: unknown[] = [since, sources];
      // Same slug-family priority as superlative: "recent escalations"
      // wants escalation pages first. And order by effective_date (the
      // content's own date), not updated_at — a bulk re-ingest bumps
      // updated_at on every page and would scramble the window.
      const familyRank = parsed.slugFamily
        ? `CASE WHEN p.slug LIKE '%' || $${params.length + 1} || '%' THEN 0 ELSE 1 END,`
        : '';
      if (parsed.slugFamily) params.push(parsed.slugFamily.replace(/\s+/g, '-'));
      // "What changed this week" is asking for the window's ROLLUP — the
      // daily-report / brain-health pages that summarize the period —
      // not the raw write volume. Inbox drops and per-minute run-logs
      // swamp the window on updated_at (a bulk re-ingest made every page
      // "recent"), and individual old decisions/meetings re-ingested in
      // the window are not "what changed". Lead with the dated rollups;
      // dated content (ISO date in slug) next; everything else is tail.
      const ROLLUP = "(p.slug LIKE '%daily-report%' OR p.slug LIKE '%brain-health%')";
      // Dated content: ISO date as a real date segment — covers
      // daily-report-2026-08-03 and decisions/2026-07-19-* but NOT the
      // compact inbox/run-log form (2026-08-19-19c493bc), which is a
      // write receipt, not a curated change entry.
      const DATED = "p.slug ~ '\\d{4}-\\d{2}-\\d{2}($|[^0-9a-f])'";
      const rows = await engine.executeRaw<PageRow>(
        `SELECT ${PAGE_COLS}
         FROM pages p
         WHERE (p.updated_at >= $1::timestamptz OR p.effective_date >= $1::timestamptz)
           AND p.source_id = ANY($2::text[])
           AND p.deleted_at IS NULL
           AND p.slug NOT LIKE '.archive/%'
           ${TEMPLATE_EXCLUDE}
         ORDER BY ${familyRank} CASE WHEN ${ROLLUP} THEN 0 WHEN ${DATED} THEN 1 ELSE 2 END, p.effective_date DESC NULLS LAST, p.updated_at DESC
         LIMIT ${limit}`,
        params,
      );
      meta.fired = rows.length > 0;
      return finish(toResults(rows, parsed.kind));
    }

    return finish([]);
  } catch {
    meta.errored = true;
    return finish([]);
  }
}
