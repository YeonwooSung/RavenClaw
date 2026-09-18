# Rewind persist-before-reset + todo.json projection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Job rewind persists the transcript drop before `git reset --hard`, and a successful rewind re-projects `.ravenclaw/todo.json` from `session.todos` under the project root.

**Architecture:** Reorder `rewindToCheckpoint` so `recordCompact` is durable before the worktree moves. Extract `projectSessionTodos` from the existing `TodoWrite` write so rewind and the tool share one pretty-print. Projection I/O fail is a notice suffix; it does not undo persist or reset and does not set `jobError`.

**Tech Stack:** Bun, TypeScript, existing `SessionStore`, `runGit`, `getSessionWorktree`, raven eval fixtures.

**Spec:** `docs/superpowers/specs/2026-09-18-rewind-persist-and-todo-projection.md`

## Global Constraints

- One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer and does not start a model turn.
- Default prefix stays small and frozen. No new always-on tool. Rewind and todo projection are session ops, not tools.
- `dontAsk` never becomes `bypass`.
- BYOK is the product. Ads never touch BYOK.
- Clean-room. Steal semantics. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**.
- `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row. Do not record that return as `lastEnd`.
- Live `/cancel` abort-pair of a parked leftover-ask stays OUT.
- Leftover-ask still wins rewind: `rewindLast` refuses when any owned unpaired pending ask exists.
- No schema bump. No automatic reset-on-resume. No-job rewind order stays persist-then-undo. `TodoWrite` persist-then-file order stays.
- Targeted `bun test ./<files>` only (path must start with `./`). Never full-repo `bun test`. Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push. Do not copy y0/eve source.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification.

1. **H0.1 already shipped** on `main` at `c851668` (PR #12). Do not re-do the pointer pass. Task 5 only updates rewind wording, CHANGELOG, and this spec’s Status/board after the code lands on this branch.

2. **H1.1 + H1.2 + H1.3 are one function.** Task 1 owns the whole `rewindToCheckpoint` reorder and the reset-fail test flip. Do not leave a half-flip where persist already ran but the test still expects originals.

3. **`rewindToCheckpoint` after Task 1:**

```ts
const next = dropLastUserTurn(opts.messages)
const droppedIds = opts.messages.slice(next.length).map((msg) => msg.id)
const checkpoint = lastAssistantCheckpoint(next)
const sha = checkpoint?.commitSha ?? job.baseCommitSha

if (droppedIds.length > 0) {
  try {
    await opts.store.recordCompact(
      opts.session.id,
      opts.session.compactGeneration,
      'rewind',
      droppedIds,
    )
  } catch {
    return { ok: false, notice: 'rewind persist failed', messages: opts.messages }
  }
}

const reset = runGit(job.worktreePath, ['reset', '--hard', sha])
if (!reset.ok) {
  const detail = reset.stderr.trim() || reset.stdout.trim() || 'git reset failed'
  const notice = `rewind reset failed: ${detail}`
  setSessionJobError(opts.session, notice)
  opts.session.updatedAt = Date.now()
  try {
    await opts.store.upsertSession(opts.session)
  } catch {
    // surface the reset failure even if jobError persist fails
  }
  return { ok: false, notice, messages: next }
}

opts.session.todos = checkpoint
  ? checkpoint.todoSnapshot.map((item) => ({ ...item }))
  : []
clearSessionJobError(opts.session)
opts.session.updatedAt = Date.now()
try {
  await opts.store.upsertSession(opts.session)
} catch {
  return { ok: false, notice: 'rewind persist failed', messages: next }
}

return {
  ok: true,
  notice: formatRewindNotice({ restored: [], removed: [] }, droppedIds.length),
  messages: next,
}
```

Persist fail: original messages, HEAD unchanged, `session.todos` unchanged, **no** `jobError`. Reset fail after persist: `messages === next`, loaded rows omit dropped ids, HEAD unchanged, `session.todos` unchanged, `setSessionJobError`.

4. **`projectSessionTodos` is the only writer of the pretty-print:**

```ts
export function projectSessionTodos(root: string, items: TodoItem[]): void {
  const path = todoJsonPath(root)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(items, null, 2)}\n`, 'utf8')
}
```

`TodoWrite.execute` must call this after `updateSessionTodos` (required DRY — do not leave a forked write). Throws on I/O; caller decides. Empty list writes `[]\n` (do not delete the file).

5. **Rewind projection (Task 3) after successful persist + reset + upsert:**

```ts
const root = getSessionWorktree(opts.session.id)?.originalCwd ?? opts.session.cwd
let notice = formatRewindNotice({ restored: [], removed: [] }, droppedIds.length)
try {
  projectSessionTodos(root, opts.session.todos ?? [])
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  notice = `${notice}; todo.json write failed: ${detail}`
}
return { ok: true, notice, messages: next }
```

Projection fail: `ok` stays `true`. No `jobError`. Session todos stay restored. Do not un-compact. Do not re-reset.

