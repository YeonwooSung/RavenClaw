# Memory docker I/O — Implementation Plan

I'm using the writing-plans skill to create the implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Bash is actually a docker `TerminalBackend` (kind + image) **and** the memory file sits inside `turn.cwd`, Memory reads and writes `.ravenclaw/MEMORY.md` / `USER.md` through that same port via `createWorkspaceFs`. Job isolation (`projectCwd` outside `cwd`) on docker fail-closes with exactly `Memory failed: outside workspace`, zero exec, no host write. Omit/local/image-less docker stays today’s host `node:fs`, including the `projectCwd` sidecar. Spec + this plan first; then TDD in this isolated worktree.

**Architecture:** `createMemoryTool(backend?: TerminalBackend)` wraps the existing leftover-ask tool. Omit / `kind !== 'docker'` / image-less `createTerminalBackend('docker')` → today’s host `readExisting` / `mkdirSync` / `writeFileSync` after `root = ctx.turn.projectCwd ?? ctx.turn.cwd`. `kind === 'docker'` **and** `isInTreePath(ctx.turn.cwd, path)` → `createWorkspaceFs({ cwd: ctx.turn.cwd, exec: backend, signal: ctx.signal })` for in-tree I/O. `kind === 'docker'` **and** path outside `turn.cwd` → return exactly `Memory failed: outside workspace` with no `backend.exec` and no host `writeFileSync`. Default export `memoryTool = createMemoryTool()` stays local. CLI and SDK `createRootTools` already take optional last `backend`; when set, pass it into the factory. SDK still includes Memory (unlike NotebookEdit). `createSessionEngine` still has no backend instance.

**Tech Stack:** Bun, TypeScript, existing `TerminalBackend` / `createDockerTerminalBackend` / `createWorkspaceFs` / `isInTreePath`. Fake `runCommand` like `notebook-edit.test.ts` / `workspace-fs.test.ts`. No live docker required to merge.

**Spec:** `docs/superpowers/specs/2026-09-22-memory-docker.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` stays the only non-`submitMessage` closer. Memory stays leftover-ask.
- Default prefix unchanged. No new tool. Factory wraps the existing tool.
- `dontAsk` never becomes `bypass`. `acceptEdits` still does not promote Memory.
- BYOK. Clean-room. No web UI, Prisma Task, Socket.IO, wiki.
- Targeted `bun test ./<files>` only. Isolated worktree. Do not implement on `main` without consent.
- `createSessionEngine` still has no `TerminalBackend` instance.
- No file-history docker, TodoWrite/Skill docker, extra mounts, schema bump, `Turn.terminalImage`, backend on `createSessionEngine`, Slack/ACP skip, web UI.
- Do not implement on `main`. Do not push. Do not commit `bun.lock`.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification only.

1. **IN is the Memory tool only.** Parse, `nextBody`, `appendParagraph`, `MEMORY_FILE_CHAR_CAP` (8000), leftover-ask `checkPermissions`, and the two filenames (`MEMORY.md` / `USER.md`) stay. Only the bytes on disk move through the docker port.

2. **`createMemoryTool(backend?: TerminalBackend): Tool<MemoryInput, string>`.** Omit / `backend.kind !== 'docker'` / image-less docker constructor (`createTerminalBackend('docker')` stamps `kind: 'local'`) → today’s host `node:fs` after the path is computed. `export const memoryTool: Tool<MemoryInput, string> = createMemoryTool()` stays the local singleton so existing tests that import `memoryTool` stay green. Do **not** infer docker from `turn.terminalBackend` (kind has no image).

3. **Path formula unchanged.** `root = ctx.turn.projectCwd ?? ctx.turn.cwd`. `path = memoryFilePath(root, target)`. Do **not** start writing MEMORY.md under the job worktree on the local backend. Local `projectCwd` outside `turn.cwd` still host-writes the project sidecar.

4. **Docker I/O only when `backend.kind === 'docker'` AND `isInTreePath(ctx.turn.cwd, path)`.** Import `isInTreePath` from `packages/core/src/permissions/modes.ts`. Pass **no** `extraRoots` / `additionalDirectories`. Inside → WorkspaceFs I/O. **Outside** (job isolation: `projectCwd` is the original repo, docker bind is the worktree) → return exactly `Memory failed: outside workspace` **before** `createWorkspaceFs`, **no** `backend.exec`, **no** host `writeFileSync`. Do not throw-and-wrap for this miss; return the string from `execute`.

5. **Reuse WorkspaceFs. Do not edit `workspace-fs.ts`.** In-tree docker: `createWorkspaceFs({ cwd: ctx.turn.cwd, exec: backend, signal: ctx.signal })`. Do not fork a second cat/tee helper. Do not import `sandbox-search.ts`. Local/omit stays today’s `readExisting` + `mkdirSync` + `writeFileSync` so `projectCwd` outside `cwd` keeps working (WorkspaceFs would jail it).

6. **Cap and match stay host-side on the read body.** Docker in-tree read: `fs.stat(path)` first (`exists === false` → `''`, matching today’s missing file); `exists === true` → `fs.readFile(path)`. Then `nextBody` + cap in process. Cap refuse and `match not found` / missing match **do not** write and **do not** issue a write exec (`tee`). Docker read/stat fail (no daemon / timeout `exitCode === 124` / missing `base64`/`cat`) → `Memory failed:` with **no** host fallback and no write. Do **not** treat daemon fail as missing.

7. **Docker write is mkdir then tee.** After a successful next body: `await fs.mkdir(dirname(path))` then `await fs.writeFile(path, next.body)` (WorkspaceFs already tees stdin, timeout 30s). Fail-closed: no daemon / missing `tee` / 30s timeout / non-zero write → `Memory failed:` and **no** host `writeFileSync`. **Turn abort** (`ctx.signal` / `AbortError` from `backend.exec`) **throws `AbortError`**. Do not stringify abort into `Memory failed:`. `interruptBehavior` stays `'block'`. Do not call `backend.start`. Do not call `fileHistory.snapshot`.

