# Grep/Glob docker-exec — Implementation Plan

I'm using the writing-plans skill to create the implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Bash is actually a docker `TerminalBackend` (kind + image), Grep and Glob share that same port object: one `backend.exec` per call, POSIX walker in the container, no host `rg` / `walkFiles` fallback. Local omit/local-kind stays today’s host `rg`/walk plus git-env isolation. Read/Write/ListDir stay host WorkspaceFs jail. Spec + this plan first; then TDD in this isolated worktree.

**Architecture:** `createGrepTool(backend?)` / `createGlobTool(backend?)` wrap the existing tools. Omit or `backend.kind !== 'docker'` → host `rg` / `walkFiles`. `kind === 'docker'` → jail `workspaceFsFor.stat` then exactly one `backend.exec` (reuse `dockerRunRequest` via the backend; do not reconstruct docker from `turn.terminalBackend`). Shared script builder lives in `sandbox-search.ts` (not a Tool). CLI `openEngine` and SDK `defaultSessionTools` construct **one** `TerminalBackend` and pass that same object to `createBashTool` and to `createRootTools` / `createSessionTools`. `createSessionEngine` still has no backend instance; eval injects already-constructed tools.

**Tech Stack:** Bun, TypeScript, existing `TerminalBackend` / `createDockerTerminalBackend` / `createBashTool` / `workspaceFsFor`. Fake `runCommand` like `terminal-backend.test.ts`. No live docker required to merge.

**Spec:** `docs/superpowers/specs/2026-09-21-grep-glob-docker-exec.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers. Grep/Glob stay leftover-allow (`checkPermissions` `{ behavior: 'allow', reason: 'mode' }`).
- Default prefix small and frozen. No new always-on tool. Factories wrap Grep/Glob.
- `dontAsk` never becomes `bypass`. Docker-exec is not a leftover-ask and not a permission promotion. `dontAsk` is not isolation.
- BYOK. Ads never touch BYOK.
- Clean-room. No vendor copy. **No web UI, no Next.js BFF, no Prisma Task, no Socket.IO, no wiki, no WorkspaceFs docker I/O, no NotebookEdit docker, no `ignored`, no LSP depth.**
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push. All commands below assume cwd is this worktree.
- `createSessionEngine` stays the existing async factory and still takes **no** `TerminalBackend` instance. Do not infer search backend from the Bash Tool or from `turn.terminalBackend` (kind has no image).
- No schema version bump. Do not edit `workspace-fs.ts`, `notebook-edit.ts`, `read.ts`, `edit.ts`, `write.ts`, `list-dir.ts`, `worktree.ts`, `loop/`, or schema.
- Do not bind host `rg` into the image. Do not fail-open to host `rg` / `walkFiles` when docker exec fails.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification only.

1. **`createGrepTool(backend?: TerminalBackend)` / `createGlobTool(backend?: TerminalBackend)`.** Omit, or a backend whose `kind` is missing/`'local'` → today’s host `rg` / `walkFiles`. `kind === 'docker'` → one `backend.exec`, no host fallback. `grepTool = createGrepTool()` and `globTool = createGlobTool()` stay the local singletons.

2. **CLI `createRootTools` and SDK `createRootTools` grow an optional last `backend?: TerminalBackend`.** `createSessionTools` grows `backend?: TerminalBackend` on its opts bag. `openEngine` / SDK `defaultSessionTools` construct the backend **once** and pass that **same object** to `createBashTool(backend)` and to `createRootTools` / `createSessionTools`. Do not infer backend from the Bash Tool. When `backend` is omitted, keep the `grepTool` / `globTool` singletons (existing `createRootTools(store)` tests stay identity-stable).

3. **Shared docker walker helper is `packages/core/src/tools/sandbox-search.ts` (not a Tool).** It builds the POSIX/`rg` script and calls `backend.exec`. It does **not** import `glob.ts` / `grep.ts` (pass ignore-dir names and caps in) so there is no cycle. Host `formatHitLines` / `matchGlob` / `posixRel` / `capInMessage` stay in grep/glob. Do not export the helper from `packages/core/src/index.ts`. Do not edit `terminal-backend.ts` argv (`dockerRunRequest` reused as-is).

4. **`TerminalBackend` grows optional `readonly kind?: TerminalBackendKind`.** `createDockerTerminalBackend` sets `kind: 'docker'`. `createLocalTerminalBackend` sets `kind: 'local'`. `createTerminalBackend('docker')` without image still returns local (kind `'local'`), so search stays local — same as Bash. Existing Bash fakes that omit `kind` stay valid and are treated as local by Grep/Glob.

5. **Local `spawnSync('rg')` / `hasRipgrep()` copy env, keep `PATH`, `GIT_TERMINAL_PROMPT=0`, delete `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`.** Export `isolatedSpawnEnv()` from `grep.ts` so the unit test can fail on today’s full `process.env` inherit (a unique-cwd integration test alone can pass via `walkFiles` fallback). Do not consult `ripgrepCached` on the docker path.

6. **Fail-closed, split by cause.** Turn abort (`ctx.signal` / `AbortError` from `backend.exec`) **throws `AbortError`**. `phases.ts` already pairs that as `ABORTED_TEXT` (Grep/Glob do not set `interruptBehavior: 'block'`). Do not stringify turn abort into `Grep failed:`. No daemon, missing `find`/`grep`, or 30s timeout (`exitCode === 124` or exec error) → `Grep failed:` / `Glob failed:` string, no `walkFiles`, no host `rg`. rg/POSIX grep exit `0` or `1` (hits / no match) is success; format stdout (empty is fine).

7. **Eval fixture `sandbox-search`.** `tools: [createGrepTool(fake), createGlobTool(fake)]` where `fake` is `createDockerTerminalBackend({ image: 'bash:5', runCommand })` — not a raw `{ exec }` and not `createSessionEngine({ terminalBackend: 'docker' })`. In-tree unique file under the session cwd (jail `stat` must succeed). Provider scripts **Grep only** so fake `exec` ran **once**. Assert the tool result is the fake stdout, not a host-walk listing of the unique token. Keep `sandbox-cwd`. Copy helpers locally in `run.ts`. No live-docker eval.

8. **Worktree.** Implement in this worktree (`/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/grep-glob-docker-exec`) or a later isolated worktree. Never on `main`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/tools/terminal-backend.ts` | optional `kind` on `TerminalBackend`; local/docker factories stamp it; **argv unchanged** |
| `packages/core/src/tools/terminal-backend.test.ts` | `kind` on local / docker / docker-without-image |
| `packages/core/src/tools/grep.ts` | `createGrepTool`, `isolatedSpawnEnv`, local git-env, docker branch |
| `packages/core/src/tools/glob.ts` | `createGlobTool`, docker branch |
| `packages/core/src/tools/sandbox-search.ts` | POSIX/`rg` script + `backend.exec` once (Task 2; not a Tool) |
| `packages/core/src/tools/grep.test.ts` | factory + git-env (Task 1); docker fake `runCommand` (Task 2) |
| `packages/core/src/tools/glob.test.ts` | factory (Task 1); docker fake `runCommand` (Task 2) |
| `packages/core/src/index.ts` | export `createGrepTool`, `createGlobTool` (and `isolatedSpawnEnv` is grep-local, not required on the barrel) |
| `packages/cli/src/engine.ts` | `createRootTools` / `createSessionTools` / `openEngine` pass the Bash backend object |
| `packages/cli/src/exec.test.ts` | `createRootTools` with backend is not the singleton; names unchanged |
| `packages/sdk/src/index.ts` | same wiring on SDK `createRootTools` / `createSessionTools` / `defaultSessionTools` |
| `packages/sdk/src/index.test.ts` | SDK `createRootTools` backend instance |
| `packages/core/src/eval/run.ts` | `runSandboxSearch`; keep `runSandboxCwd` |
| `packages/core/src/eval/fixtures/sandbox-search/case.json` | new fixture |
| docs listed in Task 4 | honesty after code; spec Status stays draft until Task 4 |

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 factories + local git-env + wiring | `terminal-backend.ts` (`kind` only), `terminal-backend.test.ts` (kind cases), `grep.ts` / `glob.ts` (factories + local env; **no docker exec yet**), `grep.test.ts` / `glob.test.ts` (factory + env), `packages/core/src/index.ts`, `packages/cli/src/engine.ts`, `packages/cli/src/exec.test.ts`, `packages/sdk/src/index.ts`, `packages/sdk/src/index.test.ts` |
| 2 docker walker + fail-closed + abort | `sandbox-search.ts` (new), `grep.ts` / `glob.ts` (docker branch), `grep.test.ts` / `glob.test.ts` (docker describes) |
| 3 eval `sandbox-search` | `eval/run.ts`, `eval/fixtures/sandbox-search/case.json` |
| 4 docs honesty | `docs/headless.md`, `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`, eve-inspired E2.1 pointer, spec Status → implemented **after code**, CHANGELOG Unreleased |

