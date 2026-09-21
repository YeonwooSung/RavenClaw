# Dismiss-on-message — Implementation Plan

I'm using the writing-plans skill to create the implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unpark dismiss-on-message: an idle `submitMessage` with unpaired owned leftover-asks persist-then-drops each as `IGNORED_TEXT`, then continues as a normal submit. No fourth host entry. Quiet success.

**Architecture:** The pending-guard inside `submitMessage` (after `whenTreeStop` / rewind recovery, before `UserPromptSubmit`) becomes dismiss-then-continue when `liveTurn === null`. Each unpaired owned row (this session **and descendants**) goes through `applyAskAnswer(callId, 'ignored')` so concurrent resolve stays one-winner. Persist-fail is all-or-nothing before the user row. `liveTurn !== null` keeps today’s `{ type: 'status', message: 'pending permission ask' }` block. `applyAskAnswer` remains the only non-`submitMessage` closer.

**Tech Stack:** Bun, TypeScript, existing `SessionStore`, `createSessionEngine`, `IGNORED_TEXT`, `applyAskAnswer` flight map.

**Spec:** `docs/superpowers/specs/2026-09-21-dismiss-on-message.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. **`applyAskAnswer` remains the only non-`submitMessage` closer for operator answers.** Dismiss-on-message runs **inside** `submitMessage`. A fourth host entry is forbidden.
- Pairing 1:1. Never a second tool row for the same `callId`. Persist-before-drop stays.
- `dontAsk` leftover stays deny at decision time. No parked dontAsk ask to auto-ignore.
- Abort-pair I2 stays `ABORTED_TEXT`. Dismiss-on-message is ignored, not aborted. Esc / `abort('cancel'|'interrupt')` stay aborted.
- Default prefix unchanged. No new tool. No schema bump (v11). Do not add `pending_asks.answer`.
- BYOK. Clean-room. **No web UI, Prisma Task, Socket.IO, wiki, Slack/Discord/ACP skip UI, timeout→ignored, WorkspaceFs docker, NotebookEdit docker, Grep/Glob edits, live-turn dismiss, clear/rewind auto-ignore.**
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push.
- Do not rewrite `ABORTED_TEXT` into ignored or vice versa.

## Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification only.

1. **Trigger lives inside `submitMessage`.** No fourth host entry. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers (Ink `i`, HTTP `{ callId, answer: 'ignored' }`, crash-resolve).

2. **After `whenTreeStop` / rewind recovery, before `UserPromptSubmit` / appending the user row.** Today (`packages/core/src/loop/session-engine.ts` 804–816) unpaired owned rows set `askBlocked` and return. Replace that block-and-return with dismiss-then-continue **when `liveTurn === null`**. If `liveTurn !== null`, KEEP today’s block (`pending permission ask`) and do not ignore rows. Do not add a steer. Do not call `abort('cancel')` to dismiss.

3. **Dismiss the rows that today set `askBlocked`:** `listOwnedPendingAsks()` (`packages/core/src/session/followup.ts:32`) = this session AND descendants, unpaired only. A parent new message ignores a child leftover-ask (`row.sessionId` = child). Do not leave a child row that would re-block.

4. **Reuse parked `'ignored'`.** For each unpaired owned row, call `applyAskAnswer(callId, 'ignored')` (same one-winner flight map at `session-engine.ts:569`). `IGNORED_TEXT` is already: `ignored: the operator skipped this ask. The tool was not executed.` No execute. No `allow_always`. No `queryLoop` per row. Do not rewrite `ABORTED_TEXT` into ignored or vice versa.

5. **All-or-nothing before the user row.** Walk sequentially. If any persist fails, STOP. Do not append the user message. Do not start `queryLoop`. Leave remaining unpaired rows. Yield `{ type: 'status', message: 'pending permission ask' }` (same string — do not invent a second blocked notice). Partial ignored pairs that already landed stay landed. Operator retries submit.

6. **Quiet is required.** After every owned unpaired row is paired or gone, fall through to today’s `UserPromptSubmit` → persist user row → `queryLoop`. Do **not** yield `pending permission ask` on the success path. Do **not** emit the spec’s optional `ignored N pending ask(s)` (HTTP/TUI clients that key on `pending permission ask` must not misfire). Model sees ignored tool rows THEN the new user text.

7. **Empty / whitespace-only text.** If today’s `submitMessage` already accepts that input (`userSubmitToBlocks` at 1275–1287 pushes `{ type: 'text', text: '' }` when empty), dismiss-then-continue still runs. Do not change empty-text law.

8. **`applyAskAnswer(..., 'ignored')` still does not start a turn.** Ink `i` still one-ask. `clearKeepId` / `rewindLast` / HTTP `POST …/clear` still refuse `{ ok: false, notice: 'pending permission ask' }` while unpaired rows exist — they do NOT auto-ignore. Esc/I2 still `ABORTED_TEXT`. Concurrent `applyAskAnswer('allow')` vs dismiss: first persist wins (`applyFlights`). HTTP `{ callId, allow: false }` still deny.

9. **`dontAsk` leftover stays deny** at decision time. No parked dontAsk ask to auto-ignore.

10. **Follow-up.** After a successful dismiss-and-continue submit that writes `lastEnd`, `runFollowupAfterSubmit` may run (owned leftover-asks are gone). Do not special-case skip. Do not edit `followup.ts`.

11. **ACP replay unchanged.** If the operator already answered via replay, `submitMessage` sees no unpaired rows and does not double-ignore. If replay times out and leaves rows, `submitMessage` of new prompt text now dismisses them. Do not change ACP timeout → `AskWaiterExpired` leave-row.

12. **Slack/Discord/ACP skip UI still out.** A Slack follow-up **message** that goes through `submitMessage` will dismiss as a side effect (new user text). Button payloads stay allow/deny. Do not touch adapter button sets.

13. **Approvals do not dismiss-on-message.** `applyAskAnswer('allow')` executes that one tool and does not ignore siblings. Sibling parked rows remain until ignored, denied, allowed, or a later `submitMessage`.

14. **No schema bump (v11).** Do not touch `pending-asks.ts` enum (already has `'ignored'`). Do not touch Slack/Discord/ACP adapter button sets. Do not touch WorkspaceFs / NotebookEdit / Grep/Glob.

15. **Eval fixture `dismiss-on-message`** is a sibling of `ignored-dismiss`. Seed a leftover-ask, `submitMessage` new text, assert `IGNORED_TEXT` then the user row, tool not executed, no `permission_denied`, no `ABORTED_TEXT`. Do not change `ignored-dismiss` or `pending-ask-persist`. Copy helpers locally in `eval/run.ts` (use the file’s existing helpers; do not import from test files). Unknown directory names still throw. Add `EvalExpect` key `dismissOnMessage?: boolean`. Dispatch next to `ignored-dismiss` (~line 76).

16. **Docs honesty** in Task 4 after code: `ARCHITECTURE.md` / `.ko.md`, `docs/headless.md`, pointer from ignored-dismiss ruling 8 / eve-inspired “dismiss-on-message stays parked”. Do not rewrite 2026-09-15 except a pointer. CHANGELOG Unreleased. Spec Status → implemented ONLY in the docs task. Pointer lines in `docs/superpowers/specs/2026-09-21-ignored-dismiss.md` and eve-analysis en/ko.

17. **Ignored persist-fail unclaims.** `applyAskAnswerOnce` ignored persist currently has no try/catch (`session-engine.ts:466–470`): if `persistSettledTool` throws, `dropPendingAsk` is not reached and `claimedAsks` still holds the `callId`. A later `applyAskAnswer` / dismiss retry would hit `!claimAsk` and return `'matched'` without persisting — bricking the spec’s “operator retries submit” on the same engine. Wrap ignored persist: on throw, `claimedAsks.delete(callId)` then rethrow. Do not unclaim after a successful persist. Do not change deny / I2 persist-fail law. Existing `applyAskAnswer ignored persist-fail leaves the row` stays green.

18. **After each dismiss `applyAskAnswer(callId, 'ignored')`:** if it throws, or returns `'matched'` but `!(await isCallPaired(callId, row.sessionId))`, treat as persist-fail (yield `pending permission ask`, return `{ reason: 'completed' }`, no user row). If it returns `'unmatched'` (row gone), continue to the next row.

19. **The one existing ignored test this door flips:** `applyAskAnswer ignored of one parked ask still blocks submitMessage on the other` in `query-loop.test.ts:1109`. That locked the previous guard. Task 1 retargets ONLY that case’s submitMessage half: ignoring one parked ask still leaves the sibling pending and does not execute; `submitMessage` then dismisses the sibling. Do not retarget parked persist, grandchild ignored, live ignored, persist-fail-on-ignored, unknown unmatched, abort-pair, rewind refuse, or clear refuse.

20. **Worktree.** Implement in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/dismiss-on-message` or a later isolated worktree. Never on `main`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/loop/session-engine.ts` | dismiss-then-continue in `submitMessage` 804–816; ignored persist unclaim |
| `packages/core/src/loop/session-engine.test.ts` | D0.1 / D0.2 / D1 tests (`describe('dismiss-on-message')`) |
| `packages/core/src/loop/query-loop.test.ts` | retarget the one inverted lock (Task 1 only) |
| `packages/core/src/eval/run.ts` + `fixtures/dismiss-on-message/` | eval lock |
| docs listed in Task 4 | honesty after code |

Leave Slack/Discord/ACP adapters, `pending-asks.ts`, WorkspaceFs, NotebookEdit, Grep/Glob, `followup.ts`, ACP timeout, rewind/clear refuse paths untouched except the dismiss loop in `submitMessage`.

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 D0.1 success path | `session-engine.ts` (submitMessage guard), `session-engine.test.ts` (success + two-row + quiet + empty), `query-loop.test.ts` (one retarget) |
| 2 D0.2 persist-fail all-or-nothing | `session-engine.ts` (unclaim + still-unpaired stop), `session-engine.test.ts` (second-of-two fail + retry) |
| 3 D1 descendants + pins | `session-engine.test.ts` (child leftover, liveTurn block, applyAskAnswer no-turn, clear/rewind refuse, I2 ABORTED_TEXT, concurrent allow vs dismiss, allow does not ignore siblings) |
| 4 D2 eval + docs | `eval/run.ts`, `eval/fixtures/dismiss-on-message/case.json`, docs listed; spec Status implemented after code |

Task 1 first. Task 2 after 1 (same dismiss loop). Task 3 after 1. Task 4 last.

---

### Task 1: D0.1 success path — dismiss-then-continue

**Files:**
- Modify: `packages/core/src/loop/session-engine.ts` (`submitMessage` pending-guard 804–816)
- Modify: `packages/core/src/loop/session-engine.test.ts` (add `textThenStop` next to `toolThenStop` ~128; add `describe('dismiss-on-message')` after the last describe ~3246)
- Modify: `packages/core/src/loop/query-loop.test.ts` (retarget `applyAskAnswer ignored of one parked ask still blocks submitMessage on the other` ~1109)

**Interfaces:**
- Consumes: `listOwnedPendingAsks()`, `isCallPaired`, `dropPendingAsk`, `applyAskAnswer(callId, 'ignored')`, `liveTurn`, `IGNORED_TEXT`
- Produces:
  ```ts
  // inside submitMessage, after whenTreeStop, before UserPromptSubmit:
  // unpaired owned rows + liveTurn === null → applyAskAnswer(callId, 'ignored') each, then fall through
  // unpaired owned rows + liveTurn !== null → yield { type: 'status', message: 'pending permission ask' }; return { reason: 'completed' }
  ```
  No new `SessionEngine` method. No new status string on the success path.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/loop/session-engine.test.ts`, next to `toolThenStop` (~128), add:

```ts
function textThenStop(text: string): ProviderChunk[] {
  return [
    { type: 'text_delta', text },
    { type: 'stop', reason: 'end' },
  ]
}
```

At the end of the file (after `describe('clearKeepId')`), add:

```ts
describe('dismiss-on-message', () => {
  async function drain(gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>) {
    const events: StreamEvent[] = []
    while (true) {
      const next = await gen.next()
      if (next.done) return { events, result: next.value }
      events.push(next.value)
    }
  }

  test('parked leftover-ask plus submitMessage go on dismisses then continues', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_dismiss_one' })
    await store.createSession(session)
    await store.persistToolCalls(session.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'hi' } }],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_1',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 1,
    })
    const echo = createAskEcho()
    const provider = createFakeProvider([textThenStop('done')])
    const engine = await createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [echo],
      }),
    )
    const { events, result } = await drain(engine.submitMessage('go on'))
    expect(result).toEqual({ reason: 'completed' })
    expect(events.some((e) => e.type === 'status' && e.message === 'pending permission ask')).toBe(
      false,
    )
    expect(
      events.some((e) => e.type === 'status' && /ignored \d+ pending ask/.test(e.message)),
    ).toBe(false)
    expect(echo.executeCount).toBe(0)
    expect(provider.streamCount).toBe(1)
    expect(await store.listPendingAsks(session.id)).toHaveLength(0)
    const loaded = await store.loadSession(session.id)
    const tools = loaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'call_1')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.ok).toBe(false)
    expect(tools[0] && tools[0].role === 'tool' ? tools[0].blocks[0]?.text : '').toBe(IGNORED_TEXT)
    expect(
      loaded.messages.some(
        (m) =>
          m.role === 'tool' &&
          m.blocks.some((b) => b.type === 'text' && b.text.includes('permission_denied')),
      ),
    ).toBe(false)
    expect(
      loaded.messages.some(
        (m) =>
          m.role === 'tool' &&
          m.blocks.some((b) => b.type === 'text' && b.text === ABORTED_TEXT),
      ),
    ).toBe(false)
    const users = loaded.messages.filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0] && users[0].role === 'user' ? users[0].blocks[0]?.text : '').toBe('go on')
    const roles = loaded.messages.map((m) => m.role)
    expect(roles.indexOf('tool')).toBeGreaterThanOrEqual(0)
    expect(roles.indexOf('user')).toBeGreaterThan(roles.indexOf('tool'))
  })

  test('two parked leftover-asks are both ignored then one user row', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_dismiss_two' })
    await store.createSession(session)
    await store.persistToolCalls(session.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [
        { type: 'tool_use', id: 'call_a', name: 'Echo', input: { text: 'a' } },
        { type: 'tool_use', id: 'call_b', name: 'Echo', input: { text: 'b' } },
      ],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_a',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo a?',
      input: { text: 'a' },
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_b',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo b?',
      input: { text: 'b' },
      createdAt: 2,
    })
    const echo = createAskEcho()
    const provider = createFakeProvider([textThenStop('done')])
    const engine = await createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [echo],
      }),
    )
    const { events, result } = await drain(engine.submitMessage('go on'))
    expect(result).toEqual({ reason: 'completed' })
    expect(events.some((e) => e.type === 'status' && e.message === 'pending permission ask')).toBe(
      false,
    )
    expect(echo.executeCount).toBe(0)
    expect(provider.streamCount).toBe(1)
    expect(await store.listPendingAsks(session.id)).toHaveLength(0)
    const loaded = await store.loadSession(session.id)
    const tools = loaded.messages.filter(
      (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
    )
    expect(tools.map((row) => row.toolUseId).sort()).toEqual(['call_a', 'call_b'])
    expect(tools.map((row) => row.blocks[0]?.text)).toEqual([IGNORED_TEXT, IGNORED_TEXT])
    const users = loaded.messages.filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0] && users[0].role === 'user' ? users[0].blocks[0]?.text : '').toBe('go on')
    const lastTool = loaded.messages.findLastIndex((m) => m.role === 'tool')
    const userIdx = loaded.messages.findIndex((m) => m.role === 'user')
    expect(userIdx).toBeGreaterThan(lastTool)
  })

  test('empty submitMessage still dismisses then continues', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_dismiss_empty' })
    await store.createSession(session)
    await store.persistToolCalls(session.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'hi' } }],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_1',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 1,
    })
    const echo = createAskEcho()
    const provider = createFakeProvider([textThenStop('done')])
    const engine = await createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [echo],
      }),
    )
    const { events, result } = await drain(engine.submitMessage(''))
    expect(result).toEqual({ reason: 'completed' })
    expect(events.some((e) => e.type === 'status' && e.message === 'pending permission ask')).toBe(
      false,
    )
    expect(echo.executeCount).toBe(0)
    expect(provider.streamCount).toBe(1)
    expect(await store.listPendingAsks(session.id)).toHaveLength(0)
    const loaded = await store.loadSession(session.id)
    const toolRow = loaded.messages.find((m) => m.role === 'tool' && m.toolUseId === 'call_1')
    expect(toolRow && toolRow.role === 'tool' ? toolRow.blocks[0]?.text : '').toBe(IGNORED_TEXT)
    expect(loaded.messages.some((m) => m.role === 'user')).toBe(true)
  })
})
```

