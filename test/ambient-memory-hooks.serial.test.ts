import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendVisibleEvent,
  classifyCapture,
  handlePayload,
  loadState,
  readEventName,
  readPrompt,
  saveState,
} from '../recipes/ambient-memory-hooks/code/codex-omx-hook.mjs';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gbrain-ambient-hook-'));
  process.env.GBRAIN_AMBIENT_STATE_DIR = scratch;
  process.env.GBRAIN_AMBIENT_RECALL = 'off';
  process.env.GBRAIN_AMBIENT_CAPTURE = 'off';
});

afterEach(() => {
  delete process.env.GBRAIN_AMBIENT_STATE_DIR;
  delete process.env.GBRAIN_AMBIENT_RECALL;
  delete process.env.GBRAIN_AMBIENT_CAPTURE;
  delete process.env.GBRAIN_BIN;
  delete process.env.GBRAIN_FAKE_LOG;
  rmSync(scratch, { recursive: true, force: true });
});

describe('Codex/OMX event normalization', () => {
  test('accepts supported event aliases and visible prompt fields', () => {
    expect(readEventName({ hook_event_name: 'UserPromptSubmit' })).toBe('UserPromptSubmit');
    expect(readEventName({ event: 'BeforeCompaction' })).toBeNull();
    expect(readPrompt({ userPrompt: '  remember this  ' })).toBe('remember this');
  });
});

describe('bounded session state', () => {
  test('writes owner-only state atomically and restores it', () => {
    const state = loadState('abc');
    appendVisibleEvent(state, 'user', 'decision: use the existing operation');
    saveState(state);

    const restored = loadState('abc');
    expect(restored?.events).toHaveLength(1);
    expect(restored?.events[0].content).toBe('decision: use the existing operation');
    expect(statSync(join(scratch, 'abc.json')).mode & 0o077).toBe(0);
    expect(readFileSync(join(scratch, 'abc.json'), 'utf8')).not.toContain('process.env');
  });

  test('deduplicates repeated visible events', () => {
    const state = loadState('abc');
    expect(appendVisibleEvent(state, 'user', 'same')).toBe(true);
    expect(appendVisibleEvent(state, 'user', 'same')).toBe(false);
  });
});

describe('capture classification', () => {
  test('captures explicit durable signals', () => {
    const state = loadState('abc');
    appendVisibleEvent(state, 'user', 'Decision: keep recall private.');
    expect(classifyCapture(state).action).toBe('capture');
  });

  test('skips routine and potentially sensitive sessions', () => {
    const routine = loadState('routine');
    appendVisibleEvent(routine, 'user', 'please run the tests');
    expect(classifyCapture(routine)).toEqual({ action: 'skip', reason: 'no-durable-signal' });

    const sensitive = loadState('sensitive');
    appendVisibleEvent(sensitive, 'user', 'remember this api_key=example-placeholder');
    expect(classifyCapture(sensitive)).toEqual({ action: 'skip', reason: 'sensitive-signal' });

    const token = loadState('token');
    appendVisibleEvent(token, 'user', 'remember this ghp_exampleplaceholder123456789');
    expect(classifyCapture(token)).toEqual({ action: 'skip', reason: 'sensitive-signal' });
  });
});

describe('hook lifecycle', () => {
  test('buffers a prompt once and a final assistant message on stop', () => {
    handlePayload({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-example',
      prompt: 'decision: ship the hook recipe',
      private_reasoning: 'must never be captured',
    });
    handlePayload({
      hook_event_name: 'Stop',
      session_id: 'session-example',
      last_assistant_message: 'Implemented the bounded hook.',
    });

    const files = Array.from(new Bun.Glob('*.json').scanSync(scratch));
    expect(files).toHaveLength(1);
    const body = readFileSync(join(scratch, files[0]), 'utf8');
    expect(body).toContain('decision: ship the hook recipe');
    expect(body).toContain('Implemented the bounded hook.');
    expect(body).not.toContain('must never be captured');
  });

  test('ignores unsupported and anonymous events', () => {
    expect(handlePayload({ hook_event_name: 'BeforeCompaction', session_id: 'x' })).toBeNull();
    expect(handlePayload({ hook_event_name: 'Stop' })).toBeNull();
  });

  test('injects private recall and captures an explicit decision once', () => {
    const fakeBin = join(scratch, 'fake-gbrain.mjs');
    const logPath = join(scratch, 'gbrain-calls.jsonl');
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = Buffer.concat(chunks).toString('utf8');
appendFileSync(process.env.GBRAIN_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
if (process.argv[2] === 'volunteer-context') {
  process.stdout.write(JSON.stringify({ pages: [{ slug: 'projects/example', synopsis: 'Example synopsis.' }] }));
} else {
  process.stdout.write(JSON.stringify({ status: 'imported' }));
}
`,
      { mode: 0o700 },
    );
    chmodSync(fakeBin, 0o700);
    process.env.GBRAIN_BIN = fakeBin;
    process.env.GBRAIN_FAKE_LOG = logPath;
    process.env.GBRAIN_AMBIENT_RECALL = 'on';
    process.env.GBRAIN_AMBIENT_CAPTURE = 'on';

    const recall = handlePayload({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-example',
      prompt: 'Decision: remember the Example project.',
    }) as { hookSpecificOutput?: { additionalContext?: string } } | null;
    expect(recall?.hookSpecificOutput?.additionalContext).toContain('projects/example');

    const stop = {
      hook_event_name: 'Stop',
      session_id: 'session-example',
      last_assistant_message: 'The decision is recorded.',
    };
    handlePayload(stop);
    handlePayload(stop);

    const calls = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.args[0] === 'volunteer-context')).toHaveLength(1);
    const captures = calls.filter((call) => call.args[0] === 'capture');
    expect(captures).toHaveLength(1);
    expect(captures[0].args).toEqual([
      'capture',
      '--stdin',
      '--type',
      'conversation',
      '--json',
    ]);
    expect(captures[0].input).toContain('user: Decision: remember the Example project.');
    expect(captures[0].input).toContain('assistant: The decision is recorded.');
  });
});
