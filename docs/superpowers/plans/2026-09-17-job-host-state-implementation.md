# Job-host state — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reconnecting job host see why the last turn stopped, park exactly one next prompt, edit the last user and resubmit, and read `base...HEAD` ∪ dirty — without a second loop or a web UI.

**Architecture:** Persist `lastEnd`, `jobError`, and one `followup` string on `SessionRecord` (schema v10). Hosts still only `submitMessage` for new user text. Follow-up auto-run and `POST …/edit` are host epilogues composed from existing engine methods. Job diff is a read-only helper, not a tool.

**Tech Stack:** Bun, TypeScript, SQLite WAL (`applyMigrations`), existing `SessionStore`, `SessionEngine`, `raven serve`, TUI slash catalog.

**Spec:** `docs/superpowers/specs/2026-09-17-job-host-state-roadmap.md`

## Global Constraints

- One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer and does not start a model turn.
- Default prefix stays small and frozen. No new always-on tool. Follow-up, edit-resubmit, and job diff are host / session ops, not tools.
- `dontAsk` never becomes `bypass`. y0 isolation-trust is not a permission mode.
- BYOK is the product. Ads never touch BYOK.
- Clean-room. Steal semantics. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**.
- `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row. Do not record that return as `lastEnd`.
- Live `/cancel` abort-pair of a parked leftover-ask stays OUT.
- Targeted `bun test <files>` only. Never full-repo `bun test`.
- Isolated `.worktrees/` + TDD. Do not implement on `main` without consent. Do not push. Do not copy y0/eve source.
- G0.1 (docs point at this spec) already shipped on `main` at `077f5e8`. Do not re-do that pass.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification.

1. **Schema v10 in Task 1**, one migration `010_session_host_state.sql`:

```sql
ALTER TABLE sessions ADD COLUMN last_end_json TEXT;
ALTER TABLE sessions ADD COLUMN job_error TEXT;
ALTER TABLE sessions ADD COLUMN followup_text TEXT;
```

Pin every `schema_version 9` assertion to `10`. Add a v9 → v10 upgrade test.

2. **`SessionRecord` fields:**

```ts
lastEnd?: RoundEnd
jobError?: string
followup?: string
```

`followup` is the one-slot text. GET snapshot `queued` is `session.followup ?? null` (always present, never omitted).

3. **Serialize `lastEnd` for SQLite.** `RoundEnd.error` is `unknown`. Persist:

```ts
function serializeLastEnd(end: RoundEnd): string {
  if (end.reason === 'max_rounds') return JSON.stringify({ reason: 'max_rounds', round: end.round })
  if (end.reason === 'model_error' || end.reason === 'persist_failed' || end.reason === 'results_persist_failed') {
    return JSON.stringify({ reason: end.reason, error: String(end.error).slice(0, 500) })
  }
  return JSON.stringify({ reason: end.reason })
}
```

Parse: unknown / malformed JSON → omit the field. Rehydrate error reasons as `{ reason, error: string }`.

4. **Write `lastEnd` only after a real turn end:** `queryLoop` return, or `UserPromptSubmit` ending `hook_stopped`. Do **not** write on pending-gate `{ reason: 'completed' }`. Do **not** write when `persistUser` throws (that is not a `RoundEnd`). Persist via the existing `upsertSession` after the turn (same write that already stores usage).

5. **`jobError` helpers live in `packages/core/src/session/job.ts`:**

```ts
export function setSessionJobError(session: SessionRecord, notice: string): void {
  session.jobError = notice
}
export function clearSessionJobError(session: SessionRecord): void {
  delete session.jobError
}
```

Set on failed enter-worktree / `maybeCommitJob` / `rewindToCheckpoint` / `openDraftPr`. Clear on the next successful one of those, or when a job session’s turn ends `completed`. Callers persist with `upsertSession`.

6. **Follow-up API (engine methods, persist via `upsertSession`):**

```ts
setFollowup(text: string): Promise<{ ok: true } | { ok: false; notice: string }>
clearFollowup(): Promise<void>
getFollowup(): string | null
```

Empty / whitespace-only `setFollowup` → `{ ok: false, notice: 'follow-up text required' }` (do not throw, do not clear). Overwrite replaces. `SuggestFollowups` and `packages/cli/src/followup-notice.ts` are **not** this slot.

7. **`maybeRunFollowup` in `packages/core/src/session/followup.ts`.** Hosts call it after `submitMessage` returns. Persist-clear **first**; if that write fails, leave the slot and do not submit. Success reasons: `completed` | `hook_stopped` | `max_rounds` | `context_full`. Clear-without-run: `cancelled` | `aborted` | `model_error` | `persist_failed` | `results_persist_failed`. Skip run (leave slot) if `listPendingAsks` nonempty. `chain: true` means this return was already a follow-up turn — do not run again (at most one chain per original host submit). Serve must not call this from `createSession` / GET / load.

8. **`SESSION_PATH` becomes:**

```ts
/^\/v1\/session\/([^/]+)\/(stream|cancel|compact|resolve|submit|pr|followup|edit|diff)$/
```

`DELETE …/followup` uses the same path. `GET …/diff` uses the same path.

9. **`consumeSubmit` returns the generator’s `RoundEnd`.** Today it discards `next.value`. Change the helper; mailbox / submit still ignore the value except the follow-up epilogue.

10. **TUI: follow-up slot runs before `/queue` leftover** after a successful turn. `/retry` is `HOST_ONLY` (needs the composer). `/follow` is dispatch (engine methods). `/queue` tests stay green.

11. **`jobDiff` lives in `packages/core/src/session/job-diff.ts`** (keep `job.ts` from growing). Types exported from that file and re-exported via `packages/core/src/index.ts`.

12. **`rewindLast` return type:**

```ts
Promise<{ ok: boolean; notice: string; droppedText?: string }>
```

`droppedText` is concatenated `type: 'text'` blocks on the last user message (ignore images). Absent when `ok` is false or there is no last user. New refuse: owned unpaired `pending_asks` → `{ ok: false, notice: 'pending permission ask' }`.

13. File partitions below are **sequential on `serve.ts`** (Tasks 3, 4, 5, 7, 9). Tasks 6 and 8 may run in parallel with each other after Task 1. Do not edit another task’s files.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/migrations/010_session_host_state.sql` | v10 columns |
| `packages/core/src/session/schema.ts` | register migration 10 |
| `packages/core/src/types.ts` | `SessionRecord` fields; `SessionEngine` follow-up + rewind return |
| `packages/core/src/session/sqlite-store.ts` | persist/load the three columns |
| `packages/core/src/session/memory-store.ts` | same fields in RAM |
| `packages/core/src/loop/session-engine.ts` | write `lastEnd`; follow-up methods; rewind return |
| `packages/core/src/session/job.ts` | `setSessionJobError` / `clearSessionJobError`; call from commit/PR |
| `packages/core/src/session/followup.ts` | set/clear/get + `maybeRunFollowup` |
| `packages/core/src/session/job-diff.ts` | `jobDiff` |
| `packages/core/src/session/rewind.ts` | last-user text helper; pending refuse stays in engine |
| `packages/cli/src/serve.ts` | snapshot fields; followup/edit/diff routes; epilogue |
| `packages/cli/src/app.tsx` / `opentui-app.ts` | follow-up before `/queue`; `/retry` composer |
| `packages/cli/src/commands.ts` | `/follow`, `/retry`; `/diff` summary |
| `packages/cli/src/slash/dispatch.ts` | `/follow` |
| `packages/cli/src/diff-cmd.ts` | job-range panel when `session.job` |
| `packages/core/src/eval/` | four new fixtures |
| docs | headless, slash, CHANGELOG, ARCHITECTURE |

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 schema | `010_session_host_state.sql`, `schema.ts`, `schema.test.ts`, `sqlite-store.ts`, `memory-store.ts`, `sqlite-store.test.ts`, `memory-store.test.ts`, `types.ts` (`SessionRecord` three fields only) |
| 2 lastEnd / jobError | `session-engine.ts`, `session-engine.test.ts`, `job.ts`, `job.test.ts` (error helpers + commit/PR), `rewind.ts` / `rewind.test.ts` (jobError on checkpoint fail/success only), `slash/dispatch.ts` (enter-worktree jobError persist) |
| 3 snapshot GET | `serve.ts` (GET snapshot body + banner), `serve.test.ts` (snapshot tests only), `docs/headless.md` |
| 4 follow-up persist | `session/followup.ts`, `followup.test.ts`, `session-engine.ts` (three methods), `types.ts` (`SessionEngine` three methods), `index.ts` (export), `serve.ts` (POST/DELETE followup + snapshot `queued`), `commands.ts` (`/follow`), `commands.test.ts`, `slash/dispatch.ts` (`/follow`), `slash/dispatch.test.ts` |
| 5 follow-up epilogue | `session/followup.ts` (`maybeRunFollowup`), `followup.test.ts`, `serve.ts` (`consumeSubmit` + submit path), `serve.test.ts` (epilogue), `app.tsx`, `opentui-app.ts` |
| 6 rewind droppedText | `rewind.ts`, `rewind.test.ts`, `session-engine.ts` (`rewindLast`), `session-engine.test.ts` / existing rewind engine tests, `types.ts` (`rewindLast` return) |
| 7 edit + retry | `serve.ts` (`POST …/edit`), `serve.test.ts`, `commands.ts` (`/retry`), `app.tsx`, `opentui-app.ts`, `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md` |
| 8 jobDiff | `session/job-diff.ts`, `job-diff.test.ts`, `types.ts` (optional re-export types), `index.ts` |
| 9 GET/TUI diff | `serve.ts` (`GET …/diff`), `serve.test.ts`, `diff-cmd.ts`, `diff-cmd.test.ts`, `diff-panel.tsx` (only if format changes), `commands.ts` (`/diff` summary) |
| 10 eval | `eval/run.ts`, `eval/run.test.ts`, `eval/fixtures/{snapshot-end-reason,followup-slot,edit-resubmit,job-diff}/case.json` |
| 11 docs | `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-09-17-job-host-state-roadmap.md` (plan pointer only) |

