# Rewind recovery, schema v11, async createSessionEngine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the compact-then-die rewind sliver with one SQLite write, persist `pendingResetSha` in `sessions.pending_reset_sha` (schema v11), and make `createSessionEngine` an async recover point without resetting GET snapshot.

**Architecture:** Migration 011 copies `job_json.pendingResetSha` into `pending_reset_sha` and dual-writes both. `recordCompactAndUpsertSession` is one `withWrite`/`beginImmediate`. `rewindToCheckpoint` persist-first via that method, then `git reset --hard`; a combined-write throw does not reset. `createSessionEngine` becomes `async` and awaits `maybeFinishRewindReset` when the flag is set. GET snapshot reads `store.loadSession` only; `live` comes from `ctx.liveRuntimes`. Mutating routes + stream + `/diff` still attach an engine.

**Tech Stack:** Bun, TypeScript, bun:sqlite, existing `SessionStore`, `createSessionEngine`, `runGit`, raven eval fixtures.

**Spec:** `docs/superpowers/specs/2026-09-20-rewind-recovery-v11.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers.
- Default prefix stays small and frozen. No new always-on tool.
- `dontAsk` never becomes `bypass`.
- BYOK is the product. Ads never touch BYOK.
- Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
- `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
- Leftover-ask still wins rewind. Edit-resubmit stays host composition.
- **Do not infer reset from `HEAD !== checkpoint`.**
- Do not change abort / I2 persist-before-drop / serve cancel `202`/`200` / tree-stop.
- Do not add `createSessionEngineSync`. Do not auto-reset on `loadSession`.
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push. Do not copy y0/eve source.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification.

1. **Column and bind.** `sessions.pending_reset_sha TEXT`. `sessionBind` adds `$pending_reset_sha: session.job?.pendingResetSha ?? null`. `SessionRow` adds `pending_reset_sha: string | null`. INSERT and UPSERT SQL both include the column. Clearing the flag writes SQL NULL and omits the JSON key (existing `delete job.pendingResetSha` + `JSON.stringify`).

2. **Load overlay** (after `jobFromJson`):

```ts
if (job && row.pending_reset_sha != null && row.pending_reset_sha !== '') {
  job.pendingResetSha = row.pending_reset_sha
}
```

Empty/NULL column keeps the `job_json` value. A non-empty column wins. No job → ignore the column.

3. **Store method** (add to `SessionStore`, sqlite, memory, and the `types.test.ts` stub):

```ts
recordCompactAndUpsertSession(opts: {
  session: SessionRecord
  inactivatedIds: string[]
  generation: number
  summary?: string
}): Promise<void>
```

Sqlite: `withWrite` → `beginImmediate` → if `inactivatedIds.length > 0` then existing `recordCompactTx` + `unindexMessagesFts`; always `upsertSessionSql.run(sessionBind(opts.session))`. Memory: `withWrite` with the same snapshot/restore pattern as `clearConversation`; compact then `sessions.set`. Summary default `'rewind'`.

4. **`rewindToCheckpoint` persist-first.** Do not assign `opts.session.job.pendingResetSha` until the combined write resolves. Combined-write throw: `{ ok: false, notice: 'rewind persist failed', messages: opts.messages }`, no `git reset`. Success: assign the flagged job onto `opts.session`, then `runGit(..., ['reset', '--hard', sha])`. Reset-fail keeps the flag (I3.3). Empty `droppedIds` still calls the method (flag upsert only). Do **not** call `recordCompact` on this path. No-job `rewindLastTurn` still uses `recordCompact`.

5. **Factory recover** (end of `createSessionEngine`, after the engine object exists):

```ts
if (session.job?.pendingResetSha) {
  await maybeFinishRewindReset({ session, store: opts.store, messages })
}
return engine
```

Do not throw on `{ ok: false }`. Use the rewind helper, not `engine.maybeFinishRewindReset()` (live-turn no-op is irrelevant at construct; keep that no-op on the method).

6. **GET snapshot split.** Add required `store: SessionStore` to `ServeRequestContext`. `runServe` passes `shared.store`. GET `/v1/session/:id` calls `store.loadSession` only — **not** `loadSessionRuntime` / `runtimeForSession` / `createSessionEngine`. `live` from `ctx.liveRuntimes` only. Pending asks via existing `listOwnedPendingAsks(store, sessionId)`. `lastSeq` via `store.lastStreamSeq`. Mutating routes + stream + `/diff` stay on `loadSessionRuntime`. `makeServeCtx` creates default session `s1`, includes `store` on the typed ctx, and sets `liveRuntimes: () => [['s1', runtime]]` so existing `live: true` assertions stay. Tests that mutate `engine.session` for GET snapshot also `upsertSession` those fields.

7. **Call-site blast at `a707249`:** 176 `createSessionEngine(` call sites + 1 export. Mechanical `await createSessionEngine(` on every call. `ReturnType<typeof createSessionEngine>` → `Awaited<ReturnType<typeof createSessionEngine>>` (ACP tests ×3, `session-engine.test.ts` `drain`). `Parameters<typeof createSessionEngine>[0]` stays. ACP `engineFactory` stays sync: `await createSessionEngine` **before** `createAcpServer`, close over the engine. Production `acp-stdio.ts` already `wrapBoot(Promise)` — do not change `handleSessionNew`. No `createSessionEngineSync`.

8. **Flip construct-must-not-reset tests.** `session-engine.test.ts` `submitMessage finishes a pending rewind reset; construct does not` → construct **does** reset and clears the flag; submit is then a no-op on the flag. `rewindLast finishes a pending reset and does not drop another turn` must set the flag **after** construct (live-engine retry), not pass it into the factory. Eval `rewind-reset-on-resume` expects construct to finish the reset.

