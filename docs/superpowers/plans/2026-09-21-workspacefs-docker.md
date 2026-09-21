# WorkspaceFs docker I/O — Implementation Plan

I'm using the writing-plans skill to create the implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Bash is actually a docker `TerminalBackend` (kind + image), Read / Write / Edit / ApplyPatch / ListDir / ReadSubtree share that same port object: host cwd jail first, then exactly one `backend.exec` per WorkspaceFs method, no host `node:fs` fallback. Local omit/local-kind stays today’s host `node:fs` wrapped in Promises. Spec + this plan first; then TDD in this isolated worktree.

**Architecture:** `createWorkspaceFs({ cwd, exec?, signal? })` is the chokepoint. `exec?.kind === 'docker'` → POSIX scripts via `backend.exec` (stdin for writes). Omit / `kind !== 'docker'` → host `node:fs` Promises. File-tool factories `createReadTool(backend?)` … `createReadSubtreeTool(backend?)` call `createWorkspaceFs({ cwd: ctx.turn.cwd, exec: backend, signal: ctx.signal })` — they do **not** reconstruct docker from `turn.terminalBackend` (kind has no image). CLI `openEngine` and SDK `defaultSessionTools` already construct **one** `TerminalBackend` for Bash/Grep/Glob; pass that same object into the six factories. `createSessionEngine` still has no backend instance; eval injects already-constructed tools. Sync `assertInsideWorkspace` is the Grep/Glob jail (today’s `workspaceFsFor.stat` cannot stay once `stat` returns a Promise).

**Tech Stack:** Bun, TypeScript, existing `TerminalBackend` / `createDockerTerminalBackend` / `createWorkspaceFs` / `createRootTools`. Fake `runCommand` like `terminal-backend.test.ts` / `sandbox-search`. No live docker required to merge.

**Spec:** `docs/superpowers/specs/2026-09-21-workspacefs-docker.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers. File tools keep today’s leftover-allow / leftover-ask / `acceptEdits` promotion.
- Default prefix small and frozen. No new always-on tool. Factories wrap Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree.
- `dontAsk` never becomes `bypass`. Docker-exec is not a leftover-ask and not a permission promotion. `dontAsk` is not isolation.
- BYOK. Ads never touch BYOK.
- Clean-room. No vendor copy. **No web UI, no Next.js BFF, no Prisma Task, no Socket.IO, no wiki, no NotebookEdit docker, no Memory/file-history writers in the container, no `ignored`, no dismiss-on-message, no LSP museum, no sandbox network policy, no session-long container.**
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push. All commands below assume cwd is this worktree.
- `createSessionEngine` stays the existing async factory and still takes **no** `TerminalBackend` instance. Do not infer file I/O from the Bash Tool or from `turn.terminalBackend` (kind has no image).
- No schema version bump. Do not edit `notebook-edit.ts`, `memory.ts`, file-history writers, schema, `worktree.ts`, or `loop/` except a type import if required.
- Do not fail-open to host `node:fs` when docker exec fails. Do not embed write bytes in `bash -c` (ARG_MAX). Do not mount docker.sock. Secrets stay `dockerAllowlistEnv()` only.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification only.

1. **`createWorkspaceFs(opts: { cwd: string; exec?: TerminalBackend; signal?: AbortSignal }): WorkspaceFs`.** `exec?.kind === 'docker'` → docker methods. Omit or a backend whose `kind` is missing/`'local'` → host `node:fs` wrapped in Promises. Drop the unused `backend: 'local' | 'docker'` kind argument. Existing tests that passed `backend: 'docker'` as a kind string switch to omit `exec` (they are jail tests) or inject a fake docker backend.

2. **Content methods async.** `readFile` / `writeFile` / `mkdir` / `unlink` / `stat` / `readdir` return `Promise<…>`. Add `readFileBuffer(path): Promise<Buffer>`. `realpath(path): string` stays **sync host** so `wasRead` / `readFileMtimes` / `fileHistory` keys stay host bind paths. Host path wraps today’s sync `node:fs`.

3. **Export `assertInsideWorkspace(cwd: string, path: string): string`.** Host `realpath` / `resolveExisting` under cwd; throws `Error('outside workspace')`. Grep.ts and glob.ts **must** call this instead of `workspaceFsFor(ctx.turn).stat`. They still do not search through WorkspaceFs. Do not retarget `sandbox-search.ts`.

4. **Factories: `createReadTool(backend?: TerminalBackend)` … `createReadSubtreeTool(backend?: TerminalBackend)`.** Omit → today’s host singletons (`readTool = createReadTool()`, …). CLI and SDK `createRootTools` already take `backend?`; when defined, pass that same object into the six factories; when omitted, keep the singletons (existing `createRootTools(store)` tests stay identity-stable).

5. **File tools call `createWorkspaceFs({ cwd: ctx.turn.cwd, exec: backend, signal: ctx.signal })`.** Do not reconstruct from `turn.terminalBackend`. `workspaceFsFor(turn)` becomes host-only (`createWorkspaceFs({ cwd: turn.cwd })`) and ignores any leftover kind field.

6. **`stdin?: string | Uint8Array` on `TerminalExecOpts` AND `TerminalRunRequest`.** `runSpawned` uses `stdio: ['pipe','pipe','pipe']` only when stdin is present; absent → today’s `ignore`. Docker argv already has `-i`; do not change argv. Local backend honors the same field. Grep/Glob omit stdin. If a sibling already landed this shape, consume it and do not fork a second stdin API. Write payload goes through stdin (`tee`), never `bash -c` bytes.

7. **One `backend.exec` per WorkspaceFs method.** Timeout 30s (`FS_TIMEOUT_MS`). Fail-closed: method throws; tools surface `Read failed:` / `Write failed:` / `Edit failed:` / `ApplyPatch failed:` / `ListDir failed:` / `ReadSubtree failed:` with **no** host fallback. Turn abort (`ctx.signal` / `AbortError` from `backend.exec`) **throws `AbortError`** — tools must rethrow it, not stringify into `Read failed:`. `phases.ts` already pairs `ABORTED_TEXT`. ENOENT docker `stat` returns `{ exists: false, isFile: false, isDir: false, mtimeMs: 0, size: 0 }` via exit 0 + missing marker. BusyBox-safe scripts (no GNU `stat -c` / `find -printf`). `readFileBuffer` docker path is `base64` + `Buffer.from(stdout, 'base64')` because `TerminalExecResult.stdout` is a utf-8 string — do not `cat` binary into that string.

8. **Host jail then exec.** `assertInsideWorkspace` / jailed `realpath` runs first. Outside-cwd and `isHardDeniedWritePath` / `resolveWritePath` run **before** exec and never call `backend.exec`. `fileHistory.snapshot` and lint stay host (same inodes as the cwd bind). Docker Read must not `openSync` / host `readFileSync` / `streamUtf8LineWindow`. Local Read may keep the stream optimization after `STREAM_AFTER`. Docker large-file Read is one `cat` (timeout 30s → fail-closed).

9. **Eval `sandbox-fs` sibling of `sandbox-search`.** `tools: [createReadTool(fake), createWriteTool(fake)]` where `fake` is `createDockerTerminalBackend({ image: 'bash:5', runCommand })` — not a raw `{ exec }` and not `createSessionEngine({ terminalBackend: 'docker' })`. In-tree unique file (jail realpath must succeed). Assert fake exec ran and the tool result is fake stdout, not a host `readFileSync` of the unique token. Exec reject → `Read failed:` / `Write failed:`, not a host write. Keep `sandbox-cwd` and `sandbox-search`. Copy helpers locally in `run.ts`. No live-docker eval. `createSessionEngine` has no backend instance.

10. **Do not edit** `notebook-edit.ts`, `memory.ts`, file-history writers, schema, `worktree.ts`, or `loop/` except a type import if required. Implement in this worktree (`/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/workspacefs-docker`). Never on `main`.

11. **Quiet docs last.** Spec Status stays **draft** until Task 7 after code. Do not mark implemented in Tasks 1–6.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/tools/terminal-backend.ts` | optional `stdin` on exec opts + run request; `runSpawned` pipes only when present; **argv unchanged** |
| `packages/core/src/tools/terminal-backend.test.ts` | stdin present → child/fake receives it; absent → `undefined` / ignore |
| `packages/core/src/tools/grep.test.ts` | Grep docker path omits stdin (Task 1) |
| `packages/core/src/tools/workspace-fs.ts` | async methods, `readFileBuffer`, `assertInsideWorkspace`, docker vs host branch |
| `packages/core/src/tools/sandbox-fs.ts` | POSIX scripts + one `backend.exec` (Task 2; not a Tool; not on the barrel) |
| `packages/core/src/tools/workspace-fs.test.ts` | jail tests omit `exec`; docker fake `runCommand` describes |
| `packages/core/src/tools/grep.ts` / `glob.ts` | jail via `assertInsideWorkspace` |
| `packages/core/src/tools/read.ts` | `createReadTool`; await fs; close host bypasses on docker (Task 4) |
| `packages/core/src/tools/write.ts` | `createWriteTool`; await fs; hard-deny before exec |
| `packages/core/src/tools/edit.ts` | `createEditTool`; snapshot then docker write |
| `packages/core/src/tools/apply-patch.ts` | `createApplyPatchTool`; async `applyOne` |
| `packages/core/src/tools/list-dir.ts` | `createListDirTool`; await `readdir` |
| `packages/core/src/tools/read-subtree.ts` | `createReadSubtreeTool`; async walk; N files → N `readFile` execs |
| matching `*.test.ts` | factory + docker fake `runCommand` |
| `packages/core/src/index.ts` | export the six factories + `assertInsideWorkspace` |
| `packages/cli/src/engine.ts` | `createRootTools` passes `backend` into the six factories |
| `packages/cli/src/exec.test.ts` | singleton vs factory identity |
| `packages/sdk/src/index.ts` / `index.test.ts` | same wiring |
| `packages/core/src/eval/run.ts` | `runSandboxFs`; keep `runSandboxCwd` / `runSandboxSearch` |
| `packages/core/src/eval/fixtures/sandbox-fs/case.json` | new fixture |
| docs listed in Task 7 | honesty after code; spec Status → implemented **after code** |

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 W0.1 stdin | `terminal-backend.ts`, `terminal-backend.test.ts`, `grep.test.ts` (stdin-absent assertion only) |
| 2 W0.2 async WorkspaceFs + jail helper + docker scripts | `workspace-fs.ts`, `sandbox-fs.ts` (new), `workspace-fs.test.ts`, `grep.ts` / `glob.ts` (jail only), mechanical `await` in the six tool modules so the package typechecks (**no** factories, **no** host-bypass closure) |
| 3 W0.3 six factories + CLI/SDK wiring + core index | the six tool modules (factory wrap), `packages/core/src/index.ts`, `packages/cli/src/engine.ts`, `packages/cli/src/exec.test.ts`, `packages/sdk/src/index.ts`, `packages/sdk/src/index.test.ts` |
| 4 W1.1 Read callers close host bypasses | `read.ts`, `read.test.ts` |
| 5 W1.2 Write / Edit / ApplyPatch | `write.ts`, `edit.ts`, `apply-patch.ts` + their tests |
| 6 W1.3 ListDir / ReadSubtree | `list-dir.ts`, `read-subtree.ts` + their tests |
| 7 W2 eval `sandbox-fs` + docs | `eval/run.ts`, `eval/fixtures/sandbox-fs/case.json`, docs listed in Task 7, spec Status → implemented **after code** |

