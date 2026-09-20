# HTTP POST `/v1/session/:id/clear` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve-wire `POST /v1/session/:id/clear` that awaits already-shipped `engine.clearKeepId()` and returns HTTP 200 `{ ok, notice }`.

**Architecture:** Add `clear` to `SESSION_PATH`. Require `ServeEngine.clearKeepId`. Handler is Bearer → `loadSessionRuntime` → empty-or-ignore JSON → `await engine.clearKeepId()` → 200 `{ ok, notice }`. No wipe reimplementation. No `singleFlight`. No `abortCachedDescendants` / `whenTreeStop`. No mint. Schema stays v10. Do not edit `session-engine.ts`.

**Tech Stack:** Bun, TypeScript, existing `handleServeRequest` + `makeServeCtx` memory-store stubs.

**Spec:** `docs/superpowers/specs/2026-09-20-http-post-clear.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers. Clear is not a model turn and must not call `applyAskAnswer`.
- Default prefix stays small and frozen. No new always-on tool. HTTP clear is **serve-wire**, not a tool and not a new engine method.
- `dontAsk` never becomes `bypass`.
- BYOK is the product. Ads never touch BYOK. This route must not call `openNewSession` / `resolveIncludedAccess({ consumeCap: true })`.
- Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
- `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
- Leftover-ask still wins rewind. Parent-tree-stop stays on `/cancel`. Child unpaired leftover-ask refuse stays inside `clearKeepId`.
- No schema bump. v10 stays. Do **not** edit `packages/core/src/loop/session-engine.ts`.
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push.

### Plan rulings

1. **Locked envelope.** Success **200** `{ ok: true, notice: 'session cleared' }`. Failure **200** `{ ok: false, notice }` with the engine string (`clear persist failed`, `pending permission ask`, `session closed`, …). Not 204, not 202, not 4xx for persist-fail or leftover refuse. Echo `Response.json({ ok: result.ok, notice: result.notice })`.

2. **Engine method is the composition.** Serve calls `engine.clearKeepId()` only. Do not reimplement wipe. Do not call `openNewSession` / `close` / `mcpCloser` / `deleteSession` / `createSession` / `applyAskAnswer` / `store.clearConversation`.

3. **`ServeEngine.clearKeepId` is required** (not optional). `makeServeCtx` and `stubRuntime` must stub it or `serve.test.ts` will not typecheck.

4. **Body:** `req.text()` like cancel/pr. Empty / whitespace OK. `JSON.parse` throw → 400 `{ error: 'invalid json' }`. Parsed JSON ignored. Do not use `readJsonBody`. Parse after `loadSessionRuntime` (unknown session with garbage body is 404).

5. **Unknown session:** `loadSessionRuntime` 404, no mint. Do not call `ctx.createSession`.

6. **Do not `singleFlight` `/clear`.** Do not `abortCachedDescendants` / `whenTreeStop` on `/clear`. Mid-turn: await `clearKeepId`, not 202.

7. **Docs (Task 2) after code.** Spec Status → implemented (leave SHA blank until land). Keep-id OUT amendment only for this route. Historical K-wave text stays.

## File map

| File | Role |
|---|---|
| `packages/cli/src/serve.ts` | `SESSION_PATH` add `clear`; `ServeEngine.clearKeepId` required; POST handler; help line ~1088 |
| `packages/cli/src/serve.test.ts` | `makeServeCtx` / `stubRuntime` stubs; wire tests in `describe('handleServeRequest')` |
| `docs/headless.md` | add `/clear` bullet; drop “there is no POST /clear” |
| `ARCHITECTURE.md` / `ARCHITECTURE.ko.md` | serve list + `clearKeepId` sentence |
| `docs/superpowers/specs/2026-09-18-keep-id-clear.md` | OUT amendment only |
| `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md` | successor pointer |
| `CHANGELOG.md` | Unreleased |
| `docs/superpowers/specs/2026-09-20-http-post-clear.md` | Status after land |

### File overlap with leftover-ask (`serve.ts`)

Leftover-ask already owns `POST /v1/session/:id/resolve`, `applyAskAnswer`, `settleAsk`, and parked `permission_ask` on the stream — all in `packages/cli/src/serve.ts`. This door edits the **same file**: `SESSION_PATH` (add `clear` next to `resolve`), `ServeEngine`, and one new `action === 'clear'` branch beside cancel/compact/resolve/submit.

