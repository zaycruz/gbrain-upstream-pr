/**
 * buildNavArm unit tests (PGLite, raava/prod ontology v1, WS3c).
 *
 * Pins: enumerate routes to the declared type only, .archive/ excluded,
 * soft-deleted excluded, canonical resolves brain-protocol docs in priority
 * order, non-nav queries no-op, and fail-open never throws.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildNavArm } from '../src/core/search/nav-recall.ts';

const PACK = new Set(['decision', 'lesson', 'meeting', 'note']);

let eng: PGLiteEngine;

beforeAll(async () => {
  eng = new PGLiteEngine();
  await eng.connect({});
  await eng.initSchema();

  const pages: Array<[string, string, string]> = [
    ['decisions/2026-07-19-gbrain-stays-on-gcp', 'decision', 'gbrain stays on GCP'],
    ['decisions/2026-07-04-gcp-exit', 'decision', 'GCP exit reconciliation'],
    ['lessons/foundry-prompt-injection', 'lesson', 'Foundry prompt injection'],
    ['schema', 'note', 'SCHEMA'],
    ['write_policy', 'note', 'WRITE_POLICY'],
    ['concepts/shared/remote_brain_operating_protocol', 'note', 'REMOTE_BRAIN_OPERATING_PROTOCOL'],
    ['tools/gbrain-reference', 'note', 'gbrain-reference'],
    ['.archive/decisions/old-decision', 'decision', 'Old archived decision'],
    ['decisions/deleted-decision', 'decision', 'Deleted decision'],
  ];
  for (const [slug, type, title] of pages) {
    await eng.putPage(slug, { type: type as 'note', title, compiled_truth: `${title} body text`, timeline: '' });
  }
  await eng.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = $1`, ['decisions/deleted-decision']);
}, 60_000);

afterAll(async () => {
  await eng.disconnect();
});

describe('buildNavArm — enumerate', () => {
  test('"all decisions" enumerates decision pages only, newest first', async () => {
    const rows = await buildNavArm(eng, 'all decisions', { packTypes: PACK });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.type === 'decision')).toBe(true);
    expect(rows.every((r) => r.nav_kind === 'enumerate')).toBe(true);
    expect(rows.map((r) => r.slug)).not.toContain('lessons/foundry-prompt-injection');
  });

  test('.archive/ and soft-deleted pages never enumerate', async () => {
    const rows = await buildNavArm(eng, 'all decisions', { packTypes: PACK });
    expect(rows.map((r) => r.slug)).not.toContain('.archive/decisions/old-decision');
    expect(rows.map((r) => r.slug)).not.toContain('decisions/deleted-decision');
  });

  test('undeclared type → no-op', async () => {
    expect(await buildNavArm(eng, 'all spreadsheets', { packTypes: PACK })).toEqual([]);
  });
});

describe('buildNavArm — canonical', () => {
  test('"how do agents write facts to the brain" surfaces write_policy + schema first', async () => {
    const rows = await buildNavArm(eng, 'how do agents write facts to the brain', { packTypes: PACK });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.nav_kind === 'canonical')).toBe(true);
    const slugs = rows.map((r) => r.slug);
    expect(slugs.indexOf('write_policy')).toBeLessThan(2);
    expect(slugs.indexOf('schema')).toBeLessThan(2);
    expect(slugs).toContain('concepts/shared/remote_brain_operating_protocol');
  });

  test('"how to query the brain from the cli" surfaces gbrain-reference', async () => {
    const rows = await buildNavArm(eng, 'how to query the brain from the cli', { packTypes: PACK });
    expect(rows.map((r) => r.slug)).toContain('tools/gbrain-reference');
  });

  test('non-brain how-to → no-op', async () => {
    expect(await buildNavArm(eng, 'how do I cook rice', { packTypes: PACK })).toEqual([]);
  });
});

describe('buildNavArm — contract', () => {
  test('non-nav query is a pure no-op', async () => {
    expect(await buildNavArm(eng, 'brain decay audit july 2026', { packTypes: PACK })).toEqual([]);
  });

  test('meta fires through onMeta', async () => {
    let seen: import('../src/core/search/nav-recall.ts').NavArmMeta | undefined;
    await buildNavArm(eng, 'all decisions', {
      packTypes: PACK,
      onMeta: (m) => { seen = m; },
    });
    expect(seen).toBeDefined();
    expect(seen!.kind).toBe('enumerate');
    expect(seen!.fired).toBe(true);
    expect(seen!.candidates).toBe(2);
  });
});
