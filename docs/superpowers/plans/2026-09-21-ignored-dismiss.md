# Ignored dismiss-and-continue — Implementation Plan

I'm using the writing-plans skill to create the implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unpark `'ignored'` as a leftover-ask / live `askUser` result. Persist-then-drop, no execute, live continues. Spec + this plan first; then TDD in an isolated worktree.

**Architecture:** `PendingAskAnswer += 'ignored'`. Parked `applyAskAnswer(..., 'ignored')` pairs `IGNORED_TEXT` then drops. Live `'ignored'` is deny-shaped (`abortRest: false`). HTTP keeps `{ callId, allow: boolean }` and adds optional `answer`. Ink `i` / OpenTUI `i|skip|ignored`. No schema bump. No fourth host entry.

**Tech Stack:** Bun, TypeScript, existing `SessionStore`, `createSessionEngine`, serve `parseResolveBody`.

**Spec:** `docs/superpowers/specs/2026-09-21-ignored-dismiss.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. **`applyAskAnswer` remains the only non-`submitMessage` closer for operator answers.** Extending its enum is this door. A fourth host entry is forbidden.
- Pairing 1:1. Never a second tool row for the same `callId`. Persist-before-execute stays.
- `dontAsk` leftover stays deny, not ignored. `decidePermission` must not emit ignored.
- Abort-pair I2 stays `ABORTED_TEXT`. Ignored is an operator answer. Aborted is a stop. Esc / `AbortError` / `abort('cancel'|'interrupt')` stay aborted.
- Default prefix unchanged. No new tool.
- No schema bump. v11 stays. Do not add `pending_asks.answer`.
- BYOK. Clean-room. **No web UI, Prisma Task, Socket.IO, wiki, Grep/Glob docker-exec, LSP depth, dismiss-on-message, Slack/Discord/ACP skip UI.**
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push.
- Do not remap timeout to ignored. Slack/Discord/ACP stay 3-way.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification only.

1. **`PendingAskAnswer += 'ignored'`.** `SessionEngineOptions.askUser` returns `Promise<PendingAskAnswer>` (stop duplicating the three-way union in `types.ts`). Slack / Discord / ACP / chat-host 3-way aliases stay 3-way.

2. **`IGNORED_TEXT`** in `pairing.ts` is exactly:

   `ignored: the operator skipped this ask. The tool was not executed.`

   `ok: false`. Must not start with `permission_denied:` or `aborted:`. Prefer this constant in every assertion.

3. **`applyAskAnswerOnce`:** `'ignored'` persist-then-drop **before** execute (deny-shaped, not I2). Do not `persistAllowAlways`. Persist fail leaves the row. Unknown non-enum runtime string → `'unmatched'`, **no claim**, no execute, row stays. Close today’s fall-through-to-execute for unknown values only. `'allow'` / `'deny'` / `'allow_always'` stay as today. Check unknown **after** the existing `executedAsks` branch and **before** `claimAsk`.

4. **`executeOneCall`:** `'ignored'` like deny (`abortRest: false`, skip only that call, rest of the batch runs). Without this branch live ignored would execute (silent bypass). Same PR as the enum. Live `askUser` stays typed `PendingAskAnswer`; do not add a live unmatched branch.

5. **Live wrap** (`session-engine.ts` `askUser` around `opts.askUser`):

   ```ts
   if (answer === 'allow' || answer === 'allow_always') claimAsk(event.id)
   ```

   Do not keep `!== 'deny'`.

6. **`parseResolveBody` keeps the request body `{ callId, allow: boolean }`.** Add optional `answer?: PendingAskAnswer`. Success return is `{ ok: true; callId: string; answer: PendingAskAnswer }` (`allow` is request-body only; serve uses `parsed.answer`). `{ callId, answer: 'allow_always' }` is **IN**. Validation order and **400 error strings** (locked):

   | Condition | `error` |
   |---|---|
   | body not a non-array object | `body must be an object` (reuse) |
   | missing / non-string / blank `callId` | `callId is required` (reuse) |
   | `allow` present and not boolean | `allow must be a boolean` (reuse) |
   | `answer` present and not `'allow'\|'deny'\|'allow_always'\|'ignored'` | `answer must be allow, deny, allow_always, or ignored` |
   | missing both `allow` and `answer` | `allow or answer is required` |
   | both present and they disagree | `allow and answer disagree` |

   `allow: true` maps to `'allow'`; `allow: false` maps to `'deny'`. `{ allow: true, answer: 'allow_always' }` **disagrees** (400). Unmatched still **404** `{ status: 'unmatched' }`. Do not change POST submit 202, compact, or cancel.

7. **Ink `i` / `I`.** OpenTUI `i` / `skip` / `ignored` (case-insensitive via existing `toLowerCase`). Esc stays abort. `y`/`n`/`a` unchanged. Dialog copy mentions skip: `y allow   n deny   a always   i skip` (Ink also keeps `esc abort` on the same line).

8. **Eval fixture `ignored-dismiss` is required** (pairing lock). Sibling of `pending-ask-persist`. Do **not** change the existing deny fixture. Copy helpers locally in `eval/run.ts`; do not import from test files. Unknown directory names still throw.

9. **Worktree.** Implement in this worktree (`/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/ignored-dismiss`) or a later isolated worktree. Never on `main`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/session/pending-asks.ts` | `PendingAskAnswer += 'ignored'`; `isPendingAskAnswer` |
| `packages/core/src/types.ts` | `askUser` returns `Promise<PendingAskAnswer>` |
| `packages/core/src/loop/pairing.ts` | `IGNORED_TEXT` |
| `packages/core/src/loop/pairing.test.ts` | constant distinct from abort / deny |
| `packages/core/src/loop/session-engine.ts` | ignored persist-then-drop; unknown unmatched; claim wrap |
| `packages/core/src/loop/session-engine.test.ts` | grandchild ignored row |
| `packages/core/src/loop/query-loop.test.ts` | parked ignored / unknown; live ignored |
| `packages/core/src/loop/phases.ts` | live `'ignored'` like deny |
| `packages/core/src/gateway/http.ts` | optional `answer`; locked 400 strings |
| `packages/core/src/gateway/http.test.ts` | parse matrix |
| `packages/cli/src/serve.ts` | resolve uses `parsed.answer` |
| `packages/cli/src/serve.test.ts` | live settle ignored; crash-resolve ignored; 400s |
| `packages/cli/src/permission-dialog.tsx` | Ink `i`; copy mentions skip |
| `packages/cli/src/permission-dialog.test.ts` | `keyToPermission` |
| `packages/cli/src/app.tsx` | `PendingAsk` resolve type |
| `packages/cli/src/opentui-app.ts` | `i` / `skip` / `ignored` |
| `packages/cli/src/opentui-app.test.ts` | skip-key bridge |
| `packages/tui-opentui/src/render.ts` | prompt line mentions skip |
| `packages/tui-opentui/src/render.test.ts` | prompt line |
| `packages/core/src/eval/run.ts` + `fixtures/ignored-dismiss/` | required eval lock |
| docs listed in Task 6 | L0 pointers + shipped wording after code |

