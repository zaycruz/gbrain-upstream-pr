/**
 * raava/prod WS2 — structural + semantic typed-edge extraction.
 *
 * The extract phase historically emitted only `mentions` /
 * `wikilink_basename` edges from body links, plus a small hardcoded verb
 * set from frontmatter. The ontology v1 vocabulary (raava-base schema
 * pack; raava-brain concepts/engineering/raava-brain-ontology-v1.md)
 * adds structural edges derivable from repo structure and frontmatter
 * with certainty, and semantic edges derivable from high-signal prose
 * markers.
 *
 * Design rules:
 *   - Every edge emitted here has confidence 1.0 (structural) or is
 *     explicitly confidence-tagged in context (semantic).
 *   - `.archive/` targets are dropped — dead migration paths are not
 *     knowledge.
 *   - Run-logs (agents/@<handle>/memory/runs/) never participate.
 *   - `mentions`/`wikilink_basename` stay untouched for back-compat;
 *     retrieval-side exclusion happens in the query layer (WS3), not here.
 */

export interface StructuralEdgeInput {
  /** Slug of the page being processed (e.g. "decisions/2026-07-19-gbrain-stays-on-gcp"). */
  slug: string;
  /** Parsed YAML frontmatter of the page. */
  frontmatter: Record<string, unknown>;
  /** All known slugs in the brain (for `related:`/`see-also:` resolution). */
  allSlugs: Set<string>;
}

export interface StructuralEdge {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
  link_source: string;
}

/** Agent handle pattern for authored_by targets: agents/@<handle>. */
const AGENT_HANDLE_RE = /^@?[a-z0-9][a-z0-9-]*$/i;

/** Slug prefixes that must never receive or emit ontology edges. */
const EXCLUDED_PREFIXES = ['.archive/', '.demos/', '.labs/'];

function isExcludedSlug(slug: string): boolean {
  const lower = slug.toLowerCase();
  if (EXCLUDED_PREFIXES.some((p) => lower.startsWith(p))) return true;
  // Run-logs: agents/@<handle>/memory/runs/* are search-excluded telemetry.
  if (/^agents\/@[^/]+\/memory\/runs\//.test(lower)) return true;
  return false;
}

/** Normalize a frontmatter array-or-string field into clean strings. */
function asStringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

/**
 * Resolve a `related:`/`see-also:` entry to a known slug.
 * Entries may be exact slugs ("concepts/shared/canonical_sources"),
 * wikilink-ish ("[[schema]]"), or bare basenames ("write_policy").
 */
function resolveReference(entry: string, allSlugs: Set<string>): string | null {
  let s = entry.trim();
  if (s.startsWith('[[') && s.endsWith(']]')) s = s.slice(2, -2);
  // Strip optional pipe alias and trailing .md
  s = s.split('|')[0]!.trim().replace(/\.md$/i, '');
  if (!s) return null;
  const lower = s.toLowerCase();
  if (allSlugs.has(lower)) return lower;
  // Basename match: unique hit wins, ambiguity drops the edge (fail-quiet).
  const matches: string[] = [];
  for (const slug of allSlugs) {
    const base = slug.slice(slug.lastIndexOf('/') + 1);
    if (base === lower) matches.push(slug);
  }
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Emit Tier-1 structural + curated-reference edges for one page.
 *
 *   filed_under  — page → its top-level domain concept (decisions/ → decisions index)
 *   authored_by  — page → agents/@<handle> when written_by names an agent
 *   references   — page → pages named in `related:` / `see-also:` frontmatter
 */
export function extractStructuralEdges(input: StructuralEdgeInput): StructuralEdge[] {
  const { slug, frontmatter, allSlugs } = input;
  if (isExcludedSlug(slug)) return [];
  const edges: StructuralEdge[] = [];

  // filed_under: page → top-level domain index when that index page exists.
  // decisions/2026-07-19-x → decisions (if a `decisions` or
  // `decisions/index` slug exists). Confidence 1.0 — pure structure.
  const topDir = slug.split('/')[0];
  if (topDir && slug.includes('/')) {
    const indexCandidates = [`${topDir}/index`, topDir];
    for (const candidate of indexCandidates) {
      if (allSlugs.has(candidate) && candidate !== slug) {
        edges.push({
          from_slug: slug,
          to_slug: candidate,
          link_type: 'filed_under',
          context: `structural: ${slug} is filed under ${topDir}/`,
          link_source: 'ontology-structural',
        });
        break;
      }
    }
  }

  // authored_by: written_by frontmatter naming an agent handle.
  // Accepts "@brain-manager", "brain-manager", or "human" (skipped — no page).
  const writtenBy = typeof frontmatter.written_by === 'string' ? frontmatter.written_by.trim() : '';
  if (writtenBy && writtenBy.toLowerCase() !== 'human') {
    const handle = writtenBy.replace(/^@/, '');
    if (AGENT_HANDLE_RE.test(handle)) {
      const agentSlug = `agents/@${handle.toLowerCase()}`;
      for (const candidate of [agentSlug, `${agentSlug}/index`]) {
        if (allSlugs.has(candidate)) {
          edges.push({
            from_slug: slug,
            to_slug: candidate,
            link_type: 'authored_by',
            context: `frontmatter written_by: ${writtenBy}`,
            link_source: 'ontology-structural',
          });
          break;
        }
      }
    }
  }

  // references: curated related:/see-also: frontmatter arrays. These are
  // the hand-maintained graph — highest-value edges in the corpus.
  const refFields = [...asStringList(frontmatter.related), ...asStringList(frontmatter['see-also'])];
  const seen = new Set<string>();
  for (const entry of refFields) {
    const target = resolveReference(entry, allSlugs);
    if (!target || target === slug || seen.has(target)) continue;
    if (isExcludedSlug(target)) continue;
    seen.add(target);
    edges.push({
      from_slug: slug,
      to_slug: target,
      link_type: 'references',
      context: `frontmatter reference: ${entry}`,
      link_source: 'ontology-frontmatter',
    });
  }

  return edges;
}
