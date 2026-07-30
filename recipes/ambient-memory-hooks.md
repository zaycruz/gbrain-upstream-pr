---
id: ambient-memory-hooks
name: Ambient Memory Hooks
version: 0.1.0
description: Private pre-turn gbrain recall and conservative session capture for Codex/OMX hooks.
category: reflex
install_kind: copy-into-host-repo
requires:
  - gbrain
secrets: []
health_checks:
  - type: command
    argv: ["gbrain", "doctor"]
    label: gbrain available
setup_time: 5 minutes
cost_estimate: Free; deterministic hook path with no hook-time LLM calls.
---

# Ambient Memory Hooks

This recipe removes the need for an always-search-gbrain skill. It installs a
single fail-open hook executable that:

- calls `gbrain volunteer-context` on `UserPromptSubmit`;
- returns volunteered pointers through Codex's private `additionalContext`;
- buffers only visible user prompts and final assistant messages;
- captures only sessions with an explicit durable-memory signal;
- persists bounded session state atomically under `~/.gbrain/hooks/ambient/`;
- never captures hidden prompts, private reasoning, environment variables, or
  raw tool payloads.

## Install

```bash
gbrain integrations install ambient-memory-hooks --target /path/to/host-repo
```

The installer copies the bundle but does not rewrite global Codex hook
configuration. Add the installed command as a second hook for
`UserPromptSubmit`, `SessionStart`, and `Stop`:

```text
node /path/to/host-repo/services/gbrain-ambient-hooks/code/codex-omx-hook.mjs
```

Codex combines `additionalContext` returned by hook commands. Keep the existing
OMX native hook in place; this recipe does not wrap or replace it.

## Capture policy

Auto-capture is conservative by default. A session is captured only when a
visible message contains an explicit memory signal such as:

- `remember this`
- `capture this`
- `decision:`
- `we decided`
- `commitment:`
- `correction:`

Set `GBRAIN_AMBIENT_CAPTURE=off` to disable capture while keeping recall.
Set `GBRAIN_AMBIENT_RECALL=off` to disable recall while keeping capture.

State is capped and expires after 24 hours. Hook failures return success so
gbrain availability cannot block the host.