Task 1 first (stdin exists; WorkspaceFs still host+sync). Task 2 after 1 (async chokepoint + scripts). Task 3 after 2 (factories pass `exec`). Task 4–6 after 3 (callers). Task 7 last, after code.

---

### Task 1: W0.1 stdin on TerminalExecOpts / runSpawned

**Files:**
- Modify: `packages/core/src/tools/terminal-backend.ts` (`TerminalExecOpts` ~3, `TerminalRunRequest` ~29, `runSpawned` stdio ~288, `dockerRunRequest` / `execLocal` / `startLocal` pass-through)
- Modify: `packages/core/src/tools/terminal-backend.test.ts` (local + docker-fake describes)
- Modify: `packages/core/src/tools/grep.test.ts` (`describe('Grep docker backend')` — stdin-absent only)

**Interfaces:**
- Consumes: existing `spawn` stdio, `docker run` already `-i`, fake `runCommand: (req) => …`
- Produces: `stdin?: string | Uint8Array` on `TerminalExecOpts` and `TerminalRunRequest`; pipe only when present

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/tools/terminal-backend.test.ts`, add to `describe('createLocalTerminalBackend')`:

```ts
test('pipes stdin when present', async () => {
  const root = fixtureRoot()
  const backend = createLocalTerminalBackend()
  const result = await backend.exec({
    command: 'cat',
    cwd: root,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    stdin: 'hello-stdin\n',
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('hello-stdin')
})

test('omitting stdin leaves cat hanging-free empty', async () => {
  const root = fixtureRoot()
  const backend = createLocalTerminalBackend()
  const result = await backend.exec({
    command: 'echo ok',
    cwd: root,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('ok')
})
```

In the existing docker `runCommand` describe (next to kind/argv tests; do not weaken argv tests):

```ts
test('forwards stdin on the run request and keeps -i', async () => {
  const root = fixtureRoot()
  let seen: TerminalRunRequest | undefined
  const backend = createDockerTerminalBackend({
    image: 'bash:5',
    runCommand: async (req) => {
      seen = req
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  })
  await backend.exec({
    command: 'tee /dev/null',
    cwd: root,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    stdin: 'payload-bytes',
  })
  expect(seen?.stdin).toBe('payload-bytes')
  expect(seen?.args).toContain('-i')
  expect(seen?.command).toBe('docker')
})

test('omits stdin on the run request when not provided', async () => {
  const root = fixtureRoot()
  let seen: TerminalRunRequest | undefined
  const backend = createDockerTerminalBackend({
    image: 'bash:5',
    runCommand: async (req) => {
      seen = req
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  })
  await backend.exec({
    command: 'echo hi',
    cwd: root,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  })
  expect(seen?.stdin).toBeUndefined()
  expect(seen?.args).toContain('-i')
})
```

In `packages/core/src/tools/grep.test.ts` `describe('Grep docker backend')`, add (keep every existing test):

```ts
test('does not pass stdin on the docker run request', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'hit.ts'), 'const STDIN_GREP_TOKEN = 1\n')
  const calls: TerminalRunRequest[] = []
  const backend = fakeDocker(async (req) => {
    calls.push(req)
    return { stdout: 'FAKE_DOCKER_GREP:1:from-container\n', stderr: '', exitCode: 0 }
  })
  await createGrepTool(backend).execute({ pattern: 'STDIN_GREP_TOKEN' }, makeCtx(root))
  expect(calls).toHaveLength(1)
  expect(calls[0]?.stdin).toBeUndefined()
})
```

Do not add a WorkspaceFs write test here (Task 2).

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/tools/terminal-backend.test.ts ./packages/core/src/tools/grep.test.ts
```

Expected: FAIL — `stdin` is not on the type / not forwarded; local `cat` with stdin does not echo; Grep assertion may pass vacuously if `stdin` is always `undefined` — the local/docker-fake tests must fail first.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/tools/terminal-backend.ts` — add optional stdin, **do not touch `docker run` argv** (keep `'run', '--rm', '-i'`):

```ts
export interface TerminalExecOpts {
  command: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  onOutput?: (text: string) => void
  stdin?: string | Uint8Array
}

export interface TerminalRunRequest {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal: AbortSignal
  onOutput?: (text: string) => void
  stdin?: string | Uint8Array
}
```

Pass `stdin` through `dockerRunRequest`, `execLocal` / `startLocal` `runSpawned` calls:

```ts
  return {
    command: 'docker',
    args,
    cwd: opts.cwd,
    env: dockerAllowlistEnv(),
    timeoutMs,
    signal: opts.signal,
    onOutput: opts.onOutput,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  }
```

`runSpawned` stdio + write:

```ts
    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: req.env,
      stdio: [req.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    if (req.stdin !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(typeof req.stdin === 'string' ? req.stdin : Buffer.from(req.stdin))
    }
```

Do not change wrap/marker, allowlist env, or `kind`. Grep/Glob stay `ignore` because they omit the field.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/tools/terminal-backend.test.ts ./packages/core/src/tools/grep.test.ts
```

Expected: PASS. Existing cwd-marker / kind / docker-argv tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/terminal-backend.ts \
  packages/core/src/tools/terminal-backend.test.ts \
  packages/core/src/tools/grep.test.ts
git commit -m "$(cat <<'EOF'
feat: pipe optional stdin through TerminalBackend exec

Present stdin uses stdio pipe; absent stays ignore.
Docker argv already has -i and is unchanged. Grep omits
stdin.
EOF
)"
```

---

### Task 2: W0.2 async WorkspaceFs + assertInsideWorkspace + docker scripts

**Files:**
- Create: `packages/core/src/tools/sandbox-fs.ts`
- Modify: `packages/core/src/tools/workspace-fs.ts`
- Modify: `packages/core/src/tools/workspace-fs.test.ts`
- Modify: `packages/core/src/tools/grep.ts` (jail only: `assertInsideWorkspace` instead of `workspaceFsFor.stat`)
- Modify: `packages/core/src/tools/glob.ts` (same)
- Modify (mechanical `await` only so the package typechecks): `read.ts`, `write.ts`, `edit.ts`, `apply-patch.ts`, `list-dir.ts`, `read-subtree.ts` — **no** `createXTool`, **no** closing Read `openSync` / `readFileSync` / `streamUtf8LineWindow`

**Interfaces:**
- Consumes: `TerminalBackend`, `resolveExisting`, Task 1 `stdin`
- Produces: async `WorkspaceFs`, `readFileBuffer`, `assertInsideWorkspace`, `workspaceFsFor` host-only, POSIX scripts in `sandbox-fs.ts` (not a Tool; not exported from `packages/core/src/index.ts`)

- [ ] **Step 1: Write the failing tests**

Rewrite `packages/core/src/tools/workspace-fs.test.ts` jail cases: drop `backend: 'local' | 'docker'` kind; omit `exec`; **await** content methods.

```ts
test('rejects path outside cwd without exec', async () => {
  const cwd = fixtureRoot()
  const calls: unknown[] = []
  const fs = createWorkspaceFs({ cwd })
  await expect(fs.readFile('/etc/passwd')).rejects.toThrow(/outside workspace/)
  expect(calls).toHaveLength(0)
})

test('local workspace fs reads host file under cwd', async () => {
  const cwd = fixtureRoot()
  writeFileSync(join(cwd, 'a.txt'), 'hi')
  expect(await createWorkspaceFs({ cwd }).readFile(join(cwd, 'a.txt'))).toBe('hi')
})
```

Keep the chmod rethrow, symlink-outside, relative-parent, mkdir/stat/readdir/unlink/realpath cases — all awaited except **sync** `realpath`.

Add `describe('assertInsideWorkspace')`:

```ts
import { assertInsideWorkspace, createWorkspaceFs } from './workspace-fs'

test('throws outside workspace and returns a jailed host path', () => {
  const cwd = fixtureRoot()
  writeFileSync(join(cwd, 'in.txt'), 'x')
  expect(assertInsideWorkspace(cwd, join(cwd, 'in.txt'))).toContain(cwd)
  expect(() => assertInsideWorkspace(cwd, '/etc/passwd')).toThrow(/outside workspace/)
})
```

Add `describe('createWorkspaceFs docker exec')` with a local fake (copy the Grep `fakeDocker` helper; do not import from `terminal-backend.test.ts`):

```ts
import {
  createDockerTerminalBackend,
  type TerminalRunRequest,
} from './terminal-backend'

function fakeDocker(runCommand: (req: TerminalRunRequest) => Promise<{
  stdout: string
  stderr: string
  exitCode: number
}>) {
  return createDockerTerminalBackend({ image: 'bash:5', runCommand })
}

test('readFile argv contains cwd bind and does not host-read content', async () => {
  const cwd = fixtureRoot()
  writeFileSync(join(cwd, 'a.txt'), 'HOST_ONLY_TOKEN')
  const calls: TerminalRunRequest[] = []
  const exec = fakeDocker(async (req) => {
    calls.push(req)
    return { stdout: 'FROM_CONTAINER', stderr: '', exitCode: 0 }
  })
  const fs = createWorkspaceFs({
    cwd,
    exec,
    signal: new AbortController().signal,
  })
  const text = await fs.readFile(join(cwd, 'a.txt'))
  expect(text).toBe('FROM_CONTAINER')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.command).toBe('docker')
  expect(calls[0]?.args).toContain(`${cwd}:${cwd}`)
  expect(calls[0]?.args).toContain('-w')
  expect(calls[0]?.timeoutMs).toBe(30_000)
  expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM'])
})

test('writeFile sends bytes on stdin via tee and not in bash -c', async () => {
  const cwd = fixtureRoot()
  const payload = 'WRITE_PAYLOAD_' + 'x'.repeat(64)
  const calls: TerminalRunRequest[] = []
  const exec = fakeDocker(async (req) => {
    calls.push(req)
    return { stdout: '', stderr: '', exitCode: 0 }
  })
  const fs = createWorkspaceFs({ cwd, exec, signal: new AbortController().signal })
  await fs.writeFile(join(cwd, 'out.txt'), payload)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.stdin).toBe(payload)
  expect(calls[0]?.args.at(-1)).toMatch(/tee/)
  expect(calls[0]?.args.at(-1)).not.toContain(payload)
})

test('exec fail does not read or write the host file', async () => {
  const cwd = fixtureRoot()
  const path = join(cwd, 'a.txt')
  writeFileSync(path, 'HOST_ONLY_TOKEN')
  const exec = fakeDocker(async () => {
    throw new Error('Cannot connect to the Docker daemon')
  })
  const fs = createWorkspaceFs({ cwd, exec, signal: new AbortController().signal })
  await expect(fs.readFile(path)).rejects.toThrow(/Docker daemon|Read failed|failed/)
  expect(readFileSync(path, 'utf8')).toBe('HOST_ONLY_TOKEN')
  await expect(fs.writeFile(path, 'NEW')).rejects.toThrow()
  expect(readFileSync(path, 'utf8')).toBe('HOST_ONLY_TOKEN')
})

test('missing file stat is exists false via missing marker', async () => {
  const cwd = fixtureRoot()
  const exec = fakeDocker(async () => ({
    stdout: '__RC_FS_MISSING__\n',
    stderr: '',
    exitCode: 0,
  }))
  const fs = createWorkspaceFs({ cwd, exec, signal: new AbortController().signal })
  const st = await fs.stat(join(cwd, 'missing.txt'))
  expect(st).toEqual({ exists: false, isFile: false, isDir: false, mtimeMs: 0, size: 0 })
})

test('outside-cwd throws with no exec', async () => {
  const cwd = fixtureRoot()
  const calls: TerminalRunRequest[] = []
  const exec = fakeDocker(async (req) => {
    calls.push(req)
    return { stdout: '', stderr: '', exitCode: 0 }
  })
  const fs = createWorkspaceFs({ cwd, exec, signal: new AbortController().signal })
  await expect(fs.readFile('/etc/passwd')).rejects.toThrow(/outside workspace/)
  expect(calls).toHaveLength(0)
})

test('aborted signal throws AbortError', async () => {
  const cwd = fixtureRoot()
  writeFileSync(join(cwd, 'a.txt'), 'x')
  const ac = new AbortController()
  ac.abort()
  const exec = fakeDocker(async () => ({ stdout: 'nope', stderr: '', exitCode: 0 }))
  const fs = createWorkspaceFs({ cwd, exec, signal: ac.signal })
  await expect(fs.readFile(join(cwd, 'a.txt'))).rejects.toMatchObject({ name: 'AbortError' })
})
```

Existing Grep/Glob outside-cwd tests must keep passing after the jail switch (same `Grep failed: outside workspace` / `Glob failed:`).

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/tools/workspace-fs.test.ts ./packages/core/src/tools/grep.test.ts ./packages/core/src/tools/glob.test.ts
```

Expected: FAIL — `createWorkspaceFs` still takes `backend: 'local' | 'docker'`; methods are sync; `assertInsideWorkspace` is not exported; docker kind is ignored and host-reads `HOST_ONLY_TOKEN`.

- [ ] **Step 3: Write minimal implementation**

New `packages/core/src/tools/sandbox-fs.ts`. Do **not** import `grep.ts` / `glob.ts` / the file tools:

```ts
import type { TerminalBackend, TerminalExecResult } from './terminal-backend'

export const FS_TIMEOUT_MS = 30_000
export const FS_MISSING = '__RC_FS_MISSING__'

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildReadFileScript(path: string): string {
  return `cat -- ${shQuote(path)}`
}

export function buildReadFileBufferScript(path: string): string {
  return `base64 ${shQuote(path)}`
}

export function buildWriteFileScript(path: string): string {
  return `tee -- ${shQuote(path)} >/dev/null`
}

export function buildMkdirScript(path: string): string {
  return `mkdir -p -- ${shQuote(path)}`
}

export function buildUnlinkScript(path: string): string {
  return `rm -f -- ${shQuote(path)}`
}

export function buildStatScript(path: string): string {
  const p = shQuote(path)
  return `if [ ! -e ${p} ]; then
  printf '%s\\n' '${FS_MISSING}'
  exit 0
fi
if [ -d ${p} ]; then kind=dir
elif [ -f ${p} ]; then kind=file
else kind=other
fi
size=0
if [ -f ${p} ]; then size=$(wc -c < ${p} | tr -d ' ')
fi
mtime=0
if mtime=$(date -r ${p} +%s 2>/dev/null); then :; fi
printf 'EXISTS %s %s %s\\n' "$kind" "$size" "$mtime"
`
}

export function buildReaddirScript(path: string): string {
  const p = shQuote(path)
  return `if [ ! -d ${p} ]; then exit 1; fi
find ${p} -maxdepth 1 -mindepth 1 2>/dev/null | while IFS= read -r ent; do
  name=$(basename "$ent")
  if [ -d "$ent" ]; then printf 'd %s\\n' "$name"
  elif [ -f "$ent" ]; then printf 'f %s\\n' "$name"
  fi
done
`
}

export async function execSandboxFs(
  backend: TerminalBackend,
  opts: {
    command: string
    cwd: string
    signal: AbortSignal
    stdin?: string | Uint8Array
  },
): Promise<TerminalExecResult> {
  return backend.exec({
    command: opts.command,
    cwd: opts.cwd,
    timeoutMs: FS_TIMEOUT_MS,
    signal: opts.signal,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
```

BusyBox-safe: no GNU `stat -c`, no `find -printf`. Do not call `backend.start`.

`packages/core/src/tools/workspace-fs.ts`:

```ts
export type WorkspaceFs = {
  readFile(path: string): Promise<string>
  readFileBuffer(path: string): Promise<Buffer>
  writeFile(path: string, content: string): Promise<void>
  mkdir(path: string): Promise<void>
  unlink(path: string): Promise<void>
  stat(path: string): Promise<{
    exists: boolean
    isFile: boolean
    isDir: boolean
    mtimeMs: number
    size: number
  }>
  readdir(path: string): Promise<Array<{ name: string; isFile: boolean; isDir: boolean }>>
  realpath(path: string): string
}

export function assertInsideWorkspace(cwd: string, path: string): string {
  const root = realpathSync(cwd)
  const resolved = resolveExisting(root, path)
  if (!isInsideRoot(resolved, root)) {
    throw new Error('outside workspace')
  }
  return resolved
}

export function workspaceFsFor(turn: { cwd: string }): WorkspaceFs {
  return createWorkspaceFs({ cwd: turn.cwd })
}

export function createWorkspaceFs(opts: {
  cwd: string
  exec?: TerminalBackend
  signal?: AbortSignal
}): WorkspaceFs {
  const root = realpathSync(opts.cwd)
  const signal = opts.signal ?? new AbortController().signal
  function jailed(path: string): string {
    return assertInsideWorkspace(opts.cwd, path)
  }
  if (opts.exec?.kind === 'docker') {
    return dockerWorkspaceFs(opts.exec, opts.cwd, jailed, signal)
  }
  return hostWorkspaceFs(jailed)
}
```

Host methods: wrap today’s `readFileSync` / `writeFileSync` / … in `Promise.resolve` / `async` functions. `stat` still maps only `ENOENT` to `{ exists: false, … }` and rethrows other errors. `realpath` stays `realpathSync(jailed(path))` on **both** host and docker.

Docker methods: jail first (throw `outside workspace` with **zero** exec). Then one `execSandboxFs`. Abort / `AbortError` → throw `AbortError`. Non-zero exit (except `stat` missing marker) → throw `Error` with stderr/stdout (tools prefix `Read failed:`). `stat`: stdout trim `FS_MISSING` → `{ exists: false, … }`; parse `EXISTS kind size mtime` (`mtimeMs = seconds * 1000`); parse failure → throw (fail-closed). `readFileBuffer`: decode base64; decode failure → throw. `writeFile`: `stdin: content`, script `tee`. Do not put bytes in argv.

Grep/Glob execute jail:

```ts
      try {
        assertInsideWorkspace(cwd, searchRoot)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `Grep failed: ${message}`
      }
```

Same for Glob (`Glob failed:`). Do not change `sandbox-search.ts`.

Mechanical awaits in the six tools (so `tsc`/bun typecheck): `await fs.stat` / `readFile` / `writeFile` / `mkdir` / `unlink` / `readdir`. `applyOne` / `createFile` / `updateFile` / `deleteFile` / `walkWorkspace` become `async` and `await`. In each `catch` around a WorkspaceFs call, rethrow AbortError:

```ts
      if (error instanceof Error && error.name === 'AbortError') throw error
```

Do **not** add factories. Do **not** replace Read `peekHasNul` / image `readFileSync` / `streamUtf8LineWindow` yet (Task 4). Those host bypasses still compile because they use `node:fs` directly.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/tools/workspace-fs.test.ts ./packages/core/src/tools/grep.test.ts ./packages/core/src/tools/glob.test.ts ./packages/core/src/tools/read.test.ts ./packages/core/src/tools/write.test.ts ./packages/core/src/tools/edit.test.ts ./packages/core/src/tools/apply-patch.test.ts ./packages/core/src/tools/list-dir.test.ts ./packages/core/src/tools/read-subtree.test.ts
```

Expected: PASS. Jail tests omit `exec`. Docker fake tests never host-read content. Grep/Glob outside-cwd still no exec. Local file-tool tests still host (they still use `workspaceFsFor` / singletons).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/sandbox-fs.ts \
  packages/core/src/tools/workspace-fs.ts \
  packages/core/src/tools/workspace-fs.test.ts \
  packages/core/src/tools/grep.ts \
  packages/core/src/tools/glob.ts \
  packages/core/src/tools/read.ts \
  packages/core/src/tools/write.ts \
  packages/core/src/tools/edit.ts \
  packages/core/src/tools/apply-patch.ts \
  packages/core/src/tools/list-dir.ts \
  packages/core/src/tools/read-subtree.ts
git commit -m "$(cat <<'EOF'
feat: make WorkspaceFs async and exec docker I/O scripts

assertInsideWorkspace is the sync host jail. Grep/Glob
use it. Docker kind runs one backend.exec per method
with tee-on-stdin writes. Host omit/local wraps node:fs.
EOF
)"
```

---

### Task 3: W0.3 six factories + createRootTools / SDK wiring

**Files:**
- Modify: `packages/core/src/tools/read.ts`, `write.ts`, `edit.ts`, `apply-patch.ts`, `list-dir.ts`, `read-subtree.ts` (factory wrap; pass `exec: backend`)
- Modify: matching `*.test.ts` (factory without backend still works)
- Modify: `packages/core/src/index.ts` (~94, ~100, ~174)
- Modify: `packages/cli/src/engine.ts` (`createRootTools` ~216)
- Modify: `packages/cli/src/exec.test.ts` (`createRootTools` ~125)
- Modify: `packages/sdk/src/index.ts` (`createRootTools` ~125)
- Modify: `packages/sdk/src/index.test.ts` (`createRootTools` ~168)

**Interfaces:**
- Consumes: Task 2 `createWorkspaceFs({ cwd, exec, signal })`, existing CLI/SDK `backend?` already passed to Grep/Glob
- Produces: `createReadTool(backend?)` … `createReadSubtreeTool(backend?)`; singletons = omit; `createRootTools` when `backend` is defined passes it into all six; when omitted keeps singletons

- [ ] **Step 1: Write the failing tests**

In each tool test file, keep every existing singleton test. Add (Read shown; mirror for Write/Edit/ApplyPatch/ListDir/ReadSubtree):

```ts
import { createReadTool, readTool } from './read'

test('createReadTool without backend still reads a unique file', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'note.txt'), 'hello factory\n')
  const tool = createReadTool()
  expect(tool.name).toBe('Read')
  expect(tool).not.toBe(readTool) // new instance is fine; name/behavior match
  const out = await tool.execute({ path: 'note.txt' }, makeCtx(root))
  expect(out).toContain('hello factory')
})
```

Do **not** require `tool === readTool` for `createReadTool()` (Grep pattern is `grepTool = createGrepTool()`; the exported singleton is the omit call). After implementation, `export const readTool = createReadTool()` so existing `readTool` tests stay the singleton.

In `packages/cli/src/exec.test.ts` `describe('createRootTools')`:

```ts
test('createRootTools with a backend does not reuse the file-tool singletons', () => {
  const backend = createLocalTerminalBackend()
  const tools = createRootTools(createMemoryStore(), bashTool, askUserTool, false, backend)
  expect(tools.find((tool) => tool.name === 'Read')).not.toBe(readTool)
  expect(tools.find((tool) => tool.name === 'Write')).not.toBe(writeTool)
  expect(tools.find((tool) => tool.name === 'Edit')).not.toBe(editTool)
  expect(tools.find((tool) => tool.name === 'ApplyPatch')).not.toBe(applyPatchTool)
  expect(tools.find((tool) => tool.name === 'ListDir')).not.toBe(listDirTool)
  expect(tools.find((tool) => tool.name === 'ReadSubtree')).not.toBe(readSubtreeTool)
})

test('createRootTools without a backend keeps the file-tool singletons', () => {
  const tools = createRootTools(createMemoryStore())
  expect(tools.find((tool) => tool.name === 'Read')).toBe(readTool)
  expect(tools.find((tool) => tool.name === 'Write')).toBe(writeTool)
  expect(tools.find((tool) => tool.name === 'Edit')).toBe(editTool)
  expect(tools.find((tool) => tool.name === 'ApplyPatch')).toBe(applyPatchTool)
  expect(tools.find((tool) => tool.name === 'ListDir')).toBe(listDirTool)
  expect(tools.find((tool) => tool.name === 'ReadSubtree')).toBe(readSubtreeTool)
})
```

Keep the existing Grep/Glob singleton tests. Keep the root name list unchanged (still no new tool, still `NotebookEdit` on CLI).

In `packages/sdk/src/index.test.ts` `describe('createRootTools')`, same identity tests with SDK arity (`createRootTools(store, bashTool, false, backend)`). SDK still omits NotebookEdit.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/tools/read.test.ts ./packages/core/src/tools/write.test.ts ./packages/core/src/tools/edit.test.ts ./packages/core/src/tools/apply-patch.test.ts ./packages/core/src/tools/list-dir.test.ts ./packages/core/src/tools/read-subtree.test.ts ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts
```

Expected: FAIL — `createReadTool` is not exported; `createRootTools` with a backend still returns the file-tool singletons.

- [ ] **Step 3: Write minimal implementation**

Each of the six modules: extract the current tool object into `createXTool(backend?: TerminalBackend)`. `execute` builds fs from the factory backend, not from `turn.terminalBackend`:

```ts
export function createReadTool(backend?: TerminalBackend): Tool<ReadInput, string> {
  return {
    name: 'Read',
    // description, inputSchema, parse, isConcurrencySafe, isReadOnly,
    // interruptBehavior, checkPermissions unchanged
    async execute(input: ReadInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const resolved = resolve(ctx.turn.cwd, input.path)
      const fs = createWorkspaceFs({
        cwd: ctx.turn.cwd,
        exec: backend,
        signal: ctx.signal,
      })
      // existing body, already awaited in Task 2
    },
  }
}

export const readTool: Tool<ReadInput, string> = createReadTool()
```

Same for Write/Edit/ApplyPatch/ListDir/ReadSubtree. Do not close Read host bypasses yet (Task 4). Local-kind backend still host-I/O inside WorkspaceFs.

`packages/core/src/index.ts`:

```ts
export { readTool, createReadTool } from './tools/read'
export { listDirTool, createListDirTool } from './tools/list-dir'
export { readSubtreeTool, createReadSubtreeTool } from './tools/read-subtree'
export { applyPatchTool, createApplyPatchTool } from './tools/apply-patch'
export { editTool, createEditTool } from './tools/edit'
export { writeTool, createWriteTool } from './tools/write'
export { createWorkspaceFs, assertInsideWorkspace } from './tools/workspace-fs'
```

Do not export `sandbox-fs.ts`.

CLI `createRootTools` (5th arg already `backend?`):

```ts
    backend !== undefined ? createReadTool(backend) : readTool,
    backend !== undefined ? createGrepTool(backend) : grepTool,
    backend !== undefined ? createGlobTool(backend) : globTool,
    backend !== undefined ? createListDirTool(backend) : listDirTool,
    backend !== undefined ? createReadSubtreeTool(backend) : readSubtreeTool,
    backend !== undefined ? createEditTool(backend) : editTool,
    backend !== undefined ? createWriteTool(backend) : writeTool,
    backend !== undefined ? createApplyPatchTool(backend) : applyPatchTool,
    notebookEditTool,
```

SDK `createRootTools` (4th arg already `backend?`) mirrors that (still no NotebookEdit). `createSessionTools` / `openEngine` / `defaultSessionTools` already pass the same backend object used for Bash — do not call `createTerminalBackend` twice. Do not add a backend field on `createSessionEngine`. Do not change `engineOpts.terminalBackend` kind-only.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/tools/read.test.ts ./packages/core/src/tools/write.test.ts ./packages/core/src/tools/edit.test.ts ./packages/core/src/tools/apply-patch.test.ts ./packages/core/src/tools/list-dir.test.ts ./packages/core/src/tools/read-subtree.test.ts ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts
```

Expected: PASS. `createRootTools(store)` name list unchanged. Grep/Glob identity tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/read.ts \
  packages/core/src/tools/write.ts \
  packages/core/src/tools/edit.ts \
  packages/core/src/tools/apply-patch.ts \
  packages/core/src/tools/list-dir.ts \
  packages/core/src/tools/read-subtree.ts \
  packages/core/src/tools/read.test.ts \
  packages/core/src/tools/write.test.ts \
  packages/core/src/tools/edit.test.ts \
  packages/core/src/tools/apply-patch.test.ts \
  packages/core/src/tools/list-dir.test.ts \
  packages/core/src/tools/read-subtree.test.ts \
  packages/core/src/index.ts \
  packages/cli/src/engine.ts \
  packages/cli/src/exec.test.ts \
  packages/sdk/src/index.ts \
  packages/sdk/src/index.test.ts
git commit -m "$(cat <<'EOF'
feat: pass TerminalBackend into file-tool factories

createReadTool and siblings take the same backend object
as Bash/Grep. Omit keeps the host singletons. CLI and SDK
createRootTools wire it when defined.
EOF
)"
```

---

### Task 4: W1.1 Read callers close host bypasses

**Files:**
- Modify: `packages/core/src/tools/read.ts` (`execute` ~59, `peekHasNul` ~151)
- Modify: `packages/core/src/tools/read.test.ts`

**Interfaces:**
- Consumes: `createReadTool(backend)`, `fs.readFile` / `readFileBuffer` / `stat` / `realpath`
- Produces: docker Read never calls `openSync` / host `readFileSync` / `streamUtf8LineWindow`; local may keep the stream optimization

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/tools/read.test.ts`, add `describe('Read docker backend')` with the Grep-style `fakeDocker`. Host files must exist (jail realpath):

