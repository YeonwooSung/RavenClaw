# Leftover-ask abort-pair completeness + cancel 202/200 — Implementation Plan

I'm using the writing-plans skill to create the implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unpark cancel-without-live of this session’s parked leftover-asks, interrupt abort-pair of this session, and cancel HTTP 202/200. Spec + this plan first; then TDD in an isolated worktree.

**Architecture:** `abort` stays `void`. Live `abort('cancel')` still I2s this session in the cancelled epilogue and does **not** start the leftover flight. Idle cancel and interrupt set `startThisSessionLeftoverFlight()`; persist runs when `whenTreeStop()` is awaited via existing `persistBeforeDropAsk`. `whenTreeStop()` grows `thisSessionWork`. Serve live cancel returns 202 `{ ok: true }` without join; idle + work returns 200 after join.

**Tech Stack:** Bun, TypeScript, existing `SessionStore`, `createSessionEngine`, serve caches.

**Spec:** `docs/superpowers/specs/2026-09-20-leftover-ask-abort-pair.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer **for operator answers**. Abort-pair is a side effect of `abort`, not a fourth host entry and not a model turn.
- Default prefix small and frozen. No new always-on tool.
- `dontAsk` never becomes `bypass`.
- BYOK. Ads never touch BYOK.
- Clean-room. No vendor copy. **No web UI, no Next.js BFF, no Prisma Task, no Socket.IO, no wiki, no Grep/Glob docker-exec, no `ignored`.**
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push.
- `createSessionEngine` stays `export function createSessionEngine(...): SessionEngine`. Do not make it async.
- No schema version bump. No `POST /clear`. Do not make `abort` async.
- Tree-stop of descendants stays cancel-only. Interrupt is not tree-stop.
- Do not switch live-cancel JSON to `{ accepted: true }`. Do not change POST submit 202, compact, or resolve status codes.
- Idle this-session I2 invents no `lastEnd`. Do not emit `cancelled, ask still pending` on `aborted`.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification only.

1. **Reuse `persistBeforeDropAsk`.** Cancelled epilogue, tree-stop descendant walk, idle this-session cancel, and interrupt this-session all call it. Do not add a second I2 helper.

2. **`whenTreeStop(): Promise<{ descendantWork: boolean; thisSessionWork: boolean }>`.** Persist of leftover-flight rows and tree-stop rows starts when this is awaited, not inside sync `abort`. Live `abort('cancel')` does **not** call `startThisSessionLeftoverFlight()`. Idle cancel and interrupt do.

3. **Flip, do not keep green against new code.** Rename/replace `cancel with no live turn does not drop leftover-asks` and `interrupt leaves a leftover-ask`. Flip idle-parent-keeps-this-session-parked. Keep `parent interrupt leaves a child leftover-ask`. Update every `whenTreeStop()` equality that currently omits `thisSessionWork`.

4. **Serve envelope.** Live → **202** `{ ok: true }` without join. Idle + work (this-session leftover-asks and/or descendant work) → **200** `{ ok: true }` after join. Idle + nothing and stale live `turnId` stay **200** `no_active_turn`. `probeIdleCancel` includes `listPendingAsks(this session)`. Submit stays 202 `{ accepted: true, sessionId }`.

5. **TUI notice.** `stopped` if `wasLive || tree.descendantWork || tree.thisSessionWork`. OpenTUI double-stop `killAll` unchanged.

6. **Eval.** `cancel-abort-pair` idle beat now drops. Add interrupt this-session drop + parent-interrupt child-row-stays. Flip parent-tree-stop eval parked beat so the two fixtures do not lock opposite laws.

7. **Wrappers / stubs.** `ServeEngine.whenTreeStop`, `followup.ts` optional engine type, `log.test.ts` / `opentui-app.test.ts` / `slash/dispatch.test.ts` / `serve.test.ts` stubs return `{ descendantWork: false, thisSessionWork: false }`. Forwarders in `log.ts` and `engine.ts` need no body change.

8. **Worktree.** Implement in this worktree (`/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/leftover-ask-abort-pair`) or a later isolated worktree. Never on `main`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/types.ts` | `SessionEngine.whenTreeStop` return grows `thisSessionWork` |
| `packages/core/src/loop/session-engine.ts` | leftover flight flags; idle cancel + interrupt start it; live cancel does not; cancelled epilogue uses `persistBeforeDropAsk`; aborted path `await whenTreeStop()` |
| `packages/core/src/loop/session-engine.test.ts` | flip idle-leave-row + interrupt-leave-row; keep parent-interrupt-child; lastEnd; persist-fail |
| `packages/core/src/session/followup.ts` | optional `whenTreeStop` type grows `thisSessionWork` |
| `packages/core/src/log.ts` | forward `whenTreeStop` (no body change) |
| `packages/core/src/log.test.ts` | stub return shape |
| `packages/cli/src/engine.ts` | forward `whenTreeStop` (no body change) |
| `packages/cli/src/serve.ts` | live 202 without join; `probeIdleCancel` counts this-session asks; idle + work 200 after join |
| `packages/cli/src/serve.test.ts` | flip live cancel 200→202; idle this-session leftover; keep stale-live and idle-nothing |
| `packages/cli/src/app.tsx` | `/stop` notice includes `thisSessionWork` |
| `packages/cli/src/opentui-app.ts` | same |
| `packages/cli/src/opentui-app.test.ts` | stub + idle this-session notice |
| `packages/cli/src/slash/dispatch.test.ts` | stub return shape |
| `packages/core/src/eval/run.ts` | `cancel-abort-pair` idle/interrupt beats; parent-tree-stop parked beat |
| docs listed in Task 6 | L0 pointers + shipped wording after code |

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 L1 idle I2 + join shape | `types.ts`, `session-engine.ts` (leftover flight, cancelled epilogue helper, idle cancel start), `session-engine.test.ts` (idle flips + lastEnd + persist-fail this-session), `followup.ts` type, stub engines (`log.test.ts`, `opentui-app.test.ts`, `slash/dispatch.test.ts`, `serve.test.ts` stub return) |
| 2 L2 interrupt I2 | `session-engine.ts` (`abort('interrupt')` + aborted path), `session-engine.test.ts` (flip interrupt this-session; keep parent-interrupt-child) |
| 3 L3 serve 202/200 | `serve.ts` cancel handler + `probeIdleCancel`, `serve.test.ts` envelope |
| 4 L3.4 TUI notice | `app.tsx`, `opentui-app.ts`, `opentui-app.test.ts` |
| 5 L4.1 eval | `eval/run.ts` (`runCancelAbortPair`, `runParentTreeStop` parked beat) |
| 6 L4.2 shipped docs | spec Status/board after code; ARCHITECTURE / `.ko.md`, SLASH_COMMANDS / `.ko.md`, headless, remaining-roadmap, CHANGELOG, eve/y0 closers, prior spec OUT |

