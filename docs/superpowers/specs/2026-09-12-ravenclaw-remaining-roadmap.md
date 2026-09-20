# RavenClaw remaining-work roadmap

Date: 2026-09-12  
Status: implemented
HEAD at write: `5629c82`  
Implemented on `main` through Wave 4 in this session.  
Supersedes remaining H1/H2 of `2026-09-12-ravenclaw-roadmap.md`. H0 and harness-honesty (`2026-09-12-ravenclaw-harness-honesty.md`) stay done.

Steal contracts. Do not copy Claude, Hermes, or Freebuff source.

Session-as-job horizon (**implemented** on `main` at `ea56edd`, closeout `0ef1554`): **`2026-09-16-session-as-job-roadmap.md`**. Job-host state (**implemented** on `main` at `6e56764`): **`2026-09-17-job-host-state-roadmap.md`**. Rewind persist-before-reset / `todo.json` projection (**implemented** on `main` at `048deff`): **`2026-09-18-rewind-persist-and-todo-projection.md`**. Cancel abort-pair / reset-on-resume / follow-up persist (**implemented** on `main` at `5eefdde`): **`2026-09-18-cancel-reset-followup.md`**. No-job todo revert (**implemented** on `main` at `be5a4a7`): **`2026-09-18-no-job-todo-revert.md`**. Stream version / `continuationToken` (**implemented** on `main` at `c9c4871`): **`2026-09-18-stream-version-token.md`**. Keep-id `/clear` (**implemented** on `main` at `edeb611`): **`2026-09-18-keep-id-clear.md`**. Parent tree-stop (**implemented** on `main` at `9901d0e`): **`2026-09-18-parent-tree-stop.md`**. Leftover-ask abort-pair completeness + cancel 202/200 (**implemented** this door, not yet on `main`): **`2026-09-20-leftover-ask-abort-pair.md`**. Previous (implemented): `2026-09-15-eve-inspired-roadmap.md`. Prior-art: [eve-analysis.md](../../research/eve-analysis.md), [y0-analysis.md](../../research/y0-analysis.md).

---

## Where we are

The coding-agent waist is shipped:

- One `queryLoop`. Hosts call `submitMessage`. Persist-before-execute. Pairing. No `bypass`.
- `dontAsk` ≠ leftover-allow-all. Fetch/AskUser leftover-deny. In-tree Edit/Write/ApplyPatch may promote.
- Frozen tool prefix + `ToolCall` unwrap. Skill jail is execute-only.
- Durable mailbox + session locks. Children go through `SessionEngine`.
- H1.1–H1.3, H1.7 (subdir AGENTS.md, verify-on-stop, coding posture, stall) are in.

Waves 1–4 are on `main`. Eve-inspired horizon is implemented. Session-as-job horizon is implemented (`ea56edd`, closeout `0ef1554`): **`2026-09-16-session-as-job-roadmap.md`**. Job-host state is implemented (`6e56764`): **`2026-09-17-job-host-state-roadmap.md`**. Rewind persist-before-reset / `todo.json` projection is implemented (`048deff`): **`2026-09-18-rewind-persist-and-todo-projection.md`**. Cancel abort-pair / reset-on-resume / follow-up persist is implemented (`5eefdde`): **`2026-09-18-cancel-reset-followup.md`**. No-job todo revert is implemented (`be5a4a7`): **`2026-09-18-no-job-todo-revert.md`**. Stream version / `continuationToken` is implemented (`c9c4871`): **`2026-09-18-stream-version-token.md`**. Keep-id `/clear` is implemented (`edeb611`): **`2026-09-18-keep-id-clear.md`**. Parent tree-stop is implemented (`9901d0e`): **`2026-09-18-parent-tree-stop.md`**. Leftover-ask abort-pair completeness + cancel 202/200 is implemented this door (not yet on `main`): **`2026-09-20-leftover-ask-abort-pair.md`**.

