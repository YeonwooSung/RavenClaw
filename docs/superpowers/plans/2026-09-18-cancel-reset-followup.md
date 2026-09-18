# Cancel abort-pair, reset-on-resume, follow-up persist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live `abort('cancel')` drops this session’s leftover-ask without a second tool row; a crashed job rewind finishes on the next `submitMessage` / `rewindLast` / host `/diff`; `writeFollowup` persists before it mutates memory.

**Architecture:** Three independent honesty leftovers. I1 reorders `writeFollowup`. I2 abort-pairs pending rows after `reason === 'cancelled'` (drop-only when already paired). I3 adds `SessionJob.pendingResetSha` and `maybeFinishRewindReset`, awaited only at already-async points. `createSessionEngine` stays a sync `function`.

**Tech Stack:** Bun, TypeScript, existing `SessionStore`, `createSessionEngine`, `runGit`, raven eval fixtures.

**Spec:** `docs/superpowers/specs/2026-09-18-cancel-reset-followup.md`

## Global Constraints

- One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer **for operator answers**. Cancel abort-pair is a side effect of `abort('cancel')`, not a fourth host entry.
- Default prefix stays small and frozen. No new always-on tool.
- `dontAsk` never becomes `bypass`.
- BYOK is the product. Ads never touch BYOK.
- Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
- `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
- Leftover-ask still wins rewind: `rewindLast` refuses when any owned unpaired pending ask exists.
- Edit-resubmit stays host composition (`rewindLast` then `submitMessage`).
- No schema version bump. `pendingResetSha` lives on `SessionJob` (`job_json`).
- `createSessionEngine` stays `export function createSessionEngine(...): SessionEngine`. Do not make it async.
- Store `loadSession` and GET snapshot stay read-only (no reset).
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push. Do not copy y0/eve source.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification.

1. **I0.1 pointer pass is already in this worktree.** Do not re-do ARCHITECTURE / README / remaining-roadmap links. Task 6 only updates shipped wording, session-as-job OUT, CHANGELOG, and this spec’s Status/board after the code lands.

2. **`writeFollowup` set vs clear on upsert throw.** Set (`text !== null`) catches and returns `{ ok: false, notice: 'follow-up persist failed' }`. Clear (`text === null`) **rethrows** so `maybeRunFollowup` stays skip-on-throw. Do not change `maybeRunFollowup`. Build a shallow copy, upsert the copy, assign onto `session` only after upsert resolves.

3. **Abort-pair algorithm** (spec Critical 1). After `queryLoop` returns `cancelled`, for each `listPendingAsks(session.id)` row (both `kind: 'leftover'` and `kind: 'ask_user'`):
   - if `isCallPaired(callId)`: `deletePendingAsk` only
   - else: `persistSettledTool(makeToolMessage(callId, false, ABORTED_TEXT))` then `deletePendingAsk`
   - persist throw or delete throw → leave that row
   - if any row remains, yield `cancelled, ask still pending`
   Do **not** use `dropPendingAsk` here — it swallows delete errors. Leave `dropPendingAsk` unchanged for `applyAskAnswer`.

4. **I2 happy path is a real leftover-ask.** Persist a `tool_use`, hang `askUser`, then `abort('cancel')`. Expect 0 pending, no status line, **exactly one** aborted tool result. Do not flip the synthetic “pending row, no `tool_use`” test into the happy path. That fixture may be reused only for unpaired persist-fail.

5. **`maybeFinishRewindReset` signature:**

```ts
export async function maybeFinishRewindReset(opts: {
  session: SessionRecord
  store: SessionStore
  messages?: Message[]
}): Promise<{ ran: boolean; ok: boolean; notice?: string }>
```

No `job` or no `pendingResetSha` → `{ ran: false, ok: true }`. Otherwise the rewind success/fail epilogue against `pendingResetSha`. Todo snapshot comes from `opts.messages` if given, else `store.loadMessages?.(session.id) ?? []`.

6. **Recover points (already async).** Call the helper from:
   - `submitMessage` (before the pending-ask gate). Ignore `{ ok: false }`; `jobError` is set; the submit continues.
   - `rewindLast` (before leftover-ask / live-turn checks). If `{ ran: true }`, **return that result and do not drop another turn**.
   - host `/diff`: serve `GET …/diff` and TUI `applyDiffView` / OpenTUI `/diff` await `engine.maybeFinishRewindReset()` then read the tree.
   Do **not** call it from `createSessionEngine`. Do **not** add `store` to `jobDiff(job)`. Do **not** call it from store `loadSession` or GET snapshot.

7. **Engine method** (not a fourth host entry):

```ts
maybeFinishRewindReset(): Promise<{ ran: boolean; ok: boolean; notice?: string }>
```

Thin wrapper: `maybeFinishRewindReset({ session, store: opts.store, messages })`. Add it to `SessionEngine`. Test stubs that implement the whole interface must add a no-op.

8. **`rewindToCheckpoint` flag order.** After compact (if dropped ids), upsert `job.pendingResetSha = target sha`, then `git reset --hard`. Flag upsert throw → still attempt the reset. If reset then succeeds, continue the success epilogue (restore todos, **delete** the flag, upsert, project `todo.json`). Reset fail: keep the flag, `setSessionJobError`, do not apply todos, do not un-compact.

9. **Eval fixtures need dedicated runners.** `runEvalDir` throws `unknown eval fixture` for new directory names. Task 5 adds three `if (name === …)` branches and three `EvalExpect` keys. `run.test.ts` already walks the dir.

10. **Session-as-job OUT.** Task 6 amends `2026-09-16-session-as-job-roadmap.md` “parked leftover-ask rows are not denied by cancel” to point at this spec. Leave the historical wave text; add a one-line amendment at the top / Do-not-build bullet.

11. **No-job rewind is unchanged.** `pendingResetSha` exists only on `SessionJob`. `rewindLastTurn` does not grow a flag.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/session/followup.ts` | persist-then-assign; set returns `{ ok: false }`; clear rethrows |
| `packages/core/src/session/followup.test.ts` | persist-fail set + clear |
| `packages/core/src/loop/session-engine.ts` | cancel abort-pair; `maybeFinishRewindReset` wrapper; call sites |
| `packages/core/src/loop/session-engine.test.ts` | real leftover-ask cancel + unchanged paths |
| `packages/core/src/types.ts` | `SessionJob.pendingResetSha?`; `SessionEngine.maybeFinishRewindReset` |
| `packages/core/src/session/rewind.ts` | write/clear flag; export `maybeFinishRewindReset` |
| `packages/core/src/session/rewind.test.ts` | flag order + finish helper |
| `packages/core/src/index.ts` | export `maybeFinishRewindReset` |
| `packages/cli/src/serve.ts` | `GET …/diff` awaits finish then `jobDiff` |
| `packages/cli/src/serve.test.ts` | `/diff` finishes a pending reset |
| `packages/cli/src/app.tsx` | `/diff` awaits `engine.maybeFinishRewindReset` |
| `packages/cli/src/opentui-app.ts` | same |
| `packages/core/src/eval/run.ts` | three fixture runners |
| `packages/core/src/eval/fixtures/cancel-abort-pair/case.json` | I2 lock |
| `packages/core/src/eval/fixtures/rewind-reset-on-resume/case.json` | I3 lock |
| `packages/core/src/eval/fixtures/followup-persist-order/case.json` | I1 lock |
| docs listed in Task 6 | Status + session-as-job OUT + cancel wording |

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 writeFollowup persist-first | `followup.ts`, `followup.test.ts` |
| 2 live cancel abort-pair | `session-engine.ts` (cancel leftover block only), `session-engine.test.ts` (cancel describe) |
| 3 `pendingResetSha` on rewind | `types.ts` (`SessionJob` only), `rewind.ts`, `rewind.test.ts` (flag tests only) |
| 4 `maybeFinishRewindReset` + call sites | `rewind.ts` (helper), `rewind.test.ts` (finish tests), `session-engine.ts` / `.test.ts` (wrapper + submit/rewindLast), `types.ts` (`SessionEngine` method), `index.ts`, `serve.ts`, `serve.test.ts`, `app.tsx`, `opentui-app.ts` |
| 5 eval | `eval/run.ts`, three fixture dirs |
| 6 docs | ARCHITECTURE / `.ko.md`, `headless.md`, CHANGELOG, session-as-job spec, this spec Status/board |