8. **Permissions unchanged.** Do **not** edit `pipeline.ts`. Memory `checkPermissions` stays leftover-ask `{ behavior: 'ask', saveAs: 'session' }`. Current `isAcceptEditsPromote` already allows in-tree Memory (`pipeline.test.ts` `dontAsk + Memory in-tree allows; out-of-tree denies`) — this door does not change that and does **not** add NotebookEdit-style tests that expect dontAsk leftover of Memory is deny. `dontAsk` never becomes `bypass`.

9. **`createSessionEngine` still has no backend instance.** Eval that needs docker Memory injects `createMemoryTool(fakeBackend)` in `tools`. No live docker required to merge. Fake `runCommand` like NotebookEdit / WorkspaceFs tests. Optional live `bash:5` is **out** of this plan.

10. **Secrets.** Allowlist env only (`PATH` / `HOME` / `TERM` / `LANG`). No docker.sock. No `ANTHROPIC_API_KEY` in the container. Tests assert the fake `runCommand` env.

11. **Hosts.** CLI `createRootTools(..., backend?: TerminalBackend)` and SDK `createRootTools(..., backend?: TerminalBackend)` use `createMemoryTool(backend)` when `backend !== undefined`; omit keeps the `memoryTool` singleton (identity-stable). SDK **still includes** Memory (unlike NotebookEdit). Do not change `createSessionTools` signatures (they already forward `opts.backend`).

12. **Worktree.** Implement in this worktree (`/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/memory-docker`). Never on `main`. Do not push. Do not commit `bun.lock`. Do not bump package version.

13. **Docs last.** Spec Status stays **draft** until Task 4 after code. Leave `Shipped sha:` empty until the branch lands on `main`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/tools/memory.ts` | `createMemoryTool`; docker in-tree WorkspaceFs I/O; outside-cwd fail-close |
| `packages/core/src/tools/memory.test.ts` | keep every existing singleton test; add factory-local + docker describes |
| `packages/core/src/index.ts` | export `createMemoryTool` next to `memoryTool` / `memoryFilePath` |
| `packages/cli/src/engine.ts` | `createRootTools` uses factory when `backend` is set |
| `packages/cli/src/exec.test.ts` | singleton identity with/without backend |
| `packages/sdk/src/index.ts` | same wiring; **still includes Memory** |
| `packages/sdk/src/index.test.ts` | identity + includes-Memory lock |
| docs listed in Task 4 | honesty after code; spec Status → implemented **after code** |

Do not touch: `workspace-fs.ts`, `sandbox-fs.ts`, `file-history.ts`, `todo.ts`, `skill.ts`, `notebook-edit.ts`, `loop/`, schema, Slack/ACP adapters, `pipeline.ts`.

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 M0 factory + local singleton + core export | `memory.ts` (factory wrap; **no docker exec yet**), `memory.test.ts` (factory local), `packages/core/src/index.ts` |
| 2 M1 docker in-tree I/O + outside-cwd fail-close | `memory.ts` (docker branch), `memory.test.ts` (docker describe + local `projectCwd` lock) |
| 3 M2 CLI/SDK wiring | `packages/cli/src/engine.ts`, `packages/cli/src/exec.test.ts`, `packages/sdk/src/index.ts`, `packages/sdk/src/index.test.ts` |
| 4 M3 docs honesty | `ARCHITECTURE.md` / `.ko.md`, `docs/headless.md`, `CHANGELOG.md` Unreleased, eve-analysis en/ko, E2.1 pointer, workspacefs/notebookedit OUT lists, this spec Status → implemented **after code** |

Task 1 first. Task 2 after 1. Task 3 after 2 (factory must exist; docker branch must exist so a wired backend actually execs). Task 4 last, after code.

---

### Task 1: M0 `createMemoryTool` + core export (no docker exec yet)

**Files:**
- Modify: `packages/core/src/tools/memory.ts` (extract factory; `void backend` until Task 2)
- Modify: `packages/core/src/tools/memory.test.ts` (keep every existing test; add factory-local)
- Modify: `packages/core/src/index.ts` (`memoryTool` export ~99)

**Interfaces:**
- Consumes: today’s `memoryTool` execute path (`root = projectCwd ?? cwd`, host `readExisting` / `mkdirSync` / `writeFileSync`, leftover-ask)
- Produces:
  ```ts
  export function createMemoryTool(backend?: TerminalBackend): Tool<MemoryInput, string>
  export const memoryTool: Tool<MemoryInput, string> = createMemoryTool()
  ```
  Core barrel: `export { memoryTool, memoryFilePath, createMemoryTool } from './tools/memory'`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/tools/memory.test.ts`, change the import to:

```ts
import { createMemoryTool, memoryFilePath, memoryTool } from './memory'
```

Keep every existing `describe('Memory')` test on the **singleton** `memoryTool`. Add inside that describe:

```ts
  test('createMemoryTool without backend still adds MEMORY.md', async () => {
    const root = fixtureRoot()
    const tool = createMemoryTool()
    expect(tool.name).toBe('Memory')
    expect(tool.isConcurrencySafe({ action: 'add', target: 'agent', text: 'x' })).toBe(false)
    expect(tool.isReadOnly({ action: 'add', target: 'agent', text: 'x' })).toBe(false)
    expect(tool.interruptBehavior?.()).toBe('block')
    const out = await tool.execute(
      { action: 'add', target: 'agent', text: 'Prefer bun test.' },
      makeCtx(root),
    )
    expect(out).toContain('MEMORY.md')
    expect(readFileSync(memoryFilePath(root, 'agent'), 'utf8')).toBe('Prefer bun test.\n')
  })
```

Do not rewrite existing singleton tests to use the factory. Do not add a docker-kind test yet (Task 2 would have to flip it).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/tools/memory.test.ts`

Expected: FAIL — `createMemoryTool` is not exported. Existing singleton add / replace / remove / cap / leftover-ask tests still PASS (do not break them).

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/tools/memory.ts` — add the type import and extract the current tool object into `createMemoryTool`. Accept `backend` so callers can pass it. **Do not take the docker exec branch yet** (Task 2):

```ts
import type { TerminalBackend } from './terminal-backend'
```