---

## Constraints (unchanged)

1. One `queryLoop`. Every host (Ink, OpenTUI, exec, ACP, serve, Slack, Discord, GH Action) only calls `submitMessage`.
2. Default prefix stays small and frozen. New tools are `isEnabled`, deferred (`ToolSearch`/`ToolCall`), or a skill — not a new always-on schema unless this doc says so.
3. `dontAsk` never becomes `bypass`. Headless Bash needs a project rule or Docker backend.
4. BYOK is the product. Ads never touch BYOK. Included resume stays fail-closed.
5. Clean-room. Steal semantics. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo.

---

## Do not build (still)

- `bypass` / auto-allow classifier / `execute_code`
- Telegram and any third chat network (Slack and Discord + pairing + delivery ledger already shipped; see `2026-09-12-ravenclaw-discord-pairing-ledger.md`)
- Electron, pets, voice, marketplace, computer-use
- Streaming tool executor, background skill curator, real LSP handshake
- Pro = no ads
- Copying vendor modules

---

## Waves

Do the waves in order. Inside a wave, slices in the same box may run in parallel (disjoint files). Do not start Wave 3 Slack before Wave 2 chrome. Do not start Wave 4 publish before Wave 1 tools exist.

```
Wave 1  daily quality + honesty leftovers
Wave 2  Ink chrome (H2.3)
Wave 3  hosts (ACP ask, Slack, mailbox wake)
Wave 4  ship (npm/brew, GH Action, log rotate)
```

---

## Wave 1 — Daily quality

Goal: a 2-hour BYOK session is cheaper and more honest. No new host.

### R1.1 Cache-safe mid-turn inject

**Why.** Hermes: mid-turn extras go on the newest tool result. RavenClaw currently persists synthetic **user** rows for empty, truncate, verify-on-stop, schema, and `/steer`. That breaks the stable prefix and role-alternation hygiene.

**Contract.**

- Add `injectMidTurnHint(messages, text)` (or reuse `injectMidTurn` in `packages/core/src/prompt/cache.ts`) as the only writer of mid-turn hints.
- Prefer suffix on the last `role: 'tool'` text block. If there is no tool row, suffix the last assistant text block. Only if neither exists, persist a user row (empty-completion with no prior tools).
- Use this path for: empty nudge, truncation nudge, verify-on-stop, structured-output nudge, steering (`injectSteering`).
- Do **not** invent a second user message in the middle of a tool trajectory when a tool row exists.
- Persist the mutated tool/assistant row (`persistToolResults` / rewrite last assistant) so resume sees the hint.

**Files.** `packages/core/src/loop/phases.ts`, `packages/core/src/prompt/cache.ts`, `query-loop.test.ts`, `session-engine` steer tests.

**Done when.** A turn with tools + empty completion does not add a user row; the last tool text contains the nudge. Pairing still 1:1.

### R1.2 Empty ladder matches the 09-08 spec

**Why.** Spec: up to 3 empty retries; drop to 1 if estimated input > $0.25; 2 consecutive identical empties stop.

**Contract.**

- `emptyNudges` cap becomes 3 (was 2).
- If `estimateTokens(request) * input price > 0.25`, cap is 1.
- If two consecutive empty completions have the same (empty) shape, stop without a third nudge.
- Still no Hermes $ ladders beyond this.

**Files.** `packages/core/src/loop/phases.ts`, `query-loop.test.ts`, `packages/core/src/cost/`.

### R1.3 Prefix diet (no new tools)

**Why.** Freeze exists; the frozen set is still large. Overnight cost is schemas.

**Contract.** Default wire after `isEnabled` in a typical git repo, no cron/lsp.json, no MCP:

Always: Read, Grep, Glob, ListDir, ReadSubtree, Edit, Write, ApplyPatch, NotebookEdit, Bash, Skill, TodoWrite, TaskOutput, TaskStop, SetOutput, AddDir, Enter/ExitPlan, Agent.

