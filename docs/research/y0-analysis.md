# y0 — Prior-Art Analysis for RavenClaw

y0 (also branded Shadow in-tree) is a **hosted, GitHub-centric background coding job runner**. A **Task** is the product waist: clone a repo, cut a shadow branch, stream one agent, auto-commit, optionally open a draft PR, and keep a repo-scoped wiki. It is a **product shell**, not a loop.

This note extracts steal-worthy **product contracts**. Steal semantics. Do not copy y0 source, prompts, Prisma, Socket.IO rooms, or the Next.js BFF.

Repo analyzed: `/Users/yeonwoosung/Desktop/y0` (read-only). Style the name `y0`, lowercase.

RavenClaw is the opposite shape: one `queryLoop`, persist-before-execute, leftover-ask, local BYOK coding agent. y0 is useful as the **session-as-job / shadow-branch / turn-end delivery** reference — not as a replacement waist and not as a web product to merge in.

Related runtime (filesystem-first durable agents): `~/Desktop/eve`. eve is the framework a y0-shaped app would sit on. Do not merge the two into RavenClaw.

---

## 1. What y0 is (and is not)

| y0 is | y0 is not |
|---|---|
| A hosted Task against `owner/repo` + `baseBranch` | A local interactive coding TUI |
| Isolated workspace (host dir or Kata VM + sidecar) | Persist-before-execute / leftover-ask |
| Shadow branch + optional draft PR as delivery | One `queryLoop` that hosts must call |
| Socket.IO + Prisma + Next.js BFF | A sandbox permission system |

**Package layout**

- `apps/frontend` — Next.js chat, file explorer, terminal, task sidebar
- `apps/server` — orchestrator, LLM, tools, Socket.IO, git, PR
- `apps/sidecar` — remote file/git/exec inside the isolated workspace
- `packages/db` — Prisma (`Task`, `Todo`, `ChatMessage`, `CodebaseUnderstanding`, …)
- `packages/command-security` — command allow/deny (isolation-trust, not leftover-ask)

**Invariant we keep:** RavenClaw hosts only `submitMessage` (plus `applyAskAnswer`). A Task table or a Socket.IO room is a second loop. Refuse it.

---

## 2. Task-as-job contract

A Task is:

```text
{ title, repoFullName, repoUrl, baseBranch, shadowBranch, baseCommitSha,
  status, initStatus, workspacePath, pullRequestNumber?, githubIssueId? }
```

First prompt creates the Task, seeds message sequence 1, and names `{ title, shadowBranch }` (`shadow/<slug>-<6>` or `shadow/task-<id>`).

**Two status axes (do not collapse them).**

| Axis | Values | Meaning |
|---|---|---|
| `TaskStatus` | `INITIALIZING` → `RUNNING` → `COMPLETED` \| `STOPPED` \| `FAILED` \| `ARCHIVED` | Job liveness |
| `InitStatus` | `INACTIVE` → prepare / VM / deps / wiki → `ACTIVE` | Workspace readiness |

`ACTIVE` means the workspace can run. `INACTIVE` means it was torn down; a follow-up **re-inits**. `ARCHIVED` is terminal (manual archive, or the linked PR closed/merged).

**Who owns git.** The **job** owns git, not the operator’s dirty working tree. Prepare clones (or, locally, should be a worktree), checks out `baseBranch`, records `baseCommitSha`, creates `shadowBranch`. After a **successful** (not stopped/errored) stream: if dirty → commit → best-effort push. Commit/push failure is **non-blocking**. Diff UX is `base...HEAD` ∪ uncommitted, as `CREATE|UPDATE|DELETE|RENAME` + line stats.

**PR.** Optional **delivery artifact**, not the waist. Default in y0 is on. Preconditions: clean tree, completing assistant `messageId`, shadow branch exists. First time: draft `shadowBranch → baseBranch` and hang a `PullRequestSnapshot` on that assistant message. Later turns update the same PR. Dirty → skip. Failure never fails the turn.

**Wiki.** Repo-scoped `CodebaseUnderstanding`. First-turn system block. Missing is silent. Generation is a blocking init step when enabled.

**Cancel / queue / follow-up.** One live stream per Task. `stop` aborts and marks `STOPPED`. While streaming, **exactly one** queued follow-up (message or stacked-PR); a later queue overwrites. After a clean complete the slot runs; after error it is cleared. Follow-up on `COMPLETED`/`STOPPED` cancels teardown and sets `RUNNING`. Archived: no more turns.

**Edit-message (time-travel).** Only user messages. Stop the stream, restore the nearest prior assistant checkpoint (`{ commitSha, todoSnapshot }`, else `baseCommitSha`), delete messages with sequence > edited, resubmit that prompt.

**Stacked PR.** A **new Task**, not a second loop on the parent. Child `baseBranch = parent.shadowBranch`. Parent transcript gets a pointer row excluded from the parent’s model history.

**Command policy (contrast, not steal).** Validate then **trust isolation**. `APPROVAL_REQUIRED` exists in types but is not the product. No leftover-ask. RavenClaw must not adopt this.

---

## 3. Map onto RavenClaw

