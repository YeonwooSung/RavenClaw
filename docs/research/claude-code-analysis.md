# Claude Code v2.1.88 — Architectural Patterns for RavenClaw

**Source:** recovered tree at `/Users/yeonwoosung/Desktop/claude-code-source-code-v2.1.88`  
**Scope:** agent-loop semantics only. No source, prompts, brand, or proprietary strings are copied here.  
**Note:** `src/types/message.ts` and `src/query/transitions.ts` are imported throughout but missing from this snapshot. Message and terminal types below are reconstructed from call sites.

---

## 1. The query / turn loop

Claude Code splits “own the conversation” from “run one agentic turn.”

| Layer | File | Role |
|---|---|---|
| Session owner | `src/QueryEngine.ts` (`QueryEngine`) | One instance per conversation. Holds `mutableMessages`, abort controller, usage, permission denials, file-read cache. `submitMessage()` is one user turn. |
| Turn loop | `src/query.ts` (`query` → `queryLoop`) | Infinite `while (true)` async generator. Yields stream events / messages; returns a terminal reason. |
| Model I/O | `src/services/api/claude.ts` (`queryModelWithStreaming`) | Anthropic streaming (with non-streaming fallback). |
| Tool run | `src/services/tools/toolOrchestration.ts`, `StreamingToolExecutor.ts`, `toolExecution.ts` | Validate → hooks → permission → execute → map to `tool_result`. |

`QueryEngine.submitMessage` (SDK/headless): process user input → persist the user message *before* the API call (so resume works if the process dies) → `yield*` `query()` → map to SDK events. The REPL consumes the same generator via Ink.

### 1.1 State machine

Each `queryLoop` iteration is one model round. Cross-iteration state lives in a single `State` object (messages, `toolUseContext`, compact tracking, turn count, recovery counters, pending tool-use summary, last transition).

```
start iteration
  yield stream_request_start
  slice history after last compact boundary
  apply tool-result budget  →  snip  →  microcompact  →  context-collapse  →  autocompact
  if over hard blocking limit (and autocompact off): return blocking_limit
  stream model
    on assistant + tool_use: collect blocks, optionally start StreamingToolExecutor
    on withheld 413 / max_output_tokens / media error: hold until recovery known
  if abort: synthesize missing tool_results, return aborted_streaming
  if no tool_use:
    try recoveries (collapse drain → reactive compact → escalate max_tokens → resume nudge)
    run Stop hooks
    optional token-budget continuation
    return completed | prompt_too_long | stop_hook_prevented | …
  execute remaining tools (or drain streaming executor)
  if abort mid-tools: return aborted_tools
  if hook preventContinuation: return hook_stopped
  inject attachments (queue, memory prefetch, skill discovery)
  refresh MCP tool pool
  if nextTurnCount > maxTurns: return max_turns
  state = { messages + assistant + toolResults, turnCount+1, transition: next_turn }
  continue
```

`stop_reason === 'tool_use'` is **not** trusted. The loop’s only “keep going” signal is “we observed at least one `tool_use` block while streaming.”

### 1.2 Streaming events

`query()` yields a tagged union (from usage in `query.ts` / `QueryEngine.ts`):

- `stream_request_start` — new API request starting (UI spinner / SDK status).
- `stream_event` — raw Anthropic events: `message_start`, `content_block_*`, `message_delta`, `message_stop`. Usage and `stop_reason` arrive on `message_delta`; assistant messages are often yielded earlier with `stop_reason: null`.
- `assistant` — one message per content block (text, thinking, tool_use). SDK consumers optionally also get partial `stream_event`s.
- `user` — tool results and synthetic user/meta messages.
- `progress` — live tool/hook progress (bash output, agent child tools).
- `attachment` — mid-turn side channel (queue drain, memory, skills, `max_turns_reached`, hook stop).
- `system` — compact/snip/microcompact boundaries, model-fallback warnings.
- `tombstone` — retract a previously yielded assistant message (streaming fallback / invalid thinking signatures).
- `tool_use_summary` — optional one-liner for the previous tool batch (generated during the *next* stream).

Thinking cannot be last in a trajectory; it must survive `tool_use` → `tool_result` → next assistant; it is stripped on fallback to a model that does not support it.

### 1.3 Tool-use collect → validate → execute

