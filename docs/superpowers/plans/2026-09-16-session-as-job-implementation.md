# Session-as-job — Implementation Plan

> **Archive:** All 15 tasks landed on `main` at `ea56edd`. Do not re-run this plan as greenfield work.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a session own a named git job (shadow branch, opt-in turn-end commit, rewindable checkpoint, optional `/pr`) and make `raven serve` reconnectable and cancel-honest — without a second loop, a web UI, or a Prisma Task table.

**Architecture:** Keep one `queryLoop`. Job metadata hangs on `SessionRecord`, not a Task table. Auto-commit and `/pr` are host epilogues (default off). Todos become session-scoped so compact restore and checkpoints are not a shared cwd file. Serve adds a monotonic `seq` plus `?after=` and a GET snapshot. Cancel is not failure and does not settle a parked leftover-ask.

**Tech Stack:** Bun, TypeScript, SQLite WAL (`applyMigrations`), existing `SessionStore`, `SessionEngine`, `StreamEvent`, `createSessionEventHub`, `enterSessionWorktree`, `gh` (optional).

**Spec:** `docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md`

## Global Constraints

Copied from the spec, plus the rulings this plan locks.

- One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer and does not start a model turn.
- Default prefix stays small and frozen. Job commit / PR are **host epilogues**, not default tools.
- `dontAsk` never becomes `bypass`. y0 isolation-trust is not a permission mode.
- BYOK is the product. Ads never touch BYOK.
- Clean-room. Steal semantics. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**.
- Persist-before-execute and pairing 1:1 stay law.
- Targeted `bun test <file>` only. Never full-repo `bun test`.
- Commits only on a feature branch unless the user says otherwise. Do not implement on `main` without consent.
- Isolated `.worktrees/` + TDD. Run tests from the worktree, not the primary checkout.

### Plan rulings (amend the spec where they disagree)

These are binding for implementers. The spec stays the product authority; these lines resolve underspecification.

1. **Schema bumps are per wave that persists.** F0 does not bump. F1.3 → schema **v7** `sessions.todos_json`. F2 → schema **v8** `sessions.job_json`, `sessions.job_auto_commit INTEGER NOT NULL DEFAULT 0`, `messages.checkpoint_json`. F3.2 → schema **v9** `stream_events`. Pin every `schema_version 6` test when that wave lands.

2. **ACP timeout does not persist deny and does not abort-pair.** `racePermission` timeout throws an error with `name === 'AskWaiterExpired'` (not `AbortError`, not `'deny'`). Do **not** write `answered.set(id, 'deny')` on timeout. `executeOneCall` on `AskWaiterExpired` returns no tool result and does not `pairMissing`. The `pending_asks` row stays. `session/prompt` returns `stopReason: 'cancelled'`. Existing test `timeout with no editor answer denies…` is rewritten.

3. **Last-horizon ruling 10 is amended.** `GET /v1/session/:id/stream?after=<seq>` is in this plan (Task 11). `POST /v1/turn` still has no `?after=`. Crash `/resolve` still pairs only.

4. **`forgetReadsNotInTail(turn, messages)`** after every compact that replaces `turn.messages` (`maybeCompact` and `runCompactNow`). Drop `turn.readFiles` / `readFileMtimes` entries whose latest Read result is missing, stubbed (`[cleared `), or inactivated. Keep mtime this-turn. Do not invent a session-scoped hash map.

5. **F1.2 restore source:** `session.todos` if that array is present (including `[]`); else `loadTodos(cwd)` so this task can land before F1.3. Empty / missing → no note. Same `appendUserNotes` shape as plan.md.

6. **Todos source of truth is `SessionRecord.todos`.** `TodoWrite` writes the session then projects `.ravenclaw/todo.json` (last writer wins the file). Children start with `todos` unset / `[]` and do not inherit. TUI panel reads `session.todos ?? loadTodos(cwd)`.

7. **`SessionJob` is the only job identity:**

```ts
export type SessionJob = {
  baseBranch: string
  shadowBranch: string
  baseCommitSha: string
  worktreePath: string
  prNumber?: number
  prUrl?: string
}

export type JobCheckpoint = {
  commitSha: string
  todoSnapshot: TodoItem[]
  dirty: boolean
}
```

`SessionRecord.job?: SessionJob`. `SessionRecord.jobAutoCommit?: boolean`. Absent job = today’s cwd session.

8. **Named shadow is always `raven/<slug>`.** `git worktree add -b <shadow> <path> <baseSha>` — never `--detach` for a new job. Default slug = first 8 cleaned session-id chars. Explicit `--worktree name` / `EnterWorktree` / `/job <name>` sanitizes to a slug and still prefixes `raven/`. Path stays `.ravenclaw/worktrees/<slug>`. Do not clone. Dirty remove stays report-only.

9. **Auto-commit runs inside `SessionEngine` after `queryLoop` returns**, so every host gets it. Fire only when `end.reason` is `completed` | `hook_stopped` | `max_rounds` | `context_full`, `jobAutoCommit === true`, job record exists, worktree is dirty, and `listPendingAsks` is empty. Skip abort / cancelled / model_error / persist failures. Author is `git config user.name` / `user.email` in the worktree. Message: `raven: turn <turn.id first 8>`. Failure yields `{ type: 'status', message }` and does **not** fail the turn.

10. **Checkpoint hangs on the completing assistant message** as `checkpoint?: JobCheckpoint` (`messages.checkpoint_json`). Job `/rewind` finds the nearest earlier assistant checkpoint, `git reset --hard` **inside the worktree only** to that sha (or `baseCommitSha`), restores that todo snapshot, drops later transcript rows. No file-history blob undo when a job record exists. Sessions without a job keep today’s rewind.

11. **`engine.abort(kind?: 'cancel' | 'interrupt')`.** Default `'interrupt'` → `{ reason: 'aborted' }` (`/steer`). `'cancel'` → `{ reason: 'cancelled' }` (`POST …/cancel`, TUI `/stop`). Parked leftover-ask rows are not denied. If `listPendingAsks` is nonempty after cancel, also yield `{ type: 'status', message: 'cancelled, ask still pending' }`. `round_start` becomes `{ type: 'round_start'; round: number; turnId: string }`. `SessionEngine.liveTurnId(): string | null`. Serve cancel body `{ turnId?: string }`; mismatch → `{ ok: true, status: 'no_active_turn' }` (200). No body cancels the current live turn.

12. **Serve NDJSON is `{ seq: number } & StreamEvent`.** Core `StreamEvent` type is unchanged. Persist at `hub.publish` into `stream_events`. Replays of the same `permission_ask.callId` reuse the same seq. `after` omitted = live tail (today). `after=0` replays from disk. No `?after=` on `/v1/turn`.

13. **`GET /v1/session/:id`** is a new path (no action). `{ id, job?, pendingAsks, lastSeq, permissionMode, live }`. 404 unknown. 401 without Bearer. No create-on-GET.

14. **`/pr` is never a tool and never starts a model turn.** Preconditions: job record, clean worktree, `gh` on PATH and authenticated. Else a notice. Snapshot `{ title, body, url?, sha, files, +, - }` is stored as an annotation on the last assistant message; `prNumber` / `prUrl` update the job record in place.