Task 2 vs Task 6 both touch `rewind.ts` / `session-engine.ts` — **do not parallel**. Task 4 vs 5 both touch `followup.ts` / `serve.ts` — sequential. Task 8 may parallel Task 6.

---

### Task 1: Schema v10 + store persist

**Files:**
- Create: `packages/core/src/migrations/010_session_host_state.sql`
- Modify: `packages/core/src/session/schema.ts`, `schema.test.ts`, `sqlite-store.ts`, `memory-store.ts`, `sqlite-store.test.ts`, `memory-store.test.ts`, `packages/core/src/types.ts` (`SessionRecord` only)

**Interfaces:**
- Consumes: existing `SessionRecord`, `applyMigrations`
- Produces: `SessionRecord.lastEnd?`, `jobError?`, `followup?`; schema version **10**

- [ ] **Step 1: Write the failing schema test**

In `schema.test.ts` add `expectHostStateColumns` and change every `toBe('9')` that asserts the fresh/upgrade tip to `toBe('10')`. Add:

```ts
test('v9 database upgrades to v10 with last_end_json', () => {
  const db = new Database(':memory:')
  db.exec(INIT_SQL)
  db.exec(FTS5_SQL)
  db.exec(AGENT_MAIL_SQL)
  db.exec(DELIVERIES_SQL)
  db.exec(PENDING_ASKS_SQL)
  db.exec(READ_MTIME_SQL)
  db.exec(SESSION_TODOS_SQL)
  db.exec(SESSION_JOB_SQL)
  db.exec(STREAM_EVENTS_SQL)
  db.query(
    "INSERT INTO meta (key, value) VALUES ('schema_version', '9') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run()
  applyMigrations(db)
  const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string
  }
  expect(version.value).toBe('10')
  expect(sessionColumns(db)).toContain('last_end_json')
  expect(sessionColumns(db)).toContain('job_error')
  expect(sessionColumns(db)).toContain('followup_text')
  db.close()
})
```

Export `STREAM_EVENTS_SQL` from `schema.ts` if the test needs it (it is already exported). Fresh-db tests must also contain the three columns.

In `sqlite-store.test.ts` change `schema_version 9` → `10` and add:

```ts
test('lastEnd, jobError, and followup round-trip through upsertSession', async () => {
  const store = openStore()
  await store.createSession(
    session({
      lastEnd: { reason: 'cancelled' },
      jobError: 'git commit failed',
      followup: 'run tests',
    }),
  )
  const loaded = await store.loadSession('s1')
  expect(loaded.session.lastEnd).toEqual({ reason: 'cancelled' })
  expect(loaded.session.jobError).toBe('git commit failed')
  expect(loaded.session.followup).toBe('run tests')
  delete loaded.session.jobError
  delete loaded.session.followup
  loaded.session.lastEnd = { reason: 'completed' }
  await store.upsertSession(loaded.session)
  const again = await store.loadSession('s1')
  expect(again.session.lastEnd).toEqual({ reason: 'completed' })
  expect(again.session.jobError).toBeUndefined()
  expect(again.session.followup).toBeUndefined()
})
```

Mirror the round-trip in `memory-store.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/session/schema.test.ts packages/core/src/session/sqlite-store.test.ts packages/core/src/session/memory-store.test.ts`

Expected: FAIL — version still `9` and columns missing.

- [ ] **Step 3: Implement the migration and store bind**

`010_session_host_state.sql` is the three `ALTER TABLE` lines from ruling 1. Register `{ version: 10, sql: SESSION_HOST_STATE_SQL }` in `MIGRATIONS`.

`SessionRecord` gains the three optional fields (ruling 2).

`sessionFromRow` / `sessionBind`: persist `last_end_json` via `serializeLastEnd` (put the helper next to `jobFromJson` in `sqlite-store.ts` or a tiny `last-end.ts` in the same folder — do **not** add it to `job.ts`). `job_error` and `followup_text` are plain TEXT. Null / empty → omit on load. `createSession` INSERT and `upsertSession` UPDATE must list the three columns.