| y0 | RavenClaw today |
|---|---|
| Task row | Session. No Prisma Task. |
| Isolated clone + Kata | `--worktree` / `EnterWorktree` / `Agent isolation: worktree` — **detached HEAD**, no named shadow branch |
| `shadowBranch` + `baseCommitSha` | Missing as session metadata |
| Turn-end auto-commit | Missing. `file-history` is per-edit undo, not a git commit |
| Checkpoint `{ sha, todos }` | `rewindLastTurn` undoes last file-history snapshot + drops last user turn. No git SHA, no todo snapshot |
| One queued follow-up | TUI composer queues while busy; Slack/Discord/serve `singleFlight`. Not a visible one-slot chip |
| Draft PR + snapshot | Missing. No `gh pr` epilogue |
| Shadow wiki | Out. Team-onboarding scan already exists as a slash |
| Socket.IO stream | `raven serve` NDJSON live tail (no reconnect cursor) |
| Isolation-trust allowlist | Forbidden. leftover-ask / `dontAsk` leftover-deny stay law |

---

## 4. Steal / skip

### Steal (contracts only)

1. **Shadow branch as job identity** — a job names `base` + `shadow`; writes happen on `shadow`; `baseCommitSha` is the rewind origin. Locally this is a **named branch on the existing worktree**, not a second clone.
2. **Turn-end commit is a host epilogue** — only after a successful turn; skip if clean; commit failure does not fail the turn; abort/error must not auto-commit. Author is the operator, not a bot.
3. **Message-level git checkpoint + edit-rewind** — successful committed turn snapshots `{ sha, todos }`; rewind restores the nearest earlier checkpoint (else `base`) then resubmits.
4. **One visible queued follow-up slot** — overwrite, clear, run after complete, drop on error. This is today’s queue made honest, not a new loop.
5. **PR as optional delivery hung on the completing turn** — draft `shadow → base`; dirty skip; never fail the turn; default **off** on a local machine.
6. **Stacked child base = parent shadow** — child `Agent` + worktree whose base is the parent’s shadow branch. Parent row is a pointer.
7. **Visible init** — `prepare worktree → ready`. Failed step is named. Skip VM/sidecar/wiki-as-product.
8. **Diff contract** — `base...HEAD` ∪ dirty, file ops + line stats, as a read-only event.

### Skip (kitchen-sink or conflicts with law)

- Next.js BFF, Prisma `Task` / `TaskSession`, Socket.IO second control plane
- Kata / K8s / sidecar as “local remote”
- Isolated **clone** of the operator’s own repo for every job
- Auto-commit as bot + co-author on the operator’s machine
- Default-on auto-PR to GitHub
- Shadow wiki / Pinecone indexer as a required horizon
- Isolation-trust command allowlist (replaces leftover-ask)
- Webhook “PR closed → archive” as a required lifecycle
- Terminal multiplexer / FS-event explorer as core UX

### Park

- Repo architecture wiki as an opt-in first-turn cache (team-onboarding already covers the walkthrough)
- GitHub App / issue-to-job
- Stacked-PR product UI (the branch rule can land without the UI)

---

## 5. How this attaches to the waist

Keep the waist exactly as it is: **hosts collect input → `SessionEngine.submitMessage` → one `queryLoop`**. y0 contracts attach as **session/job artifacts and host epilogues**.

| y0 idea | RavenClaw attachment |
|---|---|
| Task | Session + optional `job: { base, shadow, baseSha, pr? }` |
| First prompt | `submitMessage`. Title/shadow naming is host setup **before** the turn |
| `queue=true` | Existing drain / `turnPolicy: queue` |
| `stop` | Existing `abort` / `/steer`. Status `STOPPED` is UI |
| leftover-ask | **Unchanged.** y0 isolation-trust must not land |
| Turn-end commit / checkpoint | After `submitMessage` completes successfully |
| Edit-rewind | Session op, then `submitMessage` again |
| PR | Host/`gh` after the epilogue; snapshot is a message annotation |
| `raven serve` | Emit `job.*` events. Do not grow a BFF |

Hard rule: if a feature needs its own chat loop, Task row, or Socket.IO room, it is y0 product — leave it.

---

## 6. Implications for the next horizon

The previous horizon (`2026-09-15-eve-inspired-roadmap.md`) stole eve’s durable HITL, docker file jail, and session HTTP. It explicitly parked y0 Task/PR/wiki.

That parking is now the product question: **can a RavenClaw session own a git job and give the operator a branch (and optionally a PR) without a second loop?**

eve’s remaining steal that a job host actually needs: reconnectable NDJSON (`seq` / `?after=`), cancel ≠ fail, compact re-injects todos. Those are waist pieces, not a web UI.

Session-as-job roadmap (implemented): `docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md`. Job-host state (implemented at `6e56764`): `docs/superpowers/specs/2026-09-17-job-host-state-roadmap.md`. Rewind persist-before-reset (implemented at `048deff`): `docs/superpowers/specs/2026-09-18-rewind-persist-and-todo-projection.md`. Cancel abort-pair / reset-on-resume / follow-up persist (implemented at `5eefdde`): `docs/superpowers/specs/2026-09-18-cancel-reset-followup.md`. No-job todo revert (implemented at `be5a4a7`): `docs/superpowers/specs/2026-09-18-no-job-todo-revert.md`. Stream version / `continuationToken` (implemented at `c9c4871`): `docs/superpowers/specs/2026-09-18-stream-version-token.md`. Keep-id `/clear` (implemented at `edeb611`): `docs/superpowers/specs/2026-09-18-keep-id-clear.md`. Parent tree-stop (implemented at `9901d0e`): `docs/superpowers/specs/2026-09-18-parent-tree-stop.md`.
