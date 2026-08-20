/**
 * Navigational intent parser (raava/prod ontology v1, WS3c).
 *
 * The 100-query gold-set eval put navigational queries at 50% hit@5 — the
 * worst in-scope category — because "how do I find all decisions" matches on
 * word overlap and returns research pages instead of a `type:decision`
 * enumeration or the canonical RESOLVER/SCHEMA docs.
 *
 * Two nav shapes are detected, precision-first:
 *
 * 1. **enumerate** — the query asks for an exhaustive listing of a page
 *    type ("all decisions", "list run-logs", "every meeting in july").
 *    Routes to listPages({type}) instead of vector/keyword search.
 * 2. **canonical** — the query asks how to DO something with the brain
 *    itself ("how do agents write facts", "how to query the brain from
 *    the cli"). The brain's protocol/schema/reference pages are the right
 *    answer regardless of what body text happens to overlap; routes to the
 *    canonical-doc set (slug aliases + type-enum pages) so those surface
 *    deterministically.
 *
 * Everything else returns null and the caller falls through to the normal
 * hybrid pipeline unchanged. Deterministic, zero-LLM, never throws.
 *
 * Type vocabulary is pack-driven: the caller passes the active schema
 * pack's page_types so "all decisions" only routes when `decision` is a
 * declared type (ontology-governed, no hardcoded type list here).
 */

export interface NavQuery {
  kind: 'enumerate' | 'canonical';
  /** enumerate: the resolved page type to list (pack-declared). */
  pageType?: string;
  /** canonical: free-text topic used to match canonical docs by title/slug. */
  topic?: string;
}

/** Common stop-gap nouns that follow "all/every/list" but are NOT types. */
const NON_TYPE_HEADS: ReadonlySet<string> = new Set([
  'the', 'of', 'in', 'on', 'for', 'to', 'from', 'this', 'that', 'these',
  'those', 'my', 'our', 'your', 'their', 'his', 'her', 'its',
]);

/** Naive singular: strip a trailing s/es so "decisions" -> "decision". */
function singularize(word: string): string[] {
  const w = word.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const forms = [w];
  // Most-specific suffixes FIRST (ies->y, es->strip) before the bare-s
  // strip: ["theses","these"] still misses "thesis", so also try the Greek
  // -es->-is declension used by thesis/analysis/crisis.
  if (w.endsWith('ies') && w.length > 3) forms.push(`${w.slice(0, -3)}y`);
  if (w.endsWith('ses') && w.length > 3) forms.push(`${w.slice(0, -3)}sis`);
  if (w.endsWith('es') && w.length > 2) forms.push(w.slice(0, -2));
  if (w.endsWith('s') && w.length > 1) forms.push(w.slice(0, -1));
  // hyphenated run-logs <-> run_log / runlog family
  if (w.includes('-')) forms.push(w.replace(/-/g, '_'));
  return Array.from(new Set(forms));
}

function resolveType(head: string, packTypes: ReadonlySet<string>): string | null {
  for (const form of singularize(head)) {
    if (packTypes.has(form)) return form;
  }
  return null;
}

const ENUMERATE_RE =
  /^\s*(?:how\s+do\s+i\s+)?(?:find|list|show|get|enumerate|see|browse)?\s*(?:all|every|each)\s+(?:the\s+)?([a-z0-9][a-z0-9_-]{1,40})\b/i;
const ENUMERATE_LIST_RE =
  /^\s*(?:list|show|enumerate|browse)\s+(?:all\s+)?(?:the\s+)?([a-z0-9][a-z0-9_-]{1,40})\s*(?:pages?|notes?|entries)?\s*\??$/i;
const CANONICAL_RE =
  /^\s*how\s+(?:do|does|can|should|would)\s+(?:i|we|an?\s+\w+|agents?|one)\s+(.+?)\s*\??$/i;
const HOW_TO_RE = /^\s*how\s+to\s+(.+?)\s*\??$/i;
// WS5b — observed nav miss phrasings from the 100-query eval:
//   "where do agent journals live"     → canonical (storage/layout topic)
//   "how are meeting notes ingested"   → canonical (passive-voice process)
//   "how to query the brain from the cli" already matched HOW_TO_RE.
const WHERE_LIVE_RE = /^\s*where\s+(?:do|does|are)\s+(?:the\s+)?(.+?)\s+(?:live|stored|kept|filed)\s*\??$/i;
const HOW_PASSIVE_RE = /^\s*how\s+(?:are|is|get|gets)\s+(.+?)\s+(?:ingested|captured|stored|written|imported|indexed|processed)\b/i;

/**
 * Parse a query into a NavQuery, or null when it isn't navigational.
 * `packTypes` is the active schema pack's declared page_types (lowercase).
 */
export function parseNavQuery(query: string, packTypes: ReadonlySet<string>): NavQuery | null {
  const q = (query ?? '').trim();
  if (q.length === 0 || q.length > 200) return null;

  // WS6e — "how do I find/list/show X" phrasing asks for the INSTRUCTION
  // (canonical doc), not the items. Detect the interrogative "how do I ..."
  // wrapper BEFORE the enumerate branch below can claim it, and route to
  // canonical. "find all decisions" (no "how do I") still enumerates the
  // items; "how do I find all decisions" returns the doc that explains how.
  const howDoI = /^\s*how\s+(?:do|can|could)\s+i\s+(.+?)\s*\??$/i.test(q);

  // enumerate: "all decisions", "find all run-logs", "list meetings".
  // Word-boundary head noun, singularized, must resolve to a pack type.
  if (!howDoI) {
    const en = q.match(ENUMERATE_RE) ?? q.match(ENUMERATE_LIST_RE);
    if (en && en[1]) {
      const head = en[1];
      if (!NON_TYPE_HEADS.has(head.toLowerCase())) {
        const t = resolveType(head, packTypes);
        if (t) return { kind: 'enumerate', pageType: t };
      }
    }
  }

  // canonical: "how do agents write facts to the brain", "how to query the
  // brain from the cli". Only fires when the topic mentions the brain/
  // vault/agent-knowledge domain — a generic "how do I cook rice" must
  // never route to brain protocol docs.
  const cm = q.match(CANONICAL_RE) ?? q.match(HOW_TO_RE);
  if (cm && cm[1]) {
    const topic = cm[1].trim();
    if (/\b(brain|vault|gbrain|facts?\s+fence|facts?\b|run-?logs?|wikilinks?|schema|ontology|knowledge\s+graph)\b/i.test(topic)) {
      return { kind: 'canonical', topic };
    }
  }

  // "where do X live" / "how are X ingested" — the whole matched phrase is
  // the topic. Same brain-domain gate as CANONICAL_RE so "where do bugs
  // live" never routes to brain protocol docs.
  const pm = q.match(WHERE_LIVE_RE) ?? q.match(HOW_PASSIVE_RE);
  if (pm && pm[1]) {
    const topic = pm[0].replace(/\?+$/, '').trim();
    if (/\b(brain|vault|gbrain|facts?\b|run-?logs?|journals?|meeting\s+notes?|wikilinks?|schema|ontology|decisions?|agents?)\b/i.test(topic)) {
      return { kind: 'canonical', topic };
    }
  }

  return null;
}
