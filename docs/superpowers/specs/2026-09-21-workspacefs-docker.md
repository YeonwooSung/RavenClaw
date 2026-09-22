# RavenClaw next-horizon roadmap (WorkspaceFs docker I/O)

Date: 2026-09-21  
Status: implemented  
Shipped sha: `0bd239a` on `docs/workspacefs-docker`.  
Reviewed against tree at `0a1176f` (`origin/main`, instructionFiles + three doors landed).  
Successor to `2026-09-21-grep-glob-docker-exec.md` (Status: implemented). Amends prior OUT for **WorkspaceFs docker I/O** only. Does not reopen NotebookEdit docker, sandbox network policy, session-long containers, `ignored`, dismiss-on-message, or the LSP museum.

Implementation plan: [docs/superpowers/plans/2026-09-21-workspacefs-docker.md](../plans/2026-09-21-workspacefs-docker.md). Isolated worktree only. Do not implement on `main`.

Sources: current tree; [eve analysis](../../research/eve-analysis.md) “when a sandbox backend is on, file tools go through the same port.” Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not add a web UI.

---

## Where we are

Grep/Glob already share Bash’s `TerminalBackend` (one `docker run --rm` per call, POSIX walker, no host fallback). Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree still go through host `WorkspaceFs`.

At `0a1176f`:

| Piece | Tree |
|---|---|
| Docker Bash / Grep / Glob | Same `TerminalBackend` instance. `kind === 'docker'` + image → `docker run --rm -i -v cwd:cwd -w cwd`, allowlist env. Missing image silently returns **local**. |
| `WorkspaceFs` | Host `node:fs` + cwd jail. `backend: 'local' \| 'docker'` is **ignored** (`workspace-fs.ts`: “reserved for a later exec port”). Sync API. |
| `workspaceFsFor(turn)` | Passes `turn.terminalBackend` kind only. Kind has **no image**. |
| Read | `workspaceFsFor` for `stat` / utf-8 `readFile` / `realpath`. **Host bypasses:** `peekHasNul` (`openSync`/`readSync`), image/office `readFileSync`, large-file `streamUtf8LineWindow`. |
| Write / Edit / ApplyPatch | `workspaceFsFor` mkdir/stat/read/write. `fileHistory.snapshot` is host `copyFileSync`. Lint after write is host. |
| ListDir / ReadSubtree | `workspaceFsFor` `stat`/`readdir`/`readFile`. ReadSubtree walks with **one host call per file**. |
| `createSessionEngine` | No `TerminalBackend` instance. `turn.terminalBackend` is kind only. |
| `createRootTools` | Already takes `backend?` and passes it to Grep/Glob factories. File tools are singletons. |
| `TerminalExecOpts` | `command`, `cwd`, `timeoutMs`, `signal`, `onOutput`. **No stdin.** `runSpawned` uses `stdio: ['ignore','pipe','pipe']`. `docker run` already has `-i`. |
| Tests named “docker” WorkspaceFs | Assert outside-cwd refuse. They never `docker run`. |
| `headless.md` | Grep/Glob docker-exec is honest; Read/Write stay the host jail. |

E2.1 asked for Read/Write/Edit/ApplyPatch/ListDir/Grep/Glob/ReadSubtree on the same mount. Grep/Glob unparked that later door. This horizon unparks the **WorkspaceFs exec port**: those remaining file tools use Bash’s container, not the operator process.

