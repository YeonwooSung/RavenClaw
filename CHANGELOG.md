# Changelog

## 0.1.23 — 2026-09-11

List configured MCP servers without spawning them.

### Added
- `raven mcp` / `raven mcp list` prints name, command, args
- Env is shown as key names only, never values
- Empty config prints `no mcp servers`

### Try it

```bash
git clone --branch v0.1.23 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven mcp
```

## 0.1.22 — 2026-09-11

CI smokes no-key CLI commands.

### Added
- Spawn tests for `--help`, `--version`, `sessions`, `config`, `init`, `completions`, `doctor`
- GitHub Actions repeats the same surface on Ubuntu
- `raven smoke` is still not run in CI

### Try it

```bash
git clone --branch v0.1.22 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun test packages/cli/src/ci-cli.test.ts
```

## 0.1.21 — 2026-09-11

Security policy and Dependabot.

### Added
- [SECURITY.md](SECURITY.md): do not paste keys; use GitHub Security Advisories for exfil / path-escape / permission-bypass
- Weekly Dependabot updates for GitHub Actions

### Try it

https://github.com/YeonwooSung/RavenClaw/security/advisories/new

## 0.1.20 — 2026-09-11

GitHub issue and pull request templates.

### Added
- Bug form: version, repro, `raven doctor` (no secrets)
- Feature form: problem, proposal, whether a key is required
- PR checklist: tests, no keys in the diff, ads isolation, pairing tests

### Try it

https://github.com/YeonwooSung/RavenClaw/issues/new/choose

## 0.1.19 — 2026-09-11

Contributor guide.

### Added
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, package layout, tests, CLI command checklist, release process
- README Develop section links to it

### Try it

```bash
git clone --branch v0.1.19 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## 0.1.18 — 2026-09-11

Shell completion for the CLI.

### Added
- `raven completions bash` and `raven completions zsh` print a script to stdout
- Completes commands, `--provider`, and `--tui`
- Unknown shell exits 2 with usage

### Try it

```bash
git clone --branch v0.1.18 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
eval "$(bun run raven completions bash)"
# or
eval "$(bun run raven completions zsh)"
```

## 0.1.17 — 2026-09-11

Scaffold project instructions.

### Added
- `raven init` writes `AGENTS.md` in the current directory when missing
- Does not overwrite an existing file

### Try it

```bash
git clone --branch v0.1.17 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
cd /path/to/your-project
bun run /path/to/RavenClaw/packages/cli/src/index.ts init
```

## 0.1.16 — 2026-09-11

Print resolved settings without leaking secrets.

### Added
- `raven config` shows home, provider, model, modes, MCP server names, and key presence
- API keys are `set (N chars)` or `unset`, never the value
- Works before `raven setup`

### Try it

```bash
git clone --branch v0.1.16 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven config
```

## 0.1.15 — 2026-09-11

Check the local install without printing secrets.

### Added
- `raven doctor` reports home, `.env`, `config.yaml`, `state.db`, and Bun
- Prints key name and length only, never the value
- Exit 1 if any check fails; missing `state.db` is ok

### Try it

```bash
git clone --branch v0.1.15 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven setup
bun run raven doctor
```

## 0.1.14 — 2026-09-11

Set a session title from the shell or the TUI.

### Added
- `raven title <id> <name>` updates the stored title (prefix ok)
- `/title <name>` in Ink and OpenTUI
- No API key required

### Try it

```bash
git clone --branch v0.1.14 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven title <id> Fix the login bug
bun run raven sessions
```

## 0.1.13 — 2026-09-11

Export a session as Markdown, and list times in ISO-8601.

### Added
- `raven export <id>` prints a Markdown transcript with full tool bodies
- Session lists (`sessions`, `show`, `/resume`) use ISO-8601 instead of unix milliseconds

### Try it

```bash
git clone --branch v0.1.13 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven export <id> > session.md
```

## 0.1.12 — 2026-09-11

Search saved sessions from the shell.

### Added
- `raven search <query>` runs FTS5 over this directory's sessions
- `--all` searches every session in the database
- No API key required; empty query exits 2 with usage

### Try it

```bash
git clone --branch v0.1.12 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven search pairing
bun run raven search --all persist
```

## 0.1.11 — 2026-09-11

Resume a saved session from the shell.

### Added
- `raven resume` with no id lists sessions (same as `raven sessions`)
- `raven resume <id>` opens that session in the TUI (prefix ok)
- `--tui opentui` works on resume
- Listing needs no key; opening a session does

### Try it

```bash
git clone --branch v0.1.11 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven resume
bun run raven resume <id>
```

## 0.1.10 — 2026-09-11

Delete a saved session from the shell.

### Added
- `raven rm <id>` deletes a session, its child Agent sessions, messages, and permission rules
- Accepts an id prefix; missing ids exit 1
- `SessionStore.deleteSession` on SQLite and memory stores
- No API key required

### Try it

```bash
git clone --branch v0.1.10 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven sessions
bun run raven rm <id>
```

## 0.1.9 — 2026-09-11

Print a saved session transcript from the shell.

### Added
- `raven show <id>` prints header + user/assistant/tool lines
- Accepts an id prefix; ambiguous prefixes error
- Tool output longer than 200 characters is clipped
- No API key required

### Try it

```bash
git clone --branch v0.1.9 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven sessions
bun run raven show <id>
```

## 0.1.8 — 2026-09-11

List sessions from the shell without a TUI or API key.

### Added
- `raven sessions` prints recent top-level sessions for this directory
- Child Agent sessions are omitted
- Empty home prints `no sessions` and exits 0

### Try it

```bash
git clone --branch v0.1.8 https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw && bun install
bun run raven sessions
```

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
