# RavenClaw next-horizon roadmap (file-history docker undo)

Date: 2026-09-22  
Status: draft  
Shipped sha:  
Reviewed against tree at `061d23c` (`origin/main`, WorkspaceFs docker + NotebookEdit docker + dismiss-on-message landed).  
Successor to `2026-09-21-workspacefs-docker.md` (Status: implemented). Amends that spec’s ruling 14 **only for undo restore/remove of workspace files**. Does not reopen Memory docker, snapshot-as-docker-cp, extra mounts, Slack/ACP skip UI, or `fileHistory` todo frames.

Implementation plan: [docs/superpowers/plans/2026-09-22-file-history-docker.md](../plans/2026-09-22-file-history-docker.md). Isolated worktree only. Do not implement on `main`.

Sources: current tree; [eve analysis](../../research/eve-analysis.md) sandbox split. Steal contracts. Do not copy eve source. Do not become an agent framework. Do not add a web UI.

---

## Where we are

WorkspaceFs docker already writes workspace files through Bash’s container. `fileHistory.snapshot` copies the jailed **host bind path** into `$RAVENCLAW_HOME/file-history/<id>/` before that write (same inodes). `/undo` and no-job `/rewind` still restore and unlink workspace files with host `writeFileSync` / `unlinkSync`.

At `061d23c`:

| Piece | Tree |
|---|---|
| `createFileHistory(sessionId, home?)` | Sync. Backups under `join(home, 'file-history', sessionId)`. No `TerminalBackend`. No cwd. |
| `snapshot(absPath)` | Host `existsSync` / `copyFileSync` into the backup dir. New files record `{ existed: false }`. Dedupes per generation. |
| `undo()` | Sync. Restores via host `writeFileSync(readFileSync(backup))`; removes created files via host `unlinkSync`. Catch → leftover row. |
| Callers | `rewindLastTurn` (`await` already); slash `/undo` (`dispatch.ts`); tests. |
| `createSessionEngine` | `opts.fileHistory ?? createFileHistory(session.id)`. No backend instance. |
| CLI runtime | Builds a live `TerminalBackend` for tools; does **not** inject `fileHistory`. |

