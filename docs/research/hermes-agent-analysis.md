# Hermes Agent — Prior-Art Analysis for RavenClaw

Hermes Agent (Nous Research, MIT, v0.21.1) is a personal AI agent with a **narrow core loop** and an enormous product surface around it. This note extracts architecture, loop design, and feature ideas for RavenClaw. Steal patterns; do not copy code.

Repo analyzed: `/Users/yeonwoosung/Desktop/hermes-agent` (read-only).

---

## 1. Product surface

Hermes is **one agent core** (`AIAgent` in `run_agent.py`) exposed through many front ends:

| Surface | Entry | Role |
|---|---|---|
| Classic CLI | `cli.py` (`HermesCLI` + `hermes_cli/cli_*_mixin.py`) | prompt_toolkit REPL, slash commands |
| TUI | `ui-tui/` (Ink/React) + `tui_gateway/` (Python JSON-RPC) | recommended interactive UI (`hermes --tui`) |
| Desktop | `apps/desktop/` (Electron) | same backend via TUI gateway; panes, previews, projects |
| Web dashboard | `web/` + `hermes_cli/web_routers/` | FastAPI admin + optional chat PTY |
| Messaging gateway | `gateway/run.py` + `gateway/platforms/` + `plugins/platforms/` | Telegram, Discord, Slack, WhatsApp, Signal, Email, Matrix, Teams, ~25 adapters |
| ACP | `acp_adapter/` | VS Code / Zed / JetBrains over stdio JSON-RPC |
| API server | `gateway/platforms/api_server.py` | OpenAI-compatible HTTP |
| Library / batch | `run_agent.AIAgent`, `batch_runner.py` | programmatic + trajectory generation |
| Cron | `cron/jobs.py`, `cron/scheduler.py` | first-class agent jobs, not shell cron |

**Shared-state contract:** all surfaces share `~/.hermes/` — `config.yaml` (behavior), `.env` (secrets only), `state.db` (sessions), `skills/`, `memories/`. Profiles isolate homes (`hermes_constants.get_hermes_home()`).

### Feature inventory

**Core (every coding session actually needs these):**

- Tool-calling loop with streaming, retries, fallbacks
- File tools (`read_file`, `write_file`, `patch`, `search_files`) + terminal
- Skills (agentskills.io progressive disclosure)
- Session persistence + resume
- Context files (`AGENTS.md` / `CLAUDE.md` / `.hermes.md` / `.cursorrules`)
- Context compression / prompt-cache hygiene
- Provider abstraction (OpenAI-compat + Anthropic + Codex Responses)

**First-class but optional (gated by toolsets / `check_fn` / config):**

- Memory (`MEMORY.md` / `USER.md`) + `session_search` (FTS5)
- Subagents (`delegate_task`) and `execute_code` (RPC tool calling)
- MCP client (`tools/mcp_tool.py`)
- Cron (`cronjob_manage`)
- Browser, web search, vision, image/video gen, TTS
- Plugins (`hermes_cli/plugins.py`) — tools, hooks, providers
- Checkpoints / rollback (`tools` file-mutation snapshots)
- Coding posture (`agent/coding_context.py`) — auto-detect repo, tighten prompt/toolset

**Product-specific (skip for a coding-agent v1):** messaging gateway (~25 platforms), desktop GUI toolsets (`desktop_ui`, `project`), pets/skins/achievements, kanban dispatcher, voice/wake-word/computer-use/HA/Spotify, Honcho and other memory-provider plugins, MoA (`agent/moa_loop.py`), Nous Portal/billing/credential pools, batch RL (`batch_runner.py`, `toolset_distributions.py`), curator LLM consolidation, OpenClaw migration.

Two invariants from `AGENTS.md` explain almost every design choice:

1. **Per-conversation prompt caching is sacred.** The system prompt is byte-stable for the life of a conversation. Mid-session skill/tool/memory changes are deferred to the next session (`--now` to force). The only sanctioned cache break is compression.
2. **The core is a narrow waist.** New capability arrives as CLI+skill, a `check_fn`-gated tool, a plugin, or MCP — almost never a new core tool. Every core tool is sent on every API call.

---

## 2. Agent loop (the thing to steal)

### Shape

`run_agent.py` is a facade. `AIAgent` is assembled from mixins (`TurnFacadeMixin`, `ClientLifecycleMixin`, `StreamDeliveryMixin`, `InterruptControlMixin`, `CompressionFacadeMixin`, …). Construction is `agent/agent_init.py::init_agent`. A user turn is:

```
HermesCLI.process_input / GatewayRunner._handle_message
  → AIAgent.run_conversation   (turn lease in turn_facade_lease.py)
    → agent/conversation_loop.py::run_conversation
      → build_turn_context
      → while budget:
          begin_iteration → prepare_iteration → assemble_api_request
          → run_preflight_gate → announce_api_call
          → _run_api_retry_loop (perform_api_call / handle_api_error)
          → normalize_model_response
          → run_tool_round  OR  finish_text_response
      → finalize_turn
```

Public APIs (`agent/AGENTS.md`):

- `chat(message) -> str`
- `run_conversation(...) -> dict` with `final_response`, `messages`, `api_calls`, `completed`, `failed`, …

Internal messages are OpenAI-shaped: `{role, content, tool_calls?, reasoning?}`. Three API modes (`chat_completions`, `codex_responses`, `anthropic_messages`) convert at the wire and reconverge.

### State machine (one iteration)

Each phase lives in `agent/turn_*.py` and returns a **verdict** (`action`: `continue` / `break` / `return` / `fallthrough`) plus rebound locals. That is the architectural idea: a synchronous loop of named phases, not a 4k-line `while`.

| Phase | File / function | What it does |
|---|---|---|
| Turn setup | `turn_context.build_turn_context` | hydrate history, bind `task_id`/`turn_id`, restore or build system prompt, memory prefetch, persist user row, title session |
| Iteration start | `turn_iteration_prep.begin_iteration` | honor interrupt, review-input budget, iteration budget; one-turn grace via `agent._budget_grace_call` |
| Prep | `prepare_iteration` | `agent:step` hook, skill-nudge counter, `/steer` into newest **tool** result (never a synthetic user mid-loop), role-alternation repair |
| Assemble | `turn_request_assembly.assemble_api_request` | build `api_messages`, MoA extras, cache markers |
| Preflight | `turn_preflight_gate.run_preflight_gate` → `turn_preflight.run_preflight_compression` | Ollama ctx floor; compress if pressure ≥ 50% of window |
| API | `turn_api_call.perform_api_call` | stream vs non-stream; interruptible; MoA handshake |
| API error | `turn_api_error.handle_api_error` + `turn_overflow.recover_from_overflow` | 429/5xx/401, payload-too-large, context overflow |
| Intake | `turn_response_intake.normalize_model_response` + `turn_response_check.check_api_response` | usage, finish_reason, invalid-response retry |
| Empty | `turn_empty_response.recover_empty_response` | think-only / empty ladder |
| Tools | `turn_tool_round.run_tool_round` | validate → persist assistant tool_calls → execute → post-tool compress |
| Text stop | `turn_final_response.finish_text_response` + `turn_stop_gates.apply_stop_gates` | empty recovery, length-continue, verify/kanban nudges |
| Finalize | `turn_finalizer.finalize_turn` | persist, micro-compact, hooks, spawn background review |

`api_mode == "codex_app_server"` short-circuits the whole loop into `agent/transports/codex_app_server_session.py`.

### Iteration budget

`agent/iteration_budget.py::IterationBudget` — thread-safe consume/refund.

