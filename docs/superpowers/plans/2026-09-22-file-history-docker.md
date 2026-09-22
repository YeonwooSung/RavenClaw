# File-history docker undo — Implementation Plan

I'm using the writing-plans skill to create the implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Bash is actually a docker `TerminalBackend` (kind + image) and FileHistory was injected with that same object, `/undo` and no-job `/rewind` restore and remove workspace files through that port (WorkspaceFs `writeFile` / `unlink`). Snapshot backups stay host copies under `$RAVENCLAW_HOME/file-history/<id>/`. Local omit stays today’s restore/remove, wrapped in `Promise`. Spec + this plan first; then TDD in this isolated worktree.

**Architecture:** `undo(): Promise<UndoResult>`. `createFileHistory(sessionId, home?, opts?: { backend?: TerminalBackend; cwd?: string })`. Omit / `backend.kind !== 'docker'` / image-less `createTerminalBackend('docker')` / docker without `cwd` → host undo (async wrapper of today’s `writeFileSync` / `unlinkSync`). `kind === 'docker'` + `cwd` → in-tree restore/remove via `createWorkspaceFs({ cwd, exec: backend })`; outside-cwd (`isInTreePath(cwd, path)` false, no extra roots) leftovers that row with **zero** exec and **no** host write. CLI `openEngine` and SDK `createRavenSession` construct **one** `TerminalBackend` and pass it to tools **and** `createFileHistory`. `createSessionEngine` keeps `opts.fileHistory ?? createFileHistory(session.id)` and still takes **no** backend instance.

**Tech Stack:** Bun, TypeScript, existing `FileHistory` / `createWorkspaceFs` / `isInTreePath` / `TerminalBackend` / `createDockerTerminalBackend`. Fake `runCommand` like `workspace-fs.test.ts`. No live docker required to merge.

**Spec:** `docs/superpowers/specs/2026-09-22-file-history-docker.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` stays the only non-`submitMessage` closer. `/undo` is not a fourth entry and does not start a model turn.
- Default prefix small and frozen. No new always-on tool.
- `dontAsk` never becomes `bypass`. Docker undo is not a leftover-ask and not a permission promotion.
- BYOK. Ads never touch BYOK.
- Clean-room. No vendor copy. **No web UI, no Next.js BFF, no Prisma Task, no Socket.IO, no wiki, no Memory docker, no TodoWrite/Skill docker, no snapshot docker-cp, no extra mounts, no `fileHistory` todo frames, no schema bump, no Slack/ACP skip UI, no LSP museum.**
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push. All commands below assume cwd is this worktree: `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/file-history-docker`.
- `createSessionEngine` stays the existing async factory and still takes **no** `TerminalBackend` instance. Inject FileHistory from the outside, the same way tools receive a backend. Do not add a `backend` field on `SessionEngineOptions` besides the existing optional `fileHistory` and the kind string `terminalBackend?: 'local' | 'docker'`.
- No schema version bump. No `bun.lock` / `bun.lockb` edit. Do not change `workspace-fs.ts` behavior. Do not edit `memory.ts` / `todo.ts`.
- Do not fail-open to host `writeFileSync` / `unlinkSync` on a workspace path when docker exec fails. Do not embed backup bytes in `bash -c`. Do not mount docker.sock. Secrets stay allowlist env only.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification only.

1. **IN is undo restore/remove of workspace files.** `snapshot` stays host `existsSync` / `copyFileSync` of the bind path into `$RAVENCLAW_HOME/file-history/<id>/` (WorkspaceFs ruling 14 stands for snapshot). `reset()` still drops RAM generations and does not delete backups. `beginTurn` / `endTurn` / `pendingCount` / `turnWriteCount` / `peekLast` stay **sync**.

2. **`undo()` becomes `Promise<UndoResult>`.** Local backend (no docker / omit / image-less constructor / docker missing `cwd`) wraps today’s sync body in an `async` function so every caller `await`s. `formatUndoNotice` / `formatRewindNotice` stay sync and unchanged.

3. **`createFileHistory(sessionId, home?, opts?: { backend?: TerminalBackend; cwd?: string })`.** Task 1 does **not** add `opts` (signature stays `(sessionId, home?)`). Task 2 adds `opts`. Omit / `backend.kind !== 'docker'` / `createTerminalBackend('docker')` without image (stamps `kind: 'local'`) → host undo. `kind === 'docker'` **requires** `cwd` (the bind). Missing cwd on docker → treat as local host undo (do not guess).

4. **Same port object as Bash, injected — not reconstructed.** CLI `finishOpenEngine` already builds `backend = createTerminalBackend(...)`. When `backend` is defined (it always is after that call), set `engineOpts.fileHistory = createFileHistory(session.id, opts.config.home, { backend, cwd: session.cwd })`. SDK lifts `createTerminalBackend` from `defaultSessionTools` into `createRavenSession` so tools and FileHistory share **one** backend object; inject `fileHistory` when constructing the engine. `createSessionEngine` keeps `opts.fileHistory ?? createFileHistory(session.id)` and still takes **no** backend instance. Agent children that share parent `fileHistory` inherit the injected instance (`fileHistoryOwnsTurn` unchanged).

5. **Jail on restore/remove.** Docker undo of a row whose `path` is outside `cwd` (`isInTreePath(cwd, path)` from `packages/core/src/permissions/modes.ts`, **no** `extraRoots`) → leftover that row, **no** exec, **no** host write. Check jail **before** `createWorkspaceFs` / `backend.exec`. Same as WorkspaceFs outside-cwd: the container must not be asked to write `/etc` or `$HOME`.

