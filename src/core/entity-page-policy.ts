/**
 * SQL predicate for canonical entity pages.
 *
 * Pages ending in `/_notes` are agent-maintained support notes. They retain
 * an entity type for routing, but graph and timeline coverage belong to the
 * canonical entity page named by their frontmatter entity_slug.
 */
export function canonicalEntitySlugPredicate(alias = ''): string {
  const column = alias ? `${alias}.slug` : 'slug';
  return `${column} NOT LIKE '%/\\_notes' ESCAPE '\\'`;
}
