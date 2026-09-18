# RavenClaw next-horizon roadmap (cancel abort-pair, reset-on-resume, follow-up persist)

Date: 2026-09-18  
Status: implemented  
Shipped on `main` at `5eefdde`.  
Reviewed against tree at `77a09f3` (`main` after rewind persist PR land + shipped-docs PR #13).  
Successor to `2026-09-18-rewind-persist-and-todo-projection.md` (Status: implemented). Does not reopen that spec’s closed doors except the three holes named here.  
Next horizon (this branch): [`2026-09-18-no-job-todo-revert.md`](2026-09-18-no-job-todo-revert.md) (amends this spec’s OUT for no-job todo revert only). After that: [`2026-09-18-keep-id-clear.md`](2026-09-18-keep-id-clear.md) unparks keep-id `/clear` only.

Implementation plan: [2026-09-18-cancel-reset-followup.md](../plans/2026-09-18-cancel-reset-followup.md).

Sources: current tree. No new steal from eve/y0.

Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not become a hosted Task runner. Do not add a web UI.

---

## Where we are

The waist is shipped: leftover-ask, session-as-job, job-host, persist-before-reset rewind, project `todo.json` projection.

Three leftover honesty holes were open at review time. None of them is a new product surface. Landed on `main` at `5eefdde`. The table below is the pre-land snapshot.

| Piece | Tree at `77a09f3` |
|---|---|
| Live `/cancel` | `engine.abort('cancel')` stops the turn. In-flight `tool_use` is paired `aborted`. Parked leftover-ask rows **stay**. Stream may emit `cancelled, ask still pending`. `applyAskAnswer` is the only closer for those rows. |
| Persist-then-die before reset | Job rewind `recordCompact`s first, then `git reset --hard`. Crash after compact and before reset: transcript dropped, HEAD still later, `session.todos` unrestored. No durable “reset pending” flag. Resume does not finish the reset. |
| `writeFollowup` | Mutates `session.followup` / `updatedAt`, then `upsertSession`. Upsert throw leaves memory ahead of disk. `clearFollowup` can look empty in-process while the slot is still on disk. |

Previous specs parked (1) and (2) on purpose. This horizon **unparks only those two**, plus the follow-up persist-order nit. It does not unpark a web UI.

---

## Constraints (unchanged except the three holes)

1. One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer **for operator answers**. Cancel abort-pair is a side effect of `abort('cancel')`, not a fourth host entry and not a model turn.
2. Default prefix stays small and frozen. No new always-on tool.
3. `dontAsk` never becomes `bypass`.
4. BYOK is the product. Ads never touch BYOK.
5. Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
6. `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
7. Leftover-ask still wins rewind: `rewindLast` refuses when any owned unpaired pending ask exists.
8. Edit-resubmit stays host composition (`rewindLast` then `submitMessage`).
9. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.

---

## Do not build

- Web chat UI, Next.js BFF, Prisma Task, Socket.IO
- keep-id `/clear` (amended by `2026-09-18-keep-id-clear.md`), stream `version` / `continuationToken`
- `ignored` as a leftover-ask result
- Cancel with no live turn abort-pairing parked asks (`no_active_turn` stays a no-op)
- `abort('interrupt')` abort-pairing leftover-asks (steer is not cancel)
- Parent cancel abort-pairing a **child** leftover-ask (child has its own cancel)
- Schema version bump (no new column)
- Reset-on-resume without `pendingResetSha` (do not infer from HEAD ≠ checkpoint)
- Auto-reset on `loadSession` / GET snapshot (those stay read-only)
- Making `createSessionEngine` async (it stays `function …: SessionEngine`)
- Changing `TodoWrite` persist-then-file, no-job rewind order, or making `todo.json` the source of truth
- Default-on auto-commit / auto-PR

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

### Live cancel abort-pair

1. **Only a live `abort('cancel')` abort-pairs.** `POST …/cancel` / TUI `/cancel` that hits a live turn. Stale `turnId` / no live turn stays `{ ok: true, status: 'no_active_turn' }` and does **not** touch leftover-asks.
2. **This session only.** Pair leftover-ask rows whose `sessionId` is the cancelled session. Child rows stay. Parent cancel does not close a child’s ask.
3. **Pair as `aborted`, not deny. Do not double-write the tool row.** A live leftover-ask is almost always already transcript-paired: `askUser` abort returns `pairMissing(..., 'aborted')`, `runToolRound` persists those results, then `reason` is `cancelled`. Abort-pair of the pending row must **not** persist a second `ABORTED_TEXT` for an already-paired `callId`. Per leftover-ask of this session: if a tool result already exists, **drop only**; if unpaired, persist `makeToolMessage(callId, false, ABORTED_TEXT)` then drop. Same text as in-flight `tool_use` abort (`aborted: the turn was interrupted before this tool finished.`). Do not execute the tool. Do not write `permission_denied`.
4. **Persist-before-drop.** Unpaired: if persist of the tool row fails, leave the pending row. Already paired: drop only; if `deletePendingAsk` fails, leave the row. Stream still says `cancelled, ask still pending` for any leftover that remains.
5. **After a successful abort-pair**, `listPendingAsks(session.id)` is empty (for this session). Stream does **not** emit `cancelled, ask still pending`. Transcript has **exactly one** tool result for that `callId` (the aborted pair). `applyAskAnswer` for that `callId` is **`matched`** (already paired) when the tool row exists; it is `unmatched` only if there was never a `tool_use`. `lastEnd.reason` stays `cancelled`.
6. **`abort('interrupt')` is unchanged.** Leftover-asks stay. Existing interrupt tests stay green.
7. **`applyAskAnswer` is still the operator closer.** Cancel does not start a model turn. Crash-resolve (`applyAskAnswer` after process death) is still pair-only.

### Reset-on-resume

8. **Durable flag, no new column.** Add optional `pendingResetSha?: string` on `SessionJob` (already stored in `job_json`). No schema version bump.
9. **Write the flag after compact, before reset.** `rewindToCheckpoint`: `recordCompact` (if dropped ids) → upsert `job.pendingResetSha = target sha` → `git reset --hard` → restore todos, **delete** `pendingResetSha`, upsert, project `todo.json`. Persist fail of compact still leaves HEAD and originals (current H1.2). If the pending-flag upsert fails after compact, still attempt the reset (do not leave a dropped transcript with no recovery flag and no reset).
10. **Resume finishes only when the flag is set. `createSessionEngine` stays sync.** Do not change `createSessionEngine` to `async`. `maybeFinishRewindReset` is awaited at already-async points **before** they inspect or mutate the tree: `submitMessage`, `rewindLast`, and the host `/diff` wrappers (serve `GET …/diff`, TUI `/diff`). Do **not** add `store` to the pure `jobDiff(job)` helper. Not from `createSessionEngine`. Not from store `loadSession`. Not from GET snapshot (snapshot may show `job.pendingResetSha`; it must not reset).
11. **Success path equals a successful rewind epilogue.** `git reset --hard` to `pendingResetSha`. Restore `session.todos` from the last remaining assistant `todoSnapshot`, or `[]` at `baseCommitSha` with no earlier checkpoint. Clear `pendingResetSha` and `jobError`. Upsert. Re-project project `todo.json` (`originalCwd ?? cwd`). Projection fail is the existing notice suffix; `ok` stays true.
12. **Reset fail keeps the flag.** `setSessionJobError`, keep `pendingResetSha`, do not apply the todo snapshot, do not un-compact. Next `submitMessage` / `rewindLast` / host `/diff` retries.
13. **Do not infer.** `HEAD !== checkpoint` without `pendingResetSha` is operator work (or the remaining compact-then-die sliver). Do not reset it.
14. **The remaining sliver is accepted.** Compact succeeded, pending-flag upsert did not, process died: same class as today’s persist-then-die, now smaller. Do not invent a second recover heuristic.

### `writeFollowup` persist order

15. **Disk first, then memory.** Build the next `followup` / `updatedAt` values. `upsertSession` a record that already has them. Only after upsert resolves, assign `session.followup` / delete it and `session.updatedAt`. Upsert throw → in-memory session unchanged, `{ ok: false, notice: 'follow-up persist failed' }` (set) or rethrow from `clearFollowup` as today if the engine still surfaces the throw — prefer `{ ok: false }` for set; `clearFollowup` must not leave memory cleared when disk still has the slot.
16. **`maybeRunFollowup` persist-clear-then-submit is unchanged.** It already skips when `clearFollowup` throws. After this horizon, a failed clear must also leave `getFollowup()` non-null.

---

## Per-slice board

| ID | Status vs tree |
|---|---|
| I0.1 docs point at this spec | **done** |
| I1.1 `writeFollowup` persist-then-assign | **done** |
| I1.2 upsert fail leaves memory and `getFollowup()` | **done** |
| I2.1 live cancel abort-pairs this session’s leftover-asks | **done** |
| I2.2 persist fail leaves the row + `ask still pending` | **done** |
| I2.3 no live turn / interrupt / child ask unchanged | **done** |
| I3.1 `pendingResetSha` on job rewind | **done** |
| I3.2 `maybeFinishRewindReset` on first submit / rewindLast / host diff | **done** |
| I3.3 reset-fail keeps the flag | **done** |
| I4.1 eval fixtures | **done** |

---

## Waves

```
Wave I0  docs pointer
Wave I1  writeFollowup persist-first     (independent)
Wave I2  live cancel abort-pair          (independent of I1)
Wave I3  reset-on-resume                 (rewind + first submit / rewindLast / host diff)
Wave I4  eval lock
```

I1 and I2 may run in parallel (disjoint files). I3 after I0. I4 last.

---

### I0.1 Docs point at this spec

**Why.** ARCHITECTURE / README / remaining-roadmap still treat rewind as the end of the chain with no next hole.

**Contract.**

- Mark this file as the next horizon from `2026-09-18-rewind-persist-and-todo-projection.md`, `2026-09-17-job-host-state-roadmap.md`, `2026-09-12-ravenclaw-remaining-roadmap.md`, `ARCHITECTURE.md` / `.ko.md`, `README.md`, eve/y0 analysis closers.
- Do not claim a web UI. Do not reopen parked doors.

**Done when.** Those files link here.

---

### I1.1–I1.2 `writeFollowup` persist-then-assign

**Why.** Persist-before-execute exists so memory cannot lie after a failed write. Follow-up is the same class.

**Contract.**

- `writeFollowup` does not assign `session.followup` until `upsertSession` resolves.
- Empty trim still returns `{ ok: false, notice: 'follow-up text required' }` with no upsert and no memory change.
- Upsert throw: memory unchanged; set path returns `{ ok: false, notice: 'follow-up persist failed' }`; clear path must not delete `session.followup` if disk still has it.
- Existing overwrite / trim / `updatedAt` tests stay, plus a new persist-fail test.

**Files.** `packages/core/src/session/followup.ts`, `followup.test.ts`.

**Done when.** Stub `upsertSession` to throw after a successful set; `session.followup` is still the previous value and `getFollowup()` would see it.

---

### I2.1–I2.3 Live cancel abort-pair

**Why.** Cancel of the live turn that parked the ask must close the pair. Leaving the row forces `applyAskAnswer` after the operator already said stop.

**Contract.**

- After `abort('cancel')` and `round_end { reason: 'cancelled' }`, leftover-asks for **this** `session.id` are gone when drop (and persist, if unpaired) succeeded. Already-paired calls drop only; unpaired calls persist one `ABORTED_TEXT` then drop. Never a second tool row for the same `callId`.
- Replace `session-engine.test.ts` `cancel leaves a parked leftover-ask and yields a status line` with a **real leftover-ask**: persist a `tool_use`, hang `askUser`, then `abort('cancel')`. Expect length 0, **no** `cancelled, ask still pending`, and **exactly one** aborted tool result. Do not keep the synthetic “pending row, no `tool_use`” fixture as the happy path.
- Add: unpaired persist-fail keeps the row and the status line.
- Add: already-paired drop-fail keeps the row and the status line.
- Add: `abort('interrupt')` leaves the row.
- Add: parent cancel leaves a child leftover-ask.
- Add: `POST …/cancel` with no live turn does not drop rows.
- Serve / TUI / ACP keep calling `abort('cancel')`. No new route.

**Files.** `packages/core/src/loop/session-engine.ts`, `session-engine.test.ts`, serve cancel test if one asserts the old status line.

**Done when.** The real leftover-ask cancel test and the three unchanged-path tests are green.

---

### I3.1–I3.3 Reset-on-resume

**Why.** Persist-before-reset made the transcript honest. The remaining lie is a dropped transcript with a later HEAD. A flag is enough; inference is not.

**Contract.**

- `SessionJob.pendingResetSha?: string`.
- `rewindToCheckpoint` writes it after compact, before `git reset --hard`, and clears it only after a successful reset + todo restore + session upsert.
- `maybeFinishRewindReset({ session, store })`: no-op without the flag; otherwise the rewind epilogue against `pendingResetSha`.
- Call it from `submitMessage`, `rewindLast`, and host `/diff` wrappers, each before they inspect or mutate the tree. `createSessionEngine` stays a sync `function` and does **not** call it. Pure `jobDiff(job)` stays store-free.
- Reset-fail: `jobError` set, flag kept, todos unchanged.
- No call from store `loadSession` or GET snapshot.

**Files.** `packages/core/src/types.ts`, `packages/core/src/session/rewind.ts`, `rewind.test.ts`, `session-engine.ts`, serve / TUI `/diff` wrappers.

**Done when.** Persist compact, set the flag, skip reset, construct a new engine, then `submitMessage` or `rewindLast`: HEAD is the flag sha, todos match the snapshot, flag is gone. Constructing the engine alone must not reset.

---

### I4.1 Eval lock

**Why.** These are pairing / persist / job-tree contracts. Unit tests can rot if the runner never sees them.

**Contract.**

- `cancel-abort-pair`: live cancel (real leftover-ask) drops this session’s pending row, leaves exactly one aborted tool result; no live turn leaves the row.
- `rewind-reset-on-resume`: flag set, no reset, first `submitMessage` or `rewindLast` finishes the reset. Engine construct alone does not.
- `followup-persist-order`: upsert throw leaves the previous slot.

**Files.** `packages/core/src/eval/run.ts`, two or three fixture dirs, `run.test.ts` already walks the dir.

**Done when.** `bun test ./packages/core/src/eval/run.test.ts` fails if I1.1, I2.1, or I3.2 regress.

---

## Out of this horizon

Web chat UI, Next.js BFF, Prisma Task, Socket.IO, y0 Shadow wiki / indexer, eve compiler, OpenAPI connections, memory slots, `defineState`, credential brokering, self-mod, any new chat network, sandbox network policy, Grep/Glob docker-exec, `ignored`, keep-id `/clear`, stream `version` / `continuationToken`, no-job todo revert (amended by `2026-09-18-no-job-todo-revert.md`), schema v11, async `createSessionEngine`, cancel-without-live abort-pair, interrupt abort-pair, parent-cancels-child-ask.

---

## Suggested order

1. **I0.1** with the spec file.
2. **I1** (tiny, independent).
3. **I2** (real leftover-ask cancel test).
4. **I3** (`pendingResetSha` then first submit / rewindLast / host diff).
5. **I4** last.

---

## Success checks

A slice that does not move one of these is out of scope.

1. `writeFollowup` upsert fail leaves memory and the previous slot (I1).
2. Live cancel drops this session’s leftover-ask and leaves exactly one `ABORTED_TEXT` tool result (I2).
3. No live turn / interrupt / child ask stay parked (I2).
4. Job rewind writes `pendingResetSha` before reset and clears it after (I3).
5. First `submitMessage` / `rewindLast` / host `/diff` with the flag set finishes the reset; engine construct does not (I3).
6. Eval fixtures fail the runner if 1, 2, or 5 regress (I4).

---

## Key decisions

1. **Theme is three honesty leftovers, not a new host.** No new route. No web UI.
2. **Cancel abort-pair is `aborted`, not deny, and not a second tool row.** The live leftover-ask is already transcript-paired by `queryLoop`. The pending row is the remaining lie. Drop it; persist `ABORTED_TEXT` only when unpaired.
3. **This session only.** Child leftover-ask still needs the child’s cancel or `applyAskAnswer`.
4. **Reset-on-resume needs a flag.** Inferring from HEAD would rewind operator commits.
5. **`loadSession` and GET snapshot stay read-only.** Recover points are already-async: `submitMessage`, `rewindLast`, host `/diff`. `createSessionEngine` stays sync and is not a recover point.
6. **Follow-up persist-first matches persist-before-execute.** Memory must not race disk.
7. **This spec amends earlier OUT rulings** for live cancel abort-pair and reset-on-resume only. Other parked doors stay closed.