`IGNORED_TEXT` and `ABORTED_TEXT` are already imported from `./pairing`. `createMemoryStore`, `makeSession`, `createAskEcho`, `createFakeProvider`, `engineOpts`, `toolThenStop` already exist at file scope.

In `packages/core/src/loop/query-loop.test.ts`, replace `applyAskAnswer ignored of one parked ask still blocks submitMessage on the other` so the submitMessage half is dismiss-and-continue (keep the applyAskAnswer sibling-stays-parked half):

```ts
test('applyAskAnswer ignored of one parked ask leaves the other until submitMessage dismisses it', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_ignored_other_parked' })
  await store.createSession(session)
  await store.persistToolCalls(session.id, {
    id: 'a1',
    role: 'assistant',
    blocks: [
      { type: 'tool_use', id: 'call_a', name: 'Echo', input: { text: 'a' } },
      { type: 'tool_use', id: 'call_b', name: 'Echo', input: { text: 'b' } },
    ],
    createdAt: 1,
  })
  await store.upsertPendingAsk({
    callId: 'call_a',
    sessionId: session.id,
    kind: 'leftover',
    tool: 'Echo',
    message: 'Echo a?',
    input: { text: 'a' },
    createdAt: 1,
  })
  await store.upsertPendingAsk({
    callId: 'call_b',
    sessionId: session.id,
    kind: 'leftover',
    tool: 'Echo',
    message: 'Echo b?',
    input: { text: 'b' },
    createdAt: 2,
  })
  const echo = createAskEcho()
  const engine = await createSessionEngine(
    engineOpts({
      provider: createFakeProvider([textThenStop('nope')]),
      store,
      session,
      tools: [echo],
    }),
  )
  expect(await engine.applyAskAnswer('call_a', 'ignored')).toBe('matched')
  expect(await store.listPendingAsks(session.id)).toHaveLength(1)
  expect(echo.executeCount).toBe(0)
  const { events, result } = await collect(engine.submitMessage('hello anyway'))
  expect(result).toEqual({ reason: 'completed' })
  expect(events.some((e) => e.type === 'status' && e.message === 'pending permission ask')).toBe(
    false,
  )
  expect(echo.executeCount).toBe(0)
  const loaded = await store.loadSession(session.id)
  expect(
    loaded.messages.some(
      (m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && b.text === 'hello anyway'),
    ),
  ).toBe(true)
  const tools = loaded.messages.filter(
    (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
  )
  expect(tools).toHaveLength(2)
  expect(tools.map((row) => row.blocks[0]?.text)).toEqual([IGNORED_TEXT, IGNORED_TEXT])
  expect(await store.listPendingAsks(session.id)).toHaveLength(0)
})
```