6. **One exec per restore or remove. Prefer WorkspaceFs.** In-tree docker undo constructs `createWorkspaceFs({ cwd, exec: backend })` once per `undo()` call. Restore existing file: `writeFile(path, readFileSync(backupPath, 'utf8'))` (this door’s tests are utf8; stdin is backup bytes via WorkspaceFs `tee --`, never embedded in `bash -c`). Remove created file: `unlink(path)` (WorkspaceFs `rm -f --`). Timeout is WorkspaceFs `FS_TIMEOUT_MS` (30s). Do not call `backend.start`. Do **not** edit `workspace-fs.ts`. Backup **read** stays host (`readFileSync(backupPath)`). Host undo keeps today’s `mkdirSync(dirname)` + Buffer `writeFileSync`.

7. **Fail-closed, split by cause.** No daemon / missing `tee`/`rm` / 30s timeout / non-zero exec / thrown exec → leftover that row, **no** host fallback write. Partial undo (some rows restored, some leftover) is today’s shape. `/undo` is not a tool: if `backend.exec` throws `AbortError`, leftover the row and do **not** host-write (do **not** rethrow). Turn abort during `/undo` is out of scope; slash dispatch still runs undo on the operator side. Persist-before-undo on no-job rewind stays: compact first, then undo. Docker undo fail after compact is the same class as today’s restore catch (transcript already dropped; leftover snapshots remain).

8. **No live docker required to merge.** Fake `runCommand`. Optional live `bash:5` skipped when daemon/image absent. Never fail-open in production because CI skipped. Fake success does **not** bind-write: after a docker undo that reports `restored` / `removed`, the host workspace bytes stay as they were **after** the turn write (`new\n` still on disk). If the implementation host-`writeFileSync`s / `unlinkSync`s, those tests fail.

9. **Secrets.** Allowlist env only. No docker.sock.

10. **Docs honesty last.** When Bash is actually docker and FileHistory was injected with that backend, `/undo` and no-job `/rewind` restore/remove workspace files in that container; snapshot backups stay under `$RAVENCLAW_HOME`. Omit/local stays host. Do not claim Memory or TodoWrite are docker-exec. Spec Status stays **draft** until Task 4 after code. Shipped sha stays empty in this worktree. No version bump.

11. **Worktree.** Implement in this worktree (`/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/file-history-docker`) or a later isolated worktree. Never on `main`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/session/file-history.ts` | Task 1: `undo(): Promise<UndoResult>`. Task 2: `opts` + docker restore/remove |
| `packages/core/src/session/file-history.test.ts` | Task 1: `await` every `undo()`. Task 2: docker fake `runCommand` describes |
| `packages/core/src/session/rewind.ts` | Task 1: `await opts.fileHistory.undo()` (line 71) |
| `packages/core/src/session/rewind.test.ts` | Task 1: keep green (no direct `undo()` calls) |
| `packages/cli/src/slash/dispatch.ts` | Task 1: `await` `/undo` then `formatUndoNotice` |
| `packages/cli/src/slash/dispatch.test.ts` | Task 1: `/undo` awaits |
| `packages/core/src/loop/session-engine.test.ts` | Task 1: `await engine.fileHistory.undo()` (~3056) |
| `packages/cli/src/engine.ts` | Task 3: inject `fileHistory` when `backend` is defined |
| `packages/cli/src/exec.test.ts` | Task 3: inject under `config.home`; no backend instance lock |
| `packages/sdk/src/index.ts` | Task 3: lift `createTerminalBackend`; inject `fileHistory` |
| `packages/sdk/src/index.test.ts` | Task 3: inject/identity |
| docs listed in Task 4 | honesty after code; spec Status → implemented **after code** |

Do not touch: `workspace-fs.ts` behavior, `memory.ts`, `todo.ts`, schema, `bun.lock` / `bun.lockb`, `createSessionEngine` options besides passing `fileHistory` from hosts.

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 F0 async undo, local wrap | `file-history.ts` (signature + async wrap; **no docker exec**, **no opts**), `file-history.test.ts` (await existing tests), `rewind.ts` (one `await`), `rewind.test.ts` (keep green), `slash/dispatch.ts`, `slash/dispatch.test.ts`, `session-engine.test.ts` (~3056) |
| 2 F1 docker restore/remove + jail | `file-history.ts` (`opts` + docker branch), `file-history.test.ts` (docker describe). Do **not** edit `workspace-fs.ts` |
| 3 F2 CLI/SDK inject + identity | `packages/cli/src/engine.ts`, `packages/cli/src/exec.test.ts`, `packages/sdk/src/index.ts`, `packages/sdk/src/index.test.ts`. Do **not** add a backend field on `createSessionEngine` |
| 4 F3 docs honesty | docs listed in Task 4, spec Status → implemented **after code**, workspacefs ruling 14 prose |

Task 1 first. Task 2 after 1. Task 3 after 2 (hosts pass `{ backend, cwd }`). Task 4 last, after code.

---

### Task 1: F0 `undo(): Promise<UndoResult>` (local wrap, no docker exec yet)

**Files:**
- Modify: `packages/core/src/session/file-history.ts` (`FileHistory.undo`, `createFileHistory` undo method)
- Modify: `packages/core/src/session/file-history.test.ts` (`await` every `history.undo()`)
- Modify: `packages/core/src/session/rewind.ts` (line 71)
- Modify: `packages/core/src/session/rewind.test.ts` (keep green; no direct `undo()` calls today)
- Modify: `packages/cli/src/slash/dispatch.ts` (`case 'undo'` ~142)
- Modify: `packages/cli/src/slash/dispatch.test.ts` (add `/undo` await)
- Modify: `packages/core/src/loop/session-engine.test.ts` (~3056)

**Interfaces:**
- Consumes: today’s sync restore/remove/blocked/leftover body
- Produces:
  ```ts
  export interface FileHistory {
    beginTurn(): void
    endTurn(): void
    snapshot(absPath: string): void
    undo(): Promise<UndoResult>
    pendingCount(): number
    peekLast?(): { open: boolean } | undefined
    turnWriteCount(): number
    reset(): void
  }
  ```
  `createFileHistory(sessionId, home?)` unchanged besides `async undo()`. Do **not** add `opts` / docker yet.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/session/file-history.test.ts`, make every test that calls `undo()` `async` and `await` it. Keep the assertions. Add one explicit Promise lock at the top of `describe('createFileHistory')` (keep every existing test):

