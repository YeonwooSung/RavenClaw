# RavenClaw next-horizon roadmap (leftover-ask abort-pair completeness + cancel 202/200)

Date: 2026-09-20  
Status: implemented  
Shipped sha: not yet on `main` (this worktree).  
Reviewed against tree at `a707249` (`origin/main`, waist closed).  
Successor to `2026-09-18-parent-tree-stop.md` (Status: implemented at `9901d0e`). Amends that spec’s OUT for **cancel-without-live of this session’s parked asks**, **interrupt abort-pair**, and **cancel HTTP 202/200** only. Does not reopen tree-stop of descendants, keep-id `/clear`, or stream `version` / `continuationToken`.

Implementation plan: [2026-09-20-leftover-ask-abort-pair.md](../plans/2026-09-20-leftover-ask-abort-pair.md).

Sources: current tree. No new steal from eve/y0.

Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not become a hosted Task runner. Do not add a web UI.

---

## Where we are

The waist is shipped: leftover-ask, session-as-job, job-host, persist-before-reset rewind, project `todo.json` projection, live cancel abort-pair (I2), reset-on-resume, follow-up persist-first, no-job todo revert, stream version / `continuationToken`, keep-id `/clear`, parent tree-stop.

I2 (`2026-09-18-cancel-reset-followup.md`) abort-pairs leftover-asks of **this** `session.id` on a **live** `abort('cancel')` only. Tree-stop (`2026-09-18-parent-tree-stop.md`) walks **descendants** on `abort('cancel')` whether or not this session is live. The tree at `a707249` still does all of the following:

| Piece | Tree at `a707249` |
|---|---|
| Live `abort('cancel')` | Sets `liveTurn.cancelKind = 'cancel'`, `abortTurn`. Cancelled epilogue (`session-engine.ts` ~908–934) I2s `listPendingAsks(session.id)` then `await whenTreeStop()`. |
| Idle `abort('cancel')` | Starts `treeStopFlight` of descendants. **Does not** I2 this session. Test `cancel with no live turn does not drop leftover-asks` locks the row. Serve idle + no descendant work is `{ ok: true, status: 'no_active_turn' }`. |
| `abort('interrupt')` | Steer-not-cancel. Sets `cancelKind` + `abortTurn` if live. **Does not** start `treeStopFlight`. **Does not** I2 this session. Tests `interrupt leaves a leftover-ask` and `parent interrupt leaves a child leftover-ask` lock the rows. |
| `whenTreeStop()` | `Promise<{ descendantWork: boolean }>`. Persist of descendant leftover-asks starts when this is **awaited**, not inside sync `abort`. Returns `{ descendantWork: false }` if no flight. |
| `persistBeforeDropAsk` | Existing I2 helper (paired → drop-only; unpaired → persist `ABORTED_TEXT` then drop). Used by `treeStopFlight`. Cancelled epilogue still inlines `persistSettledTool`. |
| Serve `POST …/cancel` | Always HTTP **200** on the success path. Live: `abort('cancel')`, no join, `{ ok: true }`. Idle + descendant work: abort, await `whenTreeStop()`, `{ ok: true }`. Idle + nothing: `{ ok: true, status: 'no_active_turn' }`. Stale `turnId` while parent live: 200 `no_active_turn` (reconnect guard; no walk). |
| `probeIdleCancel` | Walks **descendant** leftover-asks, cached descendant `liveTurn`, `hasDescendants`. Does **not** count `listPendingAsks(this session)`. |
| Submit | Already **202** `{ accepted: true, sessionId }` (fire-and-forget). Do not change. |
| `createSessionEngine` | Sync `function …: SessionEngine`. `abort(kind?): void`. Schema **v10**. No `POST /clear`. |

Three parked items share `SessionEngine.abort`, `persistBeforeDropAsk`, `whenTreeStop`, and the serve cancel handler. This horizon unparks all three as **one door**.

---

## Constraints (unchanged except these three holes)

