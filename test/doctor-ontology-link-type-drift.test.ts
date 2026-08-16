/**
 * raava/prod ontology v1 — doctor checkOntologyLinkTypeDrift unit test.
 *
 * Pins the ontology-drift gate: observed links.link_type values outside
 * the active pack's declared link_types warn; declared types + the base
 * ingest artifacts (mentions, wikilink_basename) stay quiet. Uses the
 * bundled gbrain-base pack (the default resolution target in a test env).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { checkOntologyLinkTypeDrift } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedPagesAndLink(linkType: string): Promise<void> {
  await engine.putPage('people/a', { type: 'person', title: 'A', compiled_truth: 'a', timeline: '' });
  await engine.putPage('companies/b', { type: 'company', title: 'B', compiled_truth: 'b', timeline: '' });
  await engine.addLink('people/a', 'companies/b', '', linkType, 'manual');
}

describe('doctor checkOntologyLinkTypeDrift', () => {
  test('empty links table → ok', async () => {
    const r = await checkOntologyLinkTypeDrift(engine);
    expect(r.name).toBe('ontology_link_type_drift');
    expect(r.status).toBe('ok');
  });

  test('pack-declared link type → ok', async () => {
    await seedPagesAndLink('invested_in'); // declared in gbrain-base
    const r = await checkOntologyLinkTypeDrift(engine);
    expect(r.status).toBe('ok');
  });

  test('base ingest artifacts (mentions / wikilink_basename) are exempt', async () => {
    await seedPagesAndLink('mentions');
    await engine.addLink('companies/b', 'people/a', '', 'wikilink_basename', 'ontology-structural');
    const r = await checkOntologyLinkTypeDrift(engine);
    expect(r.status).toBe('ok');
  });

  test('undeclared link type → warn with the type named', async () => {
    await seedPagesAndLink('governs'); // ontology type NOT in gbrain-base
    const r = await checkOntologyLinkTypeDrift(engine);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('governs');
    expect(r.message).toContain('link_types');
  });
});