6. **Projection-fail test uses a real I/O error**, not `mock.module`: write a regular file at `<project>/.ravenclaw` so `mkdirSync`/`writeFileSync` throws. That is the spec’s “stub to throw” without ESM mock fragility.

7. **No-job rewind does not re-project.** Do not add a todo write to `rewindLastTurn`.

8. **Eval fixtures** are named `rewind-persist-before-reset` and `rewind-todo-project`. Unknown fixture names already throw in `runEvalDir` — adding directories without runners fails the existing `run.test.ts`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/session/rewind.ts` | persist-before-reset; project after upsert |
| `packages/core/src/session/rewind.test.ts` | H1 + H2 rewind contracts |
| `packages/core/src/tools/todo.ts` | `projectSessionTodos`; `TodoWrite` calls it |
| `packages/core/src/tools/todo.test.ts` | helper bytes + empty `[]\n` |
| `packages/core/src/index.ts` | export `projectSessionTodos` |
| `packages/core/src/eval/run.ts` | two new fixture runners |
| `packages/core/src/eval/run.test.ts` | already runs the whole dir |
| `packages/core/src/eval/fixtures/rewind-persist-before-reset/case.json` | persist-fail + success order |
| `packages/core/src/eval/fixtures/rewind-todo-project/case.json` | file equals session.todos |
| `ARCHITECTURE.md` / `.ko.md`, `SLASH_COMMANDS.md` / `.ko.md`, `CHANGELOG.md` | persist-first wording |
| spec file | Status + board after code |

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 persist-before-reset | `rewind.ts`, `rewind.test.ts` (H1 tests only; no todo.json assertions) |
| 2 `projectSessionTodos` | `todo.ts`, `todo.test.ts`, `index.ts` (export only) |
| 3 rewind re-project | `rewind.ts`, `rewind.test.ts` (H2 tests only) |
| 4 eval | `eval/run.ts`, `eval/fixtures/rewind-persist-before-reset/case.json`, `eval/fixtures/rewind-todo-project/case.json` |
| 5 docs | `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`, `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-09-18-rewind-persist-and-todo-projection.md` |

Task 1 vs Task 3 both touch `rewind.ts` — **do not parallel**. Task 2 may run only after Task 1 is complete (Task 3 imports the helper). Task 4 after Task 3.

---

### Task 1: Persist-before-reset (H1.1 + H1.2 + H1.3)

**Files:**
- Modify: `packages/core/src/session/rewind.ts`, `packages/core/src/session/rewind.test.ts`

**Interfaces:**
- Consumes: `recordCompact`, `runGit`, `setSessionJobError`, `clearSessionJobError`, `dropLastUserTurn`
- Produces: `rewindToCheckpoint` order = persist (if dropped ids) then `git reset --hard`; persist fail returns originals; reset fail after persist returns `next`

- [ ] **Step 1: Write the failing tests**

In `describe('rewindToCheckpoint')`, add two tests after the existing persist/reset cases. Reuse `tempDir`, `nextSession`, `initGitRepo`, `git`, `sessionRecord`, `user`, `assistant`.

```ts
test('persist fail leaves HEAD and original messages and does not set jobError', async () => {
  const cwd = tempDir('ravenclaw-rewind-persist-fail-')
  initGitRepo(cwd)
  const id = nextSession()
  const entered = enterSessionWorktree(id, cwd)
  expect(entered.ok).toBe(true)
  const job = entered.job!
  writeFileSync(join(job.worktreePath, 'extra.txt'), 'later\n')
  expect(spawnSync('git', ['add', '-A'], { cwd: job.worktreePath, encoding: 'utf8' }).status).toBe(0)
  expect(
    spawnSync('git', ['commit', '-m', 'later'], { cwd: job.worktreePath, encoding: 'utf8' }).status,
  ).toBe(0)
  const laterSha = git(job.worktreePath, ['rev-parse', 'HEAD'])
  expect(laterSha).not.toBe(job.baseCommitSha)

  const store = createMemoryStore()
  const sess = sessionRecord({
    id,
    cwd: job.worktreePath,
    job,
    todos: [{ text: 'keep', status: 'pending' }],
  })
  await store.createSession(sess)
  const messages: Message[] = [user('u1', 'only', 1), assistant('a1', 'ok', 2)]
  await store.persistUser(id, messages[0] as Extract<Message, { role: 'user' }>)
  await store.persistAssistant(id, messages[1] as Extract<Message, { role: 'assistant' }>)
  store.recordCompact = async () => {
    throw new Error('disk full')
  }

  const result = await rewindToCheckpoint({ session: sess, messages, store })
  expect(result.ok).toBe(false)
  expect(result.notice).toBe('rewind persist failed')
  expect(result.messages).toBe(messages)
  expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(laterSha)
  expect(sess.todos).toEqual([{ text: 'keep', status: 'pending' }])
  expect(sess.jobError).toBeUndefined()
  const loaded = await store.loadSession(id)
  expect(loaded.messages.map((msg) => msg.id)).toEqual(['u1', 'a1'])
  expect(loaded.session.jobError).toBeUndefined()
})