Task 1 first (join shape + leftover flight). Task 2 after 1 (same flight, aborted path). Task 3 after 1 (probe + 202). Task 4 after 1 (notice field). Task 5 after 1–2. Task 6 last.

---

### Task 1: L1 idle this-session I2 + leftover flight + `whenTreeStop` shape

**Files:**
- Modify: `packages/core/src/types.ts:499`
- Modify: `packages/core/src/loop/session-engine.ts` (`treeStopFlight` type ~152, `whenTreeStop` ~293, cancelled epilogue ~907–934, `abort` ~1098)
- Modify: `packages/core/src/loop/session-engine.test.ts` (idle-leave-row ~2583, idle-no-descendants ~2510, idle-parent-tree-stop ~2462, live parent whenTreeStop expects ~2305 / ~2575)
- Modify: `packages/core/src/session/followup.ts:96` and `:132`
- Modify stubs: `packages/core/src/log.test.ts:151`, `packages/cli/src/opentui-app.test.ts:141`, `packages/cli/src/slash/dispatch.test.ts:51`, `packages/cli/src/serve.test.ts:272`, `packages/cli/src/serve.ts:208`

**Interfaces:**
- Consumes: existing `persistBeforeDropAsk(row): Promise<boolean>` (true = remaining), `startTreeStopFlight(abortedLiveChild: boolean): void`, `abort(kind?: 'cancel' | 'interrupt'): void`
- Produces: `whenTreeStop(): Promise<{ descendantWork: boolean; thisSessionWork: boolean }>`, `startThisSessionLeftoverFlight(): void`

- [ ] **Step 1: Write the failing tests**

In `describe('cancel')` of `packages/core/src/loop/session-engine.test.ts`, **replace** `cancel with no live turn does not drop leftover-asks` (do not leave the old title green):

```ts
test('idle cancel abort-pairs this session leftover-asks', async () => {
  const store = createMemoryStore()
  const sess = makeSession({ id: 'sess_idle_cancel' })
  await store.createSession(sess)
  await store.persistToolCalls(sess.id, {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'parked', name: 'Bash', input: { command: 'ls' } }],
    createdAt: 1,
  })
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
  expect(engine.session.lastEnd).toBeUndefined()
  engine.abort('cancel')
  expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
  await expect(engine.whenTreeStop()).resolves.toEqual({
    descendantWork: false,
    thisSessionWork: true,
  })
  expect(await store.listPendingAsks(sess.id)).toHaveLength(0)
  expect(engine.session.lastEnd).toBeUndefined()
  const reloaded = await store.loadSession(sess.id)
  expect(reloaded.session.lastEnd).toBeUndefined()
  const tools = reloaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'parked')
  expect(tools).toHaveLength(1)
  expect((tools[0]?.blocks[0] as { text?: string })?.text).toBe(ABORTED_TEXT)
})
```