Task 1 and Task 2 may run in parallel (disjoint files). Task 3 before Task 4. Task 5 after 1, 2, and 4. Task 6 last.

---

### Task 1: `writeFollowup` persist-then-assign (I1.1–I1.2)

**Files:**
- Modify: `packages/core/src/session/followup.ts`, `packages/core/src/session/followup.test.ts`

**Interfaces:**
- Consumes: `upsertSession(session: SessionRecord): Promise<void>`
- Produces: `writeFollowup` still returns `{ ok: true } | { ok: false; notice: string }`; set-path upsert throw → `{ ok: false, notice: 'follow-up persist failed' }`; clear-path upsert throw **rethrows**; memory unchanged on any fail

- [ ] **Step 1: Write the failing tests**

In `describe('writeFollowup')` add:

```ts
test('upsert throw on set leaves the previous slot and returns persist failed', async () => {
  const session = { id: 's1', updatedAt: 0, followup: 'keep' } as SessionRecord
  const store = {
    upsertSession: async () => {
      throw new Error('disk')
    },
  }
  expect(await writeFollowup(session, store, 'next')).toEqual({
    ok: false,
    notice: 'follow-up persist failed',
  })
  expect(session.followup).toBe('keep')
  expect(session.updatedAt).toBe(0)
})

test('upsert throw on clear leaves the slot and rethrows', async () => {
  const session = { id: 's1', updatedAt: 0, followup: 'keep' } as SessionRecord
  const store = {
    upsertSession: async () => {
      throw new Error('disk')
    },
  }
  await expect(writeFollowup(session, store, null)).rejects.toThrow('disk')
  expect(session.followup).toBe('keep')
  expect(session.updatedAt).toBe(0)
})
```

