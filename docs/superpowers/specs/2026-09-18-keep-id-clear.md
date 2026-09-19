# RavenClaw next-horizon roadmap (keep-id `/clear`)

Date: 2026-09-18  
Status: implemented  
Shipped on `main` at `edeb611`. Combined waist with stream version/token and parent tree-stop is on `main` at `9901d0e`.  
Reviewed against tree at `be5a4a7` (`origin/main` after no-job todo revert).  
Successor to `2026-09-18-no-job-todo-revert.md` (Status: implemented at `be5a4a7`). Amends prior OUT for keep-id `/clear` **only**. Does not reopen that spec’s closed doors.

Implementation plan: [2026-09-18-keep-id-clear.md](../plans/2026-09-18-keep-id-clear.md). Isolated worktree only.

Sources: current tree. Steal contracts. No copy of eve, y0, Claude, Hermes, or Freebuff source.

Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not become a hosted Task runner. Do not add a web UI.

---

## Where we are

The waist is shipped: leftover-ask, session-as-job, job-host, persist-before-reset rewind, project `todo.json` projection, live cancel abort-pair, reset-on-resume, follow-up persist-first, no-job todo revert.

Hosts (TUI, `raven serve` reconnect, included-session cap) hold a `session.id`. `/clear` / `/new` today does **not** keep it. Both Ink (`packages/cli/src/app.tsx`) and OpenTUI (`packages/cli/src/opentui-app.ts`) run:

1. `engine.close()` (SessionEnd hook, release lock; does **not** `abort()`)
2. `mcpCloser?.()`
3. `openNewSession` — `newSessionRecord` mints a **new** id, `createSession`, `resolveIncludedAccess({ consumeCap: true })`
4. Reset the transcript / OpenTUI view
5. Notice `new session <shortSessionId>`

`openNewSession` does not `deleteSession` the previous row. The old transcript, pending asks, stream events, job row, and `raven/*` worktree stay on disk under the abandoned id. Mid-turn `/clear` replaces the runtime and does **not** call `abort()` first (`SLASH_COMMANDS.md`). That is survivable only because the abandoned `queryLoop` would persist onto the **old** id.

There is no `POST /v1/session/:id/clear`. Serve lists `GET` snapshot/stream and `POST` submit/cancel/compact/resolve (plus followup/edit/pr/diff). Schema stays **v10**. `recordCompact` inactivates message ids; `deleteStreamEventsBySession` exists inside `deleteSession` only; `SessionStore` has no conversation-wipe primitive.