Memory store: `createSession` / `upsertSession` already clone the object — ensure they copy `lastEnd` / `jobError` / `followup` (spread is enough if they store the record by value).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/session/schema.test.ts packages/core/src/session/sqlite-store.test.ts packages/core/src/session/memory-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/migrations/010_session_host_state.sql \
  packages/core/src/session/schema.ts packages/core/src/session/schema.test.ts \
  packages/core/src/session/sqlite-store.ts packages/core/src/session/sqlite-store.test.ts \
  packages/core/src/session/memory-store.ts packages/core/src/session/memory-store.test.ts \
  packages/core/src/types.ts
git commit -m "feat: persist lastEnd, jobError, and followup on sessions (schema v10)"
```

---

### Task 2: Engine writes lastEnd; job epilogues write jobError

**Files:**
- Modify: `packages/core/src/loop/session-engine.ts`, `session-engine.test.ts`, `packages/core/src/session/job.ts`, `job.test.ts`, `rewind.ts` (success/fail jobError only), `rewind.test.ts`, `packages/cli/src/slash/dispatch.ts` (enter-worktree fail/success persist)

**Interfaces:**
- Consumes: `SessionRecord.lastEnd`, `jobError`; `setSessionJobError` / `clearSessionJobError`
- Produces: `lastEnd` after real turns; `jobError` after failed/successful job epilogues

- [ ] **Step 1: Write the failing engine test**

In `session-engine.test.ts`:

```ts
test('cancelled turn persists lastEnd; pending-gate submit does not overwrite it', async () => {
  const store = createMemoryStore()
  const session = await store.createSession(baseSession())
  const engine = createSessionEngine({
    session,
    provider: hangUntilAbortProvider(),
    store,
    tools: [],
    compact: defaultCompact(),
    model: defaultModel(),
    maxRounds: 4,
    bare: true,
    askUser: async () => 'deny',
  })
  const gen = engine.submitMessage('go')
  const pending = drain(gen)
  engine.abort('cancel')
  expect(await pending).toEqual({ reason: 'cancelled' })
  expect(engine.session.lastEnd).toEqual({ reason: 'cancelled' })
  const loaded = await store.loadSession(session.id)
  expect(loaded.session.lastEnd).toEqual({ reason: 'cancelled' })

  await store.upsertPendingAsk({
    callId: 'parked',
    sessionId: session.id,
    kind: 'leftover',
    tool: 'Bash',
    message: 'Bash?',
    input: { command: 'ls' },
    createdAt: 1,
  })
  const gated = await drain(engine.submitMessage('again'))
  expect(gated).toEqual({ reason: 'completed' })
  expect(engine.session.lastEnd).toEqual({ reason: 'cancelled' })
})
```

Reuse the existing hang-until-abort helper from the cancel tests in the same file. If none exists, copy the `cancel-not-fail` eval provider pattern.

In `job.test.ts`:

```ts
test('setSessionJobError writes and clearSessionJobError deletes', () => {
  const session = { id: 's', jobError: undefined } as SessionRecord
  setSessionJobError(session, 'gh missing')
  expect(session.jobError).toBe('gh missing')
  clearSessionJobError(session)
  expect(session.jobError).toBeUndefined()
})
```

Add: `maybeCommitJob` failure path (stub `runGit` via a temp non-repo cwd) leaves a notice; the **engine** test after a job turn with `jobAutoCommit: true` and a missing worktree sets `session.jobError`. Successful `openDraftPr` in `job.test.ts` after a prior `jobError` should clear it when the serve/dispatch caller runs `clearSessionJobError` — test the helper plus one `applySessionDraftPr` wrapper if you add clear/set there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/loop/session-engine.test.ts packages/core/src/session/job.test.ts`

Expected: FAIL — `lastEnd` undefined.

- [ ] **Step 3: Implement writes**

In `session-engine.ts` `submitMessage`:
- Pending-gate early return: unchanged, no `lastEnd` write.
- `UserPromptSubmit` `hook_stopped`: `session.lastEnd = { reason: 'hook_stopped' }`, `upsertSession`, then return.
- After `const end = yield* queryLoop(...)`: `session.lastEnd = persistableLastEnd(end)` before the existing `upsertSession`. If `session.job` and `end.reason === 'completed'`, `clearSessionJobError(session)` on that same upsert.
- After `maybeCommitJob`: if `result.notice` and not `result.committed`, `setSessionJobError(session, result.notice)` and upsert again (or include in the same write if you reorder). If `result.committed`, `clearSessionJobError`.

`persistableLastEnd` uses ruling 3 (stringify `error`).

`rewindToCheckpoint`: on git reset fail, `setSessionJobError(opts.session, notice)` then upsert if the caller does not. Prefer setting on `opts.session` in `rewindToCheckpoint` and upserting there (it already upserts todos). On success, `clearSessionJobError`.

`openDraftPr` / `applySessionDraftPr`: do not take a session today. Set/clear in the **callers** (`slash/dispatch.ts` `/pr`, `serve.ts` POST pr). Task 2 owns dispatch `/pr` and enter-worktree: on `!entered.ok` call `setSessionJobError` + upsert; on success `clearSessionJobError`. Task 3/7 will add the same two lines on serve POST pr if not already there — add them in this task in `serve.ts` **only if** you can do it as two lines next to the existing `out.ok` branch. If that collides with Task 3’s snapshot work, put serve `/pr` jobError in Task 3.

`maybeCommitJob` itself stays notice-only; the engine applies the helper.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/loop/session-engine.test.ts packages/core/src/session/job.test.ts packages/core/src/session/rewind.test.ts packages/cli/src/slash/dispatch.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop/session-engine.ts packages/core/src/loop/session-engine.test.ts \
  packages/core/src/session/job.ts packages/core/src/session/job.test.ts \
  packages/core/src/session/rewind.ts packages/core/src/session/rewind.test.ts \
  packages/cli/src/slash/dispatch.ts
git commit -m "feat: persist lastEnd after real turns and jobError after job epilogues"
```

---

### Task 3: GET snapshot carries host fields

**Files:**
- Modify: `packages/cli/src/serve.ts` (GET `/v1/session/:id` body + stdout banner only), `packages/cli/src/serve.test.ts` (snapshot tests), `docs/headless.md`

**Interfaces:**
- Consumes: `SessionRecord.title`, `jobAutoCommit`, `lastEnd`, `jobError`, `followup`
- Produces: snapshot body from the spec

- [ ] **Step 1: Write the failing serve test**

Extend `GET /v1/session/:id returns job and parked callIds` and add:

```ts
test('GET /v1/session/:id includes title, jobAutoCommit, lastEnd, jobError, queued', async () => {
  const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
  const runtime = await ctx.runtimeForSession('s1')
  if (!runtime) throw new Error('expected runtime')
  runtime.engine.session = {
    id: 's1',
    title: 'fix login',
    permissionMode: 'default',
    jobAutoCommit: true,
    lastEnd: { reason: 'cancelled' },
    jobError: 'gh missing',
    followup: 'run tests',
    job: {
      baseBranch: 'main',
      shadowBranch: 'raven/s1',
      baseCommitSha: 'abc',
      worktreePath: '/tmp/wt',
    },
  }
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1', {
      headers: { authorization: 'Bearer secret' },
    }),
    ctx,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as Record<string, unknown>
  expect(body.title).toBe('fix login')
  expect(body.jobAutoCommit).toBe(true)
  expect(body.lastEnd).toEqual({ reason: 'cancelled' })
  expect(body.jobError).toBe('gh missing')
  expect(body.queued).toBe('run tests')
  expect(body.live).toBe(true)
})