Leave Slack/Discord/ACP adapters on 3-way.

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 I0 enum + persist + unknown + wrap | `pending-asks.ts`, `types.ts`, `pairing.ts`, `pairing.test.ts` (new), `session-engine.ts` (applyAskAnswerOnce + wrap), `session-engine.test.ts` (grandchild ignored), `query-loop.test.ts` (parked ignored / unknown / persist-fail / submitMessage guard) |
| 2 I1.1 live `executeOneCall` | `phases.ts`, `query-loop.test.ts` (live ignored + sibling + no double-pair) |
| 3 I1.2 resolve envelope | `http.ts`, `http.test.ts`, `serve.ts`, `serve.test.ts` |
| 4 I1.3 TUI skip key | `permission-dialog.tsx`, `permission-dialog.test.ts`, `app.tsx`, `opentui-app.ts`, `opentui-app.test.ts`, `tui-opentui` render + test |
| 5 I2 eval | `eval/run.ts`, `eval/fixtures/ignored-dismiss/case.json` |
| 6 I2 shipped docs | spec Status/board after code; ARCHITECTURE / `.ko.md`, SLASH_COMMANDS / `.ko.md`, headless, remaining-roadmap, leftover-ask OUT, eve-inspired pointer, CHANGELOG, eve-analysis pointer |

Task 1 first (enum + parked path + wrap). Task 2 after 1 (live ignored would execute without Task 1 enum + wrap). Task 3 after 1 (`PendingAskAnswer` + `isPendingAskAnswer`). Task 4 after 1 (askUser type). Task 5 after 1–2. Task 6 last.

---

### Task 1: I0 enum + `IGNORED_TEXT` + parked persist + unknown fail-closed + claim wrap

**Files:**
- Modify: `packages/core/src/session/pending-asks.ts:18`
- Modify: `packages/core/src/types.ts:486-489`
- Modify: `packages/core/src/loop/pairing.ts` (next to `ABORTED_TEXT` ~9)
- Create: `packages/core/src/loop/pairing.test.ts`
- Modify: `packages/core/src/loop/session-engine.ts` (`applyAskAnswerOnce` ~435, live wrap ~910)
- Modify: `packages/core/src/loop/query-loop.test.ts` (next to deny ~813)
- Modify: `packages/core/src/loop/session-engine.test.ts` (grandchild ~1945; import `IGNORED_TEXT`)

**Interfaces:**
- Consumes: existing `persistSettledTool`, `dropPendingAsk`, `claimAsk`, `denyText`, `makeToolMessage`, `persistAllowAlways`
- Produces: `PendingAskAnswer` includes `'ignored'`; `IGNORED_TEXT`; `isPendingAskAnswer(value: unknown)`; parked ignored persist-then-drop; unknown `'unmatched'`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/loop/pairing.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { ABORTED_TEXT, denyText, IGNORED_TEXT } from './pairing'

test('IGNORED_TEXT is distinct from abort and deny', () => {
  expect(IGNORED_TEXT).toBe(
    'ignored: the operator skipped this ask. The tool was not executed.',
  )
  expect(IGNORED_TEXT.startsWith('permission_denied:')).toBe(false)
  expect(IGNORED_TEXT.startsWith('aborted:')).toBe(false)
  expect(IGNORED_TEXT).not.toBe(ABORTED_TEXT)
  expect(IGNORED_TEXT).not.toBe(denyText('Echo?'))
  expect(IGNORED_TEXT.includes('permission_denied')).toBe(false)
})
```

In `packages/core/src/loop/query-loop.test.ts`, next to `applyAskAnswer deny persists permission_denied and deletes the row`, add:

```ts
test('applyAskAnswer ignored persists IGNORED_TEXT and does not execute', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_ignored' })
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
  const engine = await createSessionEngine(
    engineOpts({
      provider: createFakeProvider([textThenStop('nope')]),
      store,
      session,
      tools: [echo],
    }),
  )
  expect(await engine.applyAskAnswer('call_1', 'ignored')).toBe('matched')
  expect(await store.listPendingAsks(session.id)).toHaveLength(0)
  const loaded = await store.loadSession(session.id)
  const toolRow = loaded.messages.find((m) => m.role === 'tool')
  expect(toolRow?.ok).toBe(false)
  expect(toolRow && toolRow.role === 'tool' ? toolRow.blocks[0]?.text : '').toBe(IGNORED_TEXT)
  expect(echo.executeCount).toBe(0)
  expect(await store.listPermissionRules(session.id)).toHaveLength(0)
})

test('applyAskAnswer ignored of kind ask_user shares the persist path', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_ignored_ask_user' })
  await store.createSession(session)
  await store.persistToolCalls(session.id, {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'call_ask', name: 'Echo', input: { text: 'hi' } }],
    createdAt: 1,
  })
  await store.upsertPendingAsk({
    callId: 'call_ask',
    sessionId: session.id,
    kind: 'ask_user',
    tool: 'Echo',
    message: 'Echo?',
    input: { text: 'hi' },
    createdAt: 1,
  })
  const echo = createAskEcho()
  const engine = await createSessionEngine(
    engineOpts({
      provider: createFakeProvider([]),
      store,
      session,
      tools: [echo],
    }),
  )
  expect(await engine.applyAskAnswer('call_ask', 'ignored')).toBe('matched')
  expect(echo.executeCount).toBe(0)
  const loaded = await store.loadSession(session.id)
  const toolRow = loaded.messages.find((m) => m.role === 'tool' && m.toolUseId === 'call_ask')
  expect(toolRow && toolRow.role === 'tool' ? toolRow.blocks[0]?.text : '').toBe(IGNORED_TEXT)
})

