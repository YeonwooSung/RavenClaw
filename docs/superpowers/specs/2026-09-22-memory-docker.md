# RavenClaw next-horizon roadmap (Memory docker I/O)

Date: 2026-09-22  
Status: implemented  
Shipped sha:  
Reviewed against tree at `061d23c` (`origin/main`, WorkspaceFs docker + NotebookEdit docker + dismiss-on-message landed).  
Successor to `2026-09-21-workspacefs-docker.md` and `2026-09-21-notebookedit-docker.md` (Status: implemented). Amends prior OUT for **Memory docker I/O** only. Does not reopen file-history docker, TodoWrite/Skill docker, Slack/ACP skip UI, sandbox network policy, session-long containers, or the LSP museum.

Implementation plan: [docs/superpowers/plans/2026-09-22-memory-docker.md](../plans/2026-09-22-memory-docker.md). Isolated worktree only. Do not implement on `main`.

Sources: current tree; [eve analysis](../../research/eve-analysis.md) sandbox split. Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not add a web UI.

---

## Where we are

Read / Write / Edit / ApplyPatch / ListDir / ReadSubtree / Grep / Glob / NotebookEdit already share Bash’s `TerminalBackend` when that backend is actually docker (kind + image). Memory still uses host `node:fs`.

At `061d23c`:

| Piece | Tree |
|---|---|
| `memoryTool` | Singleton in `packages/core/src/tools/memory.ts`. `readFileSync` / `mkdirSync` / `writeFileSync` on `memoryFilePath(projectCwd ?? cwd, target)` → `<root>/.ravenclaw/MEMORY.md` or `USER.md`. |
| Factory | None. CLI and SDK `createRootTools` always insert the singleton. |
| Jail | None beyond the constructed path. Cap `MEMORY_FILE_CHAR_CAP` (8000) is an in-memory refuse before write. |
| Permissions | Leftover-ask `{ behavior: 'ask', saveAs: 'session' }`. `acceptEdits` / `dontAsk` do not promote Memory. |
| Docker | File tools and NotebookEdit exec in the container. Memory writes on the operator process even when Bash is docker. |
| Job isolation | `turn.projectCwd = worktree.originalCwd`. Memory then writes the **project** sidecar, which is outside the docker cwd bind. |
| Snapshot | Memory does not call `fileHistory.snapshot`. |

A docker session can still mutate project memory on the host while Bash runs in the container. This horizon unparks **that writer**.