Keep `applyAskAnswer ignored persists IGNORED_TEXT and does not execute`, persist-fail-on-ignored, grandchild ignored, and live ignored unchanged.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/loop/query-loop.test.ts
```

Expected: FAIL — parked leftover-ask + `submitMessage('go on')` still yields `pending permission ask`, no user row, `streamCount === 0`. The retargeted query-loop case still sees the block.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/loop/session-engine.ts` `submitMessage`, replace the pending-guard at 804–816. Keep `await maybeFinishRewindReset` and `await whenTreeStop()` immediately above. Do not move `UserPromptSubmit`. `applyAskAnswer` is already in this closure.

```ts
      const pending = await listOwnedPendingAsks()
      const unpaired: PendingAsk[] = []
      for (const row of pending) {
        if (await isCallPaired(row.callId, row.sessionId)) {
          await dropPendingAsk(row.callId)
          continue
        }
        unpaired.push(row)
      }
      if (unpaired.length > 0) {
        if (liveTurn !== null) {
          yield { type: 'status', message: 'pending permission ask' }
          return { reason: 'completed' as const }
        }
        for (const row of unpaired) {
          let status: 'matched' | 'unmatched'
          try {
            status = await applyAskAnswer(row.callId, 'ignored')
          } catch {
            yield { type: 'status', message: 'pending permission ask' }
            return { reason: 'completed' as const }
          }
          if (status === 'unmatched') continue
          if (!(await isCallPaired(row.callId, row.sessionId))) {
            yield { type: 'status', message: 'pending permission ask' }
            return { reason: 'completed' as const }
          }
        }
      }
```

Do not yield any extra status on the success path. Do not `enqueueSteer`. Do not `abort('cancel')`. Do not add a `SessionEngine` method. Do not edit `applyAskAnswerOnce` yet (unclaim is Task 2). Paired-stale-row drop stays.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/loop/query-loop.test.ts
```

Expected: PASS. Parked leftover-ask + `submitMessage('go on')` writes `IGNORED_TEXT` then the user row and runs `queryLoop`. Two parked rows both ignored. Quiet success. Empty text still dismisses. `applyAskAnswer ignored` of one parked ask still does not execute; submitMessage now dismisses the sibling. Live cancel abort-pair, persist-fail on cancel, grandchild ignored, live ignored stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop/session-engine.ts \
  packages/core/src/loop/session-engine.test.ts \
  packages/core/src/loop/query-loop.test.ts
git commit -m "$(cat <<'EOF'
feat: dismiss parked leftover-asks on a new submitMessage

Idle submitMessage persist-then-drops owned unpaired asks as
ignored, then continues. Live turns still block.
EOF
)"
```

---

### Task 2: D0.2 persist-fail all-or-nothing

**Files:**
- Modify: `packages/core/src/loop/session-engine.ts` (`applyAskAnswerOnce` ignored branch ~466–470)
- Modify: `packages/core/src/loop/session-engine.test.ts` (`describe('dismiss-on-message')`)

**Interfaces:**
- Consumes: Task 1 dismiss loop, `persistSettledTool`, `claimedAsks`, `IGNORED_TEXT`
- Produces: ignored persist throw unclaims then rethrows; dismiss loop already stops on throw / still-unpaired (Task 1); operator retry on the same engine can persist remaining rows

- [ ] **Step 1: Write the failing tests**

In `describe('dismiss-on-message')` in `packages/core/src/loop/session-engine.test.ts`, add (repeat the local `drain` already in that describe — do not invent a second helper; the tests below sit next to Task 1 cases and use the same `drain`):

```ts
  test('persist-fail on the second parked ask stops before the user row', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_dismiss_persist_fail' })
    await store.createSession(session)
    await store.persistToolCalls(session.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [
        { type: 'tool_use', id: 'call_a', name: 'Echo', input: { text: 'a' } },
        { type: 'tool_use', id: 'call_b', name: 'Echo', input: { text: 'b' } },
      ],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_a',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo a?',
      input: { text: 'a' },
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_b',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo b?',
      input: { text: 'b' },
      createdAt: 2,
    })
    const echo = createAskEcho()
    const provider = createFakeProvider([textThenStop('done')])
    let persistCount = 0
    const origPersist = store.persistToolResults.bind(store)
    store.persistToolResults = async (sessionId, rows) => {
      persistCount += 1
      if (persistCount >= 2) throw new Error('disk')
      return origPersist(sessionId, rows)
    }
    const engine = await createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [echo],
      }),
    )
    const { events, result } = await drain(engine.submitMessage('go on'))
    expect(result).toEqual({ reason: 'completed' })
    expect(events.some((e) => e.type === 'status' && e.message === 'pending permission ask')).toBe(
      true,
    )
    expect(echo.executeCount).toBe(0)
    expect(provider.streamCount).toBe(0)
    expect(await store.listPendingAsks(session.id)).toHaveLength(1)
    expect((await store.listPendingAsks(session.id))[0]?.callId).toBe('call_b')
    const loaded = await store.loadSession(session.id)
    expect(loaded.messages.filter((m) => m.role === 'user')).toHaveLength(0)
    const tools = loaded.messages.filter(
      (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
    )
    expect(tools).toHaveLength(1)
    expect(tools[0]?.toolUseId).toBe('call_a')
    expect(tools[0]?.blocks[0]?.text).toBe(IGNORED_TEXT)

    store.persistToolResults = origPersist
    const retry = await drain(engine.submitMessage('go on'))
    expect(retry.result).toEqual({ reason: 'completed' })
    expect(
      retry.events.some((e) => e.type === 'status' && e.message === 'pending permission ask'),
    ).toBe(false)
    expect(echo.executeCount).toBe(0)
    expect(provider.streamCount).toBe(1)
    expect(await store.listPendingAsks(session.id)).toHaveLength(0)
    const after = await store.loadSession(session.id)
    const afterTools = after.messages.filter(
      (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
    )
    expect(afterTools.map((row) => row.toolUseId).sort()).toEqual(['call_a', 'call_b'])
    expect(afterTools.map((row) => row.blocks[0]?.text)).toEqual([IGNORED_TEXT, IGNORED_TEXT])
    expect(
      after.messages.some(
        (m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && b.text === 'go on'),
      ),
    ).toBe(true)
  })
```

Keep `applyAskAnswer ignored persist-fail leaves the row` in `query-loop.test.ts` unchanged.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/loop/session-engine.test.ts
```

Expected: FAIL — first submit may already stop (Task 1 catch), but retry still sees `call_b` unpaired because `claimedAsks` still holds `call_b` after the thrown persist, so `applyAskAnswer('ignored')` returns `'matched'` without persisting and the still-unpaired check (Task 1) yields `pending permission ask` again. `streamCount` stays 0 on retry.

- [ ] **Step 3: Write minimal implementation**

In `applyAskAnswerOnce`, replace the ignored branch (~466–470) with:

```ts
    if (answer === 'ignored') {
      try {
        await persistSettledTool(makeToolMessage(callId, false, IGNORED_TEXT), target.sessionId)
      } catch (error) {
        claimedAsks.delete(callId)
        throw error
      }
      await dropPendingAsk(callId)
      return 'matched'
    }