1. One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer **for operator answers**. Abort-pair is a side effect of `abort`, not a fourth host entry and not a model turn.
2. Default prefix small and frozen. No new always-on tool.
3. `dontAsk` never becomes `bypass`.
4. BYOK. Ads never touch BYOK.
5. Clean-room. No vendor copy. **No web UI, no Next.js BFF, no Prisma Task, no Socket.IO, no wiki, no Grep/Glob docker-exec, no `ignored`.**
6. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on main. Do not implement in this worktree as part of writing this spec.

---

## Do not build

- Web chat UI, Next.js BFF, Prisma Task, Socket.IO
- wiki / isolation-trust / Workflow loop / agent compiler / `ignored` / Grep/Glob docker-exec
- Schema v11 / async `createSessionEngine` / compact-then-die sliver fill
- HTTP `POST /clear` (keep-id `/clear` already shipped as an engine method; no new route)
- Making `abort` async
- Using `killAll` as tree-stop
- Changing tree-stop of descendants (parent-tree-stop stays: cancel walks descendants; interrupt does not)
- Changing keep-id `/clear` engine method
- Switching live-cancel JSON to `{ accepted: true }` (that envelope is submit)
- Changing POST submit 202, compact, or resolve status codes
- Inventing a this-session `lastEnd` on idle leftover-only I2
- Emitting `cancelled, ask still pending` on `queryLoop` reason `aborted`

Amend prior OUT **only** for: cancel-without-live of this session’s parked asks, interrupt abort-pair, cancel 202/200.

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

### Abort-pair (engine)

1. **I2 law is unchanged.** Per leftover-ask of the target session: if a tool result already exists, drop-only (`deletePendingAsk`); if unpaired, persist `makeToolMessage(callId, false, ABORTED_TEXT)` then drop. Persist fail leaves the row. Same `ABORTED_TEXT` as live tool abort (`aborted: the turn was interrupted before this tool finished.`). Do not execute the tool. Do not write `permission_denied`. Never a second tool row for the same `callId`. `applyAskAnswer` remains the only operator closer.

2. **`abort('cancel')` abort-pairs THIS session’s leftover-asks whether or not `liveTurn` is set.** Idle parent + this parked ask is no longer a no-op for *this* row. Existing test `cancel with no live turn does not drop leftover-asks` **flips**. Tree-stop of descendants is unchanged (still cancel-only).

3. **`abort('interrupt')` abort-pairs THIS session’s leftover-asks** (same I2 law), whether or not `liveTurn` is set. Interrupt still **is not tree-stop**: do not abort descendant engines from parent `abort('interrupt')`, do not persist-before-drop descendant leftover-asks from the parent walk. Existing interrupt-leaves-row tests **flip for this session only**. Keep `parent interrupt leaves a child leftover-ask`.

4. **Tree-stop stays cancel-only.** `abort('cancel')` still walks descendants (live abort then I2). `abort('interrupt')` does not. Parent-tree-stop spec is not reopened except this-session idle I2 (that spec’s “idle parent keeps this session parked” is amended here).

5. **`abort` stays `void`.** Persist-before-drop of this-session leftover-asks on idle cancel / interrupt must run on a flight. Do not make `abort` async. Persist starts when `whenTreeStop` is **awaited**, not inside sync `abort` (same as today’s `treeStopFlight` flags).

6. **Join shape.**

   ```ts
   whenTreeStop(): Promise<{ descendantWork: boolean; thisSessionWork: boolean }>
   ```

   `descendantWork` is unchanged (aborted at least one registered/serve descendant `liveTurn`, or persist-before-dropped / attempted at least one descendant leftover-ask). `thisSessionWork` is true iff this cancel/interrupt persist-before-dropped **or attempted** at least one **this-session** leftover-ask row via the leftover flight. Returns `{ descendantWork: false, thisSessionWork: false }` if neither flight was requested and none is in-flight.