`dontAsk` is still not isolation.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` stays the only non-`submitMessage` closer. Memory stays leftover-ask.
2. Default prefix unchanged. No new tool. Factory wraps the existing tool.
3. `dontAsk` never becomes `bypass`. `acceptEdits` still does not promote Memory.
4. BYOK. Clean-room. No web UI, Prisma Task, Socket.IO, wiki.
5. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.
6. `createSessionEngine` still has no `TerminalBackend` instance.

---

## Do not build

- file-history docker undo (sibling door)
- TodoWrite / Skill writers in the container
- Extra docker mounts (`projectCwd`, AddDir roots, `$RAVENCLAW_HOME`)
- Sandbox network policy, session-long container, Kata, `docker exec` into a kept container
- Schema bump, `Turn.terminalImage`, backend instance on `createSessionEngine`
- Fail-open host `writeFileSync` when docker exec fails
- yaml `extraArgs` as a new key
- Slack/ACP skip UI, LSP museum, web UI
- Changing `MEMORY_FILE_CHAR_CAP`, `nextBody` / `appendParagraph` semantics, or the leftover-ask permission
- Writing MEMORY.md under the job worktree instead of `projectCwd` on the **local** backend

Amend prior OUT **only** for Memory docker I/O.

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

1. **IN is the Memory tool only.** Parse, `nextBody`, cap check, leftover-ask, and the two filenames stay. Only the bytes on disk move through the docker port.

2. **Same port object as Bash.** `createMemoryTool(backend?: TerminalBackend)`. CLI `createRootTools` and SDK `createRootTools` pass the same instance already given to Bash / WorkspaceFs / NotebookEdit. Omit / `kind !== 'docker'` / image-less docker constructor → today’s host `node:fs` after the path is computed. Default export `memoryTool = createMemoryTool()` stays local so existing tests that import the singleton stay green.

3. **Path formula unchanged.** `root = ctx.turn.projectCwd ?? ctx.turn.cwd`. `path = memoryFilePath(root, target)`. Do not start writing MEMORY.md under the job worktree on the local backend.

4. **Docker I/O only when the memory file is inside `turn.cwd`.** Host `isInTreePath(ctx.turn.cwd, path)` (no extra AddDir roots). Inside → one read exec (or equivalent WorkspaceFs `readFile`) plus one write exec (`tee` / WorkspaceFs `writeFile`) with stdin = next body; mkdir of `.ravenclaw` is one exec when needed. **Outside** (job isolation: `projectCwd` is the original repo, docker bind is the worktree) → return exactly `Memory failed: outside workspace`, **no** `backend.exec`, **no** host `writeFileSync`. A docker session must not silently write project memory on the operator process. Local backend keeps today’s `projectCwd` write even when that path is outside `turn.cwd`.

5. **Reuse WorkspaceFs when the path is in-tree.** Prefer `createWorkspaceFs({ cwd: ctx.turn.cwd, exec: backend, signal: ctx.signal })` for in-tree docker/host I/O (it already fail-closes, base64-reads, and tees). Do not fork a second cat/tee helper unless WorkspaceFs cannot mkdir/read/write the jailed path. Do not edit WorkspaceFs behavior in this worktree.

6. **Cap and match stay host-side on the read body.** Read existing bytes (docker or host), run `nextBody` + cap in process, then write. Cap refuse and `match not found` do **not** write and do **not** issue a write exec. Missing file reads as `''` (today). Docker read fail (no daemon / timeout / missing `cat`) → `Memory failed:` with no host fallback and no write.

7. **Fail-closed, split by cause.** No daemon / missing `tee` / 30s timeout / non-zero write → `Memory failed:` and **no** host `writeFileSync`. **Turn abort** (`ctx.signal`) throws `AbortError` (paired as `ABORTED_TEXT`). Do not stringify abort into `Memory failed:`. `interruptBehavior` stays `'block'`.

8. **Permissions unchanged.** Leftover-ask. `acceptEdits` / `dontAsk` do not promote. `dontAsk` leftover of Memory stays deny at `decidePermission`.

9. **No `fileHistory.snapshot`.** Memory does not grow undo snapshots this door.

10. **`createSessionEngine` still has no backend instance.** Eval that needs docker Memory injects `createMemoryTool(fakeBackend)` in `tools`. No live docker required to merge. Fake `runCommand` like WorkspaceFs / NotebookEdit tests.

11. **Secrets.** Allowlist env only. No docker.sock. No `ANTHROPIC_API_KEY`.

12. **Docs honesty.** When Bash is actually docker **and** the memory file sits inside `turn.cwd`, Memory bytes exec in that container; omit/local/image-less docker stays host; job isolation (`projectCwd` outside cwd) on docker is `Memory failed: outside workspace`. Do not claim TodoWrite, Skill, or file-history undo are docker-exec.

---

## Theme

A docker session writes `.ravenclaw/MEMORY.md` / `USER.md` in the same container Bash uses, when those files live on the cwd bind. Outside the bind, docker Memory fail-closes. Pairing and leftover-ask stay.

---

## Per-slice board

Board as of this worktree (`docs/memory-docker`). M0–M3 done.

| ID | Status vs tree |
|---|---|
| M0 Factory + path + local singleton | **done** |
| M1 Docker in-tree I/O + outside-cwd fail-close | **done** |
| M2 CLI/SDK wiring + tests | **done** |
| M3 Docs honesty | **done** |

---

## Wave M0 — Factory

**Contract.** `createMemoryTool(backend?)`. Default export stays local. Existing `memory.test.ts` cases stay green against the singleton. Path formula and cap unchanged.

**Files.** `packages/core/src/tools/memory.ts`, `memory.test.ts`, `packages/core/src/index.ts`.

---

## Wave M1 — Docker I/O

**Contract.** In-tree docker: read/mkdir/write through WorkspaceFs (or cat/tee) with the injected backend. Outside `turn.cwd` on docker: `Memory failed: outside workspace`, zero exec, file unchanged. Abort throws `AbortError`. Cap/match refuse issue no write exec. Fake `runCommand` tests; optional live `bash:5` skipped when daemon/image absent.

**Files.** `memory.ts`, `memory.test.ts`.

---

## Wave M2 — Hosts

**Contract.** CLI and SDK `createRootTools` use the factory when `backend` is set; omit keeps singleton identity. SDK still includes Memory (unlike NotebookEdit).

**Files.** `packages/cli/src/engine.ts`, `packages/cli/src/exec.test.ts`, `packages/sdk/src/index.ts`, `packages/sdk/src/index.test.ts`.

---

## Wave M3 — Docs

**Contract.** `ARCHITECTURE.md` / `.ko.md`, `docs/headless.md`, CHANGELOG Unreleased bullet, eve-analysis en/ko closer pointer, this spec Status → implemented after code (sha filled when the branch lands on main). Point from workspacefs/notebookedit OUT lists. Do not rewrite `2026-09-15-eve-inspired-roadmap.md` except a pointer.

---

## File map

| Path | Wave |
|---|---|
| `packages/core/src/tools/memory.ts` | M0–M1 |
| `packages/core/src/tools/memory.test.ts` | M0–M1 |
| `packages/core/src/index.ts` | M0 |
| `packages/cli/src/engine.ts` | M2 |
| `packages/cli/src/exec.test.ts` | M2 |
| `packages/sdk/src/index.ts` | M2 |
| `packages/sdk/src/index.test.ts` | M2 |
| docs listed in M3 | M3 |

Leave `file-history.ts`, `todo.ts`, `skill.ts`, `workspace-fs.ts` behavior, `loop/`, schema, Slack/ACP adapters.

---

## Success checks

1. Singleton Memory tests still pass (local host I/O, cap, match).
2. Docker in-tree Memory add/replace/remove goes through `backend.exec` and never `writeFileSync` on the write path.
3. Docker + `projectCwd` outside `cwd` returns `Memory failed: outside workspace`, zero exec, host file unchanged.
4. Turn abort throws `AbortError`.
5. CLI/SDK pass the live backend into `createMemoryTool` when defined.

---

## Out of this closeout

file-history docker undo, TodoWrite/Skill docker, extra mounts, Slack/ACP skip, session-long container, schema bump.