test('recordCompact runs while HEAD is still the later sha', async () => {
  const cwd = tempDir('ravenclaw-rewind-persist-order-')
  initGitRepo(cwd)
  const id = nextSession()
  const entered = enterSessionWorktree(id, cwd)
  expect(entered.ok).toBe(true)
  const job = entered.job!
  writeFileSync(join(job.worktreePath, 'extra.txt'), 'later\n')
  expect(spawnSync('git', ['add', '-A'], { cwd: job.worktreePath, encoding: 'utf8' }).status).toBe(0)
  expect(
    spawnSync('git', ['commit', '-m', 'later'], { cwd: job.worktreePath, encoding: 'utf8' }).status,
  ).toBe(0)
  const laterSha = git(job.worktreePath, ['rev-parse', 'HEAD'])

  const store = createMemoryStore()
  const sess = sessionRecord({ id, cwd: job.worktreePath, job })
  await store.createSession(sess)
  const messages: Message[] = [user('u1', 'only', 1), assistant('a1', 'ok', 2)]
  await store.persistUser(id, messages[0] as Extract<Message, { role: 'user' }>)
  await store.persistAssistant(id, messages[1] as Extract<Message, { role: 'assistant' }>)
  const headsDuringPersist: string[] = []
  const orig = store.recordCompact.bind(store)
  store.recordCompact = async (sessionId, generation, summary, ids) => {
    headsDuringPersist.push(git(job.worktreePath, ['rev-parse', 'HEAD']))
    return orig(sessionId, generation, summary, ids)
  }

  const result = await rewindToCheckpoint({ session: sess, messages, store })
  expect(result.ok).toBe(true)
  expect(headsDuringPersist).toEqual([laterSha])
  expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(job.baseCommitSha)
})
```

Rename and flip the existing test `reset failure does not inactivate messages and returns originals` to:

```ts
test('reset failure after persist keeps the drop, sets jobError, and does not apply todos', async () => {
  const cwd = tempDir('ravenclaw-rewind-reset-fail-')
  initGitRepo(cwd)
  const id = nextSession()
  const entered = enterSessionWorktree(id, cwd)
  expect(entered.ok).toBe(true)
  const job = entered.job!
  job.baseCommitSha = 'not-a-real-commit-sha'
  const store = createMemoryStore()
  const sess = sessionRecord({
    id,
    cwd: job.worktreePath,
    job,
    todos: [{ text: 'keep', status: 'pending' }],
  })
  await store.createSession(sess)
  const messages: Message[] = [user('u1', 'only', 1), assistant('a1', 'ok', 2)]
  await store.persistUser(id, messages[0] as Extract<Message, { role: 'user' }>)
  await store.persistAssistant(id, messages[1] as Extract<Message, { role: 'assistant' }>)
  const inactivated: string[] = []
  const orig = store.recordCompact.bind(store)
  store.recordCompact = async (sessionId, generation, summary, ids) => {
    inactivated.push(...ids)
    return orig(sessionId, generation, summary, ids)
  }

  const headBefore = git(job.worktreePath, ['rev-parse', 'HEAD'])
  const result = await rewindToCheckpoint({ session: sess, messages, store })
  expect(result.ok).toBe(false)
  expect(result.notice.startsWith('rewind reset failed:')).toBe(true)
  expect(result.messages.map((msg) => msg.id)).toEqual([])
  expect(inactivated).toEqual(['u1', 'a1'])
  expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(headBefore)
  expect(sess.todos).toEqual([{ text: 'keep', status: 'pending' }])
  expect(sess.jobError?.startsWith('rewind reset failed:')).toBe(true)
  const loaded = await store.loadSession(id)
  expect(loaded.messages.map((msg) => msg.id)).toEqual([])
  expect(loaded.session.jobError?.startsWith('rewind reset failed:')).toBe(true)
})
```

Keep every other existing `rewindToCheckpoint` / `rewindLastTurn` test. Do not add todo.json assertions in this task.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/session/rewind.test.ts`

Expected: FAIL — persist-fail test sees HEAD already reset (or `result.messages` is `next`); order test sees HEAD already at `baseCommitSha` during `recordCompact`; reset-fail test still expects `inactivated` empty and originals.

- [ ] **Step 3: Implement persist-before-reset**

In `rewindToCheckpoint`, move the `recordCompact` block **above** `runGit(..., ['reset', '--hard', sha])`. On persist throw, return `{ ok: false, notice: 'rewind persist failed', messages: opts.messages }` (originals, not `next`). On reset fail, return `messages: next` (not `opts.messages`). Do not apply `todoSnapshot` on reset fail. Do not set `jobError` on persist fail. Do not project `todo.json` in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/session/rewind.test.ts`

Expected: PASS (including the flipped reset-fail test and both new tests). Existing two-turn / `droppedText` / clear-`jobError` tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/rewind.ts packages/core/src/session/rewind.test.ts
git commit -m "$(cat <<'EOF'
fix: persist job rewind drop before git reset --hard

Job rewind now recordCompacts dropped ids before resetting the
worktree. Persist fail leaves HEAD and the last user; reset fail
after persist keeps the drop and sets jobError.
EOF
)"
```