Keep but gated (already): LSP, Cron*, Enter/ExitWorktree.

**Move off the default wire** (keep the modules; `isEnabled` false unless config/flag):

- `AskUser` — interactive TUI/ACP-ask only (`isEnabled` when an ask-user host is bound).
- `Fetch`, `WebSearch` — still in the catalog; **defer** like MCP (`ToolSearch`/`ToolCall`) unless `config.tools.network: true`.

Do not put Sleep, ThinkDeeply, SuggestFollowups, Task v2 back.

**Files.** `packages/cli/src/engine.ts` `createRootTools` / `createSessionTools`, `packages/core/src/agent/root.ts`, `packages/cli/src/exec.test.ts`.

**Done when.** `createRootTools` name list in `exec.test.ts` no longer includes Fetch/WebSearch/AskUser as always-on. A session with no MCP still has ToolSearch+ToolCall if network tools are deferred.

### R1.4 SessionSearch tool (H1.4)

**Why.** FTS exists; only humans have `/search`.

**Contract.**

- New tool `SessionSearch` in `packages/core/src/tools/session-search.ts`.
- Input: `{ query: string, limit?: number }` (`limit` default 5, max 20).
- Calls existing `searchMessages` / store FTS. Scope: current `cwd` sessions, exclude the live turn’s in-flight ids if cheap; otherwise whole store filtered by cwd.
- `isReadOnly() === true`. `checkPermissions` allow.
- `isEnabled`: SQLite store with FTS (memory store: tool still works if the store implements search; otherwise `isEnabled` false).
- **Not** on the default prefix if FTS is missing. If FTS exists, it may be always-on (small schema). Prefer always-on — one object schema is cheaper than teaching ToolCall for “what did we do last week.”
- Output: ranked lines `sessionId[:8] messageId[:8] snippet`. No full bodies.

**Files.** `session-search.ts` + test, `createRootTools`, `root.ts`, `packages/core/src/index.ts`.

### R1.5 Memory write tool (H1.5)

**Why.** `/review` is user-triggered append. The agent needs add/replace/remove against MEMORY.md / USER.md. Snapshot stays frozen until next session / `/reload`.

**Contract.**

- New tool `Memory` in `packages/core/src/tools/memory.ts`.
- Input: `{ action: 'add' | 'replace' | 'remove', target: 'agent' | 'user', text: string, match?: string }`.
  - `add`: append a paragraph to MEMORY.md (`target:'agent'`) or USER.md (`target:'user'`). Paths: cwd `.ravenclaw/MEMORY.md` / `USER.md`, creating parents.
  - `replace`: `match` required; replace first exact occurrence; error if missing.
  - `remove`: `match` required; delete first exact occurrence; error if missing.
- After write, if file length > `MEMORY_FILE_CHAR_CAP` (8000), return error **and leave the file unchanged** (no silent truncate on write). Caller must consolidate.
- `isReadOnly() === false`. leftover-ask. `dontAsk` + in-tree path under cwd → promote like Write (same `isAcceptEditsPromote` / dontAsk in-tree rule). Out-of-tree deny.
- Does **not** mutate `buildSystemParts` mid-session. Next `/reload` or next session sees the new snapshot.

**Files.** `memory.ts` + test, `prompt/memory.ts` (export caps), `createRootTools`, `root.ts`.

### R1.6 `/learn` authoring rules (H1.6)

**Why.** Skill index is on every API call. Bad descriptions are paid forever.

**Contract.** Replace `LEARN_PROMPT` in `packages/cli/src/commands.ts` with a prompt that requires:

- `description` ≤ 60 characters (same clip as the index).
- Body is steps + pointers. Long scripts and templates go in `references/` next to `SKILL.md`.
- Do not retype a script that already exists in the repo; link it.
- Do not add a core tool.
- Write under `.ravenclaw/skills/<name>/` or `~/.ravenclaw/skills/<name>/`.