Replace `export const memoryTool: Tool<MemoryInput, string> = { ... }` with:

```ts
export function createMemoryTool(
  backend?: TerminalBackend,
): Tool<MemoryInput, string> {
  return {
    name: 'Memory',
    description:
      'Add, replace, or remove a paragraph in project memory. target "agent" writes .ravenclaw/MEMORY.md; "user" writes .ravenclaw/USER.md. replace/remove require match (first exact occurrence). Refuses writes over 8000 characters.',
    inputSchema,
    parse(input: unknown) {
      return parseWithSchema<MemoryInput>(inputSchema, input)
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return false
    },
    interruptBehavior() {
      return 'block'
    },
    async checkPermissions(input: MemoryInput) {
      const file = input.target === 'agent' ? 'MEMORY.md' : 'USER.md'
      return { behavior: 'ask', message: `Update .ravenclaw/${file}?`, saveAs: 'session' }
    },
    async execute(input: MemoryInput, ctx: ToolContext) {
      void backend
      if (ctx.signal.aborted) throw abortError()
      const root = ctx.turn.projectCwd ?? ctx.turn.cwd
      const path = memoryFilePath(root, input.target)
      const existing = readExisting(path)
      const next = nextBody(existing, input)
      if (next.error !== undefined) return next.error
      if (next.body.length > MEMORY_FILE_CHAR_CAP) {
        return `Memory failed: file would exceed ${MEMORY_FILE_CHAR_CAP} characters; consolidate first`
      }
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, next.body, 'utf8')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `Memory failed: ${message}`
      }
      return `Updated .ravenclaw/${input.target === 'agent' ? 'MEMORY.md' : 'USER.md'}`
    },
  }
}

export const memoryTool: Tool<MemoryInput, string> = createMemoryTool()
```

`nextBody` / `appendParagraph` / `readExisting` / `abortError` stay as they are. Do not import `isInTreePath` or `createWorkspaceFs` yet.

`packages/core/src/index.ts` — change the memory export:

```ts
export { memoryTool, memoryFilePath, createMemoryTool } from './tools/memory'
```

Do not edit CLI or SDK in this task (Task 3). Do not bump package version.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/tools/memory.test.ts`

Expected: PASS. Existing singleton tests that import `memoryTool` stay green. Factory-local add host-writes MEMORY.md.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/memory.ts \
  packages/core/src/tools/memory.test.ts \
  packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat: add createMemoryTool wrapping local Memory

Factory wraps today's host execute. Default export stays
the local singleton. No docker exec yet.
EOF
)"
```

---

### Task 2: M1 docker in-tree I/O + outside-cwd fail-close

**Files:**
- Modify: `packages/core/src/tools/memory.ts` (docker branch in `createMemoryTool.execute`)
- Modify: `packages/core/src/tools/memory.test.ts` (new `describe('Memory docker backend')` + local `projectCwd` lock)
- Do **not** modify `packages/core/src/tools/workspace-fs.ts`

**Interfaces:**
- Consumes: Task 1 `createMemoryTool(backend?)`; `createWorkspaceFs({ cwd, exec, signal })`; `isInTreePath(cwd, path)` with no extra roots; `createDockerTerminalBackend({ image, runCommand })`
- Produces: docker + in-tree → WorkspaceFs `stat` / `readFile` / `mkdir` / `writeFile` (tee+stdin). docker + outside cwd → exactly `Memory failed: outside workspace`, `calls.length === 0`, host file unchanged. Cap/match refuse → no `tee`. Abort throws `AbortError`. Local `projectCwd` still host-writes.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/tools/memory.test.ts`, add these imports (Task 1 already added `createMemoryTool` next to `memoryTool`):

```ts
import {
  createDockerTerminalBackend,
  createLocalTerminalBackend,
  createTerminalBackend,
  type TerminalRunRequest,
} from './terminal-backend'
```

Shared fake helper (copy locally; do not import from `notebook-edit.test.ts` or `workspace-fs.test.ts`):

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

function scriptOf(req: TerminalRunRequest): string {
  return req.args.at(-1) ?? ''
}

function isStatScript(script: string): boolean {
  return script.includes('EXISTS') || script.includes('kind=dir') || script.includes('__RC_FS_MISSING__')
}

function isMkdirScript(script: string): boolean {
  return /\bmkdir\b/.test(script)
}

function isReadScript(script: string): boolean {
  return script.includes('base64')
}

function isWriteScript(script: string): boolean {
  return /\btee\b/.test(script)
}
```

Inside `describe('Memory')` (singleton / local path), add the `projectCwd` lock so Task 2’s docker jail does not leak onto the local backend:

```ts
  test('local backend still writes projectCwd when that path is outside cwd', async () => {
    const project = fixtureRoot()
    const worktree = fixtureRoot()
    const out = await memoryTool.execute(
      { action: 'add', target: 'agent', text: 'Prefer bun test.' },
      makeCtx(worktree, { projectCwd: project }),
    )
    expect(out).toContain('MEMORY.md')
    expect(readFileSync(memoryFilePath(project, 'agent'), 'utf8')).toBe('Prefer bun test.\n')
    expect(existsSync(memoryFilePath(worktree, 'agent'))).toBe(false)
  })

  test('does not infer docker from turn.terminalBackend; singleton still host-writes', async () => {
    const root = fixtureRoot()
    const out = await memoryTool.execute(
      { action: 'add', target: 'agent', text: 'host path' },
      makeCtx(root, { terminalBackend: 'docker' }),
    )
    expect(out).toContain('MEMORY.md')
    expect(readFileSync(memoryFilePath(root, 'agent'), 'utf8')).toBe('host path\n')
  })
```

New `describe('Memory docker backend')`:

```ts
describe('Memory docker backend', () => {
  test('in-tree add/replace/remove go through exec; host writeFileSync is not the write path', async () => {
    const root = fixtureRoot()
    const resolved = memoryFilePath(root, 'agent')
    const original = 'alpha\nkeep beta\nalpha\n'
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(resolved, original, 'utf8')
    const calls: TerminalRunRequest[] = []
    let started = false
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: 'EXISTS file 24 1\n', stderr: '', exitCode: 0 }
      }
      if (isReadScript(script)) {
        return { stdout: Buffer.from(original, 'utf8').toString('base64'), stderr: '', exitCode: 0 }
      }
      if (isMkdirScript(script) || isWriteScript(script)) {
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'unexpected script', exitCode: 1 }
    })
    const start = backend.start
    backend.start = (opts) => {
      started = true
      return start!(opts)
    }
    const out = await createMemoryTool(backend).execute(
      { action: 'replace', target: 'agent', text: 'gamma', match: 'alpha' },
      makeCtx(root),
    )
    expect(out).toContain('MEMORY.md')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(started).toBe(false)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]?.command).toBe('docker')
    expect(calls[0]?.timeoutMs).toBe(30_000)
    expect(calls[0]?.args).toContain('-v')
    expect(calls[0]?.args).toContain(`${root}:${root}`)
    expect(calls[0]?.args).toContain('-w')
    expect(calls[0]?.args).toContain(root)
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM'])
    expect(calls[0]?.env?.ANTHROPIC_API_KEY).toBeUndefined()
    const write = calls.find((req) => isWriteScript(scriptOf(req)))
    expect(write).toBeDefined()
    expect(write?.stdin).toBe('gamma\nkeep beta\nalpha\n')
    expect(JSON.stringify(write?.args)).not.toContain('gamma')
    expect(readFileSync(resolved, 'utf8')).toBe(original)

    const removedCalls: TerminalRunRequest[] = []
    const removeBackend = fakeDocker(async (req) => {
      removedCalls.push(req)
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: 'EXISTS file 24 1\n', stderr: '', exitCode: 0 }
      }
      if (isReadScript(script)) {
        return {
          stdout: Buffer.from('gamma\nkeep beta\nalpha\n', 'utf8').toString('base64'),
          stderr: '',
          exitCode: 0,
        }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const removed = await createMemoryTool(removeBackend).execute(
      { action: 'remove', target: 'agent', text: '', match: 'keep beta\n' },
      makeCtx(root),
    )
    expect(removed).toContain('MEMORY.md')
    const removeWrite = removedCalls.find((req) => isWriteScript(scriptOf(req)))
    expect(removeWrite?.stdin).toBe('gamma\nalpha\n')
    expect(readFileSync(resolved, 'utf8')).toBe(original)
  })

  test('in-tree add of a missing file tees stdin and does not host-write', async () => {
    const root = fixtureRoot()
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: '__RC_FS_MISSING__\n', stderr: '', exitCode: 0 }
      }
      if (isMkdirScript(script) || isWriteScript(script)) {
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'unexpected script', exitCode: 1 }
    })
    const agent = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'Prefer bun test.' },
      makeCtx(root),
    )
    expect(agent).toContain('MEMORY.md')
    expect(existsSync(memoryFilePath(root, 'agent'))).toBe(false)
    const write = calls.find((req) => isWriteScript(scriptOf(req)))
    expect(write?.stdin).toBe('Prefer bun test.\n')

    const userCalls: TerminalRunRequest[] = []
    const userBackend = fakeDocker(async (req) => {
      userCalls.push(req)
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: '__RC_FS_MISSING__\n', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const user = await createMemoryTool(userBackend).execute(
      { action: 'add', target: 'user', text: 'User prefers terse diffs.' },
      makeCtx(root),
    )
    expect(user).toContain('USER.md')
    expect(existsSync(memoryFilePath(root, 'user'))).toBe(false)
    expect(userCalls.find((req) => isWriteScript(scriptOf(req)))?.stdin).toBe(
      'User prefers terse diffs.\n',
    )
  })

  test('outside-cwd on docker is Memory failed: outside workspace, zero exec, host unchanged', async () => {
    const worktree = fixtureRoot()
    const project = fixtureRoot()
    const path = memoryFilePath(project, 'agent')
    mkdirSync(join(project, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'hacked' },
      makeCtx(worktree, { projectCwd: project }),
    )
    expect(calls).toHaveLength(0)
    expect(out).toBe('Memory failed: outside workspace')
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
  })

  test('cap refuse issues no write exec and leaves the host file unchanged', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    const original = `${'A'.repeat(100)}\n`
    writeFileSync(path, original, 'utf8')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: 'EXISTS file 101 1\n', stderr: '', exitCode: 0 }
      }
      if (isReadScript(script)) {
        return { stdout: Buffer.from(original, 'utf8').toString('base64'), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'B'.repeat(MEMORY_FILE_CHAR_CAP) },
      makeCtx(root),
    )
    expect(out).toContain('8000')
    expect(calls.some((req) => isWriteScript(scriptOf(req)))).toBe(false)
    expect(calls.some((req) => req.stdin !== undefined)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  test('match not found issues no write exec and leaves the host file unchanged', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: 'EXISTS file 8 1\n', stderr: '', exitCode: 0 }
      }
      if (isReadScript(script)) {
        return { stdout: Buffer.from('keep me\n', 'utf8').toString('base64'), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const missing = await createMemoryTool(backend).execute(
      { action: 'replace', target: 'agent', text: 'x', match: 'nope' },
      makeCtx(root),
    )
    expect(missing).toBe('Memory failed: match not found')
    expect(calls.some((req) => isWriteScript(scriptOf(req)))).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
  })

  test('no daemon returns Memory failed: and does not host-write', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
      exitCode: 1,
    }))
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'hacked' },
      makeCtx(root),
    )
    expect(out).toMatch(/^Memory failed:/)
    expect(out).toContain('Cannot connect to the Docker daemon')
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
  })

  test('missing base64 returns Memory failed: and does not host-write', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')
    const backend = fakeDocker(async (req) => {
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: 'EXISTS file 8 1\n', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'base64: not found', exitCode: 127 }
    })
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'hacked' },
      makeCtx(root),
    )
    expect(out).toMatch(/^Memory failed:/)
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
  })

  test('tee fail after read leaves the host file unchanged', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')
    const backend = fakeDocker(async (req) => {
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: 'EXISTS file 8 1\n', stderr: '', exitCode: 0 }
      }
      if (isReadScript(script)) {
        return { stdout: Buffer.from('keep me\n', 'utf8').toString('base64'), stderr: '', exitCode: 0 }
      }
      if (isMkdirScript(script)) {
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'tee: not found', exitCode: 127 }
    })
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'hacked' },
      makeCtx(root),
    )
    expect(out).toMatch(/^Memory failed:/)
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
  })

  test('30s timeout returns Memory failed: and does not host-write', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'timed out',
      exitCode: 124,
    }))
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'hacked' },
      makeCtx(root),
    )
    expect(out).toMatch(/^Memory failed:/)
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
  })

  test('turn abort throws AbortError and does not stringify Memory failed:', async () => {
    const root = fixtureRoot()
    const ac = new AbortController()
    const backend = fakeDocker(async ({ signal }) => {
      return new Promise((_, reject) => {
        const fail = () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal.aborted) {
          fail()
          return
        }
        signal.addEventListener('abort', fail, { once: true })
      })
    })
    const turn = makeTurn(root)
    const ctx = { turn, signal: ac.signal, onProgress() {} }
    const pending = createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'x' },
      ctx,
    )
    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await pending.catch((error: unknown) => {
      expect(String(error)).not.toMatch(/Memory failed:/)
    })
  })

  test('createTerminalBackend docker without image stays on the host path', async () => {
    const root = fixtureRoot()
    const backend = createTerminalBackend('docker')
    expect(backend.kind).toBe('local')
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'Prefer bun test.' },
      makeCtx(root),
    )
    expect(out).toContain('MEMORY.md')
    expect(readFileSync(memoryFilePath(root, 'agent'), 'utf8')).toBe('Prefer bun test.\n')
  })

  test('local-kind backend still host-writes after the path is computed', async () => {
    const root = fixtureRoot()
    const out = await createMemoryTool(createLocalTerminalBackend()).execute(
      { action: 'add', target: 'agent', text: 'Prefer bun test.' },
      makeCtx(root),
    )
    expect(out).toContain('MEMORY.md')
    expect(readFileSync(memoryFilePath(root, 'agent'), 'utf8')).toBe('Prefer bun test.\n')
  })
})
```

