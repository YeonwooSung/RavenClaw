# Child-session honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a parent steer a live background Agent via `TaskSteer` / `/tasks steer`, and report whether the child's worktree was kept dirty or pruned.

**Architecture:** `TaskRegistry` holds a process-local engine handle (`attachEngine` + `steer` → `enqueueSteer`). `TaskSteer` is a read-only sibling of `TaskOutput`. `prepareChildWorktree().cleanup()` returns `{ path, dirty, pruned }`; `spawnChild` appends that as the last JSON line of the child tool result.

**Tech Stack:** Bun, TypeScript, existing `SessionEngine.enqueueSteer` / `injectMidTurnHint`, git worktrees under `.ravenclaw/worktrees/`.

**Spec:** `docs/superpowers/specs/2026-09-12-ravenclaw-child-session-honesty.md`

## Global Constraints

- One `queryLoop`. Hosts still only call `submitMessage`.
- Persist-before-execute and pairing stay law. Steer does not re-execute tools.
- `dontAsk` is not `bypass`.
- `TaskSteer` is root-only. Children cannot steer siblings (`NESTING_DENIED`).
- Targeted `bun test` only. Never run full-repo `bun test` (Docker hang).
- Do not implement Discord, pairing, delivery ledger, `execute_code`, auto-GC, or change parent `/steer`.
- Do not edit `packages/cli/src/slack/**`.

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/tasks/registry.ts` | `attachEngine`, `steer`; extend `parseTasksArg` |
| `packages/core/src/tools/task.ts` | `taskSteerTool` |
| `packages/core/src/tools/worktree.ts` | `created` + `cleanup(): WorktreeCleanupReport` |
| `packages/core/src/tools/agent.ts` | `attachEngine` after `createSessionEngine`; append worktree JSON |
| `packages/core/src/agent/root.ts` | add `TaskSteer` to `rootAgent.toolNames` |
| `packages/core/src/agent/definition.ts` | add `TaskSteer` to `NESTING_DENIED` |
| `packages/core/src/permissions/modes.ts` | add `TaskSteer` to `READ_ONLY_NAMES` |
| `packages/core/src/index.ts` | export `taskSteerTool` |
| `packages/cli/src/engine.ts` | register `taskSteerTool` in `createRootTools` |
| `packages/cli/src/commands.ts` | `/tasks` usage |
| `packages/cli/src/app.tsx`, `opentui-app.ts` | `/tasks steer` |

---

### Task 1: TaskRegistry attachEngine + steer

**Files:**
- Modify: `packages/core/src/tasks/registry.ts`
- Test: `packages/core/src/tasks/registry.test.ts`

**Interfaces:**
- Consumes: existing `createTaskRegistry()`, `TaskKind`, `TaskStatus`
- Produces:
  - `SteerHandle = { enqueueSteer(text: string): void }`
  - `SteerResult = { ok: true } | { ok: false; error: string }`
  - `TaskRegistry.attachEngine(id: string, engine: SteerHandle): void`
  - `TaskRegistry.steer(id: string, text: string): SteerResult`

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/tasks/registry.test.ts`:

```ts
describe('attachEngine and steer', () => {
  test('live agent only; empty text and missing engine fail', () => {
    const dir = join(tmpdir(), `raven-tasks-steer-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const outputFile = join(dir, 'out.log')
    writeFileSync(outputFile, '')
    const tasks = createTaskRegistry()
    const calls: string[] = []
    const agent = tasks.register({
      type: 'agent',
      command: 'child',
      outputFile,
      kill() {},
    })
    expect(tasks.steer(agent.id, 'hello')).toEqual({
      ok: false,
      error: 'agent not started',
    })
    tasks.attachEngine(agent.id, {
      enqueueSteer(text) {
        calls.push(text)
      },
    })
    expect(tasks.steer(agent.id, '  ')).toEqual({ ok: false, error: 'empty text' })
    expect(tasks.steer(agent.id, 'hello')).toEqual({ ok: true })
    expect(calls).toEqual(['hello'])

    const bash = tasks.register({
      type: 'bash',
      command: 'sleep 1',
      outputFile,
      kill() {},
    })
    expect(tasks.steer(bash.id, 'nope')).toEqual({
      ok: false,
      error: 'not a live agent task',
    })
    expect(tasks.steer('missing', 'nope')).toEqual({
      ok: false,
      error: 'not a live agent task',
    })

    tasks.complete(agent.id, 0)
    expect(tasks.steer(agent.id, 'later')).toEqual({
      ok: false,
      error: 'not a live agent task',
    })
    expect(calls).toEqual(['hello'])
  })
})
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `bun test packages/core/src/tasks/registry.test.ts`
Expected: FAIL — `attachEngine` / `steer` are not functions.

