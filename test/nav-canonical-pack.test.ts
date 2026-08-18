/**
 * WS5b — pack-configurable canonical doc routing.
 *
 * Pins: a pack-declared nav_canonical config takes precedence over the
 * hardcoded defaults; invalid pack regexes are skipped; packs declaring
 * nothing get bit-for-bit prior behavior.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildNavArm } from '../src/core/search/nav-recall.ts';

const PACK = new Set(['decision', 'note']);

let eng: PGLiteEngine;

beforeAll(async () => {
  eng = new PGLiteEngine();
  await eng.connect({});
  await eng.initSchema();
  const pages: Array<[string, string, string]> = [
    ['write_policy', 'note', 'WRITE_POLICY'],
    ['schema', 'note', 'SCHEMA'],
    ['acme/wiki/query-surface', 'note', 'Acme Query Surface'],
  ];
  for (const [slug, type, title] of pages) {
    await eng.putPage(slug, { type: type as 'note', title, compiled_truth: `${title} body`, timeline: '' });
  }
}, 60_000);

afterAll(async () => {
  await eng.disconnect();
});

describe('navCanonical pack config', () => {
  test('pack topic map routes its own slugs first', async () => {
    const rows = await buildNavArm(eng, 'how to query the brain from the cli', {
      packTypes: PACK,
      navCanonical: {
        topics: [{ pattern: 'quer|cli', slugs: ['acme/wiki/query-surface'] }],
      },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].slug).toBe('acme/wiki/query-surface');
  });

  test('pack priority list replaces the default canonical list', async () => {
    const rows = await buildNavArm(eng, 'how do agents write facts to the brain', {
      packTypes: PACK,
      navCanonical: { priority: ['acme/wiki/query-surface'] },
    });
    // Topic map (write→write_policy/schema) still fires; priority tail is
    // the pack's list, not CANONICAL_DOC_SLUGS.
    const slugs = rows.map((r) => r.slug);
    expect(slugs).toContain('write_policy');
    expect(slugs).toContain('acme/wiki/query-surface');
  });

  test('invalid pack regex is skipped, valid entries still fire', async () => {
    const rows = await buildNavArm(eng, 'how to query the brain from the cli', {
      packTypes: PACK,
      navCanonical: {
        topics: [
          { pattern: '([invalid', slugs: ['schema'] },
          { pattern: 'quer', slugs: ['acme/wiki/query-surface'] },
        ],
      },
    });
    expect(rows.map((r) => r.slug)).toContain('acme/wiki/query-surface');
  });

  test('no pack config → hardcoded defaults (bit-for-bit)', async () => {
    const rows = await buildNavArm(eng, 'how do agents write facts to the brain', {
      packTypes: PACK,
    });
    const slugs = rows.map((r) => r.slug);
    expect(slugs.indexOf('write_policy')).toBeLessThan(2);
    expect(slugs.indexOf('schema')).toBeLessThan(2);
  });
});
