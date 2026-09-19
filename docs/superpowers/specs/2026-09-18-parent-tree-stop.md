# RavenClaw next-horizon roadmap (parent tree-stop)

Date: 2026-09-18  
Status: implemented  
Shipped on `main` at `9901d0e`.  
Reviewed against tree at `be5a4a7` (`main` after no-job todo revert).  
Successor to `2026-09-18-no-job-todo-revert.md` (Status: implemented at `be5a4a7`). Amends `2026-09-18-cancel-reset-followup.md` OUT for **parent-cancels-child-ask only**. Does not reopen that spec’s other closed doors.

Sources: current tree. No new steal from eve/y0.

Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not become a hosted Task runner. Do not add a web UI.

---

## Where we are

The waist is shipped: leftover-ask, session-as-job, job-host, persist-before-reset rewind, project `todo.json` projection, live cancel abort-pair (I2), reset-on-resume, follow-up persist-first, no-job todo revert.

I2 (`2026-09-18-cancel-reset-followup.md` ruling 1–7, shipped at `5eefdde`) abort-pairs leftover-asks only for **this** `session.id`, and only on a live `abort('cancel')`. The tree at `be5a4a7` still does all of the following:

| Piece | Tree at `be5a4a7` |
|---|---|
| Parent live `abort('cancel')` | Sets `liveTurn.cancelKind = 'cancel'`, `abortTurn`. Cancelled epilogue runs `listPendingAsks(session.id)` only. Persist-before-drop I2 law. |
| Child leftover-ask | Own `sessionId`. Test `parent cancel leaves a child leftover-ask` expects the child row to stay. |
| `listOwnedPendingAsks` | `listPendingAsks(this)` plus **one** `listSessions({ parentSessionId })` level. Used by `submitMessage`, `rewindLast`, `replayPendingAsks`, `maybeRunFollowup`, serve snapshot / parked-ask publish. |
| `applyAskAnswer` | Settles a child row onto the child session only when `child.parentSessionId === this.id` (one hop). |
| Idle parent `abort('cancel')` | No live turn → no I2. `no_active_turn` on serve. This session’s parked asks stay. Descendants untouched. |
| In-process child engine | `spawnChild` → `createSessionEngine` (sync). Foreground: `linkEngineAbort` calls `child.abort()` with **no kind** (interrupt). Background: `attachEngine` is steer-only; parent `abort` does not touch it. |
| `listSessions({ parentSessionId })` | Store API is one-level equality. Product spawn denies nested `Agent` (`NESTING_DENIED`). The filter is not a tree walk. |
| `createSessionEngine` | Sync `function …: SessionEngine`. `abort(kind?): void`. |

After I2, parent live cancel cleans **parent** leftover-asks. Parent rewind / follow-up / next submit still call `listOwnedPendingAsks`, so a parked **child** ask still blocks the parent. That is the hole.