test('applyAskAnswer unknown string is unmatched and does not execute', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_unknown_answer' })
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
  const engine = await createSessionEngine(
    engineOpts({
      provider: createFakeProvider([]),
      store,
      session,
      tools: [echo],
    }),
  )
  expect(await engine.applyAskAnswer('call_1', 'bogus' as 'deny')).toBe('unmatched')
  expect(await store.listPendingAsks(session.id)).toHaveLength(1)
  expect(echo.executeCount).toBe(0)
  expect(await engine.applyAskAnswer('call_1', 'deny')).toBe('matched')
  expect(await store.listPendingAsks(session.id)).toHaveLength(0)
  const loaded = await store.loadSession(session.id)
  const toolRow = loaded.messages.find((m) => m.role === 'tool')
  expect(toolRow && toolRow.role === 'tool' ? toolRow.blocks[0]?.text : '').toContain(
    'permission_denied',
  )
  expect(echo.executeCount).toBe(0)
})

test('applyAskAnswer ignored persist-fail leaves the row', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_ignored_persist_fail' })
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
  store.persistToolResults = async () => {
    throw new Error('disk')
  }
  const engine = await createSessionEngine(
    engineOpts({
      provider: createFakeProvider([]),
      store,
      session,
      tools: [echo],
    }),
  )
  await expect(engine.applyAskAnswer('call_1', 'ignored')).rejects.toBeInstanceOf(Error)
  expect(await store.listPendingAsks(session.id)).toHaveLength(1)
  expect(echo.executeCount).toBe(0)
})

test('applyAskAnswer ignored of one parked ask still blocks submitMessage on the other', async () => {
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
  const { events, result } = await collect(engine.submitMessage('hello anyway'))
  expect(result).toEqual({ reason: 'completed' })
  expect(events.some((e) => e.type === 'status' && e.message.includes('pending'))).toBe(true)
  const loaded = await store.loadSession(session.id)
  expect(loaded.messages.filter((m) => m.role === 'user')).toHaveLength(0)
  expect(echo.executeCount).toBe(0)
})

test('applyAskAnswer ignored does not rewrite an existing ABORTED_TEXT pair', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_ignored_after_abort' })
  await store.createSession(session)
  await store.persistToolCalls(session.id, {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'hi' } }],
    createdAt: 1,
  })
  await store.persistToolResults(session.id, [
    {
      id: 't1',
      role: 'tool',
      toolUseId: 'call_1',
      ok: false,
      blocks: [{ type: 'text', text: ABORTED_TEXT }],
      createdAt: 2,
    },
  ])
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
  const engine = await createSessionEngine(
    engineOpts({
      provider: createFakeProvider([]),
      store,
      session,
      tools: [echo],
    }),
  )
  expect(await engine.applyAskAnswer('call_1', 'ignored')).toBe('matched')
  expect(await store.listPendingAsks(session.id)).toHaveLength(0)
  const loaded = await store.loadSession(session.id)
  const tools = loaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'call_1')
  expect(tools).toHaveLength(1)
  expect(tools[0] && tools[0].role === 'tool' ? tools[0].blocks[0]?.text : '').toBe(ABORTED_TEXT)
  expect(echo.executeCount).toBe(0)
})
```

Import `ABORTED_TEXT` and `IGNORED_TEXT` from `./pairing` (query-loop.test.ts already imports `unpairedToolUseIds` from there).

In `packages/core/src/loop/session-engine.test.ts`, next to the grandchild allow test:

```ts
test('parent applyAskAnswer ignored pairs the grandchild session with IGNORED_TEXT', async () => {
  const store = createMemoryStore()
  const parent = makeSession({ id: 'sess_ignored_grand_parent' })
  const child = makeSession({ id: 'sess_ignored_grand_child', parentSessionId: parent.id })
  const grand = makeSession({ id: 'sess_ignored_grand', parentSessionId: child.id })
  await store.createSession(parent)
  await store.createSession(child)
  await store.createSession(grand)
  await store.persistToolCalls(grand.id, {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'call_grand', name: 'Echo', input: { text: 'hi' } }],
    createdAt: 1,
  })
  await store.upsertPendingAsk({
    callId: 'call_grand',
    sessionId: grand.id,
    kind: 'leftover',
    tool: 'Echo',
    message: 'Echo?',
    input: { text: 'hi' },
    createdAt: 1,
  })
  const echo = createAskEcho()
  const engine = await createSessionEngine({
    ...engineOpts({
      provider: createFakeProvider([]),
      store,
      session: parent,
      tools: [echo],
    }),
  })
  expect(await engine.applyAskAnswer('call_grand', 'ignored')).toBe('matched')
  expect(await store.listPendingAsks(grand.id)).toHaveLength(0)
  const grandLoaded = await store.loadSession(grand.id)
  const tools = grandLoaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'call_grand')
  expect(tools).toHaveLength(1)
  expect(tools[0]?.ok).toBe(false)
  expect((tools[0]?.blocks[0] as { text?: string })?.text).toBe(IGNORED_TEXT)
  const parentLoaded = await store.loadSession(parent.id)
  expect(parentLoaded.messages.some((m) => m.role === 'tool')).toBe(false)
  expect(echo.executeCount).toBe(0)
})
```

Keep `applyAskAnswer deny persists permission_denied` and grandchild allow unchanged.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/loop/pairing.test.ts ./packages/core/src/loop/query-loop.test.ts ./packages/core/src/loop/session-engine.test.ts
```

Expected: FAIL — `IGNORED_TEXT` missing; `'ignored'` is not on `PendingAskAnswer`; unknown `'bogus'` falls through to execute (or type/runtime execute); grandchild ignored executes Echo.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/session/pending-asks.ts`:

```ts
export type PendingAskAnswer = 'allow' | 'deny' | 'allow_always' | 'ignored'

const PENDING_ASK_ANSWERS: readonly PendingAskAnswer[] = [
  'allow',
  'deny',
  'allow_always',
  'ignored',
]

