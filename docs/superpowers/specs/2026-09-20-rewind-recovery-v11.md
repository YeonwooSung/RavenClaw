# RavenClaw next-horizon roadmap (rewind recovery, schema v11, async createSessionEngine)

Date: 2026-09-20  
Status: implemented  
Shipped sha: `dc45aec` on `main`.  
Reviewed against tree at `a707249` (`origin/main` after parent tree-stop `9901d0e`).  
Successor to `2026-09-18-parent-tree-stop.md` (Status: implemented at `9901d0e`). Amends prior OUT **only** for: compact-then-die sliver, schema v11, async `createSessionEngine`. Does not reopen abort / I2 / cancel 202 / tree-stop.

Implementation plan: [2026-09-20-rewind-recovery-v11.md](../plans/2026-09-20-rewind-recovery-v11.md). Isolated worktree only.

Sources: current tree. No new steal from eve/y0.

Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not become a hosted Task runner. Do not add a web UI.

---

## Where we are

The waist is shipped: leftover-ask, session-as-job, job-host, persist-before-reset rewind, project `todo.json` projection, live cancel abort-pair (I2), reset-on-resume (`pendingResetSha` in `job_json`), follow-up persist-first, no-job todo revert, stream version/token, keep-id `/clear`, parent tree-stop.

Cancel-reset ruling 14 **accepted** a remaining sliver and forbade a second recover heuristic (`HEAD !== checkpoint` must not infer reset). Schema v11 and async `createSessionEngine` stayed parked (no-job spec, parent-tree-stop K2.1). GET snapshot still attaches an engine via `loadSessionRuntime`.

This horizon **unparks three parked items that are one recover story**. It does not unpark a web UI, interrupt abort-pair, or leftover-ask abort/I2/202 changes.

| Piece | Tree at `a707249` |
|---|---|
| Compact + recover flag | `rewindToCheckpoint`: `recordCompact` (dropped ids) → `upsertSession` `job.pendingResetSha` → `git reset --hard`. Two SQLite writes. Compact success + flag upsert fail + process death: transcript dropped, HEAD later, no recover flag. |
| Schema | v10 (`010_session_host_state.sql`: `last_end_json`, `job_error`, `followup_text`). `pendingResetSha` lives only in `job_json`. `jobFromJson` must copy it or crash recovery loses the flag. |
| Factory | `export function createSessionEngine(opts: SessionEngineOptions): SessionEngine` (sync). Construct is **not** a recover point. Tests lock construct-alone must not reset. |
| GET snapshot | `GET /v1/session/:id` calls `loadSessionRuntime` → `createSessionEngine`. Snapshot is supposed to be read-only; attaching an engine would reset once construct recovers. `live` is `engine.liveTurnId() !== null` on that attached engine. |

---

## Constraints (unchanged except these three holes)

1. One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers.
2. Default prefix stays small and frozen. No new always-on tool. Rewind and recover stay **session ops**, not tools.
3. `dontAsk` never becomes `bypass`.
4. BYOK is the product. Ads never touch BYOK.
5. Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
6. `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
7. Leftover-ask still wins rewind: `rewindLast` refuses when any owned unpaired pending ask exists. Edit-resubmit stays host composition (`rewindLast` then `submitMessage`).
8. **Do not infer reset from `HEAD !== checkpoint`.** No flag → operator work. Filling the sliver is a transactional write, not a second heuristic.
9. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.

---

## Do not build

- Web chat UI, Next.js BFF, Prisma Task, Socket.IO
- `ignored` as a leftover-ask result
- Cancel with no live turn abort-pairing parked asks
- `abort('interrupt')` abort-pairing leftover-asks
- Changing abort / I2 persist-before-drop / serve cancel `202`/`200` / tree-stop
- Extra schema columns (cleared-at, fileHistory todo frames, no-job git checkpoint)
- `createSessionEngineSync` or any sync factory wrapper that skips recover
- Auto-reset on store `loadSession` / GET snapshot
- Inferring `pendingResetSha` from HEAD
- Changing `TodoWrite` persist-then-file or no-job persist-then-undo order
- Making `.ravenclaw/todo.json` the source of truth
- Default-on auto-commit / auto-PR
- POST `/v1/session/:id/clear`

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

### Schema v11

1. **New migration** `packages/core/src/migrations/011_pending_reset_sha.sql`:

```sql
ALTER TABLE sessions ADD COLUMN pending_reset_sha TEXT;
UPDATE sessions
SET pending_reset_sha = json_extract(job_json, '$.pendingResetSha')
WHERE json_extract(job_json, '$.pendingResetSha') IS NOT NULL
  AND json_extract(job_json, '$.pendingResetSha') != '';