```

Do not wrap deny or execute persist. Do not `claimedAsks.delete` after a successful persist. The Task 1 dismiss loop already stops on throw and on still-unpaired `'matched'`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/loop/query-loop.test.ts
```

Expected: PASS. Second-of-two persist-fail: first `IGNORED_TEXT` paired, `call_b` remains, no user row, status `pending permission ask`. Retry after restoring persist: both ignored, user row, `queryLoop` ran. `applyAskAnswer ignored persist-fail leaves the row` still throws and leaves the row. Cancel persist-fail still leaves the row.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop/session-engine.ts \
  packages/core/src/loop/session-engine.test.ts
git commit -m "$(cat <<'EOF'
fix: stop dismiss-on-message before the user row on persist fail

Ignored persist throw unclaims so a retry can pair remaining
asks. Partial ignored pairs stay.
EOF
)"
```

---

### Task 3: D1 descendants + live / applyAskAnswer / clear / rewind / abort pins

**Files:**
- Modify: `packages/core/src/loop/session-engine.test.ts` (`describe('dismiss-on-message')`)

**Interfaces:**
- Consumes: Task 1 dismiss loop, `listOwnedPendingAsks` descendants, `liveTurn`, `clearKeepId`, `rewindLast`, `abort`, `applyAskAnswer`, `consumeUntilAsk`, `hangAskUser`, `IGNORED_TEXT`, `ABORTED_TEXT`
- Produces: no production code unless a pin fails (the `liveTurn !== null` branch already landed in Task 1)

Repeat the `drain` already in `describe('dismiss-on-message')`. `consumeUntilAsk` and `hangAskUser` already exist at file scope (`session-engine.test.ts:135` / `:145`). `toolThenStop` already exists.

- [ ] **Step 1: Write the failing tests**

Add to `describe('dismiss-on-message')`:

```ts
  test('parent submitMessage ignores a child leftover-ask then continues', async () => {
    const store = createMemoryStore()
    const parent = makeSession({ id: 'sess_dismiss_parent' })
    const child = makeSession({ id: 'sess_dismiss_child', parentSessionId: parent.id })
    await store.createSession(parent)
    await store.createSession(child)
    await store.persistToolCalls(child.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'call_child', name: 'Echo', input: { text: 'hi' } }],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_child',
      sessionId: child.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 1,
    })
    const echo = createAskEcho()
    const provider = createFakeProvider([textThenStop('done')])
    const engine = await createSessionEngine(
      engineOpts({
        provider,
        store,
        session: parent,
        tools: [echo],
      }),
    )
    const { events, result } = await drain(engine.submitMessage('go on'))
    expect(result).toEqual({ reason: 'completed' })
    expect(events.some((e) => e.type === 'status' && e.message === 'pending permission ask')).toBe(
      false,
    )
    expect(echo.executeCount).toBe(0)
    expect(provider.streamCount).toBe(1)
    expect(await store.listPendingAsks(child.id)).toHaveLength(0)
    expect(await store.listPendingAsks(parent.id)).toHaveLength(0)
    const childLoaded = await store.loadSession(child.id)
    const childTools = childLoaded.messages.filter(
      (m) => m.role === 'tool' && m.toolUseId === 'call_child',
    )
    expect(childTools).toHaveLength(1)
    expect(childTools[0] && childTools[0].role === 'tool' ? childTools[0].blocks[0]?.text : '').toBe(
      IGNORED_TEXT,
    )
    const parentLoaded = await store.loadSession(parent.id)
    expect(parentLoaded.messages.some((m) => m.role === 'tool')).toBe(false)
    expect(
      parentLoaded.messages.some(
        (m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && b.text === 'go on'),
      ),
    ).toBe(true)
  })

  test('applyAskAnswer ignored still does not start a turn', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_dismiss_apply_no_turn' })
    await store.createSession(session)
    await store.persistToolCalls(session.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'hi' } }],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_1',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 1,
    })
    const echo = createAskEcho()
    const provider = createFakeProvider([textThenStop('nope')])
    const engine = await createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [echo],
      }),
    )
    expect(await engine.applyAskAnswer('call_1', 'ignored')).toBe('matched')
    expect(echo.executeCount).toBe(0)
    expect(provider.streamCount).toBe(0)
    expect(engine.liveTurnId()).toBeNull()
    expect(await store.listPendingAsks(session.id)).toHaveLength(0)
    const loaded = await store.loadSession(session.id)
    expect(loaded.messages.some((m) => m.role === 'user')).toBe(false)
    const toolRow = loaded.messages.find((m) => m.role === 'tool' && m.toolUseId === 'call_1')
    expect(toolRow && toolRow.role === 'tool' ? toolRow.blocks[0]?.text : '').toBe(IGNORED_TEXT)
  })

  test('liveTurn still blocks submitMessage and does not ignore the row', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_dismiss_live_block' })
    await store.createSession(session)
    const echo = createAskEcho()
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([toolThenStop('call_live', 'Echo', { text: 'hi' })]),
        store,
        session,
        tools: [echo],
      }),
      askUser: hangAskUser,
    })
    const gen = engine.submitMessage('hi')
    await consumeUntilAsk(gen)
    expect(engine.liveTurnId()).not.toBeNull()
    expect(await store.listPendingAsks(session.id)).toHaveLength(1)
    const second = await drain(engine.submitMessage('go on'))
    expect(second.result).toEqual({ reason: 'completed' })
    expect(
      second.events.some((e) => e.type === 'status' && e.message === 'pending permission ask'),
    ).toBe(true)
    expect(echo.executeCount).toBe(0)
    expect(await store.listPendingAsks(session.id)).toHaveLength(1)
    const mid = await store.loadSession(session.id)
    expect(
      mid.messages.some(
        (m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && b.text === 'go on'),
      ),
    ).toBe(false)
    engine.abort('cancel')
    await drain(gen)
  })

  test('clearKeepId and rewindLast still refuse unpaired leftover-asks', async () => {
    const store = createMemoryStore()
    const parent = makeSession({ id: 'sess_dismiss_refuse_parent' })
    const child = makeSession({ id: 'sess_dismiss_refuse_child', parentSessionId: parent.id })
    await store.createSession(parent)
    await store.createSession(child)
    await store.persistToolCalls(parent.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'call_parent', name: 'Echo', input: { text: 'hi' } }],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_parent',
      sessionId: parent.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_child',
      sessionId: child.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 1,
    })
    const engine = await createSessionEngine(
      engineOpts({
        provider: createFakeProvider([]),
        store,
        session: parent,
        tools: [createAskEcho()],
      }),
    )
    expect(await engine.rewindLast()).toEqual({ ok: false, notice: 'pending permission ask' })
    expect(await engine.clearKeepId()).toEqual({ ok: false, notice: 'pending permission ask' })
    expect(await store.listPendingAsks(parent.id)).toHaveLength(1)
    expect(await store.listPendingAsks(child.id)).toHaveLength(1)
    expect(engine.liveTurnId()).toBeNull()
  })

  test('abort still abort-pairs ABORTED_TEXT and submitMessage does not rewrite it', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_dismiss_abort' })
    await store.createSession(session)
    await store.persistToolCalls(session.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'hi' } }],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_1',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 1,
    })
    const echo = createAskEcho()
    const provider = createFakeProvider([textThenStop('done')])
    const engine = await createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [echo],
      }),
    )
    engine.abort('cancel')
    await engine.whenTreeStop()
    expect(await store.listPendingAsks(session.id)).toHaveLength(0)
    const aborted = await store.loadSession(session.id)
    const abortedTools = aborted.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'call_1')
    expect(abortedTools).toHaveLength(1)
    expect(abortedTools[0] && abortedTools[0].role === 'tool' ? abortedTools[0].blocks[0]?.text : '').toBe(
      ABORTED_TEXT,
    )
    const { result } = await drain(engine.submitMessage('go on'))
    expect(result).toEqual({ reason: 'completed' })
    expect(echo.executeCount).toBe(0)
    const loaded = await store.loadSession(session.id)
    const tools = loaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'call_1')
    expect(tools).toHaveLength(1)
    expect(tools[0] && tools[0].role === 'tool' ? tools[0].blocks[0]?.text : '').toBe(ABORTED_TEXT)
    expect(
      loaded.messages.some(
        (m) =>
          m.role === 'tool' &&
          m.blocks.some((b) => b.type === 'text' && b.text === IGNORED_TEXT),
      ),
    ).toBe(false)
  })

  test('allow of one parked ask does not ignore the sibling; later submitMessage does', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_dismiss_allow_sibling' })
    await store.createSession(session)
    await store.persistToolCalls(session.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [
        { type: 'tool_use', id: 'call_a', name: 'Echo', input: { text: 'a' } },
        { type: 'tool_use', id: 'call_b', name: 'Echo', input: { text: 'b' } },
      ],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_a',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo a?',
      input: { text: 'a' },
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_b',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo b?',
      input: { text: 'b' },
      createdAt: 2,
    })
    const echo = createAskEcho()
    const provider = createFakeProvider([textThenStop('done')])
    const engine = await createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [echo],
      }),
    )
    expect(await engine.applyAskAnswer('call_a', 'allow')).toBe('matched')
    expect(echo.executeCount).toBe(1)
    expect(provider.streamCount).toBe(0)
    expect(await store.listPendingAsks(session.id)).toHaveLength(1)
    const { events, result } = await drain(engine.submitMessage('go on'))
    expect(result).toEqual({ reason: 'completed' })
    expect(events.some((e) => e.type === 'status' && e.message === 'pending permission ask')).toBe(
      false,
    )
    expect(echo.executeCount).toBe(1)
    expect(provider.streamCount).toBe(1)
    expect(await store.listPendingAsks(session.id)).toHaveLength(0)
    const loaded = await store.loadSession(session.id)
    const byId = Object.fromEntries(
      loaded.messages
        .filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool')
        .map((row) => [row.toolUseId, row.blocks[0]?.text]),
    )
    expect(byId.call_a).toBe('a')
    expect(byId.call_b).toBe(IGNORED_TEXT)
  })

  test('concurrent allow vs dismiss keeps one tool row', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_dismiss_race' })
    await store.createSession(session)
    await store.persistToolCalls(session.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'hi' } }],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_1',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 1,
    })
    const echo = createAskEcho()
    const provider = createFakeProvider([textThenStop('done')])
    const engine = await createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [echo],
      }),
    )
    const allow = engine.applyAskAnswer('call_1', 'allow')
    const submit = drain(engine.submitMessage('go on'))
    const [allowStatus, { result }] = await Promise.all([allow, submit])
    expect(allowStatus).toBe('matched')
    expect(result).toEqual({ reason: 'completed' })
    expect(await store.listPendingAsks(session.id)).toHaveLength(0)
    const loaded = await store.loadSession(session.id)
    const tools = loaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'call_1')
    expect(tools).toHaveLength(1)
    const text = tools[0] && tools[0].role === 'tool' ? tools[0].blocks[0]?.text : ''
    expect(text === 'hi' || text === IGNORED_TEXT).toBe(true)
    expect(echo.executeCount).toBe(text === 'hi' ? 1 : 0)
    expect(
      loaded.messages.some(
        (m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && b.text === 'go on'),
      ),
    ).toBe(true)
  })
