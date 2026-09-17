# Session-as-job closeout (docs + spec holes + ACP H1)

Date: 2026-09-17  
Branch: `feat/session-as-job-closeout` (worktree `.worktrees/session-as-job-closeout`)  
Base: `ea56edd` (`main` after session-as-job merge)  
Spec: `docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md`  
Status: in progress

Close the last session-as-job honesty holes and make docs match what shipped. Not a new horizon. No web UI, no leftover-ask re-model, no docker file port.

## Binding rulings

1. One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` is the only other host entry and does not start a model turn.
2. `dontAsk` ≠ bypass. No `ignored`. Live `/cancel` abort-pair of a parked leftover-ask stays OUT.
3. ACP timeout stays `AskWaiterExpired` (not `AbortError`, not persist-deny). `executeOneCall` must not `pairMissing` on it.
4. `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row. ACP must **not** change that engine law — the host must `replayPendingAsks` instead of calling `submitMessage` while asks are open.
5. `/pr` is never a tool and never starts a turn. Annotation is a structured `draft_pr` content block on the last assistant (persists via existing `blocks_json`). No schema bump.
6. Child `raven/<slug>` created by `prepareChildWorktree` is deleted with `git branch -D` when the worktree is pruned. Dirty keep-path reports the leftover branch; do not force-delete a dirty tree.
7. `TodoWrite` persist/fs failure must not call `applyWrittenTodos`. Store remains source of truth.
8. Targeted `bun test <files>` only. TDD for Tasks 2–5 (failing test first). Task 1 is docs-only.
9. Isolated worktree only. Do not implement on `main`. Do not push. Do not copy eve/y0 source.
10. File partitions are disjoint. Do not edit another task's files.

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 docs | `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`, `CHANGELOG.md`, `README.md`, `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md`, `docs/headless.md`, `docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md`, `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md`, `docs/superpowers/plans/2026-09-16-session-as-job-implementation.md` (status note only) |
| 2 ACP H1 | `packages/acp/src/server.ts`, `packages/acp/src/server.test.ts` |
| 3 todos | `packages/core/src/loop/phases.ts`, `packages/core/src/tools/todo.ts`, `packages/core/src/loop/phases.unit.test.ts`, `packages/core/src/tools/todo.test.ts` |
| 4 /pr annotation | `packages/core/src/session/job.ts`, `packages/core/src/session/job.test.ts`, `packages/core/src/types.ts` (`ContentBlock` only) |
| 5 child branch GC | `packages/core/src/tools/worktree.ts`, `packages/core/src/tools/worktree.test.ts`, `packages/core/src/tools/agent.ts` (only if cleanup report is surfaced), `packages/core/src/tools/agent.test.ts` (only if agent.ts changes) |

## Task 1 — Docs match shipped waist

Make the tree tell the truth about session-as-job on `ea56edd` plus this closeout.

- `2026-09-16-session-as-job-roadmap.md`: `Status: implemented`. Board F0.1–F4.3 → shipped (note F4.1 annotation and F4.3 branch GC as this closeout). Do not leave the pre-ship “missing” board as current.
- `CHANGELOG.md` Unreleased: schema **9**; session routes include GET snapshot, `?after=`, `/pr`; session-as-job is **shipped**, not a plan.
- `ARCHITECTURE.md` / `.ko.md`: serve list includes `GET /v1/session/:id`, `?after=`, `POST …/pr`, cancel `turnId` / `no_active_turn` / parked asks stay. Rewind: job sessions use `rewindToCheckpoint` (`git reset --hard` in the worktree + todo snapshot); no-job stays file-history + drop last user turn.
- `SLASH_COMMANDS.md` / `.ko.md`: document `/job` and `/pr` (catalog already has them in `packages/cli/src/commands.ts`).
- `docs/headless.md`: cancel is `abort('cancel')` with optional `turnId`; stale → `no_active_turn`; parked leftover-ask stays.
- `2026-09-12-ravenclaw-remaining-roadmap.md`: session-as-job is implemented, not “next”.
- `2026-09-16-session-as-job-implementation.md`: add a one-line archive note that tasks landed on `main` at `ea56edd`. Do not rewrite the 15 tasks.
- `README.md`: if it still presents session-as-job as unbuilt, point at the implemented spec.

No production code. No tests.

## Task 2 — ACP timeout replay (H1)

**Bug.** After `AskWaiterExpired`, `pending_asks` stays (correct) but the engine stays in `sessions`. `session/load` returns early when `sessions.has(id)` and skips `replayPendingAsks`. Next `session/prompt` hits `submitMessage`'s pending gate and returns `{ reason: 'completed' }` with no `request_permission`. The row is unanswerable until process restart.

**Do not change** `submitMessage` pending-gate law.

**Fix (ACP host only):**