Keep the existing overwrite / trim / empty-trim tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/session/followup.test.ts`

Expected: FAIL — set path throws instead of `{ ok: false }`; after throw `session.followup` is already `'next'` / deleted.

- [ ] **Step 3: Implement persist-then-assign**

Replace `writeFollowup` with:

```ts
export async function writeFollowup(
  session: SessionRecord,
  store: { upsertSession(session: SessionRecord): Promise<void> },
  text: string | null,
): Promise<{ ok: true } | { ok: false; notice: string }> {
  if (text !== null) {
    const trimmed = text.trim()
    if (trimmed === '') return { ok: false, notice: 'follow-up text required' }
    const next: SessionRecord = { ...session, followup: trimmed, updatedAt: Date.now() }
    try {
      await store.upsertSession(next)
    } catch {
      return { ok: false, notice: 'follow-up persist failed' }
    }
    session.followup = trimmed
    session.updatedAt = next.updatedAt
    return { ok: true }
  }
  const next: SessionRecord = { ...session, updatedAt: Date.now() }
  delete next.followup
  await store.upsertSession(next)
  delete session.followup
  session.updatedAt = next.updatedAt
  return { ok: true }
}
```

Do not wrap the clear `upsertSession` in try/catch. Do not change `maybeRunFollowup`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/session/followup.test.ts`

Expected: PASS (existing overwrite/trim/empty + both new persist-fail tests + `maybeRunFollowup` skip-on-throw).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/followup.ts packages/core/src/session/followup.test.ts
git commit -m "$(cat <<'EOF'
fix: persist follow-up before assigning session memory

writeFollowup now upserts a copy first. Set-path persist fail
returns { ok: false } and leaves the previous slot; clear still
throws so maybeRunFollowup will not submit twice.
EOF
)"
```

---

### Task 2: Live cancel abort-pair (I2.1–I2.3)

**Files:**
- Modify: `packages/core/src/loop/session-engine.ts`, `packages/core/src/loop/session-engine.test.ts`

**Interfaces:**
- Consumes: `listPendingAsks`, `isCallPaired`, `persistSettledTool`, `deletePendingAsk`, `ABORTED_TEXT`, `makeToolMessage`
- Produces: after `end.reason === 'cancelled'`, this session’s pending rows are abort-paired per ruling 3; child rows untouched

- [ ] **Step 1: Add helpers + replace the cancel leftover test**

In `session-engine.test.ts`, next to `createFakeProvider`, add a minimal Echo that asks (copy the shape from `query-loop.test.ts`; do not import from that file):

```ts
function createAskEcho(): Tool<{ text: string }, string> {
  return {
    name: 'Echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    parse(input: unknown) {
      if (!input || typeof input !== 'object' || typeof (input as { text?: unknown }).text !== 'string') {
        return { ok: false as const, message: 'expected { text: string }' }
      }
      return { ok: true as const, value: { text: (input as { text: string }).text } }
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async checkPermissions() {
      return { behavior: 'ask' as const, message: 'Echo?' }
    },
    async execute(input: { text: string }) {
      return input.text
    },
  }
}

function toolThenStop(id: string, name: string, input: unknown): ProviderChunk[] {
  return [
    { type: 'tool_call', id, name, input },
    { type: 'stop', reason: 'tool_use' },
  ]
}

async function consumeUntilAsk(
  gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>,
): Promise<void> {
  while (true) {
    const next = await gen.next()
    if (next.done) throw new Error('ended before permission_ask')
    if (next.value.type === 'permission_ask') return
  }
}
```

Import `ABORTED_TEXT` from `./pairing`.

Replace `cancel leaves a parked leftover-ask and yields a status line` with:

```ts
test('live cancel abort-pairs a leftover-ask and does not emit ask still pending', async () => {
  const store = createMemoryStore()
  const sess = makeSession({ id: 'sess_cancel_ask' })
  await store.createSession(sess)
  const held = new Promise<'allow' | 'deny' | 'allow_always'>(() => {})
  const engine = createSessionEngine({
    ...engineOpts({
      provider: createFakeProvider([toolThenStop('call_park', 'Echo', { text: 'hi' })]),
      store,
      session: sess,
      tools: [createAskEcho()],
    }),
    askUser: async () => held,
  })
  const gen = engine.submitMessage('hi')
  await consumeUntilAsk(gen)
  expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
  engine.abort('cancel')
  const { events, result } = await drain(gen)
  expect(result).toEqual({ reason: 'cancelled' })
  expect(
    events.some((e) => e.type === 'status' && e.message === 'cancelled, ask still pending'),
  ).toBe(false)
  expect(await store.listPendingAsks(sess.id)).toHaveLength(0)
  const loaded = await store.loadSession(sess.id)
  const tools = loaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'call_park')
  expect(tools).toHaveLength(1)
  expect(tools[0]?.ok).toBe(false)
  expect((tools[0]?.blocks[0] as { text?: string })?.text).toBe(ABORTED_TEXT)
  expect(await engine.applyAskAnswer('call_park', 'deny')).toBe('matched')
})
```

Add:

```ts
test('unpaired persist-fail on cancel leaves the row and the status line', async () => {
  const store = createMemoryStore()
  const sess = makeSession({ id: 'sess_cancel_persist_fail' })
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
  const gen = engine.submitMessage('hi')
  await firstStreamEntered
  await store.upsertPendingAsk({
    callId: 'parked_1',
    sessionId: sess.id,
    kind: 'leftover',
    tool: 'Bash',
    message: 'Run ls?',
    input: { command: 'ls' },
    createdAt: 1,
  })
  store.persistToolResults = async () => {
    throw new Error('disk')
  }
  engine.abort('cancel')
  const { events, result } = await drain(gen)
  expect(result).toEqual({ reason: 'cancelled' })
  expect(
    events.some((e) => e.type === 'status' && e.message === 'cancelled, ask still pending'),
  ).toBe(true)
  expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
})

