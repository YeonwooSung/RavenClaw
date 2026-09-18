# RavenClaw

v0.1.33. RavenClaw is a Bun/TypeScript coding agent. It reads and edits a workspace, runs a shell, and resumes after crash. Bring your own API keys (BYOK). No RavenClaw backend is required.

Licensed under Apache-2.0.

## Requirements

- [Bun](https://bun.sh) 1.x
- An `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or a local server: [Ollama](https://ollama.com) / [vLLM](https://docs.vllm.ai)

## Install

```bash
npm i -g @ravenclaw/cli
raven --help
```

Requires [Bun](https://bun.sh) 1.x on `PATH`. From source:

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
# BRAVE_API_KEY=...          # optional WebSearch
# SERPER_API_KEY=...         # optional WebSearch
EOF
chmod 600 ~/.ravenclaw/.env
```

Optional `~/.ravenclaw/config.yaml`:

```yaml
model: claude-sonnet-5       # official API id; omit to use the provider default
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
    # - name: remote
    #   type: http                 # http | sse | stdio (default)
    #   url: https://example/mcp
```

A server that fails to spawn or list tools is skipped; RavenClaw still boots. Built-in tool names win if an MCP tool collides.

Optional memory files (context snapshot, 8k/file, 16k total): `~/.ravenclaw/USER.md`, `~/.ravenclaw/MEMORY.md`, and the same names under the project root or `.ravenclaw/`.

Resolution: `--provider` / `--model` flags beat `config.yaml`, which beats env for the *choice* of provider. Env still supplies the secret (except Ollama/vLLM, which do not need a cloud key).

## Models

`--model` and `config.yaml` `model:` are sent **as-is** to the provider. RavenClaw does not rewrite or pin them to a remote catalog.

When `model:` is omitted, the provider's **default role** is used:

| Provider | Default API id | Strong | Fast |
|---|---|---|---|
| `anthropic` | `claude-sonnet-5` | `claude-opus-5` | `claude-haiku-4-5` |
| `openai_compat` | `gpt-5.6-terra` | `gpt-6-astra` | `gpt-5.6-luna` |
| `ollama` | `llama3.2` | — | — |
| `vllm` | `local-model` | — | — |

Roles (`default` / `strong` / `fast`) exist only in code (`defaultModelId` in `packages/core/src/cost/models.ts`). They are not `config.yaml` keys. Put the official API id in config:

```yaml
provider: openai_compat
model: gpt-5.6-terra
```

```bash
raven --provider anthropic --model claude-opus-5
```

Built-in price / context / thinking rows (plus a few extras):

| API id | Family | Context | Thinking |
|---|---|---|---|
| `claude-sonnet-5` | Anthropic | 1M | yes |
| `claude-opus-5` | Anthropic | 1M | yes |
| `claude-fable-5-1` | Anthropic | 1M | yes |
| `claude-haiku-4-5` | Anthropic | 200k | yes |
| `gpt-5.6-terra` | OpenAI | 1.05M | no |
| `gpt-5.6-sol` (`gpt-5.6`) | OpenAI | 1.05M | no |
| `gpt-6-astra` | OpenAI | 1.05M | no |
| `gpt-5.6-luna` | OpenAI | 1.05M | no |

An unknown id still runs. It gets a conservative 32k window, $0 cost, and no thinking. You can override window and prices without a code change:

```yaml
model: claude-sonnet-6
contextWindow: 1000000
prices:
  claude-sonnet-6:
    input: 3.0
    output: 15.0
```

Vendor-prefixed and dated aliases (`anthropic/claude-sonnet-5`, `openai/gpt-5.6-terra`, `claude-haiku-4-5-20251001`) resolve to the same profile. `/model <id>` updates the session string **and** reloads the profile (window, thinking, prices) for the next turn. The live in-flight `queryLoop` is not mutated.

Sources: [Claude models](https://docs.anthropic.com/en/docs/about-claude/models/overview), [OpenAI models](https://developers.openai.com/api/docs/models). To bump defaults after a new generation, see [CONTRIBUTING.md](CONTRIBUTING.md#updating-the-model-catalog).

## Local LLMs (Ollama / vLLM)

Both use the OpenAI Chat Completions API. No cloud key is required.

**Ollama** (default `http://127.0.0.1:11434/v1`, model `llama3.2`):

```bash
ollama pull llama3.2
bun run raven setup          # choose 3) Ollama
bun run raven --provider ollama --model llama3.2
```

**vLLM** (default `http://127.0.0.1:8000/v1`):

```bash
echo 'VLLM_BASE_URL=http://127.0.0.1:8000/v1' >> ~/.ravenclaw/.env
bun run raven --provider vllm --model Qwen/Qwen2.5-Coder-7B-Instruct
```

## Run

```bash
bun run raven                          # Ink TUI (default)
bun run raven --tui opentui
bun run raven exec "list TypeScript files"
bun run raven exec --json "summarize README.md"
bun run raven exec --dont-ask --tools-preset ci "run bun test"
bun run raven acp                      # editor JSON-RPC, editor ask; optional --dont-ask
```

`exec` is `dontAsk`, not bypass: in-tree Edit/Write/ApplyPatch proceed; leftover Bash is denied unless `.ravenclaw/permissions.json` allows it. See [docs/headless.md](docs/headless.md).

`bun run raven` or `bun run raven setup` writes `~/.ravenclaw/.env` when no key is configured. `exec` and `acp` print a hint instead of prompting.

After setup, `bun run smoke` does one live text-only turn and expects `pong`. CI does not run this.

### CLI commands

| Command | Key? | What it does |
|---|---|---|
| `(default)` | yes | Interactive TUI |
| `exec <prompt>` | yes | One-shot; forces `dontAsk` |
| `acp` | yes | Agent Client Protocol on stdin/stdout |
| `setup` | no | Write `~/.ravenclaw/.env` |
| `smoke` | yes | Live ping; expects `pong` |
| `sessions` | no | List recent sessions for this directory |
| `show <id>` | no | Print transcript |
| `rm <id>` | no | Delete a session and child Agent sessions |
| `resume [id]` | list no / open yes | List or open a session |
| `search [--all] <q>` | no | FTS5 search (this directory, or all) |
| `export <id>` | no | Markdown transcript |
| `title <id> <name>` | no | Set session title |
| `doctor` | no | Home, `.env`, config, local LLM reachability (secrets redacted) |
| `config` | no | Resolved settings, secrets redacted |
| `init` | no | Write `AGENTS.md` if missing |
| `completions bash\|zsh` | no | Shell completion script |
| `mcp [list\|tools]` | no | List MCP servers, or spawn and list tool names |
| `skills [new\|rm <name>]` | no | List / create / delete skills (`--project` = cwd) |
| `cron list\|add\|rm\|on\|off` | no | Local scheduled jobs |
| `cron tick\|watch` | if a job fires | Run due jobs once, or poll |
| `serve` | yes | Loopback HTTP turn + HMAC webhook (`dontAsk`) |
| `slack` | yes | Slack Socket Mode bot (allowlist; no public URL) |
| `discord` | yes | Discord Gateway bot (allowlist + DM pairing) |
| `pairing` | no | List / approve / revoke Discord DM pairing |

Prefix session ids are ok.

### Flags

| Flag | Meaning |
|---|---|
| `--provider` | `anthropic` \| `openai_compat` \| `ollama` \| `vllm` |
| `--model <id>` | Official API model id (see [Models](#models)) |
| `--tui ink\|opentui` | TUI host (default Ink) |
| `--dont-ask` | Leftover asks become denials (except in-tree Edit/Write/ApplyPatch and read-only tools; Fetch and AskUser stay denied) |
| `--json` | `exec` only: StreamEvents as JSONL |
| `--fallback-model <id>` | On a retryable stream failure, switch to this model |
| `--allowed-tools a,b` | Restrict the tool pool (plan tools stay) |
| `--tools-preset read\|write\|ci` | Fill `--allowed-tools` when unset (`ci` still needs a Bash project rule) |
| `--worktree [name]` | Start in a detached git worktree under `.ravenclaw/worktrees` |
| `--json-schema <json>` | Require a `StructuredOutput` call matching this object schema |
| `--agent <id>` | Start with that catalog or disk agent's tools |
| `--add-dir <path>` | Extra permission root (repeatable) |
| `--cwd <dir>` | Working directory |
| `--effort <level>` | Thinking-effort hint in the system prompt |
| `--bare` | Skip file hooks, lifecycle hooks, and MEMORY/USER load |
| `--verify-on-stop` | Headless/cron opt-in: nudge if a turn edited files without a test/lint command (TUI default on) |
| `--listen host:port` | `raven serve` bind (loopback only, default `127.0.0.1:8787`) |

```bash
# bash
eval "$(bun run raven completions bash)"
# zsh
eval "$(bun run raven completions zsh)"
```

## TUI

Ink is the default. OpenTUI is `--tui opentui`.

- Shift+Tab cycles `default → acceptEdits → plan → default`.
- Escape aborts the current turn.
- `!cmd` or `/bash cmd` runs a local shell without the model.
- ↑↓ walks prompt history (`~/.ravenclaw/prompt-history.jsonl`).
- `@path` / `@agent` expands file contents or names a specialist.
- Empty submit pastes a clipboard image on macOS (PNG).
- Mid-turn text is queued for the next turn (`/queue`). `/steer <text>` injects into the live turn.

### Slash commands

| Command | Summary |
|---|---|
| `/help` | This list |
| `/resume [id]` | Restore a session; next message is a new turn (tools are not re-run) |
| `/clear` `/new` | New session |
| `/compact` | Compact the conversation |
| `/cost` | Token and USD estimate |
| `/search [ --all] <q>` | FTS5 search |
| `/mode <mode>` | `default` \| `acceptEdits` \| `plan` \| `dontAsk` |
| `/model [id]` | Show or set model for the next turn (reloads window, prices, thinking) |
| `/title <name>` | Session title |
| `/learn` | Ask the model to write a skill from this session |
| `/review` | Append a read-only review to `.ravenclaw/MEMORY.md` |
| `/interview` | Ask clarifying questions (`AskUser`) before coding |
| `/undo` | Restore files from the last closed edit checkpoint |
| `/rewind` | Job: checkpoint `git reset --hard` + todos; no-job: undo files **and** drop last user turn |
| `/job [name]` | Enter a named `raven/*` job worktree; `/job commit on\|off` flips opt-in turn-end commit |
| `/pr [title]` | Open or update a draft PR from the session shadow (default off) |
| `/diff` | Uncommitted + staged git diff |
| `/steer <text>` | Inject into the live turn |
| `/queue [drop n\|clear]` | Next-turn message queue |
| `/loop <n> <prompt>` | Repeat a prompt n times (max 20). `/loop` status, `/loop stop` |
| `/tasks [kill <id>]` | Background Bash / Agent tasks |
| `/cron [add\|rm\|on\|off]` | Local scheduled jobs |
| `/add-dir <path>` | Notice only — does not add a root; use the `AddDir` tool or `--add-dir` |
| `/effort [low\|medium\|high\|max]` | Notice only — does not persist; pass `--effort` at start |
| `/team-onboarding` `/onboard` | Walk a new teammate through this workspace |
| `/agents` | Built-in and disk agents |
| `/hooks` | Lifecycle event names |
| `/skills [show\|disable\|enable <name>]` | List, show, or disable skills |
| `/skill:<name>` | Load that skill |
| `/mcp` | Configured MCP servers |
| `/reload` | Rebuild system parts (skills, memory) |
| `/permissions` | Extra rule files |
| `/config` | Resolved config |
| `/context` | Compact generation and message count |
| `/copy` | Copy the conversation as markdown |
| `/bash <cmd>` | Local shell (also `!cmd`) |
| `/stop` `/cancel` | Abort the current turn |
| `/quit` | Exit |

## Tools

The root session can call:

| Tool | Notes |
|---|---|
| `Read` `Grep` `Glob` `ListDir` `ReadSubtree` | Read. `.ipynb` is shown as cells |
| `Edit` `Write` `ApplyPatch` `NotebookEdit` | Write. `Edit` tolerates CRLF and indent. In-tree ApplyPatch is promoted under `acceptEdits`/`dontAsk`; NotebookEdit leftover-asks |
| `Bash` | Shell. `run_in_background` + `TaskOutput` / `TaskStop` |
| `Skill` | Load a skill body or a file under that skill dir |
| `Fetch` | HTTP GET with SSRF guards |
| `WebSearch` | BYOK Brave or Serper (`BRAVE_API_KEY` / `SERPER_API_KEY`) |
| `TodoWrite` | Session checklist |
| `TaskCreate` `TaskGet` `TaskUpdate` `TaskList` | Durable `.ravenclaw/tasks.json` |
| `AskUser` | Multiple-choice questions (TUI host) |
| `SuggestFollowups` | Follow-up prompts |
| `SetOutput` | Structured child output |
| `StructuredOutput` | Only when `--json-schema` is set; required before complete |
| `ToolSearch` | Search the tool pool |
| `Sleep` | Abortable wait (≤60s) |
| `ThinkDeeply` | Log a thought, no files |
| `AddDir` | Extra permission root for this session |
| `LSP` | Hover/definition/references if `.ravenclaw/lsp.json` exists |
| `EnterWorktree` `ExitWorktree` | Session git worktree (cwd persists) |
| `CronCreate` `CronList` `CronDelete` `CronSetEnabled` | Local cron (root only) |
| `Agent` | Nested agent. `agents[]` parallel; `run_in_background`; `isolation: worktree` |
| `EnterPlanMode` `ExitPlanMode` | Plan file `.ravenclaw/plan.md` |
| `ListMcpResources` `ReadMcpResource` | When MCP is configured |

`safetyCheck` denies writes under `.git/`, credential-like names, and shell rc for `Edit` / `Write` / `ApplyPatch`. Hard-deny: `~/.ssh/id_*`, `$RAVENCLAW_HOME/state.db`, `/etc/shadow`. `.env` writes still ask.

## Agents

Spawnable from the root `Agent` tool:

| Id | Role |
|---|---|
| `general` | Default nested worker |
| `file-finder` | Locate files |
| `command-runner` | One shell command |
| `reviewer` | Same-model, no tools, parent history |
| `researcher-web` | `WebSearch` + `Fetch` (at least 3 pages) |

Disk agents: `<project>/.ravenclaw/agents/*.md` (or `~/.ravenclaw/agents`). `--agent <id>` starts the session as that definition.

## Skills

Load order (later wins): **builtin → user → project**.

| Source | Path |
|---|---|
| Builtin | shipped with `@ravenclaw/core` |
| User | `~/.ravenclaw/skills/<name>/SKILL.md` |
| Project | `<cwd>/.ravenclaw/skills/<name>/SKILL.md` |

Frontmatter: `name`, `description`, `allowed-tools` (intersects the live pool for the rest of the turn). Disabled names live in `~/.ravenclaw/skills-disabled.json`.

Builtin skills:

| Name | Use |
|---|---|
| `review` | Read-only review of recent edits |
| `test` | Smallest tests that cover the change |
| `commit` | Conventional commit from the diff (no push) |
| `debug` | Reproduce, hypothesize, then a minimal fix |
| `tdd` | Red-green-refactor |
| `plan` | Write a plan before editing |
| `frontend-design` | Pick one aesthetic before building or reshaping UI |
| `mcp-builder` | Write a local MCP server this CLI can load (`raven mcp tools` to verify) |

```bash
bun run raven skills
bun run raven skills new my-flow --project
/skills show review
/skills disable review
/skill:tdd
```

`/learn` asks the model to write a new skill from this session.

## Local gateway (`raven serve`)

Long-lived **loopback** host. Same `queryLoop` as `exec`. Requires `GATEWAY_SECRET` or `RAVEN_SERVE_SECRET`.

```bash
export GATEWAY_SECRET=dev-secret
bun run raven serve --listen 127.0.0.1:8787
# POST /v1/turn  Authorization: Bearer dev-secret
#   { "text": "list files", "sessionKey": "cli:dm:local" }
# POST /webhooks/<route>  X-Raven-Signature: t=<unix>,v1=<hmac-sha256 of t.body>
#   each delivery is a new session; tools are Read/Grep/Glob/Fetch/WebSearch only
```

Non-loopback binds are rejected. Chat hosts that reuse the same loop (not `raven serve`) are `raven slack` (Socket Mode, allowlist) and `raven discord` (Gateway, allowlist + DM pairing via `raven pairing`).

## Loop

`/loop <n> <prompt>` runs the same prompt up to 20 times. Each turn is tagged `[loop i/n]`. After a turn finishes, the next iteration starts (after any `/queue` items). `/loop` prints status. `/loop stop` cancels remaining iterations.

## Cron

Jobs live in `~/.ravenclaw/cron/jobs.json`. Schedules are 5-field UTC cron or `every <duration>` (min 15s). A fire opens a new `dontAsk` session (same pairing as `raven exec`: headless stays BYOK when the gateway sets `placementRequired`).

```bash
bun run raven cron add every 30m "run the unit tests"
bun run raven cron list
bun run raven cron on <id>
bun run raven cron tick          # one pass
bun run raven cron watch         # poll
```

The Ink/OpenTUI ticker also fires due jobs every 15s. Claim-before-execute; overlapping runs of the same id are skipped.

## Permissions

| Mode | Behavior |
|---|---|
| `default` | Ask before leftover-ask tools |
| `acceptEdits` | In-tree Edit/Write/ApplyPatch (and extra `--add-dir` roots) proceed |
| `plan` | Mutating tools denied; write `.ravenclaw/plan.md` |
| `dontAsk` | Leftover asks become denials, except in-tree Edit/Write/ApplyPatch and read-only tools. Fetch and AskUser stay denied. |

There is no `bypass` mode. Headless `raven exec` uses `dontAsk` plus optional `--tools-preset` / project `.ravenclaw/permissions.json` — see [docs/headless.md](docs/headless.md). File hooks: `~/.ravenclaw/hooks.json` and `<cwd>/.ravenclaw/hooks.json`. `pre_tool` / `PreToolUse` can allow or deny. Lifecycle events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`. `--bare` skips them.

## MCP

stdio, streamable HTTP, and SSE. Resources: `ListMcpResources` / `ReadMcpResource`. Optional headers on HTTP servers. No company OAuth broker; a future PKCE loopback is not required for stdio.

## Sessions

SQLite WAL at `$RAVENCLAW_HOME/state.db`. **One live writer per session id.**

Embed without Ink:

```ts
import { createRavenSession } from '@ravenclaw/sdk'
const session = await createRavenSession({ cwd: process.cwd(), store: 'memory', provider })
```

Local plugins: `~/.ravenclaw/plugins/<name>/plugin.json` and project `.ravenclaw/plugins` (they ask before running).

This process is the same OS user as you. There is no network sandbox.

## Included gateway (optional)

If `included.gatewayUrl` is a real URL and `GET /v1/entitlement` admits the session, the CLI uses the included-model gateway and `funding: included` (ads may mount). A denied probe falls back to BYOK. Interactive surfaces only: `raven exec`, `raven smoke`, and `raven acp` stay BYOK when the gateway sets `placementRequired`. Resume of an already-included session still uses the gateway. Prompts and messages may be used to choose first-party ads for included-model sessions. Repository contents are not sent to the ad feed. BYOK sessions do not contact the ad feed. An empty ad feed URL never opens a socket.

## Packages

- `@ravenclaw/core` — query loop, tools, permissions, sessions, Provider port, MCP, specialists, skills
- `@ravenclaw/providers` — OpenAI-compatible, Anthropic, optional included-model gateway
- `@ravenclaw/ads` — first-party ad layout, house floor, entitlement probe (included sessions only)
- `@ravenclaw/cli` — `raven` Ink TUI (default)
- `@ravenclaw/tui-opentui` — StreamEvent view-swap seam
- `@ravenclaw/acp` — Agent Client Protocol JSON-RPC adapter
- `@ravenclaw/sdk` — `createRavenSession` (no Ink, ads, or CLI)

## Docs

- [Architecture](ARCHITECTURE.md) ([한국어](ARCHITECTURE.ko.md))
- [Slash commands](SLASH_COMMANDS.md) ([한국어](SLASH_COMMANDS.ko.md))
- [Headless / `raven exec` permissions](docs/headless.md)
- [GitHub Action (`raven-exec`)](.github/actions/raven-exec/README.md)
- [System design](docs/superpowers/specs/2026-09-08-ravenclaw-coding-agent-design.md)
- [Cron / scheduler](docs/superpowers/specs/2026-09-12-ravenclaw-cron-scheduler-design.md)
- Prior art notes: [Hermes](docs/research/hermes-agent-analysis.md), [Freebuff](docs/research/freebuff-analysis.md), [Claude Code loop](docs/research/claude-code-analysis.md), [eve](docs/research/eve-analysis.md) ([한국어](docs/research/eve-analysis.ko.md)), [y0](docs/research/y0-analysis.md) ([한국어](docs/research/y0-analysis.ko.md))
- Session-as-job horizon (named shadow, checkpoint rewind, reconnectable serve, optional `/pr`; **implemented** at `ea56edd`, closeout `0ef1554`): [2026-09-16-session-as-job-roadmap.md](docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md)
- Job-host state (snapshot end-reason, one-slot follow-up, edit-resubmit, job diff; **implemented** at `6e56764`): [2026-09-17-job-host-state-roadmap.md](docs/superpowers/specs/2026-09-17-job-host-state-roadmap.md)
- Next horizon (rewind persist-before-reset / `todo.json` projection): [2026-09-18-rewind-persist-and-todo-projection.md](docs/superpowers/specs/2026-09-18-rewind-persist-and-todo-projection.md)
- Previous horizon (durable HITL, sandbox port, session HTTP; implemented): [2026-09-15-eve-inspired-roadmap.md](docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md)

## Develop

```bash
bun test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for layout, how to add a CLI command, and how to cut a release. See [SECURITY.md](SECURITY.md) to report a vulnerability without pasting keys.
