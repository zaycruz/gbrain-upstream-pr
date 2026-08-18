/**
 * parseTemporalQuery unit tests (raava/prod WS5a). Pure, no DB.
 *
 * Pins the four resolution shapes plus the year-inference rules and the
 * non-temporal no-op contract.
 */

import { describe, test, expect } from 'bun:test';
import { parseTemporalQuery } from '../src/core/search/temporal-intent.ts';

const PACK = new Set(['decision', 'lesson', 'meeting', 'note', 'report', 'run-log']);
// Fixed clock: 2026-08-18 (Tuesday) so "this week" / omitted-year
// inference are deterministic.
const NOW = new Date('2026-08-18T12:00:00Z');

describe('parseTemporalQuery — exact_date', () => {
  test('"daily report august 3 2026" → exact date + slug family', () => {
    const r = parseTemporalQuery('brain ops daily report august 3 2026', PACK, NOW);
    expect(r).toEqual({
      kind: 'exact_date',
      since: '2026-08-03',
      until: '2026-08-04',
      pageType: 'report',
      slugFamily: 'daily report',
    });
  });

  test('ISO date in query wins', () => {
    const r = parseTemporalQuery('what happened on 2026-07-20', PACK, NOW);
    expect(r?.kind).toBe('exact_date');
    expect(r?.since).toBe('2026-07-20');
    expect(r?.until).toBe('2026-07-21');
  });

  test('omitted year infers most recent non-future date (past month)', () => {
    // "july 20" asked on 2026-08-18 → 2026-07-20 (already past).
    const r = parseTemporalQuery('daily report july 20', PACK, NOW);
    expect(r?.since).toBe('2026-07-20');
  });

  test('omitted year rolls back when the date is still in the future', () => {
    // "december 25" asked on 2026-08-18 → 2025-12-25.
    const r = parseTemporalQuery('notes from december 25', PACK, NOW);
    expect(r?.since).toBe('2025-12-25');
  });

  test('ordinal suffix tolerated ("august 3rd 2026")', () => {
    const r = parseTemporalQuery('report august 3rd 2026', PACK, NOW);
    expect(r?.since).toBe('2026-08-03');
  });

  test('invalid day-of-month ("february 31") does not fire', () => {
    const r = parseTemporalQuery('meeting february 31 2026', PACK, NOW);
    expect(r?.kind).not.toBe('exact_date');
  });
});

describe('parseTemporalQuery — month_window', () => {
  test('"decisions in july 2026" → window + type hint', () => {
    const r = parseTemporalQuery('which decisions were made in july 2026', PACK, NOW);
    expect(r?.kind).toBe('month_window');
    expect(r?.since).toBe('2026-07-01');
    expect(r?.until).toBe('2026-08-01');
    expect(r?.pageType).toBe('decision');
  });

  test('bare "in july" (no year) infers the current year when past', () => {
    const r = parseTemporalQuery('reports about brain health in july', PACK, NOW);
    expect(r?.kind).toBe('month_window');
    expect(r?.since).toBe('2026-07-01');
  });

  test('bare "in december" rolls back to last year when month is future', () => {
    const r = parseTemporalQuery('decisions in december', PACK, NOW);
    expect(r?.since).toBe('2025-12-01');
    expect(r?.until).toBe('2026-01-01');
  });
});

describe('parseTemporalQuery — superlative', () => {
  test('"newest decision" → superlative + type', () => {
    const r = parseTemporalQuery('what is the newest decision in the brain', PACK, NOW);
    expect(r?.kind).toBe('superlative');
    expect(r?.pageType).toBe('decision');
  });

  test('"most recent brain daily report" → superlative + slug family', () => {
    const r = parseTemporalQuery('what is the most recent brain daily report', PACK, NOW);
    expect(r?.kind).toBe('superlative');
    expect(r?.slugFamily).toBe('daily report');
  });

  test('"latest brain health status" → superlative + slug family', () => {
    const r = parseTemporalQuery('latest brain health status', PACK, NOW);
    expect(r?.kind).toBe('superlative');
    expect(r?.slugFamily).toBe('brain health');
  });
});

describe('parseTemporalQuery — relative_window', () => {
  test('"what changed in the brain this week" → 7-day window', () => {
    const r = parseTemporalQuery('what changed in the brain this week', PACK, NOW);
    expect(r?.kind).toBe('relative_window');
    expect(r?.days).toBe(7);
  });

  test('"recent gbrain escalations" → 14-day window', () => {
    const r = parseTemporalQuery('recent gbrain escalations', PACK, NOW);
    expect(r?.kind).toBe('relative_window');
    expect(r?.days).toBe(14);
  });

  test('"this month" → 31-day window', () => {
    const r = parseTemporalQuery('new lessons this month', PACK, NOW);
    expect(r?.days).toBe(31);
  });
});

describe('parseTemporalQuery — no-op contract', () => {
  test('non-temporal query returns null', () => {
    expect(parseTemporalQuery('foundry internal api application layer', PACK, NOW)).toBeNull();
  });

  test('boundary query returns null (floor handles these)', () => {
    expect(parseTemporalQuery('what is the weather in new york today', PACK, NOW)?.kind)
      .toBe('relative_window'); // "today" is temporal — but the floor still gates the outcome
    expect(parseTemporalQuery('who is the CEO of OpenAI', PACK, NOW)).toBeNull();
  });

  test('empty / oversized query returns null', () => {
    expect(parseTemporalQuery('', PACK, NOW)).toBeNull();
    expect(parseTemporalQuery('x'.repeat(201), PACK, NOW)).toBeNull();
  });

  test('type hint only resolves pack-declared types', () => {
    // "escalations" is not in PACK → pageType stays undefined.
    const r = parseTemporalQuery('what escalations are open in july 2026', PACK, NOW);
    expect(r?.pageType).toBeUndefined();
  });
});
