# RavenClaw next-horizon roadmap (no-job todo revert)

Date: 2026-09-18  
Status: implemented on this branch  
Reviewed against tree at `9fb6ccc` (`main` after cancel-reset-followup `5eefdde`, docs honesty `5431004`, Dependabot `6716d3a`, residual nits `9fb6ccc`).  
Successor to `2026-09-18-cancel-reset-followup.md` (Status: implemented). Does not reopen that spec’s closed doors except the one hole named here.  
Next horizon (this branch): [`2026-09-18-stream-version-token.md`](2026-09-18-stream-version-token.md) (amends this spec’s OUT for stream `version` / `continuationToken` only).

Implementation plan: [2026-09-18-no-job-todo-revert.md](../plans/2026-09-18-no-job-todo-revert.md).

Sources: current tree. No new steal from eve/y0.

Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not become a hosted Task runner. Do not add a web UI.

---

## Where we are

The waist is shipped: leftover-ask, session-as-job, job-host, persist-before-reset rewind, project `todo.json` projection, live cancel abort-pair, reset-on-resume, follow-up persist-first.

`session.todos` is the source of truth. `.ravenclaw/todo.json` is a projection. **Job** `/rewind` restores `session.todos` from the remaining assistant’s `checkpoint.todoSnapshot` (or `[]` at `baseCommitSha`) and re-projects the file. **No-job** `/rewind` still only persists the transcript drop and `fileHistory.undo()`. It does not touch `session.todos` or the file.

That was parked because no-job had no snapshot. It is now the remaining honesty hole on the default cwd path: a turn that `TodoWrite`s `[b]` and is then rewound still shows `[b]`.

`stampCheckpoint` runs only inside `if (session.job)` after a success reason with no leftover-ask. `checkpointFromJson` requires `commitSha` to be a string, so a todo-only stamp would not survive load today. `fileHistory` generations live in process RAM (backups on disk, the generation list does not); they are not a durable todo store.

