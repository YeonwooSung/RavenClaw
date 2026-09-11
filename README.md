# RavenClaw

v0.1.28. RavenClaw is a Bun/TypeScript coding agent. It reads and edits a workspace, runs a shell, and resumes after crash. Bring your own API keys (BYOK). No RavenClaw backend is required.

Licensed under Apache-2.0.

## Requirements

- [Bun](https://bun.sh) 1.x
- An `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or a local server: [Ollama](https://ollama.com) / [vLLM](https://docs.vllm.ai)

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
provider: anthropic          # anthropic | openai_compat | ollama | vllm
permissionMode: default      # default | acceptEdits | plan | dontAsk
maxRounds: 80
terminal:
  backend: local             # local | docker
  image: bash:5              # required when backend is docker
ads:
  feedUrl: ""                # empty ⇒ no ad network; house floor only if included
included:
  enabled: false             # stay BYOK until a real gateway exists
  gatewayUrl: ""
  sessionCapPerDay: 4
mcp:
  servers:
    - name: filesystem
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
```

A server that fails to spawn or list tools is skipped; RavenClaw still boots. Built-in tool names win if an MCP tool collides. CI spawns the in-repo `echo_n` and `fs_list`/`fs_read` fixtures over real stdio.

Optional memory files (context snapshot, 8k/file, 16k total): `~/.ravenclaw/USER.md`, `~/.ravenclaw/MEMORY.md`, and the same names under the project root or `.ravenclaw/`.

Resolution: `--provider` / `--model` flags beat `config.yaml`, which beats env for the *choice* of provider. Env still supplies the secret (except Ollama/vLLM, which do not need a cloud key).

## Local LLMs (Ollama / vLLM)

Both use the OpenAI Chat Completions API. No cloud key is required.

**Ollama** (default `http://127.0.0.1:11434/v1`, model `llama3.2`):

```bash
ollama pull llama3.2
# or: ollama pull qwen2.5-coder
bun run raven setup          # choose 3) Ollama
# or:
echo 'OLLAMA_HOST=http://127.0.0.1:11434' >> ~/.ravenclaw/.env
bun run raven --provider ollama --model llama3.2
bun run raven exec --provider ollama --model qwen2.5-coder "say hi"
```

**vLLM** (default `http://127.0.0.1:8000/v1`, model `local-model` — pass the name you served):

```bash
# example
python -m vllm.entrypoints.openai.api_server --model Qwen/Qwen2.5-Coder-7B-Instruct
echo 'VLLM_BASE_URL=http://127.0.0.1:8000/v1' >> ~/.ravenclaw/.env
bun run raven --provider vllm --model Qwen/Qwen2.5-Coder-7B-Instruct
```

`config.yaml`:

```yaml
provider: ollama
model: qwen2.5-coder
```

## Run

Interactive TUI:

```bash
bun run raven
bun run raven --tui opentui
```

Headless (forces `dontAsk`):

```bash
bun run raven exec "list the TypeScript files in this repo"
bun run raven exec --json "summarize README.md"
bun run raven acp
```

Editor ACP is newline-delimited JSON-RPC on stdin/stdout (`dontAsk`). `session/load` resumes an existing SQLite session id.

In the TUI, `/search <query>` searches this session (FTS5). `/search --all <query>` searches all sessions.

Useful flags: `--help`, `--version`, `--dont-ask`, `--provider anthropic`, `--model anthropic/claude-sonnet-4`, `--tui ink|opentui`.

After setup, `bun run smoke` (or `raven smoke`) does one live text-only turn and expects the model to say `pong`. Without a key it prints the setup hint and exits 1. CI does not run this.

`bun run raven sessions` lists recent sessions for this directory. `bun run raven show <id>` prints the transcript. `bun run raven rm <id>` deletes it (and child Agent sessions). `bun run raven resume` lists; `raven resume <id>` opens that session in the TUI (needs a key). `bun run raven search <query>` searches this directory (`--all` for every session). `bun run raven export <id>` prints Markdown. `bun run raven title <id> <name>` sets the title. `bun run raven doctor` checks home, `.env`, config, and (when configured) whether Ollama or vLLM answers, without printing secrets. `bun run raven config` prints the resolved settings with secrets redacted. `bun run raven mcp` lists configured MCP servers without spawning them. `bun run raven mcp tools` spawns each server and prints tool names. `bun run raven skills` lists user and project skills. `bun run raven skills new <name>` writes `SKILL.md` (`--project` for this repo). `bun run raven skills rm <name>` deletes it. `bun run raven init` writes `AGENTS.md` if missing. Prefix ids are ok.

Shell completion:

```bash
# bash
eval "$(bun run raven completions bash)"
# zsh
eval "$(bun run raven completions zsh)"
```

`bun run raven` or `bun run raven setup` writes `~/.ravenclaw/.env` when no key is configured. On a TTY the key is masked with `*`. `exec` and `acp` print a hint instead of prompting.

Embed the same engine without Ink:

```ts
import { createRavenSession } from '@ravenclaw/sdk'
const session = await createRavenSession({ cwd: process.cwd(), store: 'memory', provider })
```

Local plugins are `~/.ravenclaw/plugins/<name>/plugin.json` (user-installed only; they ask before running). Skill `allowed-tools` shrinks the live pool for the rest of the turn. `Agent` can take `isolation: "worktree"`. Plan mode may write only `.ravenclaw/plan.md`.

This process is the same OS user as you. There is no network sandbox. Writes under `~/.ssh/id_*` and `$RAVENCLAW_HOME/state.db` are hard-denied; `.env` writes ask first.

## Sessions

SQLite WAL at `$RAVENCLAW_HOME/state.db`. **One live writer per session id.** A second `raven` process may read the same database and may create a different session; it must not write the same session id.

In the TUI: `/help`, `/resume`, `/compact`, `/cost`, `/search`, `/learn`, `/review`, `/quit`. `/review` appends a read-only summary to `.ravenclaw/MEMORY.md`. Shift+Tab cycles `default → acceptEdits → plan → default`. Escape aborts the current turn.

If `included.gatewayUrl` is a real URL and `GET /v1/entitlement` admits the session, the CLI uses the included-model gateway and `funding: included` (ads may mount). A denied probe falls back to BYOK.

## Packages

- `@ravenclaw/core` — query loop, tools, permissions, sessions, Provider port, MCP merge, specialists
- `@ravenclaw/providers` — OpenAI-compatible, Anthropic, optional included-model gateway
- `@ravenclaw/ads` — first-party ad layout, house floor, entitlement probe (included sessions only)
- `@ravenclaw/cli` — `raven` Ink TUI (default)
- `@ravenclaw/tui-opentui` — StreamEvent view-swap seam
- `@ravenclaw/acp` — Agent Client Protocol JSON-RPC adapter

## Docs

- [System design](docs/superpowers/specs/2026-09-08-ravenclaw-coding-agent-design.md)
- Prior art notes: [Hermes](docs/research/hermes-agent-analysis.md), [Freebuff](docs/research/freebuff-analysis.md), [loop semantics](docs/research/claude-code-analysis.md)

## Develop

```bash
bun test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for layout, how to add a CLI command, and how to cut a release. See [SECURITY.md](SECURITY.md) to report a vulnerability without pasting keys.