15. **Stacked child:** `Agent` `isolation: worktree` when the parent has `session.job` cuts from **parent `shadowBranch` (current HEAD)** and writes a child job `{ baseBranch: parent.shadow, shadowBranch: raven/<childSlug>, baseCommitSha: parent HEAD, worktreePath }`. F4.1 on the child targets `child.shadow → parent.shadow`.

16. **Eval path is identity.** Runner stays a one-name switch. No authored `id`. No LLM-as-judge. F0.3 adds `sandbox-cwd` and `compact-memory-prefix`. F4.2 adds `todo-restore`, `cancel-not-fail`, `stream-reconnect`, `job-shadow-branch`. Prefer in-process `createSessionEngine`; serve-loopback only for F3.2 if the in-process seq helper is not enough.

17. **Do not build:** web UI, Next/Prisma/Socket.IO, Shadow wiki, eve compiler / memory slots / `defineState`, sandbox network policy, Grep/Glob docker-exec, NotebookEdit docker, Slack HMAC, `ignored`, live `/cancel` abort-pair of a parked leftover-ask.

## File map

| File | Responsibility |
|---|---|
| `ARCHITECTURE.md` / `.ko.md` | schema v6 (then v7–v9 as waves land), session resolve, docker jail, next-horizon pointer |
| `SLASH_COMMANDS.md` / `.ko.md` | `/compact` queues; `/job`, `/pr` |
| `CHANGELOG.md` / `README.md` / `docs/headless.md` | shipped eve-inspired; serve seq / snapshot / cancel |
| `packages/acp/src/server.ts` | timeout → `AskWaiterExpired` |
| `packages/core/src/eval/` | path-identity fixtures |
| `packages/core/src/tools/read-files.ts` | `forgetReadsNotInTail` |
| `packages/core/src/compact/prune.ts` | todos restore-note |
| `packages/core/src/migrations/007_session_todos.sql` | `sessions.todos_json` |
| `packages/core/src/migrations/008_session_job.sql` | job + checkpoint columns |
| `packages/core/src/migrations/009_stream_events.sql` | `stream_events` |
| `packages/core/src/tools/todo.ts` | session-scoped write + cwd projection |
| `packages/core/src/tools/session-worktree.ts` | named `raven/<slug>` branch |
| `packages/core/src/session/job.ts` | `maybeCommitJob`, `rewindToCheckpoint`, `openDraftPr` |
| `packages/core/src/loop/session-engine.ts` | compact forget, auto-commit, abort kind, liveTurnId |
| `packages/cli/src/serve.ts` | seq, `?after=`, GET snapshot, cancel `turnId`, `/pr` |
| `packages/cli/src/slash/dispatch.ts` | `/job`, `/pr` |
| `packages/core/src/tools/agent.ts` / `worktree.ts` | stacked child base = parent shadow |

## Wave order

Do not start F2 before F1.3 is green (checkpoints need the session todo list). Do not start F3.2 before F3.1 (cancel reason is a stream fact). F4.2 last locks the wave.

```
Task 1  F0.1 docs
Task 2  F0.2 ACP waiter
Task 3  F0.3 eval gates
Task 4  F1.1 forgetReadsNotInTail
Task 5  F1.2 todos restore-note
Task 6  F1.3 session todos (v7)
Task 7  F2.1+F2.2 job + named shadow (v8)
Task 8  F2.3 opt-in auto-commit
Task 9  F2.4 checkpoint rewind
Task 10 F3.1 cancel ≠ fail
Task 11 F3.2 seq + ?after= (v9)
Task 12 F3.3 GET snapshot
Task 13 F4.1 optional /pr
Task 14 F4.3 stacked child
Task 15 F4.2 eval lock
```

---

### Task 1: Docs match the shipped waist (F0.1)

**Files:**
- Modify: `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`, `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md`, `CHANGELOG.md`, `README.md`, `docs/headless.md`, `docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md`, `docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md`
- Test: none (docs-only). Verify with the grep commands in Step 4.

**Interfaces:**
- Consumes: tree at `d4c73d4` (schema v6, session routes, leftover-ask)
- Produces: a reader of `ARCHITECTURE.md` can name schema v6 and `POST /v1/session/:id/resolve` without opening `serve.ts`

- [ ] **Step 1: Patch `ARCHITECTURE.md` sessions + serve**

Replace the sessions header (currently “Schema version 4” and a table that stops at v4) with:

```markdown
SQLite WAL at `$RAVENCLAW_HOME/state.db` (`PRAGMA journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON` in `packages/core/src/session/sqlite-store.ts`). Schema version **6**:

| Version | File | Adds |
|---|---|---|
| 1 | `migrations/001_init.sql` | `meta`, `sessions`, `messages`, `compact_boundaries`, `permission_rules` |
| 2 | `002_fts5.sql` | `messages_fts` FTS5 — **always applied**, fail-open on query |
| 3 | `003_agent_mail.sql` | `agent_mail` mailbox + `session_locks` |
| 4 | `004_deliveries.sql` | inbound delivery ledger |
| 5 | `005_pending_asks.sql` | `pending_asks` (one row per `call_id`) |
| 6 | `006_read_mtime.sql` | `messages.read_mtime_ms` |

`applyAskAnswer(callId, allow|deny|allow_always)` is the only non-`submitMessage` host entry. It pairs a parked leftover-ask and does not start a model turn. `resumeSession` treats pending `callId`s as paired-for-resume.
```

Under `raven serve`, after the `/v1/turn` bullet, add the live session routes:

```markdown
- `GET  /v1/session/:id/stream` — NDJSON live tail of `StreamEvent` (Bearer). Closing the stream is detach, not cancel.
- `POST /v1/session/:id/submit` — `{ text }` → `submitMessage({ text, turnPolicy: 'queue' })`, **202** `{ accepted, sessionId }`. Missing sessions are created with the **default** permission mode (not `dontAsk`).
- `POST /v1/session/:id/resolve` — `{ callId, allow }` settles a live waiter first, else `applyAskAnswer`. Crash-resolve **pairs only**.
- `POST /v1/session/:id/cancel` — `engine.abort()`; parked leftover-ask rows stay.
- `POST /v1/session/:id/compact` — `compactNow()` (queues if `liveTurn !== null`).
- `POST /v1/turn` stays dontAsk one-shot. Opening a session via `/v1/turn` first stamps `dontAsk`, so leftover-ask on that session is deny.
```

Under `raven acp`, replace “Permission timeout 120s” with: timeout stops the in-process waiter and **does not persist deny** (same law as Slack/Discord durable rows). Under `raven discord`, replace “DMs wait 120s then deny” with: durable DMs do **not** timer-deny; the `pending_asks` row remains.

Same edits in `ARCHITECTURE.ko.md`.

- [ ] **Step 2: Patch slash + changelog + spec pointers**

`SLASH_COMMANDS.md` behavior table: change `` `/compact` mid-turn | Compacts `liveTurn.messages` if a turn is live `` to `` `/compact` mid-turn | sets a one-slot flag; runs after `liveTurn` is null ``. In the `/compact` section, state that `compactNow` while `liveTurn !== null` **queues** and does not splice the live transcript. Same in `.ko.md`.

`CHANGELOG.md` Unreleased: the eve-inspired horizon and leftover-ask hole PRs #2–#8 are **shipped**, not plan-only. Point this file as the session-as-job implementation plan.

