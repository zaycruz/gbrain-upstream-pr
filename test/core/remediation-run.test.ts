import { describe, expect, test } from 'bun:test';
import { makeRemediationStep } from '../../src/core/remediation-step.ts';
import { excludeAbortedRemediations } from '../../src/core/remediation/run.ts';

describe('remediation recheck', () => {
  test('does not requeue a remediation that already reached a terminal failure', () => {
    const failedSync = makeRemediationStep({
      id: 'sync.repo',
      job: 'sync',
      params: { repoPath: '/missing/repo' },
      severity: 'high',
      est_seconds: 5,
      rationale: 'synchronize stale source',
    });
    const dependentExtract = makeRemediationStep({
      id: 'extract.all',
      job: 'extract',
      params: { mode: 'all' },
      severity: 'medium',
      est_seconds: 5,
      depends_on: ['sync.repo'],
      rationale: 'extract source content',
    });

    const remaining = excludeAbortedRemediations(
      [failedSync, dependentExtract],
      new Set(['sync.repo']),
    );

    expect(remaining.map((step) => step.id)).toEqual(['extract.all']);
  });
});
