# No-job todo revert — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No-job `/rewind` restores `session.todos` (and project `todo.json`) from a durable assistant `todoSnapshot`, matching the job rewind contract without a schema bump.

**Architecture:** Reuse `messages.checkpoint_json`. `JobCheckpoint.commitSha` becomes optional. `stampTodoSnapshot` writes `{ todoSnapshot, dirty: false }` with `commitSha` omitted. `checkpointFromJson` loads that shape. Job rewind walks for a non-empty `commitSha`. `rewindLastTurn` persist-then-undo stays; after a successful drop it persist-first upserts restored todos and re-projects.

**Tech Stack:** Bun, TypeScript, existing `SessionStore`, `projectSessionTodos`, raven eval fixtures.

**Spec:** `docs/superpowers/specs/2026-09-18-no-job-todo-revert.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers.
- Default prefix stays small and frozen. No new always-on tool.
- `dontAsk` never becomes `bypass`.
- BYOK is the product. Ads never touch BYOK.
- Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
- `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
- Leftover-ask still wins rewind. Edit-resubmit stays host composition.
- No schema bump. No `commitSha: ''`. No file-history todo frames. No-job persist-then-undo order stays. `TodoWrite` persist-then-file stays. `/undo` stays file-only.
- Cancel-without-live, interrupt abort-pair, parent-cancels-child stay OUT.
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push.

### Plan rulings

1. **`stampTodoSnapshot` lives next to `stampCheckpoint` in `job.ts` and is exported from `packages/core/src/index.ts`.**

```ts
export function stampTodoSnapshot(
  message: Extract<Message, { role: 'assistant' }>,
  todos: TodoItem[] | undefined,
): void {
  message.checkpoint = {
    todoSnapshot: (todos ?? []).map((item) => ({ ...item })),
    dirty: false,
  }
}
```

2. **`checkpointFromJson`:** `dirty` must be boolean. Copy `commitSha` only when `typeof === 'string' && length > 0`. `todoSnapshot` via `parseTodoItems`.

3. **Job rewind helper** (replace `lastAssistantCheckpoint` uses on the job path):

```ts
function lastGitCheckpoint(messages: Message[]): JobCheckpoint | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const sha = msg?.role === 'assistant' ? msg.checkpoint?.commitSha : undefined
    if (msg?.role === 'assistant' && sha) return msg.checkpoint
  }
  return undefined
}
```

`rewindToCheckpoint` / `maybeFinishRewindReset`: `const checkpoint = lastGitCheckpoint(...)`; `const sha = checkpoint?.commitSha ?? job.baseCommitSha`. Sha-less last assistant does not win.

4. **No-job restore helper:**

```ts
function lastTodoCheckpoint(messages: Message[]): JobCheckpoint | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'assistant' && msg.checkpoint) return msg.checkpoint
  }
  return undefined
}
```

5. **`rewindLastTurn` grows `session?: SessionRecord`.** Existing callers without `session` stay file+transcript only (current tests stay green). Engine `rewindLast` passes `session`.

6. **Restore after successful undo, only if `droppedIds.length > 0` and `session` + `store` are present.** Persist-first: `{ ...session, todos: nextTodos, updatedAt }` then assign. Projection root is `session.cwd`.

7. **Stamp no-job after `lastEnd` upsert**, same `isJobSuccessReason` set, `!session.job`, `listPendingAsks(session.id)` empty. Persist throw swallowed.

8. **Docs (Task 5) after code.** Spec Status → implemented (leave SHA blank until land). Pointers + CHANGELOG.

## File map

| File | Role |
|---|---|
| `packages/core/src/types.ts` | `JobCheckpoint.commitSha?` |
| `packages/core/src/session/job.ts` | `stampTodoSnapshot` |
| `packages/core/src/session/job.test.ts` | helper tests |
| `packages/core/src/session/sqlite-store.ts` | `checkpointFromJson` |
| `packages/core/src/session/sqlite-store.test.ts` | sha-less round-trip |
| `packages/core/src/index.ts` | export `stampTodoSnapshot` |
| `packages/core/src/session/rewind.ts` | `lastGitCheckpoint`, restore in `rewindLastTurn` |
| `packages/core/src/session/rewind.test.ts` | restore / legacy / upsert-fail / projection |
| `packages/core/src/loop/session-engine.ts` | no-job stamp; pass `session` |
| `packages/core/src/loop/session-engine.test.ts` | stamp on complete; no stamp on cancel |
| `packages/core/src/eval/run.ts` | `rewind-no-job-todo-revert` runner |
| `packages/core/src/eval/fixtures/rewind-no-job-todo-revert/case.json` | fixture |
| docs listed in Task 5 | pointers + honesty |

