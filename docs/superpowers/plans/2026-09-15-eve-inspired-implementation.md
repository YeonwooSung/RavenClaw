# Eve-inspired next horizon — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make leftover-ask survive process death, make Docker apply to files as well as Bash, and give `raven serve` a stream + ask-resolve contract — without a second loop or an eve compiler.

**Architecture:** Keep one `queryLoop` and persist-before-execute. An open leftover-ask is a `pending_asks` row (schema v5), not RAM. After a crash, hosts call `replayPendingAsks` / `applyAskAnswer` — they do **not** `submitMessage` to finish the parked tool. `resumeSession` treats pending `callId`s as paired-for-resume. File tools share the Bash docker bind (`-v cwd:cwd`) via `WorkspaceFs` (v1 = host path jail under cwd). Compact generalizes the tool-result budget and queues `/compact` until `liveTurn` is null. Serve keeps `POST /v1/turn` as dontAsk one-shot; new session routes do not force `dontAsk`.

**Tech Stack:** Bun, TypeScript, SQLite WAL (`applyMigrations`), existing `SessionStore`, `StreamEvent`, Slack/Discord `singleFlight`, `terminal-backend.ts`.

**Spec:** `docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md`

## Global Constraints

Copied from the spec, plus the rulings this plan locks.

- One `queryLoop`. Every host (Ink, OpenTUI, exec, ACP, serve, Slack, Discord, later HTTP) only calls `submitMessage` **for new user text**.
- Default prefix stays small and frozen. No new always-on tool unless the spec says so.
- `dontAsk` never becomes `bypass`. Headless Bash needs a project rule or a sandbox that **actually applies**.
- BYOK is the product. Ads never touch BYOK.
- Clean-room. Steal semantics. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**.
- Slack HMAC is **not** a requirement (Socket Mode). Identity is the trusted socket/gateway, never a JSON `userId` / `principalId` the body claims.
- Persist-before-execute and pairing 1:1 stay law. Do not copy eve execute-then-persist.
- Targeted `bun test <file>` only. Never full-repo `bun test`.
- Commits only on a feature branch unless the user says otherwise.

### Plan rulings (amend the spec where they disagree)

These are binding for implementers. The spec stays the product authority; these lines resolve underspecification.

1. **One row per `call_id`.** Spec E1.1’s `{ sessionId, callIds, … }` batch is stolen as `listPendingAsks(sessionId)`. Extra columns (`tool`, `message`, `input`, `saveAs`) exist so a dead process can re-render the ask.
2. **`requestId` = `permission_ask.id` = `PendingAsk.callId`.** Slack button `value` is that `callId`, not the tool name.
3. **`resolvePendingAsk` / `applyAskAnswer` is the only non-`submitMessage` host entry.** It only completes an existing `pending_asks.call_id`. It does not start a model turn.
4. **Do not add `ignored`.** Unmatched *answers* (`applyAskAnswer` on an unknown `callId`) return `'unmatched'` and are re-queued by the host. Unmatched *open asks* are denied only by explicit deny, `/steer` abort, or `applyAskAnswer(..., 'deny')`. A casual next message does **not** dismiss an approval.
5. **`submitMessage` while `listPendingAsks` is nonempty** yields `{ type: 'status', message: 'pending permission ask' }` and returns `{ reason: 'completed' }` without appending a user row. Hosts keep the text in their existing queue.
6. **`resumeSession` does not throw** when the only unpaired `tool_use` ids are pending-ask `callId`s. Other unpaired ids still throw.
7. **`prepareContext` must pass the pending set into `repairRoleAlternation`.** Otherwise the next round writes `incomplete` and kills the park.
8. **Delete a pending row only after a real `tool` result is persisted** (execute output, deny, or abort). `askUser` throw / kill -9 leaves the row. Do **not** wrap delete in `finally`.
9. **Slack/Discord must not timer-deny a durable row.** Drop the 120s deny for rows that exist in `pending_asks`. In-process waiter may stop; the row remains for replay.
10. **`POST /v1/turn` stays dontAsk one-shot.** New `/v1/session/:id/*` routes use an engine that does **not** force `dontAsk`. v1 stream is a live tail — no `?after=` cursor (`StreamEvent` has no seq).
11. **Write unread/stale applies only when the target exists.** Copying Edit’s always-`wasRead` would break new-file Write.
12. **Docker file v1 = cwd bind is the mount.** `WorkspaceFs` jails paths under `cwd` on the host bind (`-v cwd:cwd`). That is not a second copy of the tree and not docker-exec I/O. Grep/Glob stay host `rg`/walk **inside that jail**. NotebookEdit is out of E2.1.
13. **`/compact` while `liveTurn !== null` sets a one-slot flag and runs after the turn.** Do not reuse `bindDrainQueued` (that injects user text). There is no `isBusy()`.
14. **Compaction-prompt envelope:** `COMPACTION_PROMPT_TOKENS = 1024`. Treat as compact when `estimatedTokens + 1024 >= compactThreshold(...)` (same for `anchoredTokens` when set).
15. **E3.1 optional todos restore-note is out of this plan.**
16. **E4.2 path is identity:** `packages/core/src/eval/fixtures/<name>/` with `case.json` (no authored `id`). No LLM-as-judge.
17. **TUI delivery default matches the tree:** busy composer queues; `/steer` aborts. Slack/Discord/serve stay `singleFlight` queue. `turnPolicy` is explicit on object submits; `queryLoop` ignores it.
18. **Function name is `executeOneCall`**, not `executeCall`. Assistant id for `withheldAssistantId` is `state.assistantMessage?.id`.

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/migrations/005_pending_asks.sql` | `pending_asks` table |
| `packages/core/src/session/schema.ts` | register migration v5 (`PENDING_ASKS_SQL`) |
| `packages/core/src/session/schema.test.ts` | fresh db v5; v4→v5 keeps `deliveries` |
| `packages/core/src/session/sqlite-store.test.ts` | `schema_version` 5 pin |
| `packages/core/src/session/deliveries.test.ts` | `schema_version` 5 pin |
| `packages/core/src/session/pending-asks.ts` | db helpers (private to store) |
| `packages/core/src/session/pending-asks.test.ts` | upsert/list/delete |
| `packages/core/src/session/sqlite-store.ts` | store methods; `loadSession` passes pending ids; `deleteSession` drops rows |
| `packages/core/src/session/memory-store.ts` | in-memory pending map; same `loadSession` contract |
| `packages/core/src/session/resume.ts` | skip throw for pending `callId`s |
| `packages/core/src/session/resume.test.ts` | pending unpaired does not throw |
| `packages/core/src/types.ts` | `SessionStore` methods, `UserSubmitInput.turnPolicy`, `permission_ask.childSessionId`, `Turn.terminalBackend`, `SessionEngine.replayPendingAsks` / `applyAskAnswer` |
| `packages/core/src/types.test.ts` | dummy `SessionStore` gains the three methods |
| `packages/core/src/loop/repair.ts` | `repairRoleAlternation(messages, openCallIds?)` |
| `packages/core/src/loop/repair.test.ts` | skip `incomplete` when id is pending |
| `packages/core/src/loop/phases.ts` | `executeOneCall` upsert before `askUser`; `prepareContext` passes pending set |
| `packages/core/src/loop/session-engine.ts` | `applyAskAnswer`, `replayPendingAsks`, pending-guard on `submitMessage`, queued `compactNow` |
| `packages/core/src/loop/query-loop.test.ts` | live park + crash resolve + submit-while-pending |
| `packages/core/src/index.ts` | export pending-ask types + `createWorkspaceFs` |
| `packages/cli/src/app.tsx` | resume → `replayPendingAsks` |
| `packages/cli/src/opentui-app.ts` | same |
| `packages/cli/src/chat-host/session-host.ts` | Slack/Discord attach → replay |
| `packages/cli/src/slack/adapter.ts` | button `value` = `callId`; no timer-deny of a row |
| `packages/cli/src/discord/adapter.ts` | no timer-deny of a row |
| `packages/cli/src/engine.ts` | set `turn.terminalBackend`; resume already goes through `resumeSession` |
| `packages/core/src/tools/write.ts` | exists → wasRead → stale → write → `markReadPath` |
| `packages/core/src/tools/read-files.ts` | export `wasRead`; stat via `WorkspaceFs` when Task 10 lands |
| `packages/core/src/tools/workspace-fs.ts` | local vs docker-v1 cwd jail |
| `packages/core/src/tools/read.ts`, `edit.ts`, `list-dir.ts`, `apply-patch.ts`, `read-subtree.ts` | I/O through `WorkspaceFs` |
| `packages/core/src/tools/grep.ts`, `glob.ts` | path jail under cwd only (host `rg`/walk) |
| `packages/core/src/compact/prune.ts` | all-tool budget, head+tail |
| `packages/core/src/compact/policy.ts` | `COMPACTION_PROMPT_TOKENS` |
| `packages/core/src/compact/prune.test.ts` | flip “does not stub huge Read” |
| `packages/core/src/compact/maybe-compact.test.ts` | MEMORY system snapshot regression |
| `packages/cli/src/permission-dialog.tsx` | label `child <id>` |
| `packages/cli/src/serve.ts` | extract `handleServeRequest`; session stream/resolve/cancel/compact |
| `packages/core/src/gateway/http.ts` | parsers only (`parseResolveBody`) |
| `packages/cli/src/serve.test.ts` | 401, stream `permission_ask`, resolve |
| `packages/core/src/eval/` | fixture runner + `pending-ask-persist` |
| `packages/cli/src/args.ts`, `index.ts`, `help.ts`, `completions.ts` | `raven eval` |
| `docs/headless.md` | serve bind/token; docker file jail; turnPolicy |

## Wave order

Do not start host resume (Tasks 4–5) or serve resolve (Task 14) before Task 3 is green. Task 7 (auth pins) and Task 8 (Write) may run in parallel after Task 3. Task 10 needs Task 9. Task 12 is a test-only slice and may run anytime after Task 1.

```
Task 1 schema → Task 2 store/repair → Task 3 engine resolve
Task 3 → Task 4 TUI replay
Task 3 → Task 5 Slack/Discord replay
Task 3 → Task 14 serve stream/resolve
Task 6 turnPolicy  (after Task 5 types exist; can follow Task 2)
Task 7 auth pins   (parallel with Task 8)
Task 8 Write check → Task 9 WorkspaceFs → Task 10 wire file tools
Task 11 compact budget + queue
Task 12 MEMORY test
Task 13 childSessionId
Task 15 raven eval (last; locks Task 3)
```

---

### Task 1: `pending_asks` schema v5

**Files:**
- Create: `packages/core/src/migrations/005_pending_asks.sql`
- Modify: `packages/core/src/session/schema.ts` (private `MIGRATIONS` array — it is **not** exported)
- Test: `packages/core/src/session/schema.test.ts`
- Also update version pins: `packages/core/src/session/sqlite-store.test.ts` (`fresh install uses WAL and schema_version 4` → `5`), `packages/core/src/session/deliveries.test.ts` (`migrates to schema 4` → `5`)

**Interfaces:**
- Consumes: `applyMigrations`, exported `INIT_SQL` / `FTS5_SQL` / `AGENT_MAIL_SQL` / `DELIVERIES_SQL`
- Produces: schema_version `5`, table `pending_asks`

- [ ] **Step 1: Write the failing test**

In `schema.test.ts` keep the existing cases; change “version 4” titles and expectations to **5**. Add:

```ts
test('fresh db reaches schema_version 5 with pending_asks', () => {
  const db = new Database(':memory:')
  applyMigrations(db)
  const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string
  }
  expect(version.value).toBe('5')
  const names = (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((row) => row.name)
  expect(names).toContain('pending_asks')
  expect(names).toContain('deliveries')
  db.close()
})