Task 1 first (factories exist; docker backend still host-searches until Task 2). Task 2 after 1 (same factories, docker branch). Task 3 after 2. Task 4 last, after code.

---

### Task 1: Factories + local git-env isolation + createRootTools / SDK wiring

**Files:**
- Modify: `packages/core/src/tools/terminal-backend.ts` (`TerminalBackend` ~23, `createLocalTerminalBackend` ~61, `createDockerTerminalBackend` ~72)
- Modify: `packages/core/src/tools/terminal-backend.test.ts` (`createDockerTerminalBackend` / `createTerminalBackend` describes)
- Modify: `packages/core/src/tools/grep.ts` (factory + `isolatedSpawnEnv`; `tryRipgrep` / `hasRipgrep` env)
- Modify: `packages/core/src/tools/glob.ts` (factory wrapping today’s `execute`)
- Modify: `packages/core/src/tools/grep.test.ts`, `packages/core/src/tools/glob.test.ts`
- Modify: `packages/core/src/index.ts` (~90)
- Modify: `packages/cli/src/engine.ts` (`createRootTools` ~213, `createSessionTools` ~252, `finishOpenEngine` ~472)
- Modify: `packages/cli/src/exec.test.ts` (`createRootTools` ~75)
- Modify: `packages/sdk/src/index.ts` (`createRootTools` ~122, `createSessionTools` ~154, `defaultSessionTools` ~259)
- Modify: `packages/sdk/src/index.test.ts`

**Interfaces:**
- Consumes: existing `TerminalBackend`, `createTerminalBackend`, `createBashTool(backend)`, `grepTool`/`globTool` execute path, `workspaceFsFor.stat`
- Produces: `createGrepTool(backend?: TerminalBackend)`, `createGlobTool(backend?: TerminalBackend)`, `isolatedSpawnEnv()`, `TerminalBackend.kind?`, `createRootTools(..., backend?)`, `createSessionTools({ backend? })`

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/tools/terminal-backend.test.ts`, add to the existing describes (do not weaken argv tests):

```ts
test('stamps kind docker', () => {
  const backend = createDockerTerminalBackend({ image: 'bash:5' })
  expect(backend.kind).toBe('docker')
})
```

```ts
test('stamps kind local', () => {
  expect(createLocalTerminalBackend().kind).toBe('local')
})
```

In `describe('createTerminalBackend')`:

```ts
test('docker kind without image is local kind', () => {
  expect(createTerminalBackend('docker').kind).toBe('local')
})