```ts
test('utf-8 read uses fake exec stdout not host bytes', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'a.txt'), 'HOST_ONLY_READ_TOKEN\n')
  const calls: TerminalRunRequest[] = []
  const backend = fakeDocker(async (req) => {
    calls.push(req)
    if (String(req.args.at(-1)).includes('printf') || String(req.args.at(-1)).includes('EXISTS')) {
      return { stdout: 'EXISTS file 21 1\n', stderr: '', exitCode: 0 }
    }
    return { stdout: 'FROM_CONTAINER\n', stderr: '', exitCode: 0 }
  })
  const out = await createReadTool(backend).execute({ path: 'a.txt' }, makeCtx(root))
  expect(out).toContain('FROM_CONTAINER')
  expect(out).not.toContain('HOST_ONLY_READ_TOKEN')
  expect(calls.length).toBeGreaterThan(0)
  expect(calls[0]?.command).toBe('docker')
})

test('NUL / image / large-file docker path does not host-read content', async () => {
  const root = fixtureRoot()
  const nulPath = join(root, 'bin.dat')
  writeFileSync(nulPath, Buffer.from([0x00, 0x01, 0x02]))
  const imgPath = join(root, 'pic.png')
  writeFileSync(imgPath, Buffer.from('HOST_PNG'))
  const bigPath = join(root, 'big.txt')
  writeFileSync(bigPath, 'HOST_BIG\n'.repeat(40_000)) // > STREAM_AFTER
  const fakeB64 = Buffer.from('FROM_CONTAINER_PNG').toString('base64')
  const backendFor = (stdout: string) =>
    fakeDocker(async (req) => {
      const script = String(req.args.at(-1))
      if (script.includes(FS_MISSING) || script.includes('EXISTS') || script.includes('kind=dir')) {
        return { stdout: 'EXISTS file 3 1\n', stderr: '', exitCode: 0 }
      }
      if (script.includes('base64')) return { stdout: fakeB64, stderr: '', exitCode: 0 }
      return { stdout, stderr: '', exitCode: 0 }
    })

  const nulOut = await createReadTool(backendFor('no-nul-text')).execute(
    { path: 'bin.dat' },
    makeCtx(root),
  )
  expect(String(nulOut)).not.toMatch(/binary file/)
  expect(nulOut).toContain('no-nul-text')

  const imgOut = await createReadTool(backendFor('')).execute({ path: 'pic.png' }, makeCtx(root))
  expect(imgOut).toMatch(/^IMAGE::image\/png::/)
  expect(imgOut).toContain(fakeB64)
  expect(imgOut).not.toContain(Buffer.from('HOST_PNG').toString('base64'))

  const bigOut = await createReadTool(backendFor('FROM_CONTAINER_BIG\n')).execute(
    { path: 'big.txt' },
    makeCtx(root),
  )
  expect(bigOut).toContain('FROM_CONTAINER_BIG')
  expect(bigOut).not.toContain('HOST_BIG')
})

test('exec fail is Read failed: and abort throws AbortError', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'a.txt'), 'HOST_ONLY_READ_TOKEN\n')
  const fail = fakeDocker(async () => ({
    stdout: '',
    stderr: 'Cannot connect to the Docker daemon',
    exitCode: 1,
  }))
  const failed = await createReadTool(fail).execute({ path: 'a.txt' }, makeCtx(root))
  expect(failed).toMatch(/^Read failed:/)
  expect(failed).not.toContain('HOST_ONLY_READ_TOKEN')

  const ac = new AbortController()
  ac.abort()
  const tool = createReadTool(fakeDocker(async () => ({ stdout: 'x', stderr: '', exitCode: 0 })))
  await expect(tool.execute({ path: 'a.txt' }, makeCtx(root, ac.signal))).rejects.toMatchObject({
    name: 'AbortError',
  })
})

test('outside-cwd fails at jail with no exec', async () => {
  const root = fixtureRoot()
  const calls: TerminalRunRequest[] = []
  const backend = fakeDocker(async (req) => {
    calls.push(req)
    return { stdout: 'nope', stderr: '', exitCode: 0 }
  })
  const out = await createReadTool(backend).execute({ path: '/etc/passwd' }, makeCtx(root))
  expect(calls).toHaveLength(0)
  expect(out).toMatch(/^Read failed:/)
  expect(out).toMatch(/outside workspace/)
})
```