No new tool. Tests: `commands.test.ts` asserts the prompt contains `60`, `references/`, and “do not retype.”

### R1.7 Aux model for compact + title (H1.8)

**Why.** Long sessions should not spend the coding model on summaries.

**Contract.**

- Config:

```yaml
auxiliary:
  compact: anthropic/claude-haiku-4.5   # optional
  title: anthropic/claude-haiku-4.5     # optional
```

- `packages/core/src/config.ts`: `auxiliary?: { compact?: string; title?: string }`.
- Compact LLM path (`compact/summarize.ts`) uses `auxiliary.compact` via a **new** `Provider` built from that model id (same registry as CLI). On any failure (auth, 404, throw): mechanical summary. No BYOK fallback to the live model for compact.
- Session title generation (if any LLM title exists) uses `auxiliary.title` the same way; else keep the first-line title (`session-engine.ts` `titleFromUserText`).
- Included sessions: aux must be the same funding/provider as the session or skip to mechanical. Do not open a BYOK client on an included session.

**Files.** `config.ts`, `summarize.ts`, CLI `engine.ts` (pass aux provider into compact policy or session engine), tests with a fake provider that must not be called when aux throws.

### R1.8 Cron timeout / skip_memory / pre-script (H1.9)

**Why.** Coding jobs, not a scheduler museum. Fire already opens a **new** `dontAsk` session (no live-transcript splice). Keep that.

**Contract.** Extend `CronJob` in `packages/core/src/schedule/types.ts`:

```ts
timeoutMs?: number          // default 600_000 (10 min); min 15_000; max 3_600_000
skipMemory?: boolean        // default false; if true, engine bare memory / buildSystemParts({ bare: true }) except the job prompt
preScript?: string          // optional local shell, 30s, no network assumed; failure → lastStatus 'error', do not start the agent
```

- `cron-fire.ts`: `AbortSignal` / `engine.abort()` when `timeoutMs` elapses. Persist `lastError: 'timeout'`.
- `preScript` runs via the same terminal backend as Bash, persist nothing into the child session. Non-zero exit skips the model.
- Slash / `jobs.json` accept the new fields. Unknown old jobs stay valid (defaults).
- Still never splice into a live TUI transcript.

**Files.** `schedule/types.ts`, store JSON schema, `cron-fire.ts`, `cron.test.ts`, `docs` cron section if any.

### R1.9 Cheap specialist model pin

**Why.** File-finder and command-runner do not need the parent coding model. Included children stay pinned to the parent (anti-escalate).

**Contract.**

- Config `specialistModel?: string` (optional).
- `resolveChildModel`: if `funding === 'included'` → parent model (unchanged). Else `definition.model ?? config.specialistModel ?? parent.model`.
- Set `file-finder` and `command-runner` `model` only if we want a code default; prefer config-only so BYOK users opt in.
- Test: BYOK + `specialistModel: 'ollama/qwen'` → file-finder request model is that id. Included → parent.

**Files.** `agent/definition.ts`, `config.ts`, `tools/agent.ts` (pass config model into resolve), `agent.test.ts`.

### R1.10 Headless verify-on-stop (opt-in)

**Why.** Overnight `exec`/`cron` can stop after edits with no test. Default-on for headless would surprise CI.

**Contract.**

- Flag `--verify-on-stop` / config `verifyOnStop?: boolean`.
- Headless default **false**. TUI default **true** (already).
- Cron job may set `verifyOnStop?: boolean` (default false).
- Same nudge ≤2; loop still does not run tests.

**Files.** `cli/src/args.ts`, `engine.ts`, `cron-fire.ts`, `headless.md`.

### R1.11 Ads: view-ack + accidental click (included only)

**Why.** Freebuff steal list: ack on view; <300ms labelled not dropped. Library exists (`classifyClick`); CLI does not use it.