This horizon **unparks only no-job todo revert**. It does not unpark schema v11, parent-cancels-child, interrupt abort-pair, or cancel-without-live.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers.
2. Default prefix stays small and frozen. No new always-on tool. Rewind and todo projection stay **session ops**, not tools.
3. `dontAsk` never becomes `bypass`.
4. BYOK is the product. Ads never touch BYOK.
5. Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
6. `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
7. Leftover-ask still wins rewind: `rewindLast` refuses when any owned unpaired pending ask exists. Edit-resubmit stays host composition (`rewindLast` then `submitMessage`).
8. No-job persist-then-undo order stays. This horizon adds a restore after a successful undo, not a new undo order.
9. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.

---

## Do not build

- Web chat UI, Next.js BFF, Prisma Task, Socket.IO
- keep-id `/clear`, stream `version` / `continuationToken` (amended by `2026-09-18-stream-version-token.md`)
- `ignored` as a leftover-ask result
- Cancel with no live turn abort-pairing parked asks
- `abort('interrupt')` abort-pairing leftover-asks
- Parent cancel abort-pairing a child leftover-ask
- Schema version bump (no new column; v11 stays parked)
- Empty `commitSha: ''` sentinel (omit the field; do not write a fake sha)
- Putting todo snapshots on `fileHistory` generations
- Changing no-job persist-then-undo order
- Changing `TodoWrite` persist-then-file order
- Making `.ravenclaw/todo.json` the source of truth
- Inventing a no-job git checkpoint / `pendingResetSha` on cwd sessions
- Restoring `session.todos` from `/undo` (file-history only; this horizon is `/rewind`)
- Auto-reset / todo restore on `loadSession` / GET snapshot
- Default-on auto-commit / auto-PR

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

### Snapshot source

1. **Reuse `messages.checkpoint_json`.** No schema bump. `JobCheckpoint.commitSha` becomes optional. A no-job stamp is `{ todoSnapshot, dirty: false }` with **`commitSha` omitted**. `dirty` is always `false` on that path (there is no git). Copy the items (`map` a shallow clone), same as `stampCheckpoint`.
2. **New helper `stampTodoSnapshot(message, todos)`.** Writes the shape in (1) onto the last assistant. Does not call `runGit`. Job path keeps `stampCheckpoint` (sha + dirty + todos) and does **not** also call this helper.
3. **`checkpointFromJson` must load a todo-only stamp.** Today it returns `undefined` unless `commitSha` is a string. After this horizon: require `dirty` to be a boolean; accept `todoSnapshot` via `parseTodoItems`; set `commitSha` only when it is a **non-empty** string. Missing, empty, or non-string `commitSha` → field omitted. A row with no usable `dirty` is still `undefined`.
4. **Job rewind ignores sha-less checkpoints.** `rewindToCheckpoint` / `maybeFinishRewindReset` take the last remaining assistant whose `checkpoint.commitSha` is a non-empty string, else `baseCommitSha` and `[]` todos (same as today when no git checkpoint exists). A todo-only stamp must not become `git reset --hard` of `undefined` or `''`.
5. **File-history is not a snapshot store.** Generations are in-process. Do not hang todos off `FileSnapshot` / `Generation`.

### When to stamp

6. **Stamp no-job at the same settle point as job checkpoints.** After the turn writes `lastEnd`, when `!session.job`, `end.reason` is `completed | hook_stopped | max_rounds | context_full`, and `listPendingAsks(session.id)` is empty. Last assistant only. Persist via existing `persistToolCalls` / `persistAssistant`. Persist throw does **not** fail the turn (same comment as job).
7. **Do not stamp cancelled / aborted / failed.** The previous assistant’s stamp (if any) is the restore source. Leftover-ask still blocks rewind, so a missing stamp on an unfinished turn is not a rewind hole.

### Restore on no-job rewind

8. **Restore only after a successful no-job rewind that dropped at least one message.** `rewindLastTurn` keeps persist-then-undo. Open generation still refuses **before** persist. Persist fail still leaves files, messages, and `session.todos`. Undo `blocked` after persist stays the existing sliver (do not restore todos; return original messages). `droppedIds.length === 0` → do not touch `session.todos` or the file (file-only undo is not a turn rewind).
9. **Restore source, in order.** Walk `next` from the end. First assistant that has a `checkpoint` wins (empty `todoSnapshot: []` is a real snapshot — copy it). No remaining assistant at all → `[]`. Remaining assistants exist but **none** have a `checkpoint` (pre-horizon transcript) → **leave `session.todos` unchanged** and **do not re-project**. Accepted sliver: do not wipe or invent. `/undo` never consults this table.
10. **Persist-first on the session row.** Build the next `todos` / `updatedAt`. `upsertSession` a record that already has them. Only after upsert resolves, assign `session.todos`. Upsert throw → memory `session.todos` unchanged, `{ ok: false, notice: 'rewind persist failed' }`, `messages` = `next` (compact already landed; same class as job’s post-reset upsert fail). Do not un-compact. Do not re-run `fileHistory.undo` backwards.
11. **Then re-project.** After a successful todos upsert, `projectSessionTodos(session.cwd, session.todos ?? [])` (no-job has no worktree; root is `session.cwd`, which is already `originalCwd ?? cwd` for cwd sessions). Empty list writes `[]\n`. Projection throw → notice suffix `; todo.json write failed: <detail>`, `ok` stays `true`, `session.todos` stays restored. No `jobError` (no-job has no job epilogue).
12. **`rewindLastTurn` grows the session handle.** It must receive `session` + `store` to upsert and project. `createSessionEngine.rewindLast` already has both; pass them. Do not add `store` to `jobDiff`. Do not restore todos from TUI/serve after the fact — the engine op is the writer.
13. **This spec amends earlier OUT rulings** for no-job todo revert only: `2026-09-18-rewind-persist-and-todo-projection.md` ruling 8 / Do-not-build “Reverting no-job `session.todos`”, and the cancel-reset-followup Out list. Other parked doors stay closed.

---

## Per-slice board

Board as of this branch (`docs/no-job-todo-revert-spec`); not on `main`.

| ID | Status vs tree |
|---|---|
| J0.1 docs point at this spec | **done** |
| J1.1 `commitSha?` + `checkpointFromJson` + `stampTodoSnapshot` | **done** |
| J1.2 no-job success turn stamps and persists | **done** |
| J1.3 job rewind skips sha-less checkpoints | **done** |
| J2.1 no-job rewind restores from remaining snapshot | **done** |
| J2.2 persist-first upsert; upsert fail leaves memory todos | **done** |
| J2.3 projection after restore; fail is notice suffix | **done** |
| J2.4 legacy (no checkpoint) leaves todos; no drop → no restore | **done** |
| J3.1 eval fixture | **done** |

---

## Waves

```
Wave J0  docs pointer
Wave J1  stamp + parse                 (independent of J2 tests that inject a checkpoint)
Wave J2  rewindLastTurn restore        (needs J1.1 parse; can inject stamps in tests)
Wave J3  eval lock
```

J1.1 before J1.2 (helper + parse first). J2 may start after J1.1. Do not parallel J2.1 and J2.2 — same function, fail vs success order.

---

## Wave J0 — Docs point here

### J0.1 Pointers

**Why.** ARCHITECTURE / README / remaining-roadmap / rewind and cancel specs still say no-job rewind does not restore todos, or list this hole as OUT.

**Contract.**

- Mark this file as the next horizon from `2026-09-18-cancel-reset-followup.md`, `2026-09-18-rewind-persist-and-todo-projection.md` (ruling 8 becomes “amended by this spec”), `2026-09-12-ravenclaw-remaining-roadmap.md`, `ARCHITECTURE.md` / `.ko.md`, `README.md`, `SLASH_COMMANDS.md` / `.ko.md` if they describe no-job `/rewind` without todos.
- Historical OUT lines stay; add a one-line amendment at the top / Do-not-build bullet. Do not rewrite shipped wave text.

**Done when.** Those files link here. No-job rewind is no longer described as “drop + file undo only.”

---

## Wave J1 — Stamp and parse

Goal: a no-job success turn leaves a durable `todoSnapshot` on the last assistant. Load must see it. Job rewind must not treat it as a git sha.

### J1.1 Type, parse, helper

**Why.** `checkpoint_json` already exists (schema v8). The parser is what drops a sha-less stamp.

**Contract.**

```ts
export type JobCheckpoint = {
  commitSha?: string
  todoSnapshot: TodoItem[]
  dirty: boolean
}