Import `FS_MISSING` from `./sandbox-fs` in the test if used; otherwise match the stat script by `kind=dir` / `EXISTS` as above. Copy `fakeDocker` locally.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/tools/read.test.ts
```

Expected: FAIL — docker Read of NUL/image/large still `openSync` / `readFileSync` / `streamUtf8LineWindow` on the host bind (host token or `binary file` from peek).

- [ ] **Step 3: Write minimal implementation**

In `createReadTool.execute`, after `const fs = createWorkspaceFs({ cwd, exec: backend, signal })`:

- `stat = await fs.stat(resolved)` (already awaited).
- If `backend?.kind === 'docker'`: **do not** take the `stat.size > STREAM_AFTER` branch that calls `peekHasNul` + `streamUtf8LineWindow`. One `readFile` / `readFileBuffer` (WorkspaceFs already one exec per method; Read may `stat` then read = two execs — honest).
- Image/office: `buf = await fs.readFileBuffer(resolved)` on **both** local and docker (local `readFileBuffer` is host `readFileSync` wrapped). Delete the `readFileSync(fs.realpath(resolved))` branch.
- Docker text: `text = await fs.readFile(resolved)` then existing NUL-in-first-8KiB / ipynb / `sliceUtf8Lines`. Optional: docker large files still one `cat` (30s timeout lives in WorkspaceFs).
- Local non-image non-office `stat.size > STREAM_AFTER` may keep `peekHasNul` + `streamUtf8LineWindow` on `fs.realpath` (host).
- Every `catch` rethrows `AbortError`.

Do not `openSync` on the docker path. Do not edit `notebook-edit.ts`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/tools/read.test.ts
```