9. **Do not change abort / I2 / 202 / tree-stop.** Leftover-ask door overlap: `packages/core/src/loop/session-engine.ts`, `packages/cli/src/serve.ts`. Touch only factory signature + construct recover in the engine file, and only the GET snapshot branch + `ServeRequestContext.store` in serve.

10. **R0 pointer pass is this spec+plan commit.** Task 6 (docs) updates ARCHITECTURE / CHANGELOG / prior OUT lines after the code lands. Do not re-commit these two markdown files in Task 6 unless Status/board change.

11. **Wave order.** R1 before R2. R4 snapshot split **before** R3 construct-recover (Task 3 before Task 4) so GET cannot attach an engine that resets. R5 last.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/migrations/011_pending_reset_sha.sql` | ALTER + copy from `job_json` |
| `packages/core/src/session/schema.ts` | version 11 in `MIGRATIONS` |
| `packages/core/src/session/schema.test.ts` | version 11 + v10 upgrade copies column |
| `packages/core/src/session/sqlite-store.ts` | column bind, load overlay, `recordCompactAndUpsertSession` |
| `packages/core/src/session/memory-store.ts` | same method, snapshot/restore on throw |
| `packages/core/src/types.ts` | `SessionStore.recordCompactAndUpsertSession` |
| `packages/core/src/types.test.ts` | stub the new method |
| `packages/core/src/session/sqlite-store.test.ts` | v11, dual-write, combined tx rollback |
| `packages/core/src/session/memory-store.test.ts` | combined write + throw restore |
| `packages/core/src/session/deliveries.test.ts` | version 11 |
| `packages/core/src/session/search.test.ts` | version 11 |
| `packages/core/src/session/rewind.ts` | persist-first combined write then git reset |
| `packages/core/src/session/rewind.test.ts` | sliver tests; await factory |
| `packages/core/src/loop/session-engine.ts` | async factory + construct recover; `startDetachedReview` await |
| `packages/core/src/tools/agent.ts` | `spawnChild` await ~269 |
| `packages/cli/src/engine.ts` | await factory in `finishOpenEngine` |
| `packages/sdk/src/index.ts` | await factory |
| `packages/cli/src/serve.ts` | snapshot split; `store` on ctx |
| `packages/cli/src/serve.test.ts` | snapshot does not attach; flag GET does not reset |
| `packages/core/src/eval/run.ts` | 20 awaits; rewind-reset-on-resume flip |
| every test file in the call-site table | `await createSessionEngine(` |
| docs in Task 6 | Status + schema 11 + construct recovers |

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 schema v11 dual-write | `011_*.sql`, `schema.ts`, `schema.test.ts`, `sqlite-store.ts` (column/SQL/load/bind only), `sqlite-store.test.ts` (version + column tests), `deliveries.test.ts`, `search.test.ts` |
| 2 combined compact+flag | `types.ts` (store method), `types.test.ts`, `sqlite-store.ts` (new method), `memory-store.ts`, store tests for the method, `rewind.ts`, `rewind.test.ts` (sliver; not factory-await yet) |
| 3 GET snapshot split | `serve.ts`, `serve.test.ts` |
| 4 async factory + 176 awaits | `session-engine.ts`, `agent.ts`, `cli/engine.ts`, `sdk/index.ts`, `eval/run.ts`, **all** call-site files, construct-recover test flips |
| 5 eval lock | `eval/run.ts` rewind-reset-on-resume assertions (if not done in 4), fixture unchanged name |
| 6 docs | ARCHITECTURE / `.ko.md`, CHANGELOG, remaining-roadmap, prior spec OUT amendments, this spec Status/board |

Task 1 before Task 2. Task 3 before Task 4. Task 5 after 4. Task 6 last.

---

## Call-site table (`createSessionEngine(` at `a707249`)

176 calls + 1 export. Every call becomes `await createSessionEngine(`. Export becomes `export async function createSessionEngine(...): Promise<SessionEngine>`.

| File | Count | Notes |
|---|---|---|
| `packages/core/src/loop/session-engine.ts` | 1 call + 1 export | export ~128; `startDetachedReview` ~1173 (async IIFE — `await`) |
| `packages/core/src/tools/agent.ts` | 1 | `spawnChild` ~269 (already async) |
| `packages/cli/src/engine.ts` | 1 | `finishOpenEngine` already async ~594 |
| `packages/sdk/src/index.ts` | 1 | already async ~239 |
| `packages/core/src/eval/run.ts` | 20 | already async runners |
| `packages/core/src/loop/session-engine.test.ts` | 63 | `drain` helper: `Awaited<ReturnType<typeof createSessionEngine>>` |
| `packages/core/src/loop/query-loop.test.ts` | 63 | `Parameters<typeof createSessionEngine>[0]` stays |
| `packages/core/src/loop/quality-gate.test.ts` | 3 | |
| `packages/core/src/loop/pairing.test.ts` | 1 | |
| `packages/core/src/permissions/pipeline.loop.test.ts` | 6 | |
| `packages/core/src/session/rewind.test.ts` | 2 | |
| `packages/core/src/tools/agent.test.ts` | 3 | |
| `packages/cli/src/cost-command.test.ts` | 4 | |
| `packages/cli/src/exec.test.ts` | 3 | |
| `packages/acp/src/server.test.ts` | 3 | pre-await; `Awaited<ReturnType<…>>`; do not make `engineFactory` async |
| `packages/providers/src/query-loop.integration.test.ts` | 1 | |
| **Total calls** | **176** | plus 1 export |

Re-export `packages/core/src/index.ts` `export { createSessionEngine }` stays; the binding becomes async. Do not add a second factory.

---

### Task 1: Schema v11 dual-write (R1.1–R1.3)

**Files:**
- Create: `packages/core/src/migrations/011_pending_reset_sha.sql`
- Modify: `packages/core/src/session/schema.ts`, `schema.test.ts`, `sqlite-store.ts` (SessionRow, bind, INSERT/UPSERT SQL, `sessionFromRow` overlay only), `sqlite-store.test.ts` (version + column tests), `deliveries.test.ts`, `search.test.ts`

**Interfaces:**
- Consumes: `applyMigrations`, `jobFromJson`, `sessionBind`
- Produces: fresh `schema_version` `'11'`; column `pending_reset_sha`; load prefers non-empty column; upsert dual-writes column + `job_json`

- [ ] **Step 1: Write the failing tests**

In `schema.test.ts` import `SESSION_HOST_STATE_SQL`. Change every `expect(version.value).toBe('10')` and every test title `schema_version 10` / `upgrades to v10` to **11**. Keep the v9→11 path (applyMigrations still walks 10 then 11). Add:

```ts
function expectPendingResetColumn(db: Database): void {
  expect(sessionColumns(db)).toContain('pending_reset_sha')
}

test('fresh db reaches schema_version 11 with pending_reset_sha', () => {
  const db = new Database(':memory:')
  applyMigrations(db)
  const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string
  }
  expect(version.value).toBe('11')
  expectPendingResetColumn(db)
  expectHostStateColumns(db)
  db.close()
})

test('is idempotent when already at version 11', () => {
  const db = new Database(':memory:')
  applyMigrations(db)
  applyMigrations(db)
  const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string
  }
  expect(version.value).toBe('11')
  expectPendingResetColumn(db)
  db.close()
})

test('v10 database upgrades to v11 and copies job_json pendingResetSha into the column', () => {
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
  db.exec(SESSION_HOST_STATE_SQL)
  db.query(
    "INSERT INTO meta (key, value) VALUES ('schema_version', '10') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run()
  db.query(
    `INSERT INTO sessions (
       id, created_at, updated_at, cwd, model, permission_mode, compact_generation,
       usage_json, funding, job_json, job_auto_commit
     ) VALUES (?, 1, 1, '/', 'dummy', 'default', 0, '{}', 'byok', ?, 0)`,
  ).run(
    's1',
    JSON.stringify({
      baseBranch: 'main',
      shadowBranch: 'raven/s',
      baseCommitSha: 'abc123',
      worktreePath: '/tmp/wt',
      pendingResetSha: 'def456',
    }),
  )
  applyMigrations(db)
  const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string
  }
  expect(version.value).toBe('11')
  const row = db.query('SELECT pending_reset_sha FROM sessions WHERE id = ?').get('s1') as {
    pending_reset_sha: string | null
  }
  expect(row.pending_reset_sha).toBe('def456')
  expectHostStateColumns(db)
  db.close()
})
```

In `sqlite-store.test.ts` change `fresh install uses WAL and schema_version 10` to **11**. Extend `job pendingResetSha survives sqlite upsert and loadSession`:

```ts
test('loadSession prefers non-empty pending_reset_sha column over job_json', async () => {
  const store = openStore()
  await store.createSession(
    session({
      job: {
        baseBranch: 'main',
        shadowBranch: 'raven/s',
        baseCommitSha: 'abc123',
        worktreePath: '/tmp/wt',
        pendingResetSha: 'from-json',
      },
    }),
  )
  const db = sqliteStoreDatabase(store)!
  db.query(`UPDATE sessions SET pending_reset_sha = ?, job_json = ? WHERE id = ?`).run(
    'from-column',
    JSON.stringify({
      baseBranch: 'main',
      shadowBranch: 'raven/s',
      baseCommitSha: 'abc123',
      worktreePath: '/tmp/wt',
    }),
    's1',
  )
  const loaded = await store.loadSession('s1')
  expect(loaded.session.job?.pendingResetSha).toBe('from-column')
})

test('loadSession falls back to job_json when pending_reset_sha is null', async () => {
  const store = openStore()
  await store.createSession(
    session({
      job: {
        baseBranch: 'main',
        shadowBranch: 'raven/s',
        baseCommitSha: 'abc123',
        worktreePath: '/tmp/wt',
        pendingResetSha: 'from-json',
      },
    }),
  )
  const db = sqliteStoreDatabase(store)!
  db.query(`UPDATE sessions SET pending_reset_sha = NULL WHERE id = ?`).run('s1')
  const loaded = await store.loadSession('s1')
  expect(loaded.session.job?.pendingResetSha).toBe('from-json')
})
```

In `deliveries.test.ts` change `migrates to schema 10` / `toBe('10')` to 11. In `search.test.ts` change `migrates schema 1 to 10` and both `toBe('10')` to 11.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/session/schema.test.ts ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/deliveries.test.ts ./packages/core/src/session/search.test.ts`

Expected: FAIL — version is still `'10'`; column missing; new load tests fail.

- [ ] **Step 3: Implement migration + dual-write**

Create `packages/core/src/migrations/011_pending_reset_sha.sql`:

```sql
ALTER TABLE sessions ADD COLUMN pending_reset_sha TEXT;
UPDATE sessions
SET pending_reset_sha = json_extract(job_json, '$.pendingResetSha')
WHERE json_extract(job_json, '$.pendingResetSha') IS NOT NULL
  AND json_extract(job_json, '$.pendingResetSha') != '';
```

In `schema.ts` add `PENDING_RESET_SHA_SQL` via `readFileSync(join(import.meta.dir, '../migrations/011_pending_reset_sha.sql'), 'utf8')` and `{ version: 11, sql: PENDING_RESET_SHA_SQL }` on `MIGRATIONS`. Export the constant (tests may import it later; schema.test can exec 001–010 as today).

In `sqlite-store.ts`:

- `SessionRow` add `pending_reset_sha: string | null`
- `sessionBind` add `$pending_reset_sha: session.job?.pendingResetSha ?? null`
- INSERT and UPSERT column lists add `pending_reset_sha` / `$pending_reset_sha` / `pending_reset_sha = excluded.pending_reset_sha`
- After `const job = jobFromJson(row.job_json)` in `sessionFromRow`:

```ts
if (job !== undefined) {
  if (row.pending_reset_sha != null && row.pending_reset_sha !== '') {
    job.pendingResetSha = row.pending_reset_sha
  }
  session.job = job
}
```

Keep `jobFromJson` copying `pendingResetSha` from JSON (fallback when column is NULL). Do not add other columns.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/session/schema.test.ts ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/deliveries.test.ts ./packages/core/src/session/search.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/migrations/011_pending_reset_sha.sql \
  packages/core/src/session/schema.ts \
  packages/core/src/session/schema.test.ts \
  packages/core/src/session/sqlite-store.ts \
  packages/core/src/session/sqlite-store.test.ts \
  packages/core/src/session/deliveries.test.ts \
  packages/core/src/session/search.test.ts
git commit -m "$(cat <<'EOF'
feat: schema v11 pending_reset_sha dual-write

Add sessions.pending_reset_sha. Migration 011 copies
json_extract(job_json, '$.pendingResetSha'). Load prefers a
non-empty column; upsert writes column and job_json.
EOF
)"
```

---

### Task 2: Combined compact+flag write (R2.1–R2.3)

**Files:**
- Modify: `packages/core/src/types.ts`, `packages/core/src/types.test.ts`, `packages/core/src/session/sqlite-store.ts`, `packages/core/src/session/memory-store.ts`, `packages/core/src/session/sqlite-store.test.ts`, `packages/core/src/session/memory-store.test.ts`, `packages/core/src/session/rewind.ts`, `packages/core/src/session/rewind.test.ts`

**Interfaces:**
- Consumes: `recordCompactTx`, `upsertSessionSql`, `sessionBind`, `withWrite`, `beginImmediate`
- Produces: `SessionStore.recordCompactAndUpsertSession`; `rewindToCheckpoint` persist-first via it then `git reset --hard`; throw → originals, no flag, no reset

- [ ] **Step 1: Write the failing tests**

In `sqlite-store.test.ts`:

```ts
test('recordCompactAndUpsertSession inactivates ids and dual-writes pending_reset_sha in one tx', async () => {
  const store = openStore()
  const job = {
    baseBranch: 'main',
    shadowBranch: 'raven/s',
    baseCommitSha: 'abc123',
    worktreePath: '/tmp/wt',
    pendingResetSha: 'def456',
  }
  await store.createSession(session({ job: { ...job, pendingResetSha: undefined } }))
  await store.persistUser('s1', {
    id: 'u1',
    role: 'user',
    blocks: [{ type: 'text', text: 'drop' }],
    createdAt: 1,
  })
  await store.recordCompactAndUpsertSession({
    session: session({ job, compactGeneration: 1 }),
    inactivatedIds: ['u1'],
    generation: 1,
    summary: 'rewind',
  })
  const loaded = await store.loadSession('s1')
  expect(loaded.messages.map((msg) => msg.id)).toEqual([])
  expect(loaded.session.job?.pendingResetSha).toBe('def456')
  const db = sqliteStoreDatabase(store)!
  const row = db.query('SELECT pending_reset_sha, job_json FROM sessions WHERE id = ?').get('s1') as {
    pending_reset_sha: string | null
    job_json: string
  }
  expect(row.pending_reset_sha).toBe('def456')
  expect(JSON.parse(row.job_json).pendingResetSha).toBe('def456')
})