export function stampTodoSnapshot(
  message: Extract<Message, { role: 'assistant' }>,
  todos: TodoItem[] | undefined,
): void
```

- `stampTodoSnapshot` sets `message.checkpoint = { todoSnapshot: (todos ?? []).map(item => ({ ...item })), dirty: false }`. No `commitSha` key.
- `checkpointFromJson`: `dirty` must be boolean; `commitSha` copied only if `typeof === 'string' && length > 0`.
- Round-trip test: persist a sha-less checkpoint, `loadMessages`, `checkpoint.commitSha` is `undefined`, `todoSnapshot` matches.
- Existing job checkpoint tests still see a non-empty `commitSha`.

**Files.** `packages/core/src/types.ts`, `packages/core/src/session/job.ts`, `job.test.ts`, `packages/core/src/session/sqlite-store.ts`, `sqlite-store.test.ts`.

**Done when.** A sha-less `checkpoint_json` loads. `stampTodoSnapshot` does not call git.

### J1.2 No-job turn stamps

**Contract.**

- Same `isJobSuccessReason` set. `!session.job`. No rows from `listPendingAsks(session.id)`.
- After `upsertSession` of `lastEnd` (keep that write). Then stamp + persist last assistant.
- Job sessions do not call `stampTodoSnapshot`.
- Persist throw is swallowed; the turn’s `RoundEnd` is unchanged.

**Files.** `packages/core/src/loop/session-engine.ts`, `session-engine.test.ts`.

**Done when.** A no-job turn that `TodoWrite`s `[b]` and completes has `lastAssistant.checkpoint.todoSnapshot === [b]` after load. A job turn still has `commitSha`. A cancelled no-job turn has no new stamp.

### J1.3 Job rewind skips sha-less

**Contract.** If the last remaining assistant has only a todo-only stamp and an earlier assistant has `{ commitSha, todoSnapshot }`, job rewind resets to that sha (or, if none, `baseCommitSha` + `[]`). Add a unit test that injects a sha-less last assistant; HEAD / todos follow the last **git** checkpoint.

**Files.** `packages/core/src/session/rewind.ts`, `rewind.test.ts`.

**Done when.** That test is green. Existing job rewind tests stay green.

---

## Wave J2 — Restore on rewind

Goal: no-job `/rewind` of a stamped turn puts `session.todos` and project `todo.json` back to the previous snapshot.

### J2.1 Restore

**Contract.**

```
peekLast.open → refuse, originals, no persist
drop last user in memory
if droppedIds.length > 0:
  recordCompact
  on throw → rewind persist failed, originals, todos unchanged