test('docker kind with image is docker kind', () => {
  expect(createTerminalBackend('docker', { image: 'bash:5' }).kind).toBe('docker')
})
```

In `packages/core/src/tools/grep.test.ts`, import `createGrepTool` and add (keep every existing singleton test):

```ts
test('isolatedSpawnEnv drops foreign git vars and keeps PATH', () => {
  const prevDir = process.env.GIT_DIR
  const prevWorkTree = process.env.GIT_WORK_TREE
  const prevIndex = process.env.GIT_INDEX_FILE
  const prevPrompt = process.env.GIT_TERMINAL_PROMPT
  process.env.GIT_DIR = '/foreign-git-dir'
  process.env.GIT_WORK_TREE = '/foreign-work-tree'
  process.env.GIT_INDEX_FILE = '/foreign-index'
  delete process.env.GIT_TERMINAL_PROMPT
  try {
    const env = isolatedSpawnEnv()
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect(env.GIT_INDEX_FILE).toBeUndefined()
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.PATH).toBe(process.env.PATH)
  } finally {
    if (prevDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = prevDir
    if (prevWorkTree === undefined) delete process.env.GIT_WORK_TREE
    else process.env.GIT_WORK_TREE = prevWorkTree
    if (prevIndex === undefined) delete process.env.GIT_INDEX_FILE
    else process.env.GIT_INDEX_FILE = prevIndex
    if (prevPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT
    else process.env.GIT_TERMINAL_PROMPT = prevPrompt
  }
})

test('createGrepTool without backend still finds a unique string', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'hit.ts'), 'const UNIQUE_RAVEN_FACTORY = 1\n')
  const tool = createGrepTool()
  expect(tool.name).toBe('Grep')
  expect(tool.isConcurrencySafe({ pattern: 'x' })).toBe(true)
  expect(tool.isReadOnly({ pattern: 'x' })).toBe(true)
  const out = await tool.execute({ pattern: 'UNIQUE_RAVEN_FACTORY' }, makeCtx(root))
  expect(out).toContain('hit.ts')
  expect(out).toMatch(/UNIQUE_RAVEN_FACTORY/)
})

test('local grep still finds a unique string under foreign GIT_DIR', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'hit.ts'), 'const UNIQUE_RAVEN_GITENV = 1\n')
  const prevDir = process.env.GIT_DIR
  const prevWorkTree = process.env.GIT_WORK_TREE
  const prevIndex = process.env.GIT_INDEX_FILE
  process.env.GIT_DIR = join(root, 'not-a-git')
  process.env.GIT_WORK_TREE = join(root, 'not-a-worktree')
  process.env.GIT_INDEX_FILE = join(root, 'not-an-index')
  try {
    const out = await grepTool.execute({ pattern: 'UNIQUE_RAVEN_GITENV' }, makeCtx(root))
    expect(out).toContain('hit.ts')
    expect(out).toMatch(/UNIQUE_RAVEN_GITENV/)
  } finally {
    if (prevDir === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = prevDir
    if (prevWorkTree === undefined) delete process.env.GIT_WORK_TREE
    else process.env.GIT_WORK_TREE = prevWorkTree
    if (prevIndex === undefined) delete process.env.GIT_INDEX_FILE
    else process.env.GIT_INDEX_FILE = prevIndex
  }
})
```

In `packages/core/src/tools/glob.test.ts`:

```ts
test('createGlobTool without backend still matches **/*.ts', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'a.ts'), 'x\n')
  const tool = createGlobTool()
  expect(tool.name).toBe('Glob')
  const out = await tool.execute({ pattern: '**/*.ts' }, makeCtx(root))
  expect(resultLines(out)).toContain('a.ts')
})
```

In `packages/cli/src/exec.test.ts` `describe('createRootTools')`, import `grepTool`, `globTool`, `createLocalTerminalBackend`, `bashTool`, `askUserTool` from `@ravenclaw/core` as needed:

```ts
test('createRootTools with a backend does not reuse the Grep/Glob singletons', () => {
  const backend = createLocalTerminalBackend()
  const tools = createRootTools(createMemoryStore(), bashTool, askUserTool, false, backend)
  const grep = tools.find((tool) => tool.name === 'Grep')
  const glob = tools.find((tool) => tool.name === 'Glob')
  expect(grep).toBeDefined()
  expect(glob).toBeDefined()
  expect(grep).not.toBe(grepTool)
  expect(glob).not.toBe(globTool)
})

test('createRootTools without a backend keeps the Grep/Glob singletons', () => {
  const tools = createRootTools(createMemoryStore())
  expect(tools.find((tool) => tool.name === 'Grep')).toBe(grepTool)
  expect(tools.find((tool) => tool.name === 'Glob')).toBe(globTool)
})
```

Keep `registers the root CLI tools and not Agent` name list unchanged (`Grep` / `Glob` still present, still no new tool).

In `packages/sdk/src/index.test.ts`, add a focused describe (do not require a live session):

```ts
import { askUserTool, bashTool, createLocalTerminalBackend, createMemoryStore, globTool, grepTool } from '@ravenclaw/core'
import { createRootTools } from './index'

describe('createRootTools', () => {
  test('with a backend does not reuse the Grep/Glob singletons', () => {
    const backend = createLocalTerminalBackend()
    const tools = createRootTools(createMemoryStore(), bashTool, false, backend)
    expect(tools.find((tool) => tool.name === 'Grep')).not.toBe(grepTool)
    expect(tools.find((tool) => tool.name === 'Glob')).not.toBe(globTool)
  })

  test('without a backend keeps the Grep/Glob singletons', () => {
    const tools = createRootTools(createMemoryStore())
    expect(tools.find((tool) => tool.name === 'Grep')).toBe(grepTool)
    expect(tools.find((tool) => tool.name === 'Glob')).toBe(globTool)
  })
})
```

Do not add a Task 1 test that a docker-kind backend still host-walks (Task 2 would have to flip it).

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/tools/terminal-backend.test.ts ./packages/core/src/tools/grep.test.ts ./packages/core/src/tools/glob.test.ts ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts
```

Expected: FAIL — `kind` is undefined; `createGrepTool` / `isolatedSpawnEnv` / `createGlobTool` are not exported; `createRootTools` ignores a 5th/4th backend argument and still returns the singletons.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/tools/terminal-backend.ts` — add optional kind, stamp it, **do not touch `dockerRunRequest` argv**:

```ts
export interface TerminalBackend {
  readonly kind?: TerminalBackendKind
  exec(opts: TerminalExecOpts): Promise<TerminalExecResult>
  start?(opts: TerminalExecOpts): TerminalJob
}

export function createLocalTerminalBackend(): TerminalBackend {
  return {
    kind: 'local',
    exec(opts: TerminalExecOpts) {
      return execLocal(opts)
    },
    start(opts: TerminalExecOpts) {
      return startLocal(opts)
    },
  }
}