```ts
  test('undo returns a Promise and still restores the last turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-async-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-async-cwd-'))
    const existing = join(cwd, 'a.txt')
    writeFileSync(existing, 'old\n')
    const history = createFileHistory('sess_async', home)
    history.beginTurn()
    history.snapshot(existing)
    writeFileSync(existing, 'new\n')
    history.endTurn()
    const pending = history.undo()
    expect(pending).toBeInstanceOf(Promise)
    const first = await pending
    expect(first.restored).toEqual([existing])
    expect(readFileSync(existing, 'utf8')).toBe('old\n')
  })
```

Change the existing calls:

- `const first = history.undo()` → `const first = await history.undo()`
- `const mid = history.undo()` → `await`
- `const blocked = history.undo()` → `await`
- `const after = history.undo()` → `await`
- `const failed = history.undo()` / `const retried = history.undo()` → `await`
- `const undone = history.undo()` → `await`
- `expect(history.undo()).toEqual(...)` → `expect(await history.undo()).toEqual(...)`

In `packages/core/src/session/rewind.ts` the test file does **not** call `undo()` directly. Leave `rewind.test.ts` assertions as they are.

In `packages/cli/src/slash/dispatch.test.ts` `describe('dispatchSharedSlash')`, add:

```ts
  test('/undo awaits fileHistory.undo and prints the notice', async () => {
    const session = makeSession()
    const engine = fakeEngine(session)
    let resolved = false
    engine.fileHistory.undo = async () => {
      await Promise.resolve()
      resolved = true
      return { restored: ['a.txt'], removed: [] }
    }
    const host = fakeHost(fakeRuntime(engine))
    const result = await dispatchSharedSlash(cmd('undo'), host)
    expect(result).toBe('handled')
    expect(resolved).toBe(true)
    expect(host.notices[0]).toBe('undo: restored 1')
  })
```

In `packages/core/src/loop/session-engine.test.ts` ~3056, change:

```ts
    expect(await engine.fileHistory.undo()).toEqual({ restored: [], removed: [] })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/session/file-history.test.ts ./packages/core/src/session/rewind.test.ts ./packages/cli/src/slash/dispatch.test.ts ./packages/core/src/loop/session-engine.test.ts`

Expected: FAIL — `undo()` is sync (`UndoResult`, not `Promise`); `toBeInstanceOf(Promise)` fails; `/undo` dispatch does not await (or typecheck fails once the signature flips). Existing restore/remove/blocked/leftover **behavior** must stay the same after Step 3.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/session/file-history.ts` — change the interface and wrap today’s body. Do **not** take a docker branch. Do **not** add `opts`:

```ts
export interface FileHistory {
  beginTurn(): void
  endTurn(): void
  snapshot(absPath: string): void
  undo(): Promise<UndoResult>
  pendingCount(): number
  peekLast?(): { open: boolean } | undefined
  turnWriteCount(): number
  reset(): void
}
```

```ts
    async undo() {
      const idx = lastUndoableIndex(generations)
      if (idx < 0) {
        const blocked = generations.some((gen) => gen.open && gen.rows.length > 0)
        return blocked ? { restored: [], removed: [], blocked: true } : { restored: [], removed: [] }
      }
      const generation = generations[idx]
      if (!generation) return { restored: [], removed: [] }
      const leftover: FileSnapshot[] = []
      const restored: string[] = []
      const removed: string[] = []
      for (let i = generation.rows.length - 1; i >= 0; i--) {
        const row = generation.rows[i]
        if (!row) continue
        if (!row.existed) {
          try {
            if (existsSync(row.path)) unlinkSync(row.path)
            removed.push(row.path)
          } catch {
            leftover.unshift(row)
          }
          continue
        }
        if (row.backupPath && existsSync(row.backupPath)) {
          try {
            mkdirSync(dirname(row.path), { recursive: true })
            writeFileSync(row.path, readFileSync(row.backupPath))
            restored.push(row.path)
          } catch {
            leftover.unshift(row)
          }
        } else {
          leftover.unshift(row)
        }
      }
      generation.rows = leftover
      if (leftover.length === 0) {
        generations.splice(idx, 1)
        if (current === generation) current = generations[generations.length - 1]
      }
      return { restored, removed }
    },
```

`packages/core/src/session/rewind.ts` line 71:

```ts
  const undo = await opts.fileHistory.undo()
```

`packages/cli/src/slash/dispatch.ts` `case 'undo'`:

```ts
    case 'undo':
      host.notice(formatUndoNotice(await runtime.engine.fileHistory.undo()))
      return 'handled'
```

Do not change `formatUndoNotice`. Do not change generation / `reset()` / `beginTurn` / `endTurn` semantics.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/session/file-history.test.ts ./packages/core/src/session/rewind.test.ts ./packages/cli/src/slash/dispatch.test.ts ./packages/core/src/loop/session-engine.test.ts`