1. **Collect** `tool_use` blocks (IDs pair later results). Unknown name → error result (alias fallback for renames).
2. **Zod `safeParse`.** Failure → `InputValidationError`. Deferred tools that were never `ToolSearch`ed get a `select:<name>` hint.
3. **`validateInput`** (paths, empty edits).
4. **PreToolUse** — allow / deny / rewrite / inject / `preventContinuation`.
5. **`canUseTool`** (§2). Deny still emits a `tool_result` (pairing invariant).
6. **`tool.call`** — progress + optional `contextModifier` (serial only).
7. **PostToolUse / PostToolUseFailure.**
8. **Map** via `mapToolResultToToolResultBlockParam`. Huge results persist to disk (`maxResultSizeChars`; Read is exempt).

**Parallel vs serial** (`partitionToolCalls`): concurrent only if parse succeeds **and** `isConcurrencySafe(input)` (exceptions → serial). Consecutive safe calls batch together (default cap 10). Unsafe tools run alone, in order. Gated `StreamingToolExecutor` starts tools as they arrive but **emits in arrival order**. A Bash error aborts sibling Bash via a child controller without ending the turn.

Every `tool_use` must get a `tool_result` (`yieldMissingToolResultBlocks`) even on abort/fallback/throw.

### 1.4 Stop, abort, retry

**Terminal reasons:** `completed` (no tool_use, or non-recoverable API error — Stop hooks skipped on errors to avoid a death spiral), `max_turns`, `aborted_streaming`, `aborted_tools`, `hook_stopped`, `stop_hook_prevented`, `blocking_limit` (full context, autocompact off), `prompt_too_long`, `image_error`, `model_error`.

**Same-call continues:** `next_turn`, `collapse_drain_retry`, `reactive_compact_retry`, `max_output_tokens_escalate` (retry at 64k), `max_output_tokens_recovery` (≤3 resume nudges), `stop_hook_blocking`, `token_budget_continuation` (~90% of turn budget or diminishing returns).

**Abort.** Shared `AbortController`. REPL `CancelRequestHandler` binds Escape (`chat:cancel`): first press cancels the turn; second within 3s can kill background agents. Reason `'interrupt'` skips the synthetic interrupt message when a queued prompt follows. Tools declare `interruptBehavior(): 'cancel' | 'block'` (default block).

**API retry** (`withRetry.ts`): 10 tries, 500ms base. HTTP 529 only for foreground sources (REPL, SDK, agents, compact, hooks). Stream failure → non-streaming fallback → `fallbackModel`. Partial assistants from the failed attempt are tombstoned.

---

## 2. Permission / safety model

Modes (`src/types/permissions.ts`, `src/utils/permissions/PermissionMode.ts`):

| Mode | Semantics |
|---|---|
| `default` | Ask unless an allow rule or `checkPermissions` allows. |
| `acceptEdits` | Auto-allow in-tree file edits; still ask for bash / out-of-tree / dangerous paths. |
| `plan` | Read-only + plan file. Mutating tools blocked until `ExitPlanMode`. Prior mode in `prePlanMode`. |
| `bypassPermissions` | Allow all except deny rules, content-specific ask rules, and safety checks (`.git/`, `.claude/`, shell rc). |
| `dontAsk` | Leftover `ask` → `deny` (headless). |
| `auto` | Internal classifier instead of a prompt. Not an external/SDK mode. |

Shift+Tab (`getNextPermissionMode`): `default → acceptEdits → plan → [bypass] → default`.

**Gate** (`hasPermissionsToUseToolInner`): (1) blanket deny (also strips the tool from the pool), (2) blanket ask (unless sandboxed Bash auto-allows), (3) `tool.checkPermissions`, (4) deny / `requiresUserInteraction` / content-ask / `safetyCheck` are **bypass-immune**, (5) bypass mode → allow, (6) blanket allow → allow, (7) `passthrough` → `ask`, (8) `dontAsk` / `auto` rewrite leftover asks.

Reasons: `rule`, `mode`, `hook`, `classifier`, `safetyCheck`, `subcommandResults`, `permissionPromptTool`, `asyncAgent`, `sandboxOverride`, `workingDir`. Rules persist to user / project / local / session / CLI.

`useCanUseTool` is the REPL wrapper: allow short-circuits; deny records; ask goes coordinator → swarm-worker → optional bash classifier (~2s) → dialog. Background agents set `shouldAvoidPermissionPrompts` so leftover asks become denies.

**Sandbox / writes:** Bash may run in `SandboxManager` and auto-allow when sandboxed. File tools check path-in-workdir, deny sensitive trees, treat overwrite as destructive. Plan mode refuses mutating tools until exit.