fileHistory.undo()
on blocked → existing sliver (originals in the return; no todo restore)
if droppedIds.length === 0 → return undo notice; todos unchanged
walk next from the end for a checkpoint (ruling 9)
if assistants remain and none have a checkpoint → return ok, messages = next, todos unchanged, no project
upsert session with restored todos (ruling 10)
assign session.todos
projectSessionTodos(session.cwd, session.todos ?? [])
```

**Files.** `packages/core/src/session/rewind.ts`, `rewind.test.ts`, `packages/core/src/loop/session-engine.ts` (pass `session`).

**Done when.** No-job session: assistant1 stamped `[a]`, turn2 writes `[b]`; `rewindLast` → `session.todos === [a]`, last user of turn2 gone. Engine `rewindLast` on a no-job session with a store sees the same after `loadSession`.

### J2.2 Upsert fail

**Contract.** Stub `upsertSession` to throw after compact + undo. `ok: false`, `notice === 'rewind persist failed'`, `messages === next`, in-memory `session.todos` still `[b]`, loaded session todos still `[b]`. Files already undone (accepted; same class as today’s persist-then-undo).

**Done when.** That test is green. Persist-fail **before** undo still leaves files and the last user (existing test).

### J2.3 Projection

**Contract.** After a successful restore, project `todo.json` under `session.cwd` matches `session.todos`. Stub `projectSessionTodos` to throw → `ok: true`, notice contains `todo.json write failed`, `session.todos` is the snapshot.

**Done when.** File bytes match job projection (`JSON.stringify(items, null, 2) + '\n'`).

### J2.4 Legacy and no-drop

**Contract.**

- Remaining assistant has no `checkpoint` → todos unchanged, `todo.json` not written by rewind.
- No remaining assistant (rewind of the first user turn) → `session.todos = []`, project `[]\n`.
- `droppedIds.length === 0` → todos unchanged even if a later assistant has a stamp.

**Done when.** Three tests pin those three rows of ruling 9 + ruling 8’s no-drop clause.

---

## Wave J3 — Eval lock

### J3.1 Fixture

**Contract.** One eval case in `packages/core/src/eval/fixtures/`:

| Case | Assert |
|---|---|
| `rewind-no-job-todo-revert` | No-job: turn1 stamps `[a]`, turn2 writes `[b]`, `rewindLast` → `session.todos` and project `todo.json` equal `[a]`; persist-fail before undo leaves `[b]` and the last user |

**Files.** `packages/core/src/eval/run.ts`, `run.test.ts`, the fixture dir. Copy helpers locally in `run.ts`; do not import from test files. Unknown directory names still throw.

**Done when.** `bun test ./packages/core/src/eval/run.test.ts` fails if J2.1 or the existing persist-fail-before-undo contract regresses.

---

## Out of this horizon

Web chat UI, Next.js BFF, Prisma Task, Socket.IO, y0 Shadow wiki / indexer, eve compiler, OpenAPI connections, memory slots, `defineState`, credential brokering, self-mod, any new chat network, sandbox network policy, Grep/Glob docker-exec, `ignored`, keep-id `/clear`, stream `version` / `continuationToken` (amended by `2026-09-18-stream-version-token.md`), schema v11, async `createSessionEngine`, cancel-without-live abort-pair, interrupt abort-pair, parent-cancels-child-ask, no-job git checkpoint, `fileHistory` todo frames.

If a later product wants schema v11, it still needs a column this horizon does not have. Todo-only stamps fit in `checkpoint_json`.

---

## Suggested order

1. **J0.1** with the spec file.
2. **J1.1** then **J1.2** then **J1.3**.
3. **J2.1 + J2.4** then **J2.2** then **J2.3** (success + legacy first; fail paths last).
4. **J3.1** last.

---

## Success checks

A slice that does not move one of these is out of scope.

1. No-job success turn persists a sha-less `todoSnapshot` that `loadMessages` returns (J1).
2. Job rewind still uses a non-empty `commitSha` and ignores a later sha-less stamp (J1.3).
3. No-job rewind of a stamped turn restores `session.todos` to the previous snapshot (J2.1).
4. Upsert fail after undo leaves memory todos on the pre-rewind list and does not un-compact (J2.2).
5. Projection I/O fail does not undo the restore (J2.3).
6. Legacy transcripts without a checkpoint do not wipe `session.todos` (J2.4).
7. Eval fixture fails the runner if 3 or persist-before-undo regress (J3).

---

## Key decisions

1. **Theme is rewind honesty on the default cwd path, not a job feature.** Hosts still `rewindLast` / `POST …/edit`. No new route.
2. **The missing piece was a durable snapshot, not a schema.** `checkpoint_json` already stores `todoSnapshot`. Making `commitSha` optional is a parse/type change.
3. **Do not hang todos on `fileHistory`.** RAM generations die with the process; rewind after restart would lie.
4. **Do not write `commitSha: ''`.** `??` does not treat `''` as missing; `git reset --hard ''` is a footgun. Omit the field; job rewind requires a non-empty sha.
5. **Legacy silence over a wipe.** Pre-horizon no-job assistants have no checkpoint. Leaving todos unchanged is better than setting `[]` and deleting the operator’s list.
6. **Persist-first on the session row matches `writeFollowup`.** Memory must not show restored todos when disk still has the later list.
7. **This spec amends earlier OUT rulings** for no-job todo revert only. Other parked doors stay closed.