export function isPendingAskAnswer(value: unknown): value is PendingAskAnswer {
  return typeof value === 'string' && (PENDING_ASK_ANSWERS as readonly string[]).includes(value)
}
```

`packages/core/src/types.ts` `askUser`:

```ts
askUser: (
  e: Extract<StreamEvent, { type: 'permission_ask' }>,
  signal: AbortSignal,
) => Promise<PendingAskAnswer>
```

`packages/core/src/loop/pairing.ts` next to `ABORTED_TEXT`:

```ts
export const IGNORED_TEXT =
  'ignored: the operator skipped this ask. The tool was not executed.'
```

`applyAskAnswerOnce` after the `executedAsks` branch, before `claimAsk`:

```ts
if (!isPendingAskAnswer(answer as string)) return 'unmatched'

if (!claimAsk(callId)) return 'matched'

if (answer === 'deny') {
  await persistSettledTool(makeToolMessage(callId, false, denyText(row.message)), target.sessionId)
  await dropPendingAsk(callId)
  return 'matched'
}

if (answer === 'ignored') {
  await persistSettledTool(makeToolMessage(callId, false, IGNORED_TEXT), target.sessionId)
  await dropPendingAsk(callId)
  return 'matched'
}

if (answer === 'allow_always') {
  await persistAllowAlways({ /* existing */ })
}
// existing execute path
```

Import `isPendingAskAnswer` from `pending-asks.ts` and `IGNORED_TEXT` from `pairing.ts`. Do not reuse `persistBeforeDropAsk` (that is I2 / `ABORTED_TEXT`).

Live wrap:

```ts
askUser: async (event, signal) => {
  const answer = await opts.askUser(event, signal)
  if (answer === 'allow' || answer === 'allow_always') claimAsk(event.id)
  return answer
},
```

Do not edit `phases.ts` in this task.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/loop/pairing.test.ts ./packages/core/src/loop/query-loop.test.ts ./packages/core/src/loop/session-engine.test.ts
```

Expected: PASS. Deny still `permission_denied`. Unknown then deny still pairs deny. I2 `ABORTED_TEXT` tests stay green. Parent interrupt still leaves a child leftover-ask.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/pending-asks.ts \
  packages/core/src/types.ts \
  packages/core/src/loop/pairing.ts \
  packages/core/src/loop/pairing.test.ts \
  packages/core/src/loop/session-engine.ts \
  packages/core/src/loop/session-engine.test.ts \
  packages/core/src/loop/query-loop.test.ts
git commit -m "$(cat <<'EOF'
feat: persist ignored leftover-asks without executing

PendingAskAnswer grows ignored. Parked applyAskAnswer
pairs IGNORED_TEXT then drops. Unknown answers unmatched.
EOF
)"
```

---

### Task 2: I1.1 live `executeOneCall` ignored

**Files:**
- Modify: `packages/core/src/loop/phases.ts` (`executeOneCall` askUser ~1309)
- Modify: `packages/core/src/loop/query-loop.test.ts` (live ignored, next to leftover-ask / live allow ~698)

**Interfaces:**
- Consumes: `state.askUser`, `IGNORED_TEXT`, `denyText`, `claimAsk` wrap from Task 1
- Produces: live `'ignored'` → `abortRest: false`, `IGNORED_TEXT`, no execute; siblings still run; second `applyAskAnswer` does not double-pair

- [ ] **Step 1: Write the failing tests**

```ts
test('live ignored pairs IGNORED_TEXT, continues, and does not execute', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_live_ignored' })
  await store.createSession(session)
  const echo = createAskEcho()
  const engine = await createSessionEngine({
    ...engineOpts({
      provider: createFakeProvider([
        toolThenStop('call_live', 'Echo', { text: 'hi' }),
        textThenStop('done'),
      ]),
      store,
      session,
      tools: [echo],
    }),
    askUser: async () => 'ignored',
  })
  const { events, result } = await collect(engine.submitMessage('go'))
  expect(result).toEqual({ reason: 'completed' })
  expect(echo.executeCount).toBe(0)
  expect(await store.listPendingAsks(session.id)).toHaveLength(0)
  const loaded = await store.loadSession(session.id)
  const toolRow = loaded.messages.find((m) => m.role === 'tool' && m.toolUseId === 'call_live')
  expect(toolRow?.ok).toBe(false)
  expect(toolRow && toolRow.role === 'tool' ? toolRow.blocks[0]?.text : '').toBe(IGNORED_TEXT)
  expect(
    loaded.messages.some(
      (m) =>
        m.role === 'tool' &&
        m.blocks.some((b) => b.type === 'text' && b.text === ABORTED_TEXT),
    ),
  ).toBe(false)
  expect(events.some((e) => e.type === 'permission_ask')).toBe(true)
})

test('live ignored skips only that call; sibling still executes', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_live_ignored_sib' })
  await store.createSession(session)
  const echo = createAskEcho()
  const engine = await createSessionEngine({
    ...engineOpts({
      provider: createFakeProvider([
        [
          { type: 'tool_call', id: 'p1', name: 'Echo', input: { text: 'first' } },
          { type: 'tool_call', id: 'p2', name: 'Echo', input: { text: 'second' } },
          { type: 'stop', reason: 'tool_use' },
        ],
        textThenStop('done'),
      ]),
      store,
      session,
      tools: [echo],
    }),
    askUser: async (event) => (event.id === 'p1' ? 'ignored' : 'allow'),
  })
  const { result } = await collect(engine.submitMessage('both'))
  expect(result).toEqual({ reason: 'completed' })
  expect(echo.executeCount).toBe(1)
  const loaded = await store.loadSession(session.id)
  const toolRows = loaded.messages.filter(
    (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
  )
  expect(toolRows.map((row) => row.toolUseId)).toEqual(['p1', 'p2'])
  expect(toolRows.map((row) => row.blocks[0]?.text)).toEqual([IGNORED_TEXT, 'second'])
})