- Parent default: `max_iterations=500` (`agent.max_turns`).
- Subagents: independent cap `delegation.max_iterations` (default 50). Parent+children can exceed the parent cap.
- `execute_code` programmatic tool iterations are **refunded** so they do not eat the budget.
- One grace call (`_budget_grace_call`) after exhaustion so the model can emit a summary.
- Optional wrap-up: at 80% of `--run-budget` wall clock, a notice is appended to the newest tool result (`RUN_BUDGET_WRAPUP_NOTICE` in `conversation_loop.py`). Same pattern for iteration-budget warnings (`ITERATION_BUDGET_WARNING_TEMPLATE` in `turn_iteration_prep.py`) — injected into a tool result, never a new user message.

### Interrupt / cancel

`agent/interrupt_control.py` + `tools/interrupt.py`:

- Soft interrupt / `/stop` / new inbound message sets `_interrupt_requested`. Hard interrupt is a `threading.Event` that fans out to concurrent tool-worker tids.
- API call runs in a background thread; the main thread waits on response, interrupt, or timeout. On interrupt the HTTP thread is abandoned; no partial assistant row is committed unless a **redirect/steer** is applied.
- Redirect (`_apply_active_turn_redirect`) keeps role alternation with a hidden assistant placeholder + a user correction whose `api_content` carries the scaffold. Raw CoT never enters replayable content. `/steer` mid-tools appends to the newest tool result (cache-safe).
- Turn lease (`turn_facade_lease.admit_durable_turn_lease`) serializes concurrent turns on the same session.

### Empty response / retry / overflow

**Empty** (`empty_response_guard.py`, `turn_empty_response.py`): recover partial stream → reuse prior turn if only housekeeping tools ran → one post-tool nudge → thinking-only prefill (×2) → budgeted empty retries (default 3) → fallback provider → `(empty)` sentinel. Two consecutive empties with `output_tokens == 0` from the same `(model, provider, finish_reason)` skip remaining retries. If one empty attempt costs more than `$0.25` estimated input, retry budget drops 3→1.

**Invalid tools** (`turn_tool_validation.validate_tool_calls`): auto-repair names; mixed batch error-results only the invalid calls; all-invalid feeds tool-role errors (never a user message) with a 3-strike partial exit. Persist-before-execute: if the assistant tool_call row cannot flush to SQLite, the turn **breaks**.

**Overflow** (`turn_overflow.recover_from_overflow`): 413 scored in **bytes**; context-length in tokens/messages; provider-proven overflow ignores the compression cooldown for one attempt; output-cap errors clamp `max_tokens`. API retries use jittered backoff (`agent/retry_utils.py`); outer-loop exceptions cap at `_MAX_OUTER_LOOP_ERRORS = 8`.

### Tool execution

`agent/tool_executor.py` + `agent/tool_dispatch_helpers.py`:

- Single call → main thread. Multiple → `ThreadPoolExecutor` (`_MAX_TOOL_WORKERS = 8`), results reinserted in original order.
- Barriers: `clarify` is never parallel (`_NEVER_PARALLEL_TOOLS`). Path-scoped file tools admit by overlap: readers may share a subtree; a writer conflicts with any overlapping reservation.
- Concurrent batch timeout default 420s (`timeouts.tools.concurrent_batch`).
- Authorization gate serializes approval prompts so workers do not race the human (`human_wait_ceiling`).
- Inline tools (`INLINE_TOOL_EXECUTORS` in `agent/inline_tool_executors.py`) intercept `todo`, `memory`, `session_search`, `delegate_task` before `model_tools.handle_function_call` — they need live `AIAgent` stores.

### Compaction

Two layers (`website/docs/developer-guide/context-compression-and-caching.md`): gateway hygiene at **85%** (`gateway/run_turn.py`); in-loop `ContextCompressor` at **50%** (`agent/context_compressor.py`, pluggable via `ContextEngine` ABC). Algorithm: prune old tool results (no LLM), pick boundaries, summarize the middle with the **auxiliary** model. Protect last N messages (`protect_last_n`, default 20); never split a tool_call/result pair. Default is **in-place** on the same session id (`active=0` archive + new `active=1` generation). Failure cooldown 60s → 300s → 900s in `state.db`. Usage **anchor** (`agent/usage_anchor.py`) prefers provider-reported tokens + delta; unanchored rough estimates wait one request.