---

### Task 2: `projectSessionTodos` helper (H2.1)

**Files:**
- Modify: `packages/core/src/tools/todo.ts`, `packages/core/src/tools/todo.test.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `todoJsonPath`, `TodoItem[]`
- Produces: `export function projectSessionTodos(root: string, items: TodoItem[]): void`

- [ ] **Step 1: Write the failing tests**

In `todo.test.ts`, import `projectSessionTodos` from `./todo` and add:

```ts
describe('projectSessionTodos', () => {
  test('writes the same pretty-print bytes as TodoWrite', () => {
    const root = fixtureRoot()
    const items = [
      { id: 't1', text: 'one', status: 'done' as const },
      { text: 'two', status: 'in_progress' as const },
    ]
    projectSessionTodos(root, items)
    expect(readFileSync(todoJsonPath(root), 'utf8')).toBe(`${JSON.stringify(items, null, 2)}\n`)
  })

  test('empty list writes [] and a trailing newline', () => {
    const root = fixtureRoot()
    projectSessionTodos(root, [])
    expect(readFileSync(todoJsonPath(root), 'utf8')).toBe('[]\n')
    expect(existsSync(todoJsonPath(root))).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/tools/todo.test.ts`

Expected: FAIL — `projectSessionTodos` is not exported.

- [ ] **Step 3: Implement the helper and DRY TodoWrite**

Add to `todo.ts` (next to `todoJsonPath`):

```ts
export function projectSessionTodos(root: string, items: TodoItem[]): void {
  const path = todoJsonPath(root)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(items, null, 2)}\n`, 'utf8')
}
```

Replace the `mkdirSync` + `writeFileSync` block inside `todoWriteTool.execute` with `projectSessionTodos(root, items)`. Keep the existing try/catch that returns `TodoWrite failed: …`.

Export from `packages/core/src/index.ts`:

```ts
export { todoWriteTool, loadTodos, todosFromToolResult, todoJsonPath, projectSessionTodos } from './tools/todo'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/tools/todo.test.ts`

Expected: PASS. Existing `TodoWrite` write tests still pass (same bytes).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/todo.ts packages/core/src/tools/todo.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat: extract projectSessionTodos for the project todo.json file

TodoWrite and job rewind share one pretty-print writer. Empty
lists write [] plus a trailing newline; the file is not deleted.
EOF
)"
```

---

### Task 3: Job rewind re-projects todo.json (H2.2 + H2.3)

**Files:**
- Modify: `packages/core/src/session/rewind.ts`, `packages/core/src/session/rewind.test.ts`

**Interfaces:**
- Consumes: `projectSessionTodos`, `getSessionWorktree`
- Produces: after successful job rewind upsert, project file under `getSessionWorktree(session.id)?.originalCwd ?? session.cwd`; projection fail is `ok: true` + notice suffix

- [ ] **Step 1: Write the failing tests**

Import `existsSync`, `mkdirSync` (add to the existing `node:fs` import), `todoJsonPath` from `../tools/todo`, and `getSessionWorktree` from `../tools/session-worktree`. Add inside `describe('rewindToCheckpoint')`:

```ts
test('successful job rewind writes project todo.json from the restored snapshot', async () => {
  const cwd = tempDir('ravenclaw-rewind-todo-proj-')
  initGitRepo(cwd)
  const id = nextSession()
  const entered = enterSessionWorktree(id, cwd)
  expect(entered.ok).toBe(true)
  const job = entered.job!
  const project = getSessionWorktree(id)?.originalCwd ?? cwd
  mkdirSync(join(project, '.ravenclaw'), { recursive: true })
  writeFileSync(
    todoJsonPath(project),
    `${JSON.stringify([{ text: 'later', status: 'pending' }], null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(job.worktreePath, 'extra.txt'), 'later\n')
  expect(spawnSync('git', ['add', '-A'], { cwd: job.worktreePath, encoding: 'utf8' }).status).toBe(0)
  expect(
    spawnSync('git', ['commit', '-m', 'later'], { cwd: job.worktreePath, encoding: 'utf8' }).status,
  ).toBe(0)

  const store = createMemoryStore()
  const snapshot = [{ text: 'a', status: 'pending' as const }]
  const sess = sessionRecord({
    id,
    cwd: job.worktreePath,
    job,
    todos: [{ text: 'later', status: 'pending' }],
  })
  await store.createSession(sess)
  const messages: Message[] = [
    user('u1', 'first', 1),
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok' }],
      createdAt: 2,
      checkpoint: {
        commitSha: job.baseCommitSha,
        todoSnapshot: snapshot,
        dirty: false,
      },
    },
    user('u2', 'second', 3),
    assistant('a2', 'later', 4),
  ]
  await store.persistUser(id, messages[0] as Extract<Message, { role: 'user' }>)
  await store.persistAssistant(id, messages[1] as Extract<Message, { role: 'assistant' }>)
  await store.persistUser(id, messages[2] as Extract<Message, { role: 'user' }>)
  await store.persistAssistant(id, messages[3] as Extract<Message, { role: 'assistant' }>)

  const result = await rewindToCheckpoint({ session: sess, messages, store })
  expect(result.ok).toBe(true)
  expect(sess.todos).toEqual(snapshot)
  expect(readFileSync(todoJsonPath(project), 'utf8')).toBe(`${JSON.stringify(snapshot, null, 2)}\n`)
  expect(existsSync(todoJsonPath(job.worktreePath))).toBe(false)
})

test('empty snapshot writes [] to project todo.json', async () => {
  const cwd = tempDir('ravenclaw-rewind-todo-empty-')
  initGitRepo(cwd)
  const id = nextSession()
  const entered = enterSessionWorktree(id, cwd)
  expect(entered.ok).toBe(true)
  const job = entered.job!
  const project = getSessionWorktree(id)?.originalCwd ?? cwd
  mkdirSync(join(project, '.ravenclaw'), { recursive: true })
  writeFileSync(
    todoJsonPath(project),
    `${JSON.stringify([{ text: 'gone', status: 'pending' }], null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(job.worktreePath, 'extra.txt'), 'later\n')
  expect(spawnSync('git', ['add', '-A'], { cwd: job.worktreePath, encoding: 'utf8' }).status).toBe(0)
  expect(
    spawnSync('git', ['commit', '-m', 'later'], { cwd: job.worktreePath, encoding: 'utf8' }).status,
  ).toBe(0)

  const store = createMemoryStore()
  const sess = sessionRecord({
    id,
    cwd: job.worktreePath,
    job,
    todos: [{ text: 'gone', status: 'pending' }],
  })
  await store.createSession(sess)
  const messages: Message[] = [user('u1', 'only', 1), assistant('a1', 'ok', 2)]
  await store.persistUser(id, messages[0] as Extract<Message, { role: 'user' }>)
  await store.persistAssistant(id, messages[1] as Extract<Message, { role: 'assistant' }>)

  const result = await rewindToCheckpoint({ session: sess, messages, store })
  expect(result.ok).toBe(true)
  expect(sess.todos).toEqual([])
  expect(readFileSync(todoJsonPath(project), 'utf8')).toBe('[]\n')
})

test('todo.json write failure does not undo persist or reset', async () => {
  const cwd = tempDir('ravenclaw-rewind-todo-fail-')
  initGitRepo(cwd)
  const id = nextSession()
  const entered = enterSessionWorktree(id, cwd)
  expect(entered.ok).toBe(true)
  const job = entered.job!
  const project = getSessionWorktree(id)?.originalCwd ?? cwd
  writeFileSync(join(project, '.ravenclaw'), 'not-a-directory\n')
  writeFileSync(join(job.worktreePath, 'extra.txt'), 'later\n')
  expect(spawnSync('git', ['add', '-A'], { cwd: job.worktreePath, encoding: 'utf8' }).status).toBe(0)
  expect(
    spawnSync('git', ['commit', '-m', 'later'], { cwd: job.worktreePath, encoding: 'utf8' }).status,
  ).toBe(0)

  const store = createMemoryStore()
  const sess = sessionRecord({
    id,
    cwd: job.worktreePath,
    job,
    todos: [{ text: 'gone', status: 'pending' }],
  })
  await store.createSession(sess)
  const messages: Message[] = [user('u1', 'only', 1), assistant('a1', 'ok', 2)]
  await store.persistUser(id, messages[0] as Extract<Message, { role: 'user' }>)
  await store.persistAssistant(id, messages[1] as Extract<Message, { role: 'assistant' }>)

  const result = await rewindToCheckpoint({ session: sess, messages, store })
  expect(result.ok).toBe(true)
  expect(result.notice).toContain('todo.json write failed')
  expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(job.baseCommitSha)
  expect(sess.todos).toEqual([])
  expect(sess.jobError).toBeUndefined()
  const loaded = await store.loadSession(id)
  expect(loaded.messages.map((msg) => msg.id)).toEqual([])
  expect(loaded.session.jobError).toBeUndefined()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/session/rewind.test.ts`

Expected: FAIL — project `todo.json` still has the later list (or is missing `[]\n`); projection-fail path has no `todo.json write failed` suffix.

- [ ] **Step 3: Implement projection after upsert**

In `rewind.ts`:

```ts
import { getSessionWorktree } from '../tools/session-worktree'
import { projectSessionTodos } from '../tools/todo'
```

After the successful `upsertSession` (and only on that path), compute `root = getSessionWorktree(opts.session.id)?.originalCwd ?? opts.session.cwd`, call `projectSessionTodos(root, opts.session.todos ?? [])`, and on throw append `; todo.json write failed: ${detail}` to the rewind notice. `ok` stays `true`. Do not call this on persist-fail or reset-fail paths. Do not touch `rewindLastTurn`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/session/rewind.test.ts ./packages/core/src/tools/todo.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/rewind.ts packages/core/src/session/rewind.test.ts
git commit -m "$(cat <<'EOF'
feat: re-project project todo.json after a successful job rewind

Session todos stay the source of truth. The project file is written
under originalCwd after upsert. A write failure is a notice suffix
and does not undo persist or reset.
EOF
)"
```

---

### Task 4: Eval lock (H3.1)

**Files:**
- Create: `packages/core/src/eval/fixtures/rewind-persist-before-reset/case.json`, `packages/core/src/eval/fixtures/rewind-todo-project/case.json`
- Modify: `packages/core/src/eval/run.ts` only (`EvalExpect` + `runEvalDir` branches + two runners)

**Interfaces:**
- Consumes: `rewindToCheckpoint`, `projectSessionTodos` / `todoJsonPath`, `enterSessionWorktree`
- Produces: fixtures `rewind-persist-before-reset` and `rewind-todo-project`

- [ ] **Step 1: Write the failing fixtures and runners**

`packages/core/src/eval/fixtures/rewind-persist-before-reset/case.json`:

```json
{ "prompt": "unused", "expect": { "rewindPersistBeforeReset": true } }
```

`packages/core/src/eval/fixtures/rewind-todo-project/case.json`:

```json
{ "prompt": "unused", "expect": { "rewindTodoProject": true } }
```

Add to `EvalExpect`:

```ts
rewindPersistBeforeReset?: boolean
rewindTodoProject?: boolean
```

In `runEvalDir`, before the final `throw new Error(\`unknown eval fixture: ${name}\`)`:

```ts
if (name === 'rewind-persist-before-reset') {
  await runRewindPersistBeforeReset(spec)
  continue
}
if (name === 'rewind-todo-project') {
  await runRewindTodoProject(spec)
  continue
}
```

Add imports at the top of `run.ts`:

```ts
import { rewindToCheckpoint } from '../session/rewind'
import { todoJsonPath } from '../tools/todo'
```

`Message` is already imported. Add the two runners next to `runJobDiff`. Reuse `initGitRepo` / `makeSession`.

```ts
async function runRewindPersistBeforeReset(spec: EvalCase): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'raven-eval-rewind-persist-'))
  const sessionId = `sess_eval_rewind_persist_${crypto.randomUUID()}`
  try {
    initGitRepo(cwd)
    const entered = enterSessionWorktree(sessionId, cwd)
    if (!entered.ok || entered.job === undefined) {
      throw new Error(`rewind-persist-before-reset: enter failed: ${entered.error ?? 'no job'}`)
    }
    const job = entered.job
    writeFileSync(join(job.worktreePath, 'extra.txt'), 'later\n')
    const add = spawnSync('git', ['-C', job.worktreePath, 'add', 'extra.txt'], { encoding: 'utf8' })
    if (add.status !== 0) throw new Error(`rewind-persist-before-reset: git add failed: ${add.stderr}`)
    const commit = spawnSync('git', ['-C', job.worktreePath, 'commit', '-m', 'later'], {
      encoding: 'utf8',
    })
    if (commit.status !== 0) {
      throw new Error(`rewind-persist-before-reset: git commit failed: ${commit.stderr}`)
    }
    const later = spawnSync('git', ['-C', job.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    const laterSha = later.stdout.trim()

    if (spec.expect.rewindPersistBeforeReset === true) {
      const store = createMemoryStore()
      const session = makeSession({
        id: sessionId,
        cwd: job.worktreePath,
        job,
        todos: [{ text: 'keep', status: 'pending' }],
      })
      await store.createSession(session)
      const messages: Message[] = [
        {
          id: 'u1',
          role: 'user',
          blocks: [{ type: 'text', text: 'only' }],
          createdAt: 1,
        },
        {
          id: 'a1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'ok' }],
          createdAt: 2,
        },
      ]
      await store.persistUser(sessionId, messages[0] as Extract<Message, { role: 'user' }>)
      await store.persistAssistant(sessionId, messages[1] as Extract<Message, { role: 'assistant' }>)
      store.recordCompact = async () => {
        throw new Error('disk full')
      }
      const failed = await rewindToCheckpoint({ session, messages, store })
      if (failed.ok) throw new Error('rewind-persist-before-reset: persist fail unexpectedly ok')
      if (failed.notice !== 'rewind persist failed') {
        throw new Error(`rewind-persist-before-reset: notice ${JSON.stringify(failed.notice)}`)
      }
      const headAfterFail = spawnSync('git', ['-C', job.worktreePath, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      })
      if (headAfterFail.stdout.trim() !== laterSha) {
        throw new Error('rewind-persist-before-reset: persist fail moved HEAD')
      }

      const store2 = createMemoryStore()
      const session2 = makeSession({
        id: `${sessionId}_ok`,
        cwd: job.worktreePath,
        job,
      })
      await store2.createSession(session2)
      const messages2: Message[] = [
        {
          id: 'u2',
          role: 'user',
          blocks: [{ type: 'text', text: 'only' }],
          createdAt: 1,
        },
        {
          id: 'a2',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'ok' }],
          createdAt: 2,
        },
      ]
      await store2.persistUser(session2.id, messages2[0] as Extract<Message, { role: 'user' }>)
      await store2.persistAssistant(session2.id, messages2[1] as Extract<Message, { role: 'assistant' }>)
      const heads: string[] = []
      const orig = store2.recordCompact.bind(store2)
      store2.recordCompact = async (sid, generation, summary, ids) => {
        const now = spawnSync('git', ['-C', job.worktreePath, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        })
        heads.push(now.stdout.trim())
        return orig(sid, generation, summary, ids)
      }
      const ok = await rewindToCheckpoint({ session: session2, messages: messages2, store: store2 })
      if (!ok.ok) throw new Error(`rewind-persist-before-reset: success path failed: ${ok.notice}`)
      if (heads[0] !== laterSha) {
        throw new Error(
          `rewind-persist-before-reset: recordCompact ran after reset: ${JSON.stringify(heads)}`,
        )
      }
      const headAfterOk = spawnSync('git', ['-C', job.worktreePath, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      })
      if (headAfterOk.stdout.trim() !== job.baseCommitSha) {
        throw new Error('rewind-persist-before-reset: success path did not reset to base')
      }
    }
  } finally {
    exitSessionWorktree(sessionId, 'remove', true)
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function runRewindTodoProject(spec: EvalCase): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'raven-eval-rewind-todo-'))
  const sessionId = `sess_eval_rewind_todo_${crypto.randomUUID()}`
  try {
    initGitRepo(cwd)
    const entered = enterSessionWorktree(sessionId, cwd)
    if (!entered.ok || entered.job === undefined) {
      throw new Error(`rewind-todo-project: enter failed: ${entered.error ?? 'no job'}`)
    }
    const job = entered.job
    const project = cwd
    writeFileSync(join(job.worktreePath, 'extra.txt'), 'later\n')
    const add = spawnSync('git', ['-C', job.worktreePath, 'add', 'extra.txt'], { encoding: 'utf8' })
    if (add.status !== 0) throw new Error(`rewind-todo-project: git add failed: ${add.stderr}`)
    const commit = spawnSync('git', ['-C', job.worktreePath, 'commit', '-m', 'later'], {
      encoding: 'utf8',
    })
    if (commit.status !== 0) throw new Error(`rewind-todo-project: git commit failed: ${commit.stderr}`)

    if (spec.expect.rewindTodoProject === true) {
      const store = createMemoryStore()
      const snapshot: TodoItem[] = [{ text: 'a', status: 'pending' }]
      const session = makeSession({
        id: sessionId,
        cwd: job.worktreePath,
        job,
        todos: [{ text: 'later', status: 'pending' }],
      })
      await store.createSession(session)
      const messages: Message[] = [
        {
          id: 'u1',
          role: 'user',
          blocks: [{ type: 'text', text: 'first' }],
          createdAt: 1,
        },
        {
          id: 'a1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'ok' }],
          createdAt: 2,
          checkpoint: {
            commitSha: job.baseCommitSha,
            todoSnapshot: snapshot,
            dirty: false,
          },
        },
        {
          id: 'u2',
          role: 'user',
          blocks: [{ type: 'text', text: 'second' }],
          createdAt: 3,
        },
        {
          id: 'a2',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'later' }],
          createdAt: 4,
        },
      ]
      await store.persistUser(sessionId, messages[0] as Extract<Message, { role: 'user' }>)
      await store.persistAssistant(sessionId, messages[1] as Extract<Message, { role: 'assistant' }>)
      await store.persistUser(sessionId, messages[2] as Extract<Message, { role: 'user' }>)
      await store.persistAssistant(sessionId, messages[3] as Extract<Message, { role: 'assistant' }>)
      const result = await rewindToCheckpoint({ session, messages, store })
      if (!result.ok) throw new Error(`rewind-todo-project: rewind failed: ${result.notice}`)
      const loaded = await store.loadSession(sessionId)
      const fileRaw = readFileSync(todoJsonPath(project), 'utf8')
      const fileItems = JSON.parse(fileRaw) as TodoItem[]
      if (JSON.stringify(fileItems) !== JSON.stringify(loaded.session.todos)) {
        throw new Error(
          `rewind-todo-project: file ${fileRaw} !== session.todos ${JSON.stringify(loaded.session.todos)}`,
        )
      }
      if (JSON.stringify(loaded.session.todos) !== JSON.stringify(snapshot)) {
        throw new Error(
          `rewind-todo-project: session.todos ${JSON.stringify(loaded.session.todos)} !== snapshot`,
        )
      }
    }
  } finally {
    exitSessionWorktree(sessionId, 'remove', true)
    rmSync(cwd, { recursive: true, force: true })
  }
}
```

`TodoItem` is already imported in `run.ts`. `readFileSync` is already imported.

- [ ] **Step 2: Run the eval test to verify the new cases execute**

Run: `bun test ./packages/core/src/eval/run.test.ts`

Expected: PASS once Task 3 is on the branch (the runners assert the new behavior). If someone reverts H1.1 or H2.2, this file must fail.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/eval/run.ts \
  packages/core/src/eval/fixtures/rewind-persist-before-reset/case.json \
  packages/core/src/eval/fixtures/rewind-todo-project/case.json
git commit -m "$(cat <<'EOF'
test: lock job rewind persist-before-reset and todo.json projection

Eval fixtures fail the runner if persist runs after reset or if
the project todo.json drifts from session.todos after rewind.
EOF
)"
```

---

### Task 5: Docs honesty

**Files:**
- Modify: `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`, `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-09-18-rewind-persist-and-todo-projection.md`

**Interfaces:**
- Consumes: behavior from Tasks 1–3
- Produces: docs that describe persist-before-reset and projection; spec Status becomes implemented on this branch (lands with the code)

- [ ] **Step 1: Update the wording**

`ARCHITECTURE.md` `rewindLast()` bullet — replace the job sentence so persist comes first:

> **Job sessions** (`session.job`) call `rewindToCheckpoint`: persist compact `rewind` for dropped ids, then `git reset --hard` in the job worktree to the nearest earlier assistant checkpoint sha (or `baseCommitSha`), restore that todo snapshot onto `session.todos`, and re-project `.ravenclaw/todo.json` under `originalCwd ?? cwd`. Persist fail leaves HEAD and the last user. Reset fail after persist keeps the drop and sets `jobError`. Projection fail is a notice suffix (`ok` stays true).

Mirror in `ARCHITECTURE.ko.md` (job rewind: compact persist 먼저, 그 다음 `git reset --hard`, `session.todos` 복원, 프로젝트 `todo.json` 재투영).

`SLASH_COMMANDS.md` job-session step 2:

> **Job session** (`session.job`): `rewindToCheckpoint` — drop the last user turn, persist compact `rewind` **before** `git reset --hard` in the job worktree to the nearest earlier assistant checkpoint sha (or `job.baseCommitSha`), restore that todo snapshot, write project `.ravenclaw/todo.json`. Failure notices: `rewind persist failed` (HEAD unchanged) / `rewind reset failed: …` (drop kept) / `nothing to rewind`. Projection I/O fail appends `; todo.json write failed: …` and stays `ok`.

Mirror in `SLASH_COMMANDS.ko.md`.

`CHANGELOG.md` Unreleased / Added, after the job-host shipped bullet:

```md
- Job rewind persists the transcript drop (`recordCompact`) **before** `git reset --hard`. Persist fail leaves HEAD and the last user. Reset fail after persist keeps the drop and sets `jobError`. Successful job rewind re-projects project `.ravenclaw/todo.json` from `session.todos` (`originalCwd ?? cwd`); write failure is a notice suffix, not a `jobError`. Spec: [docs/superpowers/specs/2026-09-18-rewind-persist-and-todo-projection.md](docs/superpowers/specs/2026-09-18-rewind-persist-and-todo-projection.md). Plan: [docs/superpowers/plans/2026-09-18-rewind-persist-todo-projection.md](docs/superpowers/plans/2026-09-18-rewind-persist-todo-projection.md).
```

Spec file:

- Status line: `Status: implemented` (this PR is the land).
- Board H1.1 / H1.2 / H1.3 / H2.1 / H2.2 / H2.3 / H3.1 → **shipped** (leave H0.1 as shipped too; it landed in PR #12).
- Keep “Do not mark this spec implemented until it lands on `main`” only as historical context, or delete that sentence — Status is `implemented` on this branch so the merge is honest.

Do not add a web UI. Do not restyle unrelated docs.

- [ ] **Step 2: Commit**

```bash
git add ARCHITECTURE.md ARCHITECTURE.ko.md SLASH_COMMANDS.md SLASH_COMMANDS.ko.md CHANGELOG.md \
  docs/superpowers/specs/2026-09-18-rewind-persist-and-todo-projection.md
git commit -m "$(cat <<'EOF'
docs: describe persist-before-reset job rewind and todo.json projection

Architecture, slash help, changelog, and the horizon spec now match
the shipped order: persist the drop, then reset, then project the file.
EOF
)"
```

---

## Self-review

**Spec coverage**

| Spec slice | Task |
|---|---|
| H0.1 pointers | already on `main` (`c851668`); Task 5 does not redo |
| H1.1 persist before reset | Task 1 order test |
| H1.2 persist fail leaves HEAD | Task 1 persist-fail test |
| H1.3 reset fail keeps drop | Task 1 flipped reset-fail test |
| H2.1 `projectSessionTodos` | Task 2 |
| H2.2 rewind re-projects | Task 3 first two tests |
| H2.3 projection fail notice | Task 3 third test |
| H3.1 eval fixtures | Task 4 |
| Success checks 1–6 | Tasks 1, 3, 4 |
| No schema bump / no reset-on-resume / no-job order unchanged / TodoWrite persist-then-file | Global constraints; Task 2 only DRYs the file write |

**Placeholder scan:** none.

**Type consistency:** `projectSessionTodos(root: string, items: TodoItem[]): void` is named once in Task 2 and consumed in Task 3. Notices are `'rewind persist failed'`, `'rewind reset failed: …'`, and suffix `'; todo.json write failed: …'`.