Keep every existing singleton test green.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/tools/memory.test.ts`

Expected: FAIL — `createMemoryTool(docker)` still host-writes (`existsSync` is true on the missing-file add; `calls.length === 0` or no `tee`; outside-cwd docker mutates the project sidecar; abort does not reject `AbortError` from exec). Local `projectCwd` and singleton tests stay green.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/tools/memory.ts` — add:

```ts
import { isInTreePath } from '../permissions/modes'
import { createWorkspaceFs } from './workspace-fs'
```

(`TerminalBackend` is already imported from Task 1.) Helpers in this file only:

```ts
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isDockerMemory(backend?: TerminalBackend): boolean {
  return backend?.kind === 'docker'
}

async function readMemoryBody(
  path: string,
  ctx: ToolContext,
  backend?: TerminalBackend,
): Promise<string> {
  if (!isDockerMemory(backend) || backend === undefined) {
    return readExisting(path)
  }
  const fs = createWorkspaceFs({
    cwd: ctx.turn.cwd,
    exec: backend,
    signal: ctx.signal,
  })
  const st = await fs.stat(path)
  if (!st.exists) return ''
  return fs.readFile(path)
}

async function writeMemoryBody(
  path: string,
  body: string,
  ctx: ToolContext,
  backend?: TerminalBackend,
): Promise<void> {
  if (!isDockerMemory(backend) || backend === undefined) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body, 'utf8')
    return
  }
  const fs = createWorkspaceFs({
    cwd: ctx.turn.cwd,
    exec: backend,
    signal: ctx.signal,
  })
  await fs.mkdir(dirname(path))
  await fs.writeFile(path, body)
}
```

Replace the Task 1 `execute` body (`void backend` + host-only I/O) with:

```ts
    async execute(input: MemoryInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const root = ctx.turn.projectCwd ?? ctx.turn.cwd
      const path = memoryFilePath(root, input.target)
      if (isDockerMemory(backend) && !isInTreePath(ctx.turn.cwd, path)) {
        return 'Memory failed: outside workspace'
      }
      try {
        const existing = await readMemoryBody(path, ctx, backend)
        const next = nextBody(existing, input)
        if (next.error !== undefined) return next.error
        if (next.body.length > MEMORY_FILE_CHAR_CAP) {
          return `Memory failed: file would exceed ${MEMORY_FILE_CHAR_CAP} characters; consolidate first`
        }
        await writeMemoryBody(path, next.body, ctx, backend)
      } catch (error) {
        if (isAbortError(error) || ctx.signal.aborted) throw abortError()
        const message = error instanceof Error ? error.message : String(error)
        return `Memory failed: ${message}`
      }
      return `Updated .ravenclaw/${input.target === 'agent' ? 'MEMORY.md' : 'USER.md'}`
    },
```

Do not pass `ctx.turn.additionalDirectories` into `isInTreePath`. Do not call `backend.start`. Do not call `fileHistory.snapshot`. Do not edit `workspace-fs.ts`. Do not change `interruptBehavior`. Do not change `nextBody` / `appendParagraph` / `MEMORY_FILE_CHAR_CAP`. Do not reconstruct from `turn.terminalBackend`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/tools/memory.test.ts`

Expected: PASS. Existing local singleton tests still host-write. Local `projectCwd` still writes the project sidecar. Docker in-tree tees stdin and leaves the host file unchanged. Outside-cwd docker is exact `Memory failed: outside workspace` with zero exec.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/memory.ts packages/core/src/tools/memory.test.ts
git commit -m "$(cat <<'EOF'
feat: run in-tree Memory bytes through docker WorkspaceFs

Docker kind plus in-tree path uses createWorkspaceFs.
Outside cwd on docker is Memory failed: outside workspace
with zero exec. Cap and match refuse issue no write exec.
Turn abort throws AbortError.
EOF
)"
```

---

### Task 3: M2 CLI and SDK `createRootTools` wiring