test('recordCompactAndUpsertSession throw rolls back inactivate and column', async () => {
  const store = openStore()
  await store.createSession(
    session({
      job: {
        baseBranch: 'main',
        shadowBranch: 'raven/s',
        baseCommitSha: 'abc123',
        worktreePath: '/tmp/wt',
      },
    }),
  )
  await store.persistUser('s1', {
    id: 'u1',
    role: 'user',
    blocks: [{ type: 'text', text: 'keep' }],
    createdAt: 1,
  })
  const db = sqliteStoreDatabase(store)!
  db.exec(`
    CREATE TRIGGER fail_pending_reset
    BEFORE UPDATE OF pending_reset_sha ON sessions
    WHEN NEW.pending_reset_sha IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'boom');
    END
  `)
  await expect(
    store.recordCompactAndUpsertSession({
      session: session({
        job: {
          baseBranch: 'main',
          shadowBranch: 'raven/s',
          baseCommitSha: 'abc123',
          worktreePath: '/tmp/wt',
          pendingResetSha: 'def456',
        },
      }),
      inactivatedIds: ['u1'],
      generation: 1,
      summary: 'rewind',
    }),
  ).rejects.toBeInstanceOf(Error)
  const loaded = await store.loadSession('s1')
  expect(loaded.messages.map((msg) => msg.id)).toEqual(['u1'])
  expect(loaded.session.job?.pendingResetSha).toBeUndefined()
  const col = db.query('SELECT pending_reset_sha FROM sessions WHERE id = ?').get('s1') as {
    pending_reset_sha: string | null
  }
  expect(col.pending_reset_sha).toBeNull()
})
```

In `rewind.test.ts`, next to `recordCompact throw leaves originals`, add (keep the existing compact-fail test but retarget it to the combined method once the production path no longer calls `recordCompact`):

```ts
test('combined compact+flag throw does not git reset and leaves originals unflagged', async () => {
  const cwd = tempDir('ravenclaw-rewind-combined-throw-')
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
  store.recordCompactAndUpsertSession = async () => {
    throw new Error('disk full')
  }
  const result = await rewindToCheckpoint({ session: sess, messages, store })
  expect(result.ok).toBe(false)
  expect(result.notice).toBe('rewind persist failed')
  expect(result.messages).toBe(messages)
  expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(laterSha)
  expect(sess.job?.pendingResetSha).toBeUndefined()
  const loaded = await store.loadSession(id)
  expect(loaded.messages.map((msg) => msg.id)).toEqual(['u1', 'a1'])
  expect(loaded.session.job?.pendingResetSha).toBeUndefined()
})
```

Change `writes pendingResetSha after compact and before reset` so the first persist that sees the flag is `recordCompactAndUpsertSession` (HEAD still later). Keep `reset fail keeps pendingResetSha`.

Add a no-op stub on the `types.test.ts` `satisfies SessionStore` object:

```ts
async recordCompactAndUpsertSession() {},
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/rewind.test.ts ./packages/core/src/types.test.ts`

Expected: FAIL — method missing; rewind still two writes / still attempts reset after flag upsert fail.

- [ ] **Step 3: Implement the method and rewind persist-first**

`types.ts` — add the method next to `recordCompact` (jsdoc: one write; throw leaves pre-call row).

Sqlite (inside `createSqliteStore`, next to `recordCompact`):

```ts
async recordCompactAndUpsertSession(opts) {
  await withWrite(async () =>
    beginImmediate(() => {
      const sessionId = opts.session.id
      if (opts.inactivatedIds.length > 0) {
        recordCompactTx(
          sessionId,
          opts.generation,
          opts.summary ?? 'rewind',
          opts.inactivatedIds,
        )
        unindexMessagesFts(db, opts.inactivatedIds)
      }
      upsertSessionSql.run(sessionBind(opts.session))
    }),
  )
},
```

Memory: snapshot session+active flags like `clearConversation`; apply compact; `sessions.set(opts.session.id, { ...opts.session })`; restore + rethrow on failure.

`rewindToCheckpoint` replace the `recordCompact` + flag `upsertSession` block with:

```ts
const nextSession: SessionRecord = {
  ...opts.session,
  job: { ...job, pendingResetSha: sha },
  updatedAt: Date.now(),
}
try {
  await opts.store.recordCompactAndUpsertSession({
    session: nextSession,
    inactivatedIds: droppedIds,
    generation: opts.session.compactGeneration,
    summary: 'rewind',
  })
} catch {
  return { ok: false, notice: 'rewind persist failed', messages: opts.messages }
}
opts.session.job = nextSession.job
opts.session.updatedAt = nextSession.updatedAt

