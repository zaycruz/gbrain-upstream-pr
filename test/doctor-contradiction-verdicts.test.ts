import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { buildChecks } from '../src/commands/doctor.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function writeRun(contradictions: Array<Record<string, unknown>>): Promise<void> {
  await engine.writeContradictionsRun({
    run_id: crypto.randomUUID(),
    judge_model: 'test:judge',
    prompt_version: 'test',
    queries_evaluated: 2,
    queries_with_contradiction: 2,
    total_contradictions_flagged: contradictions.length,
    wilson_ci_lower: 0.1,
    wilson_ci_upper: 0.9,
    judge_errors_total: 0,
    cost_usd_total: 0,
    duration_ms: 1,
    source_tier_breakdown: {},
    report_json: {
      per_query: [
        { query: 'first', contradictions },
        { query: 'second', contradictions: [] },
      ],
    },
  });
}

function finding(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    verdict: 'contradiction',
    severity: 'high',
    axis: 'conflicting value',
    a: { slug: 'health/older' },
    b: { slug: 'health/newer' },
    resolution_command: 'gbrain takes supersede health/older --row 1',
    ...overrides,
  };
}

describe('doctor contradiction verdict handling', () => {
  test('high temporal classifications do not create a warning', async () => {
    await writeRun([
      finding({ verdict: 'temporal_regression', severity: 'high' }),
      finding({ verdict: 'negation_artifact', severity: 'low' }),
      finding({ verdict: 'contradiction', severity: 'medium' }),
    ]);

    const check = (await buildChecks(engine, [])).find((item) => item.name === 'contradictions');

    expect(check?.status).toBe('ok');
    expect(check?.message).toContain('1 genuine contradiction(s) (high=0 medium=1 low=0)');
    expect(check?.message).toContain('excluded 2 temporal or negation classification(s)');
    expect(check?.message).not.toContain('HIGH: health/older vs health/newer');
  });

  test('legacy findings without verdict keep their warning behavior', async () => {
    const legacy = finding({});
    delete legacy.verdict;
    await writeRun([legacy]);

    const check = (await buildChecks(engine, [])).find((item) => item.name === 'contradictions');

    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('1 genuine contradiction(s) (high=1 medium=0 low=0)');
    expect(check?.message).toContain('HIGH: health/older vs health/newer');
  });
});