test('GET /v1/session/:id queued is null when followup is unset', async () => {
  const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1', {
      headers: { authorization: 'Bearer secret' },
    }),
    ctx,
  )
  const body = (await res.json()) as { queued: string | null; jobAutoCommit: boolean }
  expect(body.queued).toBeNull()
  expect(body.jobAutoCommit).toBe(false)
})
```

Existing snapshot test must still pass; add `queued: null` and `jobAutoCommit: false` expectations there too.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/cli/src/serve.test.ts`

Expected: FAIL — body lacks the new keys.

- [ ] **Step 3: Implement the GET body**

Replace the GET handler object with:

```ts
const session = engine.session
const body = {
  id: session.id,
  jobAutoCommit: session.jobAutoCommit === true,
  pendingAsks,
  lastSeq,
  permissionMode: session.permissionMode,
  live: (engine.liveTurnId?.() ?? null) !== null,
  queued: session.followup ?? null,
}
if (session.title !== undefined) body.title = session.title
if (session.job !== undefined) body.job = session.job
if (session.lastEnd !== undefined) body.lastEnd = session.lastEnd
if (session.jobError !== undefined) body.jobError = session.jobError
```

If serve POST `/pr` did not get jobError in Task 2, add set/clear here next to the existing `out.ok` branch.

`docs/headless.md`: document GET fields (`title`, `jobAutoCommit`, `lastEnd`, `jobError`, `queued`). Do not invent stream version.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/serve.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve.ts packages/cli/src/serve.test.ts docs/headless.md
git commit -m "feat: expose lastEnd, jobError, and queued on GET session snapshot"
```

---

### Task 4: One-slot follow-up persist + routes + `/follow`

**Files:**
- Create: `packages/core/src/session/followup.ts`, `followup.test.ts`
- Modify: `session-engine.ts` (three methods only), `types.ts` (`SessionEngine` three methods), `index.ts`, `serve.ts` (POST/DELETE followup + `queued` already from Task 3), `commands.ts`, `commands.test.ts`, `slash/dispatch.ts`, `slash/dispatch.test.ts`

**Interfaces:**
- Consumes: `SessionRecord.followup`, `upsertSession`
- Produces:

```ts
setFollowup(text: string): Promise<{ ok: true } | { ok: false; notice: string }>
clearFollowup(): Promise<void>
getFollowup(): string | null
```

Do **not** implement `maybeRunFollowup` in this task.

- [ ] **Step 1: Write the failing tests**

`followup.test.ts` (pure helpers if you extract `normalizeFollowupText`; otherwise test through a fake session):

```ts
test('setFollowup overwrites; empty is an error; clear removes', async () => {
  const session = { id: 's1', updatedAt: 0 } as SessionRecord
  const store = { upsertSession: async (s: SessionRecord) => { Object.assign(session, s) } }
  const api = createFollowupApi(() => session, store)
  expect(await api.setFollowup('  ')).toEqual({ ok: false, notice: 'follow-up text required' })
  expect(session.followup).toBeUndefined()
  expect(await api.setFollowup('first')).toEqual({ ok: true })
  expect(await api.setFollowup('second')).toEqual({ ok: true })
  expect(api.getFollowup()).toBe('second')
  await api.clearFollowup()
  expect(api.getFollowup()).toBeNull()
})
```

You may implement the three methods directly on the engine instead of `createFollowupApi` — then write the same assertions against `createSessionEngine`. Prefer engine tests in `session-engine.test.ts` if that is smaller.

`serve.test.ts`:

```ts
test('POST /v1/session/:id/followup overwrites; DELETE clears; empty is 400', async () => {
  const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
  const runtime = await ctx.runtimeForSession('s1')
  if (!runtime) throw new Error('expected runtime')
  runtime.engine.setFollowup = async (text: string) => {
    if (text.trim() === '') return { ok: false as const, notice: 'follow-up text required' }
    runtime.engine.session.followup = text
    return { ok: true as const }
  }
  runtime.engine.clearFollowup = async () => {
    delete runtime.engine.session.followup
  }
  runtime.engine.getFollowup = () => runtime.engine.session.followup ?? null

  const bad = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/followup', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    }),
    ctx,
  )
  expect(bad.status).toBe(400)

  await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/followup', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'first' }),
    }),
    ctx,
  )
  await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/followup', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'second' }),
    }),
    ctx,
  )
  expect(runtime.engine.session.followup).toBe('second')

  const del = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/followup', {
      method: 'DELETE',
      headers: { authorization: 'Bearer secret' },
    }),
    ctx,
  )
  expect(del.status).toBe(200)
  expect(await del.json()).toEqual({ ok: true, queued: null })
})
```

`commands.test.ts`: parse `/follow`, `/follow run tests`, `/follow clear`.

`dispatch.test.ts`: `/follow` with no arg prints `no follow-up` or the text; `/follow clear` clears.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/session/followup.test.ts packages/cli/src/serve.test.ts packages/cli/src/commands.test.ts packages/cli/src/slash/dispatch.test.ts`

Expected: FAIL — route 404 / methods missing.

- [ ] **Step 3: Implement persist + routes + slash**

`followup.ts`:

```ts
export function followupNotice(text: string | null): string {
  return text == null || text === '' ? 'no follow-up' : text
}

export async function writeFollowup(
  session: SessionRecord,
  store: { upsertSession(session: SessionRecord): Promise<void> },
  text: string | null,
): Promise<{ ok: true } | { ok: false; notice: string }> {
  if (text !== null) {
    const trimmed = text.trim()
    if (trimmed === '') return { ok: false, notice: 'follow-up text required' }
    session.followup = trimmed
  } else {
    delete session.followup
  }
  session.updatedAt = Date.now()
  await store.upsertSession(session)
  return { ok: true }
}
```

Engine methods call `writeFollowup`. Extend `SESSION_PATH` with `followup`. POST body `{ text: string }`; missing/empty → 400 `{ error: 'follow-up text required' }`. Success 200 `{ ok: true, queued: text }`. DELETE 200 `{ ok: true, queued: null }` even if already empty. Neither calls `submitMessage`.

Slash: `{ name: 'follow', usage: '/follow [text|clear]', summary: 'set, show, or clear the one-slot next-turn follow-up' }`. Dispatch: no arg → `followupNotice(getFollowup())`; `clear` → `clearFollowup()` + `no follow-up`; else `setFollowup(arg)`.