const reset = runGit(job.worktreePath, ['reset', '--hard', sha])
```

Do not attempt git reset in the catch. Keep the reset-fail / success epilogue (clear flag via `upsertSession`, which dual-writes NULL). Update the old `store.recordCompact = throw` rewind test to the combined method (or keep both: `recordCompact` throw no longer applies to this path).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/memory-store.test.ts ./packages/core/src/session/rewind.test.ts ./packages/core/src/types.test.ts`

Expected: PASS. Existing persist-before-reset HEAD-during-compact test still sees later HEAD during the combined write.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/types.test.ts \
  packages/core/src/session/sqlite-store.ts packages/core/src/session/memory-store.ts \
  packages/core/src/session/sqlite-store.test.ts packages/core/src/session/memory-store.test.ts \
  packages/core/src/session/rewind.ts packages/core/src/session/rewind.test.ts
git commit -m "$(cat <<'EOF'
fix: compact and pending reset flag in one sqlite write

recordCompactAndUpsertSession is one BEGIN IMMEDIATE. Rewind
persist-first via it; a throw does not git reset and leaves
the original transcript unflagged.
EOF
)"
```

---

### Task 3: GET snapshot stays read-only (R4.1–R4.2)

**Files:**
- Modify: `packages/cli/src/serve.ts`, `packages/cli/src/serve.test.ts`

**Interfaces:**
- Consumes: `ServeRequestContext`, `loadSessionRuntime`, `store.loadSession`, `liveRuntimes`
- Produces: GET `/v1/session/:id` never calls `runtimeForSession` / `createSessionEngine`; `live` from cache only; mutating routes + stream + `/diff` still `loadSessionRuntime`

- [ ] **Step 1: Write the failing tests**

In `makeServeCtx`: `await store.createSession({ id: 's1', createdAt: 1, updatedAt: 1, cwd: '/tmp', model: 'dummy', permissionMode: 'default', compactGeneration: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, funding: 'byok' })`. Include `store` on the returned ctx. Set `liveRuntimes: () => [['s1', runtime] as [string, { engine: typeof engine }]]`. Tests that assign `runtime.engine.session.job` / `title` / `lastEnd` / `followup` for GET snapshot must also `await ctx.store.upsertSession(...)` with those fields (minimal `SessionRecord`).

Add:

```ts
test('GET /v1/session/:id does not call runtimeForSession', async () => {
  let attach = 0
  const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1', {
      headers: { authorization: 'Bearer secret' },
    }),
    {
      ...ctx,
      runtimeForSession: async (sessionId) => {
        attach += 1
        return ctx.runtimeForSession(sessionId)
      },
    },
  )
  expect(res.status).toBe(200)
  expect(attach).toBe(0)
})