```

Do not retarget `clearKeepId` `refuses unpaired child ask before abort` (~3131) or `rewind.test.ts` pending refuse (~716). Do not edit `followup.ts`, ACP, Slack/Discord adapters, or `pending-asks.ts`.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/loop/session-engine.test.ts
```

Expected: FAIL on child leftover (parent still blocked) until Task 1 descendant walk is in; FAIL on liveTurn if the Task 1 `liveTurn !== null` branch is missing. After Task 1, most of these should already pass — this task is the pin suite. If child leftover still blocks, the dismiss loop is not using `listOwnedPendingAsks` (descendants). If liveTurn dismisses the row, the `liveTurn !== null` branch is missing.

- [ ] **Step 3: Write minimal implementation**

Only if a pin fails. The dismiss loop from Task 1 already walks `listOwnedPendingAsks()` and keeps the liveTurn block. Do not add a steer. Do not auto-ignore from `clearKeepId` / `rewindLast`. Do not change I2 `persistBeforeDropAsk` (`ABORTED_TEXT`).

If parent submit still leaves the child row, the bug is that dismiss used `store.listPendingAsks(session.id)` instead of `listOwnedPendingAsks()`. Fix: walk the same `unpaired` list Task 1 already built from `listOwnedPendingAsks()`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/session/rewind.test.ts
```

Expected: PASS. Child leftover ignored on parent submit. `applyAskAnswer('ignored')` still `streamCount === 0`. `clearKeepId` / `rewindLast` still `pending permission ask`. Live turn still blocks. Abort stays `ABORTED_TEXT`. Allow does not ignore siblings. Concurrent allow vs dismiss: one tool row. Existing rewind refuse and clear-child-unpaired stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop/session-engine.test.ts
git commit -m "$(cat <<'EOF'
test: pin dismiss-on-message descendants and refuse paths

Parent submit ignores a child leftover-ask. Live turns, clear,
rewind, and abort keep their own laws.
EOF
)"
```