test('already-paired delete-fail on cancel leaves the row and the status line', async () => {
  const store = createMemoryStore()
  const sess = makeSession({ id: 'sess_cancel_drop_fail' })
  await store.createSession(sess)
  const held = new Promise<'allow' | 'deny' | 'allow_always'>(() => {})
  const engine = createSessionEngine({
    ...engineOpts({
      provider: createFakeProvider([toolThenStop('call_park', 'Echo', { text: 'hi' })]),
      store,
      session: sess,
      tools: [createAskEcho()],
    }),
    askUser: async () => held,
  })
  const gen = engine.submitMessage('hi')
  await consumeUntilAsk(gen)
  store.deletePendingAsk = async () => {
    throw new Error('disk')
  }
  engine.abort('cancel')
  const { events, result } = await drain(gen)
  expect(result).toEqual({ reason: 'cancelled' })
  expect(
    events.some((e) => e.type === 'status' && e.message === 'cancelled, ask still pending'),
  ).toBe(true)
  expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
})

test('interrupt leaves a leftover-ask', async () => {
  const store = createMemoryStore()
  const sess = makeSession({ id: 'sess_interrupt_ask' })
  await store.createSession(sess)
  const held = new Promise<'allow' | 'deny' | 'allow_always'>(() => {})
  const engine = createSessionEngine({
    ...engineOpts({
      provider: createFakeProvider([toolThenStop('call_park', 'Echo', { text: 'hi' })]),
      store,
      session: sess,
      tools: [createAskEcho()],
    }),
    askUser: async () => held,
  })
  const gen = engine.submitMessage('hi')
  await consumeUntilAsk(gen)
  engine.abort('interrupt')
  const { result } = await drain(gen)
  expect(result.reason).toBe('aborted')
  expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
})

test('parent cancel leaves a child leftover-ask', async () => {
  const store = createMemoryStore()
  const parent = makeSession({ id: 'sess_parent_cancel' })
  const child = makeSession({ id: 'sess_child_ask', parentSessionId: parent.id })
  await store.createSession(parent)
  await store.createSession(child)
  await store.upsertPendingAsk({
    callId: 'call_child',
    sessionId: child.id,
    kind: 'leftover',
    tool: 'Bash',
    message: 'Run ls?',
    input: { command: 'ls' },
    createdAt: 1,
  })
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
      session: parent,
    }),
  })
  const gen = engine.submitMessage('hi')
  await firstStreamEntered
  engine.abort('cancel')
  await drain(gen)
  expect(await store.listPendingAsks(child.id)).toHaveLength(1)
  expect(await store.listPendingAsks(parent.id)).toHaveLength(0)
})

test('cancel with no live turn does not drop leftover-asks', async () => {
  const store = createMemoryStore()
  const sess = makeSession({ id: 'sess_idle_cancel' })
  await store.createSession(sess)
  await store.upsertPendingAsk({
    callId: 'parked',
    sessionId: sess.id,
    kind: 'leftover',
    tool: 'Bash',
    message: 'Run ls?',
    input: { command: 'ls' },
    createdAt: 1,
  })
  const engine = createSessionEngine({
    ...engineOpts({ provider: createFakeProvider([]), store, session: sess }),
  })
  engine.abort('cancel')
  expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
})
```

Keep `host cancel yields cancelled and a later submit runs` and `cancelled turn persists lastEnd…`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/loop/session-engine.test.ts`

Expected: FAIL — happy-path still has length 1 and the status line; persist-fail / interrupt / no-live-turn may already pass (current code leaves rows). Happy path must fail first.

- [ ] **Step 3: Implement abort-pair**

In `session-engine.ts`, import `ABORTED_TEXT` (already imports `makeToolMessage` from `./pairing`). Replace the cancelled leftover block (`end.reason === 'cancelled'` / `listPendingAsks` / status line) with:

```ts
if (end.reason === 'cancelled') {
  const leftover = await opts.store.listPendingAsks(session.id)
  let remaining = false
  for (const row of leftover) {
    if (!(await isCallPaired(row.callId, session.id))) {
      try {
        await persistSettledTool(makeToolMessage(row.callId, false, ABORTED_TEXT), session.id)
      } catch {
        remaining = true
        continue
      }
    }
    try {
      await opts.store.deletePendingAsk(row.callId)
    } catch {
      remaining = true
      continue
    }
  }
  if (remaining) {
    yield { type: 'status', message: 'cancelled, ask still pending' }
  }
}
```

Do not abort-pair on `aborted` (interrupt). Do not walk child sessions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/loop/session-engine.test.ts`

Expected: PASS, including the new cancel tests and existing interrupt / lastEnd / pending-gate tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop/session-engine.ts packages/core/src/loop/session-engine.test.ts
git commit -m "$(cat <<'EOF'
fix: abort-pair leftover-asks on live cancel

Cancel of the live turn now drops this session's pending asks.
Already-paired calls drop only so queryLoop's ABORTED_TEXT is
not written twice. Interrupt, idle cancel, and child asks stay.
EOF
)"
```

---

### Task 3: `pendingResetSha` on job rewind (I3.1)

**Files:**
- Modify: `packages/core/src/types.ts`, `packages/core/src/session/rewind.ts`, `packages/core/src/session/rewind.test.ts`

**Interfaces:**
- Consumes: `recordCompact`, `runGit`, `upsertSession`, `setSessionJobError`
- Produces: `SessionJob.pendingResetSha?: string`; `rewindToCheckpoint` writes it after compact and before reset, clears it only on the success upsert

- [ ] **Step 1: Write the failing tests**

In `describe('rewindToCheckpoint')` add (reuse `tempDir` / `nextSession` / `initGitRepo` / `git` / `sessionRecord`):

```ts
test('writes pendingResetSha after compact and before reset, and clears it after success', async () => {
  const cwd = tempDir('ravenclaw-rewind-flag-order-')
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
  const flags: Array<string | undefined> = []
  const heads: string[] = []
  const orig = store.upsertSession.bind(store)
  store.upsertSession = async (session) => {
    flags.push(session.job?.pendingResetSha)
    heads.push(git(job.worktreePath, ['rev-parse', 'HEAD']))
    return orig(session)
  }

  const result = await rewindToCheckpoint({ session: sess, messages, store })
  expect(result.ok).toBe(true)
  expect(flags[0]).toBe(job.baseCommitSha)
  expect(heads[0]).toBe(laterSha)
  expect(sess.job?.pendingResetSha).toBeUndefined()
  const loaded = await store.loadSession(id)
  expect(loaded.session.job?.pendingResetSha).toBeUndefined()
})

test('reset fail keeps pendingResetSha', async () => {
  const cwd = tempDir('ravenclaw-rewind-flag-keep-')
  initGitRepo(cwd)
  const id = nextSession()
  const entered = enterSessionWorktree(id, cwd)
  expect(entered.ok).toBe(true)
  const job = entered.job!
  job.baseCommitSha = 'not-a-real-commit-sha'
  const store = createMemoryStore()
  const sess = sessionRecord({ id, cwd: job.worktreePath, job })
  await store.createSession(sess)
  const messages: Message[] = [user('u1', 'only', 1), assistant('a1', 'ok', 2)]
  await store.persistUser(id, messages[0] as Extract<Message, { role: 'user' }>)
  await store.persistAssistant(id, messages[1] as Extract<Message, { role: 'assistant' }>)

  const result = await rewindToCheckpoint({ session: sess, messages, store })
  expect(result.ok).toBe(false)
  expect(sess.job?.pendingResetSha).toBe('not-a-real-commit-sha')
  const loaded = await store.loadSession(id)
  expect(loaded.session.job?.pendingResetSha).toBe('not-a-real-commit-sha')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/session/rewind.test.ts`

Expected: FAIL — `pendingResetSha` is undefined on `SessionJob` / never written.

- [ ] **Step 3: Implement the flag**

In `types.ts`, add to `SessionJob`:

```ts
pendingResetSha?: string
```

In `rewindToCheckpoint`, after the compact block and **before** `runGit(..., ['reset', '--hard', sha])`:

```ts
opts.session.job = { ...job, pendingResetSha: sha }
opts.session.updatedAt = Date.now()
try {
  await opts.store.upsertSession(opts.session)
} catch {
  // still attempt the reset
}
```

On reset fail: leave `pendingResetSha` set (already on `session.job`). Existing `setSessionJobError` + upsert stays.

On success, **before** the success upsert:

```ts
const nextJob = { ...opts.session.job }
delete nextJob.pendingResetSha
opts.session.job = nextJob
```

Then restore todos, `clearSessionJobError`, upsert, project as today.

