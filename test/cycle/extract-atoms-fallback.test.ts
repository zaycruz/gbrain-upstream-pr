import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { AIConfigError, AITransientError } from '../../src/core/ai/errors.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function response(text: string, model: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model,
    providerId: model.split(':', 1)[0],
  };
}

describe('extract_atoms provider fallback', () => {
  test('falls back after an overload and retries the primary on the next item', async () => {
    const primary = 'anthropic:claude-haiku-4-5';
    const fallback = 'openrouter:deepseek/deepseek-v4-pro';
    await engine.setConfig('models.dream.extract_atoms', primary);
    await engine.setConfig('models.default', fallback);

    const calls: string[] = [];
    const chat = async (opts: ChatOpts): Promise<ChatResult> => {
      const model = opts.model ?? '';
      calls.push(model);
      if (model === primary && calls.filter(call => call === primary).length === 1) {
        throw new AITransientError('Anthropic stream error (overloaded_error): Overloaded');
      }
      const atomText = JSON.stringify([
        { title: `Fallback output ${calls.length}`, atom_type: 'insight', body: 'Useful extracted content.' },
      ]);
      return response(atomText, model);
    };

    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _pages: [
        { slug: 'notes/one', content: 'first page', contentHash: 'hash-one' },
        { slug: 'notes/two', content: 'second page', contentHash: 'hash-two' },
      ],
      _transcripts: [],
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    expect(result.details.atoms_extracted).toBe(2);
    expect(result.details.model_chain).toEqual([primary, fallback]);
    expect(result.details.failures).toEqual([]);
    expect(calls).toEqual([primary, fallback, primary]);

    const atoms = await engine.executeRaw<{ title: string; source_id: string }>(
      `SELECT title, source_id FROM pages WHERE type = 'atom' ORDER BY title`,
    );
    expect(atoms).toEqual([
      { title: 'Fallback output 2', source_id: 'default' },
      { title: 'Fallback output 3', source_id: 'default' },
    ]);
  });
  test('disables a configuration-error model for the rest of the run', async () => {
    const primary = 'anthropic:claude-haiku-4-5';
    const fallback = 'openrouter:deepseek/deepseek-v4-pro';
    await engine.setConfig('models.dream.extract_atoms', primary);
    await engine.setConfig('models.default', fallback);

    const calls: string[] = [];
    const chat = async (opts: ChatOpts): Promise<ChatResult> => {
      const model = opts.model ?? '';
      calls.push(model);
      if (model === primary) {
        throw new AIConfigError('The configured model is unavailable.');
      }
      const atomText = JSON.stringify([
        { title: `Configuration fallback ${calls.length}`, atom_type: 'insight', body: 'Useful extracted content.' },
      ]);
      return response(atomText, model);
    };

    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _pages: [
        { slug: 'notes/one', content: 'first page', contentHash: 'hash-one' },
        { slug: 'notes/two', content: 'second page', contentHash: 'hash-two' },
      ],
      _transcripts: [],
      _chat: chat,
    });

    expect(result.status).toBe('ok');
    expect(result.details.atoms_extracted).toBe(2);
    expect(calls).toEqual([primary, fallback, fallback]);
  });
});