- [ ] **Step 3: Implement**

In `packages/core/src/tasks/registry.ts`:

```ts
export type SteerHandle = { enqueueSteer(text: string): void }
export type SteerResult = { ok: true } | { ok: false; error: string }

export interface TaskRegistry {
  register(input: RegisterTaskInput): TaskSnapshot
  get(id: string): TaskSnapshot | undefined
  list(): TaskSnapshot[]
  readOutput(id: string): string | undefined
  complete(id: string, exitCode: number): TaskSnapshot | undefined
  kill(id: string): TaskSnapshot | undefined
  killAll(): TaskSnapshot[]
  attachEngine(id: string, engine: SteerHandle): void
  steer(id: string, text: string): SteerResult
}

interface LiveTask extends TaskSnapshot {
  killProcess: () => void
  engine?: SteerHandle
}
```

Add methods on the object returned by `createTaskRegistry`:

```ts
attachEngine(id, engine) {
  const task = tasks.get(id)
  if (!task || task.status !== 'running' || task.type !== 'agent') return
  task.engine = engine
},

steer(id, text) {
  const task = tasks.get(id)
  if (!task || task.type !== 'agent' || task.status !== 'running') {
    return { ok: false, error: 'not a live agent task' }
  }
  if (task.engine === undefined) return { ok: false, error: 'agent not started' }
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, error: 'empty text' }
  task.engine.enqueueSteer(text)
  return { ok: true }
},
```

In `complete` and `kill`, after changing status, set `task.engine = undefined`.

`snapshotOf` must not copy `engine` or `killProcess`.

- [ ] **Step 4: Re-run tests**

Run: `bun test packages/core/src/tasks/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tasks/registry.ts packages/core/src/tasks/registry.test.ts
git commit -m "feat: attach live child engines so TaskRegistry can steer"
```

---

### Task 2: TaskSteer tool

**Files:**
- Modify: `packages/core/src/tools/task.ts`
- Modify: `packages/core/src/index.ts` (export `taskSteerTool`)
- Test: `packages/core/src/tools/task.test.ts`

