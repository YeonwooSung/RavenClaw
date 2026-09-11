# Changelog

## 0.1.0 — 2026-09-11

First tagged release of RavenClaw, a Bun/TypeScript coding agent.

### Agent loop
- Streaming `queryLoop` with persist-before-execute and the tool_use/tool pairing invariant
- Permission modes: default, acceptEdits, plan, dontAsk
- Autocompact, SQLite WAL sessions, resume after crash
- Tools: Read, Grep, Glob, Edit, Write, Bash, Skill, Agent, plan mode
- Nested general agent plus `file-finder` / `command-runner` specialists

### CLI
- `bun run raven` Ink TUI (default)
- `bun run raven --tui opentui` line-mode view
- `bun run raven exec` and `bun run raven acp`
- Slash commands: `/resume`, `/compact`, `/cost`, `/search`, `/learn`, `/quit`
- Optional MCP stdio servers from `config.yaml`
- Included-model gateway when entitlement admits; otherwise BYOK

### Packages
`@ravenclaw/core`, `@ravenclaw/providers`, `@ravenclaw/ads`, `@ravenclaw/cli`, `@ravenclaw/tui-opentui`, `@ravenclaw/acp`

Licensed Apache-2.0. No RavenClaw backend is required.