This horizon **unparks only parent-cancels-child-ask**, and it unparks it as **tree-stop**, not leftover-only. It does not unpark cancel-without-live abort-pair of **this** session’s parked asks, interrupt abort-pair, keep-id `/clear`, or stream `version` / `continuationToken`.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer **for operator answers**. Tree-stop abort-pair is a side effect of `abort('cancel')`, not a fourth host entry and not a model turn.
2. Default prefix stays small and frozen. No new always-on tool.
3. `dontAsk` never becomes `bypass`.
4. BYOK is the product. Ads never touch BYOK.
5. Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
6. `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
7. Leftover-ask still wins rewind: `rewindLast` refuses when any **owned unpaired** pending ask remains **after** the tree-stop walk.
8. Edit-resubmit stays host composition (`rewindLast` then `submitMessage`).
9. `createSessionEngine` stays `export function createSessionEngine(...): SessionEngine`. Do not make it async.
10. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.

---

## Do not build

- Web chat UI, Next.js BFF, Prisma Task, Socket.IO
- **keep-id `/clear`** (parallel door; stays OUT)
- **stream `version` / `continuationToken`** (parallel door; stays OUT)
- `ignored` as a leftover-ask result
- Cancel with no live turn abort-pairing **this** session’s parked asks (`no_active_turn` on a truly idle parent stays a no-op for *this* row)
- `abort('interrupt')` abort-pairing leftover-asks (steer ≠ cancel)
- Half-door: drop descendant leftover-asks while that descendant’s `liveTurn` still runs
- Schema version bump (no new column; v11 stays parked)
- Making `createSessionEngine` async
- New host verb / new serve route / new slash (TUI `/stop` `/cancel` and `POST …/cancel` stay)
- Using `tasks.killAll()` as tree-stop (OpenTUI double-stop kill stays a separate host behavior)
- Changing `linkEngineAbort` into the cancel path (it stays interrupt fan-out for steer)
- Inventing a parent or child `lastEnd` when that session had no live turn
- Changing `TodoWrite` persist-then-file, no-job rewind order, or making `todo.json` the source of truth
- Default-on auto-commit / auto-PR

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

### Tree-stop, not leftover-only

1. **Full tree-stop.** Parent `/stop` / `POST …/cancel` / `engine.abort('cancel')` means: abort each descendant engine’s live turn with `abort('cancel')`, **and** persist-before-drop that descendant’s leftover-asks (I2 law). Dropping child asks while the child `liveTurn` still runs is forbidden. Steer (`abort('interrupt')`) is not tree-stop.

2. **Walk all descendants.** `listSessions({ parentSessionId })` is a one-level **filter**, not a product law that the tree is one-level. Product spawn currently denies nested `Agent` (`NESTING_DENIED` in `packages/core/src/agent/definition.ts`), but a store row may still point at a child (tests, future spawn, manual insert). Export one helper:

   ```ts
   export async function listDescendantSessionIds(
     store: { listSessions(filter: { parentSessionId: string }): Promise<Array<{ id: string }>> },
     sessionId: string,
   ): Promise<string[]>
   ```

   BFS. Each step `listSessions({ parentSessionId })` with **no `limit`**. `seen` set (skip already visited; a `parentSessionId` cycle must not loop). Do not include `sessionId` itself. `listOwnedPendingAsks` (exported from `followup.ts` **and** the engine-local copy) becomes own rows plus leftover-asks on every id from this helper. Serve `publishParkedAsks` / `collectSnapshotPendingAsks` use the same helper. One walk, four callers.

### How a child live turn dies

3. **In-process child engines must be abortable from the parent engine.** `abort('cancel')` stays `void` (type unchanged). Sync work, in this order:

   1. For every registered descendant engine, call `child.abort('cancel')` **before** this session’s `abortTurn`. First writer of `liveTurn.cancelKind` wins (`if (cancelKind === undefined)`). Registry-first so `linkEngineAbort`’s later `child.abort()` (no kind → interrupt) cannot overwrite `cancelKind = 'cancel'`.
   2. If this session has a `liveTurn`, set `cancelKind = 'cancel'` and `abortTurn` (existing I2).
   3. Start or chain `treeStopFlight` (ruling 5). Do not persist leftover-asks inside the sync function.

   **Registry.** `ToolContext` grows `registerChildEngine?(engine: SessionEngine): () => void`. Parent `createSessionEngine` owns a process-local `Map<childSessionId, SessionEngine>` and passes the registrar. `spawnChild` (`packages/core/src/tools/agent.ts`) calls it immediately after `createSessionEngine` for **both** foreground and background children, and unregisters in `finally` after `engine.close`. `createSessionEngine` stays sync. `TaskRegistry.attachEngine` stays steer-only. Do **not** use `tasks.killAll()` for tree-stop.

   **`linkEngineAbort` stays.** Parent steer still fans out as interrupt. Do not teach `abortTurn` a cancel reason (`abortTurn` still `controller.abort('interrupt')`).

   **After process death** there is no child `liveTurn` and the map is empty. Still run ruling 5 against descendant session ids in the store.

   **Serve-opened child runtimes** live in `createServeRuntimeCaches` (`sessionEngines` / `turnEngines`), not in the parent registry. On an accepted parent cancel, serve also `abort('cancel')`s any cached runtime whose session id is in `listDescendantSessionIds`. Same process, different map entry. No new route.

### Idle parent is still tree-stop of descendants

4. **Parent `/stop` with no parent live turn but live or pending children still walks the tree.** This is **not** cancel-without-live for *this* session’s parked asks. That door stays closed. Eval beat `cancel-abort-pair` idle (this session parked, no children) stays green.

   **`abort('cancel')` stays `void`.** Persist is async (`treeStopFlight`). New engine method, not a host verb:

   ```ts
   whenTreeStop(): Promise<{ descendantWork: boolean }>
   ```

   Returns the in-flight tree-stop (or `{ descendantWork: false }` if none). `descendantWork` is true iff this cancel aborted at least one registered/serve descendant `liveTurn` **or** persist-before-dropped (or attempted) at least one descendant leftover-ask row. `submitMessage`, `rewindLast`, and `maybeRunFollowup` await `whenTreeStop()` **before** they call `listOwnedPendingAsks`. Same class as `maybeFinishRewindReset`: already-async points, not `createSessionEngine`, not `loadSession`, not GET snapshot.

   **Serve `POST /v1/session/:id/cancel` envelope (always HTTP 200 on the success path; no new status string):**

   | Case | Body | Side effects |
   |---|---|---|
   | Invalid JSON body | 400 `{ error: 'invalid json' }` | none |
   | `turnId` provided **and** parent `liveTurnId() !== null` **and** `turnId !== live` | `{ ok: true, status: 'no_active_turn' }` | no abort, no walk (reconnect guard for a **live** parent turn) |
   | Parent live, and (`turnId` omitted or `turnId === live`) | `{ ok: true }` | `abort('cancel')`; this-session I2 in the cancelled stream; descendant tree-stop |
   | Parent idle, no descendant leftover-asks, no in-process descendant `liveTurn` (registry + serve cache) | `{ ok: true, status: 'no_active_turn' }` | no walk; **this** session’s parked asks stay |
   | Parent idle, descendant leftover-asks and/or in-process descendant `liveTurn` | `{ ok: true }` | `abort('cancel')`, **await** `whenTreeStop()`, then write the body. No `status` field. No parent `lastEnd`. |

   `turnId` does **not** block idle tree-stop. A body `{ turnId: "<ended turn>" }` on an idle parent with descendant work is `{ ok: true }` and walks. Clients that always echo the last `turnId` can still tree-stop after the parent turn ended. Stale `turnId` only protects a **different live** parent turn.

   TUI `/stop` `/cancel` still call `abort('cancel')`. No new slash. Notice: `stopped` if the parent was live **or** `whenTreeStop()` reports `descendantWork`; else `nothing to stop`. OpenTUI double-stop `killAll` is unchanged and is not tree-stop.

   ACP `session/cancel` already exists. It must call `abort('cancel')` (today `packages/acp/src/server.ts` and `packages/cli/src/acp-stdio.ts` call `abort()` with no kind → interrupt). Not a new verb; the cancel route must mean cancel.

### Persist-before-drop (I2 law, per descendant row)

5. **Same I2 law, per descendant row, never a second tool row.** For each leftover-ask whose `sessionId` is a descendant (not this session):

   - Already transcript-paired on **that** session (`isCallPaired(callId, row.sessionId)` / `loadMessages(row.sessionId)`): drop only (`deletePendingAsk`).
   - Unpaired: `persistToolResults(row.sessionId, [makeToolMessage(callId, false, ABORTED_TEXT)])` then drop. Same text as today (`aborted: the turn was interrupted before this tool finished.`). Do not execute the tool. Do not write `permission_denied`. Do not splice the tool row into the **parent** transcript (`persistSettledTool` already no-ops parent `messages` when `targetSessionId !== session.id`).
   - Persist fail on one row: leave **that** row; continue the other rows and the other descendants. Delete fail after a successful persist: leave the row (same as I2).
   - At most one `ABORTED_TEXT` tool result per `callId`.

   **Who writes.** This session’s leftover-asks stay owned by the existing cancelled-epilogue I2, and **only** when this session had a live turn. Idle parent tree-stop must not touch this session’s parked asks.

   Descendant leftover-asks are owned by `treeStopFlight`:

   1. Await registered (and serve-aborted) descendant engines until `liveTurnId() === null` (join their cancelled epilogue). A descendant that was live runs **its own** I2 first.
   2. Then walk leftover-asks on descendant session ids. Already paired → drop only. Still unpaired (idle child, process death, child I2 persist-fail) → persist-before-drop here.

   Do not persist-before-drop a descendant row while that descendant’s in-process `liveTurn` is still set.

   **Coalesce.** A second `abort('cancel')` while a flight is running still abort()s any newly registered children, then chains another persist pass after the current flight.

   **Stream.** Parent cancelled stream emits `cancelled, ask still pending` only if some **owned unpaired** row remains after this session’s I2 **and** `treeStopFlight` (own + all descendants). Idle parent has no parent stream; serve JSON does not grow a status line. A descendant that had its own live stream may emit the line on **that** stream if its own I2 left a row; the parent walk then retries.

### lastEnd

6. **Parent `lastEnd`.** Live parent cancel: `lastEnd.reason` stays `cancelled` (existing persistable write). Idle parent tree-stop: do **not** invent a parent `lastEnd`, do **not** `upsertSession` just to stamp one, do **not** clear follow-up via `CLEAR_REASONS` (there is no new `lastEnd`, so `runFollowupAfterSubmit` stays `skipped` unless a later real turn writes one).

7. **Child `lastEnd`.** If that child’s live turn was aborted, its own cancelled epilogue writes `cancelled` (existing). If the walk only abort-paired leftover-asks on an idle / dead child, do **not** invent a child `lastEnd` and do not upsert the child session row for that purpose.

### Closer, surfaces, rewind

8. **`applyAskAnswer` remains the operator closer** for leftover-asks the walk failed to drop. Extend `resolveAskTarget`: a row matches if `row.sessionId === this.id` **or** `row.sessionId` is in `listDescendantSessionIds(this.id)`. Replace the one-hop `child.parentSessionId !== session.id` reject. Persist / execute still target `row.sessionId` (already true for one-hop children). Crash-resolve after process death is still pair-or-execute on the descendant session. Cancel does not start a model turn.

9. **No schema bump. No web UI. No interrupt abort-pair. No cancel-without-live abort-pair of this session’s parked asks.**

10. **Same routes.** TUI `/stop` `/cancel`, serve `POST …/cancel`, ACP `session/cancel`. No new host verb. `whenTreeStop` is an engine join point, like `maybeFinishRewindReset`.

11. **Leftover-ask still wins rewind** if any owned unpaired row remains after `whenTreeStop()` + the walk. Existing `a turn is in progress` (parent `liveTurn` or `tasks.list()` running `type === 'agent'`) stays. Tree-stop does not `killAll`. After a child’s live turn clears, `spawnChild`’s existing `.then` still `tasks.complete`. Tests drain that microtask; do not add a new rewind rule.

12. **Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main`.**