test('GET snapshot with pendingResetSha does not reset HEAD', async () => {
  const cwd = tempGitRepo(false)
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim()
  writeFileSync(join(cwd, 'later.txt'), 'later\n')
  spawnSync('git', ['add', 'later.txt'], { cwd, encoding: 'utf8' })
  spawnSync('git', ['commit', '-m', 'later'], { cwd, encoding: 'utf8' })
  const later = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim()
  expect(later).not.toBe(base)

  const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
  const job = {
    baseBranch: 'main',
    shadowBranch: 'raven/s',
    baseCommitSha: base,
    worktreePath: cwd,
    pendingResetSha: base,
  }
  const loaded = await ctx.store.loadSession('s1')
  loaded.session.job = job
  await ctx.store.upsertSession(loaded.session)

  let attach = 0
  const res = await handleServeRequest(
    new Request('http://127.0.0.1/v1/session/s1', {
      headers: { authorization: 'Bearer secret' },
    }),
    {
      ...ctx,
      runtimeForSession: async (sessionId) => {
        attach += 1
        return ctx.runtimeForSession(sessionId)
      },
    },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { job?: { pendingResetSha?: string } }
  expect(body.job?.pendingResetSha).toBe(base)
  expect(attach).toBe(0)
  expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim()).toBe(later)
})
```

Keep `GET /v1/session/:id/diff finishes a pending rewind reset` (still `loadSessionRuntime`). Keep cancel tests on `loadSessionRuntime`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/cli/src/serve.test.ts`

