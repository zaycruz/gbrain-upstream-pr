/**
 * raava/prod WS5 — recall-arm rows must survive autocut + min_score floor.
 *
 * Regression guard for the prod failure where "newest decision" queries
 * returned word-overlap noise instead of the newest decision page:
 *
 *   1. Temporal/nav/relational arms fuse page-level rows at neutral RRF
 *      weight. Organic keyword/vector chunks outrank them, so the arm
 *      rows land BELOW the reranker's scored head.
 *   2. The reranker only scores its top-N head → arm rows carry no
 *      `rerank_score`.
 *   3. autocut treats un-scored rows as "no confidence signal" and cuts
 *      them; the min_score floor drops them as below-threshold noise.
 *   4. Net effect: the arm's deterministic answer was deleted while
 *      word-overlap chunks the reranker liked survived.
 *
 * The fix marks arm rows (`temporal_kind` / `nav_kind` /
 * `relational_via_link_types`) as structurally injected — same class as
 * the `alias_hit` exact-match exemption — so both stages preserve them.
 */

import { describe, expect, test } from 'bun:test';
import { isRecallArmRow, promoteRecallArmAnswers } from '../../src/core/search/hybrid.ts';
import { applyAutocut, DEFAULT_AUTOCUT } from '../../src/core/search/autocut.ts';
import type { SearchResult } from '../../src/core/types.ts';

const ON = { ...DEFAULT_AUTOCUT, enabled: true };

function row(partial: Partial<SearchResult> & { slug: string }): SearchResult {
  return {
    page_id: 1,
    title: partial.slug,
    chunk_text: partial.slug,
    chunk_source: 'compiled_truth',
    chunk_id: 0,
    chunk_index: 0,
    score: 0.01,
    stale: false,
    source_id: 'default',
    ...partial,
  } as SearchResult;
}

describe('isRecallArmRow — recognizes every arm marker', () => {
  test('temporal arm row', () => {
    expect(isRecallArmRow(row({ slug: 'a', temporal_kind: 'superlative' }))).toBe(true);
  });
  test('nav arm row', () => {
    expect(isRecallArmRow(row({ slug: 'a', nav_kind: 'enumerate' }))).toBe(true);
    expect(isRecallArmRow(row({ slug: 'a', nav_kind: 'canonical' }))).toBe(true);
  });
  test('relational arm row', () => {
    expect(
      isRecallArmRow(row({ slug: 'a', relational_via_link_types: ['decided_by'] })),
    ).toBe(true);
  });
  test('relational marker with empty link types is NOT an arm row', () => {
    expect(isRecallArmRow(row({ slug: 'a', relational_via_link_types: [] }))).toBe(false);
  });
  test('organic keyword/vector row is NOT an arm row', () => {
    expect(isRecallArmRow(row({ slug: 'a' }))).toBe(false);
  });
});

describe('autocut — arm rows survive a cut that drops scored noise', () => {
  test('unscored temporal-arm row survives the cliff', () => {
    const items = [
      row({ slug: 'temporal-arm', temporal_kind: 'superlative' }), // no rerank_score
      row({ slug: 'top', rerank_score: 0.95 }),
      row({ slug: 'noise1', rerank_score: 0.2 }),
      row({ slug: 'noise2', rerank_score: 0.1 }),
    ];
    const r = applyAutocut(items, (x) => x.rerank_score, ON, isRecallArmRow);
    expect(r.decision.applied).toBe(true);
    expect(r.kept.map((x) => x.slug).sort()).toEqual(['temporal-arm', 'top']);
  });

  test('without the predicate, the same arm row is cut (the prod bug)', () => {
    const items = [
      row({ slug: 'temporal-arm', temporal_kind: 'superlative' }),
      row({ slug: 'top', rerank_score: 0.95 }),
      row({ slug: 'noise', rerank_score: 0.1 }),
    ];
    const r = applyAutocut(items, (x) => x.rerank_score, ON);
    expect(r.kept.map((x) => x.slug)).toEqual(['top']);
  });

  test('predicate does not force a cut on a flat curve', () => {
    const items = [
      row({ slug: 'nav-arm', nav_kind: 'enumerate' }),
      row({ slug: 'a', rerank_score: 0.6 }),
      row({ slug: 'b', rerank_score: 0.58 }),
    ];
    const r = applyAutocut(items, (x) => x.rerank_score, ON, isRecallArmRow);
    expect(r.decision.applied).toBe(false);
    expect(r.kept.length).toBe(3);
  });
});

describe('promoteRecallArmAnswers — arm answers lead, arm order preserved', () => {
  test('arm rows lead; organic rows keep position below', () => {
    const items = [
      row({ slug: 'organic-strong', score: 2.0 }),
      row({ slug: 'arm-newest', temporal_kind: 'superlative', score: 1.0, base_score: 0.05 }),
      row({ slug: 'organic-mid', score: 0.9 }),
      row({ slug: 'arm-older', temporal_kind: 'superlative', score: 1.4, base_score: 0.04 }),
    ];
    const out = promoteRecallArmAnswers(items);
    expect(out.map((r) => r.slug)).toEqual([
      // Arm rows lead, ordered by base (pre-boost RRF) score — the arm's
      // own SQL ordering (newest first), not the boost-inflated fused score.
      'arm-newest',
      'arm-older',
      'organic-strong',
      'organic-mid',
    ]);
  });

  test('no arm rows → input order unchanged', () => {
    const items = [row({ slug: 'a', score: 2 }), row({ slug: 'b', score: 1 })];
    const out = promoteRecallArmAnswers(items);
    expect(out.map((r) => r.slug)).toEqual(['a', 'b']);
  });

  test('arm rows sort by base_score (arm order) even when boosts scramble fused score', () => {
    const items = [
      row({ slug: 'organic', score: 100 }),
      row({ slug: 'arm-2', temporal_kind: 'relative_window', score: 9, base_score: 0.02 }),
      row({ slug: 'arm-1', temporal_kind: 'relative_window', score: 1, base_score: 0.03 }),
    ];
    const out = promoteRecallArmAnswers(items);
    // arm-1's base_score (0.03) beats arm-2's (0.02) even though boosts
    // pushed arm-2's fused `score` to 9 — arm ordering follows base_score.
    expect(out.map((r) => r.slug)).toEqual(['arm-1', 'arm-2', 'organic']);
  });

  test('single row passes through', () => {
    const items = [row({ slug: 'only', temporal_kind: 'exact_date' })];
    expect(promoteRecallArmAnswers(items).length).toBe(1);
  });
});