Expected: PASS. Local restore/remove/blocked/leftover/reset notices unchanged. `rewindLastTurn` still persist-then-undo. `/undo` prints `undo: restored 1`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/file-history.ts \
  packages/core/src/session/file-history.test.ts \
  packages/core/src/session/rewind.ts \
  packages/core/src/session/rewind.test.ts \
  packages/cli/src/slash/dispatch.ts \
  packages/cli/src/slash/dispatch.test.ts \
  packages/core/src/loop/session-engine.test.ts
git commit -m "$(cat <<'EOF'
fix(core): make FileHistory.undo async

Local restore/remove stays the same body. Every caller awaits.
EOF
)"
```

---

### Task 2: F1 docker restore/remove + jail (no CLI/SDK inject yet)

**Files:**
- Modify: `packages/core/src/session/file-history.ts` (third `opts` arg; docker branch)
- Modify: `packages/core/src/session/file-history.test.ts` (docker describe)
- Do **not** modify `packages/core/src/tools/workspace-fs.ts`

**Interfaces:**
- Consumes: Task 1 async `undo`; `createWorkspaceFs`; `isInTreePath`; `createDockerTerminalBackend`
- Produces:
  ```ts
  export function createFileHistory(
    sessionId: string,
    home = ravenclawHome(),
    opts?: { backend?: TerminalBackend; cwd?: string },
  ): FileHistory
  ```
  Docker + cwd: in-tree restore/remove through WorkspaceFs on that backend. Snapshot still host.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/session/file-history.test.ts`, keep the existing `node:fs` import and add:

```ts
import {
  createDockerTerminalBackend,
  createTerminalBackend,
  type TerminalRunRequest,
} from '../tools/terminal-backend'
```

Add helpers next to the describe (or inside it):

```ts
function fakeDocker(
  runCommand: (req: TerminalRunRequest) => Promise<{
    stdout: string
    stderr: string
    exitCode: number
  }>,
) {
  return createDockerTerminalBackend({ image: 'bash:5', runCommand })
}
```

Keep every existing local test. Add:

```ts
describe('createFileHistory docker undo', () => {
  test('restore/remove go through exec and do not host-write workspace bytes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-dock-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-dock-cwd-'))
    const existing = join(cwd, 'a.txt')
    const created = join(cwd, 'b.txt')
    writeFileSync(existing, 'old\n')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const history = createFileHistory('sess_dock', home, { backend, cwd })
    history.beginTurn()
    history.snapshot(existing)
    writeFileSync(existing, 'new\n')
    history.snapshot(created)
    writeFileSync(created, 'fresh\n')
    history.endTurn()

    const first = await history.undo()
    expect(first.restored).toEqual([existing])
    expect(first.removed).toEqual([created])
    expect(readFileSync(existing, 'utf8')).toBe('new\n')
    expect(existsSync(created)).toBe(true)
    expect(calls.length).toBe(2)
    const tee = calls.find((req) => String(req.args.at(-1) ?? '').includes('tee'))
    const rm = calls.find((req) => String(req.args.at(-1) ?? '').includes('rm'))
    expect(tee).toBeDefined()
    expect(rm).toBeDefined()
    expect(String(tee?.stdin ?? '')).toBe('old\n')
    expect(String(tee?.args.at(-1) ?? '')).not.toContain('old\n')
    expect(tee?.timeoutMs).toBe(30_000)
    expect(rm?.timeoutMs).toBe(30_000)
    expect(calls.every((req) => req.command === 'docker')).toBe(true)
  })

  test('snapshot stays host copyFileSync with zero exec', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-snap-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-snap-cwd-'))
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'old\n')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const history = createFileHistory('sess_snap', home, { backend, cwd })
    history.beginTurn()
    history.snapshot(path)
    expect(existsSync(join(home, 'file-history', 'sess_snap', '0001'))).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('outside-cwd leftover with zero exec and no host write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-out-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-out-cwd-'))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'raven-fh-out-else-'))
    const outside = join(outsideRoot, 'secret.txt')
    writeFileSync(outside, 'old\n')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const history = createFileHistory('sess_out', home, { backend, cwd })
    history.beginTurn()
    history.snapshot(outside)
    writeFileSync(outside, 'new\n')
    history.endTurn()
    const first = await history.undo()
    expect(first.restored).toEqual([])
    expect(first.removed).toEqual([])
    expect(history.pendingCount()).toBe(1)
    expect(calls).toHaveLength(0)
    expect(readFileSync(outside, 'utf8')).toBe('new\n')
  })

  test('exec fail leftovers the row and does not host-write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-fail-dock-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-fail-dock-cwd-'))
    const path = join(cwd, 'keep.txt')
    writeFileSync(path, 'old\n')
    const backend = fakeDocker(async () => {
      throw new Error('Cannot connect to the Docker daemon')
    })
    const history = createFileHistory('sess_fail_dock', home, { backend, cwd })
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')
    history.endTurn()
    const failed = await history.undo()
    expect(failed.restored).toEqual([])
    expect(history.pendingCount()).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('new\n')
  })

  test('AbortError leftovers the row and does not host-write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-abort-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-abort-cwd-'))
    const path = join(cwd, 'keep.txt')
    writeFileSync(path, 'old\n')
    const backend = fakeDocker(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
    const history = createFileHistory('sess_abort', home, { backend, cwd })
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')
    history.endTurn()
    const failed = await history.undo()
    expect(failed.restored).toEqual([])
    expect(history.pendingCount()).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('new\n')
  })

  test('missing cwd on docker uses host undo', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-nocwd-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-nocwd-cwd-'))
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'old\n')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const history = createFileHistory('sess_nocwd', home, { backend })
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')
    history.endTurn()
    const first = await history.undo()
    expect(first.restored).toEqual([path])
    expect(readFileSync(path, 'utf8')).toBe('old\n')
    expect(calls).toHaveLength(0)
  })

  test('image-less docker constructor stays host undo', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-localish-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-localish-cwd-'))
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'old\n')
    const backend = createTerminalBackend('docker')
    expect(backend.kind).toBe('local')
    const history = createFileHistory('sess_localish', home, { backend, cwd })
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')
    history.endTurn()
    const first = await history.undo()
    expect(first.restored).toEqual([path])
    expect(readFileSync(path, 'utf8')).toBe('old\n')
  })
})
```