**Contract.**

- `packages/ads`: `acknowledgeFirstPartyView(url, { attempts: 3, timeoutMs: 2000 })` — POST, ignore body, never throw into the TUI.
- Ink `ad-dock.tsx`: call ack on mount (dedupe by creative id). OSC click <300ms still billed but labelled `accidental` in the ack payload if the feed accepts it; if the feed has no click endpoint, skip.
- BYOK: still no dock, no ack.

**Files.** `packages/ads/src/client.ts`, `ad-dock.tsx`, ads tests.

**Wave 1 parallel boxes.**

| Box | Slices | Owns |
|---|---|---|
| A | R1.1 + R1.2 | `phases.ts`, `cache.ts` |
| B | R1.3 + R1.4 + R1.5 | `engine.ts` tools, new tool files |
| C | R1.6 + R1.7 + R1.9 | `commands.ts`, `config.ts`, `summarize.ts`, `definition.ts` |
| D | R1.8 + R1.10 | cron + args |
| E | R1.11 | `packages/ads`, `ad-dock.tsx` |

---

## Wave 2 — Ink chrome (H2.3)

Goal: a full workday in Ink without missing todos or child progress. OpenTUI stays a line view.

### R2.1 Todo panel

- Read `.ravenclaw/todo.json` (existing `TodoWrite` format) after each tool_result named `TodoWrite` and on resume.
- Ink right or bottom panel: id, status, subject. Empty → hide.
- Do not put the checklist in the transcript twice.

**Files.** `packages/core/src/tools/todo.ts` (export load), `packages/cli/src/app.tsx`, new `todo-panel.tsx`.

### R2.2 Collapse Read/Grep/Glob (already dimmed)

- Keep one-line collapsed rows (already `COMPACT_TOOLS`).
- Add expand on focus / click / `Ctrl+O` for the selected tool row (full result text, clipped 2k).
- Bash stays expanded (progress matters).

**Files.** `transcript.tsx`, `app.tsx`.

### R2.3 Child-agent tree

- When `Agent` runs, show a one-line child: `agent <id[:8]> <status> <description>`.
- Background: poll `engine.tasks.list()` (already used by `/tasks`).
- Parallel `agents[]`: one line per child.
- No Freebuff `Ctrl+T` grid. No nested trees (depth 1).

**Files.** `app.tsx`, `tasks/registry.ts` (if a snapshot field is missing, add `description` only).

### R2.4 Compact warning

- When `shouldAutocompact` is within 2k tokens of the trigger (or last assemble usage ≥ 80% of window − reserve), status line shows `compact soon`.
- After a compact event, keep the existing transcript compact row.

**Files.** `status-line.ts`, `app.tsx`, `compact/policy.ts` (export a `nearCompact` helper).

**Done when.** A reviewer can use Ink for a real session and see todos, collapsed reads, child lines, and a compact warning without new core tools.

---

## Wave 3 — Hosts

One honest host at a time. Slack is **one** adapter, not a gateway product.

### R3.1 ACP ask + session/new (H2.1)

**Contract.**

- `packages/acp`: `session/new` accepts `cwd?`, `mcpServers?`, `model?`. Factory must receive them. CLI `acp-stdio.ts` calls `openEngine` with that cwd and those MCP servers (same load path as CLI).
- `promptCapabilities.image: true` if the existing image-paste path can attach a user image block; otherwise stay false and document it. Do not fake images.
- Permission: when `permission_ask` fires, emit an ACP request the editor can answer (`allow` / `deny` / `allow_always`). **Do not** force `dontAsk` for interactive ACP. Default ACP permission mode: `default`. Headless ACP flag `--dont-ask` remains.
- Timeout with no editor answer: deny (pairing holds).
- Honor `session/load` with the existing `loadEngine` hook (already typed).

**Files.** `packages/acp/src/{server,protocol}.ts`, `packages/cli/src/acp-stdio.ts`, ACP tests.