Do not touch `/queue`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/session/followup.test.ts packages/core/src/loop/session-engine.test.ts packages/cli/src/serve.test.ts packages/cli/src/commands.test.ts packages/cli/src/slash/dispatch.test.ts`

Expected: PASS. Existing `/queue` tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/followup.ts packages/core/src/session/followup.test.ts \
  packages/core/src/loop/session-engine.ts packages/core/src/types.ts packages/core/src/index.ts \
  packages/cli/src/serve.ts packages/cli/src/serve.test.ts \
  packages/cli/src/commands.ts packages/cli/src/commands.test.ts \
  packages/cli/src/slash/dispatch.ts packages/cli/src/slash/dispatch.test.ts
git commit -m "feat: persist a one-slot follow-up and expose it on serve and /follow"
```

---

### Task 5: Follow-up host epilogue

**Files:**
- Modify: `packages/core/src/session/followup.ts`, `followup.test.ts`, `packages/cli/src/serve.ts` (`consumeSubmit` + POST submit), `serve.test.ts`, `packages/cli/src/app.tsx`, `packages/cli/src/opentui-app.ts`

**Interfaces:**
- Consumes: `setFollowup` / `clearFollowup` / `getFollowup` / `listPendingAsks` / `submitMessage`
- Produces:

```ts
export async function maybeRunFollowup(opts: {
  engine: Pick<SessionEngine, 'submitMessage' | 'getFollowup' | 'clearFollowup' | 'liveTurnId'>
  listPendingAsks: () => Promise<unknown[]>
  lastEnd: RoundEnd
  chain?: boolean
}): Promise<'ran' | 'cleared' | 'skipped'>
```

When `'ran'`, the function persist-clears then `for await`/`drain`s `submitMessage({ text, turnPolicy: 'queue' })`. It does **not** call itself on that inner return (`chain` is for the **caller**: serve calls `maybeRunFollowup` once more with `chain: true` on the inner end, or the helper takes `chain` and refuses to run if `chain === true`).

Lock: **caller** (serve / TUI) does:

```ts
const end = await consumeSubmit(engine.submitMessage(input))
let flag = await maybeRunFollowup({ engine, listPendingAsks, lastEnd: end })
if (flag === 'ran' && innerEnd) {
  await maybeRunFollowup({ engine, listPendingAsks, lastEnd: innerEnd, chain: true })
}
```

Simpler lock that implementers must use: `maybeRunFollowup` runs at most one `submitMessage`. It does not recurse. Serve/TUI call it **once** per original host submit. A slot set *during* that follow-up turn stays for the next host submit.

- [ ] **Step 1: Write the failing helper test**

```ts
test('maybeRunFollowup persist-clears then submits on completed; cancel clears; pending skips', async () => {
  const submitted: string[] = []
  const session = { followup: 'next please' } as SessionRecord
  const engine = {
    getFollowup: () => session.followup ?? null,
    clearFollowup: async () => {
      delete session.followup
    },
    liveTurnId: () => null,
    async *submitMessage(input: UserSubmitInput) {
      submitted.push(typeof input === 'string' ? input : (input.text ?? ''))
    },
  }
  const ran = await maybeRunFollowup({
    engine,
    listPendingAsks: async () => [],
    lastEnd: { reason: 'completed' },
  })
  expect(ran).toBe('ran')
  expect(session.followup).toBeUndefined()
  expect(submitted).toEqual(['next please'])

  session.followup = 'nope'
  const cleared = await maybeRunFollowup({
    engine,
    listPendingAsks: async () => [],
    lastEnd: { reason: 'cancelled' },
  })
  expect(cleared).toBe('cleared')
  expect(submitted).toEqual(['next please'])
  expect(session.followup).toBeUndefined()

  session.followup = 'wait'
  const skipped = await maybeRunFollowup({
    engine,
    listPendingAsks: async () => [{ callId: 'x' }],
    lastEnd: { reason: 'completed' },
  })
  expect(skipped).toBe('skipped')
  expect(session.followup).toBe('wait')
})

test('maybeRunFollowup does not submit when clearFollowup throws', async () => {
  const submitted: string[] = []
  const engine = {
    getFollowup: () => 'keep',
    clearFollowup: async () => {
      throw new Error('disk')
    },
    liveTurnId: () => null,
    async *submitMessage(input: UserSubmitInput) {
      submitted.push(typeof input === 'string' ? input : (input.text ?? ''))
    },
  }
  const result = await maybeRunFollowup({
    engine,
    listPendingAsks: async () => [],
    lastEnd: { reason: 'completed' },
  })
  expect(result).toBe('skipped')
  expect(submitted).toEqual([])
})
```

Serve test: stub `submitMessage` that records calls; POST followup, then POST submit whose stub return is `{ reason: 'completed' }` (change the makeServeCtx generator to `return { reason: 'completed' }`). After consume finishes, expect a second `submitted` entry equal to the follow-up text. A second test: stub return `{ reason: 'cancelled' }` → follow-up cleared, no second submit.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/session/followup.test.ts packages/cli/src/serve.test.ts`

Expected: FAIL — `maybeRunFollowup` missing; submit does not chain.

- [ ] **Step 3: Implement the epilogue**

```ts
const RUN_REASONS = new Set(['completed', 'hook_stopped', 'max_rounds', 'context_full'])
const CLEAR_REASONS = new Set([
  'cancelled',
  'aborted',
  'model_error',
  'persist_failed',
  'results_persist_failed',
])

export async function maybeRunFollowup(opts: {
  engine: {
    submitMessage: SessionEngine['submitMessage']
    getFollowup: () => string | null
    clearFollowup: () => Promise<void>
    liveTurnId: () => string | null
  }
  listPendingAsks: () => Promise<unknown[]>
  lastEnd: RoundEnd
  chain?: boolean
}): Promise<'ran' | 'cleared' | 'skipped'> {
  if (opts.chain === true) return 'skipped'
  if (opts.engine.liveTurnId() !== null) return 'skipped'
  const text = opts.engine.getFollowup()
  if (text == null) return 'skipped'
  if (CLEAR_REASONS.has(opts.lastEnd.reason)) {
    await opts.engine.clearFollowup()
    return 'cleared'
  }
  if (!RUN_REASONS.has(opts.lastEnd.reason)) return 'skipped'
  if ((await opts.listPendingAsks()).length > 0) return 'skipped'
  try {
    await opts.engine.clearFollowup()
  } catch {
    return 'skipped'
  }
  const gen = opts.engine.submitMessage({ text, turnPolicy: 'queue' })
  while (true) {
    const next = await gen.next()
    if (next.done) return 'ran'
  }
}
```

Change `consumeSubmit` to return `unknown` (the generator return). In POST submit’s `singleFlight` callback: `const end = await consumeSubmit(...)` then `maybeRunFollowup({ engine, listPendingAsks: () => store.listPendingAsks(sid), lastEnd: end as RoundEnd })`. Guard `end` with a `reason` check; if the stub/generator returns undefined, skip.

TUI `app.tsx` / `opentui-app.ts`: after `next.done`, call `maybeRunFollowup`. If `'ran'`, do **not** also `dequeue` `/queue` for that cycle (slot wins). If `'skipped'` / `'cleared'`, keep today’s leftover / queue / loop / mailbox order.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/session/followup.test.ts packages/cli/src/serve.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/followup.ts packages/core/src/session/followup.test.ts \
  packages/cli/src/serve.ts packages/cli/src/serve.test.ts \
  packages/cli/src/app.tsx packages/cli/src/opentui-app.ts
git commit -m "feat: run or clear the follow-up slot after a host turn returns"
```