`dontAsk` is still not isolation. Docker is a backend, not a permission mode. Bind `-v cwd:cwd` means in-tree inodes match; this door is still required so a down daemon cannot silently write on the host, and so uid/env match Bash.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` stays the only non-`submitMessage` closer. File tools keep today’s leftover-allow / leftover-ask / `acceptEdits` promotion.
2. Default prefix stays small and frozen. No new always-on tool. Factories wrap existing tools.
3. `dontAsk` never becomes `bypass`.
4. BYOK. Ads never touch BYOK.
5. Clean-room. Steal eve’s *runtime vs sandbox* split and “secrets stay out of the container env.” No compiler, Workflow loop, credential brokering, Kata, web UI, Prisma Task, Socket.IO, wiki.
6. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent. Do not implement in this worktree as part of writing this spec.

---

## Do not build

- Web chat UI, Next.js BFF, Prisma Task, Socket.IO, wiki
- NotebookEdit docker port (sibling door; NotebookEdit keeps host `readFileSync` / `writeFileSync` this spec)
- Memory / TodoWrite / Skill / file-history **writers** in the container
- Sandbox network policy, `sandbox.stop()`, Kata, session-long container, `docker exec` into a kept container
- Binding host `rg` into the image; fail-open host `node:fs` when docker exec fails
- yaml `extraArgs` as a product surface (reuse whatever Bash already passes; do not add a new key)
- `Turn.terminalImage`, schema bump, putting a `TerminalBackend` instance on `createSessionEngine`
- Making `dontAsk` mean isolation
- AddDir extra roots as extra docker mounts
- LSP docker-exec, dismiss-on-message, Slack/ACP skip UI
- New default tool

Amend prior OUT **only** for WorkspaceFs docker I/O (Read / Write / Edit / ApplyPatch / ListDir / ReadSubtree).

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

1. **IN is the WorkspaceFs file tools only.** Read, Write, Edit, ApplyPatch, ListDir, ReadSubtree. Grep/Glob stay on their existing factory + `sandbox-search.ts` path (they may `await` a jail helper; they do not start using WorkspaceFs for search). NotebookEdit stays host this door.

2. **Same port object as Bash.** File-tool factories take the **same** `TerminalBackend` instance `createBashTool` / `createGrepTool` received. Do not reconstruct docker from `turn.terminalBackend` (kind has no image). If `createTerminalBackend('docker')` fell back to local (no image), file I/O stays local — same as Bash/Grep.

3. **Default exports stay local.** `readTool` / `writeTool` / `editTool` / `applyPatchTool` / `listDirTool` / `readSubtreeTool` keep today’s host `node:fs` so existing unit tests that import the singleton stay green. CLI `createRootTools` / SDK `defaultSessionTools` pass the live backend into the factories. Agent children already share parent tool instances.

4. **`createSessionEngine` still has no backend instance.** Eval injects already-constructed tools with a fake `runCommand`, same as `sandbox-search`. Do not copy `sandbox-cwd`’s kind-only `terminalBackend: 'docker'` pattern.

5. **Jail on the host, then exec.** Host `realpath` / `resolveExisting` under cwd still runs first. Outside-cwd → today’s `outside workspace` (surfaced as `Read failed:` / `Write failed:` / …) and **no** `backend.exec`. `realpath()` on `WorkspaceFs` stays **host** so `wasRead` / `readFileMtimes` / `fileHistory` keys stay host bind paths. In-tree paths are the same inodes as the cwd bind.

6. **One `backend.exec` per WorkspaceFs I/O method call** when the injected backend is docker. Reuse `dockerRunRequest` (`-v cwd:cwd -w cwd`, allowlist env, image, extraArgs). Do not use `backend.start`. Timeout 30s. `ctx.signal` via `backend.exec`. ReadSubtree walking N files is N execs (honest “N containers per call”); do not add a batch API this door.

7. **WorkspaceFs methods that touch content become async.** `readFile` / `writeFile` / `mkdir` / `unlink` / `stat` / `readdir` return `Promise<…>`. Host path wraps today’s sync `node:fs`. Callers already live in `async execute`. Export a **sync** jail helper (`assertInsideWorkspace` / host `realpath`). Grep/Glob **must** use that helper for the outside-cwd check (today’s sync `workspaceFsFor(ctx.turn).stat(searchRoot)` cannot stay if `stat` returns a Promise). They still do not search through WorkspaceFs.

8. **Byte I/O belongs on WorkspaceFs.** Add `readFileBuffer(path): Promise<Buffer>` (or `readFile` with a binary mode). Read’s host bypasses (`peekHasNul` `openSync`, image/office `readFileSync`, large-file `streamUtf8LineWindow`) **must** use WorkspaceFs when the injected backend is docker. Host local path may keep the stream optimization. Docker Read of a large file is one `cat` of the file (timeout 30s → fail-closed). Do not `openSync` the host path on the docker path.

9. **Stdin on the existing docker port.** `docker run` already passes `-i`. `runSpawned` currently ignores stdin. This door adds optional `stdin?: string | Uint8Array` on `TerminalExecOpts` and `TerminalRunRequest`, and wires `stdio: [pipe, pipe, pipe]` **only when stdin is present**. Local backend honors the same field. Grep/Glob omit stdin and stay `ignore`. Do not change docker argv beyond what Bash already uses. Do not mount docker.sock. The NotebookEdit docker spec uses this **same** field; if that sibling lands first with this shape, consume it and do not fork a second stdin API.

10. **Write payload goes through stdin, not argv.** `writeFile` docker path: `tee` / `cat > file` with `stdin` = contents. Do not embed file bytes in `bash -c` (ARG_MAX). `mkdir` is `mkdir -p`. `unlink` is `rm -f`. `stat` / `readdir` parse a small POSIX script that works on `bash:5` (BusyBox-safe: no GNU `stat -c` / `find -printf`). Fail-closed if parse fails.

11. **Fail-closed, split by cause.** Docker backend + in-tree path + `backend.exec` fails because there is no daemon, the image cannot run the script, or the 30s timeout fires → `Read failed:` / `Write failed:` / `Edit failed:` / `ApplyPatch failed:` / `ListDir failed:` / `ReadSubtree failed:` with **no** host `node:fs` fallback. Local backend never calls docker. **Turn abort is a different path:** if `ctx.signal` aborts, the tool **throws `AbortError`**. `phases.ts` already pairs that as `ABORTED_TEXT`. Do not stringify turn abort into `Read failed:`.

12. **ENOENT stays structured.** Host `stat` of a missing in-jail path returns `{ exists: false, … }` and does not throw. Docker `stat` of a missing file must do the same (script exit 0 + a missing marker), so Write’s “new file vs must-Read-first” law does not flip to `Write failed:` just because the container `stat` exited 1.

13. **Secrets.** Container env = `dockerAllowlistEnv()` only (`PATH`/`HOME`/`TERM`/`LANG`). Do not pass `ANTHROPIC_API_KEY` / MCP headers. Do not mount docker.sock.

14. **`fileHistory.snapshot` and lint stay host.** Snapshot runs on the jailed host bind path **before** docker `writeFile` (today’s order). Lint after write stays host. Same inodes as the bind. Do not docker-exec `cp` for undo backups.

15. **Hard-denied write paths stay host checks** (`isHardDeniedWritePath` / `resolveWritePath`) and run **before** jail exec. Protected paths never reach `backend.exec`.

16. **No live docker required to merge.** Fake `runCommand` like `terminal-backend.test.ts` / `sandbox-search`. Optional live `bash:5` test, skipped when daemon/image absent. Never fail-open in production because CI skipped.

17. **`dontAsk` unchanged.** Docker-exec is not a leftover-ask and not a permission promotion. Write/Edit still leftover-ask; `acceptEdits` still promotes in-tree Edit/Write/ApplyPatch the same way.

18. **Docs honesty.** `headless.md` / `ARCHITECTURE.md` / `.ko.md`: when Bash is actually docker (backend **and** image), Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree exec in that container; omit/local/image-less docker stays host jail. Do not claim NotebookEdit, Memory, or file-history writers are docker-exec.

---

## Theme

When `terminal.backend: docker` actually constructs a docker Bash backend, **the model’s filesystem tools use that port**. A down daemon fails closed. Outside-cwd still fails at the host jail with no exec.

---

## Per-slice board

Board as of `0bd239a` on `docs/workspacefs-docker`. W0–W2 done.

| ID | Status vs tree |
|---|---|
| W0.1 Stdin on `TerminalExecOpts` / `runSpawned` | **done** |
| W0.2 Async WorkspaceFs + sync jail helper + docker method scripts | **done** |
| W0.3 Factories + `createRootTools` / SDK wiring | **done** |
| W1.1 Read byte I/O through WorkspaceFs (close host bypasses) | **done** |
| W1.2 Write / Edit / ApplyPatch docker writeFile | **done** |
| W1.3 ListDir / ReadSubtree docker readdir/readFile | **done** |
| W2.1 Eval `sandbox-fs` | **done** |
| W2.2 Docs honesty | **done** |

---

## Wave W0 — Port

Goal: the chokepoint can exec; local behavior matches today.

### W0.1 Stdin

**Contract.** Optional `stdin` on exec opts. Present → pipe to the child. Absent → today’s `ignore`. Docker argv already has `-i`. Tests: fake `runCommand` receives stdin; Grep without stdin does not.

**Files.** `packages/core/src/tools/terminal-backend.ts`, `terminal-backend.test.ts`.

### W0.2 Async WorkspaceFs

**Contract.** Ruling 7–8, 10, 12. Replace the unused kind argument: `createWorkspaceFs({ cwd, exec?: TerminalBackend, signal?: AbortSignal })`. `exec?.kind === 'docker'` → docker methods. Omit / local-kind exec → host `node:fs` wrapped in Promises. Existing tests that passed `backend: 'docker'` as a kind string switch to omit `exec` (they are jail tests) or inject a fake docker backend. Sync jail helper exported; Grep/Glob must call it.

**Files.** `packages/core/src/tools/workspace-fs.ts`, `workspace-fs.test.ts`. Optional private helper `sandbox-fs.ts` for the POSIX scripts (not a Tool).

**Done when.** Fake docker backend: `readFile` argv contains `-v cwd:cwd`; host `readFileSync` is not used for the content; exec fail does not read the host file; missing file `stat` is `{ exists: false }`; outside-cwd throws with no exec; `ctx.signal` abort throws `AbortError`.

### W0.3 Factories

**Contract.** `createReadTool(backend?)` … `createReadSubtreeTool(backend?)`. Default singletons = omit backend. `createRootTools` / SDK pass the Bash backend. Export factories from `packages/core/src/index.ts`.

**Files.** the six tool modules, `packages/cli/src/engine.ts`, `packages/sdk/src/index.ts`, `packages/core/src/index.ts`.

---

## Wave W1 — Callers

### W1.1 Read

**Contract.** `await fs.stat` / `readFile` / `readFileBuffer` / `realpath`. Docker path must not `openSync` / host `readFileSync` / `streamUtf8LineWindow`. Local path may keep the stream optimization.

**Files.** `packages/core/src/tools/read.ts`, `read.test.ts`.

### W1.2 Write / Edit / ApplyPatch

**Contract.** Await WorkspaceFs. Snapshot then docker write. Hard-deny before exec. Stale/unread laws unchanged (mtime from `stat`, keys from host `realpath`).

**Files.** `write.ts`, `edit.ts`, `apply-patch.ts` + tests.

### W1.3 ListDir / ReadSubtree

**Contract.** Await `readdir` / `stat` / `readFile`. Caps unchanged (ReadSubtree max 80 files, 200_000 byte skip). N files → N `readFile` execs on docker.

**Files.** `list-dir.ts`, `read-subtree.ts` + tests.

---

## Wave W2 — Eval + docs

### W2.1 Eval beat

**Contract.** New fixture `sandbox-fs` under `packages/core/src/eval/fixtures/`. Inject `createReadTool(fake)` + `createWriteTool(fake)` (and optionally ListDir). In-tree unique file. Assert: fake `exec` ran; host `readFileSync` of that path is not how the tool obtained contents on the docker path; exec reject → `Read failed:` / `Write failed:` not a host write. Keep `sandbox-cwd` (Write jail) and `sandbox-search` unchanged. Copy helpers locally in `run.ts`. No live-docker eval in `runEvalDir`.

### W2.2 Docs

**Contract.** `docs/headless.md`, `ARCHITECTURE.md` / `.ko.md`. Historical E2.1 pointer: WorkspaceFs docker unparked by this spec; NotebookEdit docker still parked.

---

## File map

| Path | Wave |
|---|---|
| `packages/core/src/tools/terminal-backend.ts` | W0.1 |
| `packages/core/src/tools/workspace-fs.ts` | W0.2 |
| `packages/core/src/tools/sandbox-fs.ts` (optional) | W0.2 |
| `packages/core/src/tools/read.ts` | W0.3, W1.1 |
| `packages/core/src/tools/write.ts` | W0.3, W1.2 |
| `packages/core/src/tools/edit.ts` | W0.3, W1.2 |
| `packages/core/src/tools/apply-patch.ts` | W0.3, W1.2 |
| `packages/core/src/tools/list-dir.ts` | W0.3, W1.3 |
| `packages/core/src/tools/read-subtree.ts` | W0.3, W1.3 |
| `packages/cli/src/engine.ts` | W0.3 |
| `packages/sdk/src/index.ts` | W0.3 |
| `packages/core/src/index.ts` | W0.3 |
| `packages/core/src/eval/run.ts` + fixture | W2 |
| `docs/headless.md`, `ARCHITECTURE.md`, `ARCHITECTURE.ko.md` | W2 |

Grep/Glob must switch the outside-cwd check to the sync jail helper. Do not retarget `sandbox-search`.

Do not touch: `notebook-edit.ts`, `memory.ts`, `file-history.ts` writers, `loop/` except if a type import is required, schema, `worktree.ts`.

---

## Success checks

1. Docker Bash backend + fake `runCommand`: in-tree Read/Write invoke that backend; host `readFileSync`/`writeFileSync` are not the content path.
2. Outside-cwd Read/Write still fail closed without docker (host jail, no exec).
3. Docker exec failure (no daemon / timeout) returns `Read failed:` / `Write failed:` and does not write the host file. Turn abort throws `AbortError` and pairs `ABORTED_TEXT`.
4. Missing in-jail file: `stat.exists === false`; Write of a new file still works; overwrite still requires Read.
5. Image/office/NUL Read on the docker path does not `openSync` the host file.
6. `sandbox-cwd` and `sandbox-search` evals stay green. New `sandbox-fs` eval is green with a fake backend.
7. Local omit/local-kind file tools stay on host `node:fs`.
8. NotebookEdit still uses host `readFileSync` (sibling door).

---

## Out of this closeout

Web UI, Prisma Task, Socket.IO, wiki, Workflow loop, agent compiler, NotebookEdit docker, Memory in container, file-history docker, sandbox network policy, Kata, isolation-trust, `dontAsk` as isolation, yaml `extraArgs` as a new key, session-long container, dismiss-on-message, LSP museum.

---

## Hard rulings recap

1. Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree only; same `TerminalBackend` as Bash.
2. Host jail then one `docker run` per method; no host fallback. Turn abort → `AbortError` / `ABORTED_TEXT`.
3. Async content methods; sync jail helper for Grep/Glob. `realpath` stays host.
4. Optional exec `stdin` for writes; do not put bytes in argv.
5. Default singletons stay local. Engine has no backend instance. Eval injects factories.
6. Secrets stay out of the container. No new tool. No schema bump. NotebookEdit stays out.