### R3.2 Slack Socket Mode (H2.2)

**Contract.** One adapter. No Discord. No pairing CLI in v1 of this wave (allowlist only). *(v1 of this wave; Discord + pairing + ledger shipped later in `2026-09-12-ravenclaw-discord-pairing-ledger.md`.)*

- New optional dependency / thin module under `packages/cli/src/slack/` or `packages/gateway/src/slack.ts`.
- Config:

```yaml
slack:
  enabled: false
  appToken: $SLACK_APP_TOKEN      # xapp- Socket Mode
  botToken: $SLACK_BOT_TOKEN      # xoxb-
  allowFrom: []                   # Slack user ids; empty → deny all
  channels: []                    # public/private channel ids; empty → DMs only
  mentionOnly: true
```

- Inbound → `InboundEvent` already sketched in `2026-09-12-ravenclaw-gateway-and-parallel-agents.md`.
- Session key: `raven:slack:{team}:{channel}[:thread]`. DMs per user. Channels shared per thread.
- Durable map: `~/.ravenclaw/gateway/sessions.json` (reuse `session-map.ts`).
- **Always** `submitMessage`. Persist-before-execute unchanged.
- Permission mode: `dontAsk` in channels (unattended). DMs may use `default` and post an Allow/Deny prompt; no answer in 120s → deny.
- Tool pool: same as `raven exec` default (or `--tools-preset write` + Bash only with project rules). No self-grant.
- Streaming: send a stub message, then `chat.update`. If update fails, send a new message.
- Process: `raven slack` long-lived, takes a session lock per mapped session id, same mailbox/lock as serve.

**Files.** gateway session-map, new slack adapter, `cli/src/index.ts` command, tests with a fake Slack socket.

### R3.3 Mailbox wake on `raven serve`

**Why.** Mail is durable; serve/exec do not poll. Overnight children finish silently.

**Contract.**

- `serve.ts`: every 15s `peekAgentMail` per live engine; if nonempty, `submitMessage('[mailbox]')` under the existing `singleFlight`.
- Do **not** add a poller to one-shot `exec`.
- Cron remains a fresh session (no parent mailbox).

**Files.** `packages/cli/src/serve.ts`, `serve.test.ts`.

---

## Wave 4 — Ship

### R4.1 Install path (H2.4)

- Publish `@ravenclaw/cli` as `raven` (or keep the name `ravenclaw` if `raven` is taken — check npm at implement time; prefer `raven` as the bin, package `@ravenclaw/cli`).
- `packages/cli/package.json`: remove `"private": true` only for the CLI package that users install; workspace root may stay private.
- GitHub Actions `release.yml`: on tag `v*`, `bun publish` / npm with provenance if available.
- Optional Homebrew formula in a later PR (`brew tap`); not blocking.
- Nightly: workflow `cron: '0 7 * * *'` that runs `bun test` on `packages/core` + `packages/cli` targeted suites (never full-repo `bun test` — Docker hang). Optional live smoke job **manual** (`workflow_dispatch`) with a repo secret; default nightly is unit-only.

### R4.2 GitHub Action (H2.5)

- New repo path `.github/actions/raven-exec/action.yml` **or** a tiny composite in this repo that:
  - assumes `raven` is installed (setup-bun + `bun install -g` from the tag),
  - runs `raven exec --json --dont-ask --tools-preset ci` with `RAVENCLAW_HOME` in the runner workspace,
  - requires the caller to provide `.ravenclaw/permissions.json` (document a `bun test` allow rule),
  - fails the step on nonzero / `model_error`.
- Does **not** pass `bypass`. Does **not** default-allow all Bash.
- README snippet for consumers.

### R4.3 Rotating log (09-08 leftover)