13. **This spec amends earlier OUT rulings** for parent-cancels-child-ask only: `2026-09-18-cancel-reset-followup.md` ruling 2 / I2.3 / Do-not-build “Parent cancel abort-pairing a child leftover-ask”, and the same bullet on `2026-09-18-no-job-todo-revert.md`. Other parked doors stay closed.

---

## Per-slice board

Board as of `9901d0e` on `main`. Pre-ship “not on `main`” wording is historical.

| ID | Status vs tree |
|---|---|
| K0.1 docs point at this spec | **done** |
| K1.1 `listDescendantSessionIds` BFS + `listOwnedPendingAsks` recursive | **done** |
| K1.2 `applyAskAnswer` accepts any descendant | **done** |
| K1.3 serve snapshot / parked-ask publish use the same walk | **done** |
| K2.1 `registerChildEngine` + parent `abort('cancel')` aborts in-process children first | **done** |
| K2.2 serve cache aborts descendant runtimes | **done** |
| K2.3 `abort('interrupt')` / `linkEngineAbort` unchanged | **done** |
| K3.1 live parent cancelled epilogue + `treeStopFlight` persist-before-drop descendants | **done** |
| K3.2 idle parent tree-stop; this session’s parked asks stay | **done** |
| K3.3 persist-fail on one descendant continues the others | **done** |
| K3.4 lastEnd: live parent `cancelled`; idle parent / idle child invent nothing | **done** |
| K4.1 serve envelope (ruling 4 table) | **done** |
| K4.2 TUI notice + ACP `abort('cancel')` | **done** |
| K5.1 eval fixture | **done** |

