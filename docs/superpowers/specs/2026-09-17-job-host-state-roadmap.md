# RavenClaw next-horizon roadmap (job-host state)

Date: 2026-09-17  
Status: implemented  
Shipped on `main` at `6e56764` (merge of PR #9 / `feat/job-host-state`).  
Review-fix on the same merge (`981ec2a`): follow-up runs only after this submit wrote `lastEnd`; owned leftover-asks (parent + child) skip the slot; OpenTUI bare `/retry` resubmits `droppedText`.  
Reviewed against tree at `0ef1554` (`main` after session-as-job + closeout).  
Successor to `2026-09-16-session-as-job-roadmap.md` (Status: implemented). Does not reopen that spec’s closed doors.  
Next horizon (implemented at `048deff`): [`2026-09-18-rewind-persist-and-todo-projection.md`](2026-09-18-rewind-persist-and-todo-projection.md).

Sources: current tree, [y0 analysis](../../research/y0-analysis.md) (`/Users/yeonwoosung/Desktop/y0`, read-only), [eve analysis](../../research/eve-analysis.md) (`/Users/yeonwoosung/Desktop/eve`, Apache-2.0, read-only).

Implementation plan: [2026-09-17-job-host-state-implementation.md](../plans/2026-09-17-job-host-state-implementation.md) (11 TDD tasks, Waves G0–G4). Binding plan rulings live at the top of that file (schema v10, `lastEnd` serialize, one-slot `followup`, `maybeRunFollowup`, `jobDiff`).

Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not become a hosted Task runner. Do not add a web UI.

---

## Where we are

A session can own a named `raven/*` job, reconnect a serve stream (`seq` / `?after=`), cancel without failing, and optionally `/pr`. Closeout `0ef1554` made ACP timeout replay, TodoWrite fail-closed, `draft_pr` annotation, and child `raven/*` GC honest.

The remaining hole is not “missing a loop.” A job host (serve, later a browser, even `curl`) can tail events but **cannot tell why the last turn stopped, queue exactly one next prompt, edit the last user and resubmit, or see the job’s `base...HEAD` ∪ dirty diff.** Today:

| Piece | Tree at `0ef1554` |
|---|---|
| `GET /v1/session/:id` | `{ id, job?, pendingAsks, lastSeq, permissionMode, live }` — no `title`, `jobAutoCommit`, last `RoundEnd`, job-epilogue error, or queued follow-up |
| Last turn reason | `RoundEnd` is the `submitMessage` return value and a `round_end` stream event. Not on `SessionRecord`. Pending-gate returns `{ reason: 'completed' }` without a turn |
| Follow-up | TUI `/queue` is a multi-item mid-turn drain (`drainQueued`). Slack/Discord/serve `singleFlight` hides the next submit. No visible one-slot on the session |
| Edit last user | `/rewind` drops the last user turn (job: `rewindToCheckpoint`; no-job: file-history). Host then types a new prompt. Serve has no compose-rewind-and-submit. No dropped-text return |
| Diff | TUI `/diff` is cwd uncommitted + staged. `job.ts` `diffStat` is `fromSha...HEAD` numstat for `/pr` only. No `base...HEAD` ∪ dirty file list |

y0’s leftover lesson: a Task snapshot names `lastEndReason` / `jobError`; exactly one follow-up slot; edit-message restores the prior checkpoint then resubmits; diff is `base...HEAD` ∪ dirty.  
y0’s trap: Prisma `Task` + Socket.IO room + `TaskStatus` as a second waist.  
eve’s leftover that this horizon does **not** take: cancel `202` vs `200` envelope polish, keep-id `/clear`, stream `version` / `continuationToken`. Those stay parked.

This horizon thickens **session state the host already reads**. Hosts still only `submitMessage` for new user text. `applyAskAnswer` stays the only other closer.

---

## Constraints (unchanged)

1. One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer and does not start a model turn.
2. Default prefix stays small and frozen. No new always-on tool. Follow-up, edit-resubmit, and job diff are **host / session ops**, not tools.
3. `dontAsk` never becomes `bypass`. y0 isolation-trust is not a permission mode.
4. BYOK is the product. Ads never touch BYOK.
5. Clean-room. Steal semantics. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**.
6. `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row. This horizon must not change that law and must not record that return as `lastEnd`.
7. Live `/cancel` abort-pair of a parked leftover-ask stays OUT.

---

## Do not build

- y0’s Next.js + Prisma `Task` + Socket.IO room + `TaskStatus` / `InitStatus` state machine
- Replacing TUI `/queue` (mid-turn multi-item drain stays)
- Using `SuggestFollowups` as the one-slot (model-proposed chips ≠ host-queued next turn)
- Arbitrary mid-history edit (only the last user turn)
- Default-on auto-run of a follow-up after process restart
- Web chat UI, keep-id `/clear`, stream `version` / `continuationToken` 400
- Rewind persist-before-reset / `todo.json` re-project (later shipped at `048deff`: `2026-09-18-rewind-persist-and-todo-projection.md`)
- WorkspaceFs docker-exec, Grep/Glob docker-exec
- `ignored`, live cancel abort-pair of a parked leftover-ask
- Default-on auto-commit or auto-PR (already shipped off)

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

1. **Schema v10** in the same horizon: `sessions.last_end_json`, `sessions.job_error`, `sessions.followup_text`. No extra bump for G3. Pin every `schema_version 9` test when G0/G1 land.
2. **`lastEnd` is the last `RoundEnd` from a turn that actually entered `queryLoop`** (including `cancelled` / `aborted` / `hook_stopped` / errors). Do **not** write it on the pending-gate early return. Do **not** write it on a `UserPromptSubmit` block that never opened a turn unless the hook returns `hook_stopped` (that *is* an end — write it).
3. **`jobError` is the last failed job-epilogue notice** (`enter` / `maybeCommitJob` / `rewindToCheckpoint` / `openDraftPr`). Not leftover-ask. Not `RoundEnd.model_error` (that lives on `lastEnd`). Clear when a later job epilogue succeeds or a job turn ends `completed`.
4. **One follow-up slot, session-scoped.** `followup_text` is at most one string. A later set overwrites. Clear is explicit or automatic on `cancelled` / `aborted` / `model_error` / `persist_failed` / `results_persist_failed`. `/queue` and `drainQueued` do not read or write this slot.
5. **Auto-run the slot only in-process**, as a host epilogue after the turn that was live when the slot was set (or that just finished with the slot still set). Same success set as auto-commit: `completed` \| `hook_stopped` \| `max_rounds` \| `context_full`. Skip if any `pending_asks` remain. Persist-clear the slot **first**; if that write fails, leave the slot and do not submit (double-run is worse than loss). After process death the slot stays; the host reads `snapshot.queued` and `POST …/submit`s it. Serve must not auto-fire on `createSession`.
6. **Edit-resubmit is host composition**, not a third engine entry. Engine grows `rewindLast()` to return `{ ok, notice, droppedText? }`. Serve `POST /v1/session/:id/edit` rewinds then `submitMessage`s. Refuse when `liveTurn !== null`, when any owned pending ask exists, when there is no last user, or when `text` is empty. Only the last user turn. Job path keeps `rewindToCheckpoint`; no-job keeps file-history rewind.
7. **Job diff is read-only.** `baseCommitSha...HEAD` ∪ dirty (unstaged + staged vs `HEAD`). Ops `create` \| `update` \| `delete` \| `rename`. No turn. No tool. No job record → same notice style as `/pr` (`ok: false`, not 404).
8. **Targeted `bun test <files>` only.** Isolated worktree. Do not implement on `main` without consent. Do not copy y0/eve source.

---

## Per-slice board

Board as of `6e56764` on `main`. Pre-ship “missing” rows are historical; do not treat them as current.

| ID | Status vs tree |
|---|---|
| G0.1 docs point at this spec | **shipped** (honesty pass after `6e56764`) |
| G0.2 snapshot `title` / `jobAutoCommit` / `lastEnd` / `jobError` | **shipped** |
| G1.1 persist one-slot `followup_text` | **shipped** |
| G1.2 host epilogue run / clear | **shipped** (`runFollowupAfterSubmit`) |
| G1.3 snapshot `queued` | **shipped** |
| G2.1 `rewindLast` returns `droppedText` | **shipped** |
| G2.2 serve `POST …/edit` | **shipped** |
| G3.1 `jobDiff` helper | **shipped** |
| G3.2 serve `GET …/diff` + TUI `/diff` on a job | **shipped** |
| G4.1 eval fixtures | **shipped** |

---

## Waves

```
Wave G0  snapshot honesty     (host can name why the last turn stopped)
Wave G1  one-slot follow-up   (exactly one next prompt, visible on snapshot)
Wave G2  edit-resubmit        (rewind last user, then submitMessage)
Wave G3  job diff             (base...HEAD ∪ dirty, read-only)
Wave G4  eval lock
```

G0.2 and G1.1 share schema v10 — land G1.1 in the same migration even if G1.2 follows. G1.3 is a snapshot field once the slot exists. G2 may start after G0 (does not need the slot). G3 is independent of G1/G2.

---

## Wave G0 — Snapshot honesty

Goal: `GET /v1/session/:id` tells a reconnecting host what the session *is*, not only that it exists.

### G0.1 Docs point here

**Why.** `ARCHITECTURE.md`, `README.md`, and the remaining-roadmap still treat session-as-job as the live next horizon after closeout.

**Contract.**

- Mark this file as the next horizon from `2026-09-16-session-as-job-roadmap.md`, `2026-09-12-ravenclaw-remaining-roadmap.md`, `ARCHITECTURE.md` / `.ko.md`, `README.md`.
- `CHANGELOG.md` Unreleased already names closeout `0ef1554`; do not re-describe F0–F4.

**Files.** The docs listed above. No production behavior.

**Done when.** A reader of `ARCHITECTURE.md` can name this file as the open horizon.

### G0.2 Snapshot carries last end and job flags

**Why.** eve clients hold `{ sessionId, streamIndex }`. y0’s Task snapshot also names why the last run stopped. RavenClaw GET is `{ id, job?, pendingAsks, lastSeq, permissionMode, live }`. After reconnect the host cannot distinguish “completed, waiting” from “cancelled” from “model_error” without replaying the whole stream. `jobAutoCommit` and `title` already live on `SessionRecord` and are omitted.

**Contract.**

- Persist on the session (schema v10):
  - `last_end_json` — `RoundEnd` (the object, not only `reason`)
  - `job_error` — `TEXT NULL`
- `SessionRecord` gains `lastEnd?: RoundEnd` and `jobError?: string`.
- Write `lastEnd` when a `submitMessage` turn that entered `queryLoop` returns, and when `UserPromptSubmit` ends as `hook_stopped`. **Do not** write on pending-gate `{ reason: 'completed' }`.
- Set `jobError` to the notice string when enter-worktree / `maybeCommitJob` / `rewindToCheckpoint` / `openDraftPr` fails. Clear on the next successful one of those, or when a job session’s turn ends `completed`.
- `GET /v1/session/:id` body becomes:

```ts
{
  id: string
  title?: string
  job?: SessionJob
  jobAutoCommit: boolean
  lastEnd?: RoundEnd
  jobError?: string
  pendingAsks: Array<{ callId: string; tool: string; message: string; childSessionId?: string }>
  lastSeq: number
  permissionMode: PermissionMode
  live: boolean
  queued: string | null  // null until G1; then followup_text or null
}
```

- 404 unknown, 401 without Bearer, no create-on-GET — unchanged.
- Memory store implements the same fields.

**Files.** `packages/core/src/types.ts`, schema + migration `010`, sqlite/memory stores, `session-engine.ts` (write lastEnd), `session/job.ts` / enter / rewind (write/clear jobError), `packages/cli/src/serve.ts`, `docs/headless.md`.

**Done when.** After a cancelled turn, GET shows `lastEnd.reason === 'cancelled'` and `live: false`. A pending-gate `submitMessage` does not overwrite a previous `cancelled`. A failed `/pr` sets `jobError`; a later successful `/pr` clears it.

---

## Wave G1 — One-slot follow-up

Goal: while a turn is live, the host can park exactly one next prompt that runs after a clean complete, is visible on snapshot, and does not invent a second loop.

### G1.1 Persist the slot

**Why.** y0: exactly one queued follow-up; a later queue overwrites. RavenClaw `/queue` is a different object (mid-turn inject, N items). Serve `singleFlight` drops visibility — the next POST is accepted 202 but snapshot cannot show it.

**Contract.**

- `sessions.followup_text TEXT NULL` (same v10 migration as G0.2).
- Session API (engine or small helper next to `session/job.ts`):

```ts
setFollowup(text: string): void        // overwrite; empty string is an error, not a clear
clearFollowup(): void
getFollowup(): string | null
```

- Persist on set/clear (`upsertSession`). Memory store too.
- `POST /v1/session/:id/followup` body `{ text: string }` sets the slot. 400 if `text` missing/empty. Does **not** call `submitMessage`.
- `DELETE /v1/session/:id/followup` clears. 200 `{ ok: true, queued: null }` even if already empty.
- TUI `/follow [text]` sets; `/follow clear` clears; `/follow` with no arg prints the slot or `no follow-up`. Do not touch `/queue`.

**Files.** schema `010`, stores, `session-engine.ts` or `session/followup.ts`, `cli/src/serve.ts`, slash catalog + dispatch.

**Done when.** Two POSTs leave only the second text. DELETE then GET snapshot `queued: null`. `/queue` tests unchanged.

### G1.2 Host epilogue runs or clears

**Why.** y0 runs the slot after a clean complete and clears it on error. Auto-commit already taught the epilogue shape: after `submitMessage` returns, inside the same `singleFlight`.

**Contract.**

- After `submitMessage` returns (TUI and serve, same helper):
  - If `lastEnd.reason` is `completed` \| `hook_stopped` \| `max_rounds` \| `context_full` **and** `listPendingAsks` is empty **and** `followup_text` is set: persist-clear the slot, then `submitMessage` that text (`turnPolicy: 'queue'` on serve). If persist-clear fails, leave the slot and do not submit.
  - If `lastEnd.reason` is `cancelled` \| `aborted` \| `model_error` \| `persist_failed` \| `results_persist_failed`: clear the slot, do not submit.
- Do not run the slot from `createSession`, `session/load`, or GET.
- Do not run the slot if `liveTurn !== null` (should be false after return).
- Nested: the epilogue’s `submitMessage` may itself end with a new slot (operator POSTed during the follow-up turn). Run at most **one** chained follow-up per original host submit (no unbounded drain). A third text set during the follow-up turn waits for the next host-driven turn.
- Slack/Discord stay `singleFlight`. They may set the slot via future host code; they are not required to grow `/follow` in this horizon.

**Files.** small `session/followup.ts` epilogue, `cli/src/serve.ts` (`consumeSubmit` path), TUI stream-turn / app after submit returns.

**Done when.** Set slot mid-turn; turn completes; one new user row is the follow-up text and snapshot `queued` is null. Cancel mid-turn clears the slot and does not submit it. Parked leftover-ask at complete leaves the slot (does not run, does not clear).

### G1.3 Snapshot `queued`

**Contract.** GET `queued` is `followup_text ?? null`. Always present (never omitted).

**Done when.** GET after POST followup shows the text; after epilogue run or DELETE shows `null`.

---

## Wave G2 — Last-user edit-resubmit

Goal: a job host can replace the last user prompt, restore the checkpoint that turn started from, and `submitMessage` the new text. Not time-travel to an arbitrary row.

### G2.1 `rewindLast` returns the dropped user text

**Why.** y0 edit-message: stop, restore nearest prior assistant checkpoint, delete messages after the edited user, resubmit. RavenClaw `/rewind` already restores (job checkpoint / no-job file-history) and drops the last user turn, but the host cannot see what it dropped and serve cannot compose “rewind then send.”

**Contract.**

- `rewindLast(): Promise<{ ok: boolean; notice: string; droppedText?: string }>`
- `droppedText` is the last user message’s text (concatenated text blocks; ignore images). Absent when `ok` is false or there was no user row.
- Existing refuse rules stay: `liveTurn !== null` or a running Agent child → `{ ok: false, notice: 'a turn is in progress' }` and no drop.
- New refuse: any owned unpaired `pending_asks` → `{ ok: false, notice: 'pending permission ask' }` and no drop.
- Job / no-job rewind implementations stay as shipped (`rewindToCheckpoint` vs `rewindLastTurn`). This slice does not fix persist-before-reset.
- TUI `/rewind` still prints `notice` only.

**Files.** `packages/core/src/types.ts`, `session-engine.ts`, `session/rewind.ts` (only if dropped text is easiest there), rewind tests.

**Done when.** Two-turn session, `rewindLast()` ok, `droppedText` equals the second user prompt, transcript no longer contains that turn.

### G2.2 Serve `POST …/edit`

**Why.** A reconnecting host should not invent rewind + submit locally with a race against `live`.

**Contract.**

- `POST /v1/session/:id/edit` body `{ text: string }`. Bearer. 400 if `text` missing/empty.
- Order: `rewindLast()`. If not ok → 200 `{ ok: false, notice, droppedText? }` and **do not** submit.
- If ok → `singleFlight` `submitMessage({ text, turnPolicy: 'queue' })` and 202 `{ accepted: true, sessionId, droppedText? }` (same envelope as submit).
- Does not add a host entry on `SessionEngine` other than the wider `rewindLast` return. The route is composition.
- TUI `/retry` with no arg rewinds and puts `droppedText` in the composer (does not submit). `/retry <text>` rewinds and submits. `/rewind` stays notice-only.

**Files.** `cli/src/serve.ts`, serve tests, slash catalog + dispatch `/retry`.

**Done when.** POST edit on a job session resets HEAD to the prior checkpoint, drops the last user/assistant, and the stream shows a new user row with the edited text. POST edit while pending asks returns the pending notice and does not rewind.

---

## Wave G3 — Job diff

Goal: the host can name what the job changed versus `baseCommitSha`, including dirty files, without opening `/pr` or scraping `/diff` of cwd uncommitted only.

### G3.1 `jobDiff` helper

**Why.** y0 diff UX is `base...HEAD` ∪ uncommitted as `CREATE|UPDATE|DELETE|RENAME` + line stats. RavenClaw `/pr` already has `diffStat(fromSha, HEAD)` totals. `/diff` is the operator’s dirty tree.

**Contract.**

```ts
type JobDiffOp = 'create' | 'update' | 'delete' | 'rename'

type JobDiffFile = {
  path: string
  op: JobDiffOp
  plus: number
  minus: number
  from?: string  // rename source
}

type JobDiff = {
  baseCommitSha: string
  shadowBranch: string
  head: string
  dirty: boolean
  files: JobDiffFile[]
}

function jobDiff(job: SessionJob): JobDiff | { ok: false; notice: string }
```

- Committed: `git diff --name-status --find-renames <baseCommitSha> HEAD` plus `--numstat` for plus/minus.
- Dirty: unstaged + staged vs `HEAD`. A dirty path not in the committed list is included (usually `update` or `create`). Dirty plus/minus add to that path’s stats.
- `dirty: true` if the worktree has staged or unstaged changes.
- Git failure → `{ ok: false, notice: string }` (same shape as `/pr`). Do not throw out of serve. `jobDiff` itself returns `JobDiff | { ok: false; notice: string }`.
- No-job callers do not call this.

**Files.** `packages/core/src/session/job.ts` (or `session/job-diff.ts` if `job.ts` is already large), `job.test.ts`.

**Done when.** A worktree with one committed new file and one dirty edit lists both; rename is `op: 'rename'` with `from`.

### G3.2 Serve GET + TUI `/diff` on a job

**Contract.**

- `GET /v1/session/:id/diff` Bearer. No job → 200 `{ ok: false, notice: 'no job record' }`. Job → 200 `{ ok: true, ...JobDiff }`.
- TUI `/diff` when `session.job` is set: render `jobDiff` (path, op, plus/minus). When no job: keep today’s cwd uncommitted panel.
- Never starts a turn. Never a tool.

**Files.** `cli/src/serve.ts`, `cli/src/diff-cmd.ts` / `diff-panel.tsx`, slash help if the summary must say “job range when `/job`”.

**Done when.** `curl` GET on a job session returns `baseCommitSha` and the dirty file. `/diff` on a no-job session still shows only uncommitted.

---

## Wave G4 — Eval lock

**Contract.** Path-identity fixtures (directory name is identity, no authored `id`, no LLM-as-judge):

| Fixture | Gate |
|---|---|
| `snapshot-end-reason` | After a cancelled in-process turn, session `lastEnd.reason === 'cancelled'`; a later pending-gate submit does not overwrite it |
| `followup-slot` | Set slot, complete turn, next user row is the slot text; cancel clears without submitting |
| `edit-resubmit` | Two turns, edit last user, HEAD (job) or file-history (no-job) matches pre-last-turn; new user text is the edit |
| `job-diff` | Job with committed + dirty file; `jobDiff` lists both ops |

Prefer in-process `createSessionEngine`. HTTP-driven GET/POST may live in `serve.test.ts` (already the serve contract home). Do not invent a second loop.

**Files.** `packages/core/src/eval/`.

**Done when.** `bun test packages/core/src/eval/run.test.ts` fails if G0.2, G1.2, G2, or G3.1 regress.

---

## Out of this horizon

Web chat UI, Next.js BFF, Prisma Task, Socket.IO, y0 Shadow wiki / indexer, eve compiler, OpenAPI connections, memory slots, `defineState`, credential brokering, self-mod, any new chat network, sandbox network policy, Grep/Glob docker-exec, NotebookEdit docker port, Slack HMAC, `ignored`, live cancel abort-pair, rewind persist-before-reset, `todo.json` re-project, keep-id `/clear`, stream `version` / `continuationToken`, replacing `/queue`, `SuggestFollowups` as the slot, arbitrary mid-history edit.

If a later product wants a browser, it implements G0–G3 on the existing F3 stream. It does not add a second loop.

---

## Suggested order

1. **G0.1 + G0.2** — docs + snapshot + schema v10 columns (include `followup_text` nullable now).
2. **G1.1 + G1.3** then **G1.2** — persist/show the slot before the epilogue runs it.
3. **G2.1** then **G2.2** — dropped text before serve compose.
4. **G3.1** then **G3.2** — helper before HTTP/TUI.
5. **G4.1** last locks the wave.

G3 may run in parallel with G2 (disjoint files: `job.ts` / `diff-cmd.ts` vs `rewind.ts` / serve edit route). G1.2 and G2.2 both touch `serve.ts` — do not parallel those two.

---

## Success checks

A slice that does not move one of these is out of scope.

1. GET snapshot names `lastEnd`, `jobAutoCommit`, `title`, `jobError`, `queued` (G0.2 / G1.3).
2. Pending-gate `submitMessage` does not overwrite `lastEnd` (G0.2).
3. Exactly one follow-up; overwrite; DELETE clears; `/queue` unchanged (G1.1).
4. Clean complete runs the slot once via `submitMessage`; cancel/error clears; parked ask leaves it (G1.2).
5. `rewindLast` returns `droppedText`; pending ask refuses (G2.1).
6. `POST …/edit` rewinds then submits; empty text is 400 (G2.2).
7. Job diff is `base...HEAD` ∪ dirty with create/update/delete/rename (G3).
8. Eval fixtures fail the runner if 2, 4, 6, or 7 regress (G4).

---

## Key decisions

1. **Theme is job-host state, not a web UI and not leftover-ask.** Session-as-job already owns a branch. This horizon makes the host able to continue that job after reconnect.
2. **`lastEnd` is a session field, not a stream scan.** Scanning `stream_events` would lie after rewind and would record pending-gate `completed` if a host published it. Write only real turn ends.
3. **One slot ≠ `/queue`.** Mid-turn drain stays. The slot is the *next* turn after this one returns.
4. **Auto-run is in-process only.** After restart the host submits `snapshot.queued`. Serve load must not surprise-start a turn.
5. **Edit is last-user only, composed from rewind + `submitMessage`.** No third host entry. No arbitrary sequence edit.
6. **Job diff is a read-only host view.** `/pr` stays the delivery epilogue. `/diff` without a job stays cwd uncommitted.
7. **Schema v10 is one bump** for `last_end_json` + `job_error` + `followup_text`.
8. **Parked leftover-ask still wins.** Follow-up does not run. Edit does not rewind. Pending-gate law unchanged.
