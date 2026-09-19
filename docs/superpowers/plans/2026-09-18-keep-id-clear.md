# Keep-id `/clear` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/clear` / `/new` keep `session.id` and the live `SessionEngine`. Wipe conversation persist-first. Do not mint, close, consume an included cap, or add `POST /clear`.

**Architecture:** Add `SessionStore.clearConversation` as one `withWrite` / SQLite `BEGIN IMMEDIATE` write (`recordCompact` summary `'clear'` when ids exist, delete this session’s `pending_asks` + `stream_events`, drain this id’s agent mail, upsert the already-wiped row). `SessionEngine.clearKeepId` refuses unpaired child leftover-asks before abort, `abort('cancel')`s a live turn and waits for `liveTurn === null`, then calls that write. Memory and TUI flip only after `{ ok: true }`. Same engine, lock, MCP, job, worktree, children, permission mode.

**Tech Stack:** Bun, TypeScript, existing `SessionStore`, `FileHistory`, `projectSessionTodos`, Ink + OpenTUI hosts, raven eval fixtures.

**Spec:** `docs/superpowers/specs/2026-09-18-keep-id-clear.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer for operator answers. Clear is not a model turn and must not call `applyAskAnswer`.
- Default prefix stays small and frozen. No new always-on tool. Clear is a **session op**, not a tool.
- `dontAsk` never becomes `bypass`.
- BYOK is the product. Ads never touch BYOK. Included resume stays fail-closed. Keep-id must not call `openNewSession` / `resolveIncludedAccess({ consumeCap: true })`.
- Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
- `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
- Leftover-ask still wins rewind. Parent-tree-stop stays OUT. Refuse `/clear` while an owned **child** unpaired pending ask exists; do not abort, close, or abort-pair children.
- Persist-first: disk must show the empty conversation before any host advertises empty UI. Persist fail leaves the old transcript on disk **and** in memory.
- No schema bump. v10 columns already hold lastEnd / jobError / followup / todos / job / stream_events / pending_asks. Inactivate via `recordCompact`; do not `DELETE FROM messages`.
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push.
- Do not implement parent-tree-stop or stream `version` / `continuationToken`. Do not change `abort()` to walk children. Do not add `STREAM_PROTOCOL_VERSION`. Do not add `POST /v1/session/:id/clear`.

### Plan rulings

1. **Same `session.id`. Same engine instance.** `clearKeepId` must not call `openNewSession`, `createSession`, `deleteSession`, `engine.close()`, or `mcpCloser`. Lock, MCP, `createdAt`, `cwd`, `model`, `funding`, `permissionMode`, `prePlanMode`, `parentSessionId`, and `jobAutoCommit` stay.

2. **Notices.** Engine success is `session cleared`. TUI host success is `cleared session <shortSessionId>` of **this** id. Never `new session`. Fail notices are the engine string as-is.

3. **`FileHistory.reset()`** drops every in-process generation including an open one. `peekLast()` → `undefined`. `pendingCount()` → `0`. `undo()` → `{ restored: [], removed: [] }` (not `blocked`). Does not read or write workspace files. Does not delete `file-history/<id>` backups.

4. **`clearConversation` is one write.**

```ts
clearConversation(opts: {
  session: SessionRecord
  inactivatedIds: string[]
  generation: number
}): Promise<void>
```

Same `session.id`. Caller already wiped lastEnd / followup / jobError / title / todos / usage on the record. `inactivatedIds.length > 0` → `recordCompact(id, generation, 'clear', inactivatedIds)` (sqlite FTS unindex stays on that path). Empty ids → no boundary row, no generation bump. Always: delete this session’s `pending_asks`, delete this session’s `stream_events`, drain this session’s agent mail, upsert the row. One `withWrite`. Sqlite: one `beginImmediate` so a throw leaves messages active, asks present, stream seq unchanged, old lastEnd/todos. Memory: snapshot-restore on throw. Does not `deleteSession`, walk children, or touch permission_rules / locks / other sessions.

5. **`clearKeepId` order.**