`2026-09-15-eve-inspired-roadmap.md` Status stays **implemented**. Add: “stream `?after=` was deferred there; [session-as-job](2026-09-16-session-as-job-roadmap.md) adds seq and amends that ruling.”

`2026-09-16-session-as-job-roadmap.md`: add `Implementation plan: [2026-09-16-session-as-job-implementation.md](../plans/2026-09-16-session-as-job-implementation.md)`.

- [ ] **Step 3: Confirm with grep (this is the “test”)**

```bash
rg -n "Schema version 4" ARCHITECTURE.md ARCHITECTURE.ko.md
rg -n "POST /v1/session/:id/resolve" ARCHITECTURE.md
rg -n "queues" SLASH_COMMANDS.md
rg -n "schema_version 6|schema version \\*\\*6" ARCHITECTURE.md
```

Expected: first command empty; the others hit.

- [ ] **Step 4: Commit** (feature branch only)

```bash
git add ARCHITECTURE.md ARCHITECTURE.ko.md SLASH_COMMANDS.md SLASH_COMMANDS.ko.md CHANGELOG.md README.md docs/headless.md docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md
git commit -m "docs: match ARCHITECTURE and slash help to schema v6 waist"
```

---

### Task 2: ACP timeout does not persist deny (F0.2)

**Files:**
- Modify: `packages/acp/src/server.ts` (`racePermission`, `askPermissionOnce`), `packages/acp/src/server.test.ts`
- Test: `packages/acp/src/server.test.ts`

**Interfaces:**
- Consumes: `PERMISSION_TIMEOUT_MS`, `askPermission`, `racePermission`
- Produces: timeout throws `{ name: 'AskWaiterExpired' }`; `answered` is not set to `'deny'`; `listPendingAsks` still has the `callId` when the engine upserted first

Export nothing new from core. ACP-only error name is the string `'AskWaiterExpired'`.

- [ ] **Step 1: Rewrite the timeout test and add a persist test**

Replace `timeout with no editor answer denies and the tool does not execute` with:

```ts
test('timeout with no editor answer does not deny', async () => {
  let decided: string | undefined
  let threw: string | undefined
  const server = createAcpServer({
    engineFactory: (_sessionId, opts) => ({
      async *submitMessage() {
        try {
          decided = await opts?.requestPermission?.({
            id: 'c-timeout',
            tool: 'Bash',
            input: { command: 'rm -rf /' },
            message: 'dangerous',
          })
        } catch (error) {
          threw = error instanceof Error ? error.name : String(error)
        }
        return { reason: 'completed' }
      },
      abort() {},
    }),
    request: () => new Promise(() => {}),
    permissionTimeoutMs: 120_000,
    wait: async () => {},
  })
  const sessionId = resultOf(
    await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: ACP_METHODS.sessionNew,
      params: { cwd: '/tmp' },
    }),
  ).sessionId
  const prompt = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: ACP_METHODS.sessionPrompt,
    params: { sessionId, prompt: 'rm' },
  })
  expect(resultOf(prompt)).toEqual({ stopReason: 'cancelled' })
  expect(decided).toBeUndefined()
  expect(threw).toBe('AskWaiterExpired')
})
```

Add a second test that uses a real `createMemoryStore` + `createSessionEngine` (same shape as `eval/run.ts` `createAskEcho`) so `upsertPendingAsk` runs before `askUser`. Expire the waiter (`wait: async () => {}`). Assert `store.listPendingAsks(session.id)` still has `call_eval` and no deny tool row exists.

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/acp/src/server.test.ts`  
Expected: FAIL — timeout still `finish('deny')`, `decided === 'deny'`.

- [ ] **Step 3: Implement**

In `racePermission`, timeout must **not** `finish('deny')`. Reject with `Object.assign(new Error('permission waiter expired'), { name: 'AskWaiterExpired' })`. AbortSignal abort stays `AbortError` (turn cancel). `askPermissionOnce` must not `answered.set(event.id, resolved)` on that throw. `handleSessionPrompt`: if `askPermission` throws `AskWaiterExpired`, stop the prompt with `stopReason: 'cancelled'` and do not emit a deny `tool_result`.

In `packages/core/src/loop/phases.ts` `executeOneCall`, the `askUser` catch currently `pairMissing(..., 'aborted')` for every throw. Split:

```ts
} catch (error) {
  if (error instanceof Error && error.name === 'AskWaiterExpired') {
    return { messages: [], events, abortRest: false }
  }
  return {
    messages: pairMissing([call.id], 'aborted'),
    events,
    abortRest: signal.aborted,
  }
}
```

Empty `messages` means do not persist a tool result and do not `deletePendingAsk`. Pairing + `prepareContext` already pass the pending set, so the next assemble does not write `incomplete`.

- [ ] **Step 4: Re-run**

Run: `bun test packages/acp/src/server.test.ts packages/core/src/loop/query-loop.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/acp/src/server.ts packages/acp/src/server.test.ts packages/core/src/loop/phases.ts
git commit -m "fix: ACP permission timeout leaves pending_asks"
```

---

### Task 3: Eval gates named last horizon (F0.3)

**Files:**
- Create: `packages/core/src/eval/fixtures/sandbox-cwd/case.json`, `packages/core/src/eval/fixtures/compact-memory-prefix/case.json`
- Modify: `packages/core/src/eval/run.ts`
- Test: `packages/core/src/eval/run.test.ts` (existing `runEvalDir` call now also runs the new names)

**Interfaces:**
- Consumes: `runEvalDir` one-name switch, `createWorkspaceFs`, `runAutocompact` / `maybeCompact`
- Produces: fixtures `sandbox-cwd`, `compact-memory-prefix`. Any other directory name still throws `unknown eval fixture: ${name}`

`sandbox-cwd/case.json`:

```json
{
  "prompt": "write outside cwd",
  "expect": { "writeOutsideCwdDenied": true }
}
```

`compact-memory-prefix/case.json`:

```json
{
  "prompt": "compact me",
  "expect": { "memoryStaysSystem": true }
}
```

- [ ] **Step 1: Add fixtures and dispatch (tests fail until runners exist)**

In `run.ts` extend `EvalExpect` with `writeOutsideCwdDenied?: boolean` and `memoryStaysSystem?: boolean`. In `runEvalDir`:

```ts
if (name === 'sandbox-cwd') {
  await runSandboxCwd(spec)
  continue
}
if (name === 'compact-memory-prefix') {
  await runCompactMemoryPrefix(spec)
  continue
}
```

`runSandboxCwd`: temp dir as session cwd; `createSessionEngine` with `terminalBackend: 'docker'`, tools `[writeTool]`, provider script `Write` of `/tmp/raven-eval-outside.txt` (or `../escape.txt`). Drain. Assert the Write result text matches `/outside workspace|must be Read first|Write failed/` **and** `existsSync('/tmp/raven-eval-outside.txt')` is false. Use a unique outside path under `os.tmpdir()` so the test does not touch `/etc`.

`runCompactMemoryPrefix`: copy the existing `maybe-compact.test.ts` MEMORY case into an in-process engine: system part `{ tier: 'stable', text: 'MEMORY.md unique-bytes-xyz' }`, compact forced (tiny window + `llmSummarize: false`). After `compactNow()`, assert `system` still contains `unique-bytes-xyz` and the compact summary / new user note is **not** used as the system prefix (same assertion as `maybe-compact.test.ts`).

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/eval/run.test.ts`  
Expected: FAIL — `unknown eval fixture: compact-memory-prefix` or `sandbox-cwd` (directory sort puts `compact-memory-prefix` first).

