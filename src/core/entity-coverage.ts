const ENTITY_TYPES_SQL = "('entity', 'person', 'company', 'organization')";

/**
 * SQL predicate for canonical entity records that own graph coverage.
 * Agent-maintained `/_notes/` pages can use entity-compatible types, but they
 * are annotations, not independent entities and must not dilute coverage.
 */
export function entityCoveragePredicate(alias?: string): string {
  if (alias !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }

  const prefix = alias ? `${alias}.` : '';
  return [
    `${prefix}type IN ${ENTITY_TYPES_SQL}`,
    `${prefix}deleted_at IS NULL`,
    `POSITION('/_notes/' IN ${prefix}slug) = 0`,
  ].join(' AND ');
}