---

## Waves

```
Wave K0  docs pointer
Wave K1  descendant walk + owned asks + applyAskAnswer
Wave K2  in-process child abort('cancel')
Wave K3  persist-before-drop descendants (live + idle)
Wave K4  serve envelope + host notice
Wave K5  eval lock
```

K1 before K2/K3 (the walk is shared). K2 before K3.3’s “wait for child liveTurn to clear” (needs the registry). K4 after K3.2 (idle envelope). K5 last. Do not implement on `main`.

---

## Wave K0 — Docs point here

### K0.1 Pointers

**Why.** ARCHITECTURE / README / remaining-roadmap / cancel-reset / no-job still say parent cancel leaves a child leftover-ask, or list parent-cancels-child as OUT.

**Contract.**

- Mark this file as the next horizon from `2026-09-18-no-job-todo-revert.md`, `2026-09-18-cancel-reset-followup.md` (OUT “parent-cancels-child-ask” becomes “amended by this spec”), `2026-09-12-ravenclaw-remaining-roadmap.md`, `ARCHITECTURE.md` / `.ko.md`, `README.md`, `SLASH_COMMANDS.md` / `.ko.md`, `docs/headless.md`.
- Historical OUT lines stay; add a one-line amendment. Do not rewrite shipped I2 / J-wave text.
- Do not claim a web UI. Do not reopen keep-id `/clear` or stream `version` / `continuationToken`.

