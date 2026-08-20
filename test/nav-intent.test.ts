/**
 * nav-intent parser unit tests (raava/prod ontology v1, WS3c).
 *
 * Precision-first contract: enumeration only fires on pack-declared types,
 * canonical only fires on brain-domain how-to topics. Everything else is
 * null so the normal hybrid pipeline runs unchanged.
 */

import { describe, test, expect } from 'bun:test';
import { parseNavQuery } from '../src/core/search/nav-intent.ts';

// Mirrors the raava-base pack's declared page types (subset).
const PACK = new Set([
  'decision', 'lesson', 'meeting', 'person', 'company', 'concept',
  'agent', 'thesis', 'run-log', 'event', 'diary', 'note', 'project',
]);

describe('parseNavQuery — enumerate', () => {
  test('"all decisions" → enumerate decision', () => {
    const r = parseNavQuery('all decisions', PACK);
    expect(r).toEqual({ kind: 'enumerate', pageType: 'decision' });
  });

  // WS6e — the "how do I find X" phrasing asks for the INSTRUCTION MANUAL
  // (canonical doc), not the items themselves. Changed from enumerate.
  test('"how do I find all decisions in the brain" → canonical (instruction manual)', () => {
    const r = parseNavQuery('how do I find all decisions in the brain', PACK);
    expect(r?.kind).toBe('canonical');
  });

  test('"list meetings" → enumerate meeting', () => {
    expect(parseNavQuery('list meetings', PACK)).toEqual({ kind: 'enumerate', pageType: 'meeting' });
  });

  test('plural -ies singularizes ("all theses" → thesis)', () => {
    expect(parseNavQuery('all theses', PACK)).toEqual({ kind: 'enumerate', pageType: 'thesis' });
  });

  test('hyphenated type ("all run-logs" → run-log)', () => {
    expect(parseNavQuery('all run-logs', PACK)).toEqual({ kind: 'enumerate', pageType: 'run-log' });
  });

  test('type not in pack → null (ontology-governed, no hardcoded types)', () => {
    expect(parseNavQuery('all spreadsheets', PACK)).toBeNull();
  });

  test('non-type head noun → null', () => {
    expect(parseNavQuery('all the things', PACK)).toBeNull();
  });
});

describe('parseNavQuery — canonical', () => {
  test('"how do agents write facts to the brain" → canonical', () => {
    const r = parseNavQuery('how do agents write facts to the brain', PACK);
    expect(r!.kind).toBe('canonical');
    expect(r!.topic).toMatch(/write facts to the brain/i);
  });

  test('"how to query the brain from the cli" → canonical', () => {
    expect(parseNavQuery('how to query the brain from the cli', PACK)!.kind).toBe('canonical');
  });

  // WS5b — phrasings observed missing in the 100-query eval.
  test('"where do agent journals live" → canonical', () => {
    const r = parseNavQuery('where do agent journals live', PACK);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('canonical');
  });

  test('"how are meeting notes ingested into the brain" → canonical', () => {
    const r = parseNavQuery('how are meeting notes ingested into the brain', PACK);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('canonical');
  });

  test('non-brain "where do bugs live" → null (domain gate)', () => {
    expect(parseNavQuery('where do bugs live', PACK)).toBeNull();
  });

  test('"how does an agent start a session with the remote brain" → canonical', () => {
    expect(parseNavQuery('how does an agent start a session with the remote brain', PACK)!.kind).toBe('canonical');
  });

  test('non-brain how-to → null (no routing to protocol docs)', () => {
    expect(parseNavQuery('how do I cook rice', PACK)).toBeNull();
    expect(parseNavQuery('how to change a tire', PACK)).toBeNull();
  });
});

describe('parseNavQuery — no-match / robustness', () => {
  test('ordinary content queries → null', () => {
    expect(parseNavQuery('what is the refund policy', PACK)).toBeNull();
    expect(parseNavQuery('brain decay audit july 2026', PACK)).toBeNull();
    expect(parseNavQuery('who invested in widget-co', PACK)).toBeNull();
  });

  test('empty / overlong → null', () => {
    expect(parseNavQuery('', PACK)).toBeNull();
    expect(parseNavQuery('all ' + 'x'.repeat(300), PACK)).toBeNull();
  });

  test('empty pack never enumerates', () => {
    expect(parseNavQuery('all decisions', new Set())).toBeNull();
  });
});