Prompt assembly (`agent/system_prompt.py` + `prompt_builder.py`) is three cached tiers: **stable** (identity/`SOUL.md`, tool guidance) → **context** (project files, git snapshot) → **volatile** (skills index, MEMORY/USER snapshots, timestamp, cwd). Ephemeral layers ride tool results or user-role rows, never the system prompt.

---

## 3. Tool system

### Registration

- Each `tools/*.py` calls `registry.register(name, toolset, schema, handler, check_fn=..., …)` at import (`tools/registry.py`).
- `discover_builtin_tools()` AST-scans for top-level `register()` then imports. MCP and plugins register after.
- `check_fn` is the availability gate (API key, binary, service). Fail-closed; results TTL-cached process-wide — so **session-scoped** surface must not live in `check_fn`.
- `model_tools.get_tool_definitions(enabled_toolsets, disabled_toolsets)` expands composites via `toolsets.resolve_toolset()`.

### Toolset distributions

`toolsets.py`:

- `_HERMES_CORE_TOOLS` — shared list for CLI + messaging (web, terminal, files, skills, browser, todo, memory, session_search, clarify, execute_code, delegate_task, cron, HA, kanban, …).
- Named sets: `web`, `file`, `terminal`, `browser`, `skills`, `memory`, `delegation`, `code_execution`, `coding`, `safe`, plus platform bundles (`hermes-cli`, `hermes-acp`, …).
- `_DEFAULT_OFF_TOOLSETS` (`hermes_cli/tools_config.py`): `homeassistant`, `spotify`, `discord`, `discord_admin`, `video`, `video_gen`, `x_search`, `a2a`.
- GUI-only sets (`desktop_ui`, `project`) are folded in by `tui_gateway/server.py::_load_enabled_toolsets` from the **session platform**, never `HERMES_DESKTOP=1`.
- `coding` posture (`agent/coding_context.py`): on `cli`/`tui`/`acp`/`desktop`, detect a repo and tighten the prompt; `focus` may collapse the toolset.

`toolset_distributions.py` is **batch/eval only** (probabilistic sampling). Not a runtime concept.

### Guardrails and file safety

- Terminal approval: `tools/approval.py` `DANGEROUS_PATTERNS` (`rm -rf`, `curl|sh`, `dd`, …). CLI prompts; gateway uses allowlists.
- File safety (`agent/file_safety.py`): hard-deny writes to `~/.ssh/id_*`, `.env`, `state.db`, `/etc/shadow`, …; `~/.ssh/config` is approval-gated. Explicitly **not** a security boundary — the terminal is the same OS user.
- Loop guardrails (`agent/tool_guardrails.py`): stall detector, failure/no-progress counters, per-turn caps (`max_web_searches=50`, `max_subagents=50`). Unattended platforms can hard-stop; attended surfaces warn.
- Checkpoints: `_ensure_file_checkpoint` before `write_file`/`patch`.

### MCP / plugins

- MCP: `tools/mcp_tool.py` + `tools/mcp_tool_discovery.py`. stdio and HTTP. Per-server filter. Catalog in `optional-mcps/`.
- Plugins: `~/.hermes/plugins/`, project `.hermes/plugins/`, pip entry points, plus bundled `plugins/`. Manifest `plugin.yaml` + `register(ctx)`. Bundled plugins are **opt-in**. Specialized ABCs: model providers, memory, context engine, browser, image/video/web-search, terminal env, secret sources, platform adapters.

---

## 4. Skills / memory / learning

### Skills (agentskills.io)

On-disk: `~/.hermes/skills/<name>/SKILL.md` + optional `references/`, `scripts/`, `assets/`. Bundled copy from `skills/`; `optional-skills/` is install-explicit.