---

## 3. Tools

Registry: `src/tools.ts` (`getAllBaseTools` → `getTools` → `assembleToolPool`). Built-ins are sorted as a contiguous prefix (prompt-cache breakpoint); MCP tools are appended, also sorted; built-in names win on collision. Each tool’s `isEnabled()` is the last filter. `--tools default` is the only preset.

### 3.1 Built-in inventory

Core: `Agent` (alias `Task`, spawn subagent), `TaskOutput`, `TaskStop`, `Bash`, `Read` (self-bounded; never disk-persisted as a result), `Edit` (exact-string replace; needs a prior Read), `Write` (create/overwrite), `NotebookEdit`, `Grep`/`Glob` (dropped if the binary embeds faster search), `WebFetch`/`WebSearch`, `TodoWrite` (session checklist, UI panel), `Skill`, `EnterPlanMode`/`ExitPlanMode`, `AskUserQuestion`, `SendMessage`, `ListMcpResources`/`ReadMcpResource`.

Conditional: `TaskCreate`/`Get`/`Update`/`List` (todo v2), `ToolSearch` (deferred tools), `StructuredOutput` (SDK `jsonSchema`), `LSP`, `EnterWorktree`/`ExitWorktree`, `PowerShell`, `TeamCreate`/`Delete`, `CronCreate`/`Delete`/`List`, `Sleep`, `WorkflowTool`, `Config`.

Skip-for-v1 (see §8): `REPL`, `Tungsten`, `WebBrowser`, `Monitor`, `RemoteTrigger`, `SendUserFile`, `SendUserMessage`/`Brief`, `Snip`, `TerminalCapture`, `VerifyPlanExecution`, Chrome / computer-use.

### 3.2 How a turn’s tool pool is chosen

1. `getTools(permissionContext)` — built-ins minus denied/disabled/REPL-hidden.
2. MCP tools from connected servers, deny-filtered.
3. Coordinator mode keeps only `Agent`, `TaskStop`, `SendMessage`, `StructuredOutput` (+ PR-subscribe MCP).
4. Subagents: `resolveAgentTools` / `filterToolsForAgent` — custom agents cannot spawn Agent/TaskOutput/plan/AskUser; async agents get a fixed allow-list (Read/Grep/Glob/Bash/Edit/Write/…).
5. Mid-turn `refreshTools()` picks up late MCP connects.
6. Large pools send most tools with `defer_loading`; `ToolSearch` first. `alwaysLoad` keeps a tool in request 1.

Read/Grep/Glob are concurrency-safe and collapse in the UI. Edit is a surgical already-read replace. Write is whole-file overwrite (destructive). Bash is the parsed, optionally sandboxed escape hatch — almost never concurrent when it mutates.

---

## 4. Multi-agent / Task tool

`Agent` (`src/tools/AgentTool/`) is the spawn primitive: `description`, `prompt`, optional `subagent_type`, `model`, `run_in_background`, `isolation` (`worktree` / internal `remote`), `cwd`, teammate `name`/`team_name`/`mode`.

`runAgent` runs a **child** `query()` with its own `agentId`, prompt, tool pool, and frontmatter MCP. `createSubagentContext` clones file-state for prompt-cache sharing; parent `setAppState` is a no-op (session writes go through `setAppStateForTasks`). True-async workers cannot prompt (`shouldAvoidPermissionPrompts`); in-process teammates can. Transcript is a sidechain; resume restores cwd / worktree / replacements.

Built-in types: general-purpose, statusline-setup, explore, plan, product-guide, optional verification. User/plugin agents: `.claude/agents`.

**Coordinator vs worker** (`coordinatorMode.ts`): coordinator has almost no file/shell tools. It spawns via `Agent`, continues via `SendMessage`, stops via `TaskStop`. Worker results arrive as user-role task-notification attachments (internal signals, not conversation partners). Workers get the async-agent tool set + MCP + Skill. Optional scratchpad is a shared prompt-free workspace.

**Isolation:** `worktree` → temp git worktree as cwd; unchanged trees deleted, dirty ones kept. `cwd` is mutually exclusive. Remote isolation is internal.

Parent sees the child’s final assistant text. Coordinator workers also get a ~30s forked 3–5 word progress line (`AgentSummary`) using the same cache prefix with tools denied.