```
if closed → { ok: false, notice: 'session closed' }
if unpaired child pending ask → { ok: false, notice: 'pending permission ask' }  // no persist, no abort
if liveTurn !== null → abort('cancel'); wait until liveTurn === null
re-check child unpaired asks
ids = loadMessages(id) ?? in-memory
loadMessages throw → { ok: false, notice: 'clear persist failed' }
generation = ids.length > 0 ? compactGeneration + 1 : compactGeneration
build next SessionRecord (ruling 3 in the spec; same id / job / cwd / …)
store.clearConversation({ session: next, inactivatedIds: ids, generation })
on throw → { ok: false, notice: 'clear persist failed' }  // memory unchanged
assign memory (messages=[], wiped fields, fileHistory.reset(), drain steering, userTurns=0)
projectSessionTodos(originalCwd ?? cwd, [])
on project throw → suffix `; todo.json write failed: <detail>`; ok stays true
return { ok: true, notice: 'session cleared' }
```

Serialize concurrent `clearKeepId` on the same engine (second waits, then sees idle empty). Do not use `abort('interrupt')`. Do not persist the wipe while `liveTurn !== null`.

6. **Unpaired child** = `listSessions({ parentSessionId: this.id })` then `listPendingAsks(child.id)` with no tool result for that `callId` on the child (same test rewind uses). This-session leftover asks are not this refuse; the wipe deletes them.

7. **Wipe / keep** is the spec table. Job / worktree / `pendingResetSha` / dirty files / lock / children / MCP / mode / funding / tasks / host `/queue` `/loop` stay. Transcript inactivates via `recordCompact`. Title / usage / followup / lastEnd / jobError / todos / this-session asks / this-session stream / this-id mail / in-memory steering go.

8. **TUI** `case 'clear'` in Ink and OpenTUI: `await engine.clearKeepId()`. `{ ok: true }` resets view and prints `cleared session ${shortSessionId(engine.session.id)}`. `{ ok: false }` prints `result.notice` and does not reset. `/new` stays an alias. `openNewSession` remains for boot, ACP `session/new`, serve missing-session create, cron children.

9. **No serve route. No schema bump. No hard-DELETE of message rows.**

## File map

| File | Role |
|---|---|
| `packages/core/src/session/file-history.ts` | `FileHistory.reset()` |
| `packages/core/src/session/file-history.test.ts` | reset is a no-op undo; files/backups stay |
| `packages/core/src/types.ts` | `SessionStore.clearConversation`; `SessionEngine.clearKeepId` only |
| `packages/core/src/session/sqlite-store.ts` | one `beginImmediate` wipe |
| `packages/core/src/session/sqlite-store.test.ts` | success + transactional throw |
| `packages/core/src/session/memory-store.ts` | same contract; snapshot-restore on throw |
| `packages/core/src/session/memory-store.test.ts` | success + throw leaves pre-call state |
| `packages/core/src/loop/session-engine.ts` | add `clearKeepId` only; do not change `abort()` |
| `packages/core/src/loop/session-engine.test.ts` | idle / persist-fail / mid-turn / child refuse / job kept |
| `packages/cli/src/app.tsx` | Ink `/clear` keep-id |
| `packages/cli/src/opentui-app.ts` | OpenTUI `/clear` keep-id |
| `packages/cli/src/opentui-app.test.ts` | same engine id; honest notice; persist-fail leaves view |
| `packages/cli/src/commands.ts` | keep-id summary; alias `/new` stays |
| `packages/core/src/eval/run.ts` | `keep-id-clear` runner (copy helpers locally) |
| `packages/core/src/eval/fixtures/keep-id-clear/case.json` | fixture |
| docs listed in Task 5 | pointers + honesty |

Companion stubs that must compile after the interface grows: `packages/core/src/types.test.ts` (`satisfies SessionStore`), `packages/core/src/log.test.ts` (`stubEngine`), `packages/cli/src/opentui-app.test.ts` (`fakeEngine`). Do not add `whenTreeStop`. Do not add `STREAM_PROTOCOL_VERSION`.

---

### Task 1: `FileHistory.reset` + `clearConversation`

**Files:** `file-history.ts`, `file-history.test.ts`, `types.ts`, `sqlite-store.ts`, `sqlite-store.test.ts`, `memory-store.ts`, `memory-store.test.ts`, `types.test.ts`