```

Column is `sessions.pending_reset_sha TEXT` (NULL when unset). Copy existing `job_json` values, then the column is source of truth.

2. **`applyMigrations` gains version 11.** Fresh install `schema_version` 11. Every test that asserts version `10` (`schema.test.ts`, `sqlite-store.test.ts`, `deliveries.test.ts`, `search.test.ts`) updates to `11`. Add a v10 → v11 upgrade test: a v10 row whose `job_json` contains `pendingResetSha` lands in the column.

3. **Dual-write during v11.** Keep `SessionJob.pendingResetSha?: string` in types. `upsertSession` / `createSession` persist **both** `pending_reset_sha` (`session.job?.pendingResetSha ?? null`) **and** `job_json` (JSON still includes `pendingResetSha` when set) so old readers of `job_json` still see it. Do not bump a second time.

4. **Load prefers the column if non-empty.** `sessionFromRow`: parse `job_json` as today; if `pending_reset_sha` is a non-empty string and a job exists, set `job.pendingResetSha` from the column (column wins even if `job_json` lacks or disagrees). Empty / NULL column → keep `job_json` value. Do not invent a job from a lone column.

5. **No other columns.** Do not add cleared-at, fileHistory todo frames, or no-job git checkpoint columns.

### Compact + flag one transaction (sliver fill)

6. **New store method** — one `withWrite` / `beginImmediate`:

```ts
recordCompactAndUpsertSession(opts: {
  session: SessionRecord
  inactivatedIds: string[]
  generation: number
  summary?: string
}): Promise<void>
```

When `inactivatedIds.length > 0`, run the existing compact inactivate + boundary + generation bump (summary default `'rewind'`). Always upsert the session row (column + `job_json`) in the **same** transaction. Empty `inactivatedIds` still upserts the flag. Throw rolls both back: messages still active, column NULL, `job.pendingResetSha` absent on disk.

7. **`rewindToCheckpoint` persist-first via this method, then `git reset --hard`.** Build the next session (flag set, `updatedAt`) **without** assigning onto `opts.session` until the combined write resolves. Combined-write throw → `{ ok: false, notice: 'rewind persist failed' }`, **original** messages, in-memory job **unflagged**, HEAD unchanged, **do not** attempt `git reset`. This **amends** cancel-reset ruling 9 (“flag upsert fail after compact still attempt reset”).

8. **Still do not infer.** `HEAD !== checkpoint` without `pending_reset_sha` is operator work. No second heuristic. This **amends** cancel-reset ruling 14 (the sliver is no longer accepted).

9. **Flag-upsert-fail-after-compact is gone** for crash: they are one write. If git reset fails after the transaction, the flag stays (existing I3.3). Crash after the combined write and before git reset: construct recovers.

10. **`maybeFinishRewindReset` still runs git reset + todo restore + clear flag.** Clear the column and `job.pendingResetSha` together via the existing success `upsertSession` (dual-write writes NULL + JSON without the key). Reset-fail keeps the flag (column + JSON).

### Async `createSessionEngine`

11. **Signature:**

```ts
export async function createSessionEngine(opts: SessionEngineOptions): Promise<SessionEngine>
```

12. **Construct recovers.** After the engine object exists and the session is loaded into it, if `pendingResetSha` is set, `await maybeFinishRewindReset({ session, store: opts.store, messages })`. Engine construct **is** a recover point. Reset-fail (`{ ok: false }`) **does not throw** from the factory; return the engine with the flag kept and `jobError` set. Flip tests that assert construct-alone must not reset. `submitMessage` / `rewindLast` / host `/diff` still call `maybeFinishRewindReset` (no-op if construct already cleared).

13. **GET snapshot stays read-only.** `GET /v1/session/:id` must **not** call `createSessionEngine` / must **not** reset. Split `loadSessionRuntime`: snapshot reads `store.loadSession` only (may **show** `pendingResetSha` on the job object). `live` comes from `ctx.liveRuntimes` cache only (`liveTurnId() !== null` on a cached engine; else `false`). Mutating routes (submit / cancel / compact / resolve / edit / pr / followup / clearKeepId) + stream attach + `GET …/diff` still `loadSessionRuntime` (recover). Store `loadSession` stays sync-return / read-only (no git). Stream attach recovering is OK (it is a live host, not a snapshot).

14. **Call-site blast.** Every `createSessionEngine(` becomes `await createSessionEngine(`. At `a707249`: **176 call sites + 1 export**. `spawnChild` is `packages/core/src/tools/agent.ts` ~269 (already async). `session-engine.ts` ~1173 is `startDetachedReview` (async IIFE). Do not leave a sync wrapper that skips recover.

15. **`createSessionEngine` remains the only factory.** Do not add `createSessionEngineSync`. Wrappers (`wrapSessionEngineLog`, CLI `attachRavenclawLog` / `finishOpenEngine`) stay forwarding and already live in async functions.

16. **ACP `engineFactory` stays sync.** Production `acp-stdio.ts` already returns `wrapBoot(Promise)`. Tests that construct inside `engineFactory` must `await createSessionEngine` **before** `createAcpServer` and close over the engine. Do not make `handleSessionNew` async in this horizon.

### Merge risk

17. **Leftover-ask / abort door also edits `session-engine.ts` and `serve.ts`.** This spec must not change abort, I2 pairing, cancel `202`/`200`, or tree-stop. Snapshot split must not break cancel / clear / stream attach (those stay on `loadSessionRuntime`). Overlap files: `packages/core/src/loop/session-engine.ts`, `packages/cli/src/serve.ts`.

18. **This spec amends earlier OUT rulings** for compact-then-die sliver, schema v11, and async `createSessionEngine` only: `2026-09-18-cancel-reset-followup.md` rulings 9, 10, 14 and Do-not-build “Making `createSessionEngine` async” / “Schema version bump”; `2026-09-18-no-job-todo-revert.md` Out “schema v11, async `createSessionEngine`”; `2026-09-18-parent-tree-stop.md` K2.1 “`createSessionEngine` stays a sync function”. Other parked doors stay closed.

---

## Per-slice board

Board as of `dc45aec` on `main`. All rows **done**.

| ID | Status vs tree |
|---|---|
| R0.1 docs point at this spec | **done** |
| R1.1 migration `011_pending_reset_sha.sql` | **done** |
| R1.2 `applyMigrations` version 11; tests that asserted 10 | **done** |
| R1.3 dual-write upsert; load prefers column | **done** |
| R2.1 `recordCompactAndUpsertSession` | **done** |
| R2.2 `rewindToCheckpoint` one transaction then git reset | **done** |
| R2.3 combined-write throw does not git reset | **done** |
| R3.1 async factory; construct recovers; reset-fail does not throw | **done** |
| R3.2 every `createSessionEngine(` is `await` (176 sites) | **done** |
| R4.1 GET snapshot `loadSession` only; `live` from `liveRuntimes` | **done** |
| R4.2 mutating routes + stream + `/diff` still attach / recover | **done** |
| R5.1 eval `rewind-reset-on-resume` construct finishes reset | **done** |
| R5.2 ARCHITECTURE / CHANGELOG / prior OUT amendments | **done** |

---

## Waves

```
Wave R0  docs pointer
Wave R1  schema v11 (migration + dual-write + load)
Wave R2  transactional compact+flag (needs R1 column)
Wave R3  async factory + call sites (needs R1 load; construct recover)
Wave R4  serve snapshot split (with R3 — GET must not construct once construct recovers)
Wave R5  eval + honesty docs
```

R1 before R2. R3 after R1. **R4 with R3:** implement the snapshot split **before** (or in the same land as) flipping construct-to-recover, otherwise GET snapshot would reset HEAD. Do not parallel R2 and R3 on `rewind.ts` / `session-engine.ts` recover tests. R5 last.

---

### R0.1 Docs point at this spec

**Why.** ARCHITECTURE / README / remaining-roadmap / CHANGELOG still say schema v10, sync factory, construct must not reset, and list schema v11 / async factory as OUT.

**Contract.**

- Mark this file as the next horizon from `2026-09-18-parent-tree-stop.md`, `2026-09-18-cancel-reset-followup.md` (rulings 9 / 10 / 14 become “amended by this spec”), `2026-09-18-no-job-todo-revert.md` Out, `2026-09-12-ravenclaw-remaining-roadmap.md`, `ARCHITECTURE.md` / `.ko.md`, `README.md`, `CHANGELOG.md`.
- Historical OUT lines stay; add a one-line amendment. Do not rewrite shipped wave text. Do not claim a web UI.

**Done when.** Those files link here. Schema is no longer described as frozen at 10. Construct is no longer described as “must not reset.”

---

### R1.1–R1.3 Schema v11

**Why.** `pendingResetSha` in `job_json` only is a known load footgun. A later product needed a real column; this door’s column is `pending_reset_sha`.

**Contract.**

- Fresh DB: `schema_version` 11, column exists, NULL by default.
- v10 DB with `job_json.pendingResetSha = 'def456'` upgrades: column `'def456'`, version 11, host-state columns kept.
- `upsertSession` writes column from `session.job?.pendingResetSha ?? null` and still writes it inside `job_json`.
- `loadSession` with column `'abc'` and `job_json` missing `pendingResetSha` still returns `job.pendingResetSha === 'abc'`.
- `loadSession` with column NULL and `job_json.pendingResetSha === 'abc'` still returns `'abc'` (dual-read fallback).
- Clearing the flag: column NULL and JSON key absent.

**Files.** `packages/core/src/migrations/011_pending_reset_sha.sql`, `schema.ts`, `schema.test.ts`, `sqlite-store.ts`, `sqlite-store.test.ts`, `deliveries.test.ts`, `search.test.ts`.

**Done when.** The version-11 and column-copy tests are green. No other new column.

---

### R2.1–R2.3 Compact + flag one transaction

**Why.** Two writes are the sliver. One `BEGIN IMMEDIATE` fills it without inferring from HEAD.

**Contract.**

```
drop last user in memory
build nextSession = { ...session, job: { ...job, pendingResetSha: sha }, updatedAt }
recordCompactAndUpsertSession({ session: nextSession, inactivatedIds, generation, summary: 'rewind' })
on throw → rewind persist failed, original messages, session.job unflagged, HEAD unchanged
assign onto session
git reset --hard sha
on reset fail → keep flag (I3.3), jobError, do not un-compact
on success → clear flag+column, restore todos, upsert, project todo.json
```

- Combined write is the only persist of compact+flag. Do not call `recordCompact` then `upsertSession` on this path.
- Stubbing `upsertSession` to throw after compact-only is **impossible** on the happy path; tests throw `recordCompactAndUpsertSession` (or abort the SQLite tx) and assert messages still active + column null.
- `recordCompact` remains for prune / no-job rewind / other callers.

**Files.** `packages/core/src/types.ts` (`SessionStore`), `sqlite-store.ts`, `memory-store.ts`, `types.test.ts` (stub), `sqlite-store.test.ts`, `memory-store.test.ts`, `rewind.ts`, `rewind.test.ts`.

**Done when.** Combined-write success inactivates ids **and** sets the column before HEAD moves. Combined-write throw leaves originals and does not reset. Reset-fail after success still keeps the flag.

---

### R3.1–R3.2 Async factory + call sites

**Why.** Recover points were already-async (`submitMessage`, `rewindLast`, host `/diff`) so the factory could stay sync. GET snapshot uses the factory today; unparking construct-as-recover requires the factory to be async **and** snapshot to stop using it (R4).

**Contract.**

- Signature in ruling 11. Construct awaits `maybeFinishRewindReset` when the flag is set. Reset-fail does not throw from the factory.
- `startDetachedReview` (~1173, async IIFE) and `spawnChild` (`tools/agent.ts` ~269, already async) `await` the factory.
- Every other `createSessionEngine(` is `await`. `ReturnType<typeof createSessionEngine>` in tests becomes `Awaited<ReturnType<typeof createSessionEngine>>`.
- Flip `submitMessage finishes a pending rewind reset; construct does not` → construct **does**. `rewindLast finishes a pending reset` still covers a **live** engine whose flag was set **after** construct (reset-fail retry); construct-with-flag is itself recover and must not be used as the “rewindLast does not drop another turn” setup.
- No `createSessionEngineSync`.

**Files.** `session-engine.ts`, `session-engine.test.ts`, `tools/agent.ts`, `cli/src/engine.ts`, `sdk/src/index.ts`, `eval/run.ts`, and every file in the call-site table in the plan.

**Done when.** `await createSessionEngine({ session with pendingResetSha })` finishes the reset. A file that still calls it without `await` does not typecheck.

---

### R4.1–R4.2 Serve snapshot split

**Why.** Once construct recovers, attaching an engine on GET would reset on a read. Snapshot must show the flag without moving HEAD.

**Contract.**

- Add `store: SessionStore` to `ServeRequestContext`. `runServe` passes `shared.store`.
- `GET /v1/session/:id` uses `store.loadSession` only. 404 on unknown. Does **not** call `runtimeForSession` / `createSessionEngine`.
- `live` from `ctx.liveRuntimes` only.
- Pending asks / `lastSeq` from the store (existing `listOwnedPendingAsks` / `lastStreamSeq`).
- Job object may include `pendingResetSha`.
- `GET …/stream`, `POST …/{cancel,compact,resolve,submit,pr,followup,edit}`, `DELETE …/followup`, `GET …/diff` still `loadSessionRuntime`.
- Snapshot with flag set does not move HEAD. First mutating attach / `/diff` after snapshot recovers.

**Files.** `packages/cli/src/serve.ts`, `serve.test.ts`.

**Done when.** A GET snapshot test spies `runtimeForSession` and sees zero calls, HEAD unchanged with the flag set, and a later `/diff` or submit finishes the reset.

---

### R5.1–R5.2 Eval + docs

**Why.** Unit tests can rot if the runner never sees construct-as-recover.

**Contract.**

- `rewind-reset-on-resume`: flag set, later HEAD; `await createSessionEngine(...)` finishes the reset (HEAD = flag sha, flag gone). First `submitMessage` is a no-op on the flag (already cleared). Construct reset-fail does not throw; submit retries. GET snapshot is a serve unit test, not this eval dir.
- Docs: schema **11**, construct recovers, GET snapshot does not attach, sliver filled without HEAD inference.

**Files.** `packages/core/src/eval/run.ts`, `run.test.ts`, fixture dir (existing), ARCHITECTURE / CHANGELOG / prior specs’ amendment lines.

**Done when.** `bun test ./packages/core/src/eval/run.test.ts` fails if construct-with-flag leaves HEAD later.

---

## Out of this horizon

Web chat UI, Next.js BFF, Prisma Task, Socket.IO, y0 Shadow wiki / indexer, eve compiler, OpenAPI connections, memory slots, `defineState`, credential brokering, self-mod, any new chat network, sandbox network policy, Grep/Glob docker-exec, `ignored`, cancel-without-live abort-pair, interrupt abort-pair, extra schema columns, `createSessionEngineSync`, auto-reset on `loadSession`, HEAD-inference reset, leftover-ask abort/I2/202/tree-stop edits.

---

## Suggested order

1. **R0.1** with the spec file (this commit is spec+plan only; pointer pass lands with the code).
2. **R1** (migration + dual-write + load).
3. **R2** (combined write + rewind persist-first).
4. **R4 then R3** in one wave (snapshot split **before** construct recover, then async factory + 176 awaits).
5. **R5** last.

---

## Success checks

A slice that does not move one of these is out of scope.

1. Fresh install and v10 upgrade reach `schema_version` 11 with `pending_reset_sha` copied from `job_json` (R1).
2. Load prefers a non-empty column over `job_json`; upsert dual-writes both (R1).
3. Job rewind compact + flag are one SQLite write; throw leaves messages active, no flag, HEAD unchanged (R2).
4. Crash after that write, before git reset: `await createSessionEngine(...)` finishes the reset (R3).
5. GET snapshot with the flag set does not reset HEAD and does not call `createSessionEngine` (R4).
6. Submit / `/diff` after snapshot still recover (R4).
7. Eval fixture fails the runner if 4 regresses (R5).

---

## Key decisions

1. **Theme is recover honesty, not a new host.** No new route. No web UI.
2. **One SQLite write fills the sliver.** Inference from HEAD would rewind operator commits; cancel-reset ruling 14 was right to forbid it and wrong to leave the two-write hole.
3. **Column is source of truth; `job_json` is dual-written in v11** so old readers do not drop the flag. Load prefers a non-empty column.
4. **Construct is a recover point; GET snapshot is not.** Snapshot is a read. Stream attach is a live host and may recover.
5. **Combined-write throw does not git reset.** Persist-first matches `writeFollowup` / keep-id clear. Amends cancel-reset ruling 9.
6. **No sync factory escape hatch.** `createSessionEngineSync` would skip recover. ACP `engineFactory` stays sync by closing over an already-awaited engine / `wrapBoot`.
7. **This spec amends earlier OUT rulings** for the three named holes only. Abort / I2 / 202 / tree-stop stay closed.
