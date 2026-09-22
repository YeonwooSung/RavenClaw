# RavenClaw next-horizon roadmap (NotebookEdit docker)

Date: 2026-09-21  
Status: implemented  
Shipped sha: `6d439b6` on `main` (merge of `docs/notebookedit-docker`; code `f67c49f`).  
Reviewed against tree at `0a1176f` (`origin/main`, instructionFiles + three doors landed).  
Successor to `2026-09-21-grep-glob-docker-exec.md` (Status: implemented). Amends prior OUT for **NotebookEdit docker** only. Does not reopen WorkspaceFs docker I/O, sandbox network policy, dismiss-on-message, or the LSP museum.

Implementation plan: [docs/superpowers/plans/2026-09-21-notebookedit-docker.md](../plans/2026-09-21-notebookedit-docker.md). Isolated worktree only. Do not implement on `main`.

Sources: current tree; [eve analysis](../../research/eve-analysis.md) sandbox split. Steal contracts. Do not copy eve source. Do not become an agent framework. Do not add a web UI.

---

## Where we are

NotebookEdit is a leftover-ask mutator. It does **not** use `WorkspaceFs`. It has **no cwd jail**. Read of `.ipynb` is a different tool (Read formats cells; NotebookEdit mutates JSON).

At `0a1176f`:

| Piece | Tree |
|---|---|
| `notebookEditTool` | Singleton. `readFileSync` / `writeFileSync` on `resolveWritePath(cwd, path)`. Hard-deny via `isHardDeniedWritePath`. `wasRead` required. Parse/stringify in `notebook-format.ts`. |
| Cwd jail | **None.** A path that resolves outside cwd still reaches `readFileSync` unless hard-denied (`~/.ssh`, `state.db`, `/etc/shadow`, …). |
| SDK | `createRootTools` does **not** include NotebookEdit. CLI `createRootTools` does. |
| Docker | Grep/Glob/Bash share `TerminalBackend`. File tools (Read/Write/Edit) stay host `WorkspaceFs` (sibling door). |
| Permissions | `checkPermissions` leftover-ask. `acceptEdits` / `dontAsk` do **not** promote NotebookEdit. |
| `fileHistory.snapshot` | Host, before write. |
| `interruptBehavior` | `'block'`. |

Session-as-job / eve E2.1 parked NotebookEdit out of the WorkspaceFs mount. This horizon unparks **that tool’s docker I/O** as its own door, so a docker session cannot edit a notebook on the host while Bash runs in the container.