**Interfaces:**
- Consumes: `recordCompact`, `deleteStreamEventsBySession`, `drainAgentMail`, `upsertSession`, `withWrite` / `beginImmediate`
- Produces: `FileHistory.reset()`; `SessionStore.clearConversation`

- [ ] **Step 1: Write the failing tests**

In `file-history.test.ts` add: after snapshots + `reset()`, `peekLast()` is `undefined`, `pendingCount()` is `0`, `undo()` is `{ restored: [], removed: [] }` (not `blocked`), workspace file is unchanged, backup under `file-history/<id>` still exists. Existing undo/open-generation tests stay.

In `sqlite-store.test.ts` and `memory-store.test.ts` add:

- Success: session with messages, wiped-field record (same id, kept `job` / `permissionMode`), this-session pending ask + stream events + mail, child session with its own ask. After `clearConversation`, `loadSession` is `messages: []` with wiped fields and kept job/id/mode; `listPendingAsks` this id is `[]`; `lastStreamSeq` is `0`; child row + child ask remain; permission rules remain; `createSession` of the same id still throws `session exists`. Non-empty `inactivatedIds` writes compact summary `'clear'` at `generation`. Empty ids skip the boundary and leave `compactGeneration`.
- Throw: sqlite — reuse an existing compact generation so `insertBoundary` unique-fails inside the transaction. Memory — force a throw after mutations start (e.g. stub `drainAgentMail`). Pre-call transcript, asks, stream seq, lastEnd/todos remain.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/keep-id-clear-spec
bun test ./packages/core/src/session/file-history.test.ts ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/memory-store.test.ts
```

Expected: new tests fail (`reset` / `clearConversation` missing).

- [ ] **Step 3: Implement the primitives**

`reset()`: drop `generations` and `current`; do not reset backup `seq`; do not touch disk.

`clearConversation`: one `withWrite`. Sqlite wraps the body in `beginImmediate` (inline `recordCompactTx` + FTS unindex when ids nonempty — do not call async `store.recordCompact` from inside the sync transaction). Memory snapshots session/messages/asks/stream/mail and restores on throw.

- [ ] **Step 4: Re-run tests**

Same command. Expected: pass. Existing undo / `recordCompact` / `deleteSession` tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/file-history.ts packages/core/src/session/file-history.test.ts packages/core/src/types.ts packages/core/src/types.test.ts packages/core/src/session/sqlite-store.ts packages/core/src/session/sqlite-store.test.ts packages/core/src/session/memory-store.ts packages/core/src/session/memory-store.test.ts
git commit -m "$(cat <<'EOF'
feat: add FileHistory.reset and store.clearConversation

One transactional conversation wipe: recordCompact summary 'clear'
when ids exist, delete this session's pending_asks and stream_events,
drain this id's mail, upsert the already-empty field record. Same id.
Throw leaves the pre-call transcript. reset() drops in-process
generations and does not undo files or delete backups.
EOF
)"
```

---

### Task 2: `engine.clearKeepId`

**Files:** `types.ts` (`SessionEngine.clearKeepId` only), `session-engine.ts`, `session-engine.test.ts`, `log.test.ts` stub if the interface requires it

**Interfaces:**
- Consumes: `store.clearConversation`, `abort('cancel')`, `listSessions` / `listPendingAsks` / `isCallPaired`, `loadMessages`, `projectSessionTodos`, `getSessionWorktree`, `fileHistory.reset`
- Produces: `clearKeepId(): Promise<{ ok: true; notice: string } | { ok: false; notice: string }>`

- [ ] **Step 1: Write the failing tests**

In `session-engine.test.ts` `describe('clearKeepId')`:

1. **Idle wipe.** Messages + followup + lastEnd + todos + this-session pending ask + stream events. After success: same `session.id`, `loadMessages` `[]`, ask gone, `lastStreamSeq === 0`, notice `session cleared`. Do not call `applyAskAnswer` / `close` / `createSession` / `deleteSession`.
2. **Persist-fail.** Stub `clearConversation` throw → `{ ok: false, notice: 'clear persist failed' }`; in-memory messages and `session.todos` unchanged.
3. **Closed.** `{ ok: false, notice: 'session closed' }`; no persist.
4. **Empty transcript.** Still `ok: true` (idempotent wipe of fields/asks/stream).
5. **Mid-turn.** Live `submitMessage` + hung `askUser`: `clearKeepId` `abort('cancel')`s, waits for idle, then wipes. `liveTurnId()` is null. `loadMessages` is `[]`. This-session leftover is gone. Do not call `abort('interrupt')`. Concurrent second `clearKeepId` serializes and no-ops as empty.
6. **Child unpaired refuse.** Parent with child leftover-ask: `{ ok: false, notice: 'pending permission ask' }` **before** abort. If parent was live, `liveTurn` stays live. Parent messages and child ask unchanged. After `applyAskAnswer` on the child, `clearKeepId` may succeed and still leave the child session row. Existing parent-cancel-leaves-child-ask stays green.
7. **Job kept.** Enter a worktree, dirty a file, set todos/title/followup/`pendingResetSha`. After success: `session.job` (including the flag), cwd, worktree sidecar, HEAD, and dirty file stay. `todos` `[]`, project `todo.json` is `[]\n`, title/usage/followup/lastEnd/jobError wiped.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/keep-id-clear-spec
bun test ./packages/core/src/loop/session-engine.test.ts
```

Expected: new `clearKeepId` tests fail.

- [ ] **Step 3: Implement `clearKeepId` only**

Do not change `abort()`. Wait for idle via a settle callback when `liveTurn` is set to `null` (persist-fail path and `submitMessage` `finally`). Mutate the live `session` object only after `clearConversation` resolves. Serialize with a per-engine tail promise.

- [ ] **Step 4: Re-run tests**

Same command. Expected: pass. Existing cancel / parent-cancel-leaves-child-ask / rewind tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/loop/session-engine.ts packages/core/src/loop/session-engine.test.ts packages/core/src/log.test.ts
git commit -m "$(cat <<'EOF'
feat: add SessionEngine.clearKeepId

Same session.id and the same engine. Refuse unpaired child leftover
asks before abort. Mid-turn abort('cancel') waits for liveTurn null
then persist-first wipes via clearConversation. Persist fail leaves
memory unchanged. Job, worktree, lock, MCP, and children stay.
EOF
)"
```

---

### Task 3: TUI hosts

**Files:** `app.tsx`, `opentui-app.ts`, `opentui-app.test.ts`, `commands.ts`

- [ ] **Step 1: Write the failing tests**

Replace OpenTUI `/clear` / `/new` “new session newsessi” / new-engine assertion:

- `/clear` then a prompt submits on the **same** engine id. Notice contains `cleared session` and the same short id. `openNewSession` is not called.
- Persist-fail stub (`clearKeepId` → `{ ok: false, notice: 'clear persist failed' }`) leaves the previous view text and does not print `cleared session`.

`commands.ts` summary is no longer “start a new session”. Alias `/new` stays. Update `commands.test.ts` only if the summary string is asserted.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/keep-id-clear-spec
bun test ./packages/cli/src/opentui-app.test.ts ./packages/cli/src/commands.test.ts
```

Expected: `/clear` test fails on the old notice / new-engine path.

- [ ] **Step 3: Implement hosts**

`case 'clear'`: `await engine.clearKeepId()`. Do not `close()`, `mcpCloser`, or `openNewSession`. `{ ok: true }`: Ink resets rows/todos/selection/expanded; OpenTUI `view.reset()`; notice `cleared session ${shortSessionId(engine.session.id)}`. OpenTUI included ads may rewrite (same runtime). `{ ok: false }`: do not reset; print `result.notice`. Re-bind AskUser only if the host already did that for other same-engine ops (it did not change).

- [ ] **Step 4: Re-run tests**

Same command. Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/app.tsx packages/cli/src/opentui-app.ts packages/cli/src/opentui-app.test.ts packages/cli/src/commands.ts
git commit -m "$(cat <<'EOF'
feat: keep session.id on TUI /clear

Ink and OpenTUI call engine.clearKeepId. Success notice is
cleared session <shortId> of this id. Persist fail leaves the
view. /new stays an alias. openNewSession remains for boot.
EOF
)"
```

---

### Task 4: Eval lock