Replace `idle parent cancel with no descendants reports no descendant work` so the row is gone and `thisSessionWork: true`. Replace `idle parent tree-stop drops descendant leftover-asks and keeps this session parked` so **both** rows are gone:

```ts
test('idle parent tree-stop drops descendant leftover-asks and this session parked', async () => {
  // same fixture as today (parent parked_parent + child call_child)
  engine.abort('cancel')
  await expect(engine.whenTreeStop()).resolves.toEqual({
    descendantWork: true,
    thisSessionWork: true,
  })
  expect(await store.listPendingAsks(child.id)).toHaveLength(0)
  expect(await store.listPendingAsks(parent.id)).toHaveLength(0)
  expect(engine.session.lastEnd).toBeUndefined()
  const reloaded = await store.loadSession(parent.id)
  expect(reloaded.session.lastEnd).toBeUndefined()
  const childLoaded = await store.loadSession(child.id)
  expect(childLoaded.session.lastEnd).toBeUndefined()
})
```

Add persist-fail this-session idle:

```ts
test('idle cancel persist-fail leaves this session leftover-ask', async () => {
  const store = createMemoryStore()
  const sess = makeSession({ id: 'sess_idle_persist_fail' })
  await store.createSession(sess)
  await store.persistToolCalls(sess.id, {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'parked', name: 'Bash', input: { command: 'ls' } }],
    createdAt: 1,
  })
  await store.upsertPendingAsk({
    callId: 'parked',
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
  const engine = createSessionEngine({
    ...engineOpts({ provider: createFakeProvider([]), store, session: sess }),
  })
  engine.abort('cancel')
  await expect(engine.whenTreeStop()).resolves.toEqual({
    descendantWork: false,
    thisSessionWork: true,
  })
  expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
  expect(engine.session.lastEnd).toBeUndefined()
})
```

Update existing `toEqual({ descendantWork: true })` at live-parent-child (~2305) and persist-fail-descendants (~2575) to `{ descendantWork: true, thisSessionWork: false }`. Keep `live cancel abort-pairs a leftover-ask and does not emit ask still pending` (exactly one `ABORTED_TEXT`).

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/loop/session-engine.test.ts
```

Expected: FAIL — `whenTreeStop` result missing `thisSessionWork`; idle cancel still leaves the row; idle parent still keeps this session parked.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/types.ts` change:

```ts
whenTreeStop(): Promise<{ descendantWork: boolean; thisSessionWork: boolean }>
```

Same shape on `packages/cli/src/serve.ts` `ServeEngine.whenTreeStop`, `packages/core/src/session/followup.ts` optional engine fields, and every stub `whenTreeStop` (`log.test.ts`, `opentui-app.test.ts`, `slash/dispatch.test.ts`, `serve.test.ts` mock). Stub body:

```ts
async whenTreeStop() {
  return { descendantWork: false, thisSessionWork: false }
}
```

In `session-engine.ts`, next to `treeStopRequested`:

```ts
type TreeStopResult = { descendantWork: boolean; thisSessionWork: boolean }
let treeStopFlight: Promise<TreeStopResult> | undefined
let leftoverFlightRequested = false

function startThisSessionLeftoverFlight(): void {
  leftoverFlightRequested = true
}

async function runThisSessionLeftoverPass(): Promise<{ thisSessionWork: boolean }> {
  let attempted = false
  const rows = await opts.store.listPendingAsks(session.id)
  for (const row of rows) {
    attempted = true
    try {
      await persistBeforeDropAsk(row)
    } catch {
      // continue other this-session rows
    }
  }
  return { thisSessionWork: attempted }
}
```

Change `runTreeStopPass` / `enqueueTreeStopPass` / `whenTreeStop` so the join OR-reduces both flags. Persist still starts only inside the awaited pass:

```ts
function whenTreeStop(): Promise<TreeStopResult> {
  const needTree = treeStopRequested
  const abortedLiveChild = treeStopAbortedLiveChild
  const needLeftover = leftoverFlightRequested
  if (needTree) {
    treeStopRequested = false
    treeStopAbortedLiveChild = false
  }
  if (needLeftover) leftoverFlightRequested = false
  if (!needTree && !needLeftover) {
    return treeStopFlight ?? Promise.resolve({ descendantWork: false, thisSessionWork: false })
  }
  const prev = treeStopFlight
  const pass = (async () => {
    const prior = prev ? await prev : { descendantWork: false, thisSessionWork: false }
    let descendantWork = prior.descendantWork
    let thisSessionWork = prior.thisSessionWork
    try {
      if (needTree) {
        const next = await runTreeStopPass(abortedLiveChild)
        descendantWork = descendantWork || next.descendantWork
      }
      if (needLeftover) {
        const next = await runThisSessionLeftoverPass()
        thisSessionWork = thisSessionWork || next.thisSessionWork
      }
    } catch {
      descendantWork = descendantWork || (needTree && abortedLiveChild)
      thisSessionWork = thisSessionWork || needLeftover
    }
    return { descendantWork, thisSessionWork }
  })()
  treeStopFlight = pass
  return pass
}
```

