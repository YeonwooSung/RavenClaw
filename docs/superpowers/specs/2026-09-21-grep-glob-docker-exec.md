# RavenClaw next-horizon roadmap (Grep/Glob docker-exec)

Date: 2026-09-21  
Status: implemented  
Shipped sha: `a52eab1` on `main` (PR #16).  
Reviewed against tree at `dc45aec` (`origin/main`, waist closed).  
Successor to `2026-09-20-rewind-recovery-v11.md` (Status: implemented). Amends prior OUT for **Grep/Glob docker-exec** only. Does not reopen WorkspaceFs as a docker I/O port, NotebookEdit docker, sandbox network policy, `ignored`, or LSP depth.

Implementation plan: [2026-09-21-grep-glob-docker-exec.md](../plans/2026-09-21-grep-glob-docker-exec.md). Isolated worktree only.

Sources: current tree; [eve analysis](../../research/eve-analysis.md) sandbox split. Steal contracts. Do not copy eve, y0, Claude, Hermes, or Freebuff source. Do not become an agent framework. Do not become a hosted Task runner. Do not add a web UI.

---

## Where we are

The coding-agent waist is shipped through leftover-ask abort-pair, HTTP `POST …/clear`, and rewind recovery / schema v11 (`dc45aec`). `terminal.backend: docker` already exists for **Bash**. File search does not use that port.

At `dc45aec`:

| Piece | Tree |
|---|---|
| Docker Bash | `createDockerTerminalBackend` → `docker run --rm -v ${cwd}:${cwd} -w ${cwd}` + env allowlist `PATH/HOME/TERM/LANG` (`packages/core/src/tools/terminal-backend.ts`). Image required; missing image silently returns **local**. |
| `WorkspaceFs` | Host `node:fs` + cwd jail. `backend` is ignored (`workspace-fs.ts`: “reserved for a later exec port”). |
| Grep | `workspaceFsFor.stat(searchRoot)` then host `spawnSync('rg')` or host `walkFiles` + `readFileSync`. Full `process.env`. Process-global `hasRipgrep()`. |
| Glob | Same root `stat`, then host `walkFiles` (`readdirSync`/`statSync`). |
| ListDir / Read / ReadSubtree / Edit / Write / ApplyPatch | Per-path `workspaceFsFor` jail (host fs). Bind-identical with docker cwd for in-tree files. |
| NotebookEdit / Memory / TodoWrite / file-history | Host writers; skip WorkspaceFs (NotebookEdit has no cwd jail). |
| `turn.terminalBackend` | Kind only (`'local' \| 'docker'`). No image. Grep/Glob are singletons (`grepTool` / `globTool`); they cannot see Bash’s backend instance. |
| Tests named “docker” | Set `turn.terminalBackend = 'docker'` and assert outside-cwd refuse. They never `docker run`. |
| `headless.md` | Already labels the lie: Grep/Glob still run on the host. |

E2.1 (`2026-09-15-eve-inspired-roadmap.md`) asked for Read/Write/Edit/ApplyPatch/ListDir/Grep/Glob/ReadSubtree on the same mount. Session-as-job ruling 8 parked host writers that skip WorkspaceFs and named **Grep/Glob docker-exec** as a later door. This horizon unparks **that later door only**: Grep and Glob share Bash’s `TerminalBackend`.

`dontAsk` is still not isolation. Docker is a backend, not a permission mode.

---

## Constraints (unchanged except this hole)

1. One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` stays the only non-`submitMessage` closer for operator answers. Grep/Glob stay leftover-allow (`checkPermissions` `{ behavior: 'allow', reason: 'mode' }`).
2. Default prefix stays small and frozen. No new always-on tool. Factories wrap existing tools.
3. `dontAsk` never becomes `bypass`.
4. BYOK. Ads never touch BYOK.
5. Clean-room. Steal eve’s *runtime vs sandbox* split and “secrets stay out of the container env.” No compiler, Workflow loop, credential brokering, Kata, web UI, Prisma Task, Socket.IO, wiki.
6. Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent. Do not implement in this worktree as part of writing this spec.

---

## Do not build

- Web chat UI, Next.js BFF, Prisma Task, Socket.IO, wiki
- WorkspaceFs docker I/O (Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree `docker exec cat` / N containers per call)
- NotebookEdit docker port, Memory/TodoWrite/Skill/file-history in the container
- Sandbox network policy, `sandbox.stop()`, Kata, session-long container
- Binding host `rg` into the image; fail-open host `rg` when docker exec fails
- yaml `extraArgs`, `Turn.terminalImage`, schema bump
- Making `dontAsk` mean isolation
- `ignored` leftover-ask result, LSP depth, isolation-trust
- New default tool, `createGrepTool` as a second search product
- Fixing `worktree.ts` `runGit` env (sibling leftover of session-worktree; out of this slice)

Amend prior OUT **only** for Grep/Glob docker-exec.

---

## Binding rulings

These lock underspecification. The implementation plan may only add detail, not contradict.

1. **IN is Grep + Glob only.** Same hole (`walkFiles` / host `rg` after a root `stat`). `file-finder` (`Read`, `Grep`, `Glob`) stays mixed this door: Grep/Glob use Bash’s docker port; Read stays host WorkspaceFs jail (in-tree paths are the same inodes as the cwd bind). ListDir/ReadSubtree/Edit/Write stay host jail. Do not treat that mix as a reason to pull Read into this door.

2. **Same port object as Bash.** `createGrepTool(backend)` / `createGlobTool(backend)` take the **same** `TerminalBackend` instance `createBashTool` received. Do not reconstruct docker from `turn.terminalBackend` (kind has no image). If `createTerminalBackend('docker')` fell back to local (no image), search stays local — same as Bash.

3. **Default exports stay local.** `grepTool` / `globTool` keep today’s host `rg` / `walkFiles` so existing unit tests that import the singleton stay green. CLI `createRootTools` / SDK `defaultSessionTools` pass the live backend. Agent children already share parent tool instances.

4. **One `backend.exec` per Grep/Glob call** when the injected backend is docker. Reuse `dockerRunRequest` (`-v cwd:cwd -w cwd`, allowlist env, image, extraArgs). Do not use `backend.start` (no background Grep). Timeout 30s (today’s rg timeout). `ctx.signal` via `backend.exec`. `isConcurrencySafe() === true` stays (parallel Greps = parallel `docker run --rm`).

5. **Inside the container: POSIX walker, not “require `rg`”.** Default image is `bash:5` (has `find`/`grep`/`bash`, not `rg`). Optional: if `command -v rg` in the **image**, use it **inside** the container. Never fall back to host `rg` / `walkFiles` when the injected backend is docker.

6. **Local backend unchanged except env isolation.** Host `rg` + `walkFiles` stay the fast path. Caps stay: `WALK_MAX_FILES` 200, `WALK_MAX_DEPTH` 20, `WALK_MAX_BYTES` 10 MiB, `IN_MESSAGE_CAP` 20k, `DEFAULT_IGNORE_DIR_NAMES`, `capInMessage`. Output is never disk-persisted.

7. **Jail before exec.** `workspaceFsFor(ctx.turn).stat(searchRoot)` still runs first. Outside-cwd → `Grep failed: outside workspace` / `Glob failed: …` and **no** `backend.exec`.

8. **Fail-closed, split by cause.** Docker backend + in-tree root + `backend.exec` fails because there is no daemon, the image is missing `find`/`grep`, or the 30s timeout fires → `Grep failed:` / `Glob failed:` string. **No host fallback.** Local backend never calls docker. **Turn abort is a different path:** if `ctx.signal` aborts (Escape / `abort('cancel')`), `backend.exec` / the tool **throws `AbortError`**. `phases.ts` already pairs that as `ABORTED_TEXT` (Grep/Glob do not set `interruptBehavior: 'block'`). Do not stringify turn abort into `Grep failed:`.

9. **Secrets.** Container env = `dockerAllowlistEnv()` only (`PATH`/`HOME`/`TERM`/`LANG`). Do not pass `ANTHROPIC_API_KEY` / MCP headers. Do not mount docker.sock.

10. **Env isolation on every spawn this door touches.** Copy env, keep `PATH`, `GIT_TERMINAL_PROMPT=0`, delete `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`. Docker path already allowlists. Host `tryRipgrep` / `hasRipgrep` currently inherit full `process.env` — fix on the **local** path in this door (jobDiff flake class). Do not consult `ripgrepCached` on the docker path.

11. **Format on the host.** Walker contract inside the container must honor ignore dirs, caps, glob/include, NUL skip, cwd-relative paths. Parse/format with existing `formatHitLines` / `posixRel` / `capInMessage` so local and docker strings match.

12. **No live docker required to merge.** Fake `runCommand` like `terminal-backend.test.ts`. Optional live `bash:5` test, skipped when daemon/image absent. Never fail-open in production because CI skipped.

13. **Docs honesty.** `headless.md` sentence that Grep/Glob still run on the host becomes: when Bash is actually docker (backend+image), Grep/Glob exec in that container; local `rg`/walk otherwise. Do not claim Read/Write are docker-exec.

14. **`dontAsk` unchanged.** Docker-exec is not a leftover-ask and not a permission promotion.

---

## Theme

When `terminal.backend: docker` actually constructs a docker Bash backend, **file search uses that port**. The model’s Grep/Glob view of cwd is the container’s view of the bind, not the operator process with full `process.env`.

---

## Per-slice board

Board as of `a52eab1` on `main` (PR #16). S0–S2.2 done.

| ID | Status vs tree |
|---|---|
| S0.1 `createGrepTool` / `createGlobTool` + createRootTools/SDK wiring | **done** |
| S0.2 Local `rg` env isolation (`isolatedSpawnEnv`) | **done** |
| S1.1 Shared docker walker (`sandbox-search.ts`) | **done** |
| S1.2 Fail-closed + jail-first + abort split | **done** |
| S2.1 Eval `sandbox-search` | **done** |
| S2.2 Docs honesty | **done** |

---

## Wave S0 — Factories + local env isolation

Goal: wiring exists; local behavior matches today except git-env isolation.

### S0.1 `createGrepTool` / `createGlobTool`

**Contract.** Factories take `TerminalBackend`. Default singletons = local backend (or omit backend → host path). `createRootTools` / SDK `defaultSessionTools` pass the Bash backend. Export factories from `packages/core/src/index.ts`.

**Files.** `packages/core/src/tools/grep.ts`, `glob.ts`, `packages/cli/src/engine.ts`, `packages/sdk/src/index.ts`, `packages/core/src/index.ts`.

**Done when.** Existing Grep/Glob local tests stay green. `createRootTools` still lists `Grep`/`Glob`. SDK still includes them.

### S0.2 Local `rg` env isolation

**Contract.** Host `spawnSync('rg')` and `hasRipgrep()` copy `process.env`, keep `PATH`, set `GIT_TERMINAL_PROMPT=0`, delete `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`.

**Done when.** A test that sets those git vars still finds files under a unique cwd (jobDiff class).

---

## Wave S1 — Docker search

Goal: one container per call; fail-closed; no host fallback.

### S1.1 Shared docker walker (not a new tool)

**Contract.** Small helper (new `sandbox-search.ts` **or** private in `grep.ts` imported by `glob.ts`). Builds a POSIX script honoring ignore dirs + caps. `backend.exec` once. Host parses stdout into the same strings as local. Optional in-image `rg` if `command -v rg`.

**Files.** `packages/core/src/tools/grep.ts`, `glob.ts`, optional `sandbox-search.ts`. Do **not** edit `terminal-backend.ts` argv (reuse as-is). Do **not** edit `workspace-fs.ts`.

**Done when.** Fake docker backend tests: argv contains `-v cwd:cwd` and `-w cwd`; allowlist env; host `rg` is not spawned; exec fail (no daemon / missing `find`) does not call `walkFiles` and returns `Grep failed:` / `Glob failed:`; turn-abort (`ctx.signal`) throws `AbortError` (paired as `ABORTED_TEXT`, not `Grep failed:`).

### S1.2 Fail-closed + jail-first

**Contract.** Outside-cwd still fails at `workspaceFsFor.stat` with no exec. Exec fail → `Grep failed:` / `Glob failed:`. `createTerminalBackend('docker')` without image → search stays local.

**Done when.** Those three cases have tests. Current outside-cwd tests stay green.

---

## Wave S2 — Eval + docs

### S2.1 Eval beat

**Contract.** New fixture `sandbox-search` under `packages/core/src/eval/fixtures/`. `createSessionEngine` has no `TerminalBackend` instance — **do not** copy `sandbox-cwd`’s `terminalBackend: 'docker'` kind-only pattern, and **do not** Grep `/etc/passwd` (that fails at `workspaceFsFor.stat` and never execs). Construct `tools: [createGrepTool(fakeBackend), createGlobTool(fakeBackend)]` with a fake `runCommand` like `terminal-backend.test.ts`. Provider scripts Grep/Glob of an **in-tree** unique file. Assert: fake `exec` ran **once**; host `rg` / `walkFiles` did not run; the result is the fake stdout (or `Grep failed:` if the fake rejects) and not a host-walk listing. Keep `sandbox-cwd` (Write jail) unchanged. Copy helpers locally in `run.ts`. No live-docker eval in `runEvalDir`.

**Files.** `packages/core/src/eval/run.ts`, new fixture `case.json`.

### S2.2 Docs

**Contract.** `docs/headless.md`, `ARCHITECTURE.md` / `.ko.md` Grep/Glob rows. Historical E2.1 “missing” line gets a pointer: Grep/Glob unparked by this spec; WorkspaceFs docker-exec still parked.

**Done when.** Docs no longer say Grep/Glob always run on the host when docker Bash is on.

---

## File map

| Path | Wave |
|---|---|
| `packages/core/src/tools/grep.ts` | S0, S1 |
| `packages/core/src/tools/glob.ts` | S0, S1 |
| `packages/core/src/tools/sandbox-search.ts` (optional) | S1 |
| `packages/cli/src/engine.ts` | S0 |
| `packages/sdk/src/index.ts` | S0 |
| `packages/core/src/index.ts` | S0 |
| `packages/core/src/eval/run.ts` + fixture | S2 |
| `docs/headless.md`, `ARCHITECTURE.md`, `ARCHITECTURE.ko.md` | S2 |

Do not touch: `workspace-fs.ts`, `notebook-edit.ts`, `memory.ts`, `file-history.ts`, `read.ts`, `edit.ts`, `write.ts`, `list-dir.ts`, `loop/`, schema, `worktree.ts`.

---

## Success checks

1. Docker Bash backend + fake `runCommand`: Grep/Glob invoke that backend once on an **in-tree** path; host `rg` is not spawned.
2. Outside-cwd Grep still fails closed without docker (`workspaceFsFor.stat`, no exec).
3. Docker exec failure (no daemon / missing `find`) returns `Grep failed:` / `Glob failed:` and does not walk the host tree. Turn abort throws `AbortError` and pairs `ABORTED_TEXT`.
4. Local Grep still uses `rg`/walk; git-env isolation holds under parallel `bun test`.
5. `sandbox-cwd` eval stays green. New `sandbox-search` eval is green with a fake backend.
6. Read/Write/ListDir `terminalBackend = 'docker'` outside-cwd tests stay green (still host jail).

---

## Out of this closeout

Web UI, Prisma Task, Socket.IO, wiki, Workflow loop, agent compiler, `ignored`, LSP depth, WorkspaceFs docker-exec, NotebookEdit docker, Memory in container, sandbox network policy, Kata, isolation-trust, `dontAsk` as isolation, yaml `extraArgs`.

---

## Hard rulings recap

1. Grep + Glob only; same `TerminalBackend` as Bash.
2. One `docker run` per call; POSIX walker; no host fallback. Turn abort → `AbortError` / `ABORTED_TEXT`. Daemon/image/timeout → `Grep failed:` / `Glob failed:`.
3. Local `rg`/walk stays; isolate git env.
4. Jail `stat` before exec. Fail-closed. Eval injects `createGrepTool(fakeBackend)` on an in-tree path.
5. Secrets stay out of the container. No new tool. No schema bump.