---

### Task 1: Type, parse, `stampTodoSnapshot`

**Files:** `types.ts`, `job.ts`, `job.test.ts`, `sqlite-store.ts`, `sqlite-store.test.ts`, `index.ts`

**Interfaces:**
- Consumes: `JobCheckpoint`, `persistAssistant`, `parseTodoItems`
- Produces: `stampTodoSnapshot(message, todos): void`; `commitSha?: string`; sha-less `checkpointFromJson`

- [ ] **Step 1: Write the failing tests**

In `job.test.ts` import `stampTodoSnapshot` and add:

```ts
describe('stampTodoSnapshot', () => {
  test('copies todos and omits commitSha', () => {
    const message: Extract<Message, { role: 'assistant' }> = {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok' }],
      createdAt: 1,
    }
    const todos = [{ text: 'a', status: 'pending' as const }]
    stampTodoSnapshot(message, todos)
    expect(message.checkpoint).toEqual({
      todoSnapshot: [{ text: 'a', status: 'pending' }],
      dirty: false,
    })
    expect(message.checkpoint && 'commitSha' in message.checkpoint).toBe(false)
    expect(message.checkpoint?.todoSnapshot).not.toBe(todos)
    todos.push({ text: 'b', status: 'pending' })
    expect(message.checkpoint?.todoSnapshot).toEqual([{ text: 'a', status: 'pending' }])
  })

  test('undefined todos become an empty snapshot', () => {
    const message: Extract<Message, { role: 'assistant' }> = {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok' }],
      createdAt: 1,
    }
    stampTodoSnapshot(message, undefined)
    expect(message.checkpoint).toEqual({ todoSnapshot: [], dirty: false })
  })
})
```

In `sqlite-store.test.ts` add:

```ts
test('persistAssistant round-trips a sha-less todo snapshot', async () => {
  const store = openStore()
  await store.createSession(session())
  const textOnly: Extract<Message, { role: 'assistant' }> = {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'ok' }],
    createdAt: 1,
    checkpoint: {
      todoSnapshot: [{ text: 'a', status: 'pending' }],
      dirty: false,
    },
  }
  await store.persistAssistant('s1', textOnly)
  const loaded = await store.loadSession('s1')
  const asst = loaded.messages.find((msg) => msg.id === 'a1')
  expect(asst && asst.role === 'assistant' ? asst.checkpoint : undefined).toEqual({
    todoSnapshot: [{ text: 'a', status: 'pending' }],
    dirty: false,
  })
  expect(
    asst && asst.role === 'assistant' ? asst.checkpoint?.commitSha : 'missing',
  ).toBeUndefined()
})
```

- [ ] **Step 2: RED**

Run: `bun test ./packages/core/src/session/job.test.ts ./packages/core/src/session/sqlite-store.test.ts`

Expected: FAIL — `stampTodoSnapshot` is not exported; sha-less load returns `undefined`.

- [ ] **Step 3: Implement**

`JobCheckpoint.commitSha?`. Add `stampTodoSnapshot`. Change `checkpointFromJson`. Export from `index.ts`.

- [ ] **Step 4: GREEN** — same command, pass. Existing job checkpoint tests still see `commitSha`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/session/job.ts packages/core/src/session/job.test.ts packages/core/src/session/sqlite-store.ts packages/core/src/session/sqlite-store.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat: stamp sha-less todo snapshots on assistant checkpoints