`abort('cancel')`: keep descendant `child.abort('cancel')` first, then this `abortTurn` if live, then `startTreeStopFlight`. **If `liveTurn` is set, return without leftover flight.** If idle, also `startThisSessionLeftoverFlight()`.

Cancelled epilogue (~907): replace the inlined persist/delete loop with:

```ts
if (end.reason === 'cancelled') {
  const leftover = await opts.store.listPendingAsks(session.id)
  let remaining = false
  for (const row of leftover) {
    try {
      if (await persistBeforeDropAsk(row)) remaining = true
    } catch {
      remaining = true
    }
  }
  await whenTreeStop()
  if (!remaining) {
    for (const row of await listOwnedPendingAsks()) {
      if (!(await isCallPaired(row.callId, row.sessionId))) remaining = true
    }
  }
  if (remaining) {
    yield { type: 'status', message: 'cancelled, ask still pending' }
  }
}
```

Do not persist leftover-asks inside the sync `abort` function.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/session/followup.test.ts ./packages/core/src/log.test.ts
```

Expected: PASS. Live cancel still exactly one `ABORTED_TEXT`. Idle cancel drops this-session row only after `whenTreeStop()`. Idle invents no `lastEnd`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts \
  packages/core/src/loop/session-engine.ts \
  packages/core/src/loop/session-engine.test.ts \
  packages/core/src/session/followup.ts \
  packages/core/src/log.test.ts \
  packages/cli/src/serve.ts \
  packages/cli/src/serve.test.ts \
  packages/cli/src/opentui-app.test.ts \
  packages/cli/src/slash/dispatch.test.ts
git commit -m "$(cat <<'EOF'
feat: idle cancel abort-pairs this session leftover-asks

whenTreeStop grows thisSessionWork. Leftover flight persist
starts on join. Live cancel still owns this-session I2 in
the cancelled epilogue.
EOF
)"
```

---

### Task 2: L2 interrupt this-session I2

**Files:**
- Modify: `packages/core/src/loop/session-engine.ts` (`abort` interrupt branch ~1115, queryLoop result ~907)
- Modify: `packages/core/src/loop/session-engine.test.ts` (`interrupt leaves a leftover-ask` ~2206; keep `parent interrupt leaves a child leftover-ask` ~2413)

**Interfaces:**
- Consumes: `startThisSessionLeftoverFlight()`, `whenTreeStop()`, `persistBeforeDropAsk`
- Produces: interrupt (live or idle) I2s this session; aborted stream has no `cancelled, ask still pending`; parent interrupt still leaves a child store row

- [ ] **Step 1: Write the failing tests**

Replace `interrupt leaves a leftover-ask` (do not leave the old title green):

```ts
test('interrupt abort-pairs this session leftover-asks', async () => {
  const store = createMemoryStore()
  const sess = makeSession({ id: 'sess_interrupt_ask' })
  await store.createSession(sess)
  await store.persistToolCalls(sess.id, {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'parked_1', name: 'Bash', input: { command: 'ls' } }],
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
      session: sess,
    }),
  })
  const gen = engine.submitMessage('hi')
  const pending = drain(gen)
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
  engine.abort('interrupt')
  const { events, result } = await pending
  expect(result.reason).toBe('aborted')
  expect(
    events.some((e) => e.type === 'status' && e.message === 'cancelled, ask still pending'),
  ).toBe(false)
  expect(await store.listPendingAsks(sess.id)).toHaveLength(0)
  const loaded = await store.loadSession(sess.id)
  const tools = loaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'parked_1')
  expect(tools).toHaveLength(1)
  expect((tools[0]?.blocks[0] as { text?: string })?.text).toBe(ABORTED_TEXT)
  expect(engine.session.lastEnd).toEqual({ reason: 'aborted' })
})
```

Add idle interrupt (no live turn, no `lastEnd`):

```ts
test('idle interrupt abort-pairs this session leftover-asks and invents no lastEnd', async () => {
  const store = createMemoryStore()
  const sess = makeSession({ id: 'sess_idle_interrupt' })
  await store.createSession(sess)
  await store.persistToolCalls(sess.id, {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'parked', name: 'Bash', input: { command: 'ls' } }],
    createdAt: 1,
  })
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
  engine.abort('interrupt')
  await expect(engine.whenTreeStop()).resolves.toEqual({
    descendantWork: false,
    thisSessionWork: true,
  })
  expect(await store.listPendingAsks(sess.id)).toHaveLength(0)
  expect(engine.session.lastEnd).toBeUndefined()
})
```