Expected: PASS. Existing local Read tests stay green (stream path still used when omit/local).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/read.ts packages/core/src/tools/read.test.ts
git commit -m "$(cat <<'EOF'
feat: read docker files through WorkspaceFs bytes

Docker Read uses readFile/readFileBuffer. No openSync,
host readFileSync, or streamUtf8LineWindow on that path.
Local still streams large utf-8 files.
EOF
)"
```

---

### Task 5: W1.2 Write / Edit / ApplyPatch

**Files:**
- Modify: `packages/core/src/tools/write.ts`, `edit.ts`, `apply-patch.ts`
- Modify: `packages/core/src/tools/write.test.ts`, `edit.test.ts`, `apply-patch.test.ts`

**Interfaces:**
- Consumes: `createWriteTool(backend)` / `createEditTool` / `createApplyPatchTool`, `isHardDeniedWritePath` / `resolveWritePath`, `fileHistory.snapshot`, `lintWrittenFile`
- Produces: hard-deny and outside-cwd before exec; snapshot then docker `writeFile`; unread/stale laws unchanged (mtime from `stat`, keys from host `realpath`); lint stays host

- [ ] **Step 1: Write the failing tests**

Shared `fakeDocker` in each test file. Write:

```ts
test('docker write sends stdin and does not host-write on exec fail', async () => {
  const root = fixtureRoot()
  const path = join(root, 'out.txt')
  const calls: TerminalRunRequest[] = []
  const backend = fakeDocker(async (req) => {
    calls.push(req)
    const script = String(req.args.at(-1))
    if (script.includes('EXISTS') || script.includes('kind=dir')) {
      return { stdout: '__RC_FS_MISSING__\n', stderr: '', exitCode: 0 }
    }
    if (script.includes('mkdir')) return { stdout: '', stderr: '', exitCode: 0 }
    return { stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 }
  })
  const out = await createWriteTool(backend).execute(
    { path: 'out.txt', content: 'NEW_PAYLOAD' },
    makeCtx(root),
  )
  expect(out).toMatch(/^Write failed:/)
  expect(existsSync(path)).toBe(false)
  expect(calls.some((req) => req.stdin === 'NEW_PAYLOAD' || String(req.args.at(-1)).includes('tee'))).toBe(true)
})