**Files:**
- Modify: `packages/cli/src/engine.ts` (imports ~61; `createRootTools` ~251)
- Modify: `packages/cli/src/exec.test.ts` (`createRootTools` identity ~132–170)
- Modify: `packages/sdk/src/index.ts` (imports ~46; `createRootTools` ~151)
- Modify: `packages/sdk/src/index.test.ts` (`createRootTools` ~174–219)
- Do **not** modify `createSessionEngine`. Do **not** omit Memory from the SDK list.

**Interfaces:**
- Consumes: Task 1 `createMemoryTool`; CLI `createRootTools(store, bash?, ask?, network?, backend?)`; SDK `createRootTools(store, bash?, network?, backend?)`
- Produces: `backend !== undefined ? createMemoryTool(backend) : memoryTool`. SDK still includes Memory. Omit keeps singleton identity.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/exec.test.ts`, add `memoryTool` to the `@ravenclaw/core` import (next to `notebookEditTool`). Extend the existing backend identity tests:

```ts
  test('createRootTools with a backend does not reuse the Memory singleton', () => {
    const backend = createLocalTerminalBackend()
    const tools = createRootTools(createMemoryStore(), bashTool, askUserTool, false, backend)
    const memory = tools.find((tool) => tool.name === 'Memory')
    expect(memory).toBeDefined()
    expect(memory).not.toBe(memoryTool)
  })

  test('createRootTools without a backend keeps the Memory singleton', () => {
    const tools = createRootTools(createMemoryStore())
    expect(tools.find((tool) => tool.name === 'Memory')).toBe(memoryTool)
  })
```

Keep the name-list test unchanged (`Memory` still present, still no new tool). Existing Grep/Glob/file-tool/NotebookEdit identity tests stay.

In `packages/sdk/src/index.test.ts`, add `memoryTool` to the `@ravenclaw/core` import. Inside `describe('createRootTools')`:

```ts
  test('createRootTools with a backend does not reuse the Memory singleton', () => {
    const backend = createLocalTerminalBackend()
    const tools = createRootTools(createMemoryStore(), bashTool, false, backend)
    const memory = tools.find((tool) => tool.name === 'Memory')
    expect(memory).toBeDefined()
    expect(memory).not.toBe(memoryTool)
  })

  test('createRootTools without a backend keeps the Memory singleton', () => {
    const tools = createRootTools(createMemoryStore())
    expect(tools.find((tool) => tool.name === 'Memory')).toBe(memoryTool)
  })

  test('includes Memory with and without a backend', () => {
    const unnamed = createRootTools(createMemoryStore()).map((tool) => tool.name)
    expect(unnamed).toContain('Memory')
    expect(unnamed).not.toContain('NotebookEdit')
    const named = createRootTools(
      createMemoryStore(),
      bashTool,
      false,
      createLocalTerminalBackend(),
    ).map((tool) => tool.name)
    expect(named).toContain('Memory')
    expect(named).not.toContain('NotebookEdit')
  })
```

Keep the existing `omits NotebookEdit with and without a backend` test. SDK **must** still include Memory — do not “fix” a missing Memory by removing it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts`

Expected: FAIL — CLI and SDK `createRootTools` with a backend still return the `memoryTool` singleton. Name-list / NotebookEdit-omit / file-tool identity tests stay green. `includes Memory` PASSES today (keep it passing; do not drop Memory from `packages/sdk/src/index.ts`).

- [ ] **Step 3: Write minimal implementation**

CLI `packages/cli/src/engine.ts` — add `createMemoryTool` to the `@ravenclaw/core` import next to `memoryTool`. In `createRootTools` list, replace the bare `memoryTool` slot:

```ts
    backend !== undefined ? createMemoryTool(backend) : memoryTool,
```

Do not change `createSessionTools` signature (it already forwards `opts.backend` as the last argument of `createRootTools`). Do not add a backend field on `createSessionEngine`.

SDK `packages/sdk/src/index.ts` — add `createMemoryTool` to the `@ravenclaw/core` import next to `memoryTool`. In `createRootTools` list, replace the bare `memoryTool` slot:

```ts
    backend !== undefined ? createMemoryTool(backend) : memoryTool,
```

Do **not** add NotebookEdit to the SDK list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts ./packages/core/src/tools/memory.test.ts`

Expected: PASS. `createRootTools(store)` name list unchanged. CLI/SDK without backend keep the Memory singleton; with backend they do not. SDK still includes Memory and still omits NotebookEdit. Memory unit tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/engine.ts \
  packages/cli/src/exec.test.ts \
  packages/sdk/src/index.ts \
  packages/sdk/src/index.test.ts
git commit -m "$(cat <<'EOF'
feat: wire CLI and SDK Memory through the live backend

createRootTools passes the same TerminalBackend as Bash
when set. Omit keeps the Memory singleton. SDK still
includes Memory.
EOF
)"
```

---

### Task 4: M3 docs honesty (after code)

**Files:**
- Modify: `ARCHITECTURE.md` (openEngine bullet ~129; Memory row ~509)
- Modify: `ARCHITECTURE.ko.md` (openEngine ~126; Memory row ~410; docker sentence ~716; terminal-backend bullet ~732)
- Modify: `docs/headless.md` (Optional Docker sandbox ~46)
- Modify: `CHANGELOG.md` Unreleased ### Added (prepend one bullet)
- Modify: `docs/research/eve-analysis.md` (~191) / `eve-analysis.ko.md` (~118) one-line closer
- Modify: `docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md` (E2.1 shipped pointer ~176 — **pointer only**, do not rewrite the wave)
- Modify: `docs/superpowers/specs/2026-09-21-workspacefs-docker.md` (OUT list ~235; honesty ruling ~108)
- Modify: `docs/superpowers/specs/2026-09-21-notebookedit-docker.md` (OUT list ~174)
- Modify: `docs/superpowers/specs/2026-09-22-memory-docker.md` (Status → implemented; board waves done; leave `Shipped sha:` empty)

Spec Status stays **draft until this task**. Do not mark it implemented in Task 1–3. Do not bump package version. Do not rewrite `2026-09-15-eve-inspired-roadmap.md` except the E2.1 pointer sentence.

