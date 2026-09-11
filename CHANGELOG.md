# Changelog

## 0.1.0 — 2026-09-11

First public release. RavenClaw is a local coding agent: it reads and edits a workspace, runs a shell, and resumes after a crash. Bring your own API key. There is no RavenClaw backend.

### Highlights

- Streaming agent loop that persists tool calls before they run, and never leaves an unpaired `tool_use`
- Permission modes: `default`, `acceptEdits`, `plan`, `dontAsk`
- Autocompact and SQLite WAL sessions (`/resume` after a crash does not re-run Bash)
- Built-in tools: Read, Grep, Glob, Edit, Write, Bash, Skill, Agent, plan mode
- Nested `Agent` plus `file-finder` and `command-runner` specialists
- Optional MCP stdio servers from `config.yaml` (builtin names win on collision)
- FTS5 `/search`, `USER.md` / `MEMORY.md` snapshots, Docker Bash backend
- Editor hook: `raven acp` (newline JSON-RPC)
- Ads only on admitted included-model sessions; BYOK never shows them

### Try it

```bash
git clone --branch v0.1.0 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
mkdir -p ~/.ravenclaw
printf 'ANTHROPIC_API_KEY=sk-ant-...\n' > ~/.ravenclaw/.env
chmod 600 ~/.ravenclaw/.env
bun run raven
```

Also: `bun run raven exec "…"`, `bun run raven --tui opentui`, `bun run raven acp`.

### Packages

`@ravenclaw/core`, `@ravenclaw/providers`, `@ravenclaw/ads`, `@ravenclaw/cli`, `@ravenclaw/tui-opentui`, `@ravenclaw/acp`

### Known limits

- First public tag is BYOK-only unless you run your own included-model gateway
- `--tui opentui` is a line-mode StreamEvent view, not a native OpenTUI widget tree
- This process is the same OS user as you; there is no network sandbox
- Live model paths are env-gated in CI; run `bun test` locally with a key to exercise them

Apache-2.0. See the [README](README.md) for config, permissions, and MCP.