---

### Task 6: rewindLast returns droppedText and refuses pending asks

**Files:**
- Modify: `packages/core/src/session/rewind.ts`, `rewind.test.ts`, `packages/core/src/loop/session-engine.ts` (`rewindLast` only), existing rewind tests, `packages/core/src/types.ts` (`rewindLast` return)

**Interfaces:**
- Consumes: existing `rewindLastTurn` / `rewindToCheckpoint`
- Produces: `{ ok, notice, droppedText? }`

- [ ] **Step 1: Write the failing tests**

In `rewind.ts` add and test:

```ts
export function lastUserText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== 'user') continue
    const parts = msg.blocks.filter((b) => b.type === 'text').map((b) => b.text)
    const text = parts.join('')
    return text === '' ? undefined : text
  }
  return undefined
}
```

```ts
test('lastUserText concatenates text blocks and ignores images', () => {
  expect(
    lastUserText([
      { id: 'u', role: 'user', createdAt: 1, blocks: [
        { type: 'text', text: 'fix ' },
        { type: 'image', mediaType: 'image/png', data: 'x' },
        { type: 'text', text: 'login' },
      ] },
    ]),
  ).toBe('fix login')
})
```

Engine / rewind integration (extend the existing two-turn job rewind test in `rewind.test.ts`):

```ts
test('rewindLast returns droppedText and refuses when a pending ask exists', async () => {
  // existing two-turn setup ...
  const ok = await engine.rewindLast()
  expect(ok.ok).toBe(true)
  expect(ok.droppedText).toBe('second prompt')

  await store.upsertPendingAsk({
    callId: 'parked',
    sessionId: engine.session.id,
    kind: 'leftover',
    tool: 'Bash',
    message: 'Bash?',
    input: { command: 'ls' },
    createdAt: Date.now(),
  })
  const refused = await engine.rewindLast()
  expect(refused).toEqual({ ok: false, notice: 'pending permission ask' })
})
```

Wire this onto the existing two-turn fixture rather than inventing a third git repo helper if one already exists in `rewind.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/session/rewind.test.ts`

Expected: FAIL — `droppedText` missing; pending ask still rewinds.

- [ ] **Step 3: Implement**

`rewindLast` in the engine, **before** any rewind:

```ts
const pending = await listOwnedPendingAsks()
for (const row of pending) {
  if (!(await isCallPaired(row.callId, row.sessionId))) {
    return { ok: false, notice: 'pending permission ask' }
  }
}
const droppedText = lastUserText(messages)
```

Then existing live-turn / running-agent checks, then job vs no-job rewind. Include `droppedText` on success only (omit when `ok` is false, including “nothing to rewind”).

`/rewind` dispatch still prints `notice` only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/session/rewind.test.ts packages/core/src/loop/session-engine.test.ts packages/cli/src/slash/dispatch.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/rewind.ts packages/core/src/session/rewind.test.ts \
  packages/core/src/loop/session-engine.ts packages/core/src/types.ts
git commit -m "feat: rewindLast returns droppedText and refuses parked leftover-ask"
```

---

### Task 7: POST `/edit` and TUI `/retry`

**Files:**
- Modify: `serve.ts` (`POST …/edit`), `serve.test.ts`, `commands.ts`, `commands.test.ts`, `app.tsx`, `opentui-app.ts`, `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md`

**Interfaces:**
- Consumes: `rewindLast()`, `submitMessage`, `singleFlight`
- Produces: `POST /v1/session/:id/edit` `{ text: string }`

- [ ] **Step 1: Write the failing tests**

```ts
test('POST /v1/session/:id/edit rewinds then submits; empty is 400; pending refuses', async () => {
  const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
  const runtime = await ctx.runtimeForSession('s1')
  if (!runtime) throw new Error('expected runtime')
  let rewindCalls = 0
  runtime.engine.rewindLast = async () => {
    rewindCalls += 1
    return { ok: true, notice: 'dropped 2 messages', droppedText: 'old prompt' }
  }

  const empty = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/edit', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    }),
    ctx,
  )
  expect(empty.status).toBe(400)
  expect(rewindCalls).toBe(0)

  const ok = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/edit', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'new prompt' }),
    }),
    ctx,
  )
  expect(ok.status).toBe(202)
  expect(await ok.json()).toEqual({
    accepted: true,
    sessionId: 's1',
    droppedText: 'old prompt',
  })
  expect(rewindCalls).toBe(1)
  expect(ctx.submitted).toEqual([{ text: 'new prompt', turnPolicy: 'queue' }])

  runtime.engine.rewindLast = async () => ({ ok: false, notice: 'pending permission ask' })
  const refused = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/edit', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    }),
    ctx,
  )
  expect(refused.status).toBe(200)
  expect(await refused.json()).toEqual({ ok: false, notice: 'pending permission ask' })
  expect(ctx.submitted).toHaveLength(1)
})
```

`commands.test.ts`: `/retry`, `/retry new text`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/serve.test.ts packages/cli/src/commands.test.ts`

Expected: FAIL — 404 on `/edit`.

- [ ] **Step 3: Implement**

Extend `SESSION_PATH` with `edit` if Task 4 did not already use a shared regex that includes it (Task 4 adds `followup`; this task adds `edit`).

```ts
if (req.method === 'POST' && action === 'edit') {
  const parsedBody = await readJsonBody(req)
  if (!parsedBody.ok) return parsedBody.res
  const rec = parsedBody.body
  const text =
    rec !== null && typeof rec === 'object' && typeof (rec as { text?: unknown }).text === 'string'
      ? (rec as { text: string }).text
      : ''
  if (text.trim() === '') return Response.json({ error: 'text required' }, { status: 400 })
  const loaded = await loadSessionRuntime(ctx, sessionId)
  if (!loaded.ok) return loaded.res
  const rewound = await loaded.runtime.engine.rewindLast()
  if (!rewound.ok) {
    return Response.json({
      ok: false,
      notice: rewound.notice,
      ...(rewound.droppedText !== undefined ? { droppedText: rewound.droppedText } : {}),
    })
  }
  const sid = loaded.runtime.engine.session.id
  void singleFlight(ctx.turnFlights, sid, async () => {
    const end = await consumeSubmit(
      loaded.runtime.engine.submitMessage({ text, turnPolicy: 'queue' }),
    )
    if (end && typeof end === 'object' && 'reason' in end) {
      await maybeRunFollowup({
        engine: loaded.runtime.engine,
        listPendingAsks: () => loaded.runtime.store.listPendingAsks?.(sid) ?? [],
        lastEnd: end as RoundEnd,
      })
    }
  })
  return Response.json(
    { accepted: true, sessionId: sid, ...(rewound.droppedText !== undefined ? { droppedText: rewound.droppedText } : {}) },
    { status: 202 },
  )
}
```