Expected: FAIL — GET snapshot still calls `loadSessionRuntime` / `runtimeForSession`.

- [ ] **Step 3: Split the snapshot path**

`ServeRequestContext` add `store: SessionStore`. `runServe` `serveCtx` add `store: shared.store`.

Replace the GET `sessionIdRoute` body so it does **not** call `loadSessionRuntime`:

```ts
const sessionIdRoute = SESSION_ID_PATH.exec(url.pathname)
if (sessionIdRoute && req.method === 'GET') {
  if (!requireBearer(req, ctx.secret)) return unauthorized()
  const parsedVersion = parseVersionParam(url.searchParams.get('version'))
  if (!parsedVersion.ok) return Response.json({ error: parsedVersion.error }, { status: 400 })
  const sessionId = sessionIdRoute[1] ?? ''
  let session: SessionRecord
  try {
    session = (await ctx.store.loadSession(sessionId)).session
  } catch (error) {
    if (error instanceof PersistError && error.code === 'unknown') {
      return Response.json({ error: 'not found' }, { status: 404 })
    }
    return sessionOpenErrorResponse(error)
  }
  const pendingAsks = await collectSnapshotPendingAsksFromStore(ctx.store, sessionId)
  const lastSeq = ctx.store.lastStreamSeq ? await ctx.store.lastStreamSeq(sessionId) : 0
  let live = false
  if (ctx.liveRuntimes) {
    for (const [id, runtime] of ctx.liveRuntimes()) {
      if (id !== sessionId) continue
      live = (runtime.engine.liveTurnId?.() ?? null) !== null
      break
    }
  }
  // same JSON body as today, session from loadSession, live from cache
}
```