If the flag upsert failed and reset succeeded, still delete the in-memory flag and upsert the success state (ruling 8).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/session/rewind.test.ts`

Expected: PASS, including persist-before-reset and todo-projection tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/session/rewind.ts packages/core/src/session/rewind.test.ts
git commit -m "$(cat <<'EOF'
feat: record pendingResetSha before job rewind reset

Job rewind now upserts job.pendingResetSha after compact and
before git reset --hard, and clears it only after a successful
reset. Reset fail keeps the flag. No schema bump.
EOF
)"
```

---

### Task 4: `maybeFinishRewindReset` + recover points (I3.2–I3.3)

**Files:**
- Modify: `packages/core/src/session/rewind.ts`, `packages/core/src/session/rewind.test.ts`, `packages/core/src/loop/session-engine.ts`, `packages/core/src/loop/session-engine.test.ts`, `packages/core/src/types.ts`, `packages/core/src/index.ts`, `packages/cli/src/serve.ts`, `packages/cli/src/serve.test.ts`, `packages/cli/src/app.tsx`, `packages/cli/src/opentui-app.ts`

**Interfaces:**
- Consumes: `SessionJob.pendingResetSha`, `runGit`, `projectSessionTodos`, `setSessionJobError`, `clearSessionJobError`
- Produces: `maybeFinishRewindReset` (ruling 5); `SessionEngine.maybeFinishRewindReset` (ruling 7); call sites per ruling 6

- [ ] **Step 1: Write the failing helper + engine tests**

In `rewind.test.ts`:

```ts
test('maybeFinishRewindReset is a no-op without the flag and does not move HEAD', async () => {
  const cwd = tempDir('ravenclaw-finish-noop-')
  initGitRepo(cwd)
  const id = nextSession()
  const entered = enterSessionWorktree(id, cwd)
  expect(entered.ok).toBe(true)
  const job = entered.job!
  const later = git(job.worktreePath, ['rev-parse', 'HEAD'])
  const store = createMemoryStore()
  const sess = sessionRecord({ id, cwd: job.worktreePath, job })
  await store.createSession(sess)
  const out = await maybeFinishRewindReset({ session: sess, store })
  expect(out).toEqual({ ran: false, ok: true })
  expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(later)
})

test('maybeFinishRewindReset resets to the flag sha and clears it', async () => {
  const cwd = tempDir('ravenclaw-finish-ok-')
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
  job.pendingResetSha = job.baseCommitSha
  const store = createMemoryStore()
  const sess = sessionRecord({
    id,
    cwd: job.worktreePath,
    job,
    todos: [{ text: 'later', status: 'pending' }],
  })
  await store.createSession(sess)
  const checkpoint = { commitSha: job.baseCommitSha, todoSnapshot: [{ text: 'early', status: 'done' as const }], dirty: false }
  const messages: Message[] = [
    user('u0', 'first', 1),
    { ...assistant('a0', 'ok', 2), checkpoint },
  ]
  await store.persistUser(id, messages[0] as Extract<Message, { role: 'user' }>)
  await store.persistAssistant(id, messages[1] as Extract<Message, { role: 'assistant' }>)

  const out = await maybeFinishRewindReset({ session: sess, store, messages })
  expect(out.ran).toBe(true)
  expect(out.ok).toBe(true)
  expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(job.baseCommitSha)
  expect(sess.job?.pendingResetSha).toBeUndefined()
  expect(sess.todos).toEqual([{ text: 'early', status: 'done' }])
  expect(sess.jobError).toBeUndefined()
})

test('maybeFinishRewindReset reset-fail keeps the flag and does not apply todos', async () => {
  const cwd = tempDir('ravenclaw-finish-fail-')
  initGitRepo(cwd)
  const id = nextSession()
  const entered = enterSessionWorktree(id, cwd)
  expect(entered.ok).toBe(true)
  const job = entered.job!
  job.pendingResetSha = 'not-a-real-commit-sha'
  const store = createMemoryStore()
  const sess = sessionRecord({
    id,
    cwd: job.worktreePath,
    job,
    todos: [{ text: 'keep', status: 'pending' }],
  })
  await store.createSession(sess)
  const out = await maybeFinishRewindReset({ session: sess, store })
  expect(out.ran).toBe(true)
  expect(out.ok).toBe(false)
  expect(out.notice?.startsWith('rewind reset failed:')).toBe(true)
  expect(sess.job?.pendingResetSha).toBe('not-a-real-commit-sha')
  expect(sess.todos).toEqual([{ text: 'keep', status: 'pending' }])
  expect(sess.jobError?.startsWith('rewind reset failed:')).toBe(true)
})
```

In `session-engine.test.ts`, add the two engine tests **inside the existing job describe** that already has `initGitRepo` / `tempDir` / `nextSession` (around the auto-commit / rewind job tests). Do not open a new top-level describe — those helpers are describe-local. Construct an engine with `pendingResetSha` set and HEAD later; assert `git rev-parse HEAD` is still later; `drain(engine.submitMessage('hi'))`; HEAD is the flag sha and `session.job.pendingResetSha` is gone. Second test: `rewindLast` with the flag set finishes and does **not** drop another user turn (messages stay).

