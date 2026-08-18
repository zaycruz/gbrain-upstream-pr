/**
 * buildTemporalArm unit tests (PGLite, raava/prod WS5a).
 *
 * Pins: exact-date slug probe hits the date-stamped slug at rank 1,
 * month-window enumerates effective_date + slug-dated pages,
 * superlative returns newest-first, relative window catches recent pages,
 * .archive/ and soft-deleted are always excluded, and non-temporal
 * queries are a pure no-op.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildTemporalArm } from '../src/core/search/temporal-recall.ts';

const PACK = new Set(['decision', 'lesson', 'meeting', 'note', 'report']);
const NOW = new Date('2026-08-18T12:00:00Z');

let eng: PGLiteEngine;

beforeAll(async () => {
  eng = new PGLiteEngine();
  await eng.connect({});
  await eng.initSchema();

  const pages: Array<[string, string, string, string | null]> = [
    // slug, type, title, effective_date (ISO or null)
    ['brain-ops/daily-report-2026-08-03', 'report', 'Daily report Aug 3', '2026-08-03T00:00:00Z'],
    ['brain-ops/daily-report-2026-08-02', 'report', 'Daily report Aug 2', '2026-08-02T00:00:00Z'],
    ['brain-ops/daily-report-2026-07-20', 'report', 'Daily report Jul 20', '2026-07-20T00:00:00Z'],
    ['decisions/2026-07-19-gbrain-stays-on-gcp', 'decision', 'gbrain stays on GCP', '2026-07-19T00:00:00Z'],
    ['decisions/2026-07-04-gcp-exit', 'decision', 'GCP exit reconciliation', '2026-07-04T00:00:00Z'],
    ['decisions/adr-brain-ci-cd-policy-gates-2026-08-11', 'decision', 'CI/CD policy gates', '2026-08-11T00:00:00Z'],
    ['decisions/old-undated-decision', 'decision', 'Undated legacy decision', null],
    ['brain-ops/brain-health-2026-07-25', 'note', 'Brain health Jul 25', '2026-07-25T00:00:00Z'],
    ['inbox/2026-08-17-recent-note', 'note', 'Recent inbox note', null], // slug-dated only
    ['.archive/brain-ops/daily-report-2026-08-01', 'report', 'Archived report', '2026-08-01T00:00:00Z'],
    ['brain-ops/daily-report-2026-08-04-deleted', 'report', 'Deleted report', '2026-08-04T00:00:00Z'],
  ];
  for (const [slug, type, title, ed] of pages) {
    await eng.putPage(slug, {
      type: type as 'note',
      title,
      compiled_truth: `${title} body text`,
      timeline: '',
    });
    if (ed) {
      await eng.executeRaw(`UPDATE pages SET effective_date = $1 WHERE slug = $2`, [ed, slug]);
    }
  }
  await eng.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = $1`, [
    'brain-ops/daily-report-2026-08-04-deleted',
  ]);
}, 60_000);

afterAll(async () => {
  await eng.disconnect();
});

describe('buildTemporalArm — exact_date', () => {
  test('"daily report august 3 2026" probes the date-stamped slug at rank 1', async () => {
    const rows = await buildTemporalArm(eng, 'brain ops daily report august 3 2026', {
      packTypes: PACK, now: NOW,
    });
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe('brain-ops/daily-report-2026-08-03');
    expect(rows[0].temporal_kind).toBe('exact_date');
  });

  test('ISO date query probes the slug', async () => {
    const rows = await buildTemporalArm(eng, 'daily report 2026-07-20', {
      packTypes: PACK, now: NOW,
    });
    expect(rows.map((r) => r.slug)).toContain('brain-ops/daily-report-2026-07-20');
  });

  test('.archive/ and soft-deleted never surface', async () => {
    const rows = await buildTemporalArm(eng, 'daily report august 1 2026', {
      packTypes: PACK, now: NOW,
    });
    expect(rows.map((r) => r.slug)).not.toContain('.archive/brain-ops/daily-report-2026-08-01');
    const rows2 = await buildTemporalArm(eng, 'daily report august 4 2026', {
      packTypes: PACK, now: NOW,
    });
    expect(rows2.map((r) => r.slug)).not.toContain('brain-ops/daily-report-2026-08-04-deleted');
  });
});

describe('buildTemporalArm — month_window', () => {
  test('"decisions in july 2026" enumerates both July decisions', async () => {
    const rows = await buildTemporalArm(eng, 'which decisions were made in july 2026', {
      packTypes: PACK, now: NOW,
    });
    const slugs = rows.map((r) => r.slug);
    expect(slugs).toContain('decisions/2026-07-19-gbrain-stays-on-gcp');
    expect(slugs).toContain('decisions/2026-07-04-gcp-exit');
    expect(slugs).not.toContain('decisions/adr-brain-ci-cd-policy-gates-2026-08-11');
    expect(slugs).not.toContain('decisions/old-undated-decision');
    expect(rows.every((r) => r.temporal_kind === 'month_window')).toBe(true);
  });

  test('month window without a type hint covers reports too', async () => {
    const rows = await buildTemporalArm(eng, 'what happened in july 2026', {
      packTypes: PACK, now: NOW,
    });
    const slugs = rows.map((r) => r.slug);
    expect(slugs).toContain('brain-ops/daily-report-2026-07-20');
    expect(slugs).toContain('decisions/2026-07-19-gbrain-stays-on-gcp');
  });
});

describe('buildTemporalArm — superlative', () => {
  test('"newest decision" returns the most recent decision first', async () => {
    const rows = await buildTemporalArm(eng, 'what is the newest decision in the brain', {
      packTypes: PACK, now: NOW,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].slug).toBe('decisions/adr-brain-ci-cd-policy-gates-2026-08-11');
    expect(rows.every((r) => r.type === 'decision')).toBe(true);
  });
});

describe('buildTemporalArm — relative_window', () => {
  test('"this week" catches the slug-dated inbox note from 2026-08-17', async () => {
    const rows = await buildTemporalArm(eng, 'what changed in the brain this week', {
      packTypes: PACK, now: NOW,
    });
    const slugs = rows.map((r) => r.slug);
    expect(slugs).toContain('inbox/2026-08-17-recent-note');
    // PGLite stamps updated_at = real now() on every test page, so the
    // window contains all rows; the arm must still order by
    // effective_date/updated_at desc so genuinely-recent pages lead.
    expect(rows.every((r) => r.temporal_kind === 'relative_window')).toBe(true);
  });
});

describe('buildTemporalArm — contract', () => {
  test('non-temporal query is a pure no-op', async () => {
    expect(
      await buildTemporalArm(eng, 'foundry internal api application layer', {
        packTypes: PACK, now: NOW,
      }),
    ).toEqual([]);
  });

  test('meta fires through onMeta', async () => {
    let seen: import('../src/core/search/temporal-recall.ts').TemporalArmMeta | undefined;
    await buildTemporalArm(eng, 'newest decision', {
      packTypes: PACK, now: NOW,
      onMeta: (m) => { seen = m; },
    });
    expect(seen).toBeDefined();
    expect(seen!.kind).toBe('superlative');
    expect(seen!.fired).toBe(true);
  });
});