test('hard-denied path does not exec', async () => {
  const root = fixtureRoot()
  const calls: TerminalRunRequest[] = []
  const backend = fakeDocker(async (req) => {
    calls.push(req)
    return { stdout: '', stderr: '', exitCode: 0 }
  })
  const out = await createWriteTool(backend).execute(
    { path: '/etc/shadow', content: 'x' },
    makeCtx(root),
  )
  expect(calls).toHaveLength(0)
  expect(out).toMatch(/^Write failed:/)
  expect(out).toMatch(/protected path/)
})

test('outside-cwd does not exec', async () => {
  const root = fixtureRoot()
  const calls: TerminalRunRequest[] = []
  const backend = fakeDocker(async (req) => {
    calls.push(req)
    return { stdout: '', stderr: '', exitCode: 0 }
  })
  const out = await createWriteTool(backend).execute(
    { path: '/tmp/raven-outside.txt', content: 'x' },
    makeCtx(root),
  )
  expect(calls).toHaveLength(0)
  expect(out).toMatch(/outside workspace|Write failed:/)
})

test('overwrite still requires Read; new file does not', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'old.txt'), 'old')
  const backend = fakeDocker(async (req) => {
    const script = String(req.args.at(-1))
    if (script.includes('EXISTS') || script.includes('kind=dir')) {
      return { stdout: 'EXISTS file 3 1\n', stderr: '', exitCode: 0 }
    }
    return { stdout: '', stderr: '', exitCode: 0 }
  })
  const denied = await createWriteTool(backend).execute(
    { path: 'old.txt', content: 'new' },
    makeCtx(root),
  )
  expect(denied).toMatch(/must be Read first/)
})
```

Edit: docker `readFile` returns unique `old_string`; after snapshot, `writeFile` stdin is the replacement; abort throws `AbortError`; leftover-ask / `interruptBehavior: 'block'` unchanged.

ApplyPatch: `create_file` uses mkdir + writeFile via fs (stdin); `delete_file` uses `unlink`; protected path no exec; `ApplyPatch failed:` on exec fail with no host write.

Do not edit `file-history.ts`. A test may pass a fake `ctx.fileHistory.snapshot` and assert it ran **before** the write exec (call order on the fake `runCommand` vs snapshot spy).

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/tools/write.test.ts ./packages/core/src/tools/edit.test.ts ./packages/core/src/tools/apply-patch.test.ts
```