test('live ignored then applyAskAnswer does not double-pair', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_live_ignored_double' })
  await store.createSession(session)
  let releaseAsk!: (answer: 'allow' | 'deny' | 'allow_always' | 'ignored') => void
  const held = new Promise<'allow' | 'deny' | 'allow_always' | 'ignored'>((resolve) => {
    releaseAsk = resolve
  })
  const echo = createAskEcho()
  const engine = await createSessionEngine({
    ...engineOpts({
      provider: createFakeProvider([
        toolThenStop('call_live', 'Echo', { text: 'hi' }),
        textThenStop('done'),
      ]),
      store,
      session,
      tools: [echo],
    }),
    askUser: async () => held,
  })
  const gen = engine.submitMessage('go')
  const events: StreamEvent[] = []
  while (events.every((e) => e.type !== 'permission_ask')) {
    const next = await gen.next()
    if (next.done) break
    events.push(next.value)
  }
  expect(await store.listPendingAsks(session.id)).toHaveLength(1)
  releaseAsk('ignored')
  await collect(gen)
  expect(await engine.applyAskAnswer('call_live', 'ignored')).toBe('matched')
  expect(echo.executeCount).toBe(0)
  const loaded = await store.loadSession(session.id)
  const tools = loaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'call_live')
  expect(tools).toHaveLength(1)
  expect(tools[0] && tools[0].role === 'tool' ? tools[0].blocks[0]?.text : '').toBe(IGNORED_TEXT)
})
```

Keep `live allow then applyAskAnswer does not execute the tool twice`. Do not retarget `AskWaiterExpired` / abort-throw paths.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/loop/query-loop.test.ts
```

Expected: FAIL — live `'ignored'` falls through to `allowed = true` and executes Echo.

- [ ] **Step 3: Write minimal implementation**

In `executeOneCall`, immediately after the live `'deny'` branch (~1309):

```ts
if (answer === 'ignored') {
  return {
    messages: [makeToolMessage(call.id, false, IGNORED_TEXT)],
    events,
    abortRest: false,
  }
}
```

Import `IGNORED_TEXT` from `./pairing`. Do not persist allow-always. Do not set `abortRest: true`. Do not change the `AskWaiterExpired` empty+row branch or abort → `pairMissing(..., 'aborted')`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/loop/query-loop.test.ts ./packages/core/src/loop/session-engine.test.ts
```

Expected: PASS. Live ignored continues. Sibling executes. No `ABORTED_TEXT`. Live cancel abort-pair still `ABORTED_TEXT`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop/phases.ts packages/core/src/loop/query-loop.test.ts
git commit -m "$(cat <<'EOF'
feat: live ignored skips the tool and continues the turn

executeOneCall treats ignored like deny: abortRest false,
IGNORED_TEXT, no execute. Siblings still run.
EOF
)"
```

---

### Task 3: I1.2 HTTP resolve envelope

**Files:**
- Modify: `packages/core/src/gateway/http.ts:44-60`
- Modify: `packages/core/src/gateway/http.test.ts` (`parseResolveBody` ~45)
- Modify: `packages/cli/src/serve.ts` (resolve handler ~774-787)
- Modify: `packages/cli/src/serve.test.ts` (resolve ~478 / live settle ~1672; widen `applyCalls` answer type)

**Interfaces:**
- Consumes: `isPendingAskAnswer`, `PendingAskAnswer`, `createServeAskHost.settle`, `applyAskAnswer`
- Produces: parse success `{ callId, answer }`; live settle of `'ignored'` / `'allow_always'` without `applyAskAnswer`; crash-resolve ignored pairs only; unmatched 404; locked 400 strings

- [ ] **Step 1: Write the failing tests**

Flip `parseResolveBody` in `http.test.ts`. Replace `requires callId string and allow boolean` so `{ callId: 'c1' }` is **not** still `'allow must be a boolean'`:

```ts
test('requires callId string and allow boolean or answer', () => {
  expect(parseResolveBody(null)).toEqual({ ok: false, error: 'body must be an object' })
  expect(parseResolveBody([])).toEqual({ ok: false, error: 'body must be an object' })
  expect(parseResolveBody({})).toEqual({ ok: false, error: 'callId is required' })
  expect(parseResolveBody({ callId: '  ', allow: true })).toEqual({
    ok: false,
    error: 'callId is required',
  })
  expect(parseResolveBody({ callId: 'c1' })).toEqual({
    ok: false,
    error: 'allow or answer is required',
  })
  expect(parseResolveBody({ callId: 'c1', allow: 'yes' })).toEqual({
    ok: false,
    error: 'allow must be a boolean',
  })
  expect(parseResolveBody({ callId: 'c1', answer: 'bogus' })).toEqual({
    ok: false,
    error: 'answer must be allow, deny, allow_always, or ignored',
  })
  expect(parseResolveBody({ callId: 'c1', allow: true, answer: 'ignored' })).toEqual({
    ok: false,
    error: 'allow and answer disagree',
  })
  expect(parseResolveBody({ callId: 'c1', allow: true, answer: 'allow_always' })).toEqual({
    ok: false,
    error: 'allow and answer disagree',
  })
})

test('returns trimmed callId and mapped answer', () => {
  expect(parseResolveBody({ callId: '  c1  ', allow: true })).toEqual({
    ok: true,
    callId: 'c1',
    answer: 'allow',
  })
  expect(parseResolveBody({ callId: 'c1', allow: false })).toEqual({
    ok: true,
    callId: 'c1',
    answer: 'deny',
  })
  expect(parseResolveBody({ callId: 'c1', answer: 'ignored' })).toEqual({
    ok: true,
    callId: 'c1',
    answer: 'ignored',
  })
  expect(parseResolveBody({ callId: 'c1', answer: 'allow_always' })).toEqual({
    ok: true,
    callId: 'c1',
    answer: 'allow_always',
  })
  expect(parseResolveBody({ callId: 'c1', allow: false, answer: 'deny' })).toEqual({
    ok: true,
    callId: 'c1',
    answer: 'deny',
  })
})
```

In `serve.test.ts`, widen `applyCalls` / mock `applyAskAnswer` answer to `PendingAskAnswer` (or `'allow' | 'deny' | 'allow_always' | 'ignored'`). Keep `resolve allow deletes the pending row` (`allow: false` still deny). Keep unmatched 404.

Add:

```ts
test('POST resolve answer ignored settles a live leftover-ask without applyAskAnswer', async () => {
  const ctx = await makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
  const host = createServeAskHost()
  const pending = host.askUser(
    { type: 'permission_ask', id: 'c1', tool: 'Write', input: {}, message: 'Write?' },
    new AbortController().signal,
  )
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/resolve', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: JSON.stringify({ callId: 'c1', answer: 'ignored' }),
    }),
    { ...ctx, settleAsk: (callId, answer) => host.settle(callId, answer) },
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: 'matched' })
  await expect(pending).resolves.toBe('ignored')
  expect(ctx.applyCalls).toEqual([])
})

test('POST resolve answer allow_always settles live without applyAskAnswer', async () => {
  const ctx = await makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
  const host = createServeAskHost()
  const pending = host.askUser(
    { type: 'permission_ask', id: 'c1', tool: 'Write', input: {}, message: 'Write?' },
    new AbortController().signal,
  )
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/resolve', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: JSON.stringify({ callId: 'c1', answer: 'allow_always' }),
    }),
    { ...ctx, settleAsk: (callId, answer) => host.settle(callId, answer) },
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: 'matched' })
  await expect(pending).resolves.toBe('allow_always')
  expect(ctx.applyCalls).toEqual([])
})

test('POST resolve answer ignored crash-resolve calls applyAskAnswer ignored', async () => {
  const ctx = await makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
  await ctx.store.upsertPendingAsk({
    callId: 'parked',
    sessionId: 's1',
    kind: 'leftover',
    tool: 'Echo',
    message: 'Echo?',
    input: { text: 'hi' },
    createdAt: 1,
  } satisfies PendingAsk)
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/resolve', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: JSON.stringify({ callId: 'parked', answer: 'ignored' }),
    }),
    ctx,
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ status: 'matched' })
  expect(ctx.applyCalls).toEqual([{ callId: 'parked', answer: 'ignored' }])
})

test('POST resolve disagreeing allow and answer is 400', async () => {
  const ctx = await makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/resolve', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: JSON.stringify({ callId: 'c1', allow: true, answer: 'ignored' }),
    }),
    ctx,
  )
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'allow and answer disagree' })
  expect(ctx.applyCalls).toEqual([])
})
```

Keep `POST resolve settles a live leftover-ask without applyAskAnswer` (`allow: true` → `'allow'`).

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/gateway/http.test.ts ./packages/cli/src/serve.test.ts
```

Expected: FAIL — `{ callId: 'c1' }` still `'allow must be a boolean'`; success still `{ allow: true }`; serve maps only `allow ? 'allow' : 'deny'`.

- [ ] **Step 3: Write minimal implementation**

`parseResolveBody`:

```ts
export function parseResolveBody(
  body: unknown,
): { ok: true; callId: string; answer: PendingAskAnswer } | { ok: false; error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' }
  }
  const rec = body as Record<string, unknown>
  if (typeof rec.callId !== 'string') {
    return { ok: false, error: 'callId is required' }
  }
  const callId = rec.callId.trim()
  if (callId === '') return { ok: false, error: 'callId is required' }
  const hasAllow = rec.allow !== undefined
  const hasAnswer = rec.answer !== undefined
  if (hasAllow && typeof rec.allow !== 'boolean') {
    return { ok: false, error: 'allow must be a boolean' }
  }
  if (hasAnswer && !isPendingAskAnswer(rec.answer)) {
    return { ok: false, error: 'answer must be allow, deny, allow_always, or ignored' }
  }
  if (!hasAllow && !hasAnswer) {
    return { ok: false, error: 'allow or answer is required' }
  }
  const fromAllow: PendingAskAnswer | undefined = hasAllow
    ? rec.allow
      ? 'allow'
      : 'deny'
    : undefined
  const fromAnswer = hasAnswer ? rec.answer : undefined
  if (fromAllow !== undefined && fromAnswer !== undefined && fromAllow !== fromAnswer) {
    return { ok: false, error: 'allow and answer disagree' }
  }
  return { ok: true, callId, answer: fromAnswer ?? fromAllow! }
}
```

Import `isPendingAskAnswer` and `PendingAskAnswer` from `../session/pending-asks`.

Serve resolve handler: delete `const answer = parsed.allow ? 'allow' : 'deny'`. Use `parsed.answer` for `settleAsk` and `applyAskAnswer`. Do not change unmatched 404.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/core/src/gateway/http.test.ts ./packages/cli/src/serve.test.ts
```

Expected: PASS. `{ callId, allow: false }` still deny. Unmatched 404. Live settle ignored does not call `applyAskAnswer`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/gateway/http.ts \
  packages/core/src/gateway/http.test.ts \
  packages/cli/src/serve.ts \
  packages/cli/src/serve.test.ts
git commit -m "$(cat <<'EOF'
feat: resolve envelope accepts optional ignored answer

Keep { callId, allow } as the 2-way path. Optional answer
maps ignored and allow_always. Disagreeing fields 400.
EOF
)"
```

---

### Task 4: I1.3 Ink + OpenTUI skip key

**Files:**
- Modify: `packages/cli/src/permission-dialog.tsx` (copy ~17, `keyToPermission` ~22)
- Modify: `packages/cli/src/permission-dialog.test.ts`
- Modify: `packages/cli/src/app.tsx` (`PendingAsk.resolve` ~74, `bindAsk` promise ~219)
- Modify: `packages/cli/src/opentui-app.ts` (`parsePermissionAnswer` ~486)
- Modify: `packages/cli/src/opentui-app.test.ts` (next to `permission_ask then y` ~205)
- Modify: `packages/tui-opentui/src/render.ts:44`
- Modify: `packages/tui-opentui/src/render.test.ts:190`

**Interfaces:**
- Consumes: `PendingAskAnswer`, existing ask bridge
- Produces: Ink `i`/`I` → `'ignored'`; OpenTUI `i`/`skip`/`ignored` → `'ignored'`; prompt copy mentions skip; Esc unchanged

- [ ] **Step 1: Write the failing tests**

In `permission-dialog.test.ts`:

```ts
import { keyToPermission } from './permission-dialog'