- [ ] **Step 3: Implement the two runners** (code in Step 1). Reuse `createFakeProvider` / `defaultCompact` / `drain` already in `run.ts`. Do not add an authored `id` field.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/eval/run.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/eval
git commit -m "test: add sandbox-cwd and compact-memory-prefix eval fixtures"
```

---

### Task 4: Compact resets this-turn read tracking (F1.1)

**Files:**
- Modify: `packages/core/src/tools/read-files.ts`, `packages/core/src/loop/phases.ts` (`maybeCompact`), `packages/core/src/loop/session-engine.ts` (`runCompactNow`)
- Test: `packages/core/src/tools/read-files.ts` companion `read-files.test.ts` (create if missing) plus a compact integration in `packages/core/src/compact/prune.test.ts` or `packages/core/src/tools/write.test.ts`

**Interfaces:**
- Consumes: `Turn.readFiles`, `Turn.readFileMtimes`, post-compact `messages`
- Produces:

```ts
export function forgetReadsNotInTail(turn: Turn, messages: Message[]): void
```

A path stays only if some **kept** assistant `Read` tool_use for that path has a **kept** tool result whose text does not start with `[cleared `.

- [ ] **Step 1: Failing test**

```ts
test('forgetReadsNotInTail drops paths whose Read was summarized away', () => {
  const turn = {
    cwd: '/tmp',
    readFiles: new Set(['/tmp/a.ts']),
    readFileMtimes: new Map([['/tmp/a.ts', 1]]),
  } as Turn
  const messages: Message[] = [
    {
      id: 'u',
      role: 'user',
      blocks: [{ type: 'text', text: 'summary' }],
      createdAt: 1,
    },
  ]
  forgetReadsNotInTail(turn, messages)
  expect(turn.readFiles.has('/tmp/a.ts')).toBe(false)
  expect(turn.readFileMtimes?.has('/tmp/a.ts')).toBe(false)
})

test('Write after compact of a Read requires a new Read', async () => {
  // persist user + assistant Read(a.ts) + huge tool result; runAutocompact with
  // protectLastMessages: 1 so the Read is cut; then writeTool.execute({ path: 'a.ts', content: 'x' })
  // on a turn that still has readFiles = { resolved a.ts }.
  // After forgetReadsNotInTail(turn, compacted.messages), Write must return
  // "Write failed: path must be Read first: a.ts"
})
```

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/tools/read-files.test.ts`  
Expected: FAIL — `forgetReadsNotInTail` is not exported.

- [ ] **Step 3: Implement**

Walk `messages` like `restoreReadFilesFromMessages`, build the set of still-evidenced resolved paths, then delete every `readFiles` / `readFileMtimes` entry that is not in that set. Call it at the end of `maybeCompact` after `state.turn.messages = result.messages`, and in `runCompactNow` after `liveTurn.messages = result.messages`.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/tools/read-files.test.ts packages/core/src/compact/maybe-compact.test.ts packages/core/src/tools/write.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/read-files.ts packages/core/src/tools/read-files.test.ts packages/core/src/loop/phases.ts packages/core/src/loop/session-engine.ts packages/core/src/compact/prune.test.ts
git commit -m "fix: compact forgets this-turn Reads that left the tail"
```

---

### Task 5: Todos restore-note after compact (F1.2)

**Files:**
- Modify: `packages/core/src/compact/prune.ts` (`collectRestoredNotes`), `packages/core/src/compact/prune.test.ts`
- Test: `packages/core/src/compact/prune.test.ts`

**Interfaces:**
- Consumes: `runAutocompact` `cwd`, `SessionRecord.todos` (optional; may be missing until Task 6), `loadTodos(cwd)`
- Produces: one user-role note `Todos:\n- [pending] a\n- [done] b` (status then text). No note when the list is empty. Not a tool. Not in the system prefix.

Extend `runAutocompact` opts with `todos?: TodoItem[]`. `collectRestoredNotes` last step:

```ts
function collectTodoNote(todos: TodoItem[] | undefined, cwd?: string): string[] {
  const items = todos ?? (cwd ? loadTodos(cwd) : [])
  if (items.length === 0) return []
  const lines = items.map((item) => `- [${item.status}] ${item.text}`)
  return [`Todos:\n${lines.join('\n')}`]
}
```

`session-engine.ts` `runCompactNow` and `maybeCompact` pass `todos: session.todos` when present.

- [ ] **Step 1: Failing test**

```ts
test('compact injects a todos restore-note when TodoWrite left the tail', async () => {
  const store = createMemoryStore()
  const sess = session({ cwd: root })
  await store.createSession(sess)
  mkdirSync(join(root, '.ravenclaw'), { recursive: true })
  writeFileSync(
    join(root, '.ravenclaw', 'todo.json'),
    JSON.stringify([
      { id: 't1', text: 'one', status: 'pending' },
      { id: 't2', text: 'two', status: 'in_progress' },
      { id: 't3', text: 'three', status: 'done' },
    ]),
  )
  const messages = [
    user('u0', 'old', 1),
    asstTools('a0', [{ id: 'td', name: 'TodoWrite', input: { items: [] } }], 2),
    tool('t0', 'td', 'Wrote 3', 3),
    user('u1', 'recent', 4),
    asstText('a1', 'ok', 5),
  ]
  await persistAll(store, sess.id, messages)
  const out = await runAutocompact({
    messages,
    compact: compact({ protectLastMessages: 2 }),
    model: model(),
    store,
    sessionId: sess.id,
    generation: 0,
    summary: 'sum',
    cwd: root,
  })
  const blob = out.messages.map(textOf).join('\n')
  expect(blob).toContain('one')
  expect(blob).toContain('two')
  expect(blob).toContain('three')
})
```

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/compact/prune.test.ts`  
Expected: FAIL — blob has no todo texts.

- [ ] **Step 3: Implement** `collectTodoNote` and pass `todos` through `runAutocompact`. Missing / empty → no note.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/compact/prune.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/compact/prune.ts packages/core/src/compact/prune.test.ts packages/core/src/loop/session-engine.ts packages/core/src/loop/phases.ts
git commit -m "feat: re-inject session todos after compact"
```

---

### Task 6: Todos keyed by `sessionId` (F1.3)

**Files:**
- Create: `packages/core/src/migrations/007_session_todos.sql`
- Modify: `packages/core/src/session/schema.ts`, `schema.test.ts`, `sqlite-store.ts` (`SessionRow`, `sessionBind`, `sessionFromRow`, INSERT/UPSERT), `memory-store.ts`, `types.ts` (`SessionRecord.todos?: TodoItem[]`), `types.test.ts`, `tools/todo.ts`, `todo.test.ts`, `cli/src/app.tsx` (TodoPanel source), `sqlite-store.test.ts`, `deliveries.test.ts` (version pin 6 → 7)
- Test: `packages/core/src/tools/todo.test.ts`, `packages/core/src/session/schema.test.ts`

**Interfaces:**
- Consumes: Task 5 restore-note
- Produces: schema_version `7`; `SessionRecord.todos`; `TodoWrite` reads/writes **this session** via `ctx.store` + `ctx.turn.sessionId`

`007_session_todos.sql`:

```sql
ALTER TABLE sessions ADD COLUMN todos_json TEXT;
```

`todoWriteTool.execute`: require `ctx.store`. Load session, replace `session.todos` with the parsed items, `upsertSession`, then project `todoJsonPath(ctx.turn.projectCwd ?? ctx.turn.cwd)`. Description text may still mention `.ravenclaw/todo.json` as the human/git projection.

`runAutocompact` / compact restore uses `session.todos`, not cwd, when the engine has a session (Task 5 fallback remains for tests that only pass `cwd`).

- [ ] **Step 1: Failing tests**

Schema: copy the v6 pin tests to expect `7` and `todos_json` on `sessions`. Add:

```ts
test('two sessions in one cwd keep independent todo lists', async () => {
  const root = fixtureRoot()
  const store = createMemoryStore()
  const a = sessionRecord('s_a', root)
  const b = sessionRecord('s_b', root)
  await store.createSession(a)
  await store.createSession(b)
  const ctxA = makeCtx(root, 's_a', store)
  const ctxB = makeCtx(root, 's_b', store)
  await todoWriteTool.execute({ items: [{ text: 'alpha', status: 'pending' }] }, ctxA)
  await todoWriteTool.execute({ items: [{ text: 'beta', status: 'done' }] }, ctxB)
  expect((await store.loadSession('s_a')).session.todos?.map((t) => t.text)).toEqual(['alpha'])
  expect((await store.loadSession('s_b')).session.todos?.map((t) => t.text)).toEqual(['beta'])
})
```

`makeCtx` must pass `store` and set `turn.sessionId`.

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/session/schema.test.ts packages/core/src/tools/todo.test.ts`  
Expected: FAIL — version still 6; `session.todos` undefined.

- [ ] **Step 3: Implement** migration, bind/fromRow JSON, `TodoWrite` session write + projection, TUI `setTodos(runtime.engine.session.todos ?? loadTodos(cwd))` after TodoWrite and on resume.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/session/schema.test.ts packages/core/src/session/sqlite-store.test.ts packages/core/src/tools/todo.test.ts packages/core/src/compact/prune.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/migrations/007_session_todos.sql packages/core/src/session packages/core/src/types.ts packages/core/src/types.test.ts packages/core/src/tools/todo.ts packages/core/src/tools/todo.test.ts packages/cli/src/app.tsx
git commit -m "feat: persist todos on the session, project todo.json"
```

---

### Task 7: Session job record + named shadow branch (F2.1 / F2.2)

**Files:**
- Create: `packages/core/src/migrations/008_session_job.sql`
- Modify: `schema.ts` + version pins (7 → 8), `types.ts` (`SessionJob`, `SessionRecord.job`, `SessionRecord.jobAutoCommit`), `sqlite-store.ts` / `memory-store.ts`, `session-worktree.ts`, `session-worktree.test.ts`, `enter-worktree.ts`, `cli/src/engine.ts` (`--worktree`), `cli/src/commands.ts`, `cli/src/slash/dispatch.ts`
- Test: `packages/core/src/tools/session-worktree.test.ts`, `packages/core/src/session/schema.test.ts`

**Interfaces:**
- Consumes: today’s `enterSessionWorktree(sessionId, parentCwd, name?)`
- Produces:

```ts
export function enterSessionWorktree(
  sessionId: string,
  parentCwd: string,
  name?: string,
): { ok: boolean; cwd: string; job?: SessionJob; error?: string }

export function shadowBranchName(sessionId: string, name?: string): string
// raven/<slug> — slug from name or first 8 cleaned sessionId chars
```

On success the caller (`EnterWorktree.execute`, CLI `--worktree`, `/job`) must `session.job = result.job; await store.upsertSession(session)`.

`008_session_job.sql`:

```sql
ALTER TABLE sessions ADD COLUMN job_json TEXT;
ALTER TABLE sessions ADD COLUMN job_auto_commit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN checkpoint_json TEXT;
```

Replace `git worktree add --detach <path>` with:

```ts
const baseSha = runGit(toplevel, ['rev-parse', 'HEAD']).stdout.trim()
const baseBranch =
  runGit(toplevel, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || 'HEAD'
const shadow = shadowBranchName(sessionId, name)
runGit(toplevel, ['worktree', 'add', '-b', shadow, worktreePath, baseSha])
```

Sidecar JSON also stores `baseBranch`, `shadowBranch`, `baseCommitSha` so `getSessionWorktree` can rebuild a `SessionJob` if `session.job` was not yet upserted. Store remains source of truth after upsert.

`/job` (no arg) enters with default name. `/job <name>` passes the name. `/job commit on|off` is Task 8.

- [ ] **Step 1: Failing tests**

```ts
test('enter creates a named raven/* branch and records baseSha', () => {
  const cwd = tempDir('ravenclaw-swt-job-')
  initGitRepo(cwd)
  const sessionId = nextSession()
  const result = enterSessionWorktree(sessionId, cwd)
  expect(result.ok).toBe(true)
  expect(result.job?.shadowBranch.startsWith('raven/')).toBe(true)
  const branch = spawnSync('git', ['-C', result.cwd, 'branch', '--show-current'], {
    encoding: 'utf8',
  })
  expect(branch.stdout.trim()).toBe(result.job?.shadowBranch)
  const head = spawnSync('git', ['-C', result.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  expect(head.stdout.trim()).toBe(result.job?.baseCommitSha)
})

test('EnterWorktree then loadSession still knows base/shadow/baseSha', async () => {
  const store = createMemoryStore()
  // createSession, enter, assign session.job, upsert, loadSession
})
```

Flip the existing `enter creates a detached worktree` test: it must still create `.ravenclaw/worktrees/<slug>` but HEAD is **not** detached.

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/tools/session-worktree.test.ts`  
Expected: FAIL — still `--detach`; `result.job` undefined.

- [ ] **Step 3: Implement** named branch, job object, schema v8, persist on EnterWorktree + `--worktree` + `/job`. Update `EnterWorktree` description (no longer “detached”).

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/tools/session-worktree.test.ts packages/core/src/session/schema.test.ts packages/core/src/tools/enter-worktree.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/migrations/008_session_job.sql packages/core/src/session packages/core/src/types.ts packages/core/src/tools/session-worktree.ts packages/core/src/tools/session-worktree.test.ts packages/core/src/tools/enter-worktree.ts packages/cli/src/engine.ts packages/cli/src/commands.ts packages/cli/src/slash/dispatch.ts
git commit -m "feat: session job record with named raven/* shadow branch"
```

---

### Task 8: Opt-in turn-end commit (F2.3)

**Files:**
- Create: `packages/core/src/session/job.ts`, `packages/core/src/session/job.test.ts`
- Modify: `session-engine.ts` (after `queryLoop` returns), `config.ts` (`job?: { autoCommit?: boolean }`), `slash/dispatch.ts` (`/job commit on|off`), `commands.ts`
- Test: `packages/core/src/session/job.test.ts`, `packages/core/src/loop/session-engine.test.ts`

**Interfaces:**
- Consumes: `SessionRecord.job`, `jobAutoCommit`, worktree path
- Produces:

```ts
export function maybeCommitJob(opts: {
  job: SessionJob
  turnId: string
  cwd: string
}): { committed: boolean; sha?: string; notice?: string }

export function setJobAutoCommit(session: SessionRecord, on: boolean): void
```

`maybeCommitJob`: `git status --porcelain` empty → `{ committed: false }`. Else `git add -A` then `git commit -m "raven: turn <turnId.slice(0,8)>"` with the operator identity already configured in that repo. On failure `{ committed: false, notice: 'job commit failed: …' }`.

Call site in `submitMessage` after `const end = yield* queryLoop(...)` and `upsertSession`, before `return end`:

```ts
if (
  session.job &&
  session.jobAutoCommit === true &&
  (end.reason === 'completed' ||
    end.reason === 'hook_stopped' ||
    end.reason === 'max_rounds' ||
    end.reason === 'context_full') &&
  (await opts.store.listPendingAsks(session.id)).length === 0
) {
  const result = maybeCommitJob({ job: session.job, turnId: turn.id, cwd: turn.cwd })
  if (result.notice) yield { type: 'status', message: result.notice }
}
```

`loadConfig` reads `job.autoCommit` (default `false`) onto new sessions only; `/job commit on|off` flips `session.jobAutoCommit` and upserts.

- [ ] **Step 1: Failing tests**

```ts
test('maybeCommitJob creates one commit on a dirty shadow branch', () => {
  // init repo, enterSessionWorktree, write a file, maybeCommitJob
  // expect committed true and rev-parse HEAD !== baseCommitSha
})

test('submitMessage with jobAutoCommit does not commit on abort', async () => {
  // engine with job + jobAutoCommit, abort mid-turn, worktree still dirty, HEAD unchanged
})
```

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/session/job.test.ts`  
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** `maybeCommitJob` + engine epilogue + `/job commit on|off`. Default off.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/session/job.test.ts packages/core/src/loop/session-engine.test.ts packages/cli/src/slash/dispatch.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/job.ts packages/core/src/session/job.test.ts packages/core/src/loop/session-engine.ts packages/core/src/config.ts packages/cli/src/slash/dispatch.ts packages/cli/src/commands.ts
git commit -m "feat: opt-in turn-end commit on the session shadow branch"
```

---

### Task 9: Checkpoint and rewind-to-checkpoint (F2.4)

**Files:**
- Modify: `types.ts` (`JobCheckpoint` on assistant `Message.checkpoint?`), `sqlite-store.ts` (`messageBind` / `messageFromRow` `checkpoint_json`), `memory-store.ts`, `session/rewind.ts`, `rewind.test.ts`, `session-engine.ts` (`rewindLast` + stamp checkpoint after successful turn), `job.ts`
- Test: `packages/core/src/session/rewind.test.ts`, `packages/core/src/session/job.test.ts`

**Interfaces:**
- Consumes: Task 7 job, Task 6 todos, Task 8 commit sha (or `HEAD` + dirty when autoCommit is off)
- Produces:

```ts
export function stampCheckpoint(
  message: Extract<Message, { role: 'assistant' }>,
  job: SessionJob,
  todos: TodoItem[] | undefined,
  cwd: string,
): void

export async function rewindToCheckpoint(opts: {
  session: SessionRecord
  messages: Message[]
  store: SessionStore
}): Promise<{ ok: boolean; notice: string; messages: Message[] }>
```

After a successful turn (same reason set as auto-commit, including when autoCommit is off), find the last assistant message in `turn.messages` and set `checkpoint: { commitSha, todoSnapshot, dirty }`. Persist via existing `persistAssistant` / `persistToolCalls` — both must write `checkpoint_json` when present. If the last row is a tool result, stamp the last assistant instead and re-upsert that assistant row (`persistToolCalls` if it has `tool_use`).

`rewindLast`: if `session.job`, call `rewindToCheckpoint` and **skip** `fileHistory.undo()`. Else today’s `rewindLastTurn`.

`rewindToCheckpoint`: refuse if called while live (engine already refuses). Walk messages from the end, drop the last user turn (same `dropLastUserTurn`), then find the last remaining assistant `checkpoint`. `git -C job.worktreePath reset --hard <sha>` (sha = checkpoint.commitSha, or `job.baseCommitSha` if none). Restore `session.todos = checkpoint.todoSnapshot` (or `[]`). `upsertSession`. Persist the dropped ids via `recordCompact` like today. No force-push. No rewrite of `baseCommitSha`.

- [ ] **Step 1: Failing test**

```ts
test('two committed turns, rewind once: HEAD is the first checkpoint sha and todos match', async () => {
  // enter job, write+commit turn1 with todos [a], write+commit turn2 with todos [a,b]
  // rewindLast → HEAD === turn1 sha, session.todos === [a], last user/assistant of turn2 gone
})
```

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/session/rewind.test.ts packages/core/src/session/job.test.ts`  
Expected: FAIL — rewind still file-history only.

- [ ] **Step 3: Implement** stamp + job rewind path.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/session/rewind.test.ts packages/core/src/session/job.test.ts packages/core/src/loop/session-engine.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/session packages/core/src/loop/session-engine.ts
git commit -m "feat: rewind job sessions to the previous git checkpoint"
```

---

### Task 10: Cancel ≠ fail, `turnId` guard (F3.1)

**Files:**
- Modify: `types.ts` (`RoundEnd` + `round_start` + `SessionEngine.abort` / `liveTurnId`), `loop/phases.ts` (aborted vs cancelled), `loop/session-engine.ts`, `loop/abort.ts` if needed, `cli/src/serve.ts`, `cli/src/serve.test.ts`, `gateway/http.ts` (`parseCancelBody`), `index.ts` export, `acp/src/protocol.ts` (`roundEndToStopReason` maps `cancelled` → `'cancelled'`)
- Test: `packages/core/src/loop/session-engine.test.ts`, `packages/cli/src/serve.test.ts`

**Interfaces:**
- Consumes: today’s `engine.abort()`
- Produces:

```ts
// RoundEnd gains:
| { reason: 'cancelled' }

// StreamEvent.round_start:
| { type: 'round_start'; round: number; turnId: string }

abort(kind?: 'cancel' | 'interrupt'): void
liveTurnId(): string | null

export function parseCancelBody(
  body: unknown,
): { ok: true; turnId?: string } | { ok: false; error: string }
```

Empty / missing body is `{ ok: true }` (cancel current). Invalid JSON on POST cancel with a body is 400. `turnId` present but ≠ `liveTurnId()` → `200 { ok: true, status: 'no_active_turn' }` and do **not** call `abort`. No live turn, no body → same `no_active_turn`. Match → `abort('cancel')` then `{ ok: true }`.

`queryLoop` / `phases.ts`: when the abort controller fires, if `turn.cancelKind === 'cancel'` return `{ reason: 'cancelled' }`, else `{ reason: 'aborted' }`. Store `cancelKind` on `Turn` (add optional `cancelKind?: 'cancel' | 'interrupt'`).

After cancel, if `listPendingAsks` nonempty, yield `{ type: 'status', message: 'cancelled, ask still pending' }` before `round_end`. Do not `applyAskAnswer(..., 'deny')`. Next `submitMessage` must run (already true for `aborted`).

TUI `/stop` / Escape: `abort('cancel')`. `/steer`: keep `abort()` default interrupt.

- [ ] **Step 1: Failing tests**

```ts
test('host cancel yields cancelled and a later submit runs', async () => {
  // start submitMessage, abort('cancel'), expect { reason: 'cancelled' }
  // second submitMessage completes
})

test('POST cancel with stale turnId is a no-op', async () => {
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/cancel', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ turnId: 'stale' }),
    }),
    ctx,
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, status: 'no_active_turn' })
})
```

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/loop/session-engine.test.ts packages/cli/src/serve.test.ts`  
Expected: FAIL — `abort` takes no kind; cancel always `{ ok: true }` and `aborted`.

