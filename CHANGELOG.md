# Changelog

## 0.1.7 — 2026-09-11

One-command live turn check.

### Added
- `raven smoke` / `bun run smoke` asks the model for `pong`
- Without a key, prints the setup hint and exits 1
- CI does not run this

### Try it

```bash
git clone --branch v0.1.7 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven setup
bun run smoke
```

## 0.1.6 — 2026-09-11

CLI, MCP, and ACP versions come from each package.json.

### Changed
- `readPackageVersion(import.meta.url)` walks up to the nearest `package.json`
- `raven --version`, MCP `clientInfo`, and ACP `agentInfo` no longer hardcode 0.1.x

### Try it

```bash
git clone --branch v0.1.6 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven --version
```

## 0.1.5 — 2026-09-11

Read-only memory review can persist to the project.

### Added
- `forkMemoryReview` appends a dated section to `.ravenclaw/MEMORY.md` (8k cap)
- Does not run Edit / Write / Bash; empty or failed reviews do not write
- `/review` in Ink and OpenTUI

### Try it

```bash
git clone --branch v0.1.5 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
# after a session:
# /review
```

## 0.1.4 — 2026-09-11

First-run setup no longer echoes the API key.

### Added
- TTY `raven setup` / first-run uses raw mode and prints `*` per character
- Backspace and Ctrl-C on the secret prompt
- The key is never written back to the prompt stream

### Try it

```bash
git clone --branch v0.1.4 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven setup
```

## 0.1.3 — 2026-09-11

CI covers a real stdio MCP filesystem server, not just echo.

### Added
- In-repo `fs_list` / `fs_read` MCP fixture confined to `MCP_ROOT`
- Live spawn test: list, read, and reject `../` escape
- Shared Content-Length framing with the echo fixture

### Try it

```bash
git clone --branch v0.1.3 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun test packages/cli/src/mcp-fs-live.test.ts
```

## 0.1.2 — 2026-09-11

Editor ACP can resume a saved session.

### Added
- `session/load` on `raven acp` (`loadSession: true` when a loader is wired)
- Failed loads return JSON-RPC invalid params; missing loader stays method-not-found

### Try it

```bash
git clone --branch v0.1.2 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven acp
```

## 0.1.1 — 2026-09-11

CLI usability patch on top of 0.1.0. Same agent loop; easier to start without reading the README.

### Added
- `raven --help` / `--version` (`-h`, `-V`) without booting a session or needing a key
- `raven setup` and first-run prompt write `~/.ravenclaw/.env` (mode 0600)
- `/help` and `/?` inside Ink and OpenTUI list slash commands

### Try it

```bash
git clone --branch v0.1.1 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven --help
bun run raven setup
bun run raven
```

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