7. **Who writes this-session I2 (do not double-write).** Extract one helper — reuse existing `persistBeforeDropAsk`. Callers:

   | Path | This-session leftover-asks | Descendants |
   |---|---|---|
   | Live `abort('cancel')` | **Cancelled epilogue** owns I2. Do **not** start `startThisSessionLeftoverFlight()`. | `startTreeStopFlight` (existing). Epilogue `await whenTreeStop()` after this-session I2. |
   | Idle `abort('cancel')` | `startThisSessionLeftoverFlight()` | `startTreeStopFlight` (existing) |
   | `abort('interrupt')` (live or idle) | `startThisSessionLeftoverFlight()` | none |

   Live cancel already I2s this session in the cancelled epilogue (`session-engine.ts` ~908–920). Coalesce so live cancel does not persist `ABORTED_TEXT` twice. Idle has no epilogue; the leftover flight is the writer.

8. **Aborted path.** After `queryLoop` returns `aborted`, `await whenTreeStop()`. Do **not** emit `cancelled, ask still pending` on aborted (that line is cancel-only, and only if an owned unpaired row remains after this-session I2 **and** tree-stop). Persist-fail on interrupt leaves the row; `applyAskAnswer` is still the closer.

9. **Idle this-session I2 invents no `lastEnd`.** Do not `upsertSession` just to stamp one. Do not clear follow-up via `CLEAR_REASONS`. Live interrupt still writes persistable `lastEnd.reason === 'aborted'` from the live turn (existing). Live cancel still writes `cancelled` (existing). Idle leftover-only invents nothing on this session or on idle descendants.

10. **`no_active_turn` means no work.** After this door, serve idle cancel is `no_active_turn` only when: no live turn, **no this-session leftover-asks**, no descendant leftover-asks, no in-process descendant `liveTurn`. This-session parked asks **are work**. `probeIdleCancel` includes `listPendingAsks(this session)` as work.

11. **`createSessionEngine` stays sync in this door.** Async factory is a **different** parallel door (`docs/rewind-recovery-v11`). Do not change the factory signature here.

12. **No schema bump in this door.** Schema v11 is a different door. No `POST /clear`.

13. **Interrupt vs `linkEngineAbort`.** Parent `abort('interrupt')` I2s **this** engine only. It does not walk `listDescendantSessionIds` and does not `child.abort('cancel')`. `linkEngineAbort` stays interrupt fan-out for a **live** in-process child whose parent `AbortSignal` fires: that child receives `abort()` (no kind → interrupt) and I2s **its own** leftover-asks as its own interrupt. A parked child leftover-ask with **no** live child engine stays (the test we keep).

14. **Coalesce leftover flight.** A second idle `abort('cancel')` or `abort('interrupt')` while a leftover flight is requested still sets the flag; `whenTreeStop` chains another persist pass after the current one (same class as `treeStopFlight`).

### Cancel HTTP 202/200

15. **Live cancel → 202.** When `liveTurnId()` is non-null and the (optional) `turnId` matches or is omitted: `abort('cancel')`, do **not** await `whenTreeStop`, return **202** `{ ok: true }`. Do not switch to `{ accepted: true }` (that envelope is submit). Client watches the NDJSON stream for `round_end`.

16. **Idle + work → 200 after join.** No live turn, but this-session leftover-asks and/or descendant work: `abort('cancel')`, await `whenTreeStop()`, return **200** `{ ok: true }`.

17. **Idle + nothing → 200 `no_active_turn`.** Unchanged shape `{ ok: true, status: 'no_active_turn' }`.

18. **Stale `turnId` while parent live → 200 `no_active_turn`.** Reconnect guard. No walk. Unchanged.

19. **Do not change POST submit 202.** Do not add `POST /clear` (other door). Do not change compact/resolve status codes.

20. **TUI notice.** `/stop` `/cancel` still call `abort('cancel')`. Notice is `stopped` if the parent was live **or** `whenTreeStop()` reports `descendantWork` **or** `thisSessionWork`; else `nothing to stop`. OpenTUI double-stop `killAll` is unchanged and is not tree-stop. ACP `session/cancel` already calls `abort('cancel')` (parent-tree-stop); unchanged.