Keep `parent interrupt leaves a child leftover-ask` unchanged (child pending length 1, parent `result.reason === 'aborted'`).

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/loop/session-engine.test.ts
```

Expected: FAIL — interrupt still leaves this-session row; idle interrupt does not set leftover flight.

- [ ] **Step 3: Write minimal implementation**

In `abort`:

```ts
abort(kind?: 'cancel' | 'interrupt') {
  cancelBackgroundReview?.()
  cancelBackgroundReview = undefined
  replayAbort?.abort()
  if (kind === 'cancel') {
    let abortedLiveChild = false
    for (const child of childEngines.values()) {
      if (child.liveTurnId() !== null) abortedLiveChild = true
      child.abort('cancel')
    }
    if (liveTurn) {
      if (liveTurn.cancelKind === undefined) liveTurn.cancelKind = 'cancel'
      abortTurn(liveTurn.abort)
      startTreeStopFlight(abortedLiveChild)
      return
    }
    startTreeStopFlight(abortedLiveChild)
    startThisSessionLeftoverFlight()
    return
  }
  if (liveTurn) {
    if (liveTurn.cancelKind === undefined) liveTurn.cancelKind = kind ?? 'interrupt'
    abortTurn(liveTurn.abort)
  }
  startThisSessionLeftoverFlight()
},
```

After `const end = yield* queryLoop(loopOpts)` keep the cancelled epilogue, then:

```ts
if (end.reason === 'aborted') {
  await whenTreeStop()
}
```

Do not yield `cancelled, ask still pending` on aborted. Do not start `treeStopFlight` from interrupt. Do not `child.abort('cancel')` from interrupt.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/loop/session-engine.test.ts
```

Expected: PASS. Parent interrupt still leaves the child row. This-session interrupt drops the row. Aborted events have no cancel status line.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop/session-engine.ts packages/core/src/loop/session-engine.test.ts
git commit -m "$(cat <<'EOF'
feat: interrupt abort-pairs this session leftover-asks

Steer is still not tree-stop. Parent interrupt leaves a
child leftover-ask. Aborted streams do not emit ask still
pending.
EOF
)"
```

---

### Task 3: L3 serve cancel 202/200

**Files:**
- Modify: `packages/cli/src/serve.ts` (`probeIdleCancel` ~510, cancel handler ~697–733, `ServeEngine.whenTreeStop` if not already updated in Task 1)
- Modify: `packages/cli/src/serve.test.ts` (live cancel ~544 and ~593, idle nothing ~646, stale live ~578; add idle this-session leftover)

**Interfaces:**
- Consumes: `engine.abort('cancel')`, `engine.whenTreeStop(): Promise<{ descendantWork: boolean; thisSessionWork: boolean }>`, `engine.liveTurnId()`, `store.listPendingAsks`
- Produces: live 202 `{ ok: true }` without join; idle + work 200 `{ ok: true }` after join; idle + nothing and stale live `turnId` 200 `no_active_turn`

- [ ] **Step 1: Write the failing tests**

Flip live cancel from 200 to 202. In `POST /v1/session/:id/cancel and compact require Bearer and call the engine`:

```ts
expect(cancel.status).toBe(202)
expect(compact.status).toBe(200)
```

Replace `POST cancel on a live parent returns ok without awaiting tree-stop`:

```ts
test('POST cancel on a live parent returns 202 without awaiting tree-stop', async () => {
  const ctx = makeServeCtx('t')
  let joinCalled = false
  const engine = (ctx as unknown as { runtimeForSession: Function })
  // hang whenTreeStop on the mock already returned by makeServeCtx:
  const runtime = await ctx.runtimeForSession!('s1')
  runtime!.engine.whenTreeStop = async () => {
    joinCalled = true
    await new Promise(() => {})
    return { descendantWork: false, thisSessionWork: false }
  }
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/cancel', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
    }),
    ctx,
  )
  expect(res.status).toBe(202)
  expect(await res.json()).toEqual({ ok: true })
  expect(ctx.abortCalls).toBe(1)
  expect(ctx.abortKinds).toEqual(['cancel'])
  expect(joinCalled).toBe(false)
})
```

If hanging `whenTreeStop` on the runtime is awkward, keep `makeServeCtx`’s mock and instead assert status 202 + `abortCalls === 1` (the mock `whenTreeStop` resolving is still wrong if the handler awaits it — so make the mock hang and rely on the request finishing):

```ts
async whenTreeStop() {
  if (state.liveTurnId !== null) {
    throw new Error('live cancel must not join whenTreeStop')
  }
  return { descendantWork: state.descendantWork, thisSessionWork: false }
}
```

Live cancel must not throw. That is the join-guard.

Add idle this-session leftover-ask (session `s1`, `setLiveTurnId(null)`):

```ts
test('POST cancel idle parent with this-session leftover-ask returns 200 after join', async () => {
  const ctx = makeServeCtx('t')
  ctx.setLiveTurnId(null)
  await ctx.store.upsertPendingAsk({
    callId: 'parked_s1',
    sessionId: 's1',
    kind: 'leftover',
    tool: 'Bash',
    message: 'Bash?',
    input: { command: 'ls' },
    createdAt: 1,
  } satisfies PendingAsk)
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/cancel', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
    }),
    ctx,
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(ctx.abortCalls).toBe(1)
})
```

Keep:

- `POST cancel with stale turnId is a no-op` → 200 `{ ok: true, status: 'no_active_turn' }`, `abortCalls === 0`
- `POST cancel idle parent with no descendant work is no_active_turn` (no this-session ask either)
- `POST cancel idle parent with descendant leftover-ask returns ok and walks` → still 200 `{ ok: true }`
- `POST cancel idle parent with stale turnId still tree-stops descendants` → still 200 `{ ok: true }`
- submit 202 `{ accepted: true, sessionId }` tests unchanged

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/cli/src/serve.test.ts
```