export function createDockerTerminalBackend(opts: DockerTerminalBackendOpts): TerminalBackend {
  return {
    kind: 'docker',
    exec(execOpts: TerminalExecOpts) {
      return execDocker(execOpts, opts)
    },
    start(execOpts: TerminalExecOpts) {
      return startDocker(execOpts, opts)
    },
  }
}
```

`packages/core/src/tools/grep.ts` — extract the current tool object into `createGrepTool`. Local execute path stays as today except env. **Do not take the docker exec branch yet** (Task 2). Accept `backend` so callers can pass it:

```ts
export function isolatedSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}

export function createGrepTool(backend?: TerminalBackend): Tool<GrepInput, string> {
  return {
    name: 'Grep',
    // description, inputSchema, parse, isConcurrencySafe, isReadOnly, checkPermissions unchanged
    async execute(input: GrepInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const cwd = ctx.turn.cwd
      const searchRoot = resolve(cwd, input.path ?? '.')
      try {
        workspaceFsFor(ctx.turn).stat(searchRoot)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `Grep failed: ${message}`
      }
      const fileFilter = input.glob ?? input.include
      void backend
      const rg = tryRipgrep(input.pattern, searchRoot, cwd, fileFilter)
      if (rg !== undefined) return rg
      return grepByWalk(input.pattern, searchRoot, cwd, fileFilter)
    },
  }
}

export const grepTool: Tool<GrepInput, string> = createGrepTool()
```

`tryRipgrep` / `hasRipgrep` `spawnSync` options grow `env: isolatedSpawnEnv()`. Do not change rg argv.

`packages/core/src/tools/glob.ts` — same factory wrap of today’s `execute`; `void backend` until Task 2. `export const globTool = createGlobTool()`.

`packages/core/src/index.ts`:

```ts
export { grepTool, createGrepTool, isolatedSpawnEnv } from './tools/grep'
export { globTool, createGlobTool } from './tools/glob'
```

CLI `createRootTools`:

```ts
export function createRootTools(
  store: SessionStore,
  bash: Tool = bashTool,
  ask: Tool = askUserTool,
  network = false,
  backend?: TerminalBackend,
): Tool[] {
  const plan = createPlanModeTools(store)
  const list = [
    readTool,
    backend !== undefined ? createGrepTool(backend) : grepTool,
    backend !== undefined ? createGlobTool(backend) : globTool,
    // ...rest unchanged
  ]
```

CLI `createSessionTools` opts grow `backend?: TerminalBackend` and pass it as the 5th argument. `finishOpenEngine`:

```ts
const backend = createTerminalBackend(terminal?.backend ?? 'local', {
  ...(terminal?.image !== undefined ? { image: terminal.image } : {}),
})
const bash = createBashTool(backend)
// ...
createSessionTools({
  // existing fields
  bash,
  backend,
  // ...
})
```

Same object — do not call `createTerminalBackend` twice.

SDK `createRootTools(store, bash = bashTool, network = false, backend?: TerminalBackend)` and `createSessionTools` / `defaultSessionTools` mirror that (`defaultSessionTools` already builds `backend` then `createBashTool(backend)`; pass `backend` through).

Do not change `engineOpts.terminalBackend: opts.config.terminal?.backend ?? 'local'` (kind-only, jail tests). Do not add a backend field on `createSessionEngine`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/tools/terminal-backend.test.ts ./packages/core/src/tools/grep.test.ts ./packages/core/src/tools/glob.test.ts ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts
```

Expected: PASS. Existing Grep/Glob local tests stay green. `createRootTools(store)` name list unchanged. Docker argv tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/terminal-backend.ts \
  packages/core/src/tools/terminal-backend.test.ts \
  packages/core/src/tools/grep.ts \
  packages/core/src/tools/grep.test.ts \
  packages/core/src/tools/glob.ts \
  packages/core/src/tools/glob.test.ts \
  packages/core/src/index.ts \
  packages/cli/src/engine.ts \
  packages/cli/src/exec.test.ts \
  packages/sdk/src/index.ts \
  packages/sdk/src/index.test.ts
git commit -m "$(cat <<'EOF'
feat: add Grep/Glob factories and isolate local rg git env

createGrepTool/createGlobTool wrap the local host path.
CLI and SDK createRootTools take the same TerminalBackend
object as Bash. Local rg/hasRipgrep drop foreign GIT_DIR.
EOF
)"
```

---

### Task 2: Docker walker + fail-closed + abort split

**Files:**
- Create: `packages/core/src/tools/sandbox-search.ts`
- Modify: `packages/core/src/tools/grep.ts` (docker branch in `createGrepTool.execute`)
- Modify: `packages/core/src/tools/glob.ts` (docker branch)
- Modify: `packages/core/src/tools/grep.test.ts` (new `describe('Grep docker backend')`)
- Modify: `packages/core/src/tools/glob.test.ts` (new `describe('Glob docker backend')`)

**Interfaces:**
- Consumes: `createDockerTerminalBackend({ image, runCommand })`, `backend.exec`, `workspaceFsFor.stat`, `formatHitLines` / `matchGlob` / `posixRel` / `capInMessage`, `DEFAULT_IGNORE_DIR_NAMES`, `WALK_MAX_FILES`, `WALK_MAX_DEPTH`
- Produces: `execSandboxSearch(backend, opts)` — one `backend.exec`, timeout 30s, `ctx.signal`. Docker Grep/Glob never call `walkFiles` / `hasRipgrep` / `tryRipgrep`.

- [ ] **Step 1: Write the failing tests**

Shared fake helper in `grep.test.ts` / `glob.test.ts` (copy locally; do not import from `terminal-backend.test.ts`):

```ts
import {
  createDockerTerminalBackend,
  createTerminalBackend,
  type TerminalRunRequest,
} from './terminal-backend'
import { createGrepTool } from './grep'