Add `/retry` to `SLASH_COMMANDS` and `HOST_ONLY`. In `app.tsx` / `opentui-app.ts` host-only handler (next to `/diff`):

- no arg: `rewindLast()`; notice; if ok and `droppedText`, put it in the composer (`setInput` / equivalent). Do not `runTurn`.
- arg: `rewindLast()`; if ok, `runTurn(arg)`.

`SLASH_COMMANDS.md` / `.ko.md`: document `/retry` and `/follow`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/serve.test.ts packages/cli/src/commands.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve.ts packages/cli/src/serve.test.ts \
  packages/cli/src/commands.ts packages/cli/src/commands.test.ts \
  packages/cli/src/app.tsx packages/cli/src/opentui-app.ts \
  SLASH_COMMANDS.md SLASH_COMMANDS.ko.md
git commit -m "feat: compose rewind and submitMessage as POST /edit and /retry"
```

---

### Task 8: jobDiff helper

**Files:**
- Create: `packages/core/src/session/job-diff.ts`, `job-diff.test.ts`
- Modify: `packages/core/src/index.ts` (export `jobDiff` + types)

**Interfaces:**
- Consumes: `SessionJob`, `runGit`
- Produces:

```ts
export type JobDiffOp = 'create' | 'update' | 'delete' | 'rename'
export type JobDiffFile = { path: string; op: JobDiffOp; plus: number; minus: number; from?: string }
export type JobDiff = {
  ok: true
  baseCommitSha: string
  shadowBranch: string
  head: string
  dirty: boolean
  files: JobDiffFile[]
}
export function jobDiff(job: SessionJob): JobDiff | { ok: false; notice: string }
```

- [ ] **Step 1: Write the failing test**

Use a temp git repo (copy the helper from `job.test.ts` / `rewind.test.ts`):

```ts
test('jobDiff lists committed create plus dirty update; rename has from', () => {
  const repo = initRepo()
  const base = revParse(repo)
  write(repo, 'added.txt', 'one\n')
  git(repo, ['add', 'added.txt'])
  git(repo, ['commit', '-m', 'add'])
  write(repo, 'added.txt', 'one\ntwo\n')
  const job: SessionJob = {
    baseBranch: 'main',
    shadowBranch: 'raven/t',
    baseCommitSha: base,
    worktreePath: repo,
  }
  const diff = jobDiff(job)
  expect(diff.ok).toBe(true)
  if (!diff.ok) return
  expect(diff.dirty).toBe(true)
  expect(diff.files.some((f) => f.path === 'added.txt' && f.op === 'create' && f.plus >= 1)).toBe(true)

  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'two'])
  git(repo, ['mv', 'added.txt', 'renamed.txt'])
  const renamed = jobDiff(job)
  expect(renamed.ok).toBe(true)
  if (!renamed.ok) return
  const row = renamed.files.find((f) => f.path === 'renamed.txt')
  expect(row?.op).toBe('rename')
  expect(row?.from).toBe('added.txt')
})

