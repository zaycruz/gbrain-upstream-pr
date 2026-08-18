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

function scopeSources(opts: TemporalArmOpts): string[] {
  if (opts.sourceIds && opts.sourceIds.length > 0) return opts.sourceIds;
  if (opts.sourceId && opts.sourceId !== '__all__') return [opts.sourceId];
  return ['default'];
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
    const sources = scopeSources(opts);
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
      if (parsed.pageType) params.push(parsed.pageType);
      params.push(limit);
      const typeClause = parsed.pageType ? 'AND p.type = $5' : '';
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
           ${typeClause}
         ORDER BY p.effective_date DESC NULLS LAST, p.updated_at DESC
         LIMIT $${params.length}`,
        params,
      );
      meta.fired = rows.length > 0;
      return finish(toResults(rows, parsed.kind));
    }

    if (parsed.kind === 'superlative') {
      const typeClause = parsed.pageType ? 'AND p.type = $2' : '';
      const params: unknown[] = [sources];
      if (parsed.pageType) params.push(parsed.pageType);
      params.push(limit);
      const rows = await engine.executeRaw<PageRow>(
        `SELECT ${PAGE_COLS}
         FROM pages p
         WHERE p.source_id = ANY($1::text[])
           AND p.deleted_at IS NULL
           AND p.slug NOT LIKE '.archive/%'
           ${typeClause}
         ORDER BY p.effective_date DESC NULLS LAST, p.updated_at DESC
         LIMIT $${params.length}`,
        params,
      );
      meta.fired = rows.length > 0;
      return finish(toResults(rows, parsed.kind));
    }

    if (parsed.kind === 'relative_window' && parsed.days) {
      const now = opts.now ?? new Date();
      const since = new Date(now.getTime() - parsed.days * 86_400_000).toISOString();
      const rows = await engine.executeRaw<PageRow>(
        `SELECT ${PAGE_COLS}
         FROM pages p
         WHERE (p.updated_at >= $1::timestamptz OR p.effective_date >= $1::timestamptz)
           AND p.source_id = ANY($2::text[])
           AND p.deleted_at IS NULL
           AND p.slug NOT LIKE '.archive/%'
         ORDER BY GREATEST(p.updated_at, COALESCE(p.effective_date, p.updated_at)) DESC
         LIMIT $3`,
        [since, sources, limit],
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