Do **not** touch the `/resolve` branch, `createServeAskHost`, or `publishParkedAsks`. Child leftover refuse is engine-side; HTTP 200s `{ ok: false, notice: 'pending permission ask' }`. Parent-tree-stop (`abortCachedDescendants` / `whenTreeStop`) stays on `/cancel` in this same file — `/clear` must not call those helpers.

---

### Task 1: Route + wire tests (C1)

**Files:**
- Modify: `packages/cli/src/serve.ts` (`SESSION_PATH` ~494, `ServeEngine` ~189–216, POST handler after compact/cancel ~697–747, fallthrough 404 ~929)
- Test: `packages/cli/src/serve.test.ts` (`makeServeCtx` ~215–343, `stubRuntime` ~2122–2134, new tests in `describe('handleServeRequest')`)

**Interfaces:**
- Consumes: `requireBearer`, `loadSessionRuntime`, `SessionEngine.clearKeepId` (already shipped; do not edit `session-engine.ts`)
- Produces: `POST /v1/session/:id/clear` → **200** `{ ok: boolean, notice: string }` after `await engine.clearKeepId()`

- [ ] **Step 1: Write the failing tests**

In `makeServeCtx` add clear-stub state next to `compactCalls` / `submitHold`. The engine object passed to `tapEngineEvents` must include required `clearKeepId`. Keep the existing abort/compact/submit behavior.

Replace the `state` object so it also holds:

```ts
clearCalls: number
clearResult: { ok: true; notice: string } | { ok: false; notice: string }
clearHold?: Promise<void>
clearWipe: boolean
```

Defaults: `clearCalls: 0`, `clearResult: { ok: true, notice: 'session cleared' }`, `clearWipe: true`.

On the engine object add:

```ts
async clearKeepId() {
  state.clearCalls += 1
  if (state.clearHold) await state.clearHold
  if (state.clearWipe && state.clearResult.ok) {
    const loaded = await store.loadSession(engine.session.id).catch(() => undefined)
    const inactivatedIds = loaded?.messages.map((msg) => msg.id) ?? []
    const session = loaded?.session ?? {
      id: engine.session.id,
      createdAt: 1,
      updatedAt: 1,
      cwd: '/tmp',
      model: 'dummy',
      permissionMode: 'default' as const,
      compactGeneration: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      funding: 'byok' as const,
    }
    await store.clearConversation({
      session: {
        ...session,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        todos: [],
      },
      inactivatedIds,
      generation: inactivatedIds.length > 0 ? session.compactGeneration + 1 : session.compactGeneration,
    })
  }
  return state.clearResult
},
```

Expose on the returned ctx (same getter/setter style as `submitHold`):

```ts
get clearCalls() {
  return state.clearCalls
},
set clearResult(value: { ok: true; notice: string } | { ok: false; notice: string }) {
  state.clearResult = value
},
set clearHold(value: Promise<void> | undefined) {
  state.clearHold = value
},
set clearWipe(value: boolean) {
  state.clearWipe = value
},
```

In `stubRuntime` add a no-op required method so `ServeEngine` still typechecks:

```ts
async clearKeepId() {
  return { ok: true as const, notice: 'session cleared' }
},
```

In `describe('handleServeRequest')`, after the existing cancel/compact Bearer test (~544), add:

```ts
test('POST /v1/session/:id/clear without Bearer is 401', async () => {
  const ctx = makeServeCtx()
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/clear', { method: 'POST' }),
    ctx,
  )
  expect(res.status).toBe(401)
  expect(await res.json()).toEqual({ error: 'unauthorized' })
  expect(ctx.clearCalls).toBe(0)
})

test('POST /v1/session/:id/clear wipes transcript, keeps id, 200 session cleared', async () => {
  const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
  const ctx = makeServeCtx(secret)
  const createCalls: string[] = []
  await ctx.store.createSession({
    id: 's1',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'dummy',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    title: 'old',
  })
  await ctx.store.appendStreamEvent('s1', { type: 'text_delta', text: 'keep?' })
  await ctx.store.upsertPendingAsk({
    callId: 'parked_clear',
    sessionId: 's1',
    kind: 'leftover',
    tool: 'Echo',
    message: 'Echo?',
    input: { text: 'hi' },
    createdAt: 1,
  } satisfies PendingAsk)
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/clear', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    }),
    {
      ...ctx,
      createSession: async (id) => {
        createCalls.push(id)
        return (await ctx.runtimeForSession('s1'))!
      },
    },
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, notice: 'session cleared' })
  expect(ctx.clearCalls).toBe(1)
  const runtime = await ctx.runtimeForSession('s1')
  expect(runtime?.engine.session.id).toBe('s1')
  expect(await ctx.store.lastStreamSeq('s1')).toBe(0)
  expect(await ctx.store.listPendingAsks('s1')).toEqual([])
  expect((await ctx.store.loadSession('s1')).session.id).toBe('s1')
  expect(createCalls).toEqual([])
  expect(ctx.abortCalls).toBe(0)
  expect(ctx.turnFlights.size).toBe(0)
})

test('POST /v1/session/:id/clear persist fail is 200 ok false', async () => {
  const ctx = makeServeCtx('t')
  ctx.clearResult = { ok: false, notice: 'clear persist failed' }
  ctx.clearWipe = false
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/clear', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
    }),
    ctx,
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: false, notice: 'clear persist failed' })
  expect(ctx.clearCalls).toBe(1)
})

test('POST /v1/session/:id/clear child leftover is 200 pending permission ask', async () => {
  const ctx = makeServeCtx('t')
  ctx.clearResult = { ok: false, notice: 'pending permission ask' }
  ctx.clearWipe = false
  const childAborts: Array<'cancel' | 'interrupt' | undefined> = []
  ctx.liveRuntimes = () => [
    [
      'child_clear',
      {
        engine: {
          abort(kind?: 'cancel' | 'interrupt') {
            childAborts.push(kind)
          },
          liveTurnId: () => 'child-live',
        },
      },
    ],
  ]
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/clear', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
    }),
    ctx,
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: false, notice: 'pending permission ask' })
  expect(ctx.clearCalls).toBe(1)
  expect(ctx.abortCalls).toBe(0)
  expect(childAborts).toEqual([])
})

test('POST /v1/session/:id/clear invalid JSON is 400; empty and extra keys are ok', async () => {
  const ctx = makeServeCtx('t')
  const bad = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/clear', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: '{',
    }),
    ctx,
  )
  expect(bad.status).toBe(400)
  expect(await bad.json()).toEqual({ error: 'invalid json' })
  expect(ctx.clearCalls).toBe(0)

  const empty = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/clear', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
    }),
    ctx,
  )
  expect(empty.status).toBe(200)
  expect(await empty.json()).toEqual({ ok: true, notice: 'session cleared' })

  const extra = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/clear', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: JSON.stringify({ turnId: 'x', text: 'nope' }),
    }),
    ctx,
  )
  expect(extra.status).toBe(200)
  expect(await extra.json()).toEqual({ ok: true, notice: 'session cleared' })
  expect(ctx.clearCalls).toBe(2)
})

test('POST /v1/session/:id/clear missing session is 404 and does not mint', async () => {
  const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
  const createCalls: string[] = []
  const ctx = makeServeCtx(secret)
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/missing/clear', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: '{',
    }),
    {
      ...ctx,
      createSession: async (id) => {
        createCalls.push(id)
        throw new Error('must not mint')
      },
    },
  )
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ error: 'not found' })
  expect(createCalls).toEqual([])
  expect(ctx.clearCalls).toBe(0)
})

test('POST /v1/session/:id/clear awaits clearKeepId and is not 202', async () => {
  const ctx = makeServeCtx('t')
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  ctx.clearHold = held
  const pending = handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/clear', {
      method: 'POST',
      headers: { authorization: 'Bearer t' },
    }),
    ctx,
  )
  let settled = false
  void pending.then(() => {
    settled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(ctx.turnFlights.size).toBe(0)
  release()
  const res = await pending
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, notice: 'session cleared' })
  expect(settled).toBe(true)
  expect(ctx.clearCalls).toBe(1)
})

test('GET /v1/session/:id/clear is 404', async () => {
  const ctx = makeServeCtx('t')
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/clear', {
      headers: { authorization: 'Bearer t' },
    }),
    ctx,
  )
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ error: 'not found' })
  expect(ctx.clearCalls).toBe(0)
})
```

If spreading `ctx` drops the `clearCalls` getter, read `clearCalls` from the original `ctx` (the tests above do that). Do not type-assert the liveRuntimes child engine as `ServeEngine` unless `tsc` requires it — the existing cancel cache-abort test already uses this partial shape.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/http-post-clear
bun test ./packages/cli/src/serve.test.ts
```

Expected: FAIL — `SESSION_PATH` does not match `/clear` (404 `{ error: 'not found' }` instead of 200/401/400); `makeServeCtx` engine may already include the stub after Step 1, but `handleServeRequest` does not call it. The 401 test fails if the path 404s before Bearer (Bearer is checked for any `SESSION_PATH` match — until `clear` is in the regex, missing Bearer is 404 not 401). That 401-vs-404 failure is the signal the route is missing.

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/serve.ts`:

1. `SESSION_PATH` — add `clear` to the action group:

```ts
const SESSION_PATH =
  /^\/v1\/session\/([^/]+)\/(stream|cancel|compact|resolve|submit|pr|followup|edit|diff|clear)$/
```

2. `ServeEngine` — required method (place with the other session ops, after `compactNow`):

```ts
clearKeepId: () => Promise<{ ok: true; notice: string } | { ok: false; notice: string }>
```

3. Handler — inside the `sessionRoute` block, after the compact branch (or immediately before the `return Response.json({ error: 'not found' }, { status: 404 })` at the end of that block):

```ts
if (req.method === 'POST' && action === 'clear') {
  const loaded = await loadSessionRuntime(ctx, sessionId)
  if (!loaded.ok) return loaded.res
  const raw = await req.text()
  if (raw.trim() !== '') {
    try {
      JSON.parse(raw)
    } catch {
      return Response.json({ error: 'invalid json' }, { status: 400 })
    }
  }
  const result = await loaded.runtime.engine.clearKeepId()
  return Response.json({ ok: result.ok, notice: result.notice })
}
```

Do **not** wrap in `singleFlight`. Do **not** call `abortCachedDescendants`, `whenTreeStop`, `ctx.createSession`, `openNewSession`, `close`, `mcpCloser`, `deleteSession`, `applyAskAnswer`, or `store.clearConversation`. Do not use `readJsonBody`. Do not return 202/204. Do not map `ok: false` to 4xx.

Leave the help printer for Task 2.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/http-post-clear
bun test ./packages/cli/src/serve.test.ts
```

Expected: PASS. Existing cancel / compact / submit / resolve / stream tests stay green. Do not run engine tests unless a type error forces a stub elsewhere — do not edit `session-engine.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve.ts packages/cli/src/serve.test.ts
git commit -m "$(cat <<'EOF'
feat: add POST /v1/session/:id/clear