**Done when.** Those files link here. Parent `/stop` is no longer described as “this session only.”

---

## Wave K1 — Descendant walk

Goal: every “owned ask” reader sees the same recursive set. No abort behavior yet.

### K1.1 `listDescendantSessionIds` + recursive `listOwnedPendingAsks`

**Why.** Today both the exported helper and the engine-local copy walk one hop. A grandchild leftover-ask would not block rewind/submit/follow-up, and would not be tree-stopped later.

**Contract.**

- Implement ruling 2 in `packages/core/src/session/followup.ts`. Engine-local `listOwnedPendingAsks` in `session-engine.ts` calls the export (delete the forked one-hop body).
- Test: parent → child → grandchild leftover-ask is in `listOwnedPendingAsks(parent)`.
- Test: a `parentSessionId` cycle does not hang (seen-set).
- Existing one-hop follow-up test (`skips and keeps the slot when a child leftover-ask is parked`) stays green.

**Files.** `packages/core/src/session/followup.ts`, `followup.test.ts`, `packages/core/src/loop/session-engine.ts`.

**Done when.** Injected grandchild ask is owned. `listSessions` is still the one-level store API; the walk is the caller’s job.

### K1.2 `applyAskAnswer` descendant match

**Contract.** `resolveAskTarget` uses `listDescendantSessionIds`. A grandchild leftover-ask `applyAskAnswer` on the parent persists onto the grandchild session and returns `matched`. A row whose session is not this id and not a descendant stays `unmatched`. One-hop child tests stay green.

