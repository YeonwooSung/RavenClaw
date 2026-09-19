# RavenClaw next-horizon roadmap (session-as-job)

Date: 2026-09-16  
Status: implemented  
Shipped on `main` at `ea56edd` (merge of `feat/session-as-job`).  
Closeout shipped on `main` at `0ef1554` (merge of `feat/session-as-job-closeout`): F4.1 `draft_pr` annotation, F4.3 stacked-child `raven/*` branch GC, ACP timeout replay (H1), `TodoWrite failed:` does not apply todos.  
Reviewed against tree at `d4c73d4` before implementation (eve-inspired horizon + leftover-ask holes PRs #2–#8 on `main`).  
Successor to `2026-09-15-eve-inspired-roadmap.md` (Status: implemented). Does not reopen that spec’s closed doors.  
Next horizon (implemented at `6e56764`): [`2026-09-17-job-host-state-roadmap.md`](2026-09-17-job-host-state-roadmap.md). After that (implemented at `048deff`): [`2026-09-18-rewind-persist-and-todo-projection.md`](2026-09-18-rewind-persist-and-todo-projection.md). Then (implemented at `5eefdde`): [`2026-09-18-cancel-reset-followup.md`](2026-09-18-cancel-reset-followup.md). Then (implemented at `be5a4a7`): [`2026-09-18-no-job-todo-revert.md`](2026-09-18-no-job-todo-revert.md). Then (implemented at `c9c4871`): [`2026-09-18-stream-version-token.md`](2026-09-18-stream-version-token.md). Then (implemented at `edeb611`): [`2026-09-18-keep-id-clear.md`](2026-09-18-keep-id-clear.md). Then (implemented at `9901d0e`): [`2026-09-18-parent-tree-stop.md`](2026-09-18-parent-tree-stop.md).  
Amended by `2026-09-18-cancel-reset-followup.md`: live cancel abort-pairs this session’s leftover-ask.

Sources: current tree, [eve analysis](../../research/eve-analysis.md) (`/Users/yeonwoosung/Desktop/eve`, Apache-2.0, read-only), [y0 analysis](../../research/y0-analysis.md) (`/Users/yeonwoosung/Desktop/y0`, read-only).

Implementation plan: [2026-09-16-session-as-job-implementation.md](../plans/2026-09-16-session-as-job-implementation.md) (15 TDD tasks, Waves F0–F4). Binding plan rulings live at the top of that file (schema v7–v9, `AskWaiterExpired`, named `raven/<slug>` branch, `abort('cancel'|'interrupt')`, serve `{ seq } & StreamEvent`).

Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not become a hosted Task runner.

---

## Where we are

The eve-inspired waves and this session-as-job horizon are on `main` (`ea56edd`, closeout `0ef1554`). The waist is:

- One `queryLoop`. Hosts call `submitMessage`. The only other host entry is `applyAskAnswer`. Persist-before-execute. Pairing. No `bypass`.
- `dontAsk` ≠ leftover-allow-all.
- Frozen default prefix. Skills + MCP + `isEnabled` for growth.
- Slack, Discord + pairing, ACP, `raven serve`, cron, children via `SessionEngine`.
- Session-as-job: named `raven/*` shadow, opt-in turn-end commit, checkpoint rewind, optional `/pr`; serve `seq` / `?after=` / GET snapshot / cancel `turnId`.

This horizon is **not** “missing a loop” and **not** “add y0’s Next.js + Prisma Task.” It made a session able to **own a git job** and the serve waist **reconnectable and cancel-honest** so a job host does not invent a second stream.

eve’s leftover lesson: ID-addressed NDJSON with a cursor; cancel ≠ fail; compact re-injects todos and forgets summarized Reads.  
y0’s lesson: Task-as-job UX — the job owns a branch; delivery is an epilogue; rewind is a checkpoint, not file-undo only.  
eve’s trap: Workflow-as-loop, channel zoo, `agent/` compiler.  
y0’s trap: Socket.IO + Prisma Task as the waist, isolation-trust instead of leftover-ask, default-on auto-PR.

### Already in tree (do not rebuild)

| Piece | Where |
|---|---|
| Durable leftover-ask (`pending_asks`, `applyAskAnswer`, one row per `call_id`) | schema v5, `session-engine.ts` |
| `turnPolicy` field; Slack/Discord/serve `queue`; TUI `/steer` | `UserSubmitInput`, hosts |
| Write unread/stale (exists only); `WorkspaceFs` cwd jail | `write.ts`, `workspace-fs.ts` |
| Crash-resume Read mtimes | schema v6 `messages.read_mtime_ms` |
| Compact: all-tool budget, queued `/compact`, `COMPACTION_PROMPT_TOKENS=1024` | `compact/` |
| MEMORY stays out of the summary | `maybe-compact.test.ts` |
| Child leftover-ask + `childSessionId` | `permission_ask`, hosts |
| Serve: `GET /v1/session/:id`, stream `?after=`, `/submit|/cancel|/compact|/resolve|/pr`; `/v1/turn` stays dontAsk | `cli/src/serve.ts`, `docs/headless.md` |
| `raven eval` path-identity (session-as-job fixtures + prior gates) | `packages/core/src/eval/` |
| Session job worktree (`raven/*` shadow) + child stack on parent shadow | `session-worktree.ts`, `worktree.ts`, `session/job.ts` |
| Job rewind = `rewindToCheckpoint`; no-job = file-history + drop last user turn | `session/rewind.ts` |
| `TodoWrite` → session `todos_json` (+ cwd `todo.json` projection) | `tools/todo.ts` |
| `formatSettledOutput` shared helper | `loop/format-output.ts` |

### Per-slice board

Board as of `ea56edd` on `main`. Pre-ship “missing” rows are historical; do not treat them as current.

| ID | Status vs tree |
|---|---|
| F0.1 docs match shipped waist | **shipped** (closeout Task 1; honesty pass after `0ef1554`) |
| F0.2 ACP timeout must not persist deny | **shipped** (`AskWaiterExpired`; row stays; closeout `0ef1554` drains `replayPendingAsks` on `session/load` and `session/prompt`) |
| F0.3 eval gates for sandbox-cwd + compact-MEMORY | **shipped** |
| F1.1 compact resets this-turn `readFiles` | **shipped** (`forgetReadsNotInTail`) |
| F1.2 todos restore-note after compact | **shipped** |
| F1.3 todos keyed by `sessionId` | **shipped** (schema v7 `sessions.todos_json`) |
| F2.1 session `job` record | **shipped** (schema v8 `sessions.job_json`) |
| F2.2 named shadow branch on the worktree | **shipped** (`raven/<slug>`) |
| F2.3 opt-in turn-end commit epilogue | **shipped** (`jobAutoCommit` / `/job commit on\|off`) |
| F2.4 checkpoint `{ sha, todos }` + rewind to it | **shipped** (`rewindToCheckpoint`; no-job keeps file-history rewind) |
| F3.1 cancel ≠ fail | **shipped** (`cancelled` vs `failed`; `turnId` → `no_active_turn`; parked asks stay) |
| F3.2 reconnectable stream (`seq` + `?after=`) | **shipped** (schema v9 `stream_events`) |
| F3.3 `GET /v1/session/:id` snapshot | **shipped** |
| F4.1 optional `/pr` delivery, default off | **shipped** (route + slash + `draft_pr` block at `0ef1554`) |
| F4.2 eval fixtures that lock F1–F3 | **shipped** |
| F4.3 stacked child `base = parent.shadow` | **shipped** (spawn + prune `git branch -D raven/*` at `0ef1554`) |

---

## Constraints (unchanged)

1. One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer and does not start a model turn.
2. Default prefix stays small and frozen. No new always-on tool unless this doc says so. Job commit / PR are **host epilogues**, not default tools.
3. `dontAsk` never becomes `bypass`. y0 isolation-trust is not a permission mode.
4. BYOK is the product. Ads never touch BYOK.
5. Clean-room. Steal semantics. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**.

---

## Do not build

- y0’s Next.js + Prisma `Task` + Socket.IO room
- Isolated **clone** of the operator’s repo for every job (worktree is the local analog)
- Default-on auto-commit or auto-PR
- Bot-author commits with the operator as co-author
- Shadow wiki / Pinecone indexer as a product
- eve memory slots/providers, `defineState` authoring API, credential brokering
- Channel zoo, self-mod, OpenAPI connections
- Web chat UI
- Grep/Glob docker-exec, NotebookEdit docker port (v1 host jail stays; label it)
- Slack signing-secret HMAC (Socket Mode stays)
- `ignored` dismiss-on-message
- live `/cancel` abort-pair of a parked leftover-ask — amended — see [`2026-09-18-cancel-reset-followup.md`](2026-09-18-cancel-reset-followup.md)
- Sandbox network policy / authored `sandbox.stop()` (per-command `docker run` is not a session VM)

---

## Waves

Do the waves in order. Inside a wave, slices in the same box may run in parallel (disjoint files).

```
Wave F0  docs + leftover-ask honesty          (tree matches what shipped)
Wave F1  compact / todo session truth         (long session still knows the job)
Wave F2  session-as-job                       (named branch, commit, checkpoint)
Wave F3  durable host waist                   (reconnect + cancel ≠ fail)
Wave F4  optional delivery + eval lock        (PR off-by-default; fixtures)
```

Do not start a web UI in this spec. F3 is the prerequisite for a later client, not the client.

---

## Wave F0 — Docs and leftover-ask honesty

Goal: the tree we design F2 on is the tree that actually shipped.

### F0.1 Docs match the shipped waist

**Why.** `ARCHITECTURE.md` still says schema version 4 and serve is `/health` + `/v1/turn` + webhooks. Live schema is 6 (`pending_asks` + `read_mtime_ms`). `SLASH_COMMANDS.md` still says `/compact` splices `liveTurn`. The eve-inspired spec still says “not implemented.” A new horizon on stale docs will be implemented against the wrong waist.

**Contract.**

- Mark `2026-09-15-eve-inspired-roadmap.md` **implemented**.
- `ARCHITECTURE.md` / `.ko.md`: schema v6, `pending_asks`, `applyAskAnswer`, serve session routes, docker file jail, next-horizon pointer → this file.
- `SLASH_COMMANDS.md` / `.ko.md`: `/compact` while live **queues**.
- `CHANGELOG.md`: the eve-inspired horizon and leftover-ask hole PRs are shipped, not “plan only.”
- `README.md` next-horizon link points here.

**Files.** The docs listed above. No production behavior change.

**Done when.** A reader of `ARCHITECTURE.md` can name schema v6 and `POST /v1/session/:id/resolve` without opening `serve.ts`.

### F0.2 ACP timeout does not persist deny

**Why.** Slack/Discord dropped the 120s timer-deny of a durable `pending_asks` row. ACP’s 120s timeout still returns `deny`, which persists a tool deny and deletes the row. Kill-the-waiter must not settle the ask.

**Contract.**

- ACP waiter expiry leaves the `pending_asks` row. The editor can answer later via `applyAskAnswer` / replay.
- Same law as Slack: in-process waiter may stop; the row remains.
- Do not change leftover-ask pairing.

**Files.** `packages/acp/src/server.ts`, ACP tests.

**Done when.** A test expires the ACP waiter and `listPendingAsks` still has the `callId`.

### F0.3 Eval gates named last horizon

**Why.** E4.2 asked for gate fixtures on leftover-ask persist (done), sandbox cwd, and compact-not-touching-system. The runner is a one-name switch: any other fixture throws `unknown eval fixture`.

**Contract.**

- Add path-identity fixtures: `sandbox-cwd`, `compact-memory-prefix`.
- Runner dispatches by directory name (path is identity). No authored `id`. No LLM-as-judge.
- Keep driving `createSessionEngine` in-process. HTTP-driven eval waits for F4.2.

**Files.** `packages/core/src/eval/`.

**Done when.** `bun test packages/core/src/eval/run.test.ts` fails if docker Write escapes cwd or compact copies MEMORY into the summary as the new system prefix.

---

## Wave F1 — Compact and todo session truth

Goal: a 2-hour session after compact still has the current todos, and a later Write cannot lean on a Read the summarizer deleted.

### F1.1 Compact resets this-turn read tracking

**Why.** eve’s compact sandwich step 3: after summarize, the read-before-write cache is wrong because the evidence is gone. RavenClaw `Turn.readFiles` / `readFileMtimes` are this-`submitMessage`. If compact runs mid-session (queued or auto), a later Write in the **same** turn can still see a summarized Read as “already read.”

**Contract.**

- After a compact that drops or stubs Read evidence, clear `turn.readFiles` / `readFileMtimes` for paths whose Read result is no longer in the kept tail.
- Keep **mtime**, this-turn. Do not invent a session-scoped hash map in this slice.
- Pairing stays 1:1.

**Files.** `packages/core/src/compact/`, `tools/read-files.ts`, compact tests.

**Done when.** Compact a transcript that contains a Read of `a.ts`; a later Write of `a.ts` in that turn errors “must Read first.”

### F1.2 Todos restore-note after compact

**Why.** `collectRestoredNotes` already restores capped Read / Skill / `plan.md`. Todos live in `.ravenclaw/todo.json` and vanish from the prompt when the `TodoWrite` row is stubbed. The TUI reloads the file; the **model** does not.

**Contract.**

- After compact, inject one user-role restore-note listing the current session’s todos (text + status). Same shape as the plan.md note.
- Missing / empty list → no note.
- Do not add a tool. Do not put todos in the system prefix.

**Files.** `packages/core/src/compact/prune.ts`, `prune.test.ts`.

**Done when.** A session with three todos compact-summarized away still has those three texts in the next provider request.

### F1.3 Todos keyed by `sessionId`

**Why.** eve `todo` is session-scoped durable state. y0 todos hang on the Task. RavenClaw `TodoWrite` writes project `.ravenclaw/todo.json`. Parallel sessions in the same cwd (parent + foreground child, or two `raven`s) clobber each other. F2 checkpoints need a per-session snapshot.

**Contract.**

- Persist the todo list on the session (store column or sidecar keyed by `sessionId`). Children do **not** inherit the parent list.
- `TodoWrite` reads/writes **this session**. TUI panel reads this session.
- Project `.ravenclaw/todo.json` becomes a **projection of the current interactive session** for humans/git, not the source of truth. Do not delete the file format.
- Compact F1.2 reads the session list, not “whatever is in cwd.”
- No `defineState` authoring API. No new always-on tool.

**Files.** `packages/core/src/tools/todo.ts`, session store (schema bump if a column is added), TUI `todo-panel`.

**Done when.** Two sessions in one cwd keep independent lists; compact restore uses the engine’s session list.

---

## Wave F2 — Session-as-job

Goal: `--worktree` / `EnterWorktree` / an explicit `/job` makes the session own a **named shadow branch**. Delivery is an epilogue. Rewind is a git checkpoint.

### F2.1 Session `job` record

**Why.** y0’s Task identity is `base + shadow + baseSha`. RavenClaw worktrees are detached HEAD with a path sidecar. There is nothing to rewind to except file-history blobs, and nothing for a later PR to target.

**Contract.**

- When a session enters a worktree (flag, tool, or `/job`), persist on the session: `{ baseBranch, shadowBranch, baseCommitSha, worktreePath }`.
- `baseBranch` is the branch (or commit-ish) the worktree was cut from. `baseCommitSha` is recorded once at enter and does not move.
- Absent job record = today’s behavior (cwd session, no delivery epilogue).
- Job metadata is session state, not a Task table. No Prisma. No second id space.

**Files.** session store, `session-worktree.ts`, `types.ts`.

**Done when.** `EnterWorktree` then `loadSession` still knows `base` / `shadow` / `baseSha`.

### F2.2 Named shadow branch

**Why.** Detached HEAD cannot be pushed or PR’d. y0 names `shadow/<slug>-<6>`.

**Contract.**

- Entering a job worktree creates a **named branch** at `baseCommitSha`, not only `--detach`.
- Default name: `raven/<sessionId-prefix>` or an explicit `/job <name>`. Path stays `.ravenclaw/worktrees/<slug>`.
- Name-from-path / session id. No authored unique-id field required.
- Dirty worktree on remove stays report-only / refuse-without-discard (current law).
- Do not clone the repo.

**Files.** `session-worktree.ts`, `enter-worktree.ts`, CLI `--worktree`.

**Done when.** `git -C <worktree> branch --show-current` prints the shadow name; `rev-parse HEAD` equals the recorded `baseCommitSha` at enter.

### F2.3 Opt-in turn-end commit epilogue

**Why.** y0 commits after a successful stream so the job is a branch, not a dirty tree. On a local machine, silent commits are hostile. The contract is the epilogue, not the default.

**Contract.**

- Off by default. On via session flag / `config.yaml` `job.autoCommit` / `/job commit on`.
- Runs **after** `submitMessage` returns success (`reason` not aborted/error). Skip if the worktree is clean.
- Commit failure is a notice. It does **not** fail the turn and does **not** rewrite the transcript.
- Abort, leftover-ask park, and error must not commit.
- Author is the operator’s `user.name` / `user.email`. No bot identity. No co-author trailer required.
- Not a default tool. The model does not have to call `Bash git commit`.

**Files.** `session-engine.ts` (or a host epilogue both TUI and serve call), git helper next to `session-worktree.ts`.

**Done when.** A successful Edit with `autoCommit` on creates one commit on the shadow branch; `/steer` abort leaves the tree dirty and creates none.

### F2.4 Checkpoint and rewind-to-checkpoint

**Why.** y0 edit-message restores `{ commitSha, todoSnapshot }`. RavenClaw rewind only pops the last file-history snapshot. After F2.3, the truth is git.

**Contract.**

- After a successful committed turn (or, if `autoCommit` is off, after a successful turn that records `HEAD` + dirty bit), persist a checkpoint on the completing assistant message: `{ commitSha, todoSnapshot, dirty }`.
- `/rewind` (or edit-last-user) restores the nearest earlier checkpoint: `git checkout` / reset **inside the worktree only** to that sha (or `baseCommitSha` if none), restore that todo snapshot, drop later transcript rows, then the host may `submitMessage` the edited text.
- Refuse rewind while `liveTurn !== null` (already true).
- No rewrite of `baseCommitSha`. No force-push.
- Sessions without a job record keep today’s file-history rewind.

**Files.** `session/rewind.ts`, file-history (job path may skip blob undo when git is source of truth), TUI `/rewind`.

**Done when.** Two committed turns, rewind once: HEAD is the first checkpoint sha and todos match that snapshot.

---

## Wave F3 — Durable host waist

Goal: a job host (serve, later a browser, even `curl`) can reconnect and stop a turn without lying.

### F3.1 Cancel ≠ fail, `turnId` guard

**Why.** eve: cancel is not failure; boundary is `turn.cancelled` then `session.waiting`. Tab close / HTTP detach does not cancel. A late cancel must not hit the next turn. RavenClaw `POST …/cancel` is `engine.abort()` + `{ ok: true }`; stream ends `round_end { reason: 'aborted' }`.

**Contract.**

- Distinguish `cancelled` from `failed`. Session accepts the next `submitMessage`. Pair in-flight `tool_use` as `aborted` (already).
- Parked leftover-ask rows are **not** denied by cancel. Stream must say “cancelled, ask still pending” when that happens. (Live abort-pair of a parked ask stays out.)
- `POST /v1/session/:id/cancel` body may include `turnId` from `round_start`. Mismatch → `no_active_turn` (200). No body → cancel the current live turn if any.
- Closing the stream is detach, not cancel.
- `202` / `accepted` vs `200 no_active_turn` are both success.

**Files.** `cli/src/serve.ts`, `session-engine.ts` abort, `StreamEvent` if a new reason string is added.

**Done when.** Cancel during a turn yields `cancelled` then a later submit runs; cancel with a stale `turnId` is a no-op.

### F3.2 Reconnectable stream

**Why.** Last horizon forbade `?after=` because `StreamEvent` had no seq. A job host that drops the TCP connection loses every `text_delta`. eve’s contract: absolute `startIndex`, stable `meta.id`, unknown version fails.

**Contract.**

- Persist a monotonic `seq` (or `streamIndex`) per session event at durable write. Replays of the same fact reuse the same seq.
- `GET /v1/session/:id/stream?after=<seq>` returns events with `seq > after`, then tails live. `after` omitted = live tail (today’s default). `after=0` = replay from the start of **this process’s recorded buffer** at minimum; prefer disk so a serve restart can still replay.
- Do not rename RavenClaw `StreamEvent` kinds to eve `input.requested`.
- Buffer at least this serve process. Disk-backed replay is the done-when if a restart must not lose `permission_ask` (already republished) **and** the text that led to it.
- No `?after=` on `/v1/turn`.

**Files.** `cli/src/serve.ts`, session event log (new small table or file), `docs/headless.md`.

**Done when.** `curl` two stream connections, the second with `?after=` of the first’s last seq, and the client can concatenate without gaps or dupes.

### F3.3 `GET /v1/session/:id` snapshot

**Why.** Reconnect needs more than a tail: job record, pending asks, last seq, permission mode. eve clients hold `{ sessionId, streamIndex }`.

**Contract.**

- `GET /v1/session/:id` (Bearer, loopback) returns `{ id, job?, pendingAsks, lastSeq, permissionMode, live }`. Not the full transcript blob (stream replay covers that).
- 404 if unknown. 401 without Bearer. No create-on-GET.
- Crash-resolve law, documented here and in `headless.md`: `applyAskAnswer` after process death **pairs only**. The client must `POST …/submit` to continue the model. Live `/resolve` that hits a waiter still unblocks the in-process turn.

**Files.** `cli/src/serve.ts`, `docs/headless.md`.

**Done when.** `curl` GET shows the F2 job record and any parked `callId`s.

---

## Wave F4 — Optional delivery and eval lock

Goal: a finished job can open a draft PR without making GitHub the product; CI owns the new contracts.

### F4.1 Optional `/pr` (default off)

**Why.** y0 hangs a draft PR on the completing turn. On a local BYOK machine that must be an explicit operator action.

**Contract.**

- `/pr` (TUI) and `POST /v1/session/:id/pr` (serve) create or update a draft `shadow → base` via `gh` if present.
- Preconditions: job record exists, worktree clean (or F2.3 just committed), `gh` authenticated. Otherwise a notice, not a thrown turn.
- Snapshot `{ title, body, url?, sha, files, +, - }` is stored as an annotation on the last assistant message. Update-in-place if a PR number is already on the job record.
- Never starts a model turn. Never default-on. No GitHub App.

**Files.** CLI slash, serve route, small `gh` helper. No new default tool.

**Done when.** `/pr` on a clean shadow branch records a URL; dirty tree skips; session without a job record notices and does nothing.

### F4.2 Eval fixtures for this horizon

**Why.** Path-identity exists; the runner is still a special-case switch.

**Contract.**

- New fixtures (path is identity): `todo-restore`, `cancel-not-fail`, `stream-reconnect` (in-process seq if HTTP is heavy), `job-shadow-branch`.
- Gates only. No LLM-as-judge.
- Prefer in-process `createSessionEngine` plus a serve-loopback test for F3.2. Do not invent a second loop.

**Files.** `packages/core/src/eval/`.

**Done when.** `bun test` on the eval runner fails if F1.2, F2.2, or F3.1 regress.

### F4.3 Stacked child base = parent shadow

**Why.** y0 stacked PR is a new Task whose base is the parent shadow. RavenClaw already has `Agent` + worktree isolation (detached). After F2, a child job should stack.

**Contract.**

- `Agent` with `isolation: worktree` in a parent that has a job record cuts the child worktree from **parent `shadowBranch`** (current parent HEAD), and the child gets its own job record (`base = parent.shadow`, new child shadow).
- Parent transcript keeps today’s child pointer / `agent_mail`. Do not copy the parent chat into the child except the existing prompt.
- No stacked-PR UI. F4.1 on the child targets `child.shadow → parent.shadow`.

**Files.** `tools/agent.ts`, `worktree.ts`, `session-worktree.ts`.

**Done when.** A child worktree’s `merge-base` is the parent shadow tip at spawn.

---

## Out of this horizon

Web chat UI, Next.js BFF, Prisma Task, Socket.IO, y0 Shadow wiki / indexer, eve compiler, OpenAPI connections, memory slots/providers, `defineState` authoring, credential brokering, self-mod, any new chat network, sandbox network policy, Grep/Glob docker-exec, NotebookEdit docker port, Slack HMAC, `ignored`, live cancel abort-pair.

If a later product wants a browser, it implements F3. It does not add a second loop.

---

## Suggested order

1. **F0** — docs + ACP waiter + the two missing eval gates (unblocks honest F2 design).
2. **F1.1 + F1.2** then **F1.3** — compact/todo truth (F2.4 needs the session list).
3. **F2.1 + F2.2** then **F2.3 + F2.4** — job identity before epilogues.
4. **F3.1** then **F3.2 + F3.3** — cancel honesty, then cursor + snapshot.
5. **F4.1** then **F4.3**; **F4.2** last locks the wave.

---

## Success checks

A slice that does not move one of these is out of scope.

1. `ARCHITECTURE.md` names schema v6 and session resolve (F0.1).
2. ACP waiter expiry leaves the pending row (F0.2).
3. Compact then Write of a summarized path requires a new Read (F1.1).
4. Compact re-injects this session’s todos (F1.2 / F1.3).
5. `--worktree` session has a named shadow branch and a recorded `baseSha` (F2.1 / F2.2).
6. Opt-in auto-commit creates a commit only on success (F2.3).
7. `/rewind` lands on the previous checkpoint sha + todos (F2.4).
8. Cancel is not a failed session; stale `turnId` is a no-op (F3.1).
9. A second stream with `?after=` concatenates without gaps (F3.2).
10. `/pr` is opt-in and never fails the turn (F4.1).

---

## Key decisions

1. **Theme is session-as-job, not a web UI.** E4 already gave serve a stream. The product step is a session that owns a branch. F3 only finishes the waist a job host needs.
2. **Job metadata hangs on the session**, not a Task table. Worktree is the local analog of y0’s clone. No second id space.
3. **Auto-commit and auto-PR default off.** The contracts are epilogues. Silent git on the operator’s machine is hostile.
4. **Todos become session-scoped.** Compact restore and checkpoints are lies if two sessions share one cwd file.
5. **`?after=` is in this horizon.** Last plan deferred it because there was no seq. This plan adds seq. Live tail without a query param stays the default.
6. **Cancel does not settle parked leftover-ask.** Same as last plan. The stream must not look like a failed turn.
7. **Crash `/resolve` still pairs only.** Continuing the model is a later `submitMessage`. Do not auto-start a turn from `applyAskAnswer`.
8. **Host writers that skip `WorkspaceFs` stay host-only** (NotebookEdit, Memory, file-history). Document, do not docker-exec in this horizon.
