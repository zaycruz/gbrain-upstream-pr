import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChecks, type Check } from '../src/commands/doctor.ts';
import {
  logContentSanityAssessment,
  type ContentSanityEventType,
} from '../src/core/audit/content-sanity-audit.ts';
import type { ContentSanityResult } from '../src/core/content-sanity.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function result(kind: 'warn' | 'soft' | 'hard'): ContentSanityResult {
  const hard = kind === 'hard';
  const soft = kind === 'soft';
  const warn = kind === 'warn';
  return {
    bytes: warn ? 100_000 : soft ? 600_000 : 287,
    oversize: soft,
    junk_pattern_matches: hard ? ['access_denied'] : [],
    literal_substring_matches: [],
    prose_chars: null,
    markup_ratio: null,
    reasons: hard ? ['junk_pattern'] : soft ? ['oversize_block'] : ['oversize_warn'],
    reason_messages: hard
      ? ['PAGE_JUNK_PATTERN: matched access_denied']
      : soft
        ? ['PAGE_OVERSIZED: body 600000 bytes']
        : ['PAGE_OVERSIZE_WARN: body 100000 bytes'],
    shouldQuarantine: hard,
    shouldHardBlock: hard,
    shouldFlag: soft,
    flag_reason: soft ? 'oversized' : null,
    shouldSkipEmbed: soft,
  };
}

function findAuditCheck(checks: Check[]): Check {
  const check = checks.find(candidate => candidate.name === 'content_sanity_audit_recent');
  expect(check).toBeDefined();
  return check!;
}

async function auditStatus(
  kind: 'warn' | 'soft' | 'hard',
  count = 1,
  disposition?: ContentSanityEventType,
): Promise<Check> {
  const auditDir = mkdtempSync(join(tmpdir(), `doctor-content-sanity-${kind}-`));
  try {
    return await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      for (let index = 0; index < count; index += 1) {
        logContentSanityAssessment(
          `notes/${kind}-${index}`,
          'test-source',
          result(kind),
          { disposition },
        );
      }
      return findAuditCheck(await buildChecks(engine, []));
    });
  } finally {
    rmSync(auditDir, { recursive: true, force: true });
  }
}

describe('content_sanity_audit_recent health semantics', () => {
  test('warn-only audit volume stays healthy and visible', async () => {
    const check = await auditStatus('warn', 12);

    expect(check.status).toBe('ok');
    expect(check.message).toContain('12 events');
    expect(check.message).toContain('warn=12');
    expect(check.message).toContain('Informational warnings only');
  }, 60_000);

  test('soft dispositions still warn', async () => {
    const check = await auditStatus('soft');

    expect(check.status).toBe('warn');
    expect(check.message).toContain('soft=1');
  }, 60_000);

  test('hard dispositions still fail', async () => {
    const check = await auditStatus('hard');

    expect(check.status).toBe('fail');
    expect(check.message).toContain('hard=1');
  }, 60_000);

  test('v0.42 dispositions retain their health severity', async () => {
    const rejected = await auditStatus('hard', 1, 'reject');
    const quarantined = await auditStatus('hard', 1, 'quarantine');
    const flagged = await auditStatus('soft', 1, 'flag');

    expect(rejected.status).toBe('fail');
    expect(rejected.message).toContain('reject=1');
    expect(quarantined.status).toBe('fail');
    expect(quarantined.message).toContain('quarantine=1');
    expect(flagged.status).toBe('warn');
    expect(flagged.message).toContain('flag=1');
  }, 60_000);
});