- [ ] **Step 3: Implement** kind, `cancelled`, `parseCancelBody`, serve guard, status line for parked asks.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/loop/session-engine.test.ts packages/cli/src/serve.test.ts packages/acp/src/protocol.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/loop packages/core/src/gateway/http.ts packages/core/src/index.ts packages/cli/src/serve.ts packages/cli/src/serve.test.ts packages/acp/src/protocol.ts
git commit -m "feat: cancel is not failure and ignores a stale turnId"
```

---

### Task 11: Reconnectable stream `seq` + `?after=` (F3.2)

**Files:**
- Create: `packages/core/src/migrations/009_stream_events.sql`, `packages/core/src/session/stream-events.ts`, `stream-events.test.ts`
- Modify: `schema.ts` + version pins (8 → 9), `types.ts` (`SessionStore.appendStreamEvent` / `listStreamEventsAfter`), `sqlite-store.ts`, `memory-store.ts`, `cli/src/serve.ts` (`createSessionEventHub` or a wrapping persist hub), `docs/headless.md`
- Test: `packages/core/src/session/stream-events.test.ts`, `packages/cli/src/serve.test.ts`

**Interfaces:**
- Consumes: Task 10 `cancelled` / `turnId` events
- Produces:

```ts
export type SequencedStreamEvent = StreamEvent & { seq: number }