Progressive disclosure:

- Level 0: skill **index** (name + ≤60-char description) in the system prompt / `skills_list`
- Level 1: `skill_view(name)` loads full SKILL.md
- Level 2: `skill_view(name, path)` loads a reference file

Frontmatter: `name`, `description`, `version`, optional `platforms`, `metadata.hermes.{tags, category, fallback_for_toolsets, requires_toolsets}`. Compatible with [agentskills.io](https://agentskills.io).

Agent writes via `skill_manage` (`tools/skill_manager_tool.py`). `/learn` (`agent/learn_prompt.py::build_learn_prompt`) is **not a tool** — it is a standards-guided user prompt that makes the live agent author a skill. Large sources become a lean SKILL.md + `references/` knowledge base.

**Curator** (`agent/curator.py`): idle-triggered (default every 7 days, 2h idle). Deterministic prune: unused 30d → stale, 90d → archive under `skills/.archive/` (never delete). LLM consolidation is **off by default**. Hub-installed skills are off-limits; pinned and cron-referenced skills are skipped.

### Memory

Two bounded files in `~/.hermes/memories/`:

| Store | Limit | Role |
|---|---|---|
| `MEMORY.md` | 2,200 chars | environment, conventions, lessons |
| `USER.md` | 1,375 chars | user profile / preferences |

Frozen into the system prompt at session start (cache). Live writes via the `memory` tool (`add` / `replace` / `remove` with unique-substring match) persist immediately but appear in the prompt next session. Full store returns an error; the agent must consolidate itself — no silent drop.

`MemoryManager` (`agent/memory_manager.py`) fans hooks to the builtin provider plus **at most one** external plugin (Honcho, Mem0, Hindsight, …). Cron passes `skip_memory=True`.

### Session search (FTS5)

`~/.hermes/state.db` (WAL). Virtual tables: `messages_fts`, `messages_fts_trigram`, `messages_fts_cjk` (`hermes_state_fts.py`, native tokenizer in `native/fts5_cjk/`). Tool: `tools/session_search_tool.py` — discovery / scroll / read / browse. **No LLM in the tool itself**; ranking is FTS + lineage dedup. Cron sources are demoted so they do not starve interactive recall. Hidden sources: `kanban`, `subagent`, `tool`.

### How the “self-improving” loop actually works

It is **not** a trainer. Three cheap, cache-safe nudges plus a detached fork:

1. **Memory nudge** (`turn_context._tick_memory_nudge`): every N user turns (default 10) set `should_review_memory`.
2. **Skill nudge** (`turn_finalizer`): if this turn used ≥ N tool iterations (default 10) and `skill_manage` is enabled, flag skill review.
3. **Background review** (`agent/background_review.py`): after delivery, a daemon forks a second `AIAgent` that **inherits the parent’s byte-identical system prompt and `tools[]`** (same prefix cache) but is persistence-detached (`_persist_disabled`). Dispatch whitelist: `memory`, `skill_manage`, `read_file`, `search_files`. Dangerous commands auto-deny. Cancelled when the next live turn starts.
4. **Curator** separately prunes the skill library on idle.

That is the whole loop: periodic self-prompts + a cache-warm fork that may write memory/skills. Honcho (optional) adds dialectic user modeling.

---

## 5. Multi-agent

### `delegate_task` (`tools/delegate_tool.py`)

Child is a fresh `AIAgent` with **empty history**. Only `goal` + `context` (plus project context files minus `SOUL.md` if the parent has a workspace). Isolated terminal; child processes die with the child. Independent `IterationBudget` (default 50). Batch `tasks=[...]` defaults to 3 concurrent (no hard ceiling). Top-level calls return a handle and finish in the background; orchestrator children wait and synthesize. Parent tool-resolution (`_last_resolved_tool_names`) is saved/restored around the child.

### Public lifecycle API (`agent/subagent_lifecycle.py`)

Plugin-safe, no `AIAgent` leak. `SubagentLaunchRequest` / `SubagentHandle` (HMAC capability). States: `PENDING → STARTING → RUNNING → SUCCEEDED|FAILED|INTERRUPTED|CANCELLED`. Cancel is cooperative. Results bounded to 32k chars, hashed, retained in-process 1 hour. Fail-closed: cannot broaden parent toolsets.

### Other parallelism

`execute_code` runs a child Python process over a Unix-socket RPC (`hermes_tools` stub) so intermediate tool results never enter the parent window (iterations refunded). Kanban and `batch_runner.py` are product/eval, not core.

---

## 6. Runtime / providers / persistence

### LLM providers

Shared resolver: `hermes_cli/runtime_provider.py` + `hermes_cli/auth.py` + `providers/` (`ProviderProfile`) + `plugins/model-providers/<name>/`. Precedence: explicit request → `config.yaml` → env → plugin defaults. Saved choice beats a stale shell export.

API modes: `chat_completions` (default), `anthropic_messages`, `codex_responses`, plus `codex_app_server` transport. Auxiliary tasks (compression, curator, vision, titles) route through `agent/auxiliary_client.py::_resolve_auto_route` with per-slot `auxiliary.*` config.

### Terminal backends

`tools/environments/` — one `BaseEnvironment` ABC. Spawn-per-call `bash -c`; session snapshot re-sourced; cwd via in-band marker or temp file. Backends: `local` (default; Windows Git Bash), `docker`, `ssh`, `singularity`, `modal`/`managed_modal`, `daytona`, `vercel_sandbox`. Selected by `TERMINAL_ENV`. Connection failures raise `EnvironmentConnectionError` and are not cached.

### Persistence

`hermes_state.py` facade + `hermes_state_*.py` siblings. SQLite WAL at `$HERMES_HOME/state.db`.

Tables that matter: `sessions` (lineage via `parent_session_id`, usage, cwd/git), `messages` (full history + `active` for in-place compaction), `messages_fts*`, `compression_locks`, `async_delegations`.

Worth copying: WAL + one-writer; persist user input **before** the model call; persist assistant tool_calls **before** side effects; classify persistence errors and fail the turn rather than continue unsafely; FTS rebuild is fail-open.

---

## 7. What RavenClaw should steal vs skip

### Steal first (v1 coding agent)

1. **Phase-split synchronous loop with verdicts.** One `while` + named phases returning `continue|break|return`. No event-loop in the core.
2. **Byte-stable system prompt + cache-safe injections.** Mid-turn extras go on the newest tool result or a well-formed user row. Highest-leverage cost/latency idea in the repo.
3. **Strict role alternation**; never inject a synthetic user mid-loop. Cron/reviews get their own session or a detached fork.
4. **Persist-before-execute** for tool_call rows; fail the turn if SQLite cannot commit.
5. **Tool registry + toolsets + `check_fn`.** Keep the core schema tiny. Session-scoped surface is a toolset, not an env var.
6. **Parallel tools with an explicit planner** (never-parallel set + path-overlap), not “run everything in a pool.”
7. **Empty / overflow / invalid-tool ladders** with strike counters and cost-aware empty retries.
8. **Two-layer compression:** prune tool results, then LLM-summarize the middle, protect a tail, never split pairs. Usage-anchor so you do not compact on a bad estimate.
9. **Skills as progressive disclosure** (agentskills.io). Index in the prompt; body on demand. `/learn` as a prompt, not a tool.
10. **Bounded MEMORY.md + USER.md** — full returns an error; the agent consolidates. Frozen snapshot at session start.
11. **FTS5 session search** over the same SQLite that stores history.
12. **Subagents = fresh context + goal/context only**, independent budget, summary only back to parent.
13. **`execute_code` RPC** so intermediate results never hit the window.
14. **Coding posture:** detect a repo, inject a short operating brief, optionally shrink the toolset.
15. **File deny-list + dangerous-command approval**, labeled as defense-in-depth.
16. **Footprint ladder:** extend → CLI+skill → gated tool → plugin → MCP → new core tool (last).

### Steal later (v1.x)

Background memory/skill review fork (only after the main loop is solid — easy to poison the transcript). Interrupt + steer/redirect. Provider fallback. MCP with per-server allowlists. Local + Docker backends (skip Modal/Daytona/Vercel). ACP if editor embedding is a goal. Skill curator prune-only.

### Do not put in v1

Messaging gateway, Electron desktop, pets/skins/achievements, voice/wake-word, kanban, MoA, Honcho, billing, cloud terminal backends, Tool Gateway, hook soup beyond `pre_tool_call` / `post_tool_call` / `on_turn_complete`, trajectory/RL batch.

---

## 8. Risks if we copy too much

**License.** MIT (Copyright 2025 Nous Research). Ideas are free; copying substantial code still requires the MIT notice. RavenClaw’s brief is to steal architecture, not paste modules. Do not import Hermes files, compat shims, or `PLUGIN-COMPAT` blocks.

**Complexity trap.** The loop is conceptually simple; the *implementation* is ~40 `turn_*.py` phases, 21 `hermes_state_*` siblings, 15 `gateway/run_*` siblings, and ~39k tests. That decomposition was a reaction to god-files. If we copy the phase *count* instead of the phase *idea*, we will ship a museum.

Specific traps:

- **Cache-stability as religion** produces many sidecar fields (`api_content`, `display_kind=hidden`, ghost-row filters). Worth the first three; not the twentieth special case.
- **Facade + lazy sibling imports** (`from run_agent import X` inside functions) exist so tests can patch. Do not reproduce that unless we have the same test culture.
- **Plugin-compat shims** (`conversation_loop.py` bottom, `COMPAT_MANIFEST.md`) tax every rename. Keep the public surface tiny from day one.
- **Inline tools vs registry** drifted into two dispatch paths; they unified with `INLINE_TOOL_EXECUTORS`. Start with one table.
- **Background review** is the most expensive clever feature: a second agent that must be byte-identical on the cache prefix, persistence-detached, auto-deny, and cancellable. One bug writes review scaffolding into the user’s transcript (they already hit this — `#25322`, curator-takeover comments in `background_review.py`).
- **Product gravity.** A gateway implies pairing, delivery obligations, 25 adapters, and a dashboard. That is a different product than a coding agent.

**Practical v1 shape for RavenClaw:** CLI (maybe a thin TUI) → one `run_conversation` loop with ~8 phases → file+terminal+web tools → skills + bounded memory + SQLite/FTS5 → local (later Docker) backend → one provider abstraction with streaming and a small retry/overflow/empty ladder. Everything else is an edge.

---

## Key files (index)

`run_agent.py` (`AIAgent` facade) · `agent/conversation_loop.py` (`run_conversation`) · `agent/turn_*.py` (phases) · `agent/tool_executor.py`, `inline_tool_executors.py`, `tool_dispatch_helpers.py` · `agent/iteration_budget.py` · `agent/interrupt_control.py` · `agent/empty_response_guard.py`, `turn_empty_response.py`, `turn_overflow.py` · `agent/context_compressor.py`, `compression_facade.py`, `usage_anchor.py` · `agent/prompt_builder.py`, `system_prompt.py`, `prompt_caching.py` · `agent/background_review.py`, `curator.py`, `learn_prompt.py` · `agent/memory_manager.py`, `memory_provider.py` · `agent/subagent_lifecycle.py`, `tools/delegate_tool.py` · `agent/coding_context.py` · `agent/file_safety.py`, `tool_guardrails.py` · `toolsets.py`, `tools/registry.py`, `model_tools.py` · `tools/environments/` · `hermes_state.py` + siblings · `hermes_cli/runtime_provider.py`, `plugins/model-providers/` · `AGENTS.md`, `agent/AGENTS.md` · `website/docs/developer-guide/agent-loop.md`