**Files:** `packages/core/src/eval/run.ts`, `run.test.ts` (no change unless needed), `packages/core/src/eval/fixtures/keep-id-clear/case.json`

- [ ] **Step 1: Write the failing fixture**

`case.json`: `{ "prompt": "unused", "expect": { "keepIdClear": true } }`.

`run.ts`: unknown directory names still throw. Add `keep-id-clear` runner (copy helpers locally; do not import from test files):

| Assert | Check |
|---|---|
| Same id | `engine.session.id` unchanged after `clearKeepId` |
| Empty transcript | `loadMessages` is `[]` |
| This-session ask gone | `listPendingAsks` is `[]` |
| Stream reset | `lastStreamSeq === 0` |
| Persist-fail | stub `clearConversation` throw leaves the last user |
| Child refuse | unpaired child ask → `pending permission ask`; parent transcript stays |
| Job kept | job session still has `session.job` |

- [ ] **Step 2: Run the eval test to confirm it fails if the runner is missing**

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/keep-id-clear-spec
bun test ./packages/core/src/eval/run.test.ts
```

Expected: fail on `unknown eval fixture: keep-id-clear` until the runner exists; then pass against Task 2.

- [ ] **Step 3: Implement the runner**

- [ ] **Step 4: Re-run**

Same command. Expected: pass.

- [ ] **Step 5: Commit with Task 5** (docs + eval in one commit)

---

### Task 5: Docs (K0) after code

**Files:** spec + plan headers; `SLASH_COMMANDS.md` / `.ko.md`; `ARCHITECTURE.md` / `.ko.md`; `README.md`; `CHANGELOG.md` Unreleased; `docs/headless.md`; prior-spec one-line amendments; remaining-roadmap successor line.

- [ ] **Step 1: Point the waist here**

- This spec Status → implemented on this branch (leave SHA blank until land). Implementation plan path. Board K0–K4 → done.
- `2026-09-18-no-job-todo-revert.md` (and cancel-reset-followup, rewind-persist, job-host-state): historical OUT lines stay; add a one-line amendment that keep-id `/clear` is unparked by this spec only.
- `2026-09-12-ravenclaw-remaining-roadmap.md`: successor pointer. Do not rewrite shipped wave text.
- `SLASH_COMMANDS.md` / `.ko.md`: `/clear` / `/new` keeps `session.id`, wipes conversation, does not consume included cap, mid-turn is abort-then-wipe. Session-surgery table: same id, empty transcript, files/job unchanged.
- `ARCHITECTURE.md` / `.ko.md`: `clearKeepId` on SessionEngine. No `POST …/clear`.
- `README.md`: `/clear` `/new` is keep-id wipe, not “New session”.
- `CHANGELOG.md` Unreleased: this branch keep-id `/clear`.
- `docs/headless.md`: no new serve route; engine method is the composition. Do not document `POST …/clear`.

- [ ] **Step 2: Commit eval + docs**

```bash
git add packages/core/src/eval/run.ts packages/core/src/eval/fixtures/keep-id-clear docs/superpowers/specs docs/superpowers/plans/2026-09-18-keep-id-clear.md SLASH_COMMANDS.md SLASH_COMMANDS.ko.md ARCHITECTURE.md ARCHITECTURE.ko.md README.md CHANGELOG.md docs/headless.md
git commit -m "$(cat <<'EOF'
docs: lock keep-id /clear and point the waist at it

Eval fixture keep-id-clear fails the runner if idle wipe, persist-fail,
child refuse, or job-kept regress. Slash, architecture, README, and
headless say /clear keeps session.id and does not add POST /clear.
EOF
)"
```

---

## Out of this horizon

Web chat UI, Next.js BFF, Prisma Task, Socket.IO, y0 Shadow wiki / indexer, eve compiler, OpenAPI connections, memory slots, `defineState`, credential brokering, self-mod, any new chat network, sandbox network policy, Grep/Glob docker-exec, `ignored`, stream `version` / `continuationToken`, schema v11, async `createSessionEngine`, cancel-without-live abort-pair, interrupt abort-pair, parent-cancels-child-ask / parent-tree-stop, `POST /v1/session/:id/clear`, changing `openNewSession` mint behavior, hard-delete of message rows, deleting `raven/*` worktrees from `/clear`.