JobCheckpoint.commitSha is optional. stampTodoSnapshot writes
todoSnapshot + dirty:false and omits commitSha. checkpointFromJson
loads that shape so no-job rewind has a durable restore source.
EOF
)"
```

---

### Task 2: No-job turn stamp + job rewind skips sha-less

**Files:** `session-engine.ts`, `session-engine.test.ts`, `rewind.ts`, `rewind.test.ts`

**Interfaces:**
- Consumes: `stampTodoSnapshot`, `isJobSuccessReason`, `lastGitCheckpoint`
- Produces: no-job success turn persists a sha-less stamp; job rewind ignores sha-less last assistant

- [ ] **Step 1: Failing tests**

`session-engine.test.ts` (near other engine tests, reuse `createFakeProvider` / `engineOpts` / `drain` if present — otherwise consume the generator until `done`):

```ts
test('no-job success turn stamps a sha-less todo snapshot', async () => {
  const store = createMemoryStore()
  const sess = makeSession({
    id: 'sess_stamp_todo',
    todos: [{ text: 'b', status: 'pending' }],
  })
  await store.createSession(sess)
  const engine = createSessionEngine({
    ...engineOpts({
      provider: createFakeProvider([[{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: null }]]),
      store,
      session: sess,
    }),
  })
  const result = await drain(engine.submitMessage('hi'))
  expect(result.reason).toBe('completed')
  const loaded = await store.loadSession(sess.id)
  const last = [...loaded.messages].reverse().find((msg) => msg.role === 'assistant')
  expect(last && last.role === 'assistant' ? last.checkpoint : undefined).toEqual({
    todoSnapshot: [{ text: 'b', status: 'pending' }],
    dirty: false,
  })
})

test('cancelled no-job turn does not stamp', async () => {
  const store = createMemoryStore()
  const sess = makeSession({ id: 'sess_stamp_cancel' })
  await store.createSession(sess)
  let enteredFirst: () => void
  const firstStreamEntered = new Promise<void>((resolve) => {
    enteredFirst = resolve
  })
  const engine = createSessionEngine({
    ...engineOpts({
      provider: {
        id: 'fake',
        apiMode: 'openai_compat',
        profile: (model: string) => defaultModel(model),
        async *stream(_req, signal) {
          enteredFirst()
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        },
      },
      store,
      session: sess,
    }),
  })
  const pending = drain(engine.submitMessage('hi'))
  await firstStreamEntered
  engine.abort('cancel')
  await pending
  const loaded = await store.loadSession(sess.id)
  for (const msg of loaded.messages) {
    if (msg.role === 'assistant') expect(msg.checkpoint).toBeUndefined()
  }
})
```

`rewind.test.ts` in the job describe that has `initGitRepo` / `tempDir` / `nextSession`:

```ts
test('job rewind skips a sha-less last assistant and uses the earlier git checkpoint', async () => {
  const cwd = tempDir('ravenclaw-rewind-skip-shaless-')
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
  const laterSha = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: job.worktreePath,
    encoding: 'utf8',
  }).stdout.trim()
  const store = createMemoryStore()
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
      ...assistant('a1', 'ok', 2),
      checkpoint: {
        commitSha: job.baseCommitSha,
        todoSnapshot: [{ text: 'a', status: 'pending' }],
        dirty: false,
      },
    },
    user('u2', 'second', 3),
    {
      ...assistant('a2', 'later', 4),
      checkpoint: { todoSnapshot: [{ text: 'b', status: 'done' }], dirty: false },
    },
  ]
  const result = await rewindToCheckpoint({ session: sess, messages, store })
  expect(result.ok).toBe(true)
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: job.worktreePath,
    encoding: 'utf8',
  }).stdout.trim()
  expect(head).toBe(job.baseCommitSha)
  expect(head).not.toBe(laterSha)
  expect(sess.todos).toEqual([{ text: 'a', status: 'pending' }])
})
```

If `assistant()` return is not spreadable with checkpoint, build the object inline like the existing checkpoint tests.

- [ ] **Step 2: RED** — `bun test ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/session/rewind.test.ts`

Expected: FAIL — no-job last assistant has no checkpoint; job rewind resets using sha-less last assistant (`commitSha` undefined → `base` might already pass HEAD if `??` kicks in — **assert todos**: today last sha-less checkpoint wins and restores `[b]`, so `sess.todos` would be `[b]` not `[a]`). That is the RED.

- [ ] **Step 3: Implement**

`lastGitCheckpoint` in `rewind.ts`; use it in `rewindToCheckpoint` and `maybeFinishRewindReset`.

In `session-engine.ts` after the job stamp block (or as a sibling):

```ts
if (
  !session.job &&
  isJobSuccessReason(end.reason) &&
  (await opts.store.listPendingAsks(session.id)).length === 0
) {
  const asst = lastAssistant(turn.messages)
  if (asst) {
    stampTodoSnapshot(asst, session.todos)
    try {
      if (asst.blocks.some((block) => block.type === 'tool_use')) {
        await opts.store.persistToolCalls(session.id, asst)
      } else {
        await opts.store.persistAssistant(session.id, asst)
      }
    } catch {
      // todo snapshot persist must not fail the turn
    }
  }
}
```

Import `stampTodoSnapshot`.

- [ ] **Step 4: GREEN** — same command.

- [ ] **Step 5: Commit** `feat: stamp no-job todos and ignore sha-less job checkpoints`

---

### Task 3: `rewindLastTurn` restore

**Files:** `rewind.ts`, `rewind.test.ts`, `session-engine.ts`

**Interfaces:**
- Consumes: `lastTodoCheckpoint`, `projectSessionTodos`, `session?: SessionRecord`
- Produces: restore + persist-first upsert + projection

- [ ] **Step 1: Failing tests** in `rewind.test.ts` (new describe `rewindLastTurn todo restore`):

```ts
test('restores session.todos from the previous assistant snapshot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'raven-rewind-todo-'))
  const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-todo-cwd-'))
  const history = createFileHistory('sess_todo', home)
  history.beginTurn()
  history.endTurn()
  const store = createMemoryStore()
  const sess = sessionRecord({
    id: 'sess_todo',
    cwd,
    todos: [{ text: 'b', status: 'done' }],
  })
  await store.createSession(sess)
  const messages: Message[] = [
    user('u1', 'first', 1),
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok' }],
      createdAt: 2,
      checkpoint: { todoSnapshot: [{ text: 'a', status: 'pending' }], dirty: false },
    },
    user('u2', 'second', 3),
    assistant('a2', 'later', 4),
  ]
  const result = await rewindLastTurn({
    fileHistory: history,
    messages,
    store,
    sessionId: sess.id,
    session: sess,
  })
  expect(result.ok).toBe(true)
  expect(result.messages.map((msg) => msg.id)).toEqual(['u1', 'a1'])
  expect(sess.todos).toEqual([{ text: 'a', status: 'pending' }])
  const loaded = await store.loadSession(sess.id)
  expect(loaded.session.todos).toEqual([{ text: 'a', status: 'pending' }])
  expect(JSON.parse(readFileSync(todoJsonPath(cwd), 'utf8'))).toEqual([
    { text: 'a', status: 'pending' },
  ])
})