**Interfaces:**
- Consumes: shipped behavior from Tasks 1–3
- Produces: docs that name Memory docker I/O only when Bash is actually docker **and** the memory file sits inside `turn.cwd`; job isolation fail-closes; omit/local/image-less stays host; TodoWrite / Skill / file-history undo are **not** docker-exec

- [ ] **Step 1: Regression lock (no new product tests)**

This task is docs-only. Do not add NotebookEdit-style `dontAsk` leftover-deny tests for Memory (that would contradict current `pipeline.ts` and this door does not edit permissions). Run the Task 1–3 files as a lock:

Run: `bun test ./packages/core/src/tools/memory.test.ts ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts`

Expected: PASS (Task 1–3 already green). SDK still includes Memory. CLI without `backend` keeps the `memoryTool` singleton.

- [ ] **Step 2: Point docs at the shipped behavior**

`docs/headless.md` Optional Docker sandbox paragraph becomes: when Bash is actually docker (backend **and** image), allowed Bash, Grep/Glob, Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree, NotebookEdit bytes, **and in-tree Memory** (`.ravenclaw/MEMORY.md` / `USER.md` inside `turn.cwd`) `docker run` in that container (`-v cwd:cwd -w cwd`). Memory uses WorkspaceFs (`stat`/`readFile`, `mkdir`, `tee`+stdin). Job isolation (`projectCwd` outside `cwd`) on docker is `Memory failed: outside workspace` with no exec and no host write. Omit, local, or `createTerminalBackend('docker')` without an image keeps Grep/Glob on host `rg`/walk, file tools on the host WorkspaceFs jail, NotebookEdit on host `readFileSync`/`writeFileSync` after the cwd jail, and Memory on host `node:fs` (including the `projectCwd` sidecar). It is not a substitute for `dontAsk`. Do **not** treat this as docker-exec for TodoWrite, Skill, or file-history writers.

`ARCHITECTURE.md`:
- openEngine bullet ~129: pass the same backend object to Bash, Grep/Glob, the six file-tool factories, NotebookEdit, **and** Memory (`createMemoryTool` via `createRootTools`). Docker kind needs an image; without image, search stays host `rg`/walk, file tools stay the host WorkspaceFs jail, NotebookEdit stays host I/O after the cwd jail, and Memory stays host `node:fs`. When kind+image **and** the memory file is inside `turn.cwd`, Memory bytes exec in that container; `projectCwd` outside `cwd` on docker is `Memory failed: outside workspace`.
- Memory row ~509: leftover-ask; SDK includes Memory. Docker kind + in-tree path: WorkspaceFs exec (`stat`/`readFile`, `mkdir`, `writeFile` tee+stdin); fail-closed (`Memory failed:`; no host write). Job isolation on docker: exactly `Memory failed: outside workspace`, zero exec. Omit/local/image-less: host `node:fs` including the `projectCwd` sidecar. Abort → `AbortError` / `ABORTED_TEXT`. No `fileHistory.snapshot`. TodoWrite / Skill / file-history stay host.

`ARCHITECTURE.ko.md`:
- openEngine ~126: `TerminalBackend`는 한 번만 만들고 Bash, Grep/Glob, 여섯 파일 툴 팩토리, NotebookEdit, **Memory** (`createMemoryTool`)에 같은 객체를 넘긴다.
- Memory row ~410: leftover-ask. SDK에 있다. docker(+image)이고 파일이 `turn.cwd` 안이면 WorkspaceFs exec (`stat`/`readFile`, `mkdir`, `tee`+stdin); 실패는 `Memory failed:`(호스트 `writeFileSync` 없음). `projectCwd`가 cwd 밖인 docker는 `Memory failed: outside workspace`, exec 없음. omit/local/이미지 없는 docker는 호스트 `node:fs`(`projectCwd` 사이드카 포함). 턴 abort는 `AbortError` / `ABORTED_TEXT`. FileHistory snapshot 없음.
- docker sentence ~716 / terminal-backend bullet ~732: Bash·Grep/Glob·파일 툴·NotebookEdit·**in-tree Memory**가 같은 객체를 쓴다. docker에서 `projectCwd`가 cwd 밖이면 Memory는 `Memory failed: outside workspace`. TodoWrite·Skill·file-history writer는 호스트다. `dontAsk` 대체가 아니다.

E2.1 shipped pointer ~176: **append one sentence**, do not rewrite the wave. Add that Memory docker I/O is unparked by [`2026-09-22-memory-docker.md`](2026-09-22-memory-docker.md) (in-tree MEMORY.md/USER.md share the same port; job isolation fail-closes). Drop “Memory in container” from the remaining-OUT clause of that pointer. Leave file-history docker, LSP museum, and web UI as OUT.

`docs/research/eve-analysis.md` ~191 closer: Memory in-tree bytes share Bash’s docker port when kind+image (`docs/superpowers/specs/2026-09-22-memory-docker.md`); job isolation (`projectCwd` outside cwd) fail-closes; file-history writers stay host.

`docs/research/eve-analysis.ko.md` ~118: 같은 closer — in-tree Memory는 kind+image면 같은 포트; job isolation은 fail-close; file-history writer는 호스트.

WorkspaceFs spec `docs/superpowers/specs/2026-09-21-workspacefs-docker.md`:
- Binding 18: add a pointer that Memory docker I/O is a successor (`2026-09-22-memory-docker.md`); do not claim TodoWrite / Skill / file-history writers are docker-exec.
- Out of this closeout ~235: replace “Memory in container” with a pointer to [`2026-09-22-memory-docker.md`](2026-09-22-memory-docker.md). file-history docker stays OUT.

NotebookEdit spec `docs/superpowers/specs/2026-09-21-notebookedit-docker.md` Out of this closeout ~174: replace “Memory in container” with a pointer to [`2026-09-22-memory-docker.md`](2026-09-22-memory-docker.md). file-history docker stays OUT.

`CHANGELOG.md` Unreleased ### Added, **prepend** this one bullet:

```md
- Memory shares Bash’s `TerminalBackend` when kind+image construct docker **and** the memory file sits inside `turn.cwd`: in-tree `.ravenclaw/MEMORY.md` / `USER.md` bytes go through `createWorkspaceFs` (`stat`/`readFile`, `mkdir`, `writeFile` tee+stdin). Omit/local/`createTerminalBackend('docker')` without image stays host `node:fs` (including the `projectCwd` sidecar). Job isolation (`projectCwd` outside `cwd`) on docker returns `Memory failed: outside workspace` with zero exec and no host write. Cap/match refuse issue no write exec. Fail-closed (`Memory failed:`; no host fallback). Turn abort throws `AbortError` / `ABORTED_TEXT`. Leftover-ask unchanged. SDK still includes Memory. TodoWrite, Skill, and file-history writers stay host. Spec: [docs/superpowers/specs/2026-09-22-memory-docker.md](docs/superpowers/specs/2026-09-22-memory-docker.md). Plan: [docs/superpowers/plans/2026-09-22-memory-docker.md](docs/superpowers/plans/2026-09-22-memory-docker.md).
```

Spec `docs/superpowers/specs/2026-09-22-memory-docker.md`: set Status to **implemented**, check board M0–M3 **done** vs this worktree, leave `Shipped sha:` **empty** until the branch lands on `main`. Do not reopen file-history docker, TodoWrite/Skill docker, extra mounts, or schema.

- [ ] **Step 3: Confirm tests still pass after docs**

Run: `bun test ./packages/core/src/tools/memory.test.ts ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts`

Expected: PASS. Docs-only besides the regression lock.

- [ ] **Step 4: No package version bump**

Do not edit `package.json` version fields. Do not commit `bun.lock`.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md ARCHITECTURE.ko.md \
  docs/headless.md CHANGELOG.md \
  docs/research/eve-analysis.md docs/research/eve-analysis.ko.md \
  docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md \
  docs/superpowers/specs/2026-09-21-workspacefs-docker.md \
  docs/superpowers/specs/2026-09-21-notebookedit-docker.md \
  docs/superpowers/specs/2026-09-22-memory-docker.md
git commit -m "$(cat <<'EOF'
docs: Memory shares docker Bash backend when in-tree

Job isolation on docker fail-closes. TodoWrite, Skill,
and file-history writers stay host. Spec Status is
implemented; shipped sha waits for main.
EOF
)"
```

---

## Success checks

1. Singleton Memory tests still pass (local host I/O, cap, match, leftover-ask). Local `projectCwd` still writes the project sidecar. `turn.terminalBackend = 'docker'` on the singleton still host-writes.
2. Docker in-tree Memory add/replace/remove goes through `backend.exec` (WorkspaceFs `stat`/`readFile`/`mkdir`/`tee`) and never `writeFileSync` on the write path (host file unchanged / missing-file add does not create the host file). Tee stdin is the next body; bytes are not embedded in `bash -c`. `backend.start` is not called. Env is allowlist-only.
3. Docker + `projectCwd` outside `cwd` returns exactly `Memory failed: outside workspace`, zero exec, host file unchanged.
4. Cap refuse and `match not found` issue no write exec and leave the host file unchanged.
5. Exec fail (no daemon / missing `base64`|`tee` / 30s timeout) → `Memory failed:` and the host file is unchanged.
6. Turn abort throws `AbortError` and is not stringified as `Memory failed:`.
7. CLI/SDK pass the live backend into `createMemoryTool` when defined; omit keeps the `memoryTool` singleton. SDK still includes Memory and still omits NotebookEdit.
8. `workspace-fs.ts`, `file-history.ts`, `todo.ts`, `skill.ts`, `pipeline.ts`, and `loop/` are untouched. `createSessionEngine` still has no backend instance.

---

## Self-review

**Spec coverage:** M0 factory + local singleton + core export → Task 1. M1 docker in-tree WorkspaceFs I/O, outside-cwd fail-close, cap/match no write exec, abort `AbortError`, fail-closed, local `projectCwd` host write, image-less docker host path → Task 2. M2 CLI/SDK wiring + SDK still includes Memory → Task 3. M3 docs honesty + spec Status implemented with empty shipped sha + workspacefs/notebookedit OUT pointers + E2.1 pointer-only → Task 4. No file-history docker, no TodoWrite/Skill docker, no extra mounts, no schema bump, no `Turn.terminalImage`, no backend on `createSessionEngine`, no live docker required.

**Placeholder scan:** none. Targeted bun commands start with `./`. Commits are HEREDOC. No TBD / “similar to Task N” / empty tests. Type names match `memory.ts` (`MemoryInput`, `MemoryAction`, `MemoryTarget`, `memoryFilePath`, `createMemoryTool`, `memoryTool`).

**Type consistency:** `createMemoryTool(backend?: TerminalBackend): Tool<MemoryInput, string>`; `export const memoryTool = createMemoryTool()`; docker I/O via `createWorkspaceFs({ cwd: ctx.turn.cwd, exec: backend, signal: ctx.signal })`; jail via `isInTreePath(ctx.turn.cwd, path)` with no extra roots; fail string exact (`Memory failed: outside workspace`); cap string unchanged; abort throws `AbortError`. CLI `createRootTools(..., backend?)` and SDK `createRootTools(..., backend?)` already exist. `createSessionEngine` still has no backend instance.

**Tensions resolved (underspec only):**
- Local vs docker jail: docker-only. Local keeps today’s `projectCwd` write even when that path is outside `turn.cwd`.
- WorkspaceFs vs host `node:fs` on local: local stays `readExisting`/`mkdirSync`/`writeFileSync` so the sidecar write is not jailed.
- Missing file vs daemon fail: `fs.stat` `exists === false` → `''`; other throws → `Memory failed:`.
- Cap/match vs write exec: host-side after read; no `tee`.
- Abort vs daemon: throw `AbortError` vs return `Memory failed:`.
- Permissions: do not edit `pipeline.ts`; do not add deny-on-dontAsk tests that contradict current in-tree Memory promotion.
- SDK Memory vs NotebookEdit: Memory stays in the SDK list.
- Spec Status / shipped sha: implemented after Task 4 code+docs; sha empty until main.
