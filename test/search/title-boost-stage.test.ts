/**
 * T2 — applyTitleBoost stage unit tests (mutate-in-place post-fusion stage).
 * Verifies: title-match multiplies + stamps; non-match untouched; floor-gate
 * skips below-threshold results; idempotent factor stamping.
 */

import { describe, test, expect } from 'bun:test';
import {
  applyTitleBoost,
  DEFAULT_TITLE_BOOST,
  promoteTitleMatches,
} from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

function mk(slug: string, title: string, score: number): SearchResult {
  return {
    slug, title, score,
    chunk_text: '', type: 'note', source_id: 'default',
    chunk_index: 0, chunk_id: 1,
  } as unknown as SearchResult;
}

describe('applyTitleBoost', () => {
  test('multiplies score and stamps title_match_boost on a title-phrase match', () => {
    const r = mk('projects/mingtang', 'The Mingtang — Indoor Greek Amphitheater', 0.8);
    applyTitleBoost([r], 'greek amphitheater', DEFAULT_TITLE_BOOST);
    expect(r.score).toBeCloseTo(0.8 * 1.25, 6);
    expect(r.title_match_boost).toBe(1.25);
  });

  test('leaves non-matching results untouched (no stamp)', () => {
    const r = mk('notes/other', 'Completely Unrelated Title', 0.8);
    applyTitleBoost([r], 'greek amphitheater', DEFAULT_TITLE_BOOST);
    expect(r.score).toBe(0.8);
    expect(r.title_match_boost).toBeUndefined();
  });

  test('floor-gate skips a matching result below threshold', () => {
    const strong = mk('projects/mingtang', 'Indoor Greek Amphitheater', 1.0);
    const weak = mk('notes/aside', 'A Greek Amphitheater Footnote', 0.50);
    // threshold = 0.85 * topScore(1.0) = 0.85; weak (0.50) is below.
    applyTitleBoost([strong, weak], 'greek amphitheater', DEFAULT_TITLE_BOOST, 0.85);
    expect(strong.title_match_boost).toBe(1.25);
    expect(weak.title_match_boost).toBeUndefined(); // gated out
    expect(weak.score).toBe(0.50);
  });

  test('factor <= 1.0 is a no-op (disabled)', () => {
    const r = mk('projects/mingtang', 'Greek Amphitheater', 0.8);
    applyTitleBoost([r], 'greek amphitheater', 1.0);
    expect(r.score).toBe(0.8);
    expect(r.title_match_boost).toBeUndefined();
  });

  test('empty query is a no-op', () => {
    const r = mk('projects/mingtang', 'Greek Amphitheater', 0.8);
    applyTitleBoost([r], '', DEFAULT_TITLE_BOOST);
    expect(r.score).toBe(0.8);
  });
});

describe('promoteTitleMatches', () => {
  test('promotes exact and contiguous title matches stably', () => {
    const bodyFirst = mk('notes/body-first', 'Unrelated Reference', 0.9);
    const exact = mk('projects/exact', 'Indoor Greek', 0.2);
    const bodyMiddle = mk('notes/body-middle', 'Another Reference', 0.8);
    const contiguous = mk('projects/contiguous', 'The Mingtang — Indoor Greek Amphitheater', 0.1);
    const bodyLast = mk('notes/body-last', 'Final Reference', 0.7);
    const results = [bodyFirst, exact, bodyMiddle, contiguous, bodyLast];
    for (const [index, result] of results.entries()) {
      result.rerank_score = index / 10;
    }

    const out = promoteTitleMatches(results, 'indoor greek');

    expect(out.map(r => r.slug)).toEqual([
      'projects/exact',
      'projects/contiguous',
      'notes/body-first',
      'notes/body-middle',
      'notes/body-last',
    ]);
    expect(out.map(r => r.score)).toEqual([0.2, 0.1, 0.9, 0.8, 0.7]);
    expect(out.map(r => r.rerank_score)).toEqual([0.1, 0.3, 0, 0.2, 0.4]);
  });

  test('preserves reranker order and attribution when nothing matches', () => {
    const results = [
      mk('notes/first', 'First Reference', 0.9),
      mk('notes/second', 'Second Reference', 0.8),
      mk('notes/third', 'Third Reference', 0.7),
    ];
    results[0]!.rerank_score = 0.2;
    results[1]!.rerank_score = 0.9;
    results[2]!.rerank_score = 0.5;

    const out = promoteTitleMatches(results, 'indoor greek');

    expect(out.map(r => r.slug)).toEqual([
      'notes/first',
      'notes/second',
      'notes/third',
    ]);
    expect(out.map(r => r.score)).toEqual([0.9, 0.8, 0.7]);
    expect(out.map(r => r.rerank_score)).toEqual([0.2, 0.9, 0.5]);
  });
});
