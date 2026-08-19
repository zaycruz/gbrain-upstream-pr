/**
 * Navigational recall arm (raava/prod ontology v1, WS3c).
 *
 * Turns a navigational query into a ranked list of SearchResult rows that
 * hybridSearch injects as a FIFTH RRF arm (alongside keyword + vector +
 * relational), so a canonical protocol doc or a type enumeration competes
 * for ranking instead of relying on lexical overlap with body text.
 *
 * Shapes (from nav-intent.ts):
 *  - enumerate: "all decisions" -> listPages({type: 'decision'}) — the
 *    ontology-governed enumeration the eval's nav category wants.
 *  - canonical: "how do agents write facts to the brain" -> the brain's
 *    own protocol/schema/reference pages, resolved by slug-alias + title
 *    match against the topic, NOT by chunk-text word overlap.
 *
 * Determinism: parses the ORIGINAL query; enumeration + canonical
 * resolution are deterministic DB reads. Fail-open: any error returns an
 * empty arm + an audit row, never breaking the search hot path.
 *
 * Pack-driven: the enumerate shape only routes when the head noun resolves
 * to a page type the ACTIVE schema pack declares, so the ontology pack is
 * the single source of truth for what can be enumerated.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult, PageType } from '../types.ts';
import { parseNavQuery, type NavQuery } from './nav-intent.ts';
import { resolveArmSources } from './scope-sources.ts';

export interface NavArmOpts {
  sourceId?: string;
  sourceIds?: string[];
  /** Declared page types from the active schema pack (lowercase). */
  packTypes: ReadonlySet<string>;
  /** WS5b — pack-declared canonical doc config (manifest.nav_canonical). */
  navCanonical?: NavCanonicalConfig;
  /** Cap on enumeration rows (default 20, hard-capped at 50). */
  limit?: number;
  onMeta?: (meta: NavArmMeta) => void;
}

/**
 * WS5b — pack-configurable canonical docs. The active schema pack may
 * declare `nav_canonical` in its manifest:
 *
 *   nav_canonical:
 *     priority: [slug, ...]                                # replaces CANONICAL_DOC_SLUGS
 *     topics: [{ pattern: "quer|cli", slugs: [..] }, ...]  # prepended to the topic map
 *
 * Patterns compile case-insensitively; invalid regexes are skipped.
 * When the pack declares nothing, the hardcoded defaults below apply
 * bit-for-bit (older packs / non-raava brains keep current behavior).
 */
export interface NavCanonicalConfig {
  priority?: string[];
  topics?: Array<{ pattern: string; slugs: string[] }>;
}

export interface NavArmMeta {
  fired: boolean;
  kind: NavQuery['kind'] | null;
  candidates: number;
  errored: boolean;
  duration_ms: number;
}

/**
 * Canonical brain-protocol docs, in priority order. These are the pages a
 * "how do I do X with the brain" query should surface first. Slugs are
 * matched case-insensitively against the pages table (both the
 * concepts/shared paths and the bare canonical names are tried).
 */
const CANONICAL_DOC_SLUGS: ReadonlyArray<string> = [
  'concepts/shared/remote_brain_operating_protocol',
  'remote_brain_operating_protocol',
  'write_policy',
  'schema',
  'resolver',
  'canonical_sources',
  'concepts/shared/canonical_sources',
  'tools/gbrain-reference',
  'gbrain-reference',
  'concepts/engineering/agent-memory-convention',
  'agent-memory-convention',
  'connect-brain',
];

/** Topic keywords -> canonical docs that specifically cover them. */
const CANONICAL_TOPIC_MAP: ReadonlyArray<{ re: RegExp; slugs: string[] }> = [
  { re: /\bwrite|writing|writes|facts?\b/i, slugs: ['write_policy', 'schema', 'concepts/shared/remote_brain_operating_protocol'] },
  { re: /\bsession|start|connect|sign\s*in/i, slugs: ['concepts/shared/remote_brain_operating_protocol', 'connect-brain'] },
  { re: /\bquer(y|ies)|cli|search/i, slugs: ['tools/gbrain-reference', 'gbrain-reference', 'connect-brain'] },
  { re: /\bingest|meetings?|notes?\b/i, slugs: ['write_policy', 'schema'] },
  { re: /\binbox\b/i, slugs: ['schema'] },
  { re: /\bjournals?\b/i, slugs: ['schema', 'concepts/engineering/agent-memory-convention'] },
  { re: /\brun-?logs?\b/i, slugs: ['concepts/engineering/agent-memory-convention', 'schema'] },
  { re: /\bdedup/i, slugs: ['tools/gbrain-reference', 'gbrain-reference', 'write_policy'] },
  { re: /\bdistill|nightly|pipeline/i, slugs: ['write_policy', 'tools/gbrain-reference'] },
  { re: /\bdecisions?\b/i, slugs: ['schema', 'resolver'] },
];

/**
 * Resolve the effective canonical priority list + topic map for one arm
 * build. Pack topics are checked BEFORE the hardcoded defaults so the
 * ontology pack owns routing for its domain.
 */