In `serve.test.ts`, extend the job `/diff` describe: set `runtime.engine.session.job.pendingResetSha` to `base`, commit a later file so HEAD ≠ base, `GET …/diff`, then `rev-parse HEAD` equals `base`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/session/rewind.test.ts ./packages/core/src/loop/session-engine.test.ts ./packages/cli/src/serve.test.ts`

Expected: FAIL — `maybeFinishRewindReset` is not exported; engine construct / submit / `/diff` leave HEAD later.

- [ ] **Step 3: Implement the helper and call sites**

In `rewind.ts`, export `maybeFinishRewindReset` per ruling 5. Body:

```ts
const job = opts.session.job
const sha = job?.pendingResetSha
if (!job || !sha) return { ran: false, ok: true }

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
  return { ran: true, ok: false, notice }
}

const rows = opts.messages ?? (opts.store.loadMessages ? await opts.store.loadMessages(opts.session.id) : [])
const checkpoint = lastAssistantCheckpoint(rows)
opts.session.todos = checkpoint
  ? checkpoint.todoSnapshot.map((item) => ({ ...item }))
  : []
const nextJob = { ...job }
delete nextJob.pendingResetSha
opts.session.job = nextJob
clearSessionJobError(opts.session)
opts.session.updatedAt = Date.now()
try {
  await opts.store.upsertSession(opts.session)
} catch {
  return { ran: true, ok: false, notice: 'rewind persist failed' }
}
const root = getSessionWorktree(opts.session.id)?.originalCwd ?? opts.session.cwd
let notice = formatRewindNotice({ restored: [], removed: [] }, 0)
try {
  projectSessionTodos(root, opts.session.todos ?? [])
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  notice = `${notice}; todo.json write failed: ${detail}`
}
return { ran: true, ok: true, notice }
```

`lastAssistantCheckpoint` is already in this file. Export the helper from `packages/core/src/index.ts` next to `rewindToCheckpoint`.

On `SessionEngine` add `maybeFinishRewindReset(): Promise<{ ran: boolean; ok: boolean; notice?: string }>`. Implement as the wrapper in ruling 7.

`submitMessage`: first awaited line inside the try (after lock renew is fine), `await maybeFinishRewindReset({ session, store: opts.store, messages })`.

`rewindLast`: **before** leftover-ask / live-turn checks:

```ts
const finished = await maybeFinishRewindReset({ session, store: opts.store, messages })
if (finished.ran) {
  return finished.ok
    ? { ok: true, notice: finished.notice ?? 'nothing to rewind' }
    : { ok: false, notice: finished.notice ?? 'rewind reset failed' }
}
```

Serve `GET …/diff` (`serve.ts` ~783): after loading the runtime, `await loaded.runtime.engine.maybeFinishRewindReset?.()`, then `jobDiff`.

Ink `applyDiffView` / `refreshDiff` and OpenTUI `/diff`: if `engine.maybeFinishRewindReset` exists, `void engine.maybeFinishRewindReset().then(() => { /* existing loadSessionDiff + setState */ })`. `loadSessionDiff` stays sync.

Do not change `jobDiff`. Do not call finish from GET snapshot.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/session/rewind.test.ts ./packages/core/src/loop/session-engine.test.ts ./packages/cli/src/serve.test.ts`

Expected: PASS. Engine construct alone does not reset. First `submitMessage` / `rewindLast` / `GET …/diff` does.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/rewind.ts packages/core/src/session/rewind.test.ts packages/core/src/loop/session-engine.ts packages/core/src/loop/session-engine.test.ts packages/core/src/types.ts packages/core/src/index.ts packages/cli/src/serve.ts packages/cli/src/serve.test.ts packages/cli/src/app.tsx packages/cli/src/opentui-app.ts
git commit -m "$(cat <<'EOF'
feat: finish pending job rewind on submit, rewind, and diff