test('legacy remaining assistant without checkpoint leaves todos', async () => {
  const home = mkdtempSync(join(tmpdir(), 'raven-rewind-legacy-'))
  const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-legacy-cwd-'))
  const history = createFileHistory('sess_legacy', home)
  history.beginTurn()
  history.endTurn()
  const store = createMemoryStore()
  const sess = sessionRecord({
    id: 'sess_legacy',
    cwd,
    todos: [{ text: 'keep', status: 'pending' }],
  })
  await store.createSession(sess)
  const messages: Message[] = [user('u1', 'first', 1), assistant('a1', 'ok', 2), user('u2', 'drop', 3)]
  const result = await rewindLastTurn({
    fileHistory: history,
    messages,
    store,
    sessionId: sess.id,
    session: sess,
  })
  expect(result.ok).toBe(true)
  expect(sess.todos).toEqual([{ text: 'keep', status: 'pending' }])
  expect(existsSync(todoJsonPath(cwd))).toBe(false)
})

test('first-turn rewind with no remaining assistant clears todos', async () => {
  const home = mkdtempSync(join(tmpdir(), 'raven-rewind-empty-'))
  const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-empty-cwd-'))
  const history = createFileHistory('sess_empty', home)
  history.beginTurn()
  history.endTurn()
  const store = createMemoryStore()
  const sess = sessionRecord({
    id: 'sess_empty',
    cwd,
    todos: [{ text: 'gone', status: 'pending' }],
  })
  await store.createSession(sess)
  const messages: Message[] = [user('u1', 'only', 1), assistant('a1', 'ok', 2)]
  const result = await rewindLastTurn({
    fileHistory: history,
    messages,
    store,
    sessionId: sess.id,
    session: sess,
  })
  expect(result.ok).toBe(true)
  expect(result.messages).toEqual([])
  expect(sess.todos).toEqual([])
  expect(readFileSync(todoJsonPath(cwd), 'utf8')).toBe('[]\n')
})