If Step 3 required a `session-engine.ts` fix, `git add` that file too and use:

```bash
git add packages/core/src/loop/session-engine.ts packages/core/src/loop/session-engine.test.ts
git commit -m "$(cat <<'EOF'
fix: dismiss owned descendant leftover-asks on parent submit

Walk listOwnedPendingAsks so a child leftover-ask cannot
re-block the parent. Pins keep live/clear/rewind/abort.
EOF
)"
```

---

### Task 4: D2 eval fixture `dismiss-on-message` + docs honesty

**Files:**
- Modify: `packages/core/src/eval/run.ts` (`EvalExpect`, dispatch next to `ignored-dismiss` ~76, new `runDismissOnMessage`)
- Create: `packages/core/src/eval/fixtures/dismiss-on-message/case.json`
- Modify: `docs/superpowers/specs/2026-09-21-dismiss-on-message.md` (Status → **implemented**; board D0.1–D2 **done**; do not fill Shipped sha)
- Modify: `docs/superpowers/specs/2026-09-21-ignored-dismiss.md` (ruling 8 pointer)
- Modify: `docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md` (one-line pointer only)
- Modify: `docs/superpowers/specs/2026-09-20-leftover-ask-abort-pair.md` (OUT line: dismiss-on-message amended)
- Modify: `docs/research/eve-analysis.md`, `eve-analysis.ko.md`
- Modify: `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`
- Modify: `docs/headless.md`
- Modify: `CHANGELOG.md` Unreleased Added (prepend)

**Interfaces:**
- Consumes: Task 1–3 dismiss loop, `IGNORED_TEXT`, `ABORTED_TEXT`, existing eval helpers in `run.ts` (`createMemoryStore`, `makeSession`, `createFakeProvider`, `createAskEcho`, `textThenStop`, `toolThenStop`, `drain`, `defaultCompact`, `defaultModel`)
- Produces: fixture directory `dismiss-on-message`; `EvalExpect.dismissOnMessage?: boolean`; unknown names still throw

- [ ] **Step 1: Write the failing eval (and docs after code)**

Create `packages/core/src/eval/fixtures/dismiss-on-message/case.json`:

```json
{
  "prompt": "go on",
  "expect": {
    "dismissOnMessage": true,
    "pairing": true
  }
}
```

In `packages/core/src/eval/run.ts`, add to `EvalExpect`:

```ts
  dismissOnMessage?: boolean
```

Immediately after the `ignored-dismiss` dispatch (~76):

```ts
    if (name === 'dismiss-on-message') {
      await runDismissOnMessage(spec)
      continue
    }
```

Add `runDismissOnMessage` next to `runIgnoredDismiss` (~364), copying helpers already in this file (do not import from test files):

```ts
async function runDismissOnMessage(spec: EvalCase): Promise<void> {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_eval_dismiss_on_message' })
  await store.createSession(session)
  await store.persistToolCalls(session.id, {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'call_eval', name: 'Echo', input: { text: 'hi' } }],
    createdAt: 1,
  })
  await store.upsertPendingAsk({
    callId: 'call_eval',
    sessionId: session.id,
    kind: 'leftover',
    tool: 'Echo',
    message: 'Echo?',
    input: { text: 'hi' },
    createdAt: 1,
  })

  let executeCount = 0
  const echo = createAskEcho()
  const origExecute = echo.execute.bind(echo)
  echo.execute = async (input, ctx) => {
    executeCount += 1
    return origExecute(input, ctx)
  }

  const engine = await createSessionEngine({
    session,
    provider: createFakeProvider([textThenStop('done')]),
    store,
    tools: [echo],
    compact: defaultCompact(),
    model: defaultModel(),
    maxRounds: 8,
    bare: true,
    askUser: async () => 'deny',
  })

  const { events } = await drainEvents(engine.submitMessage(spec.prompt))
  if (events.some((e) => e.type === 'status' && e.message === 'pending permission ask')) {
    throw new Error('dismiss-on-message: yielded pending permission ask')
  }
  if ((await store.listPendingAsks(session.id)).length !== 0) {
    throw new Error('dismiss-on-message: pending ask remained')
  }
  const loaded = await store.loadSession(session.id)
  const toolRow = loaded.messages.find((m) => m.role === 'tool' && m.toolUseId === 'call_eval')
  const text = toolRow && toolRow.role === 'tool' ? (toolRow.blocks[0]?.text ?? '') : ''
  if (text !== IGNORED_TEXT) {
    throw new Error(`dismiss-on-message: expected IGNORED_TEXT, got ${JSON.stringify(text)}`)
  }
  if (text.includes('permission_denied') || text === ABORTED_TEXT) {
    throw new Error(
      `dismiss-on-message: tool text must not be permission_denied or ABORTED_TEXT: ${JSON.stringify(text)}`,
    )
  }
  if (text === 'hi' || executeCount !== 0) {
    throw new Error('dismiss-on-message: tool executed')
  }
  const userIdx = loaded.messages.findIndex(
    (m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && b.text === spec.prompt),
  )
  const toolIdx = loaded.messages.findIndex((m) => m.role === 'tool' && m.toolUseId === 'call_eval')
  if (userIdx < 0) {
    throw new Error('dismiss-on-message: user row missing')
  }
  if (toolIdx < 0 || userIdx <= toolIdx) {
    throw new Error('dismiss-on-message: expected IGNORED_TEXT then the user row')
  }
  if (spec.expect.pairing === true && unpairedToolUseIds(loaded.messages).length > 0) {
    throw new Error('dismiss-on-message: unpaired tool_use remained')
  }
  await engine.close()
}
```