Serve awaits engine.clearKeepId and returns 200 { ok, notice }.
Unknown session 404, no mint. Invalid JSON 400. Not 202/204.
EOF
)"
```

---

### Task 2: Help, ARCHITECTURE, keep-id OUT (C2)

**Files:**
- Modify: `packages/cli/src/serve.ts` (help ~1088)
- Modify: `docs/headless.md` (session-route list; last “there is no POST /clear” paragraph)
- Modify: `ARCHITECTURE.md` (serve list ~178–185; `clearKeepId()` bullet ~276)
- Modify: `ARCHITECTURE.ko.md` (serve list ~185–191; `clearKeepId` sentence ~280)
- Modify: `docs/superpowers/specs/2026-09-18-keep-id-clear.md` (ruling 12 / Do-not-build / Out — amendment only)
- Modify: `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md` (successor line)
- Modify: `CHANGELOG.md` Unreleased Added
- Modify: `docs/superpowers/specs/2026-09-20-http-post-clear.md` Status → implemented (SHA blank until land); board C1/C2 → done

**Interfaces:**
- Consumes: Task 1 route (already on the branch)
- Produces: docs and help that name `POST /v1/session/:id/clear` and the locked 200 `{ ok, notice }` envelope

- [ ] **Step 1: Amend pointers and help**

`runServe` help line:

```ts
process.stdout.write('POST /v1/session/:id/submit|/cancel|/compact|/resolve|/clear\n')
```

`docs/headless.md` — add a bullet with the other POSTs, and **replace** “There is no `POST /v1/session/:id/clear`. …”:

```
- `POST /v1/session/:id/clear` — no required body (empty OK; invalid JSON → 400 `{ error: 'invalid json' }`; parsed JSON ignored). Awaits `engine.clearKeepId()` (not 202). **200** `{ ok: true, notice: 'session cleared' }` or **200** `{ ok: false, notice }` with the engine string (`clear persist failed`, `pending permission ask`, `session closed`). Unknown session 404 (does not create). Same Bearer as other session routes. Spec: [`superpowers/specs/2026-09-20-http-post-clear.md`](superpowers/specs/2026-09-20-http-post-clear.md).
```

`ARCHITECTURE.md` serve list — add after compact (keep cancel/tree-stop wording unchanged):

```
- `POST /v1/session/:id/clear` — awaits `engine.clearKeepId()`. **200** `{ ok: true, notice: 'session cleared' }` or **200** `{ ok: false, notice }` (engine string as-is). Empty body OK; invalid JSON 400 `{ error: 'invalid json' }`. Unknown session 404; does not mint. Not 202/204. Not tree-stop (`/cancel` still owns `abortCachedDescendants` / `whenTreeStop`). Spec: [`2026-09-20-http-post-clear.md`](docs/superpowers/specs/2026-09-20-http-post-clear.md).
```

`clearKeepId()` bullet: drop “There is no `POST /v1/session/:id/clear` this horizon.” Replace with: serve `POST …/clear` calls this method; hosts must still not `openNewSession` / `close` / `mcpCloser` on this path.

`ARCHITECTURE.ko.md` — same two edits (serve list + `clearKeepId` sentence). Korean: `POST /v1/session/:id/clear`는 `engine.clearKeepId()`를 await하고 **200** `{ ok, notice }`를 돌려준다. persist 실패와 `pending permission ask`도 200이다. 없는 세션은 404 (생성하지 않음). tree-stop은 `/cancel`에 남긴다.

Keep-id spec `2026-09-18-keep-id-clear.md`:

- After the Status/Shipped header, add: `HTTP POST /v1/session/:id/clear` is unparked by [`2026-09-20-http-post-clear.md`](2026-09-20-http-post-clear.md) only. Wipe/keep table and engine method are unchanged.
- Ruling 12 historical text stays. Add one line: **Amended:** serve now has `POST /v1/session/:id/clear`; it must call `engine.clearKeepId()` and must not mint.
- Do-not-build / Out-of-horizon: keep the historical `POST /v1/session/:id/clear` bullet and suffix `(amended by 2026-09-20-http-post-clear.md)`. Do not rewrite K1–K4.

Remaining-roadmap: on the implemented-successor sentence that ends at parent tree-stop, append HTTP `POST …/clear` (**spec**) `2026-09-20-http-post-clear.md`. Do not rewrite shipped waves.

`CHANGELOG.md` Unreleased Added (top of the list):

```
- HTTP `POST /v1/session/:id/clear` awaits `engine.clearKeepId()` and returns **200** `{ ok, notice }` (`session cleared` / `clear persist failed` / `pending permission ask`). Unknown session 404, no mint. Schema stays **v10**. Spec: [docs/superpowers/specs/2026-09-20-http-post-clear.md](docs/superpowers/specs/2026-09-20-http-post-clear.md).
```

This spec: Status → `implemented` on this branch (SHA blank until land). Board C1.1–C2.1 → **done**.

Do not edit `SLASH_COMMANDS.md` (TUI `/clear` already keep-id). Do not claim ACP/Slack/Discord grew a clear route.

- [ ] **Step 2: Commit**

```bash
git add packages/cli/src/serve.ts docs/headless.md ARCHITECTURE.md ARCHITECTURE.ko.md docs/superpowers/specs/2026-09-18-keep-id-clear.md docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md docs/superpowers/specs/2026-09-20-http-post-clear.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: point serve and keep-id OUT at POST /clear

Help, headless, and ARCHITECTURE list the route. Keep-id ruling 12
is amended only; wipe/keep table stays. Schema stays v10.
EOF
)"
```

---

## Verify

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/http-post-clear
bun test ./packages/cli/src/serve.test.ts
```

Do not push. Do not merge to main. Do not edit `session-engine.ts`. Do not implement ACP/Slack/Discord/exec clear. Do not bump schema.

## Self-review

1. **Spec coverage:** C1.1/C1.2 → Task 1. C2.1 / keep-id OUT / remaining-roadmap / CHANGELOG / help / headless / ARCHITECTURE → Task 2. Envelope, body, 404-no-mint, no singleFlight, no tree-stop, mid-turn await, no engine edit — Task 1 rulings + tests.
2. **Placeholder scan:** none. Tests are concrete `serve.test.ts` cases. Commits are HEREDOC.
3. **Type consistency:** `ServeEngine.clearKeepId(): Promise<{ ok: true; notice: string } | { ok: false; notice: string }>` matches `SessionEngine.clearKeepId`. Handler returns `{ ok: result.ok, notice: result.notice }`. Locked happy-path notice is `session cleared`.