function fakeDocker(runCommand: (req: TerminalRunRequest) => Promise<{
  stdout: string
  stderr: string
  exitCode: number
}>) {
  return createDockerTerminalBackend({ image: 'bash:5', runCommand })
}
```

`describe('Grep docker backend')` in `grep.test.ts`:

```ts
test('one exec on an in-tree path; host rg/walk is not used', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'hit.ts'), 'const HOST_ONLY_GREP_TOKEN = 1\n')
  const calls: TerminalRunRequest[] = []
  let started = false
  const backend = fakeDocker(async (req) => {
    calls.push(req)
    return { stdout: 'FAKE_DOCKER_GREP:1:from-container\n', stderr: '', exitCode: 0 }
  })
  const start = backend.start
  backend.start = (opts) => {
    started = true
    return start!(opts)
  }
  const out = await createGrepTool(backend).execute(
    { pattern: 'HOST_ONLY_GREP_TOKEN' },
    makeCtx(root),
  )
  expect(calls).toHaveLength(1)
  expect(started).toBe(false)
  expect(calls[0]?.command).toBe('docker')
  expect(calls[0]?.args).toContain('-v')
  expect(calls[0]?.args).toContain(`${root}:${root}`)
  expect(calls[0]?.args).toContain('-w')
  expect(calls[0]?.args).toContain(root)
  expect(calls[0]?.timeoutMs).toBe(30_000)
  expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM'])
  expect(calls[0]?.env?.ANTHROPIC_API_KEY).toBeUndefined()
  expect(out).toContain('FAKE_DOCKER_GREP')
  expect(out).not.toContain('HOST_ONLY_GREP_TOKEN')
})

test('outside-cwd fails at jail stat and does not exec', async () => {
  const root = fixtureRoot()
  const calls: TerminalRunRequest[] = []
  const backend = fakeDocker(async (req) => {
    calls.push(req)
    return { stdout: 'should-not-run\n', stderr: '', exitCode: 0 }
  })
  const ctx = makeCtx(root)
  ctx.turn.terminalBackend = 'docker'
  const out = await createGrepTool(backend).execute(
    { pattern: 'root', path: '/etc' },
    ctx,
  )
  expect(calls).toHaveLength(0)
  expect(String(out).toLowerCase()).toMatch(/outside workspace|denied|protected/)
  expect(String(out)).toMatch(/^Grep failed:/)
})

test('no daemon returns Grep failed: and does not host-walk', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'hit.ts'), 'const HOST_ONLY_GREP_TOKEN = 1\n')
  const backend = fakeDocker(async () => ({
    stdout: '',
    stderr: 'Cannot connect to the Docker daemon',
    exitCode: 1,
  }))
  const out = await createGrepTool(backend).execute(
    { pattern: 'HOST_ONLY_GREP_TOKEN' },
    makeCtx(root),
  )
  expect(out).toMatch(/^Grep failed:/)
  expect(out).toContain('Cannot connect to the Docker daemon')
  expect(out).not.toContain('HOST_ONLY_GREP_TOKEN')
})

test('missing find returns Grep failed: and does not host-walk', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'hit.ts'), 'const HOST_ONLY_GREP_TOKEN = 1\n')
  const backend = fakeDocker(async () => ({
    stdout: '',
    stderr: 'find: not found',
    exitCode: 127,
  }))
  const out = await createGrepTool(backend).execute(
    { pattern: 'HOST_ONLY_GREP_TOKEN' },
    makeCtx(root),
  )
  expect(out).toMatch(/^Grep failed:/)
  expect(out).not.toContain('HOST_ONLY_GREP_TOKEN')
})

test('30s timeout returns Grep failed: and does not host-walk', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'hit.ts'), 'const HOST_ONLY_GREP_TOKEN = 1\n')
  const backend = fakeDocker(async () => ({
    stdout: '',
    stderr: 'timed out',
    exitCode: 124,
  }))
  const out = await createGrepTool(backend).execute(
    { pattern: 'HOST_ONLY_GREP_TOKEN' },
    makeCtx(root),
  )
  expect(out).toMatch(/^Grep failed:/)
  expect(out).not.toContain('HOST_ONLY_GREP_TOKEN')
})

test('turn abort throws AbortError and does not stringify Grep failed:', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'hit.ts'), 'x\n')
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
  const ctx = makeCtx(root)
  const pending = createGrepTool(backend).execute({ pattern: 'x' }, {
    ...ctx,
    signal: ac.signal,
  })
  ac.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await pending.catch((error: unknown) => {
    expect(String(error)).not.toMatch(/Grep failed:/)
  })
})

test('createTerminalBackend docker without image stays on the host path', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'hit.ts'), 'const LOCAL_FALLBACK_GREP_TOKEN = 1\n')
  const backend = createTerminalBackend('docker')
  expect(backend.kind).toBe('local')
  const out = await createGrepTool(backend).execute(
    { pattern: 'LOCAL_FALLBACK_GREP_TOKEN' },
    makeCtx(root),
  )
  expect(out).toContain('hit.ts')
  expect(out).toMatch(/LOCAL_FALLBACK_GREP_TOKEN/)
})
```

Keep the existing `refuses a path outside cwd` singleton test green (still no exec).

`describe('Glob docker backend')` in `glob.test.ts` — same fake shape:

```ts
test('one exec on an in-tree path; host walk is not used', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'host-only.ts'), 'x\n')
  const calls: TerminalRunRequest[] = []
  const backend = fakeDocker(async (req) => {
    calls.push(req)
    return { stdout: 'FAKE_DOCKER_GLOB.ts\n', stderr: '', exitCode: 0 }
  })
  const out = await createGlobTool(backend).execute({ pattern: '**/*.ts' }, makeCtx(root))
  expect(calls).toHaveLength(1)
  expect(calls[0]?.args).toContain(`${root}:${root}`)
  expect(calls[0]?.timeoutMs).toBe(30_000)
  expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM'])
  expect(out).toContain('FAKE_DOCKER_GLOB.ts')
  expect(out).not.toContain('host-only.ts')
})

test('outside-cwd fails at jail stat and does not exec', async () => {
  const root = fixtureRoot()
  const calls: TerminalRunRequest[] = []
  const backend = fakeDocker(async (req) => {
    calls.push(req)
    return { stdout: 'nope\n', stderr: '', exitCode: 0 }
  })
  const ctx = makeCtx(root)
  ctx.turn.terminalBackend = 'docker'
  const out = await createGlobTool(backend).execute({ pattern: '*', path: '/etc' }, ctx)
  expect(calls).toHaveLength(0)
  expect(String(out).toLowerCase()).toMatch(/outside workspace|denied|protected/)
  expect(String(out)).toMatch(/^Glob failed:/)
})