test('no dropped messages does not restore todos', async () => {
  const home = mkdtempSync(join(tmpdir(), 'raven-rewind-nodrop-'))
  const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-nodrop-cwd-'))
  const history = createFileHistory('sess_nodrop', home)
  history.beginTurn()
  history.endTurn()
  const store = createMemoryStore()
  const sess = sessionRecord({
    id: 'sess_nodrop',
    cwd,
    todos: [{ text: 'keep', status: 'pending' }],
  })
  await store.createSession(sess)
  const messages: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok' }],
      createdAt: 1,
      checkpoint: { todoSnapshot: [], dirty: false },
    },
  ]
  const result = await rewindLastTurn({
    fileHistory: history,
    messages,
    store,
    sessionId: sess.id,
    session: sess,
  })
  expect(result.ok).toBe(true)
  expect(sess.todos).toEqual([{ text: 'keep', status: 'pending' }])
})

test('upsert fail after undo leaves memory todos and does not un-compact', async () => {
  const home = mkdtempSync(join(tmpdir(), 'raven-rewind-upsert-'))
  const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-upsert-cwd-'))
  const path = join(cwd, 'keep.txt')
  writeFileSync(path, 'old\n')
  const history = createFileHistory('sess_upsert', home)
  history.beginTurn()
  history.snapshot(path)
  writeFileSync(path, 'new\n')
  history.endTurn()
  const store = createMemoryStore()
  const sess = sessionRecord({
    id: 'sess_upsert',
    cwd,
    todos: [{ text: 'b', status: 'done' }],
  })
  await store.createSession(sess)
  const orig = store.upsertSession.bind(store)
  store.upsertSession = async () => {
    throw new Error('disk full')
  }
  const messages: Message[] = [
    user('u1', 'first', 1),
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok' }],
      createdAt: 2,
      checkpoint: { todoSnapshot: [{ text: 'a', status: 'pending' }], dirty: false },
    },
    user('u2', 'second', 3),
  ]
  await store.persistUser(sess.id, messages[0] as Extract<Message, { role: 'user' }>)
  await store.persistAssistant(sess.id, messages[1] as Extract<Message, { role: 'assistant' }>)
  await store.persistUser(sess.id, messages[2] as Extract<Message, { role: 'user' }>)
  const result = await rewindLastTurn({
    fileHistory: history,
    messages,
    store,
    sessionId: sess.id,
    generation: 0,
    session: sess,
  })
  expect(result.ok).toBe(false)
  expect(result.notice).toBe('rewind persist failed')
  expect(result.messages.map((msg) => msg.id)).toEqual(['u1', 'a1'])
  expect(sess.todos).toEqual([{ text: 'b', status: 'done' }])
  store.upsertSession = orig
  const loaded = await store.loadSession(sess.id)
  expect(loaded.session.todos).toEqual([{ text: 'b', status: 'done' }])
  expect(loaded.messages.map((msg) => msg.id)).toEqual(['u1', 'a1'])
  expect(readFileSync(path, 'utf8')).toBe('old\n')
})