Do not add a live-docker test. Do not add CLI/SDK inject tests here (Task 3).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/session/file-history.test.ts`

Expected: FAIL — `createFileHistory` does not take `opts`; docker undo still host-writes (`a.txt` becomes `old\n` in the first docker test; outside-cwd currently restores on the host). Existing local tests stay green.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/session/file-history.ts` — add imports:

```ts
import { isInTreePath } from '../permissions/modes'
import { createWorkspaceFs } from '../tools/workspace-fs'
import type { TerminalBackend } from '../tools/terminal-backend'
```

Change the factory signature. Keep snapshot / beginTurn / endTurn / reset **sync** and host-only:

```ts
export function createFileHistory(
  sessionId: string,
  home = ravenclawHome(),
  opts?: { backend?: TerminalBackend; cwd?: string },
): FileHistory {
  const root = join(home, 'file-history', sessionId)
  const generations: Generation[] = []
  let current: Generation | undefined
  let seq = 0
  const docker =
    opts?.backend?.kind === 'docker' && typeof opts.cwd === 'string' && opts.cwd.length > 0
      ? { backend: opts.backend, cwd: opts.cwd }
      : undefined
```

Host undo body stays Task 1 (extract a local `undoHost(generation)` helper if that keeps `undo` readable). Docker branch, per row, **after** `lastUndoableIndex` (blocked/empty unchanged):

```ts
    async undo() {
      const idx = lastUndoableIndex(generations)
      if (idx < 0) {
        const blocked = generations.some((gen) => gen.open && gen.rows.length > 0)
        return blocked ? { restored: [], removed: [], blocked: true } : { restored: [], removed: [] }
      }
      const generation = generations[idx]
      if (!generation) return { restored: [], removed: [] }
      if (docker) return undoDocker(generation, idx, docker.backend, docker.cwd)
      return undoHost(generation, idx)
    },
```

Docker restore/remove (sketch; names are local):

```ts
  async function undoDocker(
    generation: Generation,
    idx: number,
    backend: TerminalBackend,
    cwd: string,
  ): Promise<UndoResult> {
    const leftover: FileSnapshot[] = []
    const restored: string[] = []
    const removed: string[] = []
    const fs = createWorkspaceFs({ cwd, exec: backend })
    for (let i = generation.rows.length - 1; i >= 0; i--) {
      const row = generation.rows[i]
      if (!row) continue
      if (!isInTreePath(cwd, row.path)) {
        leftover.unshift(row)
        continue
      }
      try {
        if (!row.existed) {
          await fs.unlink(row.path)
          removed.push(row.path)
          continue
        }
        if (row.backupPath && existsSync(row.backupPath)) {
          await fs.writeFile(row.path, readFileSync(row.backupPath, 'utf8'))
          restored.push(row.path)
        } else {
          leftover.unshift(row)
        }
      } catch {
        leftover.unshift(row)
      }
    }
    generation.rows = leftover
    if (leftover.length === 0) {
      generations.splice(idx, 1)
      if (current === generation) current = generations[generations.length - 1]
    }
    return { restored, removed }
  }
```

Locked behavior:

