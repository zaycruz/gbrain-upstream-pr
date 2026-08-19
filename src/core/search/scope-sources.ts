/**
 * Shared source-scope resolution for the SQL recall arms (temporal, nav,
 * relational). These arms query the `pages` table directly via executeRaw,
 * which bypasses the RLS scope-binding wrapper the engines use — so the
 * scope filter must be applied in SQL here.
 *
 * Trust ladder (mirrors operations.ts sourceScopeOpts / resolveRequestedScope):
 *  - explicit sourceIds[]          → exactly that grant
 *  - explicit scalar sourceId      → that source ('__all__' = span all)
 *  - unscoped (trusted local only) → enumerate the brain's live sources
 *
 * The unscoped fallback previously returned ['default'], which silently
 * blinded every arm on multi-source brains (raava/prod keeps its content
 * in 'raava-brain', not 'default'): temporal superlative/month windows and
 * canonical nav docs in the real source never entered the candidate pool.
 * Unscoped reachability only exists for trusted local callers — remote
 * callers always resolve to a concrete grant upstream — so enumerating
 * live sources matches the engine's unscoped-read semantics.
 */

import type { BrainEngine } from '../engine.ts';
import { ALL_SOURCES } from '../source-id.ts';

interface ScopeOpts {
  sourceId?: string;
  sourceIds?: string[];
}

/** Cached enumeration of live source ids (per source count > 0). Sources
 *  change rarely relative to search QPS; a fresh value is nice-to-have, not
 *  correctness — every arm query still applies its own filters. Cleared by
 *  tests via resetArmSourceCache. */
let liveSourcesCache: string[] | null = null;

export function resetArmSourceCache(): void {
  liveSourcesCache = null;
}

async function enumerateLiveSources(engine: BrainEngine): Promise<string[]> {
  if (liveSourcesCache) return liveSourcesCache;
  try {
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT DISTINCT source_id FROM pages WHERE deleted_at IS NULL`,
    );
    const sources = rows
      .map((r) => r.source_id)
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .sort();
    liveSourcesCache = sources.length > 0 ? sources : ['default'];
  } catch {
    // Enumeration failure must never break the search hot path — fall back
    // to the pre-fix single-source behavior rather than erroring the arm.
    liveSourcesCache = ['default'];
  }
  return liveSourcesCache;
}

export async function resolveArmSources(
  engine: BrainEngine,
  opts: ScopeOpts,
): Promise<string[]> {
  if (opts.sourceIds && opts.sourceIds.length > 0) return opts.sourceIds;
  if (opts.sourceId && opts.sourceId !== ALL_SOURCES) return [opts.sourceId];
  return enumerateLiveSources(engine);
}
