import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { backfillEffectiveDate } from '../src/core/backfill-effective-date.ts';
import { runReindexFrontmatter } from '../src/commands/reindex-frontmatter.ts';

describe('backfillEffectiveDate source scope', () => {
  test('filters page reads to the requested source', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const engine = {
      kind: 'pglite',
      executeRaw: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return [];
      },
    } as unknown as BrainEngine;

    await backfillEffectiveDate(engine, { fresh: true, sourceId: 'source-a' });

    const pageRead = calls.find(call => call.sql.includes('FROM pages'));
    expect(pageRead).toBeDefined();
    expect(pageRead!.sql).toContain('source_id = $2');
    expect(pageRead!.params).toEqual([0, 'source-a', 1000]);
  });

  test('forwards the CLI source filter into a dry-run backfill', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const engine = {
      kind: 'pglite',
      executeRaw: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return sql.includes('COUNT(*)') ? [{ n: '1' }] : [];
      },
    } as unknown as BrainEngine;

    const result = await runReindexFrontmatter(engine, {
      sourceId: 'source-a',
      dryRun: true,
    });

    expect(result.source_filter).toBe('source-a');
    const pageRead = calls.find(call => call.sql.includes('SELECT id, slug'));
    expect(pageRead!.params).toEqual([0, 'source-a', 1]);
  });
});
