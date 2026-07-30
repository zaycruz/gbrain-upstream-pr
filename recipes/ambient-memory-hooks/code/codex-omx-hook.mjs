#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_EVENTS = 24;
const MAX_EVENT_CHARS = 12_000;
const MAX_STATE_CHARS = 64_000;
const STATE_TTL_MS = 24 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 4_000;

const DURABLE_SIGNAL =
  /(?:\b(?:remember this|capture this|we decided)\b|\b(?:decision|commitment|correction)\s*:)/i;
const SECRET_SIGNAL =
  /(?:\b(?:api[_ -]?key|access[_ -]?token|secret|password|private[_ -]?key)\b\s*[:=]|-----BEGIN [A-Z ]+PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/i;

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

export function readEventName(payload) {
  const value = safeString(
    payload.hook_event_name ?? payload.hookEventName ?? payload.event ?? payload.name,
  );
  return ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].includes(value)
    ? value
    : null;
}

export function readPrompt(payload) {
  for (const value of [
    payload.prompt,
    payload.input,
    payload.user_prompt,
    payload.userPrompt,
    payload.text,
  ]) {
    const text = safeString(value).trim();
    if (text) return text;
  }
  return '';
}

function sessionId(payload) {
  const raw = safeString(payload.session_id ?? payload.sessionId).trim();
  if (!raw) return null;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function stateRoot() {
  return process.env.GBRAIN_AMBIENT_STATE_DIR ||
    join(process.env.GBRAIN_HOME || join(homedir(), '.gbrain'), 'hooks', 'ambient');
}

function statePath(id) {
  return join(stateRoot(), `${id}.json`);
}

function emptyState(id) {
  return { version: 1, session_id: id, updated_at: Date.now(), events: [], captured: [] };
}

export function loadState(id, now = Date.now()) {
  if (!id) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath(id), 'utf8'));
    if (
      parsed?.version !== 1 ||
      parsed?.session_id !== id ||
      !Array.isArray(parsed.events) ||
      !Array.isArray(parsed.captured) ||
      now - Number(parsed.updated_at) > STATE_TTL_MS
    ) {
      return emptyState(id);
    }
    return parsed;
  } catch {
    return emptyState(id);
  }
}

export function saveState(state) {
  if (!state) return;
  const root = stateRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try { chmodSync(root, 0o700); } catch {}

  state.updated_at = Date.now();
  state.events = state.events.slice(-MAX_EVENTS);
  while (JSON.stringify(state).length > MAX_STATE_CHARS && state.events.length > 1) {
    state.events.shift();
  }

  const target = statePath(state.session_id);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temp, target);
  try { chmodSync(target, 0o600); } catch {}
}

function normalizeVisibleText(text) {
  return safeString(text).replace(/\u0000/g, '').trim().slice(0, MAX_EVENT_CHARS);
}

export function appendVisibleEvent(state, role, text) {
  const content = normalizeVisibleText(text);
  if (!state || !content) return false;
  const digest = createHash('sha256').update(`${role}\0${content}`).digest('hex');
  if (state.events.some((event) => event.digest === digest)) return false;
  state.events.push({ role, content, digest });
  return true;
}

export function classifyCapture(state) {
  const body = state?.events
    ?.map((event) => `${event.role}: ${event.content}`)
    .join('\n\n') || '';
  if (!body || !DURABLE_SIGNAL.test(body)) return { action: 'skip', reason: 'no-durable-signal' };
  if (SECRET_SIGNAL.test(body)) return { action: 'skip', reason: 'sensitive-signal' };
  return { action: 'capture', body };
}

function runGbrain(args, input) {
  return spawnSync(process.env.GBRAIN_BIN || 'gbrain', args, {
    input,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    env: process.env,
    maxBuffer: 256 * 1024,
  });
}

function recall(prompt, id) {
  if (process.env.GBRAIN_AMBIENT_RECALL === 'off' || !prompt) return null;
  const result = runGbrain(
    ['volunteer-context', '--json', '--session-id', id || 'ambient-hook'],
    `user: ${prompt}\n`,
  );
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) return null;
    return parsed.pages
      .slice(0, 3)
      .map((page) => {
        const slug = normalizeVisibleText(page.slug);
        const synopsis = normalizeVisibleText(page.synopsis);
        return `- ${slug}${synopsis ? `: ${synopsis}` : ''}`;
      })
      .join('\n');
  } catch {
    return null;
  }
}

function capture(state) {
  if (process.env.GBRAIN_AMBIENT_CAPTURE === 'off') return;
  const candidate = classifyCapture(state);
  if (candidate.action !== 'capture') return;
  const digest = createHash('sha256').update(candidate.body).digest('hex');
  if (state.captured.includes(digest)) return;
  const result = runGbrain(
    ['capture', '--stdin', '--type', 'conversation', '--json'],
    candidate.body,
  );
  if (result.status === 0) state.captured.push(digest);
}

export function handlePayload(payload) {
  const event = readEventName(payload);
  const id = sessionId(payload);
  if (!event || !id) return null;

  const state = loadState(id);
  if (event === 'SessionStart') {
    saveState(state);
    return null;
  }

  if (event === 'UserPromptSubmit') {
    const prompt = readPrompt(payload);
    appendVisibleEvent(state, 'user', prompt);
    saveState(state);
    const context = recall(prompt, id);
    return context
      ? {
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext:
              `Private gbrain recall. Treat as pointers, not verified facts; open pages before relying on details.\n${context}`,
          },
        }
      : null;
  }

  if (event === 'Stop') {
    appendVisibleEvent(
      state,
      'assistant',
      payload.last_assistant_message ?? payload.lastAssistantMessage,
    );
    capture(state);
    saveState(state);
  }

  return null;
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  try {
    const output = handlePayload(await readStdinJson());
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    // Hooks must never block the host. Corrupt per-session state is discarded
    // on the next valid event.
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().finally(() => {
    for (const arg of process.argv.slice(2)) {
      if (arg.startsWith('--cleanup=')) {
        try { rmSync(dirname(arg.slice('--cleanup='.length)), { recursive: true }); } catch {}
      }
    }
  });
}