1. Extract a helper that drains `engine.replayPendingAsks()` (askUser is already wired to `requestPermission` / `applyAskAnswer` inside the engine).
2. `session/load` when the session is already in the map: still drain replay. Do not skip.
3. `session/prompt`: drain replay **before** `submitMessage`. If replay throws `AskWaiterExpired`, return `cancelled` and do **not** `submitMessage`. If replay settles, then `submitMessage` the new prompt.
4. After a timeout inside `session/prompt`'s live ask, still `abandonSubmit` + return `cancelled` (do not immediately re-ask in the same RPC — that would loop timeouts). The *next* load/prompt is what replays.

**TDD** (`packages/acp/src/server.test.ts`):

- Existing timeout tests stay green (no deny, pending remains, `liveTurnId` null).
- RED: after timeout with a real `createSessionEngine` leftover-ask, a subsequent `session/load` (same live map entry) invokes `replayPendingAsks` / sends `session/request_permission` again.
- RED: after timeout, a subsequent `session/prompt` with an editor allow settles the pending row via replay (not via `submitMessage` pairing) and then may run the new prompt.
- RED: `session/load` when `sessions.has(id)` still drains replay (fake engine counter ≥ 1).

Targeted: `bun test packages/acp/src/server.test.ts`

## Task 3 — TodoWrite error-string must not apply todos

**Bug.** `TodoWrite.execute` returns `'TodoWrite failed: …'` on missing store / upsert / file write. `executeOneCall` still calls `applyWrittenTodos(state, input)` and formats `ok: true`. RAM `session.todos` diverges from the store.

**Fix.** If execute returns a `TodoWrite failed:` string (or throws), do **not** call `applyWrittenTodos`. The tool result must be a failed/error row (`ok: false` or existing error format). Prefer matching other tools' error-string handling in `executeOneCall` — do not invent a second permission mode.

**TDD:**

- RED: `TodoWrite` with no store (or a store that rejects `updateSessionTodos`) → `session.todos` / `state.todos` unchanged; output is a failure.
- GREEN: successful `TodoWrite` still writes store + `applyWrittenTodos` + cwd projection.

Targeted: `bun test packages/core/src/tools/todo.test.ts packages/core/src/loop/phases.unit.test.ts`

Do not add session-id schema changes. Do not rewrite rewind `todo.json` projection (out of scope).

## Task 4 — `/pr` annotation is a snapshot block

**Bug.** `annotateDraftPr` pushes `Draft PR: <url|title>` text. Spec F4.1: store `{ title, body, url?, sha, files, +, - }` as an annotation on the last assistant.

**Fix.**

- Add `ContentBlock` variant `{ type: 'draft_pr'; title: string; body: string; url?: string; sha: string; files: number; plus: number; minus: number }` in `packages/core/src/types.ts` only.
- `annotateDraftPr` upserts that block (replace existing `draft_pr` on the same message). Persist via existing `blocks_json` — no migration.
- Keep a short human text line `Draft PR: <url|title>` **in addition** so TUI/search still show a URL.
- `openDraftPr` still never starts a turn; dirty / no-job / missing `gh` still notice-only.

**TDD** (`job.test.ts`):

- RED: `annotateDraftPr` / `openDraftPr` with a stub `gh` puts a `draft_pr` block whose fields match the snapshot (title, body, url, sha, files, plus, minus).
- RED: second annotate on the same message updates the same block (one `draft_pr`, not two).
- Existing dirty / no-job / edit-without-clobber tests stay green.

Targeted: `bun test packages/core/src/session/job.test.ts`

## Task 5 — Child `raven/*` branch GC

**Bug.** `prepareChildWorktree` with `parentJob` runs `git worktree add -b raven/<childSlug>` but `cleanup` only `worktree remove`. Clean prune leaves the branch. Dirty keep-path leaves directory + branch.

**Fix.**

- When cleanup prunes the worktree and a named shadow was created, `git branch -D <shadow>` (best-effort; ignore failure).
- When cleanup keeps a dirty path, include `leftoverBranch?: string` on `WorktreeCleanupReport` so the Agent result can mention it. Do not `branch -D` while the worktree still uses the branch.
- Parent-less `--detach` children have no shadow — no branch delete.
- Do not change stacked `base = parent.shadow` spawn.

**TDD** (`worktree.test.ts`):

- RED: stacked child, clean tree, `cleanup()` → `pruned: true` and `git show-ref` / `branch --list` does not list `raven/<child>`.
- RED: stacked child, dirty tree, `cleanup()` → `pruned: false`, worktree path remains, `leftoverBranch` is the shadow name, branch still exists.
- Existing detach / no-parent tests stay green.

Targeted: `bun test packages/core/src/tools/worktree.test.ts` (+ `agent.test.ts` only if `agent.ts` changes).

## Out of scope

- Rewind persist-before-reset / `todo.json` re-project
- One-slot follow-up, edit-resubmit, job diff, stream version, keep-id clear
- WorkspaceFs docker-exec
- Web UI / Prisma / Socket.IO / Next
- Official `/code-review`, merge, push