Expected: FAIL — live cancel still 200; idle this-session leftover still `no_active_turn` because `probeIdleCancel` ignores this session.

- [ ] **Step 3: Write minimal implementation**

`probeIdleCancel`:

```ts
async function probeIdleCancel(
  ctx: ServeRequestContext,
  store: ServeRuntime['store'],
  sessionId: string,
): Promise<{ leftover: boolean; cacheLive: boolean; hasDescendants: boolean }> {
  const ids = store?.listSessions ? await listDescendantSessionIds(store, sessionId) : []
  let leftover = false
  if (store?.listPendingAsks) {
    if ((await store.listPendingAsks(sessionId)).length > 0) leftover = true
    if (!leftover) {
      for (const id of ids) {
        if ((await store.listPendingAsks(id)).length > 0) {
          leftover = true
          break
        }
      }
    }
  }
  return {
    leftover,
    cacheLive: cachedDescendantLive(ctx, new Set(ids)),
    hasDescendants: ids.length > 0,
  }
}
```

Cancel handler success path:

```ts
const live = loaded.runtime.engine.liveTurnId?.() ?? null
if (parsed.turnId !== undefined && live !== null && parsed.turnId !== live) {
  return Response.json({ ok: true, status: 'no_active_turn' })
}
if (live !== null) {
  await abortCachedDescendants(ctx, loaded.runtime.store, sessionId)
  loaded.runtime.engine.abort('cancel')
  return Response.json({ ok: true }, { status: 202 })
}
const probe = await probeIdleCancel(ctx, loaded.runtime.store, sessionId)
if (!probe.leftover && !probe.cacheLive && !probe.hasDescendants) {
  return Response.json({ ok: true, status: 'no_active_turn' })
}
await abortCachedDescendants(ctx, loaded.runtime.store, sessionId)
loaded.runtime.engine.abort('cancel')
const tree = await loaded.runtime.engine.whenTreeStop?.()
if (tree?.descendantWork || tree?.thisSessionWork || probe.leftover || probe.cacheLive) {
  return Response.json({ ok: true })
}
return Response.json({ ok: true, status: 'no_active_turn' })
```

Do not change POST submit 202, compact, or resolve.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/cli/src/serve.test.ts
```

Expected: PASS. Live 202. Idle this-session leftover 200 `{ ok: true }`. Stale live `turnId` still 200 `no_active_turn`. Submit still 202 `{ accepted: true, sessionId }`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve.ts packages/cli/src/serve.test.ts
git commit -m "$(cat <<'EOF'
feat: serve live cancel 202 and idle leftover-ask as work

Live POST /cancel returns 202 { ok: true } without joining
whenTreeStop. Idle this-session parked asks are work and
return 200 after join.
EOF
)"
```

---

### Task 4: L3.4 TUI `/stop` notice

**Files:**
- Modify: `packages/cli/src/app.tsx:451-457`
- Modify: `packages/cli/src/opentui-app.ts:328-337`
- Modify: `packages/cli/src/opentui-app.test.ts` (stub already returns `thisSessionWork` from Task 1; add notice test)

**Interfaces:**
- Consumes: `whenTreeStop(): Promise<{ descendantWork: boolean; thisSessionWork: boolean }>`, `abort('cancel')`, `liveTurnId()`
- Produces: notice `stopped` if `wasLive || descendantWork || thisSessionWork`