test('jobDiff on a missing worktree is ok: false', () => {
  const diff = jobDiff({
    baseBranch: 'main',
    shadowBranch: 'raven/t',
    baseCommitSha: 'abc',
    worktreePath: '/no/such/worktree',
  })
  expect(diff.ok).toBe(false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/core/src/session/job-diff.test.ts`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
function parseNameStatus(stdout: string): Array<{ op: JobDiffOp; path: string; from?: string }> {
  const rows = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const parts = line.split('\t')
    const code = parts[0]?.[0]
    if (code === 'A') rows.push({ op: 'create' as const, path: parts[1] ?? '' })
    else if (code === 'D') rows.push({ op: 'delete' as const, path: parts[1] ?? '' })
    else if (code === 'R') rows.push({ op: 'rename' as const, from: parts[1], path: parts[2] ?? '' })
    else rows.push({ op: 'update' as const, path: parts[1] ?? '' })
  }
  return rows
}
```

Committed: `git diff --name-status --find-renames <baseCommitSha> HEAD` and `git diff --numstat --find-renames <baseCommitSha> HEAD`. Dirty: `git diff --name-status HEAD` plus `git diff --cached --name-status HEAD`, and the matching numstat. Merge by path: dirty plus/minus add; if a path is only dirty, include it (`create` if untracked via `git ls-files --others --exclude-standard`, else `update`). `dirty` is true when porcelain is nonempty. `head` is `rev-parse HEAD`. Any `runGit` failure → `{ ok: false, notice }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/session/job-diff.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/job-diff.ts packages/core/src/session/job-diff.test.ts \
  packages/core/src/index.ts
git commit -m "feat: add jobDiff for base...HEAD union dirty"
```

---

### Task 9: GET `/diff` and TUI `/diff` on a job

**Files:**
- Modify: `serve.ts` (`GET …/diff`), `serve.test.ts`, `diff-cmd.ts`, `diff-cmd.test.ts`, `commands.ts` (`/diff` summary only), `diff-panel.tsx` only if the formatter needs a job header

**Interfaces:**
- Consumes: `jobDiff`, `session.job`
- Produces: `GET /v1/session/:id/diff`

- [ ] **Step 1: Write the failing tests**

```ts
test('GET /v1/session/:id/diff without a job is a notice', async () => {
  const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1/diff', {
      headers: { authorization: 'Bearer secret' },
    }),
    ctx,
  )
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: false, notice: 'no job record' })
})
```

For a job hit, stub is not enough (`jobDiff` hits git). Either set `session.job.worktreePath` to a temp repo (copy Task 8 helper into the serve test) or inject nothing and assert `ok: false` on a fake path, plus a unit test that `loadGitDiff` with a job calls `jobDiff` — prefer a small `formatJobDiffPanel(diff: JobDiff)` in `diff-cmd.ts` tested without HTTP.

```ts
test('formatJobDiffPanel lists op and plus/minus', () => {
  const lines = formatJobDiffPanel({
    ok: true,
    baseCommitSha: 'aaa',
    shadowBranch: 'raven/s',
    head: 'bbb',
    dirty: true,
    files: [{ path: 'a.ts', op: 'create', plus: 3, minus: 0 }],
  })
  expect(lines[0]).toContain('raven/s')
  expect(lines.some((l) => l.includes('a.ts') && l.includes('create'))).toBe(true)
})
```

Existing `loadGitDiff(cwd)` tests stay on the no-job path.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/cli/src/serve.test.ts packages/cli/src/diff-cmd.test.ts`

Expected: FAIL — 404 / helper missing.

- [ ] **Step 3: Implement**

`SESSION_PATH` add `diff`. GET:

```ts
if (req.method === 'GET' && action === 'diff') {
  const loaded = await loadSessionRuntime(ctx, sessionId)
  if (!loaded.ok) return loaded.res
  const job = loaded.runtime.engine.session.job
  if (!job) return Response.json({ ok: false, notice: 'no job record' })
  const diff = jobDiff(job)
  if (!diff.ok) return Response.json(diff)
  return Response.json(diff)
}
```

`loadGitDiff` stays cwd-only. Add `loadSessionDiff(session): GitDiffView | JobDiff panel`. TUI `/diff` handler (host-only in `app.tsx`): if `engine.session.job`, render `formatJobDiffPanel(jobDiff(job))`; else today’s `loadGitDiff(cwd)`.

`/diff` summary: `open git diff; job sessions show base...HEAD ∪ dirty`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/serve.test.ts packages/cli/src/diff-cmd.test.ts packages/cli/src/commands.test.ts`

Expected: PASS. No-job `/diff` tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve.ts packages/cli/src/serve.test.ts \
  packages/cli/src/diff-cmd.ts packages/cli/src/diff-cmd.test.ts \
  packages/cli/src/app.tsx packages/cli/src/opentui-app.ts \
  packages/cli/src/commands.ts
git commit -m "feat: serve GET /diff and show job range in TUI /diff"
```

If `app.tsx` / `opentui-app.ts` were not needed (diff already goes through `loadGitDiff` and you routed there), do not add them to the commit.

---

### Task 10: Eval fixtures

**Files:**
- Create: `packages/core/src/eval/fixtures/snapshot-end-reason/case.json`, `followup-slot/case.json`, `edit-resubmit/case.json`, `job-diff/case.json`
- Modify: `packages/core/src/eval/run.ts`, `run.test.ts` (only if the existing test name is fixture-specific — keep the one `runEvalDir` smoke)

**Interfaces:**
- Consumes: engine `lastEnd`, `setFollowup` / `maybeRunFollowup`, `rewindLast`, `jobDiff`
- Produces: four path-identity fixtures; unknown names still throw

- [ ] **Step 1: Write failing fixtures**

`snapshot-end-reason/case.json`:

```json
{ "prompt": "start then cancel", "expect": { "lastEndCancelled": true } }
```

`followup-slot/case.json`:

```json
{ "prompt": "do work", "expect": { "followupRan": true } }
```

`edit-resubmit/case.json`:

```json
{ "prompt": "first", "expect": { "editResubmit": true } }
```

`job-diff/case.json`:

```json
{ "prompt": "unused", "expect": { "jobDiffListsDirty": true } }
```

Add the four flags to `EvalExpect`. Dispatch by directory name next to the existing `if (name === …)` chain. **Do not** add an authored `id`.

Implement the runners so they throw the gated error when the contract is missing (copy `runCancelNotFail` / `runJobShadowBranch` style). Then temporarily leave the dispatch `throw new Error('unknown eval fixture: …')` **out** for the new names so Step 2 fails with `unknown eval fixture`.

- [ ] **Step 2: Run eval to verify it fails**

Run: `bun test packages/core/src/eval/run.test.ts`

Expected: FAIL — `unknown eval fixture: edit-resubmit` (or the first new name in sort order: `edit-resubmit`).

- [ ] **Step 3: Implement the four runners**

`runSnapshotEndReason`: same hang+`abort('cancel')` as `runCancelNotFail`, then assert `engine.session.lastEnd?.reason === 'cancelled'`. Upsert a leftover pending ask and `submitMessage('again')`; assert `lastEnd.reason` still `'cancelled'`.

`runFollowupSlot`: `await engine.setFollowup('from slot')`, complete a one-shot provider turn, `await maybeRunFollowup(...)`, assert a user row with `from slot`. Second case in the same runner: set slot, cancel, `maybeRunFollowup` on `{ reason: 'cancelled' }`, assert no user row with that text and `getFollowup() === null`.

`runEditResubmit`: two completed turns (`first` / `second`), `rewindLast()`, assert `droppedText === 'second'` (or the second prompt you sent). No-job path is enough (file-history). Then `submitMessage('edited')` and assert the last user text is `edited`.

`runJobDiff`: `enterSessionWorktree`, commit one file on the shadow, dirty another, `jobDiff(job)` lists both. Reuse `initGitRepo` from `runJobShadowBranch`.

- [ ] **Step 4: Run eval to verify it passes**

Run: `bun test packages/core/src/eval/run.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/eval
git commit -m "test: lock job-host state contracts in raven eval"
```

---

### Task 11: Docs match the new waist

**Files:**
- Modify: `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-09-17-job-host-state-roadmap.md` (add `Implementation plan:` pointer only)

**Interfaces:** none. No production code.

- [ ] **Step 1: Update the docs**

`CHANGELOG.md` Unreleased Added: schema **10** (`last_end_json`, `job_error`, `followup_text`); GET snapshot fields; `POST/DELETE …/followup`; `POST …/edit`; `GET …/diff`; `/follow`; `/retry`; job-range `/diff`. Point at the spec. Do not mark the horizon shipped until it lands on `main`.

`ARCHITECTURE.md` / `.ko.md`: serve list includes followup / edit / diff; snapshot fields; schema v10.

Spec header: `Implementation plan: [2026-09-17-job-host-state-implementation.md](../plans/2026-09-17-job-host-state-implementation.md)`.

`SLASH_COMMANDS` and `headless.md` were updated in Tasks 3 and 7 — do not revert.

- [ ] **Step 2: Commit**

```bash
git add ARCHITECTURE.md ARCHITECTURE.ko.md CHANGELOG.md \
  docs/superpowers/specs/2026-09-17-job-host-state-roadmap.md
git commit -m "docs: document job-host state snapshot, follow-up, edit, and job diff"
```

---

## Out of scope

Web UI, Prisma Task, Socket.IO, keep-id `/clear`, stream `version` / `continuationToken`, replacing `/queue`, `SuggestFollowups` as the slot, arbitrary mid-history edit, rewind persist-before-reset, `todo.json` re-project, WorkspaceFs docker-exec, live cancel abort-pair, official `/code-review`, merge, push.

---

## Self-review

**Spec coverage**

| Spec ID | Task |
|---|---|
| G0.1 docs point here | already on `main` at `077f5e8`; Task 11 adds the plan pointer |
| G0.2 snapshot lastEnd / jobError / jobAutoCommit / title | Tasks 1–3 |
| G1.1 persist slot | Task 4 |
| G1.2 host epilogue | Task 5 |
| G1.3 snapshot `queued` | Tasks 3–4 |
| G2.1 droppedText + pending refuse | Task 6 |
| G2.2 POST edit + `/retry` | Task 7 |
| G3.1 jobDiff | Task 8 |
| G3.2 GET/TUI diff | Task 9 |
| G4.1 eval | Task 10 |

**Placeholders:** none. **Types:** `followup` on the session, `queued` on GET, `maybeRunFollowup` returns `'ran' | 'cleared' | 'skipped'`, `jobDiff` returns `JobDiff | { ok: false; notice }` with `ok: true` on the success object so serve can spread it.
