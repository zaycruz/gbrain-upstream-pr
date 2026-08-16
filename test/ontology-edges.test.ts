import { describe, expect, test } from 'bun:test';
import { extractStructuralEdges } from '../src/core/ontology-edges.ts';

const ALL_SLUGS = new Set([
  'decisions',
  'decisions/index',
  'decisions/2026-07-19-gbrain-stays-on-gcp',
  'concepts/engineering/gbrain-architecture',
  'concepts/engineering/index',
  'concepts/shared/canonical_sources',
  'agents/@brain-manager',
  'agents/@brain-manager/index',
  'agents/@codex/memory/runs/2026-08-15-run',
  '.archive/old-vault/write_policy',
  'schema',
  'write_policy',
]);

describe('extractStructuralEdges (ontology v1)', () => {
  test('filed_under links a decision page to the decisions index', () => {
    const edges = extractStructuralEdges({
      slug: 'decisions/2026-07-19-gbrain-stays-on-gcp',
      frontmatter: {},
      allSlugs: ALL_SLUGS,
    });
    const filed = edges.filter((e) => e.link_type === 'filed_under');
    expect(filed).toHaveLength(1);
    expect(filed[0]!.to_slug).toBe('decisions/index');
    expect(filed[0]!.link_source).toBe('ontology-structural');
  });

  test('authored_by resolves an agent handle to the agent page', () => {
    const edges = extractStructuralEdges({
      slug: 'concepts/engineering/gbrain-architecture',
      frontmatter: { written_by: '@brain-manager' },
      allSlugs: ALL_SLUGS,
    });
    const authored = edges.filter((e) => e.link_type === 'authored_by');
    expect(authored).toHaveLength(1);
    expect(authored[0]!.to_slug).toBe('agents/@brain-manager');
  });

  test('authored_by skips human authors', () => {
    const edges = extractStructuralEdges({
      slug: 'concepts/engineering/gbrain-architecture',
      frontmatter: { written_by: 'human' },
      allSlugs: ALL_SLUGS,
    });
    expect(edges.filter((e) => e.link_type === 'authored_by')).toHaveLength(0);
  });

  test('references resolves related: and see-also: entries to slugs', () => {
    const edges = extractStructuralEdges({
      slug: 'concepts/shared/canonical_sources',
      frontmatter: {
        related: ['schema', '[[write_policy]]', 'concepts/engineering/gbrain-architecture'],
        'see-also': ['nonexistent-page'],
      },
      allSlugs: ALL_SLUGS,
    });
    const refs = edges.filter((e) => e.link_type === 'references');
    expect(refs.map((r) => r.to_slug).sort()).toEqual([
      'concepts/engineering/gbrain-architecture',
      'schema',
      'write_policy',
    ]);
  });

  test('references drops ambiguous basename matches (fail-quiet)', () => {
    const slugs = new Set(['a/dup', 'b/dup', 'single']);
    const edges = extractStructuralEdges({
      slug: 'single',
      frontmatter: { related: ['dup'] },
      allSlugs: slugs,
    });
    expect(edges.filter((e) => e.link_type === 'references')).toHaveLength(0);
  });

  test('excludes .archive/ targets and self-loops', () => {
    const edges = extractStructuralEdges({
      slug: 'schema',
      frontmatter: { related: ['.archive/old-vault/write_policy', 'schema'] },
      allSlugs: ALL_SLUGS,
    });
    expect(edges.filter((e) => e.link_type === 'references')).toHaveLength(0);
  });

  test('run-log pages emit no ontology edges at all', () => {
    const edges = extractStructuralEdges({
      slug: 'agents/@codex/memory/runs/2026-08-15-run',
      frontmatter: { written_by: '@codex', related: ['schema'] },
      allSlugs: ALL_SLUGS,
    });
    expect(edges).toHaveLength(0);
  });

  test('dedupes repeated references to the same target', () => {
    const edges = extractStructuralEdges({
      slug: 'concepts/shared/canonical_sources',
      frontmatter: { related: ['schema'], 'see-also': ['schema'] },
      allSlugs: ALL_SLUGS,
    });
    expect(edges.filter((e) => e.link_type === 'references')).toHaveLength(1);
  });
});