- [ ] **Step 1: Write the failing test**

In `packages/cli/src/opentui-app.test.ts`, next to `idle parent /stop with descendant work prints stopped`:

```ts
test('idle parent /stop with this-session leftover work prints stopped', async () => {
  const engine = fakeEngine(makeSession(), emptyTurn)
  engine.whenTreeStop = async () => ({ descendantWork: false, thisSessionWork: true })
  const written: string[] = []
  const code = await runOpenTuiApp(fakeRuntime(engine, { store: fakeStore() }), {
    input: asyncLines('/stop', '/quit'),
    write: (chunk) => {
      written.push(chunk)
    },
  })
  expect(code).toBe(0)
  expect(written.join('')).toContain('stopped')
  expect(written.join('')).not.toContain('nothing to stop')
})
```

Keep `idle parent /stop with descendant work prints stopped` (stub must include `thisSessionWork: false` if you replace the object):

```ts
engine.whenTreeStop = async () => ({ descendantWork: true, thisSessionWork: false })
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
bun test ./packages/cli/src/opentui-app.test.ts
```

Expected: FAIL — notice still uses only `wasLive || descendantWork`, so this-session-only work prints `nothing to stop`.

- [ ] **Step 3: Write minimal implementation**

Ink (`app.tsx`):

```ts
case 'stop':
  void (async () => {
    const wasLive = runtimeRef.current.engine.liveTurnId() !== null
    runtimeRef.current.engine.abort('cancel')
    const tree = await runtimeRef.current.engine.whenTreeStop()
    setNotice(
      wasLive || tree.descendantWork || tree.thisSessionWork ? 'stopped' : 'nothing to stop',
    )
  })()
  return
```

OpenTUI (`opentui-app.ts`):

```ts
const tree = await current.engine.whenTreeStop()
write(
  wasLive || tree.descendantWork || tree.thisSessionWork ? 'stopped\n' : 'nothing to stop\n',
)
```

Do not change the `kill_all` branch.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/cli/src/opentui-app.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/app.tsx packages/cli/src/opentui-app.ts packages/cli/src/opentui-app.test.ts
git commit -m "$(cat <<'EOF'
feat: TUI /stop treats this-session leftover-asks as work

Notice is stopped when whenTreeStop reports thisSessionWork.
OpenTUI double-stop killAll is unchanged.
EOF
)"
```

---

### Task 5: L4.1 eval lock

**Files:**
- Modify: `packages/core/src/eval/run.ts` (`runCancelAbortPair` ~1184–1234, `runParentTreeStop` parked beat ~1355–1386)

**Interfaces:**
- Consumes: `engine.abort`, `engine.whenTreeStop()`, `store.listPendingAsks`, `ABORTED_TEXT`
- Produces: idle this-session parked now drops; interrupt this-session now drops; descendant interrupt still leaves child row; parent-tree-stop parked beat agrees

- [ ] **Step 1: Flip the eval beats so they fail on the old law**

In `runCancelAbortPair`, replace the idle beat that currently throws if the row is not length 1. After live-cancel (existing), keep `await engine.close()` at the end of the function. Idle beat:

```ts
idleEngine.abort('cancel')
const idleTree = await idleEngine.whenTreeStop()
if (!idleTree.thisSessionWork) {
  throw new Error('cancel-abort-pair: idle cancel reported no thisSessionWork')
}
if (idleTree.descendantWork) {
  throw new Error('cancel-abort-pair: idle this-session cancel reported descendant work')
}
const still = await idleStore.listPendingAsks(idle.id)
if (still.length !== 0) {
  throw new Error(`cancel-abort-pair: idle cancel left leftover: ${still.length}`)
}
if (idleEngine.session.lastEnd !== undefined) {
  throw new Error('cancel-abort-pair: idle cancel invented lastEnd')
}
await idleEngine.close()
```

Add interrupt this-session (same parked fixture pattern, new store/session ids `sess_eval_cancel_abort_interrupt` / `parked_interrupt`) `abort('interrupt')` + `whenTreeStop()` → pending length 0.

Add parent interrupt + child leftover-ask (copy the shape of `parent interrupt leaves a child leftover-ask`: live parent hang stream, upsert child pending, `abort('interrupt')`, child pending length 1).

In `runParentTreeStop` parked beat, flip:

```ts
parkedEngine.abort('cancel')
const parkedTree = await parkedEngine.whenTreeStop()
if (parkedTree.descendantWork) {
  throw new Error('parent-tree-stop: idle this-session cancel reported descendant work')
}
if (!parkedTree.thisSessionWork) {
  throw new Error('parent-tree-stop: idle this-session cancel reported no thisSessionWork')
}
if ((await parkedStore.listPendingAsks(parked.id)).length !== 0) {
  throw new Error('parent-tree-stop: idle this-session parked ask was not dropped')
}
```

Copy helpers locally; do not import from `session-engine.test.ts`. Unknown directory names still throw.

- [ ] **Step 2: Run eval tests**

```bash
bun test ./packages/core/src/eval/run.test.ts
```

Expected: PASS against Task 1–2 code. Would FAIL if idle cancel left the row or if parent interrupt dropped the child row.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/eval/run.ts
git commit -m "$(cat <<'EOF'
test: lock leftover-ask abort-pair idle and interrupt in eval

Idle this-session parked now drops. Interrupt this-session
drops. Parent interrupt still leaves a child leftover-ask.
EOF
)"
```