**Interfaces:**
- Consumes: `TaskRegistry.steer` from Task 1
- Produces:
  - `TaskSteerInput = { taskId: string; text: string }`
  - `taskSteerTool: Tool<TaskSteerInput, string>`
  - fail: `TaskSteer failed: <error>`
  - ok: `steered <taskId> <preview>` where preview is first 40 chars of **trimmed** text

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/tools/task.test.ts` (import `taskSteerTool` and `decidePermission` is already imported):

```ts
describe('TaskSteer', () => {
  test('is read-only allow and formats success or failure', async () => {
    expect(taskSteerTool.isReadOnly({})).toBe(true)
    const tasks = createTaskRegistry()
    const dir = join(tmpdir(), `raven-steer-tool-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const outputFile = join(dir, 'out.log')
    writeFileSync(outputFile, '')
    const agent = tasks.register({
      type: 'agent',
      command: 'child',
      outputFile,
      kill() {},
    })
    const ctx = makeCtx(tasks)
    expect((await taskSteerTool.checkPermissions({ taskId: agent.id, text: 'hi' }, ctx)).behavior).toBe(
      'allow',
    )
    const dontAsk = await decidePermission({
      name: 'TaskSteer',
      input: { taskId: agent.id, text: 'hi' },
      tool: taskSteerTool,
      ctx,
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(dontAsk.behavior).toBe('allow')

    expect(await taskSteerTool.execute({ taskId: agent.id, text: 'hi' }, ctx)).toBe(
      `TaskSteer failed: agent not started`,
    )
    tasks.attachEngine(agent.id, { enqueueSteer() {} })
    expect(await taskSteerTool.execute({ taskId: agent.id, text: 'hello from parent' }, ctx)).toBe(
      `steered ${agent.id} hello from parent`,
    )
    expect(await taskSteerTool.execute({ taskId: agent.id, text: '   ' }, ctx)).toBe(
      'TaskSteer failed: empty text',
    )
    expect(await taskSteerTool.execute({ taskId: 'missing', text: 'x' }, ctx)).toBe(
      'TaskSteer failed: not a live agent task',
    )
    const parsed = taskSteerTool.parse({ taskId: 'b_1', text: 'go' })
    expect(parsed.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `bun test packages/core/src/tools/task.test.ts`
Expected: FAIL — `taskSteerTool` is not exported.

- [ ] **Step 3: Implement**

In `packages/core/src/tools/task.ts` add (keep `task_id` on Output/Stop; Steer uses spec names `taskId` / `text`):

```ts
export interface TaskSteerInput {
  taskId: string
  text: string
}

const steerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'text'],
  properties: {
    taskId: { type: 'string', minLength: 1 },
    text: { type: 'string' },
  },
}

export const taskSteerTool: Tool<TaskSteerInput, string> = {
  name: 'TaskSteer',
  description:
    'Inject a mid-turn hint into a live background Agent started with run_in_background. Does not re-run tools. Fails if the task is Bash, finished, or not yet started.',
  inputSchema: steerSchema,
  parse(input: unknown) {
    return parseWithSchema<TaskSteerInput>(steerSchema, input)
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  interruptBehavior() {
    return 'cancel'
  },
  async checkPermissions() {
    return { behavior: 'allow', reason: 'mode' }
  },
  async execute(input: TaskSteerInput, ctx: ToolContext) {
    const tasks = ctx.tasks
    if (!tasks) return 'TaskSteer failed: no task registry'
    const result = tasks.steer(input.taskId, input.text)
    if (!result.ok) return `TaskSteer failed: ${result.error}`
    const preview = input.text.trim().slice(0, 40)
    return `steered ${input.taskId} ${preview}`
  },
}
```

In `packages/core/src/index.ts` change:

```ts
export { taskOutputTool, taskStopTool, taskSteerTool } from './tools/task'
```

- [ ] **Step 4: Re-run tests**

Run: `bun test packages/core/src/tools/task.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/task.ts packages/core/src/tools/task.test.ts packages/core/src/index.ts
git commit -m "feat: add TaskSteer tool for live background agents"
```

---

### Task 3: Root pool includes TaskSteer; children cannot

**Files:**
- Modify: `packages/core/src/agent/root.ts` — insert `'TaskSteer'` immediately after `'TaskStop'`
- Modify: `packages/core/src/agent/definition.ts` — add `'TaskSteer'` to `NESTING_DENIED`
- Modify: `packages/core/src/permissions/modes.ts` — add `'TaskSteer'` to `READ_ONLY_NAMES`
- Modify: `packages/cli/src/engine.ts` — import `taskSteerTool` and insert it after `taskStopTool` in `createRootTools`
- Test: `packages/core/src/agent/definition.test.ts` (root `toolNames` snapshot)
- Test: `packages/cli/src/exec.test.ts` (`createRootTools` name list)
- Test: `packages/core/src/tools/agent.test.ts` (`child tools list has no Agent or plan tools` — add `not.toContain('TaskSteer')`)

**Interfaces:**
- Consumes: `taskSteerTool` from Task 2
- Produces: root wire includes `TaskSteer`; `childToolNames(rootAgent)` does not

- [ ] **Step 1: Write / extend the failing assertions**

In `packages/core/src/agent/definition.test.ts` root `toolNames` array, after `'TaskStop'`:

```ts
'TaskSteer',
```

`childToolNames(rootAgent)` expected list stays **without** `TaskSteer` (denied).

In `packages/cli/src/exec.test.ts` `createRootTools` expected names, after `'TaskStop'`:

```ts
'TaskSteer',
```

In `packages/core/src/tools/agent.test.ts` test `'child tools list has no Agent or plan tools'`, add:

```ts
expect(names).not.toContain('TaskSteer')
```

- [ ] **Step 2: Run those tests and confirm they fail**

Run: `bun test packages/core/src/agent/definition.test.ts packages/cli/src/exec.test.ts packages/core/src/tools/agent.test.ts`
Expected: FAIL on the new `TaskSteer` assertions (root list missing the name; child test may still pass until the name exists in the pool).

- [ ] **Step 3: Implement the four source edits**

`root.ts` `toolNames`: `'TaskStop', 'TaskSteer', 'AskUser', ...`

`definition.ts` `NESTING_DENIED`: add `'TaskSteer'`.

`modes.ts` `READ_ONLY_NAMES`: add `'TaskSteer'`.

`engine.ts`:

```ts
import { taskOutputTool, taskStopTool, taskSteerTool } from '@ravenclaw/core'
```

In `createRootTools` list: `taskOutputTool, taskStopTool, taskSteerTool, ask, ...`

If another fixture lists root tools without `TaskSteer` (search `TaskStop` next to tool name arrays), add `TaskSteer` after `TaskStop` the same way. Do not add it to specialist child `toolNames` (file-finder, command-runner).

- [ ] **Step 4: Re-run tests**

Run: `bun test packages/core/src/agent/definition.test.ts packages/cli/src/exec.test.ts packages/core/src/tools/agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agent/root.ts packages/core/src/agent/definition.ts packages/core/src/agent/definition.test.ts packages/core/src/permissions/modes.ts packages/cli/src/engine.ts packages/cli/src/exec.test.ts packages/core/src/tools/agent.test.ts
git commit -m "feat: wire TaskSteer on the root pool and deny it to children"
```

---

### Task 4: attachEngine after background child engine create

**Files:**
- Modify: `packages/core/src/tools/agent.ts` (`spawnChild`, `startBackgroundAgent`)
- Test: `packages/core/src/tools/agent.test.ts`

**Interfaces:**
- Consumes: `TaskRegistry.attachEngine` from Task 1; `createSessionEngine` already returns `enqueueSteer`
- Produces: `spawnChild(..., childSessionId?: string, taskId?: string)` calls `ctx.tasks.attachEngine(taskId, engine)` immediately after `wrapSessionEngineLog(createSessionEngine(...))`. Sync `Agent` still omits `taskId`.

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/tools/agent.test.ts`:

```ts
test('background spawn attaches the child engine so TaskSteer works', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ravenclaw-agent-steer-attach-'))
  tempDirs.push(home)
  const savedHome = process.env.RAVENCLAW_HOME
  process.env.RAVENCLAW_HOME = home
  const session = makeSession()
  const store = createMemoryStore()
  try {
    await store.createSession(session)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: Tool = {
      ...stubTool('Read'),
      async execute(_input, ctx) {
        await new Promise<void>((resolve, reject) => {
          if (ctx.signal.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            return
          }
          const timer = setTimeout(resolve, 2_000)
          ctx.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            },
            { once: true },
          )
        })
        return 'slow-done'
      },
    }
    const provider = createFakeProvider([
      toolThenStop('r1', 'Read', { path: 'x' }),
      textThenStop('after-steer'),
    ])
    const { tool } = createTestAgent({
      store,
      provider,
      tools: parentPool().map((item) => (item.name === 'Read' ? slow : item)),
    })
    const tasks = createTaskRegistry()
    const ctx = { ...makeCtx(makeTurn(session)), tasks }
    const dispatched = JSON.parse(
      await tool.execute({ prompt: 'bg', run_in_background: true }, ctx),
    ) as { taskId: string }
    const deadline = Date.now() + 2000
    let started = false
    while (Date.now() < deadline) {
      const hit = tasks.steer(dispatched.taskId, 'turn left')
      if (hit.ok) {
        started = true
        break
      }
      expect(hit.error === 'agent not started' || hit.error === 'not a live agent task').toBe(true)
      await Bun.sleep(10)
    }
    expect(started).toBe(true)
    tasks.kill(dispatched.taskId)
  } finally {
    if (savedHome === undefined) delete process.env.RAVENCLAW_HOME
    else process.env.RAVENCLAW_HOME = savedHome
  }
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/core/src/tools/agent.test.ts`
Expected: FAIL — `steer` stays `agent not started` until timeout (`started === false`).

- [ ] **Step 3: Implement**

Change `spawnChild` signature to:

```ts
async function spawnChild(
  input: AgentChildInput,
  ctx: ToolContext,
  opts: AgentToolOpts,
  childSessionId?: string,
  taskId?: string,
): Promise<string>
```

Immediately after:

```ts
engine = wrapSessionEngineLog(createSessionEngine(engineOpts), openRavenclawLog(), {
  closeLog: false,
})
```

add:

```ts
if (taskId !== undefined) ctx.tasks?.attachEngine(taskId, engine)
```

In `startBackgroundAgent`, change the spawn call to:

```ts
void spawnChild(
  { ...input, run_in_background: false },
  bgCtx,
  opts,
  childSessionId,
  task.id,
).then(async (text) => {
```

Do not attach for the sync `Agent` path (no fifth argument).

- [ ] **Step 4: Re-run the agent tests**

Run: `bun test packages/core/src/tools/agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/agent.ts packages/core/src/tools/agent.test.ts
git commit -m "feat: attach background Agent engines for TaskSteer"
```

---

### Task 5: Worktree cleanup returns { path, dirty, pruned }

**Files:**
- Modify: `packages/core/src/tools/worktree.ts`
- Test: `packages/core/src/tools/worktree.test.ts`

**Interfaces:**
- Consumes: existing `isWorktreeDirty` / `prepareChildWorktree`
- Produces:
  - `WorktreeCleanupReport = { path: string; dirty: boolean; pruned: boolean }`
  - `ChildWorktree = { cwd: string; created: boolean; cleanup: () => WorktreeCleanupReport }`
  - `created === false` for `isolation !== 'worktree'` and non-git fallback
  - dirty: do not remove, `{ dirty: true, pruned: false }`
  - clean: remove as today, `{ dirty: false, pruned: true }`
  - `path` is always the worktree path when `created`, else the parent cwd

- [ ] **Step 1: Write the failing assertions**

Update `packages/core/src/tools/worktree.test.ts`:

```ts
test('isolation none keeps the parent cwd', () => {
  const cwd = tempDir('ravenclaw-wt-none-')
  const handle = prepareChildWorktree(cwd, 'child-1', 'none')
  expect(handle.cwd).toBe(cwd)
  expect(handle.created).toBe(false)
  expect(handle.cleanup()).toEqual({ path: cwd, dirty: false, pruned: false })
})

test('creates a detached worktree then removes it', () => {
  const cwd = tempDir('ravenclaw-wt-git-')
  initGitRepo(cwd)
  const handle = prepareChildWorktree(cwd, 'sess_child', 'worktree')
  const path = join(cwd, '.ravenclaw', 'worktrees', 'sess_child')
  expect(handle.cwd).toBe(path)
  expect(handle.created).toBe(true)
  expect(handle.cleanup()).toEqual({ path, dirty: false, pruned: true })
  expect(existsSync(path)).toBe(false)
})

test('cleanup keeps a dirty worktree', () => {
  const cwd = tempDir('ravenclaw-wt-dirty-')
  initGitRepo(cwd)
  const handle = prepareChildWorktree(cwd, 'sess_dirty', 'worktree')
  writeFileSync(join(handle.cwd, 'scratch.txt'), 'keep me\n')
  expect(handle.cleanup()).toEqual({
    path: handle.cwd,
    dirty: true,
    pruned: false,
  })
  expect(existsSync(handle.cwd)).toBe(true)
})
```

Keep the non-git fallback test: `created === false`, cleanup does not invent a worktree dir.

- [ ] **Step 2: Run worktree tests and confirm they fail**

Run: `bun test packages/core/src/tools/worktree.test.ts`
Expected: FAIL — `created` / return value missing.

- [ ] **Step 3: Implement**

Replace the public types and `cleanup` bodies in `packages/core/src/tools/worktree.ts`:

```ts
export interface WorktreeCleanupReport {
  path: string
  dirty: boolean
  pruned: boolean
}

export interface ChildWorktree {
  cwd: string
  created: boolean
  cleanup: () => WorktreeCleanupReport
}
```

Fallback:

```ts
const fallback: ChildWorktree = {
  cwd: parentCwd,
  created: false,
  cleanup: () => ({ path: parentCwd, dirty: false, pruned: false }),
}
```

Real worktree `cleanup`:

```ts
cleanup: () => {
  if (isWorktreeDirty(worktreePath)) {
    return { path: worktreePath, dirty: true, pruned: false }
  }
  const removed = runGit(toplevel, ['worktree', 'remove', worktreePath])
  if (!removed.ok && !isWorktreeDirty(worktreePath)) {
    runGit(toplevel, ['worktree', 'remove', '--force', worktreePath])
  }
  if (isWorktreeDirty(worktreePath)) {
    return { path: worktreePath, dirty: true, pruned: false }
  }
  return { path: worktreePath, dirty: false, pruned: true }
},
```

- [ ] **Step 4: Re-run worktree tests**

Run: `bun test packages/core/src/tools/worktree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/worktree.ts packages/core/src/tools/worktree.test.ts
git commit -m "feat: return worktree dirty/pruned from cleanup"
```

---

### Task 6: Append worktree JSON as the last child result line

**Files:**
- Modify: `packages/core/src/tools/agent.ts` (`spawnChild` `finally` / return)
- Test: `packages/core/src/tools/agent.test.ts`

**Interfaces:**
- Consumes: `ChildWorktree.created` and `WorktreeCleanupReport` from Task 5; `CHILD_RESULT_CHAR_BOUND` (32000) from `../agent/definition`
- Produces: `appendWorktreeLine(body: string, report: WorktreeCleanupReport): string` (local helper in `agent.ts`)

```ts
function appendWorktreeLine(body: string, report: WorktreeCleanupReport): string {
  const line = JSON.stringify({ worktree: report })
  const bound = boundChildResult(body)
  if (bound.length + 1 + line.length <= CHILD_RESULT_CHAR_BOUND) {
    return `${bound}\n${line}`
  }
  const room = Math.max(0, CHILD_RESULT_CHAR_BOUND - line.length - 1)
  return `${bound.slice(0, room)}\n${line}`
}
```

Only call when `isolated.created === true`. `isolation: none` and fallback cwd: no JSON line.

Restructure `spawnChild` so `cleanup()` runs, then the returned string is wrapped:

```ts
let result = INCOMPLETE_TEXT
let report: WorktreeCleanupReport | undefined
try {
  // existing try/catch assigns to result instead of return
} finally {
  // existing usage + unlink
  report = isolated.cleanup()
}
if (isolated.created && report) result = appendWorktreeLine(result, report)
return result
```

Every current `return childResult(...)` / `return ABORTED_TEXT` / `return boundChildResult(...)` inside the try/catch must become `result = ...`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/tools/agent.test.ts`:

```ts
test('isolation worktree dirty reports path and keeps the tree', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-agent-wt-dirty-'))
  tempDirs.push(cwd)
  initGitRepo(cwd)
  const store = createMemoryStore()
  const session = makeSession({ cwd })
  await store.createSession(session)
  const writer: Tool = {
    ...stubTool('Write'),
    async execute(_input, ctx) {
      writeFileSync(join(ctx.turn.cwd, 'scratch.txt'), 'keep\n')
      return 'wrote'
    },
  }
  const provider = createFakeProvider([
    toolThenStop('w1', 'Write', { path: 'scratch.txt', content: 'keep' }),
    textThenStop('dirty-ok'),
  ])
  const { tool } = createTestAgent({
    store,
    provider,
    tools: parentPool().map((item) => (item.name === 'Write' ? writer : item)),
  })
  const result = await tool.execute(
    { prompt: 'dirty', isolation: 'worktree' },
    makeCtx(makeTurn(session, { cwd })),
  )
  const last = result.trim().split('\n').at(-1)
  const parsed = JSON.parse(last ?? '') as {
    worktree: { path: string; dirty: boolean; pruned: boolean }
  }
  expect(parsed.worktree.dirty).toBe(true)
  expect(parsed.worktree.pruned).toBe(false)
  expect(existsSync(parsed.worktree.path)).toBe(true)
  expect(existsSync(join(parsed.worktree.path, 'scratch.txt'))).toBe(true)
})

test('isolation none does not append a worktree line', async () => {
  const store = createMemoryStore()
  const session = makeSession()
  await store.createSession(session)
  const provider = createFakeProvider([textThenStop('plain')])
  const { tool } = createTestAgent({ store, provider })
  const result = await tool.execute({ prompt: 'no wt' }, makeCtx(makeTurn(session)))
  expect(result).toBe('plain')
  expect(result).not.toContain('{"worktree"')
})
```

Reuse `initGitRepo` already in this file (same helper as the existing worktree test). If it is local to that describe, copy the helper next to the new tests.

Update existing `'isolation worktree creates then removes a git worktree'` so the last line is JSON `pruned: true` and `existsSync(path)` is still false:

```ts
expect(result.startsWith('isolated-ok')).toBe(true)
const last = result.trim().split('\n').at(-1)
const parsed = JSON.parse(last ?? '') as {
  worktree: { path: string; dirty: boolean; pruned: boolean }
}
expect(parsed.worktree.dirty).toBe(false)
expect(parsed.worktree.pruned).toBe(true)
expect(existsSync(parsed.worktree.path)).toBe(false)
```

- [ ] **Step 2: Run agent tests and confirm the new ones fail**

Run: `bun test packages/core/src/tools/agent.test.ts`
Expected: FAIL — result is still `'isolated-ok'` / `'dirty-ok'` with no JSON line.

- [ ] **Step 3: Implement `appendWorktreeLine` and the result/finally restructure**

Import `CHILD_RESULT_CHAR_BOUND` and `boundChildResult` (already imported if present; otherwise import from `../agent/definition`). Import `WorktreeCleanupReport` from `./worktree`.

Do not append when `isolated.created === false`.

- [ ] **Step 4: Re-run agent + worktree tests**

Run: `bun test packages/core/src/tools/agent.test.ts packages/core/src/tools/worktree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/agent.ts packages/core/src/tools/agent.test.ts
git commit -m "feat: append worktree dirty/pruned JSON to child results"
```

---

### Task 7: `/tasks steer <id> <text>`

**Files:**
- Modify: `packages/core/src/tasks/registry.ts` (`parseTasksArg`)
- Modify: `packages/cli/src/commands.ts` (usage/summary)
- Modify: `packages/cli/src/app.tsx`
- Modify: `packages/cli/src/opentui-app.ts`
- Test: `packages/core/src/tasks/registry.test.ts`
- Test: `packages/cli/src/commands.test.ts`

**Interfaces:**
- Consumes: `TaskRegistry.steer` from Task 1
- Produces:

```ts
export function parseTasksArg(
  arg?: string,
):
  | { action: 'list' }
  | { action: 'kill'; id: string }
  | { action: 'steer'; id: string; text: string }
  | { action: 'error'; message: string }
```

`/^steer\s+(\S+)\s+(.+)$/is` → `{ action: 'steer', id, text }` (`text` is the remainder, not trimmed beyond the regex).
`/^steer\b/i` but not that shape → `{ action: 'error', message: 'usage: /tasks [kill <id>|steer <id> <text>]' }`.
`kill` unchanged. Bare `/tasks` still lists.

Ink / OpenTUI `case 'tasks'`:

```ts
if (parsedTasks.action === 'error') {
  setNotice(parsedTasks.message) // OpenTUI: write(`${parsedTasks.message}\n`)
  return
}
if (parsedTasks.action === 'steer') {
  const out = runtimeRef.current.engine.tasks.steer(parsedTasks.id, parsedTasks.text)
  setNotice(out.ok ? `steered ${parsedTasks.id}` : `TaskSteer failed: ${out.error}`)
  return
}
```

`commands.ts`:

```ts
{
  name: 'tasks',
  usage: '/tasks [kill <id>|steer <id> <text>]',
  summary: 'list, stop, or steer background tasks',
},
```

- [ ] **Step 1: Write the failing tests**

In `registry.test.ts` `parseTasksArg` describe:

```ts
expect(parseTasksArg('steer b_abc turn left')).toEqual({
  action: 'steer',
  id: 'b_abc',
  text: 'turn left',
})
expect(parseTasksArg('steer b_abc')).toEqual({
  action: 'error',
  message: 'usage: /tasks [kill <id>|steer <id> <text>]',
})
```

In `packages/cli/src/commands.test.ts` table (next to existing `/tasks` rows):

```ts
['/tasks steer t_1 hello', { type: 'command', name: 'tasks', arg: 'steer t_1 hello' }],
```

And `expect(SLASH_HELP).toContain('/tasks')` already exists; add:

```ts
expect(SLASH_HELP).toContain('steer')
```

- [ ] **Step 2: Run command/registry tests and confirm they fail**

Run: `bun test packages/core/src/tasks/registry.test.ts packages/cli/src/commands.test.ts`
Expected: FAIL on the new `parseTasksArg` steer case.

- [ ] **Step 3: Implement parseTasksArg + slash handlers + usage**

Replace `parseTasksArg` in `registry.ts`:

```ts
export function parseTasksArg(
  arg?: string,
):
  | { action: 'list' }
  | { action: 'kill'; id: string }
  | { action: 'steer'; id: string; text: string }
  | { action: 'error'; message: string } {
  if (arg === undefined) return { action: 'list' }
  const trimmed = arg.trim()
  if (trimmed === '') return { action: 'list' }
  const kill = /^kill\s+(\S+)$/i.exec(trimmed)
  if (kill?.[1]) return { action: 'kill', id: kill[1] }
  const steer = /^steer\s+(\S+)\s+(.+)$/is.exec(trimmed)
  if (steer?.[1] && steer[2] !== undefined) {
    return { action: 'steer', id: steer[1], text: steer[2] }
  }
  if (/^steer\b/i.test(trimmed) || /^kill\b/i.test(trimmed)) {
    return { action: 'error', message: 'usage: /tasks [kill <id>|steer <id> <text>]' }
  }
  return { action: 'list' }
}
```

Wire Ink (`app.tsx`) and OpenTUI (`opentui-app.ts`) as above. OpenTUI writes a line instead of `setNotice`.

- [ ] **Step 4: Re-run tests**

Run: `bun test packages/core/src/tasks/registry.test.ts packages/cli/src/commands.test.ts packages/cli/src/opentui-app.test.ts packages/cli/src/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tasks/registry.ts packages/core/src/tasks/registry.test.ts packages/cli/src/commands.ts packages/cli/src/commands.test.ts packages/cli/src/app.tsx packages/cli/src/opentui-app.ts
git commit -m "feat: add /tasks steer for live background agents"
```

---

### Task 8: Mid-turn inject — steer does not re-run child tools

**Files:**
- Test: `packages/core/src/tools/agent.test.ts`
- Modify: only if Task 4 attach is insufficient (should not need new production code)

**Interfaces:**
- Consumes: Tasks 1–4; existing `enqueueSteer` → `injectMidTurnHint` on the child engine
- Produces: a regression test that `execute` count stays 1 after `TaskSteer`

- [ ] **Step 1: Write the failing test if the inject path is broken**

Add to `packages/core/src/tools/agent.test.ts`:

```ts
test('TaskSteer suffixes the next child tool result and does not re-execute', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ravenclaw-agent-steer-inject-'))
  tempDirs.push(home)
  const savedHome = process.env.RAVENCLAW_HOME
  process.env.RAVENCLAW_HOME = home
  const session = makeSession()
  const store = createMemoryStore()
  try {
    await store.createSession(session)
    let executes = 0
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: Tool = {
      ...stubTool('Read'),
      async execute() {
        executes += 1
        release()
        await Bun.sleep(80)
        return 'tool-body'
      },
    }
    const provider = createFakeProvider([
      toolThenStop('r1', 'Read', { path: 'x' }),
      textThenStop('final'),
    ])
    const { tool } = createTestAgent({
      store,
      provider,
      tools: parentPool().map((item) => (item.name === 'Read' ? slow : item)),
    })
    const tasks = createTaskRegistry()
    const ctx = { ...makeCtx(makeTurn(session)), tasks }
    const dispatched = JSON.parse(
      await tool.execute({ prompt: 'bg', run_in_background: true }, ctx),
    ) as { taskId: string }
    await started
    const steered = await taskSteerTool.execute(
      { taskId: dispatched.taskId, text: 'prefer grep' },
      { ...ctx, tasks },
    )
    expect(steered.startsWith(`steered ${dispatched.taskId}`)).toBe(true)
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (tasks.get(dispatched.taskId)?.status !== 'running') break
      await Bun.sleep(10)
    }
    expect(executes).toBe(1)
    const output = tasks.readOutput(dispatched.taskId) ?? ''
    expect(output).toContain('final')
  } finally {
    if (savedHome === undefined) delete process.env.RAVENCLAW_HOME
    else process.env.RAVENCLAW_HOME = savedHome
  }
})
```

Import `taskSteerTool` from `./task`.

This test asserts execute-count and completion. If `injectMidTurnHint` already works once `enqueueSteer` is called, it will pass after Task 4. Do **not** add a second execute or a new persist path.

- [ ] **Step 2: Run it**

Run: `bun test packages/core/src/tools/agent.test.ts`
Expected: PASS after Tasks 1–4. If it fails because steer races before `attachEngine`, wait in a loop like Task 4 (`steer` until `ok`) before asserting.

- [ ] **Step 3: Only if FAIL — do not invent a new inject path**

If `enqueueSteer` is not on the wrapped engine, forward it in `wrapSessionEngineLog` (`packages/core/src/log.ts`): the wrapper must expose `enqueueSteer` on the returned engine (delegate to the inner engine). Add a unit test in `packages/core/src/log.test.ts` that `wrapSessionEngineLog(engine).enqueueSteer('x')` calls `engine.enqueueSteer('x')`. That is the only allowed extra production edit.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/tools/agent.test.ts packages/core/src/log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/agent.test.ts packages/core/src/log.ts packages/core/src/log.test.ts
git commit -m "test: TaskSteer does not re-execute child tools"
```

If `log.ts` was not changed, omit it from `git add`.

---

## Spec coverage

| Spec section | Task |
|---|---|
| §1 TaskRegistry attach/steer errors | Task 1 |
| §2 TaskSteer tool + permissions + preview | Task 2 |
| §2 root-only / no sibling steer | Task 3 |
| §2 `/tasks steer` | Task 7 |
| §3 background attach after engine create | Task 4 |
| §3 sync Agent has no task id | Task 4 (no fifth arg) |
| §4 cleanup report + no auto-GC | Task 5 |
| §4 last-line JSON, bound, isolation none | Task 6 |
| §5 inject unchanged, no re-execute | Task 8 |
| Done-when 1–4 | Tasks 5–8 |

## Placeholder scan

No TBD / “handle edge cases” / “similar to Task N” without code.

## Type consistency

- `SteerHandle.enqueueSteer(text: string): void`
- `SteerResult = { ok: true } | { ok: false; error: string }`
- `TaskSteerInput = { taskId: string; text: string }` (not `task_id`)
- `WorktreeCleanupReport = { path: string; dirty: boolean; pruned: boolean }`
- `parseTasksArg` steer: `{ action: 'steer'; id: string; text: string }`