`drainEvents` already exists at ~2243. Do not change `runIgnoredDismiss` or `runPendingAskPersist`. Unknown directory names still throw at ~156.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/eval/run.test.ts
```

Expected: FAIL until Task 1–3 exist — `dismiss-on-message: yielded pending permission ask` (or `user row missing`). After Task 1–3 code is in, this should PASS; if the fixture directory exists without the runner, `unknown eval fixture: dismiss-on-message`. `ignored-dismiss` and `pending-ask-persist` still their own pairing.

- [ ] **Step 3: Docs honesty (after the eval is green)**

Do this only after Task 1–3 code and the eval runner are in. Spec Status → **implemented**. Board D0.1 / D0.2 / D1.1 / D1.2 / D2 **done**. Leave Shipped sha empty until it lands on `main`.

`docs/superpowers/specs/2026-09-21-ignored-dismiss.md` ruling 8. Replace the “pending-guard unchanged” sentence with a pointer, keep the one-ask skip law:

```
8. **`submitMessage` pending-guard.** One-ask skip (`applyAskAnswer(..., 'ignored')` / Ink `i`) still pairs only and does not start a turn. Dismiss-and-continue of **all** parked owned asks on a new user message is amended by [`2026-09-21-dismiss-on-message.md`](2026-09-21-dismiss-on-message.md).
```

`docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md`: do not rewrite E1.1. Pointer only. In the header sentence and the Shipped pointer (~176), change “dismiss-on-message stays parked” to “dismiss-on-message amended by [`2026-09-21-dismiss-on-message.md`](2026-09-21-dismiss-on-message.md)”.

`docs/superpowers/specs/2026-09-20-leftover-ask-abort-pair.md` OUT / “Dismiss-on-message stays OUT” (~53, ~67, ~327): one-line amendment “dismiss-on-message amended by `2026-09-21-dismiss-on-message.md`”.

`docs/research/eve-analysis.md` (~176 and ~326): leftover-ask now has dismiss-on-message via `submitMessage` ([`2026-09-21-dismiss-on-message.md`](../superpowers/specs/2026-09-21-dismiss-on-message.md)). Approvals still do not dismiss-on-message. `eve-analysis.ko.md` (~106 / the long implemented paragraph): matching Korean pointer.

`ARCHITECTURE.md` `submitMessage` sequence (~250): after lock renew, document rewind recovery / `whenTreeStop`, then: idle (`liveTurn === null`) unpaired owned leftover-asks (this session + descendants) persist-then-drop `IGNORED_TEXT` via `applyAskAnswer(..., 'ignored')` and continue; persist-fail yields `pending permission ask` and does not append the user row; `liveTurn !== null` still yields `pending permission ask` and does not ignore. Quiet success (no extra status). Spec: [`2026-09-21-dismiss-on-message.md`](docs/superpowers/specs/2026-09-21-dismiss-on-message.md). Next to the `applyAskAnswer` paragraph (~647): parked `'ignored'` still does not start a turn; a **new user message** is the dismiss-on-message trigger.

`ARCHITECTURE.ko.md`: matching sentences at the `submitMessage` / `applyAskAnswer` paragraphs (~548).

`docs/headless.md` `POST /v1/session/:id/submit` (~87): parked leftover-ask + submit text persist-then-drops `IGNORED_TEXT` then continues (quiet; not a `pending permission ask` no-op). Live turn still blocks. Crash-resolve `'ignored'` still pairs only. Pointer to this spec next to the ignored-dismiss resolve bullet.

`CHANGELOG.md` Unreleased ### Added, **prepend**:

```md
- Idle `submitMessage` dismisses owned unpaired leftover-asks (`IGNORED_TEXT`, no execute) then continues the new user text. `liveTurn !== null` still yields `pending permission ask`. Persist-fail is all-or-nothing before the user row. `applyAskAnswer(..., 'ignored')` / Ink `i` still pair only. `clearKeepId` / `rewindLast` still refuse. Esc / I2 stay `ABORTED_TEXT`. Slack/Discord/ACP stay 3-way (a follow-up **message** through `submitMessage` dismisses as a side effect). Schema stays **v11**. Spec: [docs/superpowers/specs/2026-09-21-dismiss-on-message.md](docs/superpowers/specs/2026-09-21-dismiss-on-message.md). Plan: [docs/superpowers/plans/2026-09-21-dismiss-on-message.md](docs/superpowers/plans/2026-09-21-dismiss-on-message.md).
```

Do not touch Slack/Discord/ACP adapters, `pending-asks.ts`, WorkspaceFs, NotebookEdit, Grep/Glob.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/eval/run.test.ts ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/loop/query-loop.test.ts
```

Expected: PASS. `dismiss-on-message` eval green. `ignored-dismiss` and `pending-ask-persist` still their own pairing. Session-engine pins green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/eval/run.ts \
  packages/core/src/eval/fixtures/dismiss-on-message/case.json \
  docs/superpowers/specs/2026-09-21-dismiss-on-message.md \
  docs/superpowers/specs/2026-09-21-ignored-dismiss.md \
  docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md \
  docs/superpowers/specs/2026-09-20-leftover-ask-abort-pair.md \
  docs/research/eve-analysis.md \
  docs/research/eve-analysis.ko.md \
  ARCHITECTURE.md \
  ARCHITECTURE.ko.md \
  docs/headless.md \
  CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: lock dismiss-on-message eval and architecture

Eval seeds a leftover-ask and asserts IGNORED_TEXT then the
user row. Docs unpark the submitMessage trigger.
EOF
)"
```

---

## Self-review

1. **Spec coverage.** Binding rulings 1–16 and Success checks 1–8 each have a task: D0.1 success + two-row + quiet (Task 1); persist-fail all-or-nothing + retry (Task 2); descendants, liveTurn-only, applyAskAnswer no-turn, clear/rewind refuse, I2 `ABORTED_TEXT`, concurrent first-persist-wins, allow does not ignore siblings (Task 3); eval + docs (Task 4). No fourth host entry. Empty-text law unchanged (Task 1). Follow-up / ACP / Slack buttons / schema / WorkspaceFs / NotebookEdit / Grep/Glob not edited.
2. **Placeholder scan.** No TBD / TODO / “similar to Task N” / “add error handling” / “write tests for the above”. Harness setup is repeated in each task (`createMemoryStore`, `makeSession`, `engineOpts`, `createAskEcho`, `createFakeProvider`, leftover-ask seed, `drain`).
3. **Type consistency.** `applyAskAnswer(callId, 'ignored')`, status string exactly `pending permission ask`, `IGNORED_TEXT` constant, `{ ok: false, notice: 'pending permission ask' }` for clear/rewind.
4. **bun test paths** start with `./`.
5. **HEREDOC commits** on every task.
6. **Tests that stay green (do not retarget):** live cancel abort-pair; persist-fail on cancel leaves the row; `pending-ask-persist` eval deny; `ignored-dismiss` eval; ACP timeout leave-row; Slack durable timer does not deny; `dontAsk` leftover deny; serve resolve unmatched 404; keep-id `/clear` refuse child unpaired ask (**clear**, not submit); rewind refuse pending permission ask. The one exception is the query-loop submitMessage-blocks-the-sibling case (ruling 19).