---

### Task 6: L0/L4.2 shipped wording (after code)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-20-leftover-ask-abort-pair.md` (Status → implemented; board L0.1–L4.1 **done**; shipped sha)
- Modify: `ARCHITECTURE.md`, `ARCHITECTURE.ko.md` (cancel bullets ~180 and `abort(kind?)` ~280)
- Modify: `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md` (`/stop` ~328)
- Modify: `docs/headless.md` (POST cancel ~87)
- Modify: `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md` (horizon pointer)
- Modify: `docs/superpowers/specs/2026-09-18-parent-tree-stop.md`, `docs/superpowers/specs/2026-09-18-cancel-reset-followup.md`, `docs/superpowers/specs/2026-09-18-stream-version-token.md` (one-line OUT amendment)
- Modify: `CHANGELOG.md` Unreleased
- Modify: `docs/research/eve-analysis.md`, `eve-analysis.ko.md`, `y0-analysis.md`, `y0-analysis.ko.md` closers

- [ ] **Step 1: Point docs at the shipped behavior**

Idle `/stop` abort-pairs this session’s parked asks. Interrupt abort-pairs this session only. Live `POST …/cancel` is **202** `{ ok: true }` without join. Idle + work is **200** after join. Idle + nothing and stale live `turnId` stay **200** `no_active_turn`. Historical OUT lines stay; add “amended by `2026-09-20-leftover-ask-abort-pair.md`”. Do not claim a web UI. Do not reopen schema v11, async `createSessionEngine`, or `POST /clear`.

- [ ] **Step 2: Commit**

```bash
git add ARCHITECTURE.md ARCHITECTURE.ko.md \
  SLASH_COMMANDS.md SLASH_COMMANDS.ko.md \
  docs/headless.md CHANGELOG.md \
  docs/superpowers/specs/2026-09-20-leftover-ask-abort-pair.md \
  docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md \
  docs/superpowers/specs/2026-09-18-parent-tree-stop.md \
  docs/superpowers/specs/2026-09-18-cancel-reset-followup.md \
  docs/superpowers/specs/2026-09-18-stream-version-token.md \
  docs/research/eve-analysis.md docs/research/eve-analysis.ko.md \
  docs/research/y0-analysis.md docs/research/y0-analysis.ko.md
git commit -m "$(cat <<'EOF'
docs: mark leftover-ask abort-pair waves implemented

Idle cancel and interrupt I2 this session. Live serve cancel
is 202. Parallel doors stay OUT.
EOF
)"
```

---

## Success checks

1. Idle `abort('cancel')` abort-pairs this session’s leftover-ask with exactly one `ABORTED_TEXT` (or drop-only if already paired) and invents no `lastEnd`.
2. Live cancel still I2s this session in the cancelled epilogue and does not write a second `ABORTED_TEXT`.
3. `abort('interrupt')` abort-pairs this session’s leftover-asks; parent interrupt leaves a child leftover-ask; aborted stream does not emit `cancelled, ask still pending`.
4. Live serve cancel is **202** `{ ok: true }` without joining `whenTreeStop`; idle + work is **200** `{ ok: true }` after join; idle + nothing and stale live `turnId` stay **200** `no_active_turn`.
5. `probeIdleCancel` treats this-session leftover-asks as work; TUI idle `/stop` with `thisSessionWork` prints `stopped`.
6. Eval `cancel-abort-pair` fails the runner if 1 or 3 regress; parent-tree-stop parked beat agrees that idle this-session parked drops.

---

## Self-review

**Spec coverage:** L1 → Task 1. L2 → Task 2. L3.1–L3.3 → Task 3. L3.4 → Task 4. L4.1 → Task 5. L0/L4.2 → Task 6. Live cancel no leftover flight, persist-on-join, aborted no status line, no `lastEnd` on idle, no `POST /clear`, sync factory, I2 law, parent-interrupt-child kept.

**Placeholder scan:** none. Targeted bun commands start with `./`. Commits are HEREDOC.

**Type consistency:** `whenTreeStop(): Promise<{ descendantWork: boolean; thisSessionWork: boolean }>` in types, engine, serve, followup, stubs, TUI, eval.