test('v4 database upgrades to v5 without dropping deliveries', () => {
  const db = new Database(':memory:')
  db.exec(INIT_SQL)
  db.exec(FTS5_SQL)
  db.exec(AGENT_MAIL_SQL)
  db.exec(DELIVERIES_SQL)
  db.query(
    "INSERT INTO meta (key, value) VALUES ('schema_version', '4') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run()
  db.query("INSERT INTO deliveries (id, source, seen_at) VALUES ('discord:abc', 'discord', 1)").run()
  applyMigrations(db)
  const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string
  }
  expect(version.value).toBe('5')
  const kept = db.query("SELECT id FROM deliveries WHERE id = 'discord:abc'").get() as {
    id: string
  } | null
  expect(kept?.id).toBe('discord:abc')
  expect(
    db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_asks'").get(),
  ).toBeTruthy()
  db.close()
})
```

Do **not** `applyMigrations` to v5 then `DROP TABLE` to fake a v4 db.

- [ ] **Step 2: Run and confirm fail**

Run: `bun test packages/core/src/session/schema.test.ts`  
Expected: FAIL — version is still `4`, no `pending_asks`, `INIT_SQL` import unused if you added it early.

- [ ] **Step 3: Implement**

`packages/core/src/migrations/005_pending_asks.sql`:

```sql
CREATE TABLE IF NOT EXISTS pending_asks (
  call_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT NOT NULL,
  message TEXT NOT NULL,
  input_json TEXT,
  save_as TEXT,
  withheld_assistant_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_asks_session ON pending_asks(session_id);
```

In `schema.ts`, same `readFileSync(join(import.meta.dir, '../migrations/005_pending_asks.sql'))` pattern as v4. Append `{ version: 5, sql: PENDING_ASKS_SQL }` to the private `MIGRATIONS` array. Export `PENDING_ASKS_SQL` like the other SQL constants.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/session/schema.test.ts packages/core/src/session/sqlite-store.test.ts packages/core/src/session/deliveries.test.ts`  
Expected: PASS after the v4→v5 pin updates.

- [ ] **Step 5: Commit** (feature branch only)

```bash
git add packages/core/src/migrations/005_pending_asks.sql packages/core/src/session/schema.ts packages/core/src/session/schema.test.ts packages/core/src/session/sqlite-store.test.ts packages/core/src/session/deliveries.test.ts
git commit -m "feat: add pending_asks schema v5"
```

---

### Task 2: Store API + repair skips open asks

**Files:**
- Create: `packages/core/src/session/pending-asks.ts`, `packages/core/src/session/pending-asks.test.ts`
- Modify: `packages/core/src/session/sqlite-store.ts`, `packages/core/src/session/memory-store.ts`, `packages/core/src/types.ts` (`SessionStore`), `packages/core/src/types.test.ts` (dummy store), `packages/core/src/loop/repair.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/session/pending-asks.test.ts`, `packages/core/src/loop/repair.test.ts`

**Interfaces:**
- Consumes: v5 table
- Produces (lock these names; later tasks call **only** the store methods):

```ts
export type PendingAskKind = 'leftover' | 'ask_user'

export type PendingAsk = {
  callId: string
  sessionId: string
  kind: PendingAskKind
  tool: string
  message: string
  input: unknown
  saveAs?: PermissionScope
  withheldAssistantId?: string
  createdAt: number
}

export type PendingAskAnswer = 'allow' | 'deny' | 'allow_always'

// pending-asks.ts — db helpers, not part of SessionStore
export function upsertPendingAskRow(db: Database, row: PendingAsk): void
export function listPendingAskRows(db: Database, sessionId: string): PendingAsk[]
export function getPendingAskRow(db: Database, callId: string): PendingAsk | undefined
export function deletePendingAskRow(db: Database, callId: string): void

// SessionStore — required methods (update the dummy in types.test.ts)
upsertPendingAsk(row: PendingAsk): Promise<void>
listPendingAsks(sessionId: string): Promise<PendingAsk[]>
getPendingAsk(callId: string): Promise<PendingAsk | undefined>
deletePendingAsk(callId: string): Promise<void>
```

`repairRoleAlternation(messages: Message[], openCallIds?: Set<string>): Message[]`  
`flushUnpaired` does **not** insert `INCOMPLETE_TEXT` for `block.id` in `openCallIds`. Existing one-arg callers stay valid (`agent/definition.ts` included).

`loadSession` (sqlite + memory): `const open = await store.listPendingAsks(sessionId)` then `repairRoleAlternation(active, new Set(open.map((r) => r.callId)))`.  
`deleteSession` also deletes `pending_asks` for that `session_id` (memory store: drop the map entries).

- [ ] **Step 1: Failing tests**

`pending-asks.test.ts`:

```ts
test('upsert and list pending asks by session', async () => {
  const db = new Database(':memory:')
  applyMigrations(db)
  upsertPendingAskRow(db, {
    callId: 'call_1',
    sessionId: 's1',
    kind: 'leftover',
    tool: 'Bash',
    message: 'Run this command?',
    input: { command: 'ls' },
    createdAt: 1,
  })
  expect(listPendingAskRows(db, 's1')).toHaveLength(1)
  expect(listPendingAskRows(db, 's2')).toHaveLength(0)
  deletePendingAskRow(db, 'call_1')
  expect(listPendingAskRows(db, 's1')).toHaveLength(0)
})
```

In `repair.test.ts` (reuse existing `assistant` / `tool` helpers — there is no `assistantWithToolUse`):

```ts
test('repairRoleAlternation leaves unpaired tool_use when call is a pending ask', () => {
  const input = [
    user('u1', 'run'),
    assistant('a1', [{ type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'hi' } }]),
  ]
  const out = repairRoleAlternation(input, new Set(['call_1']))
  expect(out.some((m) => m.role === 'tool')).toBe(false)
  expect(out).toHaveLength(2)
})

test('repairRoleAlternation still inserts incomplete when not pending', () => {
  const input = [
    user('u1', 'run'),
    assistant('a1', [{ type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'hi' } }]),
  ]
  const out = repairRoleAlternation(input)
  const last = out.at(-1)
  expect(last?.role).toBe('tool')
  if (last?.role === 'tool') {
    expect(last.toolUseId).toBe('call_1')
    expect(last.blocks[0]?.text).toBe(INCOMPLETE_TEXT)
  }
})
```

- [ ] **Step 2: Run fail**

Run: `bun test packages/core/src/session/pending-asks.test.ts packages/core/src/loop/repair.test.ts`  
Expected: FAIL — module missing / second arg ignored.

- [ ] **Step 3: Implement**

Thread `openCallIds` into `flushUnpaired`. Wire sqlite helpers through `SessionStore`. Memory store keeps `Map<string, PendingAsk>` keyed by `callId`. Export `PendingAsk` / `PendingAskAnswer` from `packages/core/src/index.ts`.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/session/pending-asks.test.ts packages/core/src/loop/repair.test.ts packages/core/src/session/sqlite-store.test.ts packages/core/src/types.test.ts`  
Expected: PASS. Existing “resume of unpaired tool_use inserts incomplete” still passes when **no** pending row exists.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/pending-asks.ts packages/core/src/session/pending-asks.test.ts packages/core/src/session/sqlite-store.ts packages/core/src/session/memory-store.ts packages/core/src/types.ts packages/core/src/types.test.ts packages/core/src/loop/repair.ts packages/core/src/loop/repair.test.ts packages/core/src/index.ts
git commit -m "feat: persist pending asks and skip incomplete repair"
```

---

### Task 3: Write the row, settle it, fix resume

This is the E1.1 engine. Hosts are Tasks 4–5.

**Files:**
- Modify: `packages/core/src/loop/phases.ts` (`executeOneCall` ~1227, `prepareContext` ~265), `packages/core/src/loop/session-engine.ts`, `packages/core/src/session/resume.ts`, `packages/core/src/types.ts` (`SessionEngine`)
- Test: `packages/core/src/loop/query-loop.test.ts`, `packages/core/src/session/resume.test.ts`

**Interfaces:**
- Consumes: `store.upsertPendingAsk` / `listPendingAsks` / `getPendingAsk` / `deletePendingAsk`
- Produces:

```ts
// SessionEngine
applyAskAnswer(
  callId: string,
  answer: PendingAskAnswer,
): Promise<'matched' | 'unmatched'>
replayPendingAsks(): AsyncGenerator<StreamEvent, void>
```

`applyAskAnswer` algorithm:

1. `const row = await store.getPendingAsk(callId)`. If missing or `row.sessionId !== engine.session.id`, return `'unmatched'`.
2. `'deny'`: `persistToolResults([makeToolMessage(callId, false, denyText(row.message))])`, then `deletePendingAsk(callId)`, return `'matched'`.
3. `'allow_always'`: existing `persistAllowAlways` using `row.saveAs ?? 'session'`, then fall through to allow.
4. `'allow'`: look up `tools` by `row.tool`, `parse(row.input)`, `execute` with a `ToolContext` built from `session.cwd` / `session.id` (new `Turn` with empty `readFiles`), `persistToolResults` of the execute output (or `executeFailedText` on throw), then `deletePendingAsk`. Return `'matched'`.
5. Do **not** call the model.

`replayPendingAsks`: `for (const row of await store.listPendingAsks(session.id))` yield a `permission_ask` built from the row (`id: row.callId`), `await askUser(event, abort.signal)`, `await applyAskAnswer(row.callId, answer)`.

`executeOneCall` (live path), when `decision.behavior === 'ask'`, **after** `persistToolCalls` already happened in `runToolRound` and **before** `await state.askUser`:

```ts
await state.store.upsertPendingAsk({
  callId: call.id,
  sessionId: state.turn.sessionId,
  kind: tool.name === 'AskUser' ? 'ask_user' : 'leftover',
  tool: tool.name,
  message: decision.message ?? '',
  input: call.input,
  saveAs: decision.saveAs,
  withheldAssistantId: state.assistantMessage?.id,
  createdAt: Date.now(),
})
```

On deny / allow / abort that **persists** a `tool` row, `await state.store.deletePendingAsk(call.id)` **after** that persist. If `askUser` throws and you persist `pairMissing(..., 'aborted')`, delete the row (pairing is closed). If you persist nothing, leave the row.

`prepareContext`:

```ts
const open = await state.store.listPendingAsks(state.turn.sessionId)
const repaired = repairRoleAlternation(
  state.turn.messages,
  new Set(open.map((row) => row.callId)),
)
```

`resumeSession`:

```ts
const loaded = await store.loadSession(sessionId)
const pending = await store.listPendingAsks(sessionId)
const pendingIds = new Set(pending.map((row) => row.callId))
const unpaired = unpairedToolUseIds(loaded.messages).filter((id) => !pendingIds.has(id))
if (unpaired.length > 0) {
  throw new Error(`resumeSession: unpaired tool_use: ${unpaired.join(', ')}`)
}
return loaded
```

`submitMessage`: if `(await store.listPendingAsks(session.id)).length > 0`, `yield { type: 'status', message: 'pending permission ask' }` and `return { reason: 'completed' }` — no new user row.

- [ ] **Step 1: Failing tests**

Add this helper next to `createEcho` in `query-loop.test.ts`:

```ts
function createAskEcho(): ReturnType<typeof createEcho> {
  const echo = createEcho()
  echo.checkPermissions = async () => ({ behavior: 'ask', message: 'Echo?' })
  return echo
}
```

```ts
test('leftover-ask writes a pending row before askUser resolves', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_park' })
  await store.createSession(session)
  let release!: (v: 'allow' | 'deny' | 'allow_always') => void
  const held = new Promise<'allow' | 'deny' | 'allow_always'>((resolve) => {
    release = resolve
  })
  const echo = createAskEcho()
  const provider = createFakeProvider([
    toolThenStop('call_park', 'Echo', { text: 'hi' }),
    textThenStop('done'),
  ])
  const engine = createSessionEngine({
    ...engineOpts({ provider, store, session, tools: [echo] }),
    askUser: async () => held,
  })
  const gen = engine.submitMessage('go')
  const events: StreamEvent[] = []
  const first = await gen.next()
  events.push(first.value as StreamEvent)
  while (events.every((e) => e.type !== 'permission_ask')) {
    const next = await gen.next()
    if (next.done) break
    events.push(next.value)
  }
  expect(await store.listPendingAsks(session.id)).toHaveLength(1)
  expect((await store.listPendingAsks(session.id))[0]?.callId).toBe('call_park')
  release('deny')
  await gen.next() // drain
})

test('loadSession after pending row does not insert incomplete', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_crash' })
  await store.createSession(session)
  await store.persistUser(session.id, {
    id: 'u1',
    role: 'user',
    blocks: [{ type: 'text', text: 'go' }],
    createdAt: 1,
  })
  await store.persistToolCalls(session.id, {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'call_1', name: 'Echo', input: { text: 'hi' } }],
    createdAt: 2,
  })
  await store.upsertPendingAsk({
    callId: 'call_1',
    sessionId: session.id,
    kind: 'leftover',
    tool: 'Echo',
    message: 'Echo?',
    input: { text: 'hi' },
    createdAt: 3,
  })
  const loaded = await store.loadSession(session.id)
  expect(loaded.messages.some((m) => m.role === 'tool')).toBe(false)
  await expect(resumeSession(store, session.id)).resolves.toBeTruthy()
})

test('applyAskAnswer deny persists permission_denied and deletes the row', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_deny' })
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
  const engine = createSessionEngine(
    engineOpts({
      provider: createFakeProvider([textThenStop('nope')]),
      store,
      session,
      tools: [echo],
    }),
  )
  expect(await engine.applyAskAnswer('call_1', 'deny')).toBe('matched')
  expect(await engine.applyAskAnswer('missing', 'deny')).toBe('unmatched')
  expect(await store.listPendingAsks(session.id)).toHaveLength(0)
  const loaded = await store.loadSession(session.id)
  const toolRow = loaded.messages.find((m) => m.role === 'tool')
  expect(toolRow?.ok).toBe(false)
  expect(toolRow && toolRow.role === 'tool' ? toolRow.blocks[0]?.text : '').toContain(
    'permission_denied',
  )
  expect(echo.executeCount).toBe(0)
})

test('applyAskAnswer allow executes the tool and pairs', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_allow' })
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
  const engine = createSessionEngine(
    engineOpts({
      provider: createFakeProvider([textThenStop('nope')]),
      store,
      session,
      tools: [echo],
    }),
  )
  expect(await engine.applyAskAnswer('call_1', 'allow')).toBe('matched')
  expect(echo.executeCount).toBe(1)
  expect(await store.listPendingAsks(session.id)).toHaveLength(0)
})

test('submitMessage while a pending ask exists does not append a user row', async () => {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_block' })
  await store.createSession(session)
  await store.upsertPendingAsk({
    callId: 'call_1',
    sessionId: session.id,
    kind: 'leftover',
    tool: 'Echo',
    message: 'Echo?',
    input: { text: 'hi' },
    createdAt: 1,
  })
  const engine = createSessionEngine(
    engineOpts({
      provider: createFakeProvider([textThenStop('nope')]),
      store,
      session,
    }),
  )
  const { events, result } = await collect(engine.submitMessage('hello anyway'))
  expect(result).toEqual({ reason: 'completed' })
  expect(events.some((e) => e.type === 'status' && e.message.includes('pending'))).toBe(true)
  const loaded = await store.loadSession(session.id)
  expect(loaded.messages.filter((m) => m.role === 'user')).toHaveLength(0)
})
```

In `resume.test.ts`, keep `'asserts pairing after loadSession'` (no pending methods → still throws). Add a case whose fake store returns unpaired `tool_use` **and** `listPendingAsks` = `[{ callId: 'c1', ... }]` → `resumeSession` resolves.

Keep existing `'7. resume of unpaired tool_use inserts incomplete and never executes'` — no pending row.

- [ ] **Step 2: Run fail**

Run: `bun test packages/core/src/loop/query-loop.test.ts packages/core/src/session/resume.test.ts`  
Expected: FAIL — `applyAskAnswer` missing; `resumeSession` still throws on unpaired.

- [ ] **Step 3: Implement** the algorithms in Interfaces. Do not add `ignored`. Do not start a model turn from `applyAskAnswer`.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/loop/query-loop.test.ts packages/core/src/session/resume.test.ts packages/core/src/permissions/pipeline.loop.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop/phases.ts packages/core/src/loop/session-engine.ts packages/core/src/session/resume.ts packages/core/src/types.ts packages/core/src/loop/query-loop.test.ts packages/core/src/session/resume.test.ts
git commit -m "feat: park leftover-ask rows and settle them without a new turn"
```

---

### Task 4: TUI / OpenTUI replay pending asks

**Files:**
- Modify: `packages/cli/src/app.tsx`, `packages/cli/src/opentui-app.ts`, `packages/cli/src/engine.ts` (only if resume attach needs a hook)
- Test: `packages/cli/src/app.test.ts` and/or `packages/cli/src/opentui-app.test.ts`

**Interfaces:**
- Consumes: `engine.replayPendingAsks()`, `resumeRuntime` → `resumeSession` (Task 3)
- Produces: after `resumeRuntime` / first paint, if `listPendingAsks` nonempty, `for await (const ev of engine.replayPendingAsks())` — the existing `ask.bind` in `app.tsx` (`askRef` / `setAsk`) receives `permission_ask` the same way a live turn does. Do **not** call `submitMessage` to show the ask.

- [ ] **Step 1: Failing test**

```ts
test('resume with a pending row replays permission_ask without submitMessage', async () => {
  const asks: string[] = []
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_tui' })
  await store.createSession(session)
  await store.upsertPendingAsk({
    callId: 'call_1',
    sessionId: session.id,
    kind: 'leftover',
    tool: 'Bash',
    message: 'Run ls?',
    input: { command: 'ls' },
    createdAt: 1,
  })
  const engine = createSessionEngine({
    ...engineOpts({
      provider: createFakeProvider([]),
      store,
      session,
    }),
    askUser: async (event) => {
      asks.push(event.id)
      return 'deny'
    },
  })
  const events: StreamEvent[] = []
  for await (const ev of engine.replayPendingAsks()) events.push(ev)
  expect(asks).toEqual(['call_1'])
  expect(events.some((e) => e.type === 'permission_ask' && e.id === 'call_1')).toBe(true)
  expect(await store.listPendingAsks(session.id)).toHaveLength(0)
})
```

If the TUI test harness cannot boot Ink, put this test in `packages/core/src/loop/session-engine.test.ts` (the file exists) and in the TUI file only assert that the resume path **calls** `replayPendingAsks` (spy on the fake engine used by `opentui-app.test.ts`, which already injects `resumeRuntime`).

- [ ] **Step 2: Run fail**

Run: `bun test packages/core/src/loop/session-engine.test.ts packages/cli/src/opentui-app.test.ts`  
Expected: FAIL — resume path never calls `replayPendingAsks`.

- [ ] **Step 3: Implement**

After a successful `resumeRuntime` in Ink `app.tsx` and `opentui-app.ts`, drain `replayPendingAsks` through the same event renderer as a live turn. Wire `ask.bind` **before** the replay so the existing permission dialog opens.

- [ ] **Step 4: Re-run** those two files. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: replay leftover-ask on TUI resume"
```

---

### Task 5: Slack / Discord replay, callId buttons, no timer-deny

**Files:**
- Modify: `packages/cli/src/slack/adapter.ts`, `packages/cli/src/discord/adapter.ts`, `packages/cli/src/chat-host/session-host.ts`
- Test: `packages/cli/src/slack/adapter.test.ts`, `packages/cli/src/discord/adapter.test.ts`, `packages/cli/src/chat-host/session-host.test.ts`

**Interfaces:**
- Consumes: `replayPendingAsks`, `applyAskAnswer`
- Produces: attach/open session → `replayPendingAsks`. Slack `permissionBlocks` button `value` is `event.id` (the `callId`). `tryResolvePermit` matches `inbound.actionValue === pending.callId` **or** `raven_allow` / `raven_deny` against the permit that holds that `callId`. **Do not** `setTimeout(..., 120_000)` deny when `getPendingAsk` is defined — omit the timer, or on fire only drop the in-process waiter (do not `resolve('deny')` if the row still exists). Discord: same — no timer deny of a durable row. Non-allow/deny text does **not** call `submitMessage` while a pending row exists (stash one inbound text; after settle, `singleFlight` may submit it).

- [ ] **Step 1: Failing tests**

```ts
test('slack allow button value is the call id', () => {
  const blocks = permissionBlocks('call_1', 'Bash', 'Allow Bash?')
  const actions = (blocks[1] as { elements: Array<{ value: string; action_id: string }> }).elements
  expect(actions[0]?.value).toBe('call_1')
  expect(actions[0]?.action_id).toBe('raven_allow')
})

test('slack does not deny a durable pending row on timer', async () => {
  // Construct adapter with permissionTimeoutMs: 5.
  // Seed store.upsertPendingAsk for the session.
  // Start askSlackPermission (or handleTurn leftover-ask).
  // Wait 20ms.
  expect(await store.listPendingAsks(sessionId)).toHaveLength(1)
})

test('session host replays pending asks after resumeRuntime', async () => {
  let replayed = 0
  const host = createChatSessionHost({
    home,
    shared,
    resumeRuntime: async () =>
      fakeRuntime({
        async *replayPendingAsks() {
          replayed += 1
        },
      }),
  })
  await host.open(existingSessionId)
  expect(replayed).toBe(1)
})
```

`permissionBlocks` today is `(tool, prompt)` — change it to `(callId, tool, prompt)` in the same task. Update every caller.

- [ ] **Step 2: Run fail**

Run: `bun test packages/cli/src/slack/adapter.test.ts packages/cli/src/discord/adapter.test.ts packages/cli/src/chat-host/session-host.test.ts`  
Expected: FAIL — button `value` is still the tool name; host does not replay.

- [ ] **Step 3: Implement** as specified. Keep `singleFlight`. Permission answers never call `engine.abort` or `enqueueSteer`.

- [ ] **Step 4: Re-run** those three files. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: replay leftover-ask on Slack and Discord without timer deny"
```

---

### Task 6: Explicit `turnPolicy` on submit

**Files:**
- Modify: `packages/core/src/types.ts`, `packages/cli/src/app.tsx`, `packages/cli/src/opentui-app.ts`, `packages/cli/src/slack/adapter.ts`, `packages/cli/src/discord/adapter.ts`, `packages/cli/src/serve.ts`, `packages/cli/src/chat-host/session-host.ts` (`ChatBoundSession.submitMessage` today is `(text: string)` — widen to `UserSubmitInput`), `docs/headless.md`
- Test: `packages/cli/src/slack/adapter.test.ts` (existing overlapping-turn test), `packages/core/src/loop/session-engine.test.ts`

**Interfaces:**
- Consumes: existing TUI enqueue + Slack `singleFlight`
- Produces:

```ts
export type TurnPolicy = 'steer' | 'queue'

export type UserSubmitInput =
  | string
  | {
      text?: string
      images?: UserImage[]
      turnPolicy?: TurnPolicy
    }
```

`userSubmitToBlocks` keeps reading only `text` / `images`. `queryLoop` does **not** grow a second queue. Slack/Discord/serve pass `{ text, turnPolicy: 'queue' }` and keep `singleFlight`. TUI busy path keeps enqueue; `/steer` still `enqueueSteer` + `abort`.

- [ ] **Step 1: Failing tests**

```ts
test('slack overlapping inbound does not call engine.abort', async () => {
  // keep the existing adapter test title; add:
  // expect(abortCalls).toBe(0)
})

test('tryResolvePermit does not call abort or enqueueSteer', () => {
  const abort = mock(() => {})
  // invoke tryResolvePermit with a block_actions allow
  expect(abort).not.toHaveBeenCalled()
})
```

Do **not** add a tautology (`const input = { turnPolicy: 'queue' }; expect(input.turnPolicy).toBe('queue')`).

Add one paragraph to `docs/headless.md`:

```md
## Host delivery policy

Slack, Discord, and `raven serve` serialize inbound with `singleFlight` (`turnPolicy: queue`). They do not abort a live turn. The TUI queues composer input while busy; `/steer` aborts the live turn. Permission answers never steer.
```

- [ ] **Step 2–4:** Widen the type, pass `turnPolicy: 'queue'` from Slack/Discord/serve `submitMessage` calls, document. Do not add a second serializer.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: make turnPolicy explicit on host deliveries"
```

---

### Task 7: Channel auth pins + serve docs (E1.3)

**Files:**
- Modify: `docs/headless.md`
- Test: `packages/core/src/gateway/http.test.ts` (already pins `checkBearer` — keep), `packages/cli/src/serve.test.ts`, `packages/cli/src/slack/adapter.test.ts` or `normalize` tests, `packages/cli/src/discord/admit.test.ts`

**Interfaces:** none new.

- [ ] **Step 1: Failing tests**

HTTP `/v1/turn` 401 without Bearer is Task 14 (`handleServeRequest`). This task pins identity + documents bind/token. Add:

```ts
test('slack events_api ignores a forged top-level user field', () => {
  const inbound = normalizeSlackEnvelope({
    type: 'events_api',
    payload: {
      team_id: 'T1',
      event: {
        type: 'app_mention',
        user: 'U_REAL',
        channel: 'C1',
        ts: '1.0',
        text: 'hi',
      },
      user: 'U_FORGED',
      userId: 'U_FORGED',
      principalId: 'U_FORGED',
    },
  })
  expect(inbound?.userId).toBe('U_REAL')
})

test('discord normalize uses author.id and ignores d.user_id', () => {
  const inbound = normalizeDiscordPayload({
    author: { id: 'D_REAL' },
    channel_id: 'C1',
    id: 'M1',
    content: 'hi',
    user_id: 'D_FORGED',
    userId: 'D_FORGED',
  })
  expect(inbound?.userId).toBe('D_REAL')
})
```

Adapt argument shapes to the real `normalizeSlackEnvelope` / Discord normalize exports. If Discord normalize already only reads `author.id`, the test still belongs — it is the pin.

- [ ] **Step 2: Implement only if a test fails.** Add to `docs/headless.md`:

```md
## raven serve bind and token

`raven serve` exits 1 without `GATEWAY_SECRET` / `RAVEN_SERVE_SECRET`.
`--listen` must be loopback (`127.0.0.1`, `localhost`, `::1`).
`POST /v1/turn` requires `Authorization: Bearer <secret>` (`timingSafeEqual`).
Webhooks verify `X-Raven-Signature` over the raw body.
Slack uses Socket Mode (app token); there is no Slack signing-secret HMAC.
Discord identity is Gateway `author.id` plus the pairing ledger.
Never trust a JSON `userId` / `principalId` the body claims.
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test: pin serve and chat-host identity; document serve auth"
```

---

### Task 8: Write unread / stale check (E2.2)

**Files:**
- Modify: `packages/core/src/tools/write.ts`, `packages/core/src/tools/read-files.ts` (export `wasRead` from here; delete the local copies in `edit.ts` / `apply-patch.ts` / `notebook-edit.ts` only if the export is a move — do **not** change Edit behavior)
- Test: `packages/core/src/tools/write.test.ts`

**Interfaces:**
- Consumes: `wasRead` / `isStaleSinceRead` / `markReadPath` / `recordReadFile`
- Produces: existing-file Write without Read → `Write failed: path must be Read first: …` and file unchanged; stale mtime → `Write failed: file changed since last Read`; **new file does not require Read**; successful Write calls `markReadPath`. Keep **mtime**, this-turn only. Do not session-scope.

`wasRead` is currently a private function in `edit.ts`. Move it to `read-files.ts` and export it.

- [ ] **Step 1: Failing tests**

`write.test.ts` already has `fixtureRoot` / `makeCtx` / `writeTool`. Add imports for `statSync` and `recordReadFile`. **Change** the existing `'overwrites an existing file'` test so it Records first (or expect the new unread error). Add:

```ts
test('Write existing file without Read fails', async () => {
  const cwd = fixtureRoot()
  writeFileSync(join(cwd, 'a.txt'), 'old')
  const ctx = makeCtx(cwd)
  const out = await writeTool.execute({ path: 'a.txt', content: 'new' }, ctx)
  expect(out).toContain('path must be Read first')
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('old')
})

test('Write new file does not require Read', async () => {
  const cwd = fixtureRoot()
  const ctx = makeCtx(cwd)
  const out = await writeTool.execute({ path: 'b.txt', content: 'new' }, ctx)
  expect(out).toContain('Wrote')
  expect(readFileSync(join(cwd, 'b.txt'), 'utf8')).toBe('new')
})

test('Write after Read then external mtime change is stale', async () => {
  const cwd = fixtureRoot()
  const path = join(cwd, 'a.txt')
  writeFileSync(path, 'old')
  const ctx = makeCtx(cwd)
  recordReadFile(ctx.turn, path, statSync(path).mtimeMs - 1)
  const out = await writeTool.execute({ path: 'a.txt', content: 'new' }, ctx)
  expect(out).toContain('changed since last Read')
  expect(readFileSync(path, 'utf8')).toBe('old')
})
```

- [ ] **Step 2: Run fail**

Run: `bun test packages/core/src/tools/write.test.ts`  
Expected: FAIL — Write still overwrites.

- [ ] **Step 3: Implement**

```ts
const resolved = resolveWritePath(ctx.turn.cwd, input.path)
if (isHardDeniedWritePath(resolved)) {
  return `Write failed: write denied to protected path: ${input.path}`
}
const candidate = resolve(ctx.turn.cwd, input.path)
let exists = false
try {
  exists = statSync(resolved).isFile()
} catch {
  exists = false
}
if (exists) {
  if (!wasRead(ctx.turn.readFiles, resolved, candidate)) {
    return `Write failed: path must be Read first: ${input.path}`
  }
  if (isStaleSinceRead(ctx.turn, resolved, candidate)) {
    return `Write failed: file changed since last Read`
  }
}
// mkdir + writeFileSync + markReadPath (existing success path)
```

Update the Write `description` so it no longer says overwrite of an existing file is always allowed.

Do **not** introduce `WorkspaceFs` in this task.

- [ ] **Step 4: Re-run**

Run: `bun test packages/core/src/tools/write.test.ts packages/core/src/tools/edit.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "fix: Write requires Read and rejects stale mtime"
```

---

### Task 9: `WorkspaceFs` cwd jail (E2.1 port)

**Files:**
- Create: `packages/core/src/tools/workspace-fs.ts`, `packages/core/src/tools/workspace-fs.test.ts`
- Modify: `packages/core/src/types.ts` (`Turn.terminalBackend?: 'local' | 'docker'`), `packages/core/src/index.ts`
- Test: `packages/core/src/tools/workspace-fs.test.ts`

**Interfaces:**
- Consumes: `Turn.cwd`, `Turn.terminalBackend`
- Produces:

```ts
export type WorkspaceFs = {
  readFile(path: string): string
  writeFile(path: string, content: string): void
  mkdir(path: string): void
  unlink(path: string): void
  stat(path: string): {
    exists: boolean
    isFile: boolean
    isDir: boolean
    mtimeMs: number
    size: number
  }
  readdir(path: string): Array<{ name: string; isFile: boolean; isDir: boolean }>
  realpath(path: string): string
}

export function createWorkspaceFs(opts: {
  cwd: string
  backend: 'local' | 'docker'
}): WorkspaceFs
```

v1 for **both** backends: `node:fs` on the host + jail. A path whose `realpath` is not `cwd` or a descendant throws `Error` whose message matches `/outside workspace/`. Docker v1 is the Bash bind (`-v cwd:cwd`); there is no `docker exec` and no second tree. `AddDir` extra roots are **not** in the jail (same as Bash’s single mount).

- [ ] **Step 1: Failing tests**

```ts
test('docker workspace fs rejects path outside cwd', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ws-'))
  const fs = createWorkspaceFs({ cwd, backend: 'docker' })
  expect(() => fs.readFile('/etc/passwd')).toThrow(/outside workspace/)
})

test('local workspace fs reads host file under cwd', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ws-'))
  writeFileSync(join(cwd, 'a.txt'), 'hi')
  expect(createWorkspaceFs({ cwd, backend: 'local' }).readFile(join(cwd, 'a.txt'))).toBe('hi')
})

test('writeFile outside cwd throws and does not create the file', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ws-'))
  const fs = createWorkspaceFs({ cwd, backend: 'docker' })
  expect(() => fs.writeFile('/tmp/raven-outside.txt', 'x')).toThrow(/outside workspace/)
})
```

- [ ] **Step 2: Run fail**

Run: `bun test packages/core/src/tools/workspace-fs.test.ts`  
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** `createWorkspaceFs`. Jail before every I/O. `backend` is reserved for a later exec port; v1 ignores it except as documentation.

- [ ] **Step 4: Re-run** that file. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add WorkspaceFs cwd jail for docker v1 bind"
```

---

### Task 10: File tools use `WorkspaceFs`

**Files:**
- Modify: `packages/cli/src/engine.ts` (when building a `Turn`, set `terminalBackend: config.terminal?.backend ?? 'local'`), `packages/core/src/loop/session-engine.ts` (same on the `turn` object it constructs ~142), `packages/core/src/tools/read.ts`, `write.ts`, `edit.ts`, `list-dir.ts`, `apply-patch.ts`, `read-subtree.ts`, `read-files.ts` (`markReadPath` / `isStaleSinceRead` stat through `createWorkspaceFs`), `grep.ts`, `glob.ts` (reject paths outside cwd; keep host `rg`/walk), `docs/headless.md`
- Test: `packages/core/src/tools/write.test.ts`, `packages/core/src/tools/workspace-fs.test.ts`, existing edit/read tests

**Interfaces:**
- Consumes: `createWorkspaceFs({ cwd: turn.cwd, backend: turn.terminalBackend ?? 'local' })`
- Produces: Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree I/O go through `WorkspaceFs`. Hard-denied paths stay hard-denied. NotebookEdit is **not** in this task.

Replace the Docker sentence in `docs/headless.md`:

```md
The Docker terminal backend runs allowed Bash in a container (`-v cwd:cwd -w cwd`) and jails Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree to that same cwd bind. Grep/Glob still run on the host but refuse paths outside cwd. It is not a substitute for `dontAsk`.
```

- [ ] **Step 1: Failing test**

```ts
test('Write with terminalBackend docker refuses a path outside cwd', async () => {
  const cwd = fixtureRoot()
  const ctx = makeCtx(cwd)
  ctx.turn.terminalBackend = 'docker'
  const out = await writeTool.execute({ path: '/etc/passwd', content: 'x' }, ctx)
  expect(String(out).toLowerCase()).toMatch(/outside workspace|denied|protected/)
})
```

- [ ] **Step 2–4:** Switch the listed tools. Keep Write’s exists-gate from Task 8.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: file tools honor docker workspace cwd jail"
```

---

### Task 11: Compact budget beyond Bash + queue live `/compact` (E3.1)

**Files:**
- Modify: `packages/core/src/compact/prune.ts`, `packages/core/src/compact/policy.ts`, `packages/core/src/loop/session-engine.ts` (`compactNow`), `packages/cli/src/slash/dispatch.ts` (no change if `compactNow` queues internally)
- Test: `packages/core/src/compact/prune.test.ts`, `packages/core/src/compact/policy.test.ts`, `packages/core/src/loop/session-engine.test.ts`

**Interfaces:**
- Consumes: `applyToolResultBudget`, `compactNow`, `liveTurn` (private)
- Produces: budget applies to **all** `role: tool` without `persistPath`; preview is head 400 + tail 400; `COMPACTION_PROMPT_TOKENS = 1024` added to the compact comparison; `compactNow` while `liveTurn !== null` sets `compactQueued = true` and returns; after `liveTurn = null` in `submitMessage`’s `finally`, if `compactQueued` then run the current compact body.

Do **not** call `bindDrainQueued`. Do **not** add `isBusy()`.

```ts
// prune.ts
function headTailPreview(text: string, head = 400, tail = 400): string {
  if (text.length <= head + tail) return text
  return `${text.slice(0, head)}\n... [truncated ${text.length} characters] ...\n${text.slice(-tail)}`
}
```

Drop the `if (name !== 'Bash') return msg` guard. Keep the 100_000 cap and the `persistPath` skip.

```ts
// policy.ts
export const COMPACTION_PROMPT_TOKENS = 1024

export function compactThreshold(model: ModelProfile, compact: CompactPolicy): number {
  return model.contextWindow - model.reserveOutputTokens - compact.autoCompactBuffer
}

// shouldAutocompact: compare (estimatedTokens + COMPACTION_PROMPT_TOKENS)
// and (anchoredTokens + COMPACTION_PROMPT_TOKENS) against compactThreshold
```

- [ ] **Step 1: Failing tests**

Use existing `asstTools` / `tool` / `textOf` helpers in `prune.test.ts`. **Replace** `'does not stub huge Read output'`:

```ts
test('applyToolResultBudget trims large Grep results with head and tail', () => {
  const big = 'x'.repeat(200_000)
  const messages = [
    user('u1', 'g', 1),
    asstTools('a1', [{ id: 'c1', name: 'Grep', input: { pattern: 'x' } }], 2),
    tool('t1', 'c1', big, 3),
  ]
  const out = applyToolResultBudget(messages)
  const text = textOf(out.find((m) => m.role === 'tool')!)
  expect(text.length).toBeLessThan(2000)
  expect(text.startsWith('x'.repeat(200))).toBe(true)
  expect(text.endsWith('x'.repeat(200))).toBe(true)
  expect(text).toContain('truncated')
})

test('applyToolResultBudget still skips persistPath', () => {
  const huge = 'y'.repeat(100_001)
  const messages = [
    user('u1', 'run', 1),
    asstTools('a1', [{ id: 'b1', name: 'Bash', input: { command: 'ls' } }], 2),
    tool('t1', 'b1', huge, 3, { persistPath: '/tmp/out.txt' }),
  ]
  expect(textOf(applyToolResultBudget(messages).find((m) => m.id === 't1')!)).toBe(huge)
})
```

```ts
// policy.test.ts
test('shouldAutocompact counts COMPACTION_PROMPT_TOKENS against the threshold', () => {
  const model = { ...dummyModel, contextWindow: 10_000, reserveOutputTokens: 1_000 }
  const compact = defaultCompactPolicy()
  const threshold = compactThreshold(model, compact)
  const decision = shouldAutocompact({
    enabled: true,
    estimatedTokens: threshold - 500,
    anchoredTokens: threshold - 500,
    model,
    compact,
    consecutiveFailures: 0,
  })
  expect(decision).toBe('compact')
})
```

```ts
// session-engine.test.ts
test('compactNow during submitMessage does not rewrite messages until the turn ends', async () => {
  let sawLive = false
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_c' })
  await store.createSession(session)
  const provider = createFakeProvider([
    async function* () {
      sawLive = true
      yield { type: 'text_delta', text: 'hi' }
      yield { type: 'stop', reason: null }
    },
  ])
  const engine = createSessionEngine(engineOpts({ provider, store, session }))
  const gen = engine.submitMessage('hi')
  await gen.next()
  const before = (await store.loadSession(session.id)).messages.length
  await engine.compactNow()
  const mid = (await store.loadSession(session.id)).messages.length
  expect(mid).toBe(before)
  await collect(gen)
})
```

Adapt the provider script to whatever `createFakeProvider` already accepts in that file. The assertion that matters: `compactNow` during a live `submitMessage` does not call `recordCompact` until after the generator finishes.

- [ ] **Step 2–4:** Implement preview, drop Bash-only, add 1024, queue on `liveTurn`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: trim all tool results before compact; queue live /compact"
```

---

### Task 12: MEMORY compact regression (E3.2)

**Files:**
- Test: `packages/core/src/compact/maybe-compact.test.ts`
- Modify: none unless the test fails

**Interfaces:** none new.

- [ ] **Step 1: Write the test**

`maybe-compact.test.ts` already builds a `LoopState`. Give `state.system` a MEMORY snapshot part and a long transcript. Run `maybeCompact` / `runAutocompact`. Then:

```ts
test('compact leaves MEMORY system snapshot untouched', async () => {
  const memoryPart = { type: 'text' as const, text: 'MEMORY.md unique-bytes-xyz' }
  const state = makeLoopState({
    system: [memoryPart],
    messages: longTranscript(),
  })
  const before = JSON.stringify(state.system)
  await collectMaybe(maybeCompact(state))
  expect(JSON.stringify(state.system)).toBe(before)
  expect(state.system?.some((p) => 'text' in p && p.text.includes('unique-bytes-xyz'))).toBe(true)
  const summary = state.turn.messages.find((m) => m.role === 'assistant' || m.role === 'user')
  const blob = JSON.stringify(state.turn.messages)
  expect(blob.includes('unique-bytes-xyz') && state.system === undefined).toBe(false)
})
```

Adapt `makeLoopState` / `collectMaybe` to the helpers already in that file. The law: after compact, `state.system` still equals the captured snapshot; the compact summary lives in **messages** only.

- [ ] **Step 2: Run.** If it passes, keep the test. If it fails, fix compact — do not put MEMORY into the summary as the new system prefix.

- [ ] **Step 3: Commit**

```bash
git commit -m "test: compact must not replace MEMORY system snapshot"
```

---

### Task 13: `permission_ask.childSessionId` (E3.3)

**Files:**
- Modify: `packages/core/src/types.ts`, `packages/core/src/loop/phases.ts` (`executeOneCall` event builder), `packages/cli/src/permission-dialog.tsx`, `packages/cli/src/slack/adapter.ts` (`askSlackPermission` event type is `{ id, tool, message }` — add `childSessionId?: string`)
- Test: `packages/core/src/tools/agent.test.ts`

**Interfaces:**
- Consumes: child `SessionEngine` already uses parent `askUser`; child `session.id` is `state.turn.sessionId` on the child engine
- Produces:

```ts
// StreamEvent permission_ask
{
  type: 'permission_ask'
  id: string
  tool: string
  input: unknown
  message: string
  saveAs?: PermissionScope
  childSessionId?: string
}
```

In `executeOneCall`, if the engine session has `parentSessionId`, set `event.childSessionId = state.turn.sessionId`. TUI/Slack label `child <id>`. Answer still writes the **child** tool result (pairing on the child transcript). Do not add a second loop. Do not change `dontAsk` channel children (they stay deny).

- [ ] **Step 1: Failing test**

`agent.test.ts` already builds a parent engine with `askUser` (see the `askUser: async () => 'allow'` cases around line 618). Add a sibling that records the event:

```ts
test('child leftover-ask permission_ask includes childSessionId', async () => {
  const seen: Array<string | undefined> = []
  const parentAsk: SessionEngineOptions['askUser'] = async (event) => {
    seen.push(event.childSessionId)
    return 'deny'
  }
  // Same createAgentTool + foreground child setup as the existing
  // "child inherits parent askUser" test, but the child tool's
  // checkPermissions returns { behavior: 'ask', message: 'child bash?' }.
  expect(seen[0]).toBeTruthy()
  expect(seen[0]).toBe(childSession.id)
})
```

- [ ] **Step 2–4:** Thread the field. Update Ink dialog and Slack prompt text when `childSessionId` is set: `` `child ${id}` ``.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: label child leftover-ask with childSessionId"
```

---

### Task 14: Serve stream + ask-resolve (E4.1)

**Files:**
- Modify: `packages/cli/src/serve.ts` (extract `export async function handleServeRequest(...)` from the `Bun.serve` `fetch` so tests do not need `runServe`), `packages/core/src/gateway/http.ts` (parsers only), `packages/cli/src/args.ts` (do **not** force `dontAsk` on the new session runtime — keep `if (cmd === 'serve') flags.dontAsk = true` for `/v1/turn` boot **or** split: `bootCli` for `/v1/turn` stays dontAsk; session routes call `bootCli({ flags: { ...opts.flags, dontAsk: false } })`), `docs/headless.md`
- Test: `packages/cli/src/serve.test.ts`

**Interfaces:**
- Consumes: Task 3 `applyAskAnswer`, existing `checkBearer` + loopback
- Produces (names ours, not `eve/v1`):

```
GET  /v1/session/:id/stream   NDJSON StreamEvent live tail (no ?after=)
POST /v1/session/:id/cancel   engine.abort()
POST /v1/session/:id/compact  engine.compactNow()
POST /v1/session/:id/resolve  { callId, allow: boolean }
```

Keep `POST /v1/turn` as today (dontAsk, one-shot JSON, Bearer).  
`parseResolveBody` in `gateway/http.ts`:

```ts
export function parseResolveBody(
  body: unknown,
): { ok: true; callId: string; allow: boolean } | { ok: false; error: string }
```

Resolve handler: `checkBearer` → `engine.applyAskAnswer(callId, allow ? 'allow' : 'deny')` → 200 `{ status }` or 404 if `'unmatched'`. 401 without Bearer.

Stream: subscribe to the in-process engine’s live `submitMessage` / `replayPendingAsks` events and write one JSON object per line. v1 = this process’s live tail. No sequence numbers.

- [ ] **Step 1: Failing tests** in `serve.test.ts`

```ts
test('POST /v1/session/:id/resolve without Bearer is 401', async () => {
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/resolve', {
      method: 'POST',
      body: JSON.stringify({ callId: 'c1', allow: true }),
    }),
    ctx,
  )
  expect(res.status).toBe(401)
})

test('POST /v1/turn without Bearer is 401', async () => {
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/turn', { method: 'POST', body: JSON.stringify({ text: 'hi' }) }),
    ctx,
  )
  expect(res.status).toBe(401)
})

test('resolve allow deletes the pending row', async () => {
  await ctx.store.upsertPendingAsk({
    callId: 'c1',
    sessionId: 's1',
    kind: 'leftover',
    tool: 'Echo',
    message: 'Echo?',
    input: { text: 'hi' },
    createdAt: 1,
  })
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/resolve', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: JSON.stringify({ callId: 'c1', allow: false }),
    }),
    ctxWithSecret,
  )
  expect(res.status).toBe(200)
  expect(await ctx.store.listPendingAsks('s1')).toHaveLength(0)
})
```

Build `ctx` from the same loopback + secret helpers `serve.test.ts` already uses for `gatewaySecret` / `parseListen`. Extracting `handleServeRequest` is part of the implementation.

Document the new routes in `docs/headless.md`. Update `help.ts` serve blurb only if you mention stream/resolve (optional).

- [ ] **Step 2–4:** Implement with the same `checkBearer` / `singleFlight`. Non-loopback still rejected at `runServe` start.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: serve NDJSON stream and leftover-ask resolve"
```

---

### Task 15: In-process eval fixtures (E4.2)

**Files:**
- Create: `packages/core/src/eval/run.ts`, `packages/core/src/eval/run.test.ts`, `packages/core/src/eval/fixtures/pending-ask-persist/case.json`
- Modify: `packages/cli/src/args.ts` (`ParsedArgv.cmd` union + first-positional list), `packages/cli/src/index.ts`, `packages/cli/src/help.ts`, `packages/cli/src/completions.ts` (`COMPLETION_COMMANDS`), `packages/cli/src/help.test.ts`
- Optional: `packages/cli/src/eval-cmd.ts` thin wrapper

**Interfaces:**
- Consumes: `createSessionEngine` + Task 3 store/engine
- Produces: path-identity fixtures. No authored `id`. Gate assertions only (pairing, pending-ask persist, Write-without-Read, compact MEMORY). No LLM-as-judge.

`packages/core/src/eval/fixtures/pending-ask-persist/case.json`:

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

```ts
export async function runEvalDir(dir: string): Promise<void>
```

`runEvalDir` loads each subdirectory that contains `case.json`. For `pending-ask-persist` it: creates a memory store + ask-Echo + fake provider leftover-ask; hangs `askUser`; asserts `listPendingAsks` nonempty; clones the store state into a new engine; `loadSession` has no `incomplete` tool row; `applyAskAnswer(..., 'deny')` pairs. Throw if any expect fails.

`raven eval [dir]` defaults to `packages/core/src/eval/fixtures`. Exit 1 on throw.

- [ ] **Step 1: Failing test**

```ts
test('pending-ask-persist fails if applyAskAnswer is missing', async () => {
  await expect(
    runEvalDir(join(import.meta.dir, 'fixtures')),
  ).resolves.toBeUndefined()
})
```

This test is green only after Task 3. If someone reverts Task 3, it must throw.

- [ ] **Step 2–4:** Implement the runner and CLI wiring (`completions.ts` + `help.test.ts` expect `raven eval`).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add raven eval fixture runner"
```

---

## Spec coverage

| Spec slice | Task | Notes |
|---|---|---|
| E1.1 pending-ask + repair | 1–3 | resume + `applyAskAnswer` live here, not only in hosts |
| E1.1 host re-ask | 4–5 | TUI then Slack/Discord |
| E1.1 requestId match | 3 + 5 | `callId`; Slack button `value` |
| E1.1 unmatched answer re-queue | 3 + 5 | `'unmatched'`; host does not `submitMessage` |
| E1.1 unmatched open ask | 3 | explicit deny / abort only; no `ignored`; no dismiss-on-message |
| E1.1 approvals do not dismiss-on-message | 5 | non-allow text stashed |
| E1.2 turnPolicy | 6 | type + existing serializers; no tautology |
| E1.3 auth tests + headless | 7 | Socket Mode; no Slack HMAC |
| E2.2 Write Read/stale | 8 | exists-gate; mtime; this-turn |
| E2.1 docker file port | 9–10 | cwd bind jail; Grep/Glob host+jail |
| E3.1 budget + queue compact | 11 | 1024 envelope; not `bindDrainQueued` |
| E3.1 todos restore-note | — | out of plan (ruling 15) |
| E3.2 MEMORY regression | 12 | `maybe-compact.test.ts` |
| E3.3 child ask id | 13 | |
| E4.1 serve stream/resolve | 14 | `/v1/turn` stays dontAsk; session routes do not |
| E4.2 raven eval | 15 | `fixtures/<name>/case.json` |
| Do not build / one loop | Global constraints | |

Out of plan (spec “Out of this horizon” + rulings): web UI, Next BFF, y0 Task/PR, eve compiler, OpenAPI, memory slots, self-mod, `ignored`, todos restore-note, stream `?after=`, NotebookEdit docker port, Grep/Glob docker-exec, Slack signing-secret HMAC.

## Success checks (from spec)

1. Kill mid-leftover-ask; resume answers the same ask — Tasks 3–5  
2. Slack follow-up with queue does not abort — Task 6 (already true; now explicit)  
3. Docker Write is not a host-only side channel outside cwd — Tasks 9–10  
4. Existing-file Write without Read errors — Task 8  
5. Huge non-Bash tool result trims without LLM — Task 11  
6. Child leftover-ask labeled on parent TUI — Task 13  
7. `curl` stream + resolve — Task 14  
8. Eval fixture fails if ask persist regresses — Task 15  