**Files.** `packages/core/src/loop/session-engine.ts`, `session-engine.test.ts`.

**Done when.** Parent `applyAskAnswer` on a grandchild `callId` writes the tool row on the grandchild session, not the parent transcript.

### K1.3 Serve snapshot / parked publish

**Contract.** `publishParkedAsks` and `collectSnapshotPendingAsks` walk `listDescendantSessionIds` (or `listOwnedPendingAsks`). Grandchild asks appear with `childSessionId`. No new route.

**Files.** `packages/cli/src/serve.ts`, `serve.test.ts`.

**Done when.** GET snapshot pending list includes a grandchild leftover-ask.

---

## Wave K2 — Abort in-process descendant live turns

Goal: parent `abort('cancel')` cancels child engines that exist in this process. Persist is K3.

### K2.1 Registry + cancelKind wins

**Contract.**

- `ToolContext.registerChildEngine` + parent map (ruling 3).
- `spawnChild` registers foreground and background children; unregisters after close.
- Parent `abort('cancel')` calls `child.abort('cancel')` **before** `abortTurn(parent)`.
- Test: parent live + child live (hang `askUser` or hang stream) → parent `abort('cancel')` → child `round_end.reason === 'cancelled'` (not `aborted`). `createSessionEngine` stays a sync function.

**Files.** `packages/core/src/types.ts`, `packages/core/src/loop/session-engine.ts`, `packages/core/src/tools/agent.ts`, `session-engine.test.ts`, `packages/core/src/tools/agent.ts` tests if present.

**Done when.** A live child turn ends `cancelled` when the parent cancels. Steer still ends the child `aborted`.

### K2.2 Serve descendant runtimes

**Contract.** On an accepted parent cancel (ruling 4 live or idle-with-work rows), serve `abort('cancel')`s cached runtimes in `listDescendantSessionIds`. A child session opened via `runtimeForSessionId` does not keep running after parent cancel.

**Files.** `packages/cli/src/serve.ts`, `serve.test.ts`.

**Done when.** Two cached runtimes (parent + child); parent cancel aborts the child runtime.

### K2.3 Interrupt unchanged

**Contract.** `abort('interrupt')` does not start `treeStopFlight`, does not walk leftover-asks, does not call `child.abort('cancel')`. Existing interrupt leftover-ask test stays green. `linkEngineAbort` still `engine.abort()` with no kind.

**Done when.** That test is still green and a new test shows parent interrupt leaves a child leftover-ask.

---

## Wave K3 — Persist-before-drop descendants

Goal: after tree-stop, owned unpaired leftover-asks are gone when persist/drop succeeded. This session’s idle parked asks stay.

### K3.1 Live parent + child leftover-ask

**Contract.**

- Replace `session-engine.test.ts` `parent cancel leaves a child leftover-ask` with: parent live, child leftover-ask (real `tool_use` + hang `askUser` on the child **or** a parked child row plus registered/idle child), `abort('cancel')`, drain parent. Expect child pending length 0, **exactly one** `ABORTED_TEXT` on the **child** session, none extra on the parent, no `cancelled, ask still pending` when the walk succeeded.
- Parent `lastEnd.reason === 'cancelled'`.
- `whenTreeStop()` resolves with `descendantWork: true`.
- Flip I2.3’s “child ask unchanged” claim; do not keep the old expect as the happy path.

**Files.** `packages/core/src/loop/session-engine.ts`, `session-engine.test.ts`.