Expected: FAIL on current Task-3 tree if Write still host-writes when exec returns 1, or if hard-deny is not before exec (should already be host — then the hard-deny test passes and the fail-closed write test is the red one).

- [ ] **Step 3: Write minimal implementation**

Keep today’s order: `isHardDeniedWritePath` → `await fs.stat` → unread/stale → `await fs.mkdir` → `ctx.fileHistory?.snapshot(resolved)` → `await fs.writeFile`. That snapshot-then-write is already correct; docker `writeFile` is the content path.

Edit: `await fs.readFile` for the unique replace; snapshot; `await fs.writeFile`. ApplyPatch `applyOne` already async from Task 2; ensure AbortError rethrow in `createFile` / `updateFile` / `deleteFile` catches (do not treat abort as “file missing” on create).

Lint after write stays `lintWrittenFile(resolved, ctx.turn.cwd)` host. Do not docker-exec `cp`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/tools/write.test.ts ./packages/core/src/tools/edit.test.ts ./packages/core/src/tools/apply-patch.test.ts
```

Expected: PASS. Local singleton Write/Edit/ApplyPatch tests stay green. `sandbox-cwd` eval still uses host `writeTool` + kind-only `terminalBackend: 'docker'` (jail, not this port).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/write.ts \
  packages/core/src/tools/write.test.ts \
  packages/core/src/tools/edit.ts \
  packages/core/src/tools/edit.test.ts \
  packages/core/src/tools/apply-patch.ts \
  packages/core/src/tools/apply-patch.test.ts
git commit -m "$(cat <<'EOF'
feat: write Edit and ApplyPatch through docker WorkspaceFs

Hard-deny and cwd jail run before exec. Snapshot and lint
stay host. Exec failure is Write/Edit/ApplyPatch failed
with no host fallback.
EOF
)"
```

---

### Task 6: W1.3 ListDir / ReadSubtree

**Files:**
- Modify: `packages/core/src/tools/list-dir.ts`, `read-subtree.ts`
- Modify: `packages/core/src/tools/list-dir.test.ts`, `read-subtree.test.ts`

**Interfaces:**
- Consumes: `createListDirTool(backend)`, `createReadSubtreeTool(backend)`, async `readdir` / `stat` / `readFile`
- Produces: caps unchanged (ListDir 500; ReadSubtree max 80 files, 200_000 byte skip); docker ReadSubtree N files → N `readFile` execs plus walk `stat`/`readdir` execs; no batch API

- [ ] **Step 1: Write the failing tests**

ListDir:

```ts
test('docker readdir uses fake listing not host names', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'host-only.txt'), 'x')
  mkdirSync(join(root, 'host-dir'))
  const calls: TerminalRunRequest[] = []
  const backend = fakeDocker(async (req) => {
    calls.push(req)
    return { stdout: 'd from-container-dir\nf from-container.txt\n', stderr: '', exitCode: 0 }
  })
  const out = await createListDirTool(backend).execute({ path: '.' }, makeCtx(root))
  expect(out).toContain('dir   from-container-dir')
  expect(out).toContain('file  from-container.txt')
  expect(out).not.toContain('host-only.txt')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.timeoutMs).toBe(30_000)
})

test('exec fail is ListDir failed: ; abort throws AbortError', async () => {
  const root = fixtureRoot()
  const backend = fakeDocker(async () => ({
    stdout: '',
    stderr: 'Cannot connect to the Docker daemon',
    exitCode: 1,
  }))
  const out = await createListDirTool(backend).execute({}, makeCtx(root))
  expect(out).toMatch(/^ListDir failed:/)
  const ac = new AbortController()
  ac.abort()
  await expect(
    createListDirTool(fakeDocker(async () => ({ stdout: '', stderr: '', exitCode: 0 }))).execute(
      {},
      makeCtx(root, ac.signal),
    ),
  ).rejects.toMatchObject({ name: 'AbortError' })
})
```

ReadSubtree: two in-tree files `a.ts` / `b.ts`; fake `readdir`/`stat`/`readFile` so the tool lists container names; count `readFile` (`cat` / non-stat) execs === 2 when both files are under `TEXT_BYTE_CAP`; a file with fake size ≥ 200_000 is size-only (no `cat` for that file). Caps: `maxFiles` default 40, cap 80 — do not change.

```ts
test('docker ReadSubtree issues one readFile exec per file under the byte cap', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'a.ts'), 'export function alpha() {}\n')
  writeFileSync(join(root, 'b.ts'), 'export function beta() {}\n')
  let cats = 0
  const backend = fakeDocker(async (req) => {
    const script = String(req.args.at(-1))
    if (script.includes('find') || script.startsWith('if [ ! -d')) {
      return { stdout: 'f a.ts\nf b.ts\n', stderr: '', exitCode: 0 }
    }
    if (script.includes('EXISTS') || script.includes('kind=dir')) {
      return { stdout: 'EXISTS file 24 1\n', stderr: '', exitCode: 0 }
    }
    cats += 1
    return { stdout: 'export function fromContainer() {}\n', stderr: '', exitCode: 0 }
  })
  const out = await createReadSubtreeTool(backend).execute({ path: '.' }, makeCtx(root))
  expect(cats).toBe(2)
  expect(out).toContain('fromContainer')
  expect(out).not.toContain('function alpha')
})
```

Outside-cwd: no exec, `ListDir failed:` / `ReadSubtree failed:`.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/tools/list-dir.test.ts ./packages/core/src/tools/read-subtree.test.ts
```

Expected: FAIL — ListDir still host-`readdir`s `host-only.txt`; ReadSubtree still host-walks `alpha`/`beta`.

- [ ] **Step 3: Write minimal implementation**

ListDir already `await fs.readdir` from Task 2; factory already passes `exec` from Task 3. Fix any leftover `workspaceFsFor(ctx.turn)` if still present. AbortError rethrow.

ReadSubtree `walkWorkspace` already async from Task 2; each `readFile` is one exec. Skip `readFile` when `file.size >= TEXT_BYTE_CAP` (header only). Binary NUL still from `readFile` text slice. Do not add a batch API.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/tools/list-dir.test.ts ./packages/core/src/tools/read-subtree.test.ts
```

Expected: PASS. Local singleton tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/list-dir.ts \
  packages/core/src/tools/list-dir.test.ts \
  packages/core/src/tools/read-subtree.ts \
  packages/core/src/tools/read-subtree.test.ts
git commit -m "$(cat <<'EOF'
feat: listDir and ReadSubtree through docker WorkspaceFs

