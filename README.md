# RavenClaw

RavenClaw is a Bun/TypeScript coding agent. It reads and edits a workspace, runs a shell, and resumes after crash. Bring your own API keys (BYOK). No RavenClaw backend is required.

Licensed under Apache-2.0.

## Requirements

- [Bun](https://bun.sh) 1.x
- An `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (OpenAI-compatible hosts also work via `OPENAI_BASE_URL`)

## Install

```bash
git clone https://github.com/YeonwooSung/RavenClaw.git
cd RavenClaw
bun install
```

## Configure

Default home is `~/.ravenclaw/`. Secrets go in `~/.ravenclaw/.env` (mode `0600`):

```bash
mkdir -p ~/.ravenclaw
cat > ~/.ravenclaw/.env <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
# or:
# OPENAI_API_KEY=sk-...
# OPENAI_BASE_URL=https://api.openai.com/v1
EOF
chmod 600 ~/.ravenclaw/.env
```

Optional `~/.ravenclaw/config.yaml`:

```yaml
model: anthropic/claude-sonnet-4
provider: anthropic          # anthropic | openai_compat
permissionMode: default      # default | acceptEdits | plan | dontAsk
maxRounds: 80
terminal:
  backend: local             # local | docker
  image: bash:5              # required when backend is docker
ads:
  feedUrl: ""                # empty ⇒ no ad network; house floor only if included
```

Optional memory files (context snapshot, 8k/file, 16k total): `~/.ravenclaw/USER.md`, `~/.ravenclaw/MEMORY.md`, and the same names under the project root or `.ravenclaw/`.

Resolution: `--provider` / `--model` flags beat `config.yaml`, which beats env for the *choice* of provider. Env still supplies the secret.

## Run

Interactive TUI:

```bash
bun run raven
```

Headless (forces `dontAsk`):

```bash
bun run raven exec "list the TypeScript files in this repo"
bun run raven exec --json "summarize README.md"
```

Useful flags: `--dont-ask`, `--provider anthropic`, `--model anthropic/claude-sonnet-4`.

This process is the same OS user as you. There is no network sandbox. Writes under `~/.ssh/id_*` and `$RAVENCLAW_HOME/state.db` are hard-denied; `.env` writes ask first.

## Sessions

SQLite WAL at `$RAVENCLAW_HOME/state.db`. **One live writer per session id.** A second `raven` process may read the same database and may create a different session; it must not write the same session id.

In the TUI: `/resume`, `/compact`, `/cost`, `/learn`, `/quit`. Shift+Tab cycles `default → acceptEdits → plan → default`. Escape aborts the current turn.

## Packages

- `@ravenclaw/core` — query loop, tools, permissions, sessions, Provider port
- `@ravenclaw/providers` — OpenAI-compatible Chat Completions and Anthropic Messages adapters
- `@ravenclaw/ads` — first-party ad layout and house-ad floor (included-model sessions only; never on BYOK)
- `@ravenclaw/cli` — `raven` Ink TUI

## Docs

- [System design](docs/superpowers/specs/2026-09-08-ravenclaw-coding-agent-design.md)
- Prior art notes: [Hermes](docs/research/hermes-agent-analysis.md), [Freebuff](docs/research/freebuff-analysis.md), [loop semantics](docs/research/claude-code-analysis.md)

## Develop

```bash
bun test
```