test('projection fail keeps restored todos and ok true', async () => {
  const home = mkdtempSync(join(tmpdir(), 'raven-rewind-proj-'))
  const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-proj-cwd-'))
  writeFileSync(join(cwd, '.ravenclaw'), 'not-a-dir\n')
  const history = createFileHistory('sess_proj', home)
  history.beginTurn()
  history.endTurn()
  const store = createMemoryStore()
  const sess = sessionRecord({
    id: 'sess_proj',
    cwd,
    todos: [{ text: 'b', status: 'done' }],
  })
  await store.createSession(sess)
  const messages: Message[] = [
    user('u1', 'first', 1),
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok' }],
      createdAt: 2,
      checkpoint: { todoSnapshot: [{ text: 'a', status: 'pending' }], dirty: false },
    },
    user('u2', 'second', 3),
  ]
  const result = await rewindLastTurn({
    fileHistory: history,
    messages,
    store,
    sessionId: sess.id,
    session: sess,
  })
  expect(result.ok).toBe(true)
  expect(result.notice).toContain('todo.json write failed')
  expect(sess.todos).toEqual([{ text: 'a', status: 'pending' }])
})
```

`sessionRecord` already exists in `rewind.test.ts` job describe — if it is describe-local, hoist a small helper or inline a `SessionRecord`. Do not break the job describe.

- [ ] **Step 2: RED** `bun test ./packages/core/src/session/rewind.test.ts`

- [ ] **Step 3: Implement** restore in `rewindLastTurn` per spec rulings 8–12. Pass `session` from `session-engine.rewindLast`.

```ts
if (droppedIds.length > 0 && opts.session && opts.store) {
  const snapshot = lastTodoCheckpoint(next)
  const hasAssistant = next.some((msg) => msg.role === 'assistant')
  if (!(snapshot === undefined && hasAssistant)) {
    const nextTodos = snapshot
      ? snapshot.todoSnapshot.map((item) => ({ ...item }))
      : []
    const toWrite = { ...opts.session, todos: nextTodos, updatedAt: Date.now() }
    try {
      await opts.store.upsertSession(toWrite)
    } catch {
      return { ok: false, notice: 'rewind persist failed', messages: next }
    }
    opts.session.todos = nextTodos
    opts.session.updatedAt = toWrite.updatedAt
    try {
      projectSessionTodos(opts.session.cwd, opts.session.todos ?? [])
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      notice = `${notice}; todo.json write failed: ${detail}`
    }
  }
}
```

Compute `notice` from `formatRewindNotice(undo, droppedIds.length)` before the projection try.

- [ ] **Step 4: GREEN** plus `bun test ./packages/core/src/loop/session-engine.test.ts` (engine still compiles).

- [ ] **Step 5: Commit** `feat: restore no-job session todos on rewind`

---

### Task 4: Eval lock

**Files:** `packages/core/src/eval/run.ts`, `run.test.ts` (no new test file if the dir walk covers it), `packages/core/src/eval/fixtures/rewind-no-job-todo-revert/case.json`

**Interfaces:**
- Consumes: `rewindLastTurn`, `createFileHistory`, `createMemoryStore`
- Produces: fixture name `rewind-no-job-todo-revert`; `EvalExpect.rewindNoJobTodoRevert?: boolean`

- [ ] **Step 1: Add `case.json`** `{ "prompt": "unused", "expect": { "rewindNoJobTodoRevert": true } }`

- [ ] **Step 2: RED** `bun test ./packages/core/src/eval/run.test.ts` — `unknown eval fixture: rewind-no-job-todo-revert`

- [ ] **Step 3: Implement `runRewindNoJobTodoRevert`**

Copy helpers locally in `run.ts`. Two beats:
1. Success: messages + stamps as Task 3 first test; `rewindLastTurn`; `session.todos` and `todo.json` equal `[a]`.
2. Persist-fail before undo: `recordCompact` throws; file still `new`; last user still loaded; todos still `[b]`.

Dispatch in `runEvalDir` before the unknown-name throw.

- [ ] **Step 4: GREEN**

- [ ] **Step 5: Commit** `test: lock no-job todo revert in eval fixtures`

---

### Task 5: Docs honesty

**Files:** spec (Status/board), cancel + rewind specs (one-line amendment + next-horizon pointer), `2026-09-12-ravenclaw-remaining-roadmap.md`, `ARCHITECTURE.md` / `.ko.md` no-job rewind sentence, `SLASH_COMMANDS.md` / `.ko.md` if they say no-job rewind is drop+undo only, `README.md` if it points at the last horizon, `CHANGELOG.md` Unreleased Added.

- [ ] Update pointers. Do not invent a ship SHA. Spec Status: `implemented on this branch` (SHA filled when it lands on `main`).
- [ ] Commit `docs: spec no-job todo revert and point the waist at it`

---

## Suggested order

1 → 2 → 3 → 4 → 5. Do not parallel 2 and 3 (`rewind.ts`).

## Success checks

1. Sha-less stamp loads.
2. Job rewind uses a non-empty `commitSha` and earlier git todos.
3. No-job rewind of a stamped turn restores todos + file.
4. Upsert fail leaves memory todos and keeps the compact.
5. Projection fail does not undo the restore.
6. Legacy silence; no-drop does not restore; first-turn → `[]`.
7. Eval fails if 3 or persist-before-undo regress.