One readdir exec for ListDir. ReadSubtree walks with one
exec per stat/readdir/readFile. Caps unchanged. Fail-closed.
EOF
)"
```

---

### Task 7: W2 eval sandbox-fs + docs honesty (after code)

**Files:**
- Modify: `packages/core/src/eval/run.ts` (`EvalExpect` ~36, `runEvalDir` ~152, new `runSandboxFs` next to `runSandboxSearch` ~409)
- Create: `packages/core/src/eval/fixtures/sandbox-fs/case.json`
- Modify: `docs/headless.md` (~46)
- Modify: `ARCHITECTURE.md` (openEngine bullet ~129; Read/Write/ListDir/ReadSubtree/Edit rows ~490)
- Modify: `ARCHITECTURE.ko.md` (Grep/Glob/Read row ~396; docker sentence ~714)
- Modify: `docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md` (E2.1 ~161 — pointer only)
- Modify: `docs/superpowers/specs/2026-09-21-workspacefs-docker.md` (Status → implemented; board waves done; shipped sha)
- Modify: `CHANGELOG.md` Unreleased
- Modify: `docs/research/eve-analysis.md` / `eve-analysis.ko.md` one-line closer if they still say file tools never use the docker port

Spec Status stays **draft until this task**. Do not mark it implemented in Tasks 1–6.

- [ ] **Step 1: Write the failing fixture + runner so today’s tree throws `unknown eval fixture`**

`packages/core/src/eval/fixtures/sandbox-fs/case.json`:

```json
{
  "prompt": "read then write the in-tree unique file",
  "expect": { "sandboxFsUsesBackend": true }
}
```

In `EvalExpect` add `sandboxFsUsesBackend?: boolean`.

In `runEvalDir`, **before** `throw new Error(\`unknown eval fixture: ${name}\`)`:

```ts
    if (name === 'sandbox-fs') {
      await runSandboxFs(spec)
      continue
    }
```

Keep `sandbox-cwd` (Write jail, `terminalBackend: 'docker'` kind-only + host `writeTool`) and `sandbox-search` unchanged. Do **not** pass `terminalBackend: 'docker'` on the sandbox-fs engine. Do not Grep `/etc/passwd`.

```ts
async function runSandboxFs(spec: EvalCase): Promise<void> {
  if (spec.expect.sandboxFsUsesBackend !== true) {
    throw new Error('sandbox-fs: expect.sandboxFsUsesBackend must be true')
  }
  const cwd = mkdtempSync(join(tmpdir(), 'raven-eval-sandbox-fs-'))
  const uniqueName = `unique-sandbox-fs-${crypto.randomUUID()}.txt`
  const uniquePath = join(cwd, uniqueName)
  const hostToken = `SANDBOX_FS_HOST_TOKEN_${crypto.randomUUID().slice(0, 8)}`
  writeFileSync(uniquePath, `${hostToken}\n`)
  const calls: Array<{ command: string; args: string[]; stdin?: string | Uint8Array }> = []
  try {
    const fakeBackend = createDockerTerminalBackend({
      image: 'bash:5',
      runCommand: async (req) => {
        calls.push({ command: req.command, args: req.args, stdin: req.stdin })
        const script = String(req.args.at(-1) ?? '')
        if (script.includes('__RC_FS_MISSING__') || script.includes('kind=dir')) {
          return { stdout: 'EXISTS file 8 1\n', stderr: '', exitCode: 0 }
        }
        if (script.includes('tee') || script.includes('mkdir')) {
          return { stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 }
        }
        return { stdout: 'FAKE_DOCKER_READ\n', stderr: '', exitCode: 0 }
      },
    })
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_eval_sandbox_fs', cwd })
    await store.createSession(session)
    const engine = await createSessionEngine({
      session,
      provider: createFakeProvider([
        toolThenStop('call_eval_read', 'Read', { path: uniqueName }),
        toolThenStop('call_eval_write', 'Write', {
          path: uniqueName,
          content: 'SHOULD_NOT_HOST_WRITE',
        }),
        textThenStop('done'),
      ]),
      store,
      tools: [createReadTool(fakeBackend), createWriteTool(fakeBackend)],
      compact: defaultCompact(),
      model: defaultModel(),
      maxRounds: 8,
      bare: true,
      askUser: async () => 'allow',
    })
    await drain(engine.submitMessage(spec.prompt))
    const loaded = await store.loadSession(session.id)
    const text = toolResultText(loaded.messages)
    if (calls.length < 1) {
      throw new Error(`sandbox-fs: expected backend exec, got ${calls.length}`)
    }
    if (calls[0]?.command !== 'docker') {
      throw new Error(`sandbox-fs: expected docker exec, got ${calls[0]?.command}`)
    }
    if (!calls.some((c) => c.args.includes(`${cwd}:${cwd}`) && c.args.includes('-w'))) {
      throw new Error('sandbox-fs: docker argv missing cwd bind')
    }
    if (!text.includes('FAKE_DOCKER_READ')) {
      throw new Error(`sandbox-fs: expected fake read stdout, got ${JSON.stringify(text)}`)
    }
    if (text.includes(hostToken)) {
      throw new Error('sandbox-fs: host readFileSync ran')
    }
    if (!/Write failed:/.test(text)) {
      throw new Error(`sandbox-fs: expected Write failed on exec reject, got ${JSON.stringify(text)}`)
    }
    if (readFileSync(uniquePath, 'utf8').includes('SHOULD_NOT_HOST_WRITE')) {
      throw new Error('sandbox-fs: host writeFileSync ran')
    }
    await engine.close()
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}
```

Import `createReadTool` / `createWriteTool` next to the existing `createGrepTool` imports. Copy no helpers from `session-engine.test.ts`. Unknown directory names still throw.

- [ ] **Step 2: Run eval tests**

```bash
bun test ./packages/core/src/eval/run.test.ts
```

Expected: FAIL until dispatch + factories exist (`unknown eval fixture: sandbox-fs`). After Tasks 1–6: PASS. `sandbox-cwd` and `sandbox-search` stay green.

- [ ] **Step 3: Point docs at the shipped behavior (only after code is green)**

`docs/headless.md` Optional Docker sandbox paragraph becomes: when Bash is actually docker (backend **and** image), allowed Bash, Grep/Glob, and Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree `docker run` in that container (`-v cwd:cwd -w cwd`); omit/local/`createTerminalBackend('docker')` without image stays host `rg`/walk / host WorkspaceFs jail. It is not a substitute for `dontAsk`. Do **not** claim NotebookEdit, Memory, or file-history writers are docker-exec.

`ARCHITECTURE.md` / `.ko.md`: Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree notes — share Bash’s `TerminalBackend`; host jail then one exec per WorkspaceFs method; fail-closed; turn abort → `AbortError` / `ABORTED_TEXT`. openEngine bullet: pass the same backend object to Bash, Grep/Glob, **and** the six file-tool factories. Korean file must not lag.

E2.1 historical pointer: Grep/Glob unparked by `2026-09-21-grep-glob-docker-exec.md`; WorkspaceFs docker I/O unparked by `2026-09-21-workspacefs-docker.md`. NotebookEdit docker, Memory in container, file-history docker, `ignored` dismiss-on-message, LSP museum, web UI stay OUT.

`CHANGELOG.md` Unreleased: when Bash is actually docker (backend **and** image), Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree exec in that container; omit/local/image-less docker stays host jail. Link this spec + plan.

After code ships, set spec Status to **implemented**, check waves W0–W2 done, record the sha. Do not reopen NotebookEdit docker, schema, or `createSessionEngine` backend instance.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/eval/run.ts \
  packages/core/src/eval/fixtures/sandbox-fs/case.json \
  docs/headless.md ARCHITECTURE.md ARCHITECTURE.ko.md \
  CHANGELOG.md \
  docs/superpowers/specs/2026-09-21-workspacefs-docker.md \
  docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md \
  docs/research/eve-analysis.md docs/research/eve-analysis.ko.md
git commit -m "$(cat <<'EOF'
docs: Read/Write share docker Bash backend

Eval sandbox-fs injects createReadTool/createWriteTool with
a fake runCommand. NotebookEdit and file-history writers
stay host. Parallel doors stay OUT.
EOF
)"
```

If the eval runner lands before the docs pass, split into two commits (eval first, docs second) rather than mixing a red runner with honesty edits. Spec Status flips only in the docs commit.

---

## Success checks

1. Docker Bash backend + fake `runCommand`: in-tree Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree invoke that backend; host `readFileSync`/`writeFileSync`/`openSync` are not the content path; argv contains `-v cwd:cwd` and `-w cwd`; env is allowlist-only.
2. Outside-cwd Read/Write still fail closed without docker (host jail, no exec). Hard-denied writes never exec.
3. Docker exec failure (no daemon / timeout) returns `Read failed:` / `Write failed:` / … and does not write the host file. Turn abort throws `AbortError` (phases pair `ABORTED_TEXT`) and is not stringified as `Read failed:`.
4. Missing in-jail file: `stat.exists === false`; Write of a new file still works; overwrite still requires Read.
5. Image/office/NUL/large Read on the docker path does not `openSync` the host file. Write payload is stdin to `tee`, not `bash -c` bytes.
6. `sandbox-cwd` and `sandbox-search` evals stay green. New `sandbox-fs` eval is green with a fake backend.
7. Local omit/local-kind file tools stay on host `node:fs`. Singletons remain when `createRootTools` omits `backend`.
8. NotebookEdit still uses host `readFileSync` (sibling door). `createSessionEngine` still has no backend instance. No schema bump.

## Out of this closeout

Web UI, Prisma Task, Socket.IO, wiki, Workflow loop, agent compiler, NotebookEdit docker, Memory in container, file-history docker, sandbox network policy, Kata, isolation-trust, `dontAsk` as isolation, yaml `extraArgs` as a new key, session-long container, dismiss-on-message, LSP museum.