appendStreamEvent(sessionId: string, event: StreamEvent): Promise<number>
listStreamEventsAfter(sessionId: string, afterSeq: number): Promise<SequencedStreamEvent[]>
lastStreamSeq(sessionId: string): Promise<number>
```

`009_stream_events.sql`:

```sql
CREATE TABLE IF NOT EXISTS stream_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ask_call_id TEXT,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS stream_events_ask ON stream_events(session_id, ask_call_id);
```

`appendStreamEvent`: if `event.type === 'permission_ask'`, `SELECT seq FROM stream_events WHERE session_id = ? AND ask_call_id = ?` and reuse that seq (do not insert a second row). Else `MAX(seq)+1` insert. `deleteSession` drops the session’s rows.

Hub: `publish` must persist then fan out `{ ...event, seq }`. `GET …/stream?after=` parses `after` as a non-negative integer (missing = live tail only; `after=0` = replay all then tail). Replay `listStreamEventsAfter` then `subscribe`. Closing the stream is detach.

No `?after=` handling on `/v1/turn`.

- [ ] **Step 1: Failing tests**

```ts
test('append reuses seq for the same permission_ask callId', async () => {
  const store = createMemoryStore()
  await store.createSession(session())
  const event = {
    type: 'permission_ask' as const,
    id: 'c1',
    tool: 'Bash',
    input: {},
    message: '?',
  }
  const a = await store.appendStreamEvent('s1', event)
  const b = await store.appendStreamEvent('s1', event)
  expect(a).toBe(b)
  expect(await store.listStreamEventsAfter('s1', 0)).toHaveLength(1)
})