A docker session can still rewrite workspace files on the operator process during `/undo` while Bash is jailed. Snapshot-to-`$HOME` is not that hole: backups live outside the cwd bind by design (WorkspaceFs ruling 14). This horizon unparks **undo restore/remove**.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` stays the only non-`submitMessage` closer. `/undo` is not a fourth entry and does not start a model turn.
2. Default prefix unchanged. No new tool.
3. `dontAsk` never becomes `bypass`.
4. BYOK. Clean-room. No web UI, Prisma Task, Socket.IO, wiki.
5. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.
6. `createSessionEngine` still has no `TerminalBackend` instance. Inject FileHistory from the outside, the same way tools receive a backend.

---

## Do not build

- Memory / TodoWrite / Skill docker (sibling / parked)
- Docker-exec of snapshot `cp` into `$HOME` (backups stay host)
- Extra docker mounts (`$RAVENCLAW_HOME`, AddDir, `projectCwd`)
- `fileHistory` todo frames, no-job git checkpoint, schema bump
- Putting a `TerminalBackend` field on `createSessionEngine` / `SessionEngineOptions` besides the existing optional `fileHistory`
- Sandbox network policy, session-long container, Kata
- Slack/ACP skip UI, LSP museum, web UI
- Changing generation / `reset()` / `beginTurn` / `endTurn` semantics
- Making `dontAsk` mean isolation

Amend prior OUT **only** for file-history **undo** of workspace files.

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

1. **IN is undo restore/remove of workspace files.** `snapshot` stays host `copyFileSync` / `existsSync` of the bind path into `$RAVENCLAW_HOME/file-history/<id>/` (WorkspaceFs ruling 14 stands for snapshot). `reset()` still drops RAM generations and does not delete backups. `beginTurn` / `endTurn` / `pendingCount` / `turnWriteCount` / `peekLast` stay sync.

2. **`undo()` becomes `Promise<UndoResult>`.** Local backend (no docker / omit) wraps today’s sync body in an async function so every caller `await`s. Docker backend restore/remove uses `backend.exec`; it must **not** call host `writeFileSync` / `unlinkSync` on the workspace path. Backup **read** stays host (`readFileSync(backupPath)` then stdin to `tee`).

3. **Same port object as Bash, injected — not reconstructed.** `createFileHistory(sessionId, home?, opts?: { backend?: TerminalBackend; cwd?: string })`. Omit / `backend.kind !== 'docker'` / image-less constructor → today’s host undo (async wrapper). `kind === 'docker'` requires `cwd` (the bind). Missing cwd on docker → treat as local host undo (do not guess). CLI / SDK, when they already construct a live backend for `createRootTools`, also construct `createFileHistory(session.id, home, { backend, cwd: session.cwd })` and pass it as `SessionEngineOptions.fileHistory`. `createSessionEngine` keeps `opts.fileHistory ?? createFileHistory(session.id)` and still takes **no** backend instance. Agent children that share parent `fileHistory` inherit the injected instance (`fileHistoryOwnsTurn` unchanged).

4. **Jail on restore/remove.** Docker undo of a row whose `path` is outside `cwd` (`isInTreePath(cwd, path)` false, no extra roots) → leftover that row, **no** exec, **no** host write. Same as WorkspaceFs outside-cwd: the container must not be asked to write `/etc` or `$HOME`.

5. **One exec per restore or remove.** Restore existing file: `tee ${shQuote(path)}` with `stdin` = backup bytes, timeout 30s, `cwd` = bind. Remove created file: `rm -f` (WorkspaceFs unlink script is fine). Do not embed backup bytes in `bash -c`. Do not call `backend.start`. Prefer WorkspaceFs `writeFile` / `unlink` when the path is in-tree so stdin/base64/fail-closed stay one implementation. Do not change WorkspaceFs behavior in this worktree.

6. **Fail-closed, split by cause.** No daemon / missing `tee`/`rm` / 30s timeout / non-zero exec → leftover that row, **no** host fallback write. Partial undo (some rows restored, some leftover) is today’s shape. Turn abort during `/undo` is out of scope (`/undo` is not a tool); slash dispatch still runs undo on the operator side. If `backend.exec` throws `AbortError`, leftover the row and do not host-write.

7. **Callers await.** `rewindLastTurn` already async — `await opts.fileHistory.undo()`. Slash `/undo` in `packages/cli/src/slash/dispatch.ts` `await`s and then `formatUndoNotice`. Tests that called `history.undo()` synchronously `await`. `formatUndoNotice` / `formatRewindNotice` unchanged. Persist-before-undo on no-job rewind stays: compact first, then undo (today’s order). Docker undo fail after compact is the same class as today’s restore catch (transcript already dropped; leftover snapshots remain).

8. **No live docker required to merge.** Fake `runCommand`. Optional live `bash:5` skipped when daemon/image absent. Never fail-open in production because CI skipped.

9. **Secrets.** Allowlist env only. No docker.sock.

10. **Docs honesty.** When Bash is actually docker and FileHistory was injected with that backend, `/undo` and no-job `/rewind` restore/remove workspace files in that container; snapshot backups stay under `$RAVENCLAW_HOME`. Omit/local stays host. Do not claim Memory or TodoWrite are docker-exec.

---

## Theme

`/undo` of a docker session restores workspace files through the same port Bash uses. Backups stay in `$HOME` on the host. A down daemon fail-closes instead of silently writing on the operator process.

---

## Per-slice board

Board as of this spec (draft).

| ID | Status vs tree |
|---|---|
| F0 `undo(): Promise<UndoResult>` + local wrap | **missing** |
| F1 Docker restore/remove + jail | **missing** |
| F2 CLI/SDK inject FileHistory | **missing** |
| F3 Docs honesty | **missing** |

---

## Wave F0 — Async undo, local behavior

**Contract.** Signature `undo(): Promise<UndoResult>`. Default `createFileHistory(id)` (no opts) matches today’s restore/remove/blocked/leftover. Every in-repo caller awaits. Existing `file-history.test.ts` and `rewind.test.ts` stay green.

**Files.** `packages/core/src/session/file-history.ts`, `file-history.test.ts`, `rewind.ts`, `rewind.test.ts`, `packages/cli/src/slash/dispatch.ts`, `dispatch.test.ts`, any other `fileHistory.undo()` call sites.

---

## Wave F1 — Docker undo

**Contract.** `createFileHistory(id, home, { backend, cwd })` with docker backend: restore/remove via exec / WorkspaceFs; outside-cwd leftover; fail-closed; snapshot still host. Fake `runCommand` asserts exec and no host write of workspace bytes.

**Files.** `file-history.ts`, `file-history.test.ts`.

---

## Wave F2 — Inject from hosts

**Contract.** CLI `engine.ts` and SDK session builder, when `backend` is defined, pass `fileHistory: createFileHistory(session.id, home, { backend, cwd: session.cwd })`. Omit backend → engine default local FileHistory. Children sharing parent history unchanged. `createSessionEngine` gains no backend field.

**Files.** `packages/cli/src/engine.ts`, CLI tests that lock singleton/backend wiring, `packages/sdk/src/index.ts` + tests if SDK constructs engines with a docker backend.

---

## Wave F3 — Docs

**Contract.** `ARCHITECTURE.md` / `.ko.md`, `SLASH_COMMANDS.md` / `.ko.md` (`/undo`), `docs/headless.md`, CHANGELOG Unreleased, eve-analysis closer pointer, this spec Status → implemented after code. Amend workspacefs ruling-14 prose: snapshot stays host; **undo restore/remove** is this door.

---

## File map

| Path | Wave |
|---|---|
| `packages/core/src/session/file-history.ts` | F0–F1 |
| `packages/core/src/session/file-history.test.ts` | F0–F1 |
| `packages/core/src/session/rewind.ts` | F0 |
| `packages/core/src/session/rewind.test.ts` | F0 |
| `packages/cli/src/slash/dispatch.ts` | F0 |
| `packages/cli/src/slash/dispatch.test.ts` | F0 |
| `packages/cli/src/engine.ts` | F2 |
| SDK session builder if it constructs engines | F2 |
| docs listed in F3 | F3 |

Leave `memory.ts`, `todo.ts`, `workspace-fs.ts` behavior, schema, Slack/ACP, `createSessionEngine` options besides `fileHistory`.

---

## Success checks

1. Local `undo` still restores/removes the last closed generation; open generation still `blocked`.
2. Docker `undo` restore/remove goes through `backend.exec` (or WorkspaceFs on that backend) and never host-writes the workspace path.
3. Docker undo of an outside-cwd snapshot path leftovers the row with zero exec.
4. `rewindLastTurn` and `/undo` await and still format the same notices on the local path.
5. `createSessionEngine` still has no backend instance; CLI/SDK inject FileHistory when they have a backend.

---

## Out of this closeout

Memory docker, TodoWrite/Skill docker, snapshot docker-cp, extra mounts, `fileHistory` todo frames, schema bump, Slack/ACP skip.