test('keyToPermission maps i to ignored and keeps y/n/a', () => {
  expect(keyToPermission('i')).toBe('ignored')
  expect(keyToPermission('I')).toBe('ignored')
  expect(keyToPermission('y')).toBe('allow')
  expect(keyToPermission('n')).toBe('deny')
  expect(keyToPermission('a')).toBe('allow_always')
  expect(keyToPermission('skip')).toBeUndefined()
  expect(keyToPermission('escape')).toBeUndefined()
})
```

In `opentui-app.test.ts`, next to the `y` bridge test (widen that file’s answer arrays to include `'ignored'` only in the new tests):

```ts
test('permission_ask then i ignores via the ask bridge', async () => {
  const answers: Array<'allow' | 'deny' | 'allow_always' | 'ignored'> = []
  const ask = createAskBridge()
  const event: Extract<StreamEvent, { type: 'permission_ask' }> = {
    type: 'permission_ask',
    id: 'p1',
    tool: 'Bash',
    input: { command: 'ls' },
    message: 'Allow Bash?',
  }
  const engine = fakeEngine(makeSession(), async function* (text) {
    expect(text).toBe('run ls')
    yield event
    const answer = await ask.ask(event, new AbortController().signal)
    answers.push(answer)
    yield { type: 'text_delta', text: `answer:${answer}` }
    return { reason: 'completed' }
  })
  const written: string[] = []
  const code = await runOpenTuiApp(fakeRuntime(engine, { ask }), {
    input: asyncLines('run ls', 'i', '/quit'),
    write: (chunk) => {
      written.push(chunk)
    },
  })
  expect(code).toBe(0)
  expect(answers).toEqual(['ignored'])
  expect(written.join('')).toContain('answer:ignored')
})

test('permission_ask skip and ignored aliases map to ignored', async () => {
  for (const line of ['skip', 'ignored', 'SKIP'] as const) {
    const answers: Array<'allow' | 'deny' | 'allow_always' | 'ignored'> = []
    const ask = createAskBridge()
    const event: Extract<StreamEvent, { type: 'permission_ask' }> = {
      type: 'permission_ask',
      id: 'p1',
      tool: 'Bash',
      input: { command: 'ls' },
      message: 'Allow Bash?',
    }
    const engine = fakeEngine(makeSession(), async function* (text) {
      expect(text).toBe('run ls')
      yield event
      answers.push(await ask.ask(event, new AbortController().signal))
      return { reason: 'completed' }
    })
    const code = await runOpenTuiApp(fakeRuntime(engine, { ask }), {
      input: asyncLines('run ls', line, '/quit'),
      write: () => {},
    })
    expect(code).toBe(0)
    expect(answers).toEqual(['ignored'])
  }
})
```

Flip `packages/tui-opentui/src/render.test.ts` prompt third line from `'y allow   n deny   a always'` to `'y allow   n deny   a always   i skip'` (both parent and child cases). Do not leave the old string green.

Keep `casual line during leftover-ask does not deny; y still allows`.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/cli/src/permission-dialog.test.ts ./packages/cli/src/opentui-app.test.ts ./packages/tui-opentui/src/render.test.ts
```

Expected: FAIL — `i` is undefined; prompt line still three-way.

- [ ] **Step 3: Write minimal implementation**

`keyToPermission`:

```ts
export function keyToPermission(
  input: string,
): PendingAskAnswer | undefined {
  if (input === 'y' || input === 'Y') return 'allow'
  if (input === 'n' || input === 'N') return 'deny'
  if (input === 'a' || input === 'A') return 'allow_always'
  if (input === 'i' || input === 'I') return 'ignored'
  return undefined
}
```

Dialog copy: `y allow   n deny   a always   i skip   esc abort`.

`app.tsx`: `PendingAsk.resolve` and `bindAsk` promise type `PendingAskAnswer`. Import the type from `@ravenclaw/core`. Do not change Esc / `engine.abort('cancel')`.

`parsePermissionAnswer`:

```ts
function parsePermissionAnswer(line: string): PendingAskAnswer | undefined {
  const key = line.trim().toLowerCase()
  if (key === 'y' || key === 'yes' || key === 'allow') return 'allow'
  if (key === 'n' || key === 'no' || key === 'deny') return 'deny'
  if (key === 'a' || key === 'always' || key === 'allow_always') return 'allow_always'
  if (key === 'i' || key === 'skip' || key === 'ignored') return 'ignored'
  return undefined
}
```

`permissionPromptLines` last line: `'y allow   n deny   a always   i skip'`.

Do not edit Slack/Discord/ACP.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test ./packages/cli/src/permission-dialog.test.ts ./packages/cli/src/opentui-app.test.ts ./packages/tui-opentui/src/render.test.ts
```

Expected: PASS. `y` still allow. Casual line still does not settle.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/permission-dialog.tsx \
  packages/cli/src/permission-dialog.test.ts \
  packages/cli/src/app.tsx \
  packages/cli/src/opentui-app.ts \
  packages/cli/src/opentui-app.test.ts \
  packages/tui-opentui/src/render.ts \
  packages/tui-opentui/src/render.test.ts
git commit -m "$(cat <<'EOF'
feat: Ink and OpenTUI skip key maps to ignored

Ink i skips. OpenTUI i/skip/ignored skip. Esc stays abort.
EOF
)"
```

---

### Task 5: I2 eval lock `ignored-dismiss`

**Files:**
- Create: `packages/core/src/eval/fixtures/ignored-dismiss/case.json`
- Modify: `packages/core/src/eval/run.ts` (`runEvalDir` dispatch ~68, new `runIgnoredDismiss` next to `runPendingAskPersist`)

**Interfaces:**
- Consumes: `applyAskAnswer`, `IGNORED_TEXT`, existing `waitForPendingAsks` / `cloneStore` / `createAskEcho`
- Produces: fixture fails the runner if ignored does not pair or if the text is `permission_denied` / `ABORTED_TEXT`. Existing `pending-ask-persist` deny fixture unchanged.

- [ ] **Step 1: Add the fixture so `runEvalDir` fails on the old dispatch**

`packages/core/src/eval/fixtures/ignored-dismiss/case.json`:

```json
{
  "prompt": "echo hi",
  "expect": {
    "pendingAskPersists": true,
    "noIncomplete": true,
    "pairing": true
  }
}
```

Do not add a new `EvalExpect` key. Dispatch by directory name.

In `runEvalDir`, after the `pending-ask-persist` branch:

```ts
if (name === 'ignored-dismiss') {
  await runIgnoredDismiss(spec)
  continue
}
```

`runIgnoredDismiss` copies `runPendingAskPersist` locally (do not import from `query-loop.test.ts`). Differences from the deny fixture:

- `makeSession({ id: 'sess_eval_ignored_dismiss' })`
- After clone + live release `'deny'` (finish the in-process turn; do not change the deny fixture), crash-resolve the clone with `applyAskAnswer(callId, 'ignored')`
- If status !== `'matched'`, throw `ignored-dismiss: applyAskAnswer ignored returned ${status}`
- Loaded tool text must equal `IGNORED_TEXT`
- If the text includes `permission_denied` or equals `ABORTED_TEXT`, throw
- `unpairedToolUseIds` must be empty when `spec.expect.pairing === true`
- Do not execute (tool text is not `'hi'`)

Import `IGNORED_TEXT` next to the existing `ABORTED_TEXT` import in `run.ts`.

- [ ] **Step 2: Run eval tests**

```bash
bun test ./packages/core/src/eval/run.test.ts
```

Expected: PASS against Task 1–2 code. Would FAIL if the directory existed without the runner (`unknown eval fixture: ignored-dismiss`) or if ignored wrote `permission_denied`. `pending-ask-persist` still deny-pairs.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/eval/run.ts packages/core/src/eval/fixtures/ignored-dismiss/case.json
git commit -m "$(cat <<'EOF'
test: lock ignored leftover-ask pairing in eval

ignored-dismiss is a sibling of pending-ask-persist.
The deny fixture is unchanged.
EOF
)"
```

---

### Task 6: I2 shipped wording (after code)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-ignored-dismiss.md` (Status → implemented; board I0–I2 **done**)
- Modify: `ARCHITECTURE.md`, `ARCHITECTURE.ko.md` (`POST …/resolve` ~179; `applyAskAnswer` ~647)
- Modify: `docs/headless.md` (`POST …/resolve` ~90)
- Modify: `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md` (permission-ask keys if present; otherwise one leftover-ask sentence: Ink `i` / OpenTUI `i|skip|ignored`, Esc abort)
- Modify: `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md` (horizon pointer)
- Modify: `docs/superpowers/specs/2026-09-20-leftover-ask-abort-pair.md` (one-line OUT amendment: `ignored` as leftover-ask / live `askUser` result amended by this spec; dismiss-on-message stays OUT)
- Modify: `docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md` (one-line pointer only; do not rewrite E1.1)
- Modify: `CHANGELOG.md` Unreleased
- Modify: `docs/research/eve-analysis.md`, `eve-analysis.ko.md` (pointer that RavenClaw leftover-ask now has an `ignored` result; dismiss-on-message still parked)

- [ ] **Step 1: Point docs at the shipped behavior**

Parked `'ignored'` → one `IGNORED_TEXT` row, no execute, no model turn. Live `'ignored'` continues (`abortRest: false`). HTTP `{ callId, allow }` stays; optional `answer` including `'ignored'` and `'allow_always'`; disagreeing fields 400. Ink `i`, OpenTUI `i`/`skip`/`ignored`. Esc / I2 stay `ABORTED_TEXT`. `dontAsk` leftover stays deny. Slack/Discord/ACP stay 3-way. Schema v11. No web UI. Historical OUT lines stay; add “amended by `2026-09-21-ignored-dismiss.md`” only for the leftover-ask `ignored` result (not dismiss-on-message).

`ARCHITECTURE.md` resolve bullet becomes `{ callId, allow }` or `{ callId, answer }` settles a live waiter first, else `applyAskAnswer`. `applyAskAnswer(callId, allow|deny|allow_always|ignored)` is still the only non-`submitMessage` host entry.

- [ ] **Step 2: Commit**

```bash
git add ARCHITECTURE.md ARCHITECTURE.ko.md \
  SLASH_COMMANDS.md SLASH_COMMANDS.ko.md \
  docs/headless.md CHANGELOG.md \
  docs/superpowers/specs/2026-09-21-ignored-dismiss.md \
  docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md \
  docs/superpowers/specs/2026-09-20-leftover-ask-abort-pair.md \
  docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md \
  docs/research/eve-analysis.md docs/research/eve-analysis.ko.md
git commit -m "$(cat <<'EOF'
docs: mark ignored dismiss-and-continue implemented

Parked and live ignored pair IGNORED_TEXT. HTTP optional
answer. Parallel doors stay OUT.
EOF
)"
```

---

## Success checks

1. Parked `'ignored'` → one `IGNORED_TEXT` row, pending gone, tool not executed, no model turn, no allow-always rule.
2. Live `'ignored'` → loop continues; siblings run; no `ABORTED_TEXT`.
3. `{ callId, answer: 'ignored' }` resolve 200 matched; `{ callId, allow: false }` still deny; disagreeing fields 400 `allow and answer disagree`; `{ callId, answer: 'allow_always' }` is IN.
4. Esc / cancel I2 still `ABORTED_TEXT`. Parent interrupt still leaves a child leftover-ask.
5. `dontAsk` leftover still deny. ACP timeout still leaves the row.
6. `submitMessage` with a remaining other parked ask still `pending permission ask`.
7. Unknown `applyAskAnswer` string is `'unmatched'` and does not execute (a later `'deny'` still pairs).
8. Eval `ignored-dismiss` fails the runner if 1 regresses; `pending-ask-persist` still deny.

---

## Self-review

**Spec coverage:** I0.1–I0.2 → Task 1. I1.1 → Task 2. I1.2 → Task 3. I1.3 → Task 4. I2 eval → Task 5. I2 docs → Task 6. Live wrap allow/allow_always only. Unknown fail-closed. HTTP 400 strings locked. `{ callId, answer: 'allow_always' }` IN. Slack/ACP 3-way. No schema bump. I2 stays aborted. `dontAsk` stays deny.

**Placeholder scan:** none. Targeted bun commands start with `./`. Commits are HEREDOC.

**Type consistency:** `PendingAskAnswer` includes `'ignored'` in pending-asks, `askUser`, `applyAskAnswer`, serve settle, Ink/OpenTUI parsers. Slack/Discord/ACP aliases stay 3-way.