**Done when.** That replacement test is green. This-session I2 happy path (`live cancel abort-pairs a leftover-ask…`) stays green.

### K3.2 Idle parent tree-stop

**Contract.**

- Idle parent, child leftover-ask, no parent live turn: `abort('cancel')` + `await whenTreeStop()` → child row gone (persist-before-drop on child id), parent parked ask (if any) **stays**, parent `lastEnd` unchanged / unset, child `lastEnd` unchanged if the child had no live turn.
- Idle parent, **only** this session’s parked ask, no descendants: `abort('cancel')` + `whenTreeStop()` → `{ descendantWork: false }`, this row stays. Existing `cancel with no live turn does not drop leftover-asks` stays green.

**Done when.** Both tests are green.

### K3.3 Persist-fail continues

**Contract.** Two descendant leftover-asks. Stub persist on child A to throw; child B succeeds. A remains; B is gone with one `ABORTED_TEXT`. Parent live stream emits `cancelled, ask still pending` because an owned unpaired row remains. A third descendant is still walked. `applyAskAnswer` on A still matches (ruling 8).

**Done when.** That test is green.

### K3.4 lastEnd

**Contract.** Pin ruling 6–7 with explicit tests: live parent writes `cancelled`; idle parent tree-stop does not upsert a parent `lastEnd`; idle child leftover-only does not upsert a child `lastEnd`; live child abort writes `cancelled` on the child session.

**Done when.** Those four expects exist and are green.

---

## Wave K4 — Serve envelope and host notice

### K4.1 Serve table

**Contract.** Implement the ruling 4 table in `packages/cli/src/serve.ts`. Await `whenTreeStop()` only on the idle-with-descendant-work row (live parent persist stays in the stream; do not delay `{ ok: true }` on the live path). Stale `turnId` while parent is live is still a no-op. Idle + stale `turnId` + descendant work is `{ ok: true }` and walks.

**Files.** `packages/cli/src/serve.ts`, `serve.test.ts`.

**Done when.** Four new (or rewritten) serve tests match the four success-path rows of the table. Existing stale-live-turnId test stays green.

### K4.2 TUI + ACP

**Contract.**

- Ink and OpenTUI `/stop`: still `abort('cancel')`. Notice `stopped` vs `nothing to stop` follows ruling 4 (await `whenTreeStop` in the already-async OpenTUI path; Ink stop handler may become async). Double-stop `killAll` unchanged.
- ACP `session/cancel` and `acp-stdio` wrap call `abort('cancel')`.

**Files.** `packages/cli/src/app.tsx`, `packages/cli/src/opentui-app.ts`, `packages/acp/src/server.ts`, `packages/cli/src/acp-stdio.ts`, their tests.

**Done when.** ACP cancel test asserts `abort` was called with `'cancel'`. Idle parent + child ask `/stop` does not print `nothing to stop`.

---

## Wave K5 — Eval lock

### K5.1 Fixture

**Contract.** One eval case in `packages/core/src/eval/fixtures/` (name `parent-tree-stop`):

| Beat | Assert |
|---|---|
| Live parent + child leftover-ask + `abort('cancel')` | Child pending empty; exactly one child `ABORTED_TEXT`; parent this-session I2 still holds |
| Idle parent + child leftover-ask | Child pending empty after `whenTreeStop()`; parent `lastEnd` unset |
| Idle parent + this-session parked ask, no children | Row remains (do not regress I2 idle) |
| Persist-fail on one of two children | Failed row remains; other gone; `applyAskAnswer` still matches the failed row |

Copy helpers locally in `run.ts`; do not import from test files. Unknown directory names still throw. Existing `cancel-abort-pair` stays and still fails the runner if this-session I2 regresses.

**Files.** `packages/core/src/eval/run.ts`, `run.test.ts`, the fixture dir.