test('missing find returns Glob failed: and does not host-walk', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'host-only.ts'), 'x\n')
  const backend = fakeDocker(async () => ({
    stdout: '',
    stderr: 'find: not found',
    exitCode: 127,
  }))
  const out = await createGlobTool(backend).execute({ pattern: '**/*.ts' }, makeCtx(root))
  expect(out).toMatch(/^Glob failed:/)
  expect(out).not.toContain('host-only.ts')
})

test('turn abort throws AbortError and does not stringify Glob failed:', async () => {
  const root = fixtureRoot()
  writeFileSync(join(root, 'a.ts'), 'x\n')
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
  const ctx = makeCtx(root)
  const pending = createGlobTool(backend).execute({ pattern: '**/*.ts' }, {
    ...ctx,
    signal: ac.signal,
  })
  ac.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
})
```

Optional live `bash:5` test (skip when daemon/image absent; never fail-open production because CI skipped). Put it in `grep.test.ts`:

```ts
test('live bash:5 grep finds an in-tree file when docker is ready', async () => {
  const probe = spawnSync('docker', ['image', 'inspect', 'bash:5'], {
    stdio: 'ignore',
    timeout: 2000,
  })
  if (probe.error !== undefined || probe.status !== 0) return
  const root = fixtureRoot()
  writeFileSync(join(root, 'live.ts'), 'const LIVE_DOCKER_GREP_TOKEN = 1\n')
  const backend = createDockerTerminalBackend({ image: 'bash:5' })
  const out = await createGrepTool(backend).execute(
    { pattern: 'LIVE_DOCKER_GREP_TOKEN' },
    makeCtx(root),
  )
  expect(out).toContain('live.ts')
  expect(out).toMatch(/LIVE_DOCKER_GREP_TOKEN/)
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/tools/grep.test.ts ./packages/core/src/tools/glob.test.ts
```

Expected: FAIL — `createGrepTool(docker)` still host-walks (`HOST_ONLY_GREP_TOKEN` present, `FAKE_DOCKER_GREP` absent); exec is 0; abort does not reject `AbortError` (or is not reached).

- [ ] **Step 3: Write minimal implementation**

New `packages/core/src/tools/sandbox-search.ts`. Do **not** import `grep.ts` or `glob.ts`:

```ts
import type { TerminalBackend, TerminalExecResult } from './terminal-backend'

export const SEARCH_TIMEOUT_MS = 30_000

export interface SandboxSearchOpts {
  kind: 'grep' | 'glob'
  cwd: string
  searchRoot: string
  pattern: string
  fileFilter?: string
  ignoreDirNames: readonly string[]
  maxFiles: number
  maxDepth: number
  signal: AbortSignal
}

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildSandboxSearchScript(opts: SandboxSearchOpts): string {
  const cwd = shQuote(opts.cwd)
  const root = shQuote(opts.searchRoot)
  const prune = opts.ignoreDirNames.map((name) => `-name ${shQuote(name)}`).join(' -o ')
  const findPrint = `find ${root} -maxdepth ${opts.maxDepth} \\( ${prune} \\) -prune -o -type f -print`
  if (opts.kind === 'glob') {
    return `cd ${cwd} || exit 1\n${findPrint} 2>/dev/null | head -n ${opts.maxFiles}\n`
  }
  const pattern = shQuote(opts.pattern)
  const rgIgnore = opts.ignoreDirNames
    .flatMap((dir) => [`--glob ${shQuote(`!${dir}`)}`, `--glob ${shQuote(`!${dir}/**`)}`])
    .join(' ')
  const rgFilter = opts.fileFilter !== undefined ? `--glob ${shQuote(opts.fileFilter)}` : ''
  return `cd ${cwd} || exit 1
if command -v rg >/dev/null 2>&1; then
  rg --no-heading --line-number --color=never --no-config ${rgIgnore} ${rgFilter} -- ${pattern} ${root}
  exit $?
fi
${findPrint} 2>/dev/null | head -n ${opts.maxFiles} | while IFS= read -r f; do
  grep -n -H -E -I -- ${pattern} "$f" 2>/dev/null
done
`
}

export async function execSandboxSearch(
  backend: TerminalBackend,
  opts: SandboxSearchOpts,
): Promise<TerminalExecResult> {
  return backend.exec({
    command: buildSandboxSearchScript(opts),
    cwd: opts.cwd,
    timeoutMs: SEARCH_TIMEOUT_MS,
    signal: opts.signal,
  })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
```

In `createGrepTool.execute`, after jail `stat`, **before** `tryRipgrep`:

```ts
if (backend?.kind === 'docker') {
  return grepByDocker(backend, input, ctx, searchRoot, cwd, fileFilter)
}
```

`grepByDocker` (private in `grep.ts`):

```ts
async function grepByDocker(
  backend: TerminalBackend,
  input: GrepInput,
  ctx: ToolContext,
  searchRoot: string,
  cwd: string,
  fileFilter: string | undefined,
): Promise<string> {
  try {
    const result = await execSandboxSearch(backend, {
      kind: 'grep',
      cwd,
      searchRoot,
      pattern: input.pattern,
      fileFilter,
      ignoreDirNames: DEFAULT_IGNORE_DIR_NAMES,
      maxFiles: WALK_MAX_FILES,
      maxDepth: WALK_MAX_DEPTH,
      signal: ctx.signal,
    })
    if (ctx.signal.aborted) throw abortError()
    if (result.exitCode === 0 || result.exitCode === 1) {
      let text = formatHitLines(result.stdout ?? '', cwd)
      if (fileFilter !== undefined) {
        text = text
          .split('\n')
          .filter((line) => {
            if (!line) return false
            const file = hitFile(line)
            return file !== undefined && matchGlob(fileFilter, file)
          })
          .join('\n')
        return capInMessage(text)
      }
      return text
    }
    const err = (result.stderr || result.stdout || 'docker search failed').trim()
    return capInMessage(`Grep failed: ${err}`)
  } catch (error) {
    if (isAbortError(error) || ctx.signal.aborted) throw abortError()
    const message = error instanceof Error ? error.message : String(error)
    return `Grep failed: ${message}`
  }
}
```

Do not call `hasRipgrep` / `tryRipgrep` / `walkFiles` on this branch. Do not call `backend.start`.

`createGlobTool.execute` after jail `stat`:

```ts
if (backend?.kind === 'docker') {
  return globByDocker(backend, input, ctx, searchRoot, cwd)
}
```

`globByDocker`: `execSandboxSearch({ kind: 'glob', pattern: input.pattern, ... })`. Exit `0` or `1`: split stdout lines, `posixRel` to cwd/root, `matchGlob(input.pattern, relToRoot)`, sort, `capInMessage`. Any other exit or thrown non-abort → `Glob failed:` and **no** `walkFiles`. Abort → throw `AbortError`.

Do not edit `terminal-backend.ts` argv. Do not edit `workspace-fs.ts`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/tools/grep.test.ts ./packages/core/src/tools/glob.test.ts ./packages/core/src/tools/terminal-backend.test.ts
```

Expected: PASS. Outside-cwd still no exec. Local singleton tests still host `rg`/walk. Live bash:5 test returns early when the image is missing.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/sandbox-search.ts \
  packages/core/src/tools/grep.ts \
  packages/core/src/tools/glob.ts \
  packages/core/src/tools/grep.test.ts \
  packages/core/src/tools/glob.test.ts
git commit -m "$(cat <<'EOF'
feat: run Grep and Glob through docker TerminalBackend

One backend.exec per call with a POSIX walker. Jail stat
stays first. Exec failures are Grep/Glob failed with no
host fallback. Turn abort throws AbortError.
EOF
)"
```

---

### Task 3: Eval `sandbox-search`

**Files:**
- Modify: `packages/core/src/eval/run.ts` (`EvalExpect` ~34, `runEvalDir` ~63, new `runSandboxSearch` next to `runSandboxCwd` ~257)
- Create: `packages/core/src/eval/fixtures/sandbox-search/case.json`

**Interfaces:**
- Consumes: `createGrepTool`, `createGlobTool`, `createDockerTerminalBackend`, `createSessionEngine`, `createFakeProvider` / `toolThenStop` / `drain` / `toolResultText` / `makeSession` (copy locally — already in `run.ts`)
- Produces: fixture `sandbox-search` fails the runner if host `rg`/walk ran or if `runCommand` was not called exactly once

- [ ] **Step 1: Write the failing fixture + runner so today’s tree throws `unknown eval fixture`**

`packages/core/src/eval/fixtures/sandbox-search/case.json`:

```json
{
  "prompt": "grep the in-tree unique file",
  "expect": { "sandboxSearchUsesBackend": true }
}
```

In `EvalExpect` add `sandboxSearchUsesBackend?: boolean`.

In `runEvalDir`, **before** `throw new Error(\`unknown eval fixture: ${name}\`)`:

```ts
if (name === 'sandbox-search') {
  await runSandboxSearch(spec)
  continue
}
```

Keep the `sandbox-cwd` branch unchanged (`terminalBackend: 'docker'` + `writeTool` + `/etc`-style outside path is still the Write jail beat). Do **not** Grep `/etc/passwd`. Do **not** pass `terminalBackend: 'docker'` on this engine.

```ts
async function runSandboxSearch(spec: EvalCase): Promise<void> {
  if (spec.expect.sandboxSearchUsesBackend !== true) {
    throw new Error('sandbox-search: expect.sandboxSearchUsesBackend must be true')
  }
  const cwd = mkdtempSync(join(tmpdir(), 'raven-eval-sandbox-search-'))
  const uniqueName = `unique-sandbox-search-${crypto.randomUUID()}.txt`
  const uniquePath = join(cwd, uniqueName)
  const hostToken = `SANDBOX_SEARCH_HOST_TOKEN_${crypto.randomUUID().slice(0, 8)}`
  writeFileSync(uniquePath, `${hostToken}\n`)
  const calls: Array<{ command: string; args: string[] }> = []
  try {
    const fakeBackend = createDockerTerminalBackend({
      image: 'bash:5',
      runCommand: async (req) => {
        calls.push({ command: req.command, args: req.args })
        return { stdout: 'FAKE_DOCKER_GREP:1:from-container\n', stderr: '', exitCode: 0 }
      },
    })
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_eval_sandbox_search', cwd })
    await store.createSession(session)
    const engine = await createSessionEngine({
      session,
      provider: createFakeProvider([
        toolThenStop('call_eval_grep', 'Grep', {
          pattern: hostToken,
          path: uniqueName,
        }),
        textThenStop('done'),
      ]),
      store,
      tools: [createGrepTool(fakeBackend), createGlobTool(fakeBackend)],
      compact: defaultCompact(),
      model: defaultModel(),
      maxRounds: 8,
      bare: true,
      askUser: async () => 'allow',
    })
    await drain(engine.submitMessage(spec.prompt))
    const loaded = await store.loadSession(session.id)
    const text = toolResultText(loaded.messages)
    if (calls.length !== 1) {
      throw new Error(`sandbox-search: expected one backend exec, got ${calls.length}`)
    }
    if (calls[0]?.command !== 'docker') {
      throw new Error(`sandbox-search: expected docker exec, got ${calls[0]?.command}`)
    }
    if (!calls[0]?.args.includes(`${cwd}:${cwd}`) || !calls[0]?.args.includes('-w')) {
      throw new Error('sandbox-search: docker argv missing cwd bind')
    }
    if (!text.includes('FAKE_DOCKER_GREP')) {
      throw new Error(`sandbox-search: expected fake stdout, got ${JSON.stringify(text)}`)
    }
    if (text.includes(hostToken)) {
      throw new Error('sandbox-search: host rg/walk ran')
    }
    await engine.close()
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}
```

Import `createGrepTool`, `createGlobTool`, `createDockerTerminalBackend` from the tools (or the core barrel already used in `run.ts`). Copy no helpers from `session-engine.test.ts`. Unknown directory names still throw.

- [ ] **Step 2: Run eval tests**

```bash
bun test ./packages/core/src/eval/run.test.ts
```

Expected: FAIL on current Task-1-only tree (`unknown eval fixture: sandbox-search`, or after the dispatch lands but before Task 2: host token in the result / `calls.length === 0`). After Task 2: PASS. `sandbox-cwd` stays green.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/eval/run.ts \
  packages/core/src/eval/fixtures/sandbox-search/case.json
git commit -m "$(cat <<'EOF'
test: lock Grep/Glob docker-exec in sandbox-search eval

Inject createGrepTool/createGlobTool with a fake docker
runCommand on an in-tree file. One exec. No host rg.
EOF
)"
```

---

### Task 4: Docs honesty (after code)

**Files:**
- Modify: `docs/headless.md` (~46)
- Modify: `ARCHITECTURE.md` (openEngine bullet ~129; Grep/Glob rows ~491)
- Modify: `ARCHITECTURE.ko.md` (Grep/Glob row ~396; docker sentence ~714)
- Modify: `docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md` (E2.1 ~161 — pointer only)
- Modify: `docs/superpowers/specs/2026-09-21-grep-glob-docker-exec.md` (Status → implemented; board waves done; shipped sha)
- Modify: `CHANGELOG.md` Unreleased
- Modify: `docs/research/eve-analysis.md` / `eve-analysis.ko.md` one-line closer if they still say file tools never use the docker port

Spec Status stays **draft until this task**. Do not mark it implemented in Task 1–3.

- [ ] **Step 1: Point docs at the shipped behavior**

`docs/headless.md` Optional Docker sandbox paragraph becomes: when Bash is actually docker (backend **and** image), Grep/Glob `docker run` in that container (`-v cwd:cwd -w cwd`); omit/local/`createTerminalBackend('docker')` without image stays host `rg`/walk. Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree stay host WorkspaceFs jail (in-tree paths are the same inodes as the cwd bind). It is not a substitute for `dontAsk`. Do **not** claim Read/Write are docker-exec.

`ARCHITECTURE.md` / `.ko.md`: Grep/Glob notes — share Bash’s `TerminalBackend`; one exec; POSIX walker; fail-closed; turn abort → `AbortError` / `ABORTED_TEXT`. openEngine bullet: pass the same backend object to Bash and Grep/Glob. Korean file must not lag.

E2.1 historical “missing” line: Grep/Glob unparked by `2026-09-21-grep-glob-docker-exec.md`; WorkspaceFs docker-exec (Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree `docker exec cat`) still parked. NotebookEdit docker, `ignored`, LSP depth, web UI stay OUT.

After code ships, set spec Status to **implemented**, check waves S0–S2 done, record the sha. Do not reopen schema, `ignored`, LSP, or WorkspaceFs docker.

- [ ] **Step 2: Commit**

```bash
git add docs/headless.md ARCHITECTURE.md ARCHITECTURE.ko.md \
  CHANGELOG.md \
  docs/superpowers/specs/2026-09-21-grep-glob-docker-exec.md \
  docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md \
  docs/research/eve-analysis.md docs/research/eve-analysis.ko.md
git commit -m "$(cat <<'EOF'
docs: Grep/Glob share docker Bash backend

Host rg/walk remains the local path. Read/Write stay the
host WorkspaceFs jail. Parallel doors stay OUT.
EOF
)"
```

---

## Success checks

1. Docker Bash backend + fake `runCommand`: Grep/Glob invoke that backend **once** on an **in-tree** path; host `rg` / `walkFiles` is not used; argv contains `-v cwd:cwd` and `-w cwd`; env is allowlist-only.
2. Outside-cwd Grep/Glob still fails at `workspaceFsFor.stat` with no exec.
3. Docker exec failure (no daemon / missing `find` / 30s timeout) returns `Grep failed:` / `Glob failed:` and does not walk the host tree. Turn abort throws `AbortError` (phases pair `ABORTED_TEXT`) and is not stringified as `Grep failed:`.
4. Local Grep still uses `rg`/walk; `isolatedSpawnEnv` drops `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`; unique cwd still hits under foreign git vars.
5. `sandbox-cwd` eval stays green. New `sandbox-search` eval is green with `createGrepTool(fakeBackend)` (not kind-only `terminalBackend`).
6. Read/Write/ListDir `terminalBackend = 'docker'` outside-cwd tests stay green (still host jail). `createRootTools(store)` still lists `Grep`/`Glob` and keeps singleton identity when backend is omitted.
7. `createTerminalBackend('docker')` without image: search stays local. SDK/CLI pass the same backend object given to `createBashTool`.

---

## Self-review

**Spec coverage:** S0.1 factories + wiring → Task 1. S0.2 local rg env → Task 1. S1.1 walker + S1.2 fail-closed/jail/abort → Task 2. S2.1 eval → Task 3. S2.2 docs + spec Status → Task 4 (after code). Read stays host jail. No schema bump. No new default tool.

**Placeholder scan:** none. Targeted bun commands start with `./`. Commits are HEREDOC. No TBD / “similar to Task N” / empty tests.

**Type consistency:** `createGrepTool(backend?: TerminalBackend)` / `createGlobTool(backend?: TerminalBackend)`; `TerminalBackend.kind?: 'local' | 'docker'`; CLI `createRootTools(store, bash, ask, network, backend?)`; SDK `createRootTools(store, bash, network, backend?)`; `createSessionTools({ backend? })`. `createSessionEngine` still has no backend instance.

**Tensions resolved (underspec only):**
- How to tell docker from local without reconstructing from `turn.terminalBackend`: optional `kind` stamped by the factories.
- `createRootTools` currently takes a Bash Tool, not a backend: grow optional `backend` and pass the same object `createBashTool` received.
- `sandbox-search.ts` must not import `glob.ts` (cycle): ignore-dir names and caps are arguments.
- Unique-cwd-only git-env test can pass via `walkFiles` fallback: export and test `isolatedSpawnEnv()`.
- Eval `createSessionEngine` has no backend instance: inject `createGrepTool(fake)` / `createGlobTool(fake)`; Grep-only provider script so exec ran once.
- Abort vs daemon: throw `AbortError` vs return `Grep failed:` / `Glob failed:`.
