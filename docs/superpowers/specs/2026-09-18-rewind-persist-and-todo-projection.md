# RavenClaw next-horizon roadmap (rewind persist-before-reset)

Date: 2026-09-18  
Status: implemented  
Shipped on `main` at `048deff`.  
Reviewed against tree at `ac2d184` (`main` after job-host PR #9 + shipped-docs PR #11).  
Successor to `2026-09-17-job-host-state-roadmap.md` (Status: implemented). Does not reopen that spec’s closed doors.  
Next horizon (implemented at `5eefdde`): [`2026-09-18-cancel-reset-followup.md`](2026-09-18-cancel-reset-followup.md) (amends this spec’s OUT for live cancel abort-pair and reset-on-resume only). After that (implemented at `be5a4a7`): [`2026-09-18-no-job-todo-revert.md`](2026-09-18-no-job-todo-revert.md) (amends ruling 8 / no-job todo revert). Then (this branch): [`2026-09-18-stream-version-token.md`](2026-09-18-stream-version-token.md) (amends this spec’s OUT for stream `version` / `continuationToken` only).

Sources: current tree, [y0 analysis](../../research/y0-analysis.md) (`/Users/yeonwoosung/Desktop/y0`, read-only), [eve analysis](../../research/eve-analysis.md) (`/Users/yeonwoosung/Desktop/eve`, Apache-2.0, read-only).

Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not become a hosted Task runner. Do not add a web UI.

---

## Where we are

A session can own a named `raven/*` job, reconnect, follow up, edit-resubmit the last user, and read `jobDiff`. Closeout made `TodoWrite` fail-closed and todos session-scoped (`sessions.todos_json`). No-job `/rewind` already persists the transcript drop (`recordCompact`) **before** `fileHistory.undo()`.

The remaining hole **at review time** was job rewind and the human-visible todo file. Landed on `main` at `048deff`. The table below is the pre-land snapshot.

| Piece | Tree at `ac2d184` |
|---|---|
| No-job rewind | `rewindLastTurn`: persist drop first; undo files second; persist fail leaves the tree and the messages |
| Job rewind | `rewindToCheckpoint`: `git reset --hard` **first**, then `recordCompact`. Persist fail leaves HEAD already reset. Reset fail today skips persist (test-pinned) |
| Session todos | Restored from `checkpoint.todoSnapshot` (or `[]` at `baseCommitSha`) and upserted |
| `.ravenclaw/todo.json` | `TodoWrite` writes it under `projectCwd ?? cwd` **after** `updateSessionTodos`. Job `git reset --hard` is in `worktreePath` and does **not** touch the project file. Rewind never re-projects. TUI reads `session.todos ?? loadTodos(cwd)` |

Crash after reset and before persist: resume still shows the later user turn, but the worktree is already at the earlier sha. That is the same class of lie persist-before-execute exists to prevent.

y0 edit-message restores `{ commitSha, todoSnapshot }` then the host resubmits. RavenClaw already restores those two on the session. It does not persist the drop first, and it does not write the projection file.

---

## Constraints (unchanged)

1. One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer and does not start a model turn.
2. Default prefix stays small and frozen. No new always-on tool. Rewind and todo projection are **session ops**, not tools.
3. `dontAsk` never becomes `bypass`.
4. BYOK is the product. Ads never touch BYOK.
5. Clean-room. Steal semantics. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**.
6. `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row. This horizon must not change that law and must not record that return as `lastEnd`.
7. Live `/cancel` abort-pair of a parked leftover-ask stays OUT.
8. Leftover-ask still wins rewind: `rewindLast` refuses when any owned unpaired pending ask exists. Edit-resubmit stays host composition (`rewindLast` then `submitMessage`).

---

## Do not build

- y0’s Next.js + Prisma `Task` + Socket.IO room
- Web chat UI, keep-id `/clear`, stream `version` / `continuationToken` (amended by `2026-09-18-stream-version-token.md`)
- Reverting no-job `session.todos` on rewind (amended by `2026-09-18-no-job-todo-revert.md`)
- Changing no-job order (already persist-then-undo)
- Changing `TodoWrite` persist-then-file order (already correct)
- Making `.ravenclaw/todo.json` the source of truth again
- Schema bump (no new column)
- Automatic reset-on-resume if persist landed and reset did not (no second recover loop)
- `ignored`, live cancel abort-pair, default-on auto-commit / auto-PR

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

1. **No schema bump.** Session todos and checkpoints already exist (v7 / v8). This horizon reorders job rewind and writes a file.
2. **Persist-before-reset on the job path.** `rewindToCheckpoint` must `recordCompact` the dropped ids (when any) **before** `git reset --hard`. Persist fail → `{ ok: false, notice: 'rewind persist failed' }`, original messages, HEAD unchanged, `session.todos` unchanged, no `jobError` from persist (same notice as no-job).
3. **Reset fail after a successful persist.** Store already dropped the last user turn. Return `{ ok: false, notice: 'rewind reset failed: …' }`, `messages` = the already-dropped list, `setSessionJobError`, HEAD unchanged. Do **not** un-compact. The current test that reset-fail leaves messages active is **wrong after this horizon** and must flip.
4. **Crash window is accepted in one direction only.** Persist succeeded, process died before reset: resume shows the dropped transcript and a later HEAD. That is better than a reset tree with a lying transcript. Do not auto-finish the reset on `loadSession`.
5. **`session.todos` is the source of truth.** After a successful job rewind, set `session.todos` from `checkpoint.todoSnapshot` (or `[]` when rewinding to `baseCommitSha` with no earlier assistant checkpoint), then `upsertSession`.
6. **`.ravenclaw/todo.json` is a projection of `session.todos`.** After that upsert, write the file under the **project** root: `getSessionWorktree(session.id)?.originalCwd ?? session.cwd` (same root `TodoWrite` uses via `projectCwd ?? cwd`). Pretty-print + trailing newline, same as `TodoWrite`. Empty list writes `[]\n` (do not delete the file).
7. **Projection fail does not undo rewind.** Persist + reset + session upsert already succeeded. Append a notice suffix (`todo.json write failed: …`). `ok` stays `true`. `session.todos` stays restored. `jobError` is **not** set (file projection is not a job epilogue).
8. **No-job rewind does not re-project** unless a later spec invents a snapshot. Amended by [`2026-09-18-no-job-todo-revert.md`](2026-09-18-no-job-todo-revert.md): no-job success turns stamp a sha-less `todoSnapshot`; rewind restores and re-projects.
9. **Targeted `bun test <files>` only.** Isolated worktree. Do not implement on `main` without consent. Do not copy y0/eve source.

---

## Per-slice board

Board as of this branch (`feat/rewind-persist-todo`); H0.1 shipped on `main` at `c851668` (PR #12).

| ID | Status vs tree |
|---|---|
| H0.1 docs point at this spec | **shipped** (PR #12 / `c851668`) |
| H1.1 persist drop before `git reset --hard` | **shipped** |
| H1.2 persist fail leaves HEAD and messages | **shipped** |
| H1.3 reset fail after persist keeps the drop | **shipped** |
| H2.1 `projectSessionTodos(root, items)` helper | **shipped** |
| H2.2 job rewind re-projects after upsert | **shipped** |
| H2.3 projection fail is a notice suffix | **shipped** |
| H3.1 eval fixtures | **shipped** |

---

## Waves

```
Wave H0  docs pointer
Wave H1  persist-before-reset          (job rewind cannot lie after a crash)
Wave H2  todo.json projection          (file matches session.todos after rewind)
Wave H3  eval lock
```

H2 may start after H1.1 (needs a successful persist-then-reset path). H2.1 can land with H2.2 in one task if the helper is tiny. Do not parallel H1.1 and H1.3 — same function, opposite fail order.

---

## Wave H0 — Docs point here

### H0.1 Pointers

**Why.** ARCHITECTURE / README / remaining-roadmap still say the next work is this hole with “no spec yet.”

**Contract.**

- Mark this file as the next horizon from `2026-09-17-job-host-state-roadmap.md`, `2026-09-16-session-as-job-roadmap.md`, `2026-09-12-ravenclaw-remaining-roadmap.md`, `ARCHITECTURE.md` / `.ko.md`, `README.md`, eve/y0 analysis closers.
- Historical: pointers landed on `main` before code (`c851668` / PR #12); Status is `implemented` on this branch so the merge is honest.

**Done when.** Those files link here. Job-host no longer says “no spec yet.”

---

## Wave H1 — Persist-before-reset

Goal: a job rewind that cannot reset the worktree unless the transcript drop is durable.

### H1.1 Order

**Why.** Persist-before-execute: the store is written before the world changes. Job rewind currently changes the world first.

**Contract.**

```
drop last user turn in memory
if droppedIds.length > 0:
  recordCompact(...)          # MUST succeed before reset
  on throw → rewind persist failed, original messages, no reset
git reset --hard <checkpoint sha | baseCommitSha>
on reset fail → H1.3
restore session.todos from snapshot (or [])
upsertSession
clearSessionJobError
return ok, dropped messages
```

No-job `rewindLastTurn` stays as it is (persist then `fileHistory.undo()`).

**Files.** `packages/core/src/session/rewind.ts`, `rewind.test.ts`.

**Done when.** A test that stubs `recordCompact` to throw sees HEAD unchanged and original messages. A test that spies call order sees `recordCompact` before `git reset`.

### H1.2 Persist fail is a no-op on the tree

**Contract.** Same notice as no-job: `rewind persist failed`. No `jobError`. `session.todos` unchanged. Loaded messages still include the last user.

**Done when.** The existing no-job persist-fail test still passes; the job path gains the same assertion on HEAD.

### H1.3 Reset fail after persist

**Why.** The drop is already the truth. Un-compacting would fight the store. Leaving the later messages in memory while the store dropped them is a second lie.

**Contract.**

- `notice` still starts with `rewind reset failed:`.
- `setSessionJobError` + `upsertSession` (same as today).
- `messages` = dropped list (`next`), not the pre-rewind array.
- HEAD unchanged.
- `session.todos` **unchanged** (do not apply the snapshot if reset did not happen).
- Loaded messages no longer include the dropped ids.

**Files.** Flip `rewind.test.ts` `reset failure does not inactivate messages and returns originals`.

**Done when.** That test expects inactivated ids, `result.messages` === `next`, and HEAD still at the later sha.

---

## Wave H2 — `todo.json` projection

Goal: after a successful job rewind, a human (or `loadTodos`) reading the project file sees the restored session list.

### H2.1 Helper

**Why.** `TodoWrite` already writes the same file. Do not fork the format.

**Contract.**

```ts
export function projectSessionTodos(root: string, items: TodoItem[]): void
```

Writes `todoJsonPath(root)` as `${JSON.stringify(items, null, 2)}\n`. `mkdirSync` recursive. Throws on I/O error (caller decides). `TodoWrite.execute` may call this after `updateSessionTodos` (optional DRY in the same task; not required if rewind is the only new caller).

**Files.** `packages/core/src/tools/todo.ts`, `todo.test.ts`.

**Done when.** Helper write matches today’s `TodoWrite` bytes for the same items.

### H2.2 Rewind re-projects

**Contract.**

- Root = `getSessionWorktree(session.id)?.originalCwd ?? session.cwd`.
- Call **after** `session.todos` is assigned and `upsertSession` succeeds.
- Empty snapshot writes `[]\n`.
- Do not write inside the worktree unless that path *is* the project root (no-job / cwd session).

**Files.** `rewind.ts`, `rewind.test.ts`.

**Done when.** Project `todo.json` has the later list; rewind to a checkpoint whose snapshot is `[{ text: 'a', status: 'pending' }]`; file becomes that list even though `git reset --hard` never touched the project file.

### H2.3 Projection fail

**Contract.** Persist + reset + upsert already done → `ok: true`. Notice is the usual rewind notice plus `; todo.json write failed: <detail>`. No `jobError`. Session todos stay restored.

**Done when.** Stub `projectSessionTodos` to throw; HEAD is the checkpoint sha; `session.todos` is the snapshot; notice contains `todo.json write failed`.

---

## Wave H3 — Eval lock

### H3.1 Fixtures

**Contract.** Two eval cases in `packages/core/src/eval/fixtures/`:

| Case | Assert |
|---|---|
| `rewind-persist-before-reset` | Job rewind: persist fail leaves HEAD; success records compact then resets |
| `rewind-todo-project` | After successful job rewind, project `todo.json` equals `session.todos` |

**Files.** `packages/core/src/eval/run.ts`, `run.test.ts`, the two `case.json` files.

**Done when.** `bun test packages/core/src/eval/run.test.ts` fails if H1.1 or H2.2 regress.

---

## Out of this horizon

Web chat UI, Next.js BFF, Prisma Task, Socket.IO, y0 Shadow wiki / indexer, eve compiler, OpenAPI connections, memory slots, `defineState`, credential brokering, self-mod, any new chat network, sandbox network policy, Grep/Glob docker-exec, `ignored`, live cancel abort-pair, keep-id `/clear`, stream `version` / `continuationToken` (amended by `2026-09-18-stream-version-token.md`), no-job todo revert (amended by `2026-09-18-no-job-todo-revert.md`), reset-on-resume recovery, schema v11.

If a later product wants a browser, it still implements G0–G3 on the existing F3 stream. This horizon does not add a client.

---

## Suggested order

1. **H0.1** with the spec file.
2. **H1.1 + H1.2** then **H1.3** (same function; flip the reset-fail test last so H1.1 is green first).
3. **H2.1** then **H2.2 + H2.3**.
4. **H3.1** last.

---

## Success checks

A slice that does not move one of these is out of scope.

1. Job `recordCompact` runs before `git reset --hard` (H1.1).
2. Persist fail leaves HEAD and the last user row (H1.2).
3. Reset fail after persist keeps the drop, sets `jobError`, does not apply the todo snapshot (H1.3).
4. Successful job rewind writes project `todo.json` from `session.todos` (H2.2).
5. Projection I/O fail does not undo persist or reset (H2.3).
6. Eval fixtures fail the runner if 1 or 4 regress (H3).

---

## Key decisions

1. **Theme is rewind honesty, not a new job feature.** Hosts still `rewindLast` / `POST …/edit`. No new route.
2. **Persist-before-reset matches persist-before-execute.** The transcript is the recovery record. The worktree is the effect.
3. **Reset-fail after persist does not un-compact.** Two sources of truth is worse than a dropped turn the operator can retype (`droppedText` already exists).
4. **`todo.json` stays a projection.** `git reset` in the worktree cannot be the writer of the project file.
5. **Projection fail is not a job error.** The job epilogue (`reset`) succeeded. The file is best-effort for humans/git.
6. **No schema bump.** The lie is ordering and a missing write, not a missing column.