This horizon **unparks only keep-id `/clear`**. Same `session.id`, empty conversation, no second included cap, no new serve route.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers. Clear is not a model turn and must not call `applyAskAnswer`.
2. Default prefix stays small and frozen. No new always-on tool. Clear is a **session op**, not a tool.
3. `dontAsk` never becomes `bypass`.
4. BYOK is the product. Ads never touch BYOK. Included resume stays fail-closed. Keep-id must not call `openNewSession` / `resolveIncludedAccess({ consumeCap: true })`.
5. Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
6. `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
7. Leftover-ask still wins rewind. Parent-tree-stop stays a different door. This horizon refuses `/clear` while an owned **child** unpaired pending ask exists; it does not abort, close, or abort-pair children.
8. Persist-first: disk must show the empty conversation before any host advertises empty UI. Persist fail leaves the old transcript on disk **and** in memory.
9. No schema bump. v10 columns already hold lastEnd / jobError / followup / todos / job / stream_events / pending_asks. Prefer `recordCompact`-all + upsert empty fields + delete this session’s pending_asks + delete this session’s stream_events.
10. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.

---

## Do not build

- Web chat UI, Next.js BFF, Prisma Task, Socket.IO
- `POST /v1/session/:id/clear` (and any other new serve route)
- Changing `openNewSession` to reuse an id (boot, ACP `session/new`, serve missing-session create, cron child stay mint-new)
- `deleteSession` + `createSession` of the same id (recursive child delete, drops job/rules/lock)
- Silently deleting a `raven/*` worktree, `exitSessionWorktree`, `git reset --hard`, force-push, or detaching `session.job`
- Parent-tree-stop / parent cancel abort-pairing a child leftover-ask
- Stream `version` / `continuationToken`
- Cancel with no live turn abort-pairing parked asks (idle leftover on **this** session is dropped by the wipe, not abort-paired)
- `abort('interrupt')` abort-pairing leftover-asks
- Schema version bump (no new column; v11 stays parked)
- Hard-`DELETE` of message rows (inactivate via `recordCompact`)
- Putting a clear marker in a new column
- Changing `TodoWrite` persist-then-file order
- Making `.ravenclaw/todo.json` the source of truth
- Auto-reset / todo restore / clear on `loadSession` / GET snapshot
- Default-on auto-commit / auto-PR

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

### Identity and notice

1. **Same `session.id` after `/clear` / `/new`.** Do not call `openNewSession`. Do not `createSession`. Do not `deleteSession`. Do not `engine.close()`. Do not `mcpCloser`. The live `SessionEngine` instance stays. Session lock stays. MCP stays. `createdAt`, `cwd`, `model`, `funding`, `permissionMode`, `prePlanMode`, `parentSessionId`, and `jobAutoCommit` stay.
2. **Notice is honest.** Engine success notice is `session cleared`. TUI host notice is `cleared session <shortSessionId>` of **this** id. Never `new session <other id>`. Never `new session <same id>` (the id is not new). Fail notices are the engine string as-is.

### Wipe vs keep

3. **Wipe / keep table (every cell is decided).**

| Cell | Decision |
|---|---|
| Transcript | **Inactivate** every **active** message via `recordCompact` (same as rewind/compact). Do **not** `DELETE FROM messages`. `loadMessages` / `loadSession` return `[]`. |
| `pending_asks` (this id) | **Delete** the rows. Not `applyAskAnswer`. Idle leftover on this session is dropped by the wipe, not abort-paired. |
| `pending_asks` (children) | **Leave.** Refuse clear if any child row is unpaired (ruling 10). |
| `followup` | **Wipe** (`undefined`). |
| `lastEnd` | **Wipe**. |
| `jobError` | **Wipe**. |
| `todos` | **Wipe** to `[]`. |
| `.ravenclaw/todo.json` | Re-project `[]\n` after a successful todos upsert. Root is `getSessionWorktree(id)?.originalCwd ?? session.cwd`. I/O throw → notice suffix `; todo.json write failed: <detail>`, `ok` stays `true`. |
| `fileHistory` | **Drop in-process generations** (`reset()`). Do **not** `undo()` files. Do **not** delete `~/.ravenclaw/file-history/<id>` backups. Next `/undo` is a no-op. |
| `compactGeneration` | If any id is inactivated, `recordCompact` at **`session.compactGeneration + 1`** with summary `'clear'` (PK is `(session_id, generation)`; rewind’s reuse of the current generation is not copied). No active messages → skip `recordCompact`, leave the number. |
| `stream_events` / `lastSeq` | **Delete** every row for this id. `lastStreamSeq` → `0`. Reconnect `?after=<old>` gets nothing. |
| `title` | **Wipe.** Next `submitMessage` retitles via existing `titleFromUserText` (`title === undefined \|\| title === ''`). |
| `usage` | **Zero** `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`. Display `/cost` only; not an included-cap refund. |
| `permissionMode` / `prePlanMode` | **Keep.** Same session, not a config-default new row. |
| `job` / worktree / `pendingResetSha` / `jobAutoCommit` | **Keep.** Do not refuse dirty. Do not reset HEAD. Do not remove `raven/<slug>`. Next submit still runs `maybeFinishRewindReset` if the flag is set. |
| Lock | **Keep.** Do not `releaseSessionLock`. |
| Children session rows | **Leave.** Do not recurse `deleteSession`. Do not clear `parentSessionId`. |
| This row’s `parentSessionId` | **Keep.** |
| `permission_rules` | **Keep** (`allow_always` belongs to the id). |
| Agent mail | **Drain** this id as part of the wipe write (old mailbox must not land on the first post-clear turn). Mail enqueued **after** a successful wipe is a later turn. |
| Engine / MCP | **Keep** the same instance and servers. Do not fire `SessionEnd`. `sessionStartDone` stays true (do not re-run `SessionStart`). |
| `tasks` | **Keep.** Do not `killAll`. `/tasks` still lists live Bash/Agent work. |
| In-memory steering | **Drain.** |
| Host `/queue` / `/loop` | **Keep** (host state; same as `/stop` today). |

4. **Job is chat-only wipe.** keep-id `/clear` MUST NOT silently delete a `raven/*` worktree, `exitSessionWorktree`, `git reset --hard`, or force-push. Dirty job is allowed. Detaching `session.job` is forbidden. The id is what serve / TUI reconnect / included cap already hold; throwing the worktree away would lie.

### Mid-turn

5. **`abort('cancel')` first, then wipe.** Today’s replace-runtime-without-abort is illegal on a kept id: the abandoned `queryLoop` would persist onto the same row after the wipe. `clearKeepId` must not persist the wipe while `liveTurn !== null`.
6. **Engine owns the wait.** If `liveTurn !== null`, `clearKeepId` calls `abort('cancel')` and waits until `submitMessage`’s `finally` has set `liveTurn = null` (cancel persist + this-session leftover abort-pair already ran). Then it wipes, including those cancelled rows. Do not use `abort('interrupt')`. Do not keep today’s close-without-abort.
7. **Refuse before abort when a child leftover would block the wipe** (ruling 10). Mid-turn `/clear` with an owned unpaired **child** ask is not a silent `/stop`. After settle, refuse again if a child unpaired ask remains.

### Children (tree-stop stays OUT)

8. **Do not invent parent-tree-stop.** Do not abort child engines. Do not abort-pair child leftover-asks. Do not close child pending rows from the parent.
9. **Leave child session rows.** They keep their transcripts, asks, and `parentSessionId`.
10. **Refuse `/clear` while any owned unpaired child pending ask exists.** Walk `listSessions({ parentSessionId: this.id })` then `listPendingAsks(child.id)`. Unpaired = no tool result for that `callId` on the child (same test rewind uses). Notice `pending permission ask`. No persist, no abort, no view reset. This-session leftover asks are **not** this refuse (ruling 3).

### Included cap and serve

11. **Must not consume another included-session cap.** No `openNewSession`. No `resolveIncludedAccess({ consumeCap: true })`. `funding` and `remainingSessions` stay as they are.
12. **No serve route this horizon.** There is no `POST /clear` today (`docs/headless.md`). Do not add `POST /v1/session/:id/clear`. The engine method is the host composition so serve can call it in a later door. ACP `session/new`, Slack, Discord, exec stay on their current mint/resume paths.

### Persist-first and schema

13. **One store write wipes disk.** Add `SessionStore.clearConversation` (no new column). Inside one `withWrite` / SQLite transaction:
    - `recordCompact(id, generation, 'clear', inactivatedIds)` when `inactivatedIds.length > 0` (FTS unindex stays on that path)
    - `DELETE pending_asks WHERE session_id = this`
    - `DELETE stream_events WHERE session_id = this`
    - drain agent mail for this id
    - `upsertSession` of the already-empty field record (same id; `job` still present when it was)
    Throw rolls the transaction back. Disk still has the old transcript, asks, stream, lastEnd, todos.
14. **Memory and UI flip only after that write resolves.** Then assign `messages = []`, the wiped session fields, `fileHistory.reset()`, drain steering, `userTurns = 0`. Then project `todo.json`. Hosts reset rows/view **only** when `{ ok: true }`.
15. **Persist fail does not flip.** `clearConversation` throw → `{ ok: false, notice: 'clear persist failed' }`. In-memory messages, session fields, fileHistory, and TUI rows stay pre-clear. If a live cancel already settled before the wipe, the cancelled turn is the honest leftover (same class as “cancel succeeded, clear did not”).
16. **No schema bump.** Schema stays v10. Do not add a cleared-at column. Do not hard-delete message rows. `compact_boundaries` may gain a `'clear'` generation; that table already exists.
17. **`inactivatedIds` come from disk.** `loadMessages(session.id)` (active only). Missing `loadMessages` → in-memory `messages`. `loadMessages` throw → persist failed, no wipe.

### What clear is not

18. **`applyAskAnswer` remains the leftover-ask closer.** Clear must not allow/deny/allow_always. Idle this-session asks are deleted with the wipe. Live this-session asks are abort-paired by the existing cancel path, then inactivated by the wipe.
19. **One `queryLoop`.** No web UI, no Next.js BFF, no Prisma Task, no Socket.IO.
20. **Other parallel doors stay OUT:** parent-tree-stop, stream `version` / `continuationToken`, cancel-without-live abort-pair, interrupt abort-pair, schema v11 as a standalone bump.
21. **This spec amends earlier OUT rulings for keep-id `/clear` only:** `2026-09-18-no-job-todo-revert.md` Do-not-build / Out “keep-id `/clear`”, and the same bullet on cancel-reset-followup, rewind-persist, job-host-state, and remaining-roadmap. Other parked doors stay closed.

---

## Per-slice board

Board as of `edeb611` on `main`. Combined waist `9901d0e`. Pre-ship “not on `main`” wording is historical.

| ID | Status vs tree |
|---|---|
| K0.1 docs point at this spec | **done** |
| K1.1 `FileHistory.reset` | **done** |
| K1.2 `SessionStore.clearConversation` (sqlite + memory) | **done** |
| K2.1 `clearKeepId` idle wipe + persist-fail | **done** |
| K2.2 mid-turn abort-then-wipe | **done** |
| K2.3 refuse child unpaired ask (before abort) | **done** |
| K2.4 job kept; todos/title/usage/followup/lastEnd wiped | **done** |
| K3.1 Ink + OpenTUI call `clearKeepId`; honest notice | **done** |
| K4.1 eval fixture | **done** |

---

## Waves

```
Wave K0  docs pointer
Wave K1  store + fileHistory primitive   (independent of engine)
Wave K2  engine.clearKeepId              (needs K1)
Wave K3  TUI hosts                       (needs K2)
Wave K4  eval lock
```

K1.1 may run with K1.2. Do not parallel K2.1 and K2.2 — same function, idle vs live order. K3 after K2.1 at least (hosts can stub live). K4 last.

---

## Wave K0 — Docs point here

### K0.1 Pointers

**Why.** ARCHITECTURE / README / SLASH_COMMANDS / remaining-roadmap / prior specs still say `/clear` mints a new id via `openNewSession`, or list keep-id `/clear` as OUT.

**Contract.**

- Mark this file as the next horizon from `2026-09-18-no-job-todo-revert.md`. Historical OUT lines stay; add a one-line amendment at the top / Do-not-build bullet. Do not rewrite shipped wave text.
- `SLASH_COMMANDS.md` / `.ko.md`: `/clear` / `/new` keeps `session.id`, wipes conversation, does not consume included cap, mid-turn is abort-then-wipe (not replace-runtime-without-abort). Session-surgery table: same id, empty transcript, files/job unchanged.
- `packages/cli/src/commands.ts` summary: no longer “start a new session”. Use keep-id wording (alias `/new` stays).
- `ARCHITECTURE.md` / `.ko.md`, `README.md`, `CHANGELOG.md` Unreleased, `docs/headless.md`: no new serve route; engine method is the composition. Do not document `POST …/clear`.

**Done when.** Those files link here. `/clear` is no longer described as `openNewSession` + new id.

---

## Wave K1 — Store and file-history primitive

Goal: one transactional wipe of disk conversation state; RAM file-history can drop generations without touching files.

### K1.1 `FileHistory.reset`

**Why.** Today’s new engine gets a fresh `createFileHistory(newId)`. Same id would otherwise `/undo` pre-clear edits from a conversation that no longer exists.

**Contract.**

```ts
export interface FileHistory {
  // existing methods…
  reset(): void
}
```

- `reset()` drops every generation including an open one. `peekLast()` → `undefined`. `pendingCount()` → `0`. `undo()` → `{ restored: [], removed: [] }` (not `blocked`).
- Does not read or write workspace files. Does not delete backup files under `file-history/<id>`.
- Existing undo/open-generation tests stay green.

**Files.** `packages/core/src/session/file-history.ts`, `file-history.test.ts`.

**Done when.** After snapshots + `reset()`, undo is a no-op and the workspace file is unchanged.

### K1.2 `clearConversation`

**Why.** Sequential `recordCompact` then `upsertSession` can leave inactive messages with a still-full session row. Ruling 13 requires one write.

**Contract.**

```ts
clearConversation(opts: {
  session: SessionRecord
  inactivatedIds: string[]
  generation: number
}): Promise<void>
```

- Same `session.id`. Upsert that record (caller already wiped lastEnd / followup / jobError / title / todos / usage).
- `inactivatedIds.length > 0` → `recordCompact(id, generation, 'clear', inactivatedIds)` (sqlite FTS unindex unchanged). Empty ids → no boundary row, no generation bump.
- Always: delete this session’s `pending_asks`, delete this session’s `stream_events`, drain this session’s agent mail, upsert the row.
- One `withWrite`. Sqlite: one `beginImmediate` transaction so a throw leaves messages active, asks present, stream seq unchanged, old lastEnd/todos.
- Does not `deleteSession`. Does not walk children. Does not touch permission_rules, locks, or other sessions’ asks/events.
- `createSession` of an existing id still throws `session exists` (unchanged).

**Files.** `packages/core/src/types.ts`, `packages/core/src/session/sqlite-store.ts`, `sqlite-store.test.ts`, `memory-store.ts`, `memory-store.test.ts`.

**Done when.** After a successful call, `loadSession` returns `messages: []`, wiped fields, kept `job` / id / `permissionMode`; `listPendingAsks` is `[]`; `lastStreamSeq` is `0`; child sessions and their asks remain. Stub/forced throw leaves the pre-call transcript and asks (sqlite + memory).

---

## Wave K2 — `engine.clearKeepId`

Goal: one engine op hosts call. Same id. Persist-first. Abort-then-wipe when live.

### K2.1 Idle wipe and persist-fail

**Contract.**

```ts
clearKeepId(): Promise<{ ok: true; notice: string } | { ok: false; notice: string }>
```

Add to `SessionEngine` / `createSessionEngine`.

```
if closed → { ok: false, notice: 'session closed' }
if unpaired child pending ask → { ok: false, notice: 'pending permission ask' }  // no persist
if liveTurn !== null → ruling 6 (K2.2)
re-check child unpaired asks
ids = loadMessages(id) ?? in-memory
generation = ids.length > 0 ? compactGeneration + 1 : compactGeneration
build next SessionRecord (ruling 3; same id / job / cwd / …)
store.clearConversation({ session: next, inactivatedIds: ids, generation })
on throw → { ok: false, notice: 'clear persist failed' }  // memory unchanged
assign memory (ruling 14)
projectSessionTodos(originalCwd ?? cwd, [])
on project throw → suffix notice; ok stays true
return { ok: true, notice: 'session cleared' }
```

- Closed engine: no persist.
- Empty transcript: still upserts wiped fields + deletes asks/stream (idempotent); `ok: true`.
- Do not call `applyAskAnswer`, `openNewSession`, `close`, `createSession`, `deleteSession`.

**Files.** `packages/core/src/types.ts`, `packages/core/src/loop/session-engine.ts`, `session-engine.test.ts`.

**Done when.** Idle session with messages + followup + lastEnd + todos + this-session pending ask + stream events: after `clearKeepId`, `loadSession` is empty conversation, same id, ask gone, `lastStreamSeq === 0`. Stub `clearConversation` throw: memory messages and `session.todos` unchanged, `ok: false`, notice `clear persist failed`.

### K2.2 Mid-turn abort-then-wipe

**Contract.** Live `submitMessage` + hung `askUser` / in-flight model: `clearKeepId` `abort('cancel')`s, waits for `liveTurn === null`, then wipes. Post-condition: no live turn, `loadMessages` is `[]`, this-session leftover row is gone (cancel abort-pair may have written `ABORTED_TEXT`; wipe inactivates it). `abort('interrupt')` is not used. A second `clearKeepId` while the first is waiting must not start a second wipe (serialize on the same engine; the second sees idle empty or in-flight wait then no-ops as empty).

**Done when.** That test is green. A test that would persist a tool result onto the same id after wipe must not be possible (generator finished before wipe).

### K2.3 Child unpaired refuse

**Contract.** Parent with a child session that has an unpaired leftover-ask: `clearKeepId` returns `{ ok: false, notice: 'pending permission ask' }` **before** `abort`. Parent `liveTurn` stays live if it was live. Parent messages unchanged. Child ask row unchanged. After the child ask is paired via `applyAskAnswer` (not via clear), `clearKeepId` may succeed and still leave the child session row.

**Done when.** That test is green. Existing parent-cancel-leaves-child-ask tests stay green.

### K2.4 Job kept; display fields wiped

**Contract.** Job session: after success, `session.job` (including `pendingResetSha` if set), `cwd`, worktree sidecar, and HEAD are unchanged. `session.todos` is `[]`. Project `todo.json` under `originalCwd ?? cwd` is `[]\n`. `title`, `usage`, `followup`, `lastEnd`, `jobError` wiped. Dirty worktree files stay dirty.

**Done when.** Unit test enters a worktree, dirties a file, sets todos/title/followup, `clearKeepId` → job + HEAD + dirty file kept, chat fields wiped.

---

## Wave K3 — TUI hosts

Goal: `/clear` / `/new` call the engine op. No new id. Honest notice.

### K3.1 Ink and OpenTUI

**Contract.**

- `case 'clear'` in `app.tsx` and `opentui-app.ts`: `await engine.clearKeepId()`. Do **not** `close()`, `mcpCloser`, or `openNewSession`.
- `{ ok: true }`: reset transcript/view (Ink: rows/todos/selection/expanded; OpenTUI: `view.reset()`). Notice `cleared session ${shortSessionId(engine.session.id)}`. Re-bind AskUser only if the host already did that for other session ops; the engine instance did not change. OpenTUI included ads may rewrite (same runtime).
- `{ ok: false }`: do **not** reset view. Print `result.notice`.
- `/new` stays an alias of `clear` (`commands.ts`).
- `openNewSession` remains for boot, ACP `session/new`, serve missing-session create, cron children.

**Files.** `packages/cli/src/app.tsx`, `opentui-app.ts`, `opentui-app.test.ts` (replace “new session newsessi” / new-engine assertion), `commands.ts`, `commands.test.ts` if the summary string is asserted.

**Done when.** OpenTUI `/clear` then a prompt submits on the **same** engine id. Notice contains `cleared session` and the same short id. Persist-fail stub leaves the previous view text.

---

## Wave K4 — Eval lock

### K4.1 Fixture

**Contract.** One eval case in `packages/core/src/eval/fixtures/`:

| Case | Assert |
|---|---|
| `keep-id-clear` | Same id after `clearKeepId`; `loadMessages` is `[]`; this-session pending ask gone; `lastStreamSeq === 0`; persist-fail stub leaves the last user; unpaired child ask refuses and leaves the parent transcript; job session keeps `session.job` |

**Files.** `packages/core/src/eval/run.ts`, `run.test.ts`, the fixture dir. Copy helpers locally in `run.ts`; do not import from test files. Unknown directory names still throw.

**Done when.** `bun test ./packages/core/src/eval/run.test.ts` fails if K2.1 / K2.3 / K2.4 or persist-fail regress.

---

## Out of this horizon

Web chat UI, Next.js BFF, Prisma Task, Socket.IO, y0 Shadow wiki / indexer, eve compiler, OpenAPI connections, memory slots, `defineState`, credential brokering, self-mod, any new chat network, sandbox network policy, Grep/Glob docker-exec, `ignored`, stream `version` / `continuationToken`, schema v11, async `createSessionEngine`, cancel-without-live abort-pair, interrupt abort-pair, parent-cancels-child-ask / parent-tree-stop, `POST /v1/session/:id/clear`, changing `openNewSession` mint behavior, hard-delete of message rows, deleting `raven/*` worktrees from `/clear`.

If a later product wants HTTP clear, it calls `engine.clearKeepId()` and adds a route in a new spec. It does not mint a new id.

---

## Suggested order

1. **K0.1** with the spec file.
2. **K1.1** and **K1.2** (primitives).
3. **K2.1 + K2.4** then **K2.3** then **K2.2** (idle + job first; refuse; then live abort-wait).
4. **K3.1** after K2.1.
5. **K4.1** last.

---

## Success checks

A slice that does not move one of these is out of scope.

1. `/clear` / `clearKeepId` keeps `session.id` and does not call `openNewSession` (K2, K3).
2. After success, `loadMessages` is `[]`, this-session `pending_asks` are gone, `lastStreamSeq === 0` (K1, K2.1).
3. Persist fail leaves the old transcript on disk and in memory; UI does not flip to empty (K1.2, K2.1).
4. Mid-turn clear aborts with `'cancel'`, waits for idle, then wipes; the abandoned turn cannot persist onto the kept id (K2.2).
5. Unpaired child leftover-ask refuses clear before abort; child row remains (K2.3).
6. Job worktree / `session.job` / dirty files survive; todos/title/usage/followup/lastEnd/jobError do not (K2.4).
7. Included cap is not consumed (no `consumeCap: true` on this path) (K3).
8. Eval fixture fails the runner if 2, 3, 5, or 6 regress (K4).

---

## Key decisions

1. **Theme is host-held id honesty, not a new session product.** Serve, TUI reconnect, and the included cap already key on `session.id`. Minting on `/clear` is the bug.
2. **Same engine, not close + reopen.** `close()` releases the lock and fires SessionEnd. Reopen via `openNewSession` consumes a cap and assigns a new id. `resumeRuntime` is for a different id. Wipe in place.
3. **Abort-then-wipe is required for keep-id.** Replace-without-abort only worked because writes landed on the abandoned id. Waiting is the engine’s job so every host gets it.
4. **Refuse child leftover rather than tree-stop.** Closing a child ask from the parent without aborting a live child turn is the half-measure the leftover-ask work already rejected. Empty parent chat that is still blocked by an invisible child ask would lie.
5. **Job stays; chat goes.** `/clear` is not `/rewind` and not worktree teardown. Dirty files and `pendingResetSha` are job state, not transcript.
6. **Inactivate, do not DELETE, do not bump schema.** `recordCompact` + existing nullable host-state columns are enough. A `'clear'` compact boundary is a generation, not a new table.
7. **One transactional store write.** Persist-fail must leave the old transcript, not a half-wiped row. That is stricter than rewind’s accepted compact-then-fail sliver, and it is required because the UI promise is “empty session.”
8. **No serve route this horizon.** The stolen eve contract is keep-id clear on the engine. Wiring HTTP is a later door that must call the same method.
9. **This spec amends earlier OUT rulings for keep-id `/clear` only.** Other parked doors stay closed.