`dontAsk` is still not isolation.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` stays the only non-`submitMessage` closer. NotebookEdit stays leftover-ask.
2. Default prefix unchanged. No new tool. Factory wraps the existing tool.
3. `dontAsk` never becomes `bypass`. `acceptEdits` still does not promote NotebookEdit.
4. BYOK. Clean-room. No web UI, Prisma Task, Socket.IO, wiki.
5. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.

---

## Do not build

- WorkspaceFs docker I/O for Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree (sibling door; do not implement those factories here)
- Memory / TodoWrite / Skill / file-history writers in the container
- Sandbox network policy, session-long container, Kata
- Putting NotebookEdit in SDK `createRootTools`
- Promoting NotebookEdit under `acceptEdits` / `dontAsk`
- Schema bump, `Turn.terminalImage`, backend instance on `createSessionEngine`
- Fail-open host `readFileSync` when docker exec fails
- yaml `extraArgs` as a new key
- Dismiss-on-message, LSP museum, web UI

Amend prior OUT **only** for NotebookEdit docker.

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

1. **IN is NotebookEdit only.** Parse/stringify stay host (`notebook-format.ts` unchanged as a format library). Only the bytes on disk move through the docker port.

2. **Independent of WorkspaceFs docker.** This door must close even if WorkspaceFs still ignores `backend`. Do **not** wait for, and do **not** implement, Read/Write docker. NotebookEdit may call a small private cat/tee helper (local to `notebook-edit.ts`, or a shared `sandbox-fs.ts` **imported** if the sibling door already added it — do not create WorkspaceFs docker behavior from here). Do not edit `workspace-fs.ts` in this worktree.

3. **Same port object as Bash.** `createNotebookEditTool(backend?: TerminalBackend)`. CLI `createRootTools` passes the same instance already given to Bash/Grep/Glob. Omit / `kind !== 'docker'` / image-less docker constructor → today’s host `readFileSync`/`writeFileSync` **after** the new jail. Default export `notebookEditTool` stays local so existing tests that import the singleton stay green.

4. **Cwd jail before any I/O (new, both backends).** Resolve with `resolveWritePath`. Then host `resolveExisting` + inside-cwd check (same predicate as `WorkspaceFs` / `isInTreePath` without extra AddDir roots). Outside-cwd → `NotebookEdit failed: outside workspace` and **no** `backend.exec` and **no** host read/write. Hard-deny still runs first (`NotebookEdit failed: write denied to protected path:`). Adding this jail on the **local** path is in-scope: docker I/O without a jail is a hole.

5. **`wasRead` unchanged.** Keys stay host resolved paths. Docker does not invent a second identity. Missing prior Read → `NotebookEdit failed: path must be Read first:` with no exec.

6. **One exec to read, one exec to write** when docker (two `backend.exec` calls, not a combined script). Read = `cat` of the jailed path (stdout = notebook JSON text). Write = `tee` / `cat >` with **stdin** = `stringifyNotebook` bytes. If `TerminalExecOpts` has no `stdin` yet, this door adds the **same** optional field as WorkspaceFs docker spec ruling 9: `stdin?: string | Uint8Array` on `TerminalExecOpts` and `TerminalRunRequest`; `stdio: [pipe, pipe, pipe]` only when present; docker argv already has `-i`. If the sibling door already added that field, consume it and do not fork a second stdin API. Do not embed notebook JSON in `bash -c`. Timeout 30s.

7. **Fail-closed, split by cause.** No daemon / missing `cat`/`tee` / 30s timeout → `NotebookEdit failed:` and **no** host `writeFileSync`. The in-memory parsed notebook is discarded. **Turn abort** (`ctx.signal`) throws `AbortError` (paired as `ABORTED_TEXT`; tool keeps `interruptBehavior: 'block'` which `phases.ts` already maps). Do not stringify abort into `NotebookEdit failed:`.

8. **Snapshot order unchanged.** `fileHistory.snapshot(resolved)` on the host bind path, then docker write. Lint is N/A (NotebookEdit does not lint). Undo stays host file-history.

9. **Permissions unchanged.** Leftover-ask. `acceptEdits` / `dontAsk` do not promote. `dontAsk` leftover of NotebookEdit stays deny at `decidePermission` (existing law).

10. **SDK unchanged.** NotebookEdit stays CLI-root-only. Do not add it to SDK `createRootTools`.

11. **`createSessionEngine` still has no backend instance.** Eval that needs docker NotebookEdit injects `createNotebookEditTool(fakeBackend)` in `tools`. No live docker required to merge.

12. **Secrets.** Allowlist env only. No docker.sock.

13. **Docs honesty.** Label NotebookEdit: when Bash is actually docker, NotebookEdit bytes exec in that container; omit/local stays host after the new cwd jail. Do not claim Read/Write are docker because this door shipped.

---

## Theme

A docker session edits notebooks in the same container Bash uses. Outside-cwd is refused on every backend. Pairing and leftover-ask stay.

---

## Per-slice board

Board as of this worktree (`docs/notebookedit-docker`). N0.1–N2.1 done.

| ID | Status vs tree |
|---|---|
| N0.1 Cwd jail on local + docker (no exec yet) | **done** |
| N0.2 `createNotebookEditTool` + CLI wiring | **done** |
| N1.1 Docker cat/tee + stdin + fail-closed | **done** |
| N2.1 Tests + docs | **done** |

---

## Wave N0 — Jail + factory

### N0.1 Cwd jail

**Contract.** Ruling 4. Existing outside-cwd notebook path that today succeeds on host must now fail `outside workspace` even with a local backend. Hard-deny strings stay. `wasRead` still required.

**Files.** `packages/core/src/tools/notebook-edit.ts`, `notebook-edit.test.ts`.

### N0.2 Factory

**Contract.** `createNotebookEditTool(backend?)`. Default singleton = omit. CLI `createRootTools` passes `backend`. Export from `packages/core/src/index.ts`. SDK list unchanged.

**Files.** `notebook-edit.ts`, `packages/cli/src/engine.ts`, `packages/core/src/index.ts`.

---

## Wave N1 — Docker bytes

**Contract.** Rulings 6–8, 11. Fake `runCommand`: first exec is cat (stdout = JSON); after in-memory edit, second exec is tee/cat with stdin; host `writeFileSync` not called; exec fail leaves the host file unchanged; abort throws `AbortError`. If stdin is missing on `TerminalExecOpts`, add the shared field (WorkspaceFs docker spec ruling 9) without changing docker argv.

**Files.** `notebook-edit.ts`, `terminal-backend.ts` only if stdin is not already present, tests.

---

## Wave N2 — Tests + docs

**Contract.** Unit tests for jail, wasRead, hard-deny, docker fake, abort. No new eval fixture required; optional sibling of `sandbox-fs` only if that fixture already exists. Docs: `ARCHITECTURE.md` / `.ko.md` NotebookEdit row, `docs/headless.md`. Pointer from E2.1: NotebookEdit docker unparked by this spec; WorkspaceFs docker stays parked unless that sibling spec has shipped. Amended: WorkspaceFs docker shipped on `main` at `9c8d9db` ([`2026-09-21-workspacefs-docker.md`](2026-09-21-workspacefs-docker.md)). Dismiss-on-message shipped on `main` at `061d23c` ([`2026-09-21-dismiss-on-message.md`](2026-09-21-dismiss-on-message.md)).

---

## File map

| Path | Wave |
|---|---|
| `packages/core/src/tools/notebook-edit.ts` | N0, N1 |
| `packages/core/src/tools/notebook-edit.test.ts` | N0, N1, N2 |
| `packages/core/src/tools/terminal-backend.ts` | N1 (stdin only, if absent) |
| `packages/cli/src/engine.ts` | N0.2 |
| `packages/core/src/index.ts` | N0.2 |
| `docs/headless.md`, `ARCHITECTURE.md`, `ARCHITECTURE.ko.md` | N2 |

Do not touch: `workspace-fs.ts`, `read.ts`, `write.ts`, `edit.ts`, `apply-patch.ts`, `list-dir.ts`, `read-subtree.ts`, `loop/`, schema, SDK `createRootTools` tool list, `notebook-format.ts` (format only).

---

## Success checks

1. Local NotebookEdit of a path outside cwd returns `NotebookEdit failed: outside workspace` and does not write.
2. Docker fake backend: in-tree `.ipynb` that was Read first is cat’d then teed via `backend.exec`; host `writeFileSync` is not the write path; file content matches stringify.
3. Exec fail (no daemon) → `NotebookEdit failed:` and the host notebook is unchanged.
4. Turn abort throws `AbortError`.
5. `wasRead` miss still fails with no exec. Hard-deny still fails with no exec.
6. `acceptEdits` / `dontAsk` still do not auto-allow NotebookEdit.
7. SDK `createRootTools` still omits NotebookEdit.
8. Read/Write/Edit still use host WorkspaceFs (this door did not wire them).

---

## Out of this closeout

WorkspaceFs docker I/O, Memory in container, file-history docker, SDK NotebookEdit, `acceptEdits` promotion, session-long container, dismiss-on-message, web UI, Prisma Task, Socket.IO, wiki, schema bump.

---

## Hard rulings recap

1. NotebookEdit bytes only; same `TerminalBackend` as Bash; independent of WorkspaceFs docker.
2. Cwd jail on every backend before I/O.
3. One cat + one stdin write; fail-closed; abort → `AbortError`.
4. Leftover-ask unchanged. Default singleton local. SDK omits the tool.
5. Secrets stay out of the container. No new tool. No schema bump.