- Writer: `packages/core/src/log.ts`. Path `$RAVENCLAW_HOME/logs/ravenclaw.log`. Rotate at 5 MB, keep 3 files.
- Log: session id, round end reason, persist errors, MCP load errors. No prompt bodies. No tool outputs.
- CLI opens it at boot. Failure to write is silent.

---

## File map (new / hot)

| Path | Wave |
|---|---|
| `packages/core/src/loop/phases.ts` | 1.1, 1.2 |
| `packages/core/src/prompt/cache.ts` | 1.1 |
| `packages/cli/src/engine.ts` | 1.3, 1.4, 1.5, 1.7 |
| `packages/core/src/tools/session-search.ts` | 1.4 |
| `packages/core/src/tools/memory.ts` | 1.5 |
| `packages/cli/src/commands.ts` | 1.6 |
| `packages/core/src/config.ts` | 1.7, 1.8, 1.9, 3.2 |
| `packages/core/src/compact/summarize.ts` | 1.7 |
| `packages/core/src/schedule/types.ts` + `cli/src/cron-fire.ts` | 1.8, 1.10 |
| `packages/core/src/agent/definition.ts` | 1.9 |
| `packages/ads/src/*` + `cli/src/ad-dock.tsx` | 1.11 |
| `packages/cli/src/{app,transcript,todo-panel,status-line}.tsx` | 2.* |
| `packages/acp/src/*` + `cli/src/acp-stdio.ts` | 3.1 |
| `packages/cli/src/slack/*` or `packages/gateway/` | 3.2 |
| `packages/cli/src/serve.ts` | 3.3 |
| `packages/cli/package.json`, `.github/workflows/*` | 4.* |
| `packages/core/src/log.ts` | 4.3 |

---

## Success checks

A slice that does not move one of these is out of scope (H3).

1. A 2-hour monorepo session does not `context_full` from schemas alone (R1.3 + R1.1).
2. Kill mid-Bash; `/resume` never re-runs the command (already true; R1.1 must not break pairing).
3. `raven exec` with a project rule runs `bun test` and cannot `curl | sh` (already true; R4.2 wraps it).
4. Ollama empty reply retries up to the spec ladder (R1.2).
5. Ink shows todos, child lines, and a compact warning for a full workday (R2.*).
6. ACP in an editor can ask before a leftover Bash (R3.1).
7. One Slack workspace can `@mention` the bot and get a `dontAsk` coding turn without a public URL (R3.2).
8. `npm i -g @ravenclaw/cli` (or the chosen name) runs `raven --help` (R4.1).

---

## Suggested implementation order (first four PRs)

1. **R1.1 + R1.2** (cache inject + empty ladder) — one PR, `phases.ts`.
2. **R1.3 + R1.4 + R1.5** — prefix diet + two small tools.
3. **R1.6 + R1.7 + R1.8 + R1.9 + R1.10** — config/prompt/cron.
4. **R2.1–R2.4** — Ink chrome.

Then R3.1, then R3.2+R3.3, then Wave 4. R1.11 can ride with any included-session PR.

---

## Out of this closeout

`execute_code`, Electron, streaming executor, curator, real LSP handshake. Slack/Discord + pairing + ledger already shipped. Eve-style durable HITL is implemented (`2026-09-15-eve-inspired-roadmap.md`). Session-as-job F3 (reconnect + cancel) is implemented. Job-host state is implemented (`2026-09-17-job-host-state-roadmap.md` at `6e56764`). Rewind persist-before-reset is implemented (`2026-09-18-rewind-persist-and-todo-projection.md` at `048deff`). Cancel abort-pair / reset-on-resume / follow-up persist is implemented (`2026-09-18-cancel-reset-followup.md` at `5eefdde`). No-job todo revert is implemented (`2026-09-18-no-job-todo-revert.md` at `be5a4a7`). Stream `version` / `continuationToken` is amended by `2026-09-18-stream-version-token.md`. If a later product wants a browser, it still implements G0–G3 on the existing F3 stream. Do not extend this file.