21. **Same routes.** TUI `/stop` `/cancel`, serve `POST …/cancel`, ACP `session/cancel`. No new host verb. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main`.

22. **This spec amends earlier OUT rulings** for these three holes only: `2026-09-18-cancel-reset-followup.md` (cancel-without-live / interrupt abort-pair), `2026-09-18-parent-tree-stop.md` (idle this-session parked stays; always-200 cancel envelope), `2026-09-18-stream-version-token.md` (cancel 202/200 polish). Other parked doors stay closed.

---

## Per-slice board

Board as of this worktree. L0.1–L4.1 code is done. L4.2 is this docs pass. Not yet on `main`.

| ID | Status vs tree |
|---|---|
| L0.1 docs point at this spec | **done** |
| L1.1 `whenTreeStop` grows `thisSessionWork`; leftover flight flags | **done** |
| L1.2 idle `abort('cancel')` I2s this session via leftover flight | **done** |
| L1.3 cancelled epilogue uses `persistBeforeDropAsk`; live cancel does not start leftover flight | **done** |
| L1.4 idle this-session I2 invents no `lastEnd` | **done** |
| L2.1 `abort('interrupt')` I2s this session via leftover flight | **done** |
| L2.2 aborted path `await whenTreeStop()`; no `cancelled, ask still pending` | **done** |
| L2.3 parent interrupt still leaves a child leftover-ask | **done** |
| L3.1 live serve cancel → 202 `{ ok: true }` without join | **done** |
| L3.2 idle + work → 200 after join (`probeIdleCancel` counts this-session asks) | **done** |
| L3.3 idle + nothing and stale live `turnId` stay 200 `no_active_turn` | **done** |
| L3.4 TUI notice includes `thisSessionWork` | **done** |
| L4.1 eval `cancel-abort-pair` + parent-tree-stop parked beat | **done** |
| L4.2 shipped docs | **done** |

---

## Waves

```
Wave L0  docs pointer
Wave L1  idle this-session I2 + leftover flight + whenTreeStop shape
Wave L2  interrupt this-session I2
Wave L3  serve 202/200 + TUI notice
Wave L4  eval lock + shipped wording
```

L1 before L2 (shared leftover flight + join shape). L3 after L1 (`probeIdleCancel` + 202). L4 last. Do not implement on `main`.

---

## Wave L0 — Docs point here

### L0.1 Pointers

**Why.** ARCHITECTURE / remaining-roadmap / parent-tree-stop / cancel-reset still say idle cancel leaves this session’s parked asks, interrupt leaves leftover-asks, and serve cancel is always 200.

**Contract.**

- Mark this file as the next horizon from `2026-09-18-parent-tree-stop.md`, `2026-09-18-cancel-reset-followup.md` (OUT “cancel-without-live” / “interrupt abort-pair” become “amended by this spec”), `2026-09-12-ravenclaw-remaining-roadmap.md`, `ARCHITECTURE.md` / `.ko.md`, `SLASH_COMMANDS.md` / `.ko.md`, `docs/headless.md`, eve/y0 closers.
- Historical OUT lines stay; add a one-line amendment. Do not rewrite shipped I2 / K-wave text except the three holes.
- Do not claim a web UI. Do not reopen schema v11, async `createSessionEngine`, or `POST /clear`.

**Done when.** Those files link here. Idle `/stop` is no longer described as a no-op for *this* row. Live `POST …/cancel` is no longer described as always 200.

---

## Wave L1 — Idle this-session I2

Goal: idle `abort('cancel')` persist-before-drops this session’s leftover-asks. Live cancel still owns this-session I2 in the cancelled epilogue. Join shape grows `thisSessionWork`.

### L1.1 `whenTreeStop` + leftover flight flags

**Why.** `abort` stays `void`. Persist must not run inside the sync function. Hosts already join via `whenTreeStop`.

**Contract.**

- Type: `whenTreeStop(): Promise<{ descendantWork: boolean; thisSessionWork: boolean }>`.
- `startThisSessionLeftoverFlight()` sets a flag (sibling of `treeStopRequested`). Persist of this-session rows starts only inside `whenTreeStop`’s enqueue, via `persistBeforeDropAsk`.
- Live `abort('cancel')` does **not** call `startThisSessionLeftoverFlight()`. Idle `abort('cancel')` does (and still `startTreeStopFlight`).
- Wrappers (`log.ts`, `engine.ts`) already forward; update local types in `serve.ts` `ServeEngine`, `followup.ts` optional engine, and test stubs so they compile.
- `createSessionEngine` stays a sync function.

**Files.** `packages/core/src/types.ts`, `packages/core/src/loop/session-engine.ts`, `packages/core/src/session/followup.ts`, `packages/cli/src/serve.ts`, stub engines in tests listed in the plan.

**Done when.** Typecheck of those files succeeds. A unit test can request leftover flight without a live turn and observe persist only after `await whenTreeStop()`.

### L1.2 Idle cancel abort-pairs this session

**Contract.**

- Replace `session-engine.test.ts` `cancel with no live turn does not drop leftover-asks` with idle cancel + `await whenTreeStop()` → this-session pending length 0, exactly one `ABORTED_TEXT` when unpaired (or drop-only when already paired), `{ descendantWork: false, thisSessionWork: true }`.
- Flip `idle parent cancel with no descendants reports no descendant work` the same way (row gone, `thisSessionWork: true`, `descendantWork: false`).
- Flip `idle parent tree-stop drops descendant leftover-asks and keeps this session parked`: **both** rows gone; parent `lastEnd` still unset; child `lastEnd` still unset if the child had no live turn; `whenTreeStop()` → `{ descendantWork: true, thisSessionWork: true }`.
- Persist-fail on one this-session row leaves that row; `thisSessionWork: true`; `applyAskAnswer` still matches.

**Files.** `packages/core/src/loop/session-engine.ts`, `session-engine.test.ts`.

**Done when.** Those flipped tests are green. Live this-session I2 happy path (`live cancel abort-pairs a leftover-ask…`) stays green with **exactly one** `ABORTED_TEXT`.

### L1.3 Cancelled epilogue uses `persistBeforeDropAsk`

**Contract.** Replace the inlined `persistSettledTool` / `deletePendingAsk` loop (~908–925) with `persistBeforeDropAsk`. After this-session I2, still `await whenTreeStop()` (descendants). Emit `cancelled, ask still pending` only if an owned unpaired row remains. Live cancel must not also run leftover flight.

**Done when.** Live cancel tests still green. A regression test (or the existing exactly-one tool-row expect) fails if a second `ABORTED_TEXT` is written.

### L1.4 lastEnd on idle leftover-only

**Contract.** Idle this-session I2 does not invent `lastEnd` and does not upsert the session row for that purpose. Live cancel still writes `cancelled`. Pin with an explicit test next to the flipped idle-cancel test.

**Done when.** That expect is green.

---

## Wave L2 — Interrupt this-session I2

Goal: `abort('interrupt')` abort-pairs this session’s leftover-asks. Not tree-stop.

### L2.1 Interrupt leftover flight

**Contract.**

- Replace `interrupt leaves a leftover-ask` with: live (or idle) `abort('interrupt')` + drain / `await whenTreeStop()` → this-session pending length 0, exactly one `ABORTED_TEXT` when unpaired. Live interrupt `lastEnd.reason === 'aborted'` (existing persistable write). Idle interrupt invents no `lastEnd`.
- `abort('interrupt')` calls `startThisSessionLeftoverFlight()` whether or not `liveTurn` is set. Does **not** start `treeStopFlight`. Does **not** `child.abort('cancel')`.

**Files.** `packages/core/src/loop/session-engine.ts`, `session-engine.test.ts`.

**Done when.** That flipped test is green.

### L2.2 Aborted path join

**Contract.** After `queryLoop` returns `aborted`, `await whenTreeStop()`. Do not yield `{ type: 'status', message: 'cancelled, ask still pending' }` on aborted, even if persist-fail left a row.

**Done when.** Interrupt drain does not contain that status line. Persist-fail interrupt test leaves the row and has no status line.

### L2.3 Parent interrupt leaves a child leftover-ask

**Contract.** Keep `parent interrupt leaves a child leftover-ask` green. Parent interrupt I2s parent leftover-asks only. A parked child store row with no live child engine stays.

**Done when.** That test is still green and a new (or flipped) this-session interrupt test is green.

---

## Wave L3 — Serve 202/200 + TUI notice

### L3.1–L3.3 Serve table

**Contract.** Implement the ruling 15–18 table in `packages/cli/src/serve.ts`.

| Case | HTTP | Body | Side effects |
|---|---|---|---|
| Invalid JSON body | 400 | `{ error: 'invalid json' }` | none |
| `turnId` provided **and** parent `liveTurnId() !== null` **and** `turnId !== live` | **200** | `{ ok: true, status: 'no_active_turn' }` | no abort, no walk |
| Parent live, and (`turnId` omitted or `turnId === live`) | **202** | `{ ok: true }` | `abort('cancel')`; do **not** await `whenTreeStop` |
| Parent idle, no this-session leftover-asks, no descendant leftover-asks, no in-process descendant `liveTurn` | **200** | `{ ok: true, status: 'no_active_turn' }` | no abort |
| Parent idle, this-session leftover-asks and/or descendant work | **200** | `{ ok: true }` | `abort('cancel')`, **await** `whenTreeStop()`, then write the body |

`probeIdleCancel` includes `listPendingAsks(this session)` as work. `turnId` still does **not** block idle work (idle + stale `turnId` + work still walks). Submit 202 `{ accepted: true, sessionId }` unchanged.

**Files.** `packages/cli/src/serve.ts`, `serve.test.ts`.

**Done when.** Live cancel tests expect **202**. Idle + this-session leftover-ask is 200 `{ ok: true }` and aborts. Idle + nothing and stale-live-turnId stay 200 `no_active_turn`. Submit tests still expect 202 `{ accepted: true, sessionId }`.

### L3.4 TUI notice

**Contract.** Ink and OpenTUI `/stop`: still `abort('cancel')`. Notice `stopped` if `wasLive || descendantWork || thisSessionWork`. Double-stop `killAll` unchanged.

**Files.** `packages/cli/src/app.tsx`, `packages/cli/src/opentui-app.ts`, `opentui-app.test.ts` (stub `whenTreeStop` grows `thisSessionWork`).

**Done when.** Idle parent + this-session leftover-ask `/stop` does not print `nothing to stop`. Existing descendant-work notice test stays green.

---

## Wave L4 — Eval lock + shipped docs

### L4.1 Fixture

**Contract.** Update `cancel-abort-pair` in `packages/core/src/eval/run.ts`:

| Beat | Assert |
|---|---|
| Live cancel (existing) | This-session pending empty; exactly one `ABORTED_TEXT`; no status line |
| Idle this-session parked + `abort('cancel')` + `whenTreeStop()` | Row **gone**; `thisSessionWork: true`; `descendantWork: false`; no `lastEnd` |
| Interrupt this-session parked + `abort('interrupt')` + `whenTreeStop()` | Row **gone** |
| Parent interrupt + child leftover-ask | Child row **stays** |

Flip the parent-tree-stop eval parked beat (today: idle this-session parked stays). After this door that beat must expect the row gone / `thisSessionWork: true` so the two fixtures do not lock opposite laws. Copy helpers locally in `run.ts`; do not import from test files.

**Files.** `packages/core/src/eval/run.ts`, `run.test.ts` already walks the dir. Optional extra asserts in `fixtures/cancel-abort-pair/case.json` stay `{ "cancelAbortPair": true }`.

**Done when.** `bun test ./packages/core/src/eval/run.test.ts` fails if L1.2, L2.1, or L2.3 regress.

### L4.2 Shipped wording

**Contract.** After code: mark this spec’s board L0.1–L4.1 done. CHANGELOG Unreleased one-liner. ARCHITECTURE / `.ko.md`, SLASH_COMMANDS / `.ko.md`, `docs/headless.md`, remaining-roadmap, eve/y0 closers, prior spec OUT pointers.

**Done when.** Docs match the three holes. Parallel doors stay OUT.

---

## Out of this horizon

Web chat UI, Next.js BFF, Prisma Task, Socket.IO, y0 Shadow wiki / indexer, eve compiler, OpenAPI connections, memory slots, `defineState`, credential brokering, self-mod, any new chat network, sandbox network policy, Grep/Glob docker-exec, `ignored`, schema v11, async `createSessionEngine`, compact-then-die sliver fill, HTTP `POST /clear`, making `abort` async, using `killAll` as tree-stop, changing tree-stop of descendants, changing keep-id `/clear`, switching live-cancel JSON to `{ accepted: true }`, changing POST submit 202.

---

## Suggested order

1. **L0.1** with the spec file (pointer pass may land with the impl door; this spec-only commit keeps the pointer inside this file).
2. **L1.1** then **L1.2 + L1.4** then **L1.3**.
3. **L2.1 + L2.2** then **L2.3**.
4. **L3.1–L3.3** then **L3.4**.
5. **L4.1** then **L4.2** last.

---

## Success checks

A slice that does not move one of these is out of scope.

1. Idle `abort('cancel')` abort-pairs this session’s leftover-ask with exactly one `ABORTED_TEXT` (or drop-only if already paired) and invents no `lastEnd` (L1).
2. Live cancel still I2s this session in the cancelled epilogue and does **not** write a second `ABORTED_TEXT` (L1.3).
3. `abort('interrupt')` abort-pairs this session’s leftover-asks; parent interrupt leaves a child leftover-ask; aborted stream does not emit `cancelled, ask still pending` (L2).
4. Live serve cancel is **202** `{ ok: true }` without joining `whenTreeStop`; idle + work is **200** `{ ok: true }` after join; idle + nothing and stale live `turnId` stay **200** `no_active_turn` (L3).
5. `probeIdleCancel` treats this-session leftover-asks as work; TUI idle `/stop` with this-session leftover-asks prints `stopped` (L3).
6. Eval `cancel-abort-pair` fails the runner if 1, 3, or the idle-drop beat regress (L4).

---

## Key decisions

1. **Theme is abort-pair completeness, not a new host.** Same `abort`, same I2 law, same routes. Three parked items share the writer and the join.
2. **Live cancel’s cancelled epilogue already owns this-session I2.** A leftover flight on that path would double-write or race the epilogue. Idle cancel and interrupt have no cancelled epilogue, so they start `startThisSessionLeftoverFlight()`.
3. **`abort` stays `void`; persist starts when `whenTreeStop` is awaited.** Same flag-then-join pattern as `treeStopFlight`. Serve live cancel still does not join (now 202). Serve idle + work still joins (200).
4. **`no_active_turn` means no work, including this-session parked asks.** That is the honesty hole idle cancel locked in I2.3.
5. **Interrupt is this-session I2, not tree-stop.** Descendants in the store stay unless that descendant engine itself receives interrupt (live in-process child via `linkEngineAbort`).
6. **HTTP 202 is live fire-and-forget, matching submit’s “don’t wait for the turn” shape, but the JSON stays `{ ok: true }`.** `{ accepted: true }` remains submit-only.
7. **Idle leftover-only invents no `lastEnd`.** Follow-up stays skipped until a later real turn. Rewind/submit still await `whenTreeStop()` before `listOwnedPendingAsks`.
8. **This spec amends parent-tree-stop / cancel-reset OUT for these three holes only.** Schema v11, async factory, and `POST /clear` stay other doors.