- Jail miss: leftover, **do not** call `fs.writeFile` / `fs.unlink` / `backend.exec`.
- Catch includes thrown `AbortError` from exec — leftover, **no** rethrow, **no** host write.
- Do not call `backend.start`.
- Do not `writeFileSync` / `unlinkSync` on `row.path` in the docker branch.
- `existsSync(row.backupPath)` / `readFileSync(row.backupPath)` stay host.
- `snapshot` unchanged (host `copyFileSync`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/session/file-history.test.ts`

Expected: PASS. Local omit path still host-writes. Docker fake success reports restored/removed **without** mutating host workspace bytes. Outside-cwd zero exec. Daemon throw leftovers. Missing cwd and image-less constructor host-undo.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/file-history.ts \
  packages/core/src/session/file-history.test.ts
git commit -m "$(cat <<'EOF'
feat(core): restore docker FileHistory undo through WorkspaceFs

In-tree restore/remove uses the injected TerminalBackend.
Outside-cwd leftovers with no exec. Snapshot stays host.
EOF
)"
```

---

### Task 3: F2 CLI/SDK inject FileHistory (same backend object)

**Files:**
- Modify: `packages/cli/src/engine.ts` (import `createFileHistory`; `finishOpenEngine` ~563–608)
- Modify: `packages/cli/src/exec.test.ts` (`describe('openEngine')`)
- Modify: `packages/sdk/src/index.ts` (`createRavenSession` + `defaultSessionTools`)
- Modify: `packages/sdk/src/index.test.ts`
- Do **not** modify `packages/core/src/loop/session-engine.ts` options besides hosts passing `fileHistory`
- Do **not** add `backend?: TerminalBackend` on `SessionEngineOptions`

**Interfaces:**
- Consumes: Task 2 `createFileHistory(sessionId, home, { backend, cwd })`; existing `createTerminalBackend` in CLI `finishOpenEngine` (~485) and SDK `defaultSessionTools` (~279–296)
- Produces: CLI `engineOpts.fileHistory` when `backend` is defined. SDK: one `backend` in `createRavenSession`, passed into `defaultSessionTools` **and** `createFileHistory`. `createSessionEngine` still `opts.fileHistory ?? createFileHistory(session.id)`.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/exec.test.ts`, add `existsSync` and `writeFileSync` to the `node:fs` import. In `describe('openEngine')`, add:

```ts
  test('injects fileHistory under config.home not ravenclawHome()', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-cli-home-'))
    const envHome = mkdtempSync(join(tmpdir(), 'raven-fh-cli-env-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-cli-cwd-'))
    tempDirs.push(home, envHome, cwd)
    const prev = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = envHome
    try {
      const { engine } = await openEngine({
        provider: createFakeProvider([]),
        store: createMemoryStore(),
        config: { ...testResolvedConfig(), home },
        cwd,
        async askUser() {
          return 'deny'
        },
      })
      const path = join(cwd, 'a.txt')
      writeFileSync(path, 'old\n')
      engine.fileHistory.beginTurn()
      engine.fileHistory.snapshot(path)
      engine.fileHistory.endTurn()
      expect(existsSync(join(home, 'file-history', engine.session.id, '0001'))).toBe(true)
      expect(existsSync(join(envHome, 'file-history', engine.session.id, '0001'))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = prev
    }
  })

  test('SessionEngineOptions still has no TerminalBackend instance field', () => {
    const types = readFileSync(join(import.meta.dir, '../../core/src/types.ts'), 'utf8')
    const start = types.indexOf('export interface SessionEngineOptions')
    const end = types.indexOf('export interface SessionEngine')
    const block = types.slice(start, end)
    expect(block).toContain('fileHistory?')
    expect(block).toContain("terminalBackend?: 'local' | 'docker'")
    expect(block).not.toMatch(/backend\?: TerminalBackend/)
  })
```

Add `readFileSync` to the `node:fs` import (exec.test.ts currently imports `mkdtempSync, rmSync` only).

In `packages/sdk/src/index.test.ts`, add `existsSync` and `writeFileSync` to the `node:fs` import. In `describe('createRavenSession')`, add:

```ts
  test('injects fileHistory under opts.home', async () => {
    const home = tempHome()
    const cwd = tempHome()
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const session = await createRavenSession({
      cwd,
      home,
      provider,
      store: 'memory',
      tools: [],
    })
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'old\n')
    session.engine.fileHistory.beginTurn()
    session.engine.fileHistory.snapshot(path)
    session.engine.fileHistory.endTurn()
    expect(existsSync(join(home, 'file-history', session.engine.session.id, '0001'))).toBe(true)
    await session.close()
  })

  test('lifts one TerminalBackend for tools and FileHistory', () => {
    const src = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')
    const start = src.indexOf('export async function createRavenSession')
    const rest = src.slice(start)
    const nextExport = rest.indexOf('\nexport ', 1)
    const body = nextExport === -1 ? rest : rest.slice(0, nextExport)
    expect(body).toContain('createTerminalBackend')
    expect(body).toContain('createFileHistory')
    expect(body).toContain('cwd: session.cwd')
    expect(body).toMatch(/fileHistory:\s*createFileHistory\(/)
    expect(body).toMatch(/createFileHistory\(session\.id, home, \{ backend, cwd: session\.cwd \}\)/)
  })
```

Today `createRavenSession` does **not** call `createTerminalBackend` (that lives in `defaultSessionTools`) and does **not** pass `fileHistory`. Both new tests fail.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts`

Expected: FAIL — CLI backups land under `RAVENCLAW_HOME` (`createFileHistory(session.id)` inside `createSessionEngine`); SDK same; SDK source lock misses `createFileHistory` / lifted `createTerminalBackend`. The `SessionEngineOptions` lock PASSES (keep it passing). Existing `createRootTools` identity tests stay green.

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/engine.ts` — add `createFileHistory` to the `@ravenclaw/core` import (next to `createSessionEngine`). In `finishOpenEngine`, after `backend` / `tools` are built and `engineOpts` is constructed (~563), when `backend` is defined:

```ts
  engineOpts.fileHistory = createFileHistory(session.id, opts.config.home, {
    backend,
    cwd: session.cwd,
  })
```

Do **not** pass `backend` into `createSessionEngine` as a new field. `terminalBackend: opts.config.terminal?.backend ?? 'local'` (the kind string) stays.

`packages/sdk/src/index.ts` — add `createFileHistory` to the `@ravenclaw/core` import. Lift backend construction out of `defaultSessionTools` into `createRavenSession`:

```ts
function defaultSessionTools(opts: {
  store: SessionStore
  provider: Provider
  config: ResolvedConfig
  compact: CompactPolicy
  system: SystemPart[]
  askUser: SessionEngineOptions['askUser']
  backend: TerminalBackend
}): Tool[] {
  const bash = createBashTool(opts.backend)
  return createSessionTools({
    store: opts.store,
    provider: opts.provider,
    compact: opts.compact,
    model: opts.config.profile,
    askUser: opts.askUser,
    childMaxRounds: opts.config.childMaxRounds,
    system: opts.system,
    bash,
    backend: opts.backend,
    network: (opts.config as { tools?: { network?: boolean } }).tools?.network === true,
  })
}
```

In `createRavenSession`, after `askUser` is chosen and **before** `engineOpts`:

```ts
  const terminal = config.terminal
  const backendOpts: { image?: string } = {}
  if (terminal?.image !== undefined) backendOpts.image = terminal.image
  const backend = createTerminalBackend(terminal?.backend ?? 'local', backendOpts)
  const tools = opts.tools ?? defaultSessionTools({ store, provider, config, compact, system, askUser, backend })

  const engineOpts: SessionEngineOptions = {
    session,
    provider,
    store,
    tools,
    compact,
    model: config.profile,
    maxRounds: config.maxRounds,
    askUser,
    system,
    instructionFiles: config.instructionFiles,
    fileHistory: createFileHistory(session.id, home, { backend, cwd: session.cwd }),
  }
```

Always lift/inject even when the caller passed `opts.tools` — FileHistory still shares the session backend object. Do not reconstruct a second `createTerminalBackend` inside `defaultSessionTools`.

`createSessionEngine` stays `opts.fileHistory ?? createFileHistory(session.id)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts ./packages/core/src/session/file-history.test.ts ./packages/core/src/session/rewind.test.ts ./packages/cli/src/slash/dispatch.test.ts ./packages/core/src/loop/session-engine.test.ts`

Expected: PASS. CLI/SDK backups land under the injected `home`. SDK source contains one lifted `createTerminalBackend` plus `createFileHistory(session.id, home, { backend, cwd: session.cwd })`. `SessionEngineOptions` still has no instance `backend?: TerminalBackend`. Local FileHistory tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/engine.ts \
  packages/cli/src/exec.test.ts \
  packages/sdk/src/index.ts \
  packages/sdk/src/index.test.ts
git commit -m "$(cat <<'EOF'
feat: inject FileHistory with the live TerminalBackend

CLI openEngine and SDK createRavenSession pass the same
backend object tools already use. createSessionEngine
still has no backend instance.
EOF
)"
```

---

### Task 4: F3 docs honesty (after code)

**Files:**
- Modify: `ARCHITECTURE.md` (openEngine bullet ~129; Rewind vs undo ~657–659; fileHistory row ~245)
- Modify: `ARCHITECTURE.ko.md` (Rewind vs undo ~565; docker sentence ~716; terminal-backend bullet ~732)
- Modify: `SLASH_COMMANDS.md` (`/undo` ~434–451)
- Modify: `SLASH_COMMANDS.ko.md` (`/undo` ~275–283)
- Modify: `docs/headless.md` (Optional Docker sandbox ~44–46)
- Modify: `docs/research/eve-analysis.md` (sandbox closer ~191)
- Modify: `docs/research/eve-analysis.ko.md` (closer ~118)
- Modify: `docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md` (E2.1 shipped pointer ~176)
- Modify: `docs/superpowers/specs/2026-09-21-workspacefs-docker.md` (ruling 14 ~100 **only**)
- Modify: `docs/superpowers/specs/2026-09-22-file-history-docker.md` (Status → implemented; board F0–F3 done; Shipped sha empty)
- Modify: `CHANGELOG.md` Unreleased ### Added (prepend)

Spec Status stays **draft until this task**. Do not mark it implemented in Tasks 1–3. No version bump. No `package.json` edit.

**Interfaces:**
- Consumes: shipped behavior from Tasks 1–3
- Produces: docs that name docker **undo restore/remove** without claiming snapshot docker-cp or Memory docker

- [ ] **Step 1: No new unit tests for docs**

Docs-only. Keep Task 1–3 tests green.

- [ ] **Step 2: Run tests**

Run: `bun test ./packages/core/src/session/file-history.test.ts ./packages/core/src/session/rewind.test.ts ./packages/cli/src/slash/dispatch.test.ts ./packages/core/src/loop/session-engine.test.ts ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts`

Expected: PASS.

- [ ] **Step 3: Point docs at the shipped behavior**

`docs/headless.md` Optional Docker sandbox paragraph: when Bash is actually docker (backend **and** image), allowed Bash, Grep/Glob, Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree, NotebookEdit bytes, **and `/undo` / no-job `/rewind` restore/remove** `docker run` in that container (`-v cwd:cwd -w cwd`). Snapshot backups stay host copies under `$RAVENCLAW_HOME/file-history/<id>/`. Omit, local, or `createTerminalBackend('docker')` without an image keeps FileHistory undo on the host. It is not a substitute for `dontAsk`. Do **not** claim Memory or TodoWrite are docker-exec.

`ARCHITECTURE.md`:
- openEngine bullet ~129: pass the same backend object to Bash, Grep/Glob, the six file-tool factories, NotebookEdit, **and** `createFileHistory(session.id, home, { backend, cwd: session.cwd })`. `createSessionEngine` still has no backend instance.
- fileHistory row ~245 / Rewind vs undo ~657: `/undo` and no-job `/rewind` restore/remove through that backend when kind+image; snapshot stays host `$RAVENCLAW_HOME/file-history/<id>/`. Fail-closed (leftover row, no host fallback write). Outside-cwd leftover with zero exec.

`ARCHITECTURE.ko.md`:
- Rewind vs undo ~565: docker(+image)이고 FileHistory가 그 백엔드로 inject되면 `/undo`와 no-job `/rewind`의 restore/remove는 컨테이너. 스냅샷 백업은 호스트 `$RAVENCLAW_HOME`.
- docker sentence ~716 / terminal-backend bullet ~732: Bash·Grep/Glob·파일 툴·NotebookEdit·**file-history undo restore/remove**가 같은 객체를 쓴다. snapshot은 호스트. Memory·TodoWrite는 호스트. `dontAsk` 대체가 아니다.

`SLASH_COMMANDS.md` `/undo` (~440–443): files that existed are copied back from `$RAVENCLAW_HOME/file-history/<sessionId>/` **on the host**; when Bash is actually docker and FileHistory was injected, restore/remove of **workspace** files runs in that container (`tee` / `rm`). Omit/local stays host `writeFileSync` / `unlinkSync`. Notices unchanged.

`SLASH_COMMANDS.ko.md` `/undo` (~275–283): 백업은 호스트 `~/.ravenclaw/file-history/<sessionId>/`. docker(+image)+inject면 워크스페이스 restore/remove는 컨테이너. omit/local은 호스트.

E2.1 shipped pointer ~176: append that file-history **undo restore/remove** is unparked by [`2026-09-22-file-history-docker.md`](2026-09-22-file-history-docker.md). Snapshot stays host. **Memory in container stays OUT.**

`docs/research/eve-analysis.md` / `.ko.md` closer: FileHistory undo restore/remove shares Bash’s docker port when kind+image and injected; snapshot backups stay host; Memory writers stay host.

WorkspaceFs spec ruling 14 (`docs/superpowers/specs/2026-09-21-workspacefs-docker.md` ~100). **Amend prose only** (do not reopen WorkspaceFs):

```
14. **`fileHistory.snapshot` and lint stay host.** Snapshot runs on the jailed host bind path **before** docker `writeFile` (today’s order). Lint after write stays host. Same inodes as the bind. Do not docker-exec `cp` for undo backups. Undo **restore/remove** of workspace files is [`2026-09-22-file-history-docker.md`](2026-09-22-file-history-docker.md).
```

`CHANGELOG.md` Unreleased ### Added, **prepend**:

```md
- FileHistory `/undo` (and no-job `/rewind`) restore/remove workspace files through Bash’s `TerminalBackend` when kind+image and the host injected `createFileHistory(session.id, home, { backend, cwd })`. Snapshot backups stay host copies under `$RAVENCLAW_HOME/file-history/<id>/`. Omit/local/`createTerminalBackend('docker')` without image, or docker without cwd, stays host undo. Outside-cwd leftovers with no exec. Fail-closed (no host fallback write). `createSessionEngine` still has no backend instance. Spec: [docs/superpowers/specs/2026-09-22-file-history-docker.md](docs/superpowers/specs/2026-09-22-file-history-docker.md). Plan: [docs/superpowers/plans/2026-09-22-file-history-docker.md](docs/superpowers/plans/2026-09-22-file-history-docker.md).
```

Do **not** edit the existing WorkspaceFs CHANGELOG line’s “Memory and file-history writers stay host” into a lie — that line described WorkspaceFs’s door. This new bullet is the amendment.

Spec `docs/superpowers/specs/2026-09-22-file-history-docker.md`: set Status to **implemented**, check board F0–F3 **done** vs this worktree, leave **Shipped sha:** empty. Do not reopen Memory docker, snapshot-as-docker-cp, extra mounts, or `fileHistory` todo frames.

- [ ] **Step 4: No further unit test for docs**

Docs-only besides the bun test in Step 2.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md ARCHITECTURE.ko.md \
  SLASH_COMMANDS.md SLASH_COMMANDS.ko.md \
  docs/headless.md CHANGELOG.md \
  docs/research/eve-analysis.md docs/research/eve-analysis.ko.md \
  docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md \
  docs/superpowers/specs/2026-09-21-workspacefs-docker.md \
  docs/superpowers/specs/2026-09-22-file-history-docker.md
git commit -m "$(cat <<'EOF'
docs: file-history docker undo honesty

Undo restore/remove shares the docker Bash port when injected.
Snapshot backups stay host. Memory writers stay host.
EOF
)"
```

---

## Success checks

1. Local `undo` still restores/removes the last closed generation; open generation still `blocked`.
2. Docker `undo` restore/remove goes through `backend.exec` (WorkspaceFs on that backend) and never host-writes the workspace path (fake success leaves `new\n` on disk).
3. Docker undo of an outside-cwd snapshot path leftovers the row with zero exec.
4. `rewindLastTurn` and `/undo` await and still format the same notices on the local path.
5. `createSessionEngine` still has no backend instance; CLI/SDK inject FileHistory when they have a backend (backups land under the injected `home`).

---

## Self-review

**Spec coverage:** F0 async undo + every caller awaits → Task 1. F1 docker restore/remove + jail + fail-closed + snapshot host + missing cwd host undo → Task 2. F2 CLI/SDK inject same backend object; `createSessionEngine` has no backend instance → Task 3. F3 docs + spec Status + workspacefs ruling 14 prose → Task 4 (after code).

**Placeholder scan:** none. Targeted bun commands start with `./`. Commits are HEREDOC. No TBD / “similar to Task N” / empty tests.

**Type consistency:** `undo(): Promise<UndoResult>`; `createFileHistory(sessionId, home?, opts?: { backend?: TerminalBackend; cwd?: string })` from Task 2; CLI/SDK pass `{ backend, cwd: session.cwd }`; `SessionEngineOptions` keeps `fileHistory?` and kind string `terminalBackend?: 'local' | 'docker'` only.

**Tensions resolved (underspec only):**
- WorkspaceFs `writeFile` is typed `string`: this door’s tests are utf8; stdin is backup text via `tee`, never `bash -c` bytes.
- Fake success does not bind-write: assert host workspace bytes stay `new\n` so a host fallback cannot hide.
- `/undo` AbortError leftovers (not a tool); do not rethrow.
- Docker missing cwd / image-less constructor → host undo (do not guess).
- SDK always lifts one backend even when `opts.tools` is passed, so FileHistory still shares that object.
- Spec Status / shipped sha empty until Task 4; no version bump; no `bun.lock`.
