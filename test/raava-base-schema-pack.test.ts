import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';

const BASE_PATH = join(import.meta.dir, '../src/core/schema-pack/base/gbrain-base.yaml');
const RAAVA_PATH = join(import.meta.dir, '../src/core/schema-pack/base/raava-base.yaml');

const RAAVA_TYPES = [
  'decision',
  'lesson',
  'thesis',
  'journal',
  'research',
  'runbook',
  'memory',
  'adr',
  'knowledge-base',
  'ops-note',
];

describe('raava-base bundled schema pack', () => {
  test('is a self-contained superset of gbrain-base page types', () => {
    const base = loadPackFromFile(BASE_PATH);
    const raava = loadPackFromFile(RAAVA_PATH);
    const raavaTypes = new Set(raava.page_types.map((pt) => pt.name));

    expect(raava.name).toBe('raava-base');
    expect(raava.extends).toBe('gbrain-base');
    expect(base.page_types).toHaveLength(25);
    expect(raava.page_types).toHaveLength(base.page_types.length + RAAVA_TYPES.length);
    for (const pt of base.page_types) {
      expect(raavaTypes.has(pt.name)).toBe(true);
    }
    for (const name of RAAVA_TYPES) {
      expect(raavaTypes.has(name)).toBe(true);
    }
  });

  test('copies base companion sections instead of relying on extends', () => {
    const base = loadPackFromFile(BASE_PATH);
    const raava = loadPackFromFile(RAAVA_PATH);

    expect(raava.link_types).toEqual(base.link_types);
    expect(raava.frontmatter_links).toEqual(base.frontmatter_links);
    expect(raava.enrichable_types).toEqual(base.enrichable_types);
    expect(raava.filing_rules).toEqual(base.filing_rules);
    expect(raava.takes_kinds).toEqual(base.takes_kinds);
  });

  test('folds Raava aliases without declaring migration rules', () => {
    const raw = readFileSync(RAAVA_PATH, 'utf8');
    const raava = loadPackFromFile(RAAVA_PATH);
    const byName = new Map(raava.page_types.map((pt) => [pt.name, pt]));

    expect(raw).not.toContain('mapping_rules');
    expect(byName.get('lesson')?.aliases).toEqual(['lesson-learned']);
    expect(byName.get('journal')?.path_prefixes).toEqual(['agents/*/journal/']);
    expect(byName.get('journal')?.aliases).toEqual(['daily-journal', 'daily-note']);
    expect(byName.get('adr')?.aliases).toEqual(['ADR']);
    expect(byName.get('knowledge-base')?.aliases).toEqual(['knowledge']);
  });
});