maybeFinishRewindReset runs only at already-async recover
points. createSessionEngine stays sync. GET snapshot and
loadSession do not reset the worktree.
EOF
)"
```

---

### Task 5: Eval lock (I4.1)

**Files:**
- Modify: `packages/core/src/eval/run.ts`
- Create: `packages/core/src/eval/fixtures/cancel-abort-pair/case.json`, `packages/core/src/eval/fixtures/rewind-reset-on-resume/case.json`, `packages/core/src/eval/fixtures/followup-persist-order/case.json`

**Interfaces:**
- Consumes: Task 1–4 helpers
- Produces: three named runners; unknown names still throw

- [ ] **Step 1: Add fixtures + failing runners**

`cancel-abort-pair/case.json`:

```json
{ "prompt": "unused", "expect": { "cancelAbortPair": true } }
```

`rewind-reset-on-resume/case.json`:

```json
{ "prompt": "unused", "expect": { "rewindResetOnResume": true } }
```

`followup-persist-order/case.json`:

```json
{ "prompt": "unused", "expect": { "followupPersistOrder": true } }
```

Add the three keys to `EvalExpect`. In `runEvalDir`, add three `if (name === …)` branches **before** the unknown-name throw. Runners:

- `runCancelAbortPair`: same real leftover-ask as Task 2 happy path (`createAskEcho` + hang `askUser` + `abort('cancel')`). Throw if pending remains, if status line fired, or if tool rows for that `callId` ≠ 1. Second beat: no live turn + pending row + `abort('cancel')` leaves the row.
- `runRewindResetOnResume`: job worktree, later HEAD, `job.pendingResetSha = baseCommitSha`, `createSessionEngine`, assert HEAD still later, `submitMessage` with a text-stop provider, assert HEAD === base and flag gone.
- `runFollowupPersistOrder`: `writeFollowup` success then stub `upsertSession` to throw, `writeFollowup(..., 'next')` returns persist-failed and previous slot remains.

Copy `createAskEcho` / `initGitRepo` locally in `run.ts` (do not import test helpers). Reuse `makeSession` already in this file.

- [ ] **Step 2: Run eval to verify it fails until runners exist**

Run: `bun test ./packages/core/src/eval/run.test.ts`

Expected: FAIL on `unknown eval fixture` until the three `if` branches exist; then FAIL on the contracts if Tasks 1–4 regressed. After Tasks 1–4, adding empty branches that immediately `throw new Error('not implemented')` is the red step.

- [ ] **Step 3: Implement the three runners**

Fill the runners so the expects above pass. Mirror `runRewindPersistBeforeReset` for git setup (`finally` must `exitSessionWorktree` + `rmSync`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/eval/run.test.ts`

Expected: PASS, including the two existing rewind fixtures.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/eval/run.ts packages/core/src/eval/fixtures/cancel-abort-pair packages/core/src/eval/fixtures/rewind-reset-on-resume packages/core/src/eval/fixtures/followup-persist-order
git commit -m "$(cat <<'EOF'
test: lock cancel abort-pair, reset-on-resume, follow-up persist

Eval runners fail the suite if live cancel double-writes a tool
row, if engine construct resets a pending rewind, or if
writeFollowup mutates memory before upsert.
EOF
)"
```

---

### Task 6: Docs (I0 leftover + shipped wording)

**Files:**
- Modify: `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`, `docs/headless.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md`, `docs/superpowers/specs/2026-09-18-cancel-reset-followup.md`

**Interfaces:**
- Consumes: landed behavior from Tasks 1–5
- Produces: docs match the tree; spec Status = implemented (only after code is on this branch)

- [ ] **Step 1: Update cancel + reset wording**

- `ARCHITECTURE.md` / `.ko.md` / `docs/headless.md`: live `abort('cancel')` abort-pairs **this** session’s leftover-asks (drop-only when already paired). No live turn / interrupt / child ask unchanged. Stream emits `cancelled, ask still pending` only if a row remains.
- Job rewind: `pendingResetSha` after compact, before reset. First `submitMessage` / `rewindLast` / host `/diff` finishes it. `createSessionEngine` stays sync. GET snapshot does not reset.
- `writeFollowup` persist-then-assign.
- `CHANGELOG.md`: Unreleased bullet for the three holes.
- session-as-job spec: at the top after Status, add: “Amended by `2026-09-18-cancel-reset-followup.md`: live cancel abort-pairs this session’s leftover-ask.” Change the Do-not-build bullet “live `/cancel` abort-pair…” to “amended — see that spec.”
- This spec: `Status: implemented` (fill the ship SHA when known, or leave “this branch” until merge). Board rows I1–I4 → **done**.

Do not claim a web UI. Do not reopen parked doors.

- [ ] **Step 2: Commit**

```bash
git add ARCHITECTURE.md ARCHITECTURE.ko.md docs/headless.md CHANGELOG.md docs/superpowers/specs/2026-09-16-session-as-job-roadmap.md docs/superpowers/specs/2026-09-18-cancel-reset-followup.md
git commit -m "$(cat <<'EOF'
docs: mark cancel abort-pair, reset-on-resume, follow-up persist

ARCHITECTURE, headless, and session-as-job now match the three
honesty leftovers. Spec status flips to implemented.
EOF
)"
```

---

## Self-review

**Spec coverage**

| Spec slice | Task |
|---|---|
| I0.1 pointers | already in this worktree; Task 6 leftover only |
| I1.1–I1.2 writeFollowup | Task 1 |
| I2.1–I2.3 cancel abort-pair | Task 2 |
| I3.1 pendingResetSha | Task 3 |
| I3.2–I3.3 finish on submit/rewindLast/diff | Task 4 |
| I4.1 eval | Task 5 |
| Success checks 1–6 | Tasks 1, 2, 3, 4, 5 |

**Not in this plan (spec OUT / Important leftover the user did not unpark):** web UI, schema v11, async `createSessionEngine`, interrupt abort-pair, parent-cancels-child, no-job todo revert, `claimAsk` vs cancel race (live allow still goes through `askUser`; `applyAskAnswer` during live cancel stays the existing `claimAsk` lock).

**Type names:** `pendingResetSha`, `maybeFinishRewindReset`, `ABORTED_TEXT` match the spec and `pairing.ts`.