function resolveCanonicalConfig(
  packCfg: NavCanonicalConfig | undefined,
): { priority: ReadonlyArray<string>; topicMap: ReadonlyArray<{ re: RegExp; slugs: string[] }> } {
  if (!packCfg || (!packCfg.priority?.length && !packCfg.topics?.length)) {
    return { priority: CANONICAL_DOC_SLUGS, topicMap: CANONICAL_TOPIC_MAP };
  }
  const priority = packCfg.priority?.length ? packCfg.priority : CANONICAL_DOC_SLUGS;
  const packTopics: Array<{ re: RegExp; slugs: string[] }> = [];
  for (const t of packCfg.topics ?? []) {
    try {
      packTopics.push({ re: new RegExp(t.pattern, 'i'), slugs: t.slugs });
    } catch {
      // Invalid pack regex — skip the entry, keep the rest.
    }
  }
  return { priority, topicMap: [...packTopics, ...CANONICAL_TOPIC_MAP] };
}

async function pagesToResults(
  engine: BrainEngine,
  pages: Array<{ id: number; slug: string; title: string; type: string; compiled_truth: string; source_id?: string }>,
  navKind: NavQuery['kind'],
): Promise<SearchResult[]> {
  return pages.map((p) => ({
    slug: p.slug,
    page_id: p.id,
    title: p.title,
    type: p.type as PageType,
    chunk_text: (p.compiled_truth ?? '').slice(0, 240) || p.slug,
    chunk_source: 'compiled_truth' as const,
    chunk_id: 0, // page-level key, mirrors the relational arm convention
    chunk_index: 0,
    score: 0, // rank-based: RRF derives score from list position
    stale: false,
    source_id: p.source_id ?? 'default',
    nav_kind: navKind,
  }));
}

/**
 * Build the navigational recall arm. Returns an empty list (pure no-op)
 * when the query isn't navigational or nothing resolves. Never throws.
 */
export async function buildNavArm(
  engine: BrainEngine,
  query: string,
  opts: NavArmOpts,
): Promise<SearchResult[]> {
  const startedAt = Date.now();
  const meta: NavArmMeta = { fired: false, kind: null, candidates: 0, errored: false, duration_ms: 0 };
  const finish = (list: SearchResult[]) => {
    meta.candidates = list.length;
    meta.duration_ms = Date.now() - startedAt;
    opts.onMeta?.(meta);
    return list;
  };

  const parsed = parseNavQuery(query, opts.packTypes);
  if (!parsed) return finish([]);
  meta.kind = parsed.kind;

  try {
    const sources = await resolveArmSources(engine, opts);
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 50);

    if (parsed.kind === 'enumerate' && parsed.pageType) {
      // Type enumeration, scope-aware, .archive/ always excluded, newest
      // first. Sorted by updated_at desc so the freshest decisions/lessons
      // lead the arm.
      const rows = await engine.executeRaw<{
        id: number; slug: string; title: string; type: string; compiled_truth: string; source_id: string;
      }>(
        `SELECT p.id, p.slug, p.title, p.type, LEFT(p.compiled_truth, 240) AS compiled_truth, p.source_id
         FROM pages p
         WHERE p.type = $1
           AND p.source_id = ANY($2::text[])
           AND p.deleted_at IS NULL
           AND p.slug NOT LIKE '.archive/%'
          AND p.slug NOT LIKE '%/_templates/%'
         ORDER BY p.updated_at DESC
         LIMIT $3`,
        [parsed.pageType, sources, limit],
      );
      const list = await pagesToResults(engine, rows, 'enumerate');
      meta.fired = list.length > 0;
      return finish(list);
    }

    if (parsed.kind === 'canonical' && parsed.topic) {
      // Topic-specific canonicals first, then the general priority list.
      const { priority, topicMap } = resolveCanonicalConfig(opts.navCanonical);
      const wanted: string[] = [];
      for (const m of topicMap) {
        if (m.re.test(parsed.topic)) wanted.push(...m.slugs);
      }
      wanted.push(...priority);
      const dedup = Array.from(new Set(wanted.map((s) => s.toLowerCase())));

      const rows = await engine.executeRaw<{
        id: number; slug: string; title: string; type: string; compiled_truth: string; source_id: string;
      }>(
        `SELECT p.id, p.slug, p.title, p.type, LEFT(p.compiled_truth, 240) AS compiled_truth, p.source_id
         FROM pages p
         WHERE lower(p.slug) = ANY($1::text[])
           AND p.source_id = ANY($2::text[])
           AND p.deleted_at IS NULL`,
        [dedup, sources],
      );
      // Preserve the canonical priority order (DB return order is unspecified).
      const bySlug = new Map(rows.map((r) => [r.slug.toLowerCase(), r] as const));
      const ordered = dedup
        .map((s) => bySlug.get(s))
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
        .slice(0, 5);
      const list = await pagesToResults(engine, ordered, 'canonical');
      meta.fired = list.length > 0;
      return finish(list);
    }

    return finish([]);
  } catch {
    meta.errored = true;
    return finish([]);
  }
}
