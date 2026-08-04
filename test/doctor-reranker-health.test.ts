import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { checkRerankerHealth } from '../src/commands/doctor.ts';
import { computeRerankAuditFilename } from '../src/core/rerank-audit.ts';

const MODEL = 'zeroentropyai:zerank-2';

function makeEngine(config: Record<string, string>) {
  return {
    async getConfig(key: string): Promise<string | null> {
      return config[key] ?? null;
    },
  } as any;
}

function writeFailure(
  auditDir: string,
  ts: string,
  reason: 'auth' | 'payload_too_large',
): void {
  fs.mkdirSync(auditDir, { recursive: true });
  fs.appendFileSync(
    path.join(auditDir, computeRerankAuditFilename()),
    JSON.stringify({
      ts,
      model: MODEL,
      reason,
      query_hash: 'deadbeef',
      doc_count: 1,
      error_summary: reason === 'auth' ? 'invalid api key' : 'payload too large',
      severity: 'warn',
    }) + '\n',
  );
}

function writeAuthFailure(auditDir: string, ts: string): void {
  writeFailure(auditDir, ts, 'auth');
}

describe('checkRerankerHealth historical auth recovery', () => {
  test('a newer successful probe clears a historical auth warning', async () => {
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-reranker-health-'));
    try {
      const failureAt = new Date(Date.now() - 60_000).toISOString();
      const verifiedAt = new Date(Date.now() - 30_000).toISOString();
      writeAuthFailure(auditDir, failureAt);

      await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
        const check = await checkRerankerHealth(makeEngine({
          'search.mode': 'balanced',
          'search.reranker.enabled': 'true',
          'search.reranker.last_verified_at': verifiedAt,
          'search.reranker.last_verified_model': MODEL,
        }));
        expect(check.status).toBe('ok');
        expect(check.message).toContain('historical reranker auth failure');
      });
    } finally {
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test('a resolved auth failure does not mask a payload failure', async () => {
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-reranker-health-'));
    try {
      writeAuthFailure(auditDir, new Date(Date.now() - 60_000).toISOString());
      writeFailure(auditDir, new Date(Date.now() - 45_000).toISOString(), 'payload_too_large');

      await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
        const check = await checkRerankerHealth(makeEngine({
          'search.mode': 'balanced',
          'search.reranker.enabled': 'true',
          'search.reranker.last_verified_at': new Date(Date.now() - 30_000).toISOString(),
          'search.reranker.last_verified_model': MODEL,
        }));
        expect(check.status).toBe('warn');
        expect(check.message).toContain('payload-too-large');
      });
    } finally {
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test('a newer probe for a different model does not clear the warning', async () => {
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-reranker-health-'));
    try {
      const failureAt = new Date(Date.now() - 60_000).toISOString();
      const verifiedAt = new Date(Date.now() - 30_000).toISOString();
      writeAuthFailure(auditDir, failureAt);

      await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
        const check = await checkRerankerHealth(makeEngine({
          'search.mode': 'balanced',
          'search.reranker.enabled': 'true',
          'search.reranker.last_verified_at': verifiedAt,
          'search.reranker.last_verified_model': 'zeroentropyai:other',
        }));
        expect(check.status).toBe('warn');
        expect(check.message).toContain('verify ZEROENTROPY_API_KEY');
      });
    } finally {
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test('a probe older than the latest auth failure does not clear the warning', async () => {
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-reranker-health-'));
    try {
      const verifiedAt = new Date(Date.now() - 60_000).toISOString();
      const failureAt = new Date(Date.now() - 30_000).toISOString();
      writeAuthFailure(auditDir, failureAt);

      await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
        const check = await checkRerankerHealth(makeEngine({
          'search.mode': 'balanced',
          'search.reranker.enabled': 'true',
          'search.reranker.last_verified_at': verifiedAt,
          'search.reranker.last_verified_model': MODEL,
        }));
        expect(check.status).toBe('warn');
        expect(check.message).toContain('verify ZEROENTROPY_API_KEY');
      });
    } finally {
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test('without a successful probe marker, auth failures still warn', async () => {
    const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-reranker-health-'));
    try {
      writeAuthFailure(auditDir, new Date(Date.now() - 60_000).toISOString());

      await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
        const check = await checkRerankerHealth(makeEngine({
          'search.mode': 'balanced',
          'search.reranker.enabled': 'true',
        }));
        expect(check.status).toBe('warn');
        expect(check.message).toContain('verify ZEROENTROPY_API_KEY');
      });
    } finally {
      fs.rmSync(auditDir, { recursive: true, force: true });
    }
  });
});