Extract pending-ask mapping to take a store (reuse `listOwnedPendingAsks`). Do **not** change `POST …/cancel` status codes, abort, or tree-stop. Do not change `/diff` (still `loadSessionRuntime` then `maybeFinishRewindReset`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/cli/src/serve.test.ts`

Expected: PASS including cancel / diff / snapshot / `does not create`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve.ts packages/cli/src/serve.test.ts
git commit -m "$(cat <<'EOF'
fix: GET session snapshot reads store without attaching engine

Snapshot uses loadSession and liveRuntimes only. Mutating
routes, stream, and /diff still loadSessionRuntime.
EOF
)"
```

---

### Task 4: Async createSessionEngine + construct recover + 176 awaits (R3.1–R3.2)

**Files:**
- Modify: `packages/core/src/loop/session-engine.ts`, `packages/core/src/tools/agent.ts`, `packages/cli/src/engine.ts`, `packages/sdk/src/index.ts`, `packages/core/src/eval/run.ts`, and **every file in the call-site table**

**Interfaces:**
- Consumes: `maybeFinishRewindReset({ session, store, messages })`
- Produces: `export async function createSessionEngine(opts: SessionEngineOptions): Promise<SessionEngine>`; construct recovers when flag set; reset-fail does not throw; 176 call sites `await`

- [ ] **Step 1: Write the failing construct-recover tests**

In `session-engine.test.ts` replace `submitMessage finishes a pending rewind reset; construct does not` with:

```ts
test('createSessionEngine finishes a pending rewind reset; submit is then a no-op on the flag', async () => {
  const cwd = tempDir('ravenclaw-job-finish-construct-')
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
  const later = git(job.worktreePath, ['rev-parse', 'HEAD'])
  expect(later).not.toBe(job.baseCommitSha)
  job.pendingResetSha = job.baseCommitSha
  const store = createMemoryStore()
  const sess = makeSession({ id, cwd: job.worktreePath, job })
  await store.createSession(sess)
  const engine = await createSessionEngine({
    ...engineOpts({
      provider: createFakeProvider([
        [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
      ]),
      store,
      session: sess,
    }),
  })
  expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(job.baseCommitSha)
  expect(engine.session.job?.pendingResetSha).toBeUndefined()
  await drain(engine.submitMessage('hi'))
  expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(job.baseCommitSha)
  expect(engine.session.job?.pendingResetSha).toBeUndefined()
})

test('createSessionEngine reset-fail does not throw and keeps the flag', async () => {
  const cwd = tempDir('ravenclaw-job-construct-reset-fail-')
  initGitRepo(cwd)
  const id = nextSession()
  const entered = enterSessionWorktree(id, cwd)
  expect(entered.ok).toBe(true)
  const job = entered.job!
  job.pendingResetSha = 'not-a-real-commit-sha'
  const store = createMemoryStore()
  const sess = makeSession({ id, cwd: job.worktreePath, job })
  await store.createSession(sess)
  const engine = await createSessionEngine({
    ...engineOpts({
      provider: createFakeProvider([
        [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
      ]),
      store,
      session: sess,
    }),
  })
  expect(engine.session.job?.pendingResetSha).toBe('not-a-real-commit-sha')
  expect(engine.session.jobError?.startsWith('rewind reset failed:')).toBe(true)
})
```

Change `rewindLast finishes a pending reset and does not drop another turn` so construct happens **without** the flag, then `engine.session.job.pendingResetSha = job.baseCommitSha` (and persist) **after** construct, then `rewindLast`. That is the live-engine retry path.

In `eval/run.ts` `runRewindResetOnResume`, replace the construct-must-not-reset checks:

```ts
const engine = await createSessionEngine({ /* same opts */ })
const headAfterConstruct = spawnSync('git', ['-C', job.worktreePath, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
})
if (headAfterConstruct.stdout.trim() !== job.baseCommitSha) {
  throw new Error(
    `rewind-reset-on-resume: createSessionEngine did not reset HEAD ${JSON.stringify(headAfterConstruct.stdout.trim())}`,
  )
}
if (engine.session.job?.pendingResetSha !== undefined) {
  throw new Error('rewind-reset-on-resume: flag still set after construct')
}
await drain(engine.submitMessage(spec.prompt))
const headAfterSubmit = spawnSync('git', ['-C', job.worktreePath, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
})
if (headAfterSubmit.stdout.trim() !== job.baseCommitSha) {
  throw new Error('rewind-reset-on-resume: submit moved HEAD after construct recover')
}
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `bun test ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/eval/run.test.ts`

Expected: FAIL — construct does not reset; eval still asserts the old error string. (Typecheck of `await` on a sync function is fine in TS; the assertions fail.)

- [ ] **Step 3: Make the factory async and await every call site**

Change the export:

```ts
export async function createSessionEngine(opts: SessionEngineOptions): Promise<SessionEngine> {
```

At the end of the function, after `const engine: SessionEngine = { ... }` is complete:

```ts
if (session.job?.pendingResetSha) {
  await maybeFinishRewindReset({ session, store: opts.store, messages })
}
return engine
```

Do not throw. Do not change `abort`, I2 leftover-ask pairing, or `whenTreeStop`.

Then every call in the call-site table:

- `packages/core/src/loop/session-engine.ts` ~1173: `child = await createSessionEngine(childOpts)` inside the existing async IIFE.
- `packages/core/src/tools/agent.ts` ~269: `engine = wrapSessionEngineLog(await createSessionEngine(engineOpts), openRavenclawLog(), { closeLog: false })`.
- `packages/cli/src/engine.ts` ~594: `engine: attachRavenclawLog(await createSessionEngine(engineOpts), log)`.
- `packages/sdk/src/index.ts` ~239: `const engine = await createSessionEngine(engineOpts)`.
- `packages/core/src/eval/run.ts`: all 20 calls `await`.
- Tests: `const engine = await createSessionEngine(`. Make the enclosing callback `async` if it is not. ACP three sites: `const built = await createSessionEngine({...}); engine = built; return createAcpServer({ engineFactory: () => built, ...})` (or assign then `engineFactory: () => engine!`). Do **not** `await` inside a sync `engineFactory`.
- `session-engine.test.ts` `drain`: `engine: Awaited<ReturnType<typeof createSessionEngine>>`.
- ACP: `let engine: Awaited<ReturnType<typeof createSessionEngine>> | undefined`.

Do not globally replace the export line. Do not add `createSessionEngineSync`. Wrappers stay forwarding.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun test ./packages/core/src/loop/session-engine.test.ts \
  ./packages/core/src/loop/query-loop.test.ts \
  ./packages/core/src/loop/quality-gate.test.ts \
  ./packages/core/src/loop/pairing.test.ts \
  ./packages/core/src/permissions/pipeline.loop.test.ts \
  ./packages/core/src/session/rewind.test.ts \
  ./packages/core/src/tools/agent.test.ts \
  ./packages/cli/src/engine.ts \
  ./packages/cli/src/cost-command.test.ts \
  ./packages/cli/src/exec.test.ts \
  ./packages/cli/src/serve.test.ts \
  ./packages/sdk/src/index.ts \
  ./packages/acp/src/server.test.ts \
  ./packages/providers/src/query-loop.integration.test.ts \
  ./packages/core/src/eval/run.test.ts \
  ./packages/core/src/types.test.ts
```

`bun test ./packages/cli/src/engine.ts` is a reminder to typecheck via neighboring tests (`engine-included.test.ts` if present, else `exec.test.ts` / serve). Expected: PASS. A missed `await` fails typecheck or yields a Promise where an engine is required.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop/session-engine.ts \
  packages/core/src/loop/session-engine.test.ts \
  packages/core/src/loop/query-loop.test.ts \
  packages/core/src/loop/quality-gate.test.ts \
  packages/core/src/loop/pairing.test.ts \
  packages/core/src/permissions/pipeline.loop.test.ts \
  packages/core/src/session/rewind.test.ts \
  packages/core/src/tools/agent.ts \
  packages/core/src/tools/agent.test.ts \
  packages/cli/src/engine.ts \
  packages/cli/src/cost-command.test.ts \
  packages/cli/src/exec.test.ts \
  packages/sdk/src/index.ts \
  packages/acp/src/server.test.ts \
  packages/providers/src/query-loop.integration.test.ts \
  packages/core/src/eval/run.ts \
  packages/core/src/eval/run.test.ts
git commit -m "$(cat <<'EOF'
feat: async createSessionEngine recovers pending rewind reset

Factory awaits maybeFinishRewindReset when the flag is set.
Reset-fail does not throw. Every call site awaits. GET snapshot
already does not construct.
EOF
)"
```

If `git add` misses a call-site file, `rg 'createSessionEngine\('` must show only the export plus `await createSessionEngine(` (and type-only `typeof createSessionEngine`). Add stragglers before committing.

---

### Task 5: Eval lock (R5.1)

**Files:**
- Modify: `packages/core/src/eval/run.ts` (only if Task 4 left a gap), `packages/core/src/eval/run.test.ts` if it asserts the old error string

**Interfaces:**
- Consumes: `await createSessionEngine`, `EvalExpect.rewindResetOnResume`
- Produces: fixture fails if construct-with-flag leaves HEAD later

- [ ] **Step 1: Confirm the fixture dir still walks**

`packages/core/src/eval/fixtures/rewind-reset-on-resume/case.json` stays `{ "prompt": "unused", "expect": { "rewindResetOnResume": true } }`. `run.test.ts` already walks the dir. If Task 4 already flipped `runRewindResetOnResume`, this task only adds a regression string check:

Grep `run.ts` for `createSessionEngine reset HEAD` — that old throw must be gone. The new throws are `createSessionEngine did not reset HEAD` and `flag still set after construct`.

- [ ] **Step 2: Run eval**

Run: `bun test ./packages/core/src/eval/run.test.ts`

Expected: PASS. Temporarily commenting out the construct `await maybeFinishRewindReset` must fail this fixture.

- [ ] **Step 3: Commit only if Task 4 did not already include the eval flip**

If Task 4 committed the eval change, skip. Otherwise:

```bash
git add packages/core/src/eval/run.ts packages/core/src/eval/run.test.ts
git commit -m "$(cat <<'EOF'
test: eval rewind-reset-on-resume locks construct recover

New engine construct finishes the pending git reset. First
submit is a no-op on the flag.
EOF
)"
```

---

### Task 6: Docs honesty (R0.1 / R5.2)

**Files:**
- Modify: `ARCHITECTURE.md`, `ARCHITECTURE.ko.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md`, `docs/superpowers/specs/2026-09-18-cancel-reset-followup.md` (amendment line only), `docs/superpowers/specs/2026-09-18-no-job-todo-revert.md` (Out), `docs/superpowers/specs/2026-09-18-parent-tree-stop.md` (K2.1 / Out), `docs/superpowers/specs/2026-09-20-rewind-recovery-v11.md` (Status/board after land), `README.md` if it says schema v10 or sync factory

**Interfaces:**
- Consumes: this spec’s Status + success checks
- Produces: schema **11**, construct recovers, GET snapshot does not attach, sliver filled without HEAD inference

- [ ] **Step 1: Pointer pass**

- CHANGELOG Unreleased Added: schema v11 `pending_reset_sha`; compact+flag one write; async `createSessionEngine` recovers; GET snapshot `loadSession` only. Link this spec + plan. Do not claim a web UI.
- ARCHITECTURE / `.ko.md`: schema version **11**; `createSessionEngine` is async and a recover point; GET snapshot is read-only.
- remaining-roadmap: next horizon implemented pointer (leave SHA blank until land, then fill).
- cancel-reset spec: one-line amendment at top / ruling 9, 10, 14 / Do-not-build “Making `createSessionEngine` async” → amended by `2026-09-20-rewind-recovery-v11.md`. Do not rewrite shipped I2/I3 wave text.
- no-job spec Out “schema v11, async `createSessionEngine`” → amended by this spec.
- parent-tree-stop K2.1 “`createSessionEngine` stays a sync function” → amended for the factory only; tree-stop behavior unchanged.
- This spec: Status → implemented (SHA blank until land); board rows **done**.

- [ ] **Step 2: Commit**

```bash
git add ARCHITECTURE.md ARCHITECTURE.ko.md CHANGELOG.md README.md \
  docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md \
  docs/superpowers/specs/2026-09-18-cancel-reset-followup.md \
  docs/superpowers/specs/2026-09-18-no-job-todo-revert.md \
  docs/superpowers/specs/2026-09-18-parent-tree-stop.md \
  docs/superpowers/specs/2026-09-20-rewind-recovery-v11.md
git commit -m "$(cat <<'EOF'
docs: rewind recovery schema v11 and async createSessionEngine

Point ARCHITECTURE, CHANGELOG, and prior OUT rulings at the
v11 recover spec. Historical wave text stays.
EOF
)"
```

---

## Self-review

**Spec coverage**

| Spec slice | Task |
|---|---|
| R0.1 docs pointer | Task 6 (this commit is spec+plan only) |
| R1.1–R1.3 migration + dual-write + load | Task 1 |
| R2.1–R2.3 combined write + rewind persist-first + no git on throw | Task 2 |
| R4.1–R4.2 snapshot split | Task 3 (before construct recover) |
| R3.1–R3.2 async factory + 176 awaits + construct recover | Task 4 |
| R5.1 eval | Task 4 + Task 5 |
| R5.2 honesty docs | Task 6 |
| Do not infer HEAD | Global + Task 2 |
| Do not change abort/I2/202/tree-stop | Ruling 9 + Task 3/4 file partitions |
| No `createSessionEngineSync` | Ruling 7 |
| Column name `pending_reset_sha` | Task 1 |
| Factory signature async | Task 4 |

**Placeholder scan:** none. Call-site table lists every file. Tests are copy-pasteable.

**Type consistency:** `recordCompactAndUpsertSession` signature is identical in spec, Task 2, and sqlite/memory. Factory signature is identical in spec, Task 4, and Global. Load prefers non-empty column in spec ruling 4 and plan ruling 2.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-20-rewind-recovery-v11.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks
2. **Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints

Do not implement production code in the spec+plan commit. Do not commit `.spec-brief.md`.