test('second stream with after= concatenates without gaps or dupes', async () => {
  // handleServeRequest two GET stream connections; first reads seq 1..n;
  // second ?after=n reads only later events; concat === full order
})
```

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/session/stream-events.test.ts packages/cli/src/serve.test.ts`  
Expected: FAIL — no `appendStreamEvent`; stream is live tail only.

- [ ] **Step 3: Implement** table, store methods, persist-on-publish, `?after=` replay.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/session/stream-events.test.ts packages/core/src/session/schema.test.ts packages/cli/src/serve.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/migrations/009_stream_events.sql packages/core/src/session packages/core/src/types.ts packages/cli/src/serve.ts packages/cli/src/serve.test.ts docs/headless.md
git commit -m "feat: persist serve stream seq and honor ?after="
```

---

### Task 12: `GET /v1/session/:id` snapshot (F3.3)

**Files:**
- Modify: `packages/cli/src/serve.ts` (`SESSION_PATH` plus a new exact-id route), `packages/cli/src/serve.test.ts`, `docs/headless.md`
- Test: `packages/cli/src/serve.test.ts`

**Interfaces:**
- Consumes: Task 7 `session.job`, Task 11 `lastStreamSeq`, `listPendingAsks`
- Produces: `200` JSON

```ts
type SessionSnapshot = {
  id: string
  job?: SessionJob
  pendingAsks: Array<{ callId: string; tool: string; message: string; childSessionId?: string }>
  lastSeq: number
  permissionMode: PermissionMode
  live: boolean
}
```

`live` is `engine.liveTurnId() !== null`. 404 if `loadSessionRuntime` misses and `createSession` is **not** invoked. 401 without Bearer.

Document crash-resolve in `headless.md`: `applyAskAnswer` after process death pairs only; the client must `POST …/submit` to continue the model.

- [ ] **Step 1: Failing test**

```ts
test('GET /v1/session/:id returns job and parked callIds', async () => {
  // runtime with session.job + one pending ask; GET with Bearer
  // expect 200 body.id, body.job.shadowBranch, body.pendingAsks[0].callId, lastSeq number
})

test('GET /v1/session/:id does not create', async () => {
  const res = await handleServeRequest(getUnknown, ctxWithoutCreate)
  expect(res.status).toBe(404)
})
```

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/cli/src/serve.test.ts`  
Expected: FAIL — path requires an action; 404 `not found`.

- [ ] **Step 3: Implement**

Keep `SESSION_PATH` for actions. Add:

```ts
const SESSION_ID_PATH = /^\/v1\/session\/([^/]+)$/
```

Handle `GET` on that path before the 404 fallthrough.

- [ ] **Step 4: Re-run**

Run: `bun test packages/cli/src/serve.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve.ts packages/cli/src/serve.test.ts docs/headless.md
git commit -m "feat: GET /v1/session/:id snapshot for reconnect"
```

---

### Task 13: Optional `/pr` (F4.1)

**Files:**
- Modify: `packages/core/src/session/job.ts` (`openDraftPr`), `job.test.ts`, `cli/src/commands.ts`, `cli/src/slash/dispatch.ts`, `cli/src/serve.ts` (`POST …/pr`), `serve.test.ts`
- Test: `packages/core/src/session/job.test.ts`, `packages/cli/src/slash/dispatch.test.ts`

**Interfaces:**
- Consumes: `SessionJob`, clean worktree, `gh`
- Produces:

```ts
export function openDraftPr(opts: {
  job: SessionJob
  cwd: string
  title?: string
  body?: string
  gh?: (args: string[], cwd: string) => { ok: boolean; stdout: string; stderr: string }
}): {
  ok: boolean
  notice: string
  snapshot?: { title: string; body: string; url?: string; sha: string; files: number; plus: number; minus: number }
  job?: SessionJob
}
```

Default `gh` is `runGit`-style `spawnSync('gh', args)`. Create: `gh pr create --draft --base <baseBranch> --head <shadowBranch> --title … --body …`. Update if `job.prNumber` set: `gh pr edit <n> --title … --body …`. Parse URL from stdout. Annotate last assistant message (append a text block or set a small `pr` field — **do not** add a new always-on tool). Update `session.job` with `prNumber` / `prUrl` and upsert.