Background `Task` types (`src/Task.ts`): `local_agent`, `remote_agent`, `local_bash`, `in_process_teammate`, `local_workflow`, `monitor_mcp`, `dream`. Status: pending → running → completed | failed | killed.

---

## 5. Memory / project files / skills / hooks

### Memory (`src/utils/claudemd.ts`)

Later files win: managed/policy → user `~/.claude/CLAUDE.md` + rules → project `CLAUDE.md` / `.claude/CLAUDE.md` / `.claude/rules/*.md` (cwd→root, closer wins) → `CLAUDE.local.md`. `@path` includes (text only, cycle-safe). Nested files attach once (`loadedNestedMemoryPaths`). Cap ~40k chars/file.

Auto memory: `MEMORY.md` (`src/memdir/memdir.ts`), 200 lines / 25KB, plus topic files. Session memory: a background forked agent writes a conversation note (`src/services/SessionMemory/`).

### Skills (`src/skills/`)

Sources: managed, user, project `.claude/skills`, plugins, bundled, MCP. Only frontmatter is in the system prompt; the body loads on `Skill` invocation. Skills may declare allowed tools, model, hooks, `inline|fork`, and args. Discovery can prefetch mid-turn.

### Hooks (`HOOK_EVENTS` in `src/entrypoints/sdk/coreTypes.ts`)

Lifecycle: `SessionStart`/`Setup`/`SessionEnd`, `UserPromptSubmit`. Tool: `PreToolUse` (allow/deny/rewrite), `PermissionRequest`/`PermissionDenied`, `PostToolUse`/`PostToolUseFailure`. Turn: `Stop` (may block and force another round), `StopFailure`. Agent: `SubagentStart`/`SubagentStop`, `TeammateIdle`, `TaskCreated`/`TaskCompleted`. Compact: `PreCompact`/`PostCompact`. Workspace: `WorktreeCreate`/`Remove`, `CwdChanged`, `FileChanged`, `InstructionsLoaded`. Other: `Notification`, `Elicitation`/`ElicitationResult`, `ConfigChange`.

Implementations: shell, LLM prompt, HTTP POST, nested agent. Optional `if` uses permission-rule syntax so non-matching tools skip the spawn. `async`/`asyncRewake` run in the background; exit 2 can wake the model.

---

## 6. Compaction

Cheapest first, all **before** the next API call:

1. **Tool-result budget** — huge results → on-disk preview (UUID-keyed for resume).
2. **Snip** (feature) — drop old interior turns; subtract savings from later checks.
3. **Microcompact** — clear stale Read/Grep/Glob/Bash/Web/Edit/Write *results* in place.
4. **Context collapse** (feature) — granular archived spans; REPL keeps full scrollback.
5. **Autocompact** — estimated tokens ≥ effective window − 13k. Effective window = model context − reserved summary (capped 20k). Env/settings can disable. Circuit-breaker: 3 failures. Not run for compact/session-memory forks.
6. **On 413:** collapse drain, then single-shot **reactive compact** (`hasAttemptedReactiveCompact`).

`buildPostCompactMessages`: boundary → summary → preserved tail → attachments → hook results.

Restored (not the raw transcript): summary (images stripped), optional recent tail, ≤5 recently read files (5k each, 50k total; skip if already in the tail), invoked skills (5k/skill, 25k), plan file, MCP/deferred-tool deltas, live agent listing.

Manual `/compact` uses a 3k reserve. The hard **blocking limit** (window − 3k) only fires when autocompact is off.

---

## 7. UX loop details worth copying

- **Streaming tokens.** Render `text_delta` immediately; assistant messages land per block. Spinner text from `getActivityDescription`.
- **Tool progress.** Per-tool progress lines; search/read/list collapse (`isSearchOrReadCommand`). Agent children as a tree (`AgentProgressLine`: last tool, tokens, backgrounded).
- **Plan mode.** Shift+Tab or `EnterPlanMode` → read-only explore → `ExitPlanMode` approval dialog.
- **Todos.** `TodoWrite` is a session checklist in a side panel (not the transcript). Resume hydrates from the last `TodoWrite` in the log.
- **Cost.** `cost-tracker.ts`: tokens, USD, API duration, lines changed. Status line + SDK `result`. Restored with the session.
- **Resume.** JSONL transcript. User message flushed *before* the API call. Compact boundaries carry `preservedSegment` `{head, anchor, tail}` so resume can drop pre-compact history. Also restore cwd, worktree, file-history, replacements, mode, todos, cost.

