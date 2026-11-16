---
name: continual-learning
description: "Orchestrate continual learning by delegating transcript mining and .ravenclaw/RAVEN.md updates to `agents-memory-updater`."
---
RavenClaw note: upstream MIT text from https://github.com/cursor/plugins. Ignore Cursor stop hooks, cloud agents, canvases, and model slugs. Use the cursor-pack router limits.

# Continual Learning

Keep `.ravenclaw/RAVEN.md` current by delegating the memory update flow to one subagent.

## Trigger

Use when the user asks to mine prior chats, maintain `.ravenclaw/RAVEN.md`, or run the continual-learning loop.

## Workflow

1. Call `agents-memory-updater`.
2. Return the updater result.

## Guardrails

- Keep the parent skill orchestration-only.
- Do not mine transcripts or edit files in the parent flow.
- Do not bypass the subagent.
