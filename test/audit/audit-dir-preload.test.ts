/**
 * Regression gate for #2823: the shared test bootstrap
 * (`test/helpers/audit-dir-preload.ts`, wired via `bunfig.toml`'s
 * `preload`) must redirect `GBRAIN_AUDIT_DIR` to a per-run scratch
 * directory BEFORE any test file runs, so audit-emitting code paths never
 * fall through to the operator's real `~/.gbrain/audit/`.
 *
 * Before the fix, `test/import-file.test.ts`'s oversize-content boundary
 * fixture (`'borderline-slug'`) fired a real `soft_block` content-sanity
 * event straight into the developer's live audit trail on every test run.
 * This file reproduces that exact event shape directly against the audit
 * module (no PGLite/import-file machinery needed) and asserts it lands
 * only in the scratch dir.
 */
import { describe, test, expect } from 'bun:test';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { resolveAuditDir } from '../../src/core/audit/audit-writer.ts';
import { withIsolatedAuditDir } from '../helpers/audit-dir-preload.ts';
import {
  logContentSanityAssessment,
  readRecentContentSanityEvents,
  computeContentSanityAuditFilename,
} from '../../src/core/audit/content-sanity-audit.ts';
import { assessContentSanity } from '../../src/core/content-sanity.ts';

describe('shared test-bootstrap audit isolation (#2823)', () => {
  test('GBRAIN_AUDIT_DIR is set by the preload to a scratch dir, not the real ~/.gbrain/audit', () => {
    const dir = process.env.GBRAIN_AUDIT_DIR;
    expect(dir).toBeTruthy();
    expect(dir).not.toBe(join(homedir(), '.gbrain', 'audit'));
    // mkdtempSync(tmpdir(), ...) always lives directly under os.tmpdir().
    expect(dir!.startsWith(tmpdir())).toBe(true);
  });

  test('resolveAuditDir() resolves to the preload-set scratch dir', () => {
    const expected = process.env.GBRAIN_AUDIT_DIR;
    expect(expected).toBeTruthy();
    expect(resolveAuditDir()).toBe(expected!);
  });

  test('an oversize content-sanity event (the import-file.test.ts "borderline-slug" shape) never reaches the real ~/.gbrain/audit', async () => {
    // Unique per test-run so a stale match from a prior manual run can
    // never produce a false pass.
    const sentinelSlug = `borderline-slug-audit-dir-preload-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const realAuditDir = join(homedir(), '.gbrain', 'audit');
    const realAuditFile = join(realAuditDir, computeContentSanityAuditFilename());
    const hostFileExisted = existsSync(realAuditFile);
    const hostFileBefore = hostFileExisted
      ? readFileSync(realAuditFile, 'utf8')
      : undefined;

    // Reproduce the exact disposition the leaking fixture hits: body bytes
    // over DEFAULT_BYTES_BLOCK (500_000) with no junk pattern match →
    // shouldSkipEmbed=true, no shouldQuarantine → classified 'soft_block'.
    const result = assessContentSanity({
      compiled_truth: 'x'.repeat(600_000),
      timeline: '',
      title: 'Borderline',
    });
    expect(result.shouldSkipEmbed).toBe(true);
    expect(result.shouldQuarantine).toBe(false);

    const priorAuditDir = process.env.GBRAIN_AUDIT_DIR;
    let isolatedAuditDir: string | undefined;
    await withIsolatedAuditDir(async (configuredAuditDir) => {
      isolatedAuditDir = configuredAuditDir;
      expect(resolveAuditDir()).toBe(configuredAuditDir);
      logContentSanityAssessment(sentinelSlug, 'default', result);

      // The configured isolated path receives the event, both on disk and
      // through the same read helper that doctor uses.
      const isolatedAuditFile = join(
        configuredAuditDir,
        computeContentSanityAuditFilename(),
      );
      expect(existsSync(isolatedAuditFile)).toBe(true);
      expect(readFileSync(isolatedAuditFile, 'utf8')).toContain(sentinelSlug);
      const recent = readRecentContentSanityEvents(1);
      const found = recent.find((e) => e.slug === sentinelSlug);
      expect(found).toBeDefined();
      expect(found?.event_type).toBe('soft_block');
    });

    // withEnv restores the process-global override after the test body.
    expect(process.env.GBRAIN_AUDIT_DIR).toBe(priorAuditDir);
    expect(isolatedAuditDir).toBeDefined();
    expect(existsSync(isolatedAuditDir!)).toBe(false);

    // The real ~/.gbrain/audit file is unchanged byte-for-byte. In particular,
    // do not delete or rewrite an existing user audit file as part of cleanup.
    expect(existsSync(realAuditFile)).toBe(hostFileExisted);
    if (hostFileExisted && hostFileBefore !== undefined) {
      expect(readFileSync(realAuditFile, 'utf8')).toBe(hostFileBefore);
    }
  });
});