Preconditions fail → `{ ok: false, notice }` (dirty / no job / `gh` missing). Never throw into the turn. Never default-on.

Serve: `POST /v1/session/:id/pr` Bearer, optional `{ title, body }`, returns the notice JSON. Add `pr` to the action regex.

- [ ] **Step 1: Failing tests**

```ts
test('openDraftPr on a clean shadow records a url', () => {
  const gh = (_args: string[]) => ({ ok: true, stdout: 'https://github.com/o/r/pull/4\n', stderr: '' })
  const out = openDraftPr({ job, cwd, gh })
  expect(out.ok).toBe(true)
  expect(out.snapshot?.url).toContain('/pull/4')
  expect(out.job?.prNumber).toBe(4)
})

test('openDraftPr without a job record notices and does nothing', () => {
  const calls: string[][] = []
  const out = openDraftPr({
    job: undefined as never,
    cwd: '/tmp',
    gh: (args) => {
      calls.push(args)
      return { ok: true, stdout: '', stderr: '' }
    },
  })
  // actually: a wrapper used by slash that reads session.job
})
```

Slash test: session without `job` → notice `no job record`, `gh` not invoked. Dirty tree → notice `worktree is dirty`.

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/session/job.test.ts packages/cli/src/slash/dispatch.test.ts`  
Expected: FAIL — `openDraftPr` missing.

- [ ] **Step 3: Implement** helper, `/pr`, `POST …/pr`. Default off (no auto call from `submitMessage`).

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/session/job.test.ts packages/cli/src/slash/dispatch.test.ts packages/cli/src/serve.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/job.ts packages/core/src/session/job.test.ts packages/cli/src/commands.ts packages/cli/src/slash/dispatch.ts packages/cli/src/serve.ts packages/cli/src/serve.test.ts
git commit -m "feat: optional draft PR from the session shadow branch"
```

---

### Task 14: Stacked child base = parent shadow (F4.3)

**Files:**
- Modify: `packages/core/src/tools/worktree.ts` (`prepareChildWorktree`), `worktree.test.ts`, `packages/core/src/tools/agent.ts`
- Test: `packages/core/src/tools/worktree.test.ts`, `packages/core/src/tools/agent.test.ts` if one exists for isolation

**Interfaces:**
- Consumes: parent `SessionRecord.job`
- Produces:

```ts
export function prepareChildWorktree(
  parentCwd: string,
  childSessionId: string,
  isolation: IsolationMode,
  parentJob?: SessionJob,
): ChildWorktree & { job?: SessionJob }
```

When `isolation === 'worktree'` and `parentJob` is set:

```ts
const baseSha = runGit(parentJob.worktreePath, ['rev-parse', 'HEAD']).stdout.trim()
const shadow = shadowBranchName(childSessionId)
runGit(toplevel, ['worktree', 'add', '-b', shadow, worktreePath, baseSha])
// child job.baseBranch = parentJob.shadowBranch
// child job.baseCommitSha = baseSha
```

When `parentJob` is absent, keep today’s `--detach` fallback (child without a job record). `createAgentTool` passes `ctx.store.loadSession`’s `session.job` (parent). After `createSession(childSession)`, set `childSession.job` and upsert.

F4.1 on the child uses `child.job.baseBranch` which is the parent shadow.

- [ ] **Step 1: Failing test**

```ts
test('child worktree merge-base is the parent shadow tip at spawn', () => {
  // parent job at sha P; prepareChildWorktree(..., parentJob)
  // git merge-base child parent.shadow === P
  // child job.baseBranch === parent.shadowBranch
})
```

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/tools/worktree.test.ts`  
Expected: FAIL — still `--detach`; no child job.

- [ ] **Step 3: Implement** parent-job branch cut + persist child job. Do not copy the parent chat except the existing Agent prompt.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/tools/worktree.test.ts packages/core/src/tools/agent.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/worktree.ts packages/core/src/tools/worktree.test.ts packages/core/src/tools/agent.ts
git commit -m "feat: stack child worktrees on the parent shadow branch"
```

---

### Task 15: Eval fixtures that lock F1–F3 (F4.2)

**Files:**
- Create: `packages/core/src/eval/fixtures/todo-restore/case.json`, `cancel-not-fail/case.json`, `stream-reconnect/case.json`, `job-shadow-branch/case.json`
- Modify: `packages/core/src/eval/run.ts`, `run.test.ts`
- Test: `bun test packages/core/src/eval/run.test.ts`

**Interfaces:**
- Consumes: Tasks 5–11
- Produces: four named runners. Path is identity. Gates only.

`todo-restore`: session with three todos, compact the `TodoWrite` out of the tail, assert next provider request / compacted messages contain the three texts (F1.2/F1.3).

`cancel-not-fail`: `submitMessage`, `abort('cancel')`, assert `{ reason: 'cancelled' }`, then a second `submitMessage` completes (F3.1).

`stream-reconnect`: in-process `appendStreamEvent` three events, `listStreamEventsAfter(id, 1)` returns exactly events 2 and 3 with those seqs (F3.2). Do not require HTTP if the store helper is enough.

`job-shadow-branch`: temp git repo, `enterSessionWorktree`, assert `job.shadowBranch` is current and `HEAD === baseCommitSha` (F2.2).

- [ ] **Step 1: Add the four directories + switch arms** (tests fail until each runner is real).

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/eval/run.test.ts`  
Expected: FAIL — `unknown eval fixture: cancel-not-fail` (sort order).

- [ ] **Step 3: Implement the four runners.** No LLM-as-judge. Drive `createSessionEngine` / store helpers only.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/eval/run.test.ts`  
Expected: PASS. A regression that drops F1.2, F2.2, or F3.1 fails this file.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/eval
git commit -m "test: lock session-as-job contracts in raven eval"
```

---

## Self-review

**Spec coverage**

| Spec slice | Task |
|---|---|
| F0.1 docs | 1 |
| F0.2 ACP timeout | 2 |
| F0.3 sandbox-cwd + compact-MEMORY | 3 |
| F1.1 read tracking | 4 |
| F1.2 todos restore-note | 5 |
| F1.3 session todos | 6 |
| F2.1 job record | 7 |
| F2.2 named shadow | 7 |
| F2.3 auto-commit | 8 |
| F2.4 checkpoint rewind | 9 |
| F3.1 cancel ≠ fail + turnId | 10 |
| F3.2 seq + `?after=` | 11 |
| F3.3 GET snapshot | 12 |
| F4.1 `/pr` | 13 |
| F4.2 eval lock | 15 |
| F4.3 stacked child | 14 |

Out-of-horizon items (web UI, Prisma/Socket.IO, wiki, compiler, HMAC, `ignored`, live cancel abort-pair, docker Grep/NotebookEdit) have no task.

**Placeholder scan:** no TBD / “implement later” / “similar to Task N” without code.

**Type consistency:** `SessionJob`, `JobCheckpoint`, `forgetReadsNotInTail`, `maybeCommitJob`, `rewindToCheckpoint`, `openDraftPr`, `appendStreamEvent`, `abort('cancel'|'interrupt')`, `liveTurnId()`, `parseCancelBody` are named once in Task 4–13 and reused later.
