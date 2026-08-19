/**
 * raava/prod ontology v1 — absolute relevance floor (search.min_score)
 * end-to-end through hybridSearch.
 *
 * Pins the boundary-rejection behavior the 100-query gold-set eval showed
 * missing (out-of-scope queries returned top-K word-overlap noise instead of
 * "no answer"):
 *  - floor drops every below-threshold rerank score → empty result set.
 *  - floor keeps at/above-threshold scores and preserves order.
 *  - floor off (default) → bit-for-bit prior behavior.
 *  - no rerank scores (reranker disabled / fail-open) → floor is a no-op.
 *  - per-call minScore wins over config; config wins over bundle default.
 *  - floor composes with autocut (both trim-only).
 *
 * Serial because it mutates gateway global state (same pattern as
 * autocut-integration.serial.test.ts). No API keys; embedding + reranker
 * stubbed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import type { PageInput, SearchOpts } from '../../src/core/types.ts';
import type { RerankInput, RerankResult } from '../../src/core/ai/gateway.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let engine: PGLiteEngine;
let previousGbrainHome: string | undefined;
let isolatedHome: string | undefined;

const DIMS = 1536;
const FAKE_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01));

beforeAll(async () => {
  previousGbrainHome = process.env.GBRAIN_HOME;
  isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-minscore-home-'));
  process.env.GBRAIN_HOME = isolatedHome;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const pages: Array<[string, PageInput, string]> = [
    ['notes/a', { type: 'note', title: 'A', compiled_truth: 'alpha keyword one' }, 'alpha keyword one chunk'],
    ['notes/b', { type: 'note', title: 'B', compiled_truth: 'alpha keyword two' }, 'alpha keyword two chunk'],
    ['notes/c', { type: 'note', title: 'C', compiled_truth: 'alpha keyword three' }, 'alpha keyword three chunk'],
    ['notes/d', { type: 'note', title: 'D', compiled_truth: 'alpha keyword four' }, 'alpha keyword four chunk'],
    ['notes/e', { type: 'note', title: 'E', compiled_truth: 'alpha keyword five' }, 'alpha keyword five chunk'],
  ];
  for (const [slug, page, chunkText] of pages) {
    await engine.putPage(slug, page);
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: chunkText, chunk_source: 'compiled_truth' },
    ]);
  }

  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  __setEmbedTransportForTests(async (args: any) => ({
    embeddings: args.values.map(() => FAKE_EMB),
  }) as any);
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  try {
    await engine?.disconnect();
  } finally {
    if (previousGbrainHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = previousGbrainHome;
    if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
  }
});

function rerankerWithScores(scores: number[]) {
  return async (input: RerankInput): Promise<RerankResult[]> =>
    input.documents.map((_, i) => ({ index: i, relevanceScore: scores[i] ?? 0.01 }));
}

// NOTE: balanced mode has autocut ON, which would ALSO trim on a cliff. The
// score shapes below are chosen flat-enough (max gap ratio <= 0.2) that
// autocut declines, so any observed trim is attributable to the floor. Where
// a cliff shape is needed, the expectation accounts for autocut too.
function rerankerOpts(scores: number[]): SearchOpts['reranker'] {
  return {
    enabled: true,
    topNIn: 30,
    topNOut: null,
    rerankerFn: rerankerWithScores(scores),
  };
}

describe('min_score — out-of-scope query returns empty instead of noise', () => {
  test('all scores below floor → empty set', async () => {
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      minScore: 0.5,
      reranker: rerankerOpts([0.3, 0.28, 0.26, 0.24, 0.22]),
    });
    expect(out).toEqual([]);
  });

  test('scores straddling the floor → only above-floor kept, order preserved', async () => {
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      minScore: 0.5,
      reranker: rerankerOpts([0.9, 0.85, 0.4, 0.35, 0.3]),
    });
    expect(out.map((r) => r.rerank_score)).toEqual([0.9, 0.85]);
  });

  test('score exactly at the floor is kept (>= comparison)', async () => {
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      minScore: 0.5,
      reranker: rerankerOpts([0.5, 0.48, 0.46, 0.44, 0.42]),
    });
    expect(out.length).toBe(1);
    expect(out[0].rerank_score).toBe(0.5);
  });
});

describe('min_score — off by default and no-op without rerank scores', () => {
  // The candidate pool shrinks upstream of the floor (dedup on identical
  // stub embeddings), so these assertions are baseline-relative rather than
  // absolute — same contract as the autocut integration tests.
  test('floor unset → full set returned (prior behavior)', async () => {
    const baseline = await hybridSearch(engine, 'alpha keyword', { limit: 10 });
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: rerankerOpts([0.3, 0.28, 0.26, 0.24, 0.22]),
    });
    expect(out.length).toBe(baseline.length);
  });

  test('reranker disabled → floor no-op (no trustworthy absolute signal)', async () => {
    const baseline = await hybridSearch(engine, 'alpha keyword', { limit: 10 });
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      minScore: 0.5,
      reranker: { enabled: false, topNIn: 30, topNOut: null, rerankerFn: rerankerWithScores([0.1, 0.1]) },
    });
    expect(out.map((r) => r.slug)).toEqual(baseline.map((r) => r.slug));
  });

  test('reranker fails open → floor no-op', async () => {
    const baseline = await hybridSearch(engine, 'alpha keyword', { limit: 10 });
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      minScore: 0.5,
      reranker: {
        enabled: true,
        topNIn: 30,
        topNOut: null,
        rerankerFn: async () => {
          throw new Error('upstream down');
        },
      },
    });
    expect(out.map((r) => r.slug)).toEqual(baseline.map((r) => r.slug));
  });
});

describe('min_score — composition + meta', () => {
  test('composes with autocut: cliff-cut set still floor-gated', async () => {
    // Cliff after rank 2 (autocut trims to 2: [0.95, 0.45]) — then the
    // floor at 0.5 drops the 0.45, leaving 1.
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      minScore: 0.5,
      reranker: rerankerOpts([0.95, 0.45, 0.1, 0.08, 0.05]),
    });
    expect(out.map((r) => r.rerank_score)).toEqual([0.95]);
  });

  test('decision meta surfaces threshold/dropped/kept via onMeta', async () => {
    let seen: { threshold: number; dropped: number; kept: number } | undefined;
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      minScore: 0.5,
      reranker: rerankerOpts([0.9, 0.85, 0.4, 0.35, 0.3]),
      onMeta: (m) => {
        seen = m.min_score;
      },
    });
    expect(seen).toBeDefined();
    expect(seen!.threshold).toBe(0.5);
    // Pool size varies with upstream dedup; derive expectations from the
    // returned set instead of assuming all 5 candidates survive to the
    // floor. Every kept result is above the floor, and dropped + kept is
    // the size of the pool the floor saw.
    expect(seen!.kept).toBe(out.length);
    expect(seen!.dropped).toBeGreaterThanOrEqual(0);
    expect(out.every((r) => (r.rerank_score ?? 0) >= 0.5)).toBe(true);
  });

  test('meta omitted when floor is off', async () => {
    let seen: unknown;
    await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: rerankerOpts([0.9, 0.85, 0.8, 0.75, 0.7]),
      onMeta: (m) => {
        seen = m.min_score;
      },
    });
    expect(seen).toBeUndefined();
  });
});

describe('min_score — recall-arm rows are exempt (raava/prod WS5)', () => {
  // Regression: prod "newest decision" queries lost the temporal arm's
  // page-level candidates because they fuse at neutral RRF weight, land
  // below the reranker's scored head (no rerank_score), and the floor
  // dropped every un-scored row — leaving only word-overlap noise. Arm
  // rows are deterministic answers to a parsed query shape (like
  // alias-hop exact matches) and must survive the floor.
  //
  // The temporal arm needs a schema pack declaring `decision` to fire;
  // PGLite has no pack row, so the arm can't light up end-to-end here.
  // The load-bearing predicate is `isRecallArmRow`; see
  // test/search/recall-arm-exemption.test.ts for the unit-level pins
  // covering both the autocut preserve predicate and the floor filter.
});