**Done when.** `bun test ./packages/core/src/eval/run.test.ts` fails if K3.1, K3.2, or K3.3 regress.

---

## Out of this horizon

Web chat UI, Next.js BFF, Prisma Task, Socket.IO, y0 Shadow wiki / indexer, eve compiler, OpenAPI connections, memory slots, `defineState`, credential brokering, self-mod, any new chat network, sandbox network policy, Grep/Glob docker-exec, `ignored`, **keep-id `/clear`**, **stream `version` / `continuationToken`**, schema v11, async `createSessionEngine`, cancel-without-live abort-pair of **this** session’s parked asks, interrupt abort-pair, using `killAll` as tree-stop, no-job git checkpoint, `fileHistory` todo frames.

If a later product wants nested `Agent` spawn, the walk already treats grandchildren as owned. This horizon does not lift `NESTING_DENIED`.

---

## Suggested order

1. **K0.1** with the spec file.
2. **K1.1** then **K1.2** then **K1.3**.
3. **K2.1 + K2.3** then **K2.2**.
4. **K3.1 + K3.4** then **K3.2** then **K3.3**.
5. **K4.1** then **K4.2**.
6. **K5.1** last.

---

## Success checks

A slice that does not move one of these is out of scope.

1. Parent live cancel abort-pairs a child leftover-ask onto the child session with exactly one `ABORTED_TEXT` (K3.1).
2. Idle parent cancel abort-pairs descendant leftover-asks and does **not** drop this session’s parked asks (K3.2).
3. Persist-fail on one descendant leaves that row and continues the others; stream says `cancelled, ask still pending` only if an owned unpaired row remains (K3.3).
4. In-process child live turn ends `cancelled` on parent `abort('cancel')`; interrupt does not abort-pair (K2).
5. Serve idle parent + descendant work is `200 { ok: true }`; idle parent + no descendant work is `200 { ok: true, status: 'no_active_turn' }`; stale `turnId` while parent is live is still `no_active_turn` (K4.1).
6. `listOwnedPendingAsks` / rewind / follow-up / submit see recursive descendants; leftover-ask still wins rewind if any owned unpaired row remains after the walk (K1, ruling 11).
7. Eval fixture fails the runner if 1, 2, or 3 regress (K5).

---

## Key decisions

1. **Theme is tree-stop, not leftover-only and not cancel-without-live.** Half-door (drop child asks, leave child `liveTurn`) is a lie. Idle parent still walks **descendants** only; this session’s parked asks stay behind the I2 live-only door.
2. **Store `listSessions` is one-level; the walk is not.** Product spawn currently cannot nest `Agent`. The helper still BFS until a level is empty so owned-ask, rewind, and tree-stop agree on grandchildren.
3. **Parent engine aborts in-process children; the store walk abort-pairs the dead ones.** `registerChildEngine` + serve cache cover live engines. Process death has no `liveTurn`; persist-before-drop still runs on descendant ids.
4. **`abort` stays `void`; `whenTreeStop` is the join.** Same pattern as `maybeFinishRewindReset`. Serve awaits it only on the idle-with-work row so `{ ok: true }` is not a lie. `createSessionEngine` stays sync.
5. **No new HTTP status.** `{ ok: true }` means this cancel stopped something (parent live turn and/or descendants). `no_active_turn` means this cancel stopped nothing. `tree_stopped` would be a new host contract for no gain.
6. **`turnId` guards a live parent turn, not idle tree-stop.** Echoing the last ended `turnId` must still be able to stop leftover children.
7. **I2 law is per descendant row, persist-before-drop, continue on fail.** Child I2 (if that child was live) runs first; the parent walk is the idle / crash / persist-fail sweeper. `applyAskAnswer` is the operator closer and now matches any descendant.
8. **This spec amends cancel-reset OUT for parent-cancels-child-ask only.** keep-id `/clear` and stream `version` / `continuationToken` stay the other two parallel doors, still OUT.