Also copy: type-ahead command queue (drained as next-round attachments), Escape cancel, always-allow permission persistence, token-warning chrome.

---

## 8. What RavenClaw should steal as semantics

### The v1 agent loop (implementable spec)

A **Turn** is one user submission. It owns an `AbortController` and a message list. Inside the turn, a **Round** is:

1. Optionally compact if over threshold.  
2. Stream the model with the current tool pool.  
3. If aborted: pair every tool_use with an error result; end.  
4. If the assistant has no tool_use: run Stop hooks; end (or retry once if a hook blocks).  
5. Partition tool_use: concurrent-safe batches in parallel (cap N), others serial.  
6. For each call: validate → PreToolUse → permission → execute → PostToolUse → `tool_result`.  
7. Append results (and any mid-turn attachments). If `rounds == maxRounds`, stop. Else go to 1.

Invariants:

- Every `tool_use.id` has exactly one `tool_result`.  
- Permission deny is a `tool_result`, not a thrown exception.  
- History sent to the API is the slice after the last compact boundary.  
- Thinking (if any) is kept for the whole tool trajectory and stripped on model fallback.

### Recommended TypeScript interfaces (original)

```ts
type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypass'
  | 'dontAsk'

interface Turn {
  id: string
  messages: Message[]
  round: number
  maxRounds?: number
  abort: AbortController
  permissionMode: PermissionMode
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

type StreamEvent =
  | { type: 'round_start'; round: number }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_progress'; id: string; text: string }
  | { type: 'tool_result'; id: string; result: ToolResult }
  | { type: 'status'; message: string }
  | { type: 'compact'; summary: string }
  | { type: 'error'; message: string; recoverable: boolean }

interface Tool<I = unknown, O = unknown> {
  name: string
  description: string
  inputSchema: unknown // JSON Schema or Zod
  isConcurrencySafe(input: I): boolean
  isReadOnly(input: I): boolean
  checkPermissions(input: I, ctx: Turn): Promise<PermissionDecision>
  execute(input: I, ctx: Turn, onProgress?: (s: string) => void): Promise<O>
  renderResult?(output: O): string
}

interface ToolResult {
  toolUseId: string
  ok: boolean
  content: string | Array<{ type: 'text' | 'image'; value: string }>
  persistPath?: string
}

type PermissionDecision =
  | { behavior: 'allow'; reason: 'rule' | 'mode' | 'hook' | 'user' }
  | { behavior: 'deny'; reason: 'rule' | 'mode' | 'hook' | 'user' | 'safety'; message: string }
  | { behavior: 'ask'; message: string; saveAs?: 'session' | 'project' | 'user' }

interface CompactPolicy {
  enabled: boolean
  contextWindow: number
  reserveOutputTokens: number
  autoCompactBuffer: number      // e.g. 13_000
  blockingBufferWhenManual: number
  keepRecentFiles: number        // e.g. 5
  maxTokensPerRestoredFile: number
  maxConsecutiveFailures: number
}

type RoundEnd =
  | { reason: 'completed' }
  | { reason: 'max_rounds'; round: number }
  | { reason: 'aborted' }
  | { reason: 'hook_stopped' }
  | { reason: 'context_full' }
  | { reason: 'model_error'; error: unknown }
```

### v1 build order

1. `queryLoop` + pairing invariant + abort.  
2. Read / Grep / Glob / Edit / Write / Bash with the permission pipeline (`default` + `acceptEdits` + `dontAsk`).  
3. Autocompact (summary + recent-file restore).  
4. Streaming UI (text deltas + tool progress lines).  
5. `Agent` as a nested `queryLoop` (no worktree yet).  
6. CLAUDE.md + Skill + Pre/PostToolUse + Stop.  
7. Plan mode, todos, resume transcript, cost.

### Skip for v1

Buddy companion, Grove, Desktop upsell / handoff, Undercover, Tungsten, computer-use / Chrome, Brief / SendUserMessage, cron / kairos / remote triggers, teammate swarms / coordinator mode, REPL-in-VM, WebBrowser panel, Dream / auto-memory extraction, context-collapse / snip / cached-microcompact, yolo `auto` classifier, GrowthBook experiments, Voice, Teleport / remote CCR, plugin marketplace, LSP, workflow scripts. These are product surface, not the loop.

The recovered tree is a reference for **control flow**, not a source to vendor. Re-implement the state machine and interfaces above in RavenClaw’s own types and prompts.
