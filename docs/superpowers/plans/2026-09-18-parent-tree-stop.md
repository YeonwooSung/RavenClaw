# Parent tree-stop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parent `abort('cancel')` is full tree-stop: abort descendant live turns with `abort('cancel')`, then persist-before-drop descendant leftover-asks (I2 law). Idle parent still walks descendants only; this session’s parked asks stay.

**Architecture:** One BFS helper (`listDescendantSessionIds`) is the owned-ask set. Parent engine owns a process-local child-engine map. `abort('cancel')` stays `void` and starts `treeStopFlight`; `whenTreeStop()` is the join. Serve awaits that join only on the idle-with-descendant-work row.

**Tech Stack:** Bun, TypeScript, existing `SessionStore`, `createSessionEngine`, serve caches.

**Spec:** `docs/superpowers/specs/2026-09-18-parent-tree-stop.md`

## Global Constraints

- One `queryLoop`. Every host only calls `submitMessage` for new user text. `applyAskAnswer` remains the only non-`submitMessage` closer **for operator answers**. Tree-stop abort-pair is a side effect of `abort('cancel')`, not a fourth host entry and not a model turn.
- Default prefix stays small and frozen. No new always-on tool.
- `dontAsk` never becomes `bypass`.
- BYOK is the product. Ads never touch BYOK.
- Clean-room. No vendor prompts, no 25 adapters, no Electron, no marketplace, no computer-use, no `execute_code`, no yolo, **no Workflow SDK as the loop**, **no eve `agent/` compiler**, **no Prisma Task / Socket.IO second loop**, **no Next.js BFF**, **no web UI**.
- `submitMessage` while pending still returns `{ reason: 'completed' }` without a user row and must not record that return as `lastEnd`.
- Leftover-ask still wins rewind: `rewindLast` refuses when any **owned unpaired** pending ask remains **after** `whenTreeStop()`.
- Edit-resubmit stays host composition (`rewindLast` then `submitMessage`).
- `createSessionEngine` stays `export function createSessionEngine(...): SessionEngine`. Do not make it async.
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push.
- No schema version bump. No new route. No web UI. No `engine.clearKeepId`. No `STREAM_PROTOCOL_VERSION`.
- Full tree-stop, not leftover-only. No leftover-only half door.
- Interrupt unchanged. Cancel-without-live of **this** session’s parked asks stays closed.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification only.

1. **K0.1 pointer pass lands with the spec commit.** Historical OUT lines stay; add a one-line amendment. Do not rewrite shipped I2 / J-wave text. Do not claim a web UI.

2. **One BFS helper, four callers.** `listDescendantSessionIds` lives in `followup.ts` and is exported from `@ravenclaw/core`. Engine-local `listOwnedPendingAsks` **calls the export** (delete the forked one-hop body). `resolveAskTarget`, serve `publishParkedAsks` / `collectSnapshotPendingAsks` use the same helper (or `listOwnedPendingAsks`). Store `listSessions({ parentSessionId })` stays one-level.

3. **`abort` stays `void`.** Sync order on `abort('cancel')`: registered children `child.abort('cancel')` first, then this session’s `cancelKind` + `abortTurn` if live, then start/chain `treeStopFlight`. Do not persist leftover-asks inside the sync function. `abort('interrupt')` does not start `treeStopFlight` and does not call `child.abort('cancel')`.

4. **`whenTreeStop(): Promise<{ descendantWork: boolean }>`.** Returns the in-flight tree-stop, or `{ descendantWork: false }` if none. `descendantWork` is true iff this cancel aborted at least one registered/serve descendant `liveTurn` **or** persist-before-dropped (or attempted) at least one descendant leftover-ask row. `submitMessage`, `rewindLast`, and `runFollowupAfterSubmit` / `maybeRunFollowup` await it **before** `listOwnedPendingAsks`.

5. **treeStopFlight owns descendant leftover-asks.** Await registered descendant engines until `liveTurnId() === null`, then persist-before-drop descendant rows (I2 law, per row, continue on fail). Do not touch this session’s parked asks. Do not invent parent or child `lastEnd` on idle leftover-only. Coalesce: a second `abort('cancel')` still abort()s newly registered children, then chains another persist pass.

6. **Cancelled stream line.** Parent cancelled stream emits `cancelled, ask still pending` only if some **owned unpaired** row remains after this session’s I2 **and** `treeStopFlight`.

7. **Serve envelope (always HTTP 200 on the success path).** Stale `turnId` only protects a **different live** parent turn. Idle + stale `turnId` + descendant work still walks. Live parent returns `{ ok: true }` without awaiting tree-stop. Idle + descendant work awaits `whenTreeStop` then `{ ok: true }`. Idle + nothing is `no_active_turn` (no abort). Serve also `abort('cancel')`s cached runtimes whose session id is in `listDescendantSessionIds`. Probe descendant work via leftover-asks, cached `liveTurnId`, and registered child live turns (if descendants exist, `abort('cancel')` then `whenTreeStop` decides `descendantWork`).

8. **TUI notice.** `/stop` `/cancel` still call `abort('cancel')`. Notice is `stopped` if the parent was live **or** `whenTreeStop()` reports `descendantWork`; else `nothing to stop`. OpenTUI double-stop `killAll` is unchanged. ACP `session/cancel` and `acp-stdio` call `abort('cancel')`.

9. **Eval fixture `parent-tree-stop`.** Dedicated runner in `run.ts`. Copy helpers locally; do not import from test files. Unknown directory names still throw. Existing `cancel-abort-pair` stays.

10. **Wrappers.** `wrapSessionEngineLog` and the CLI engine wrapper forward `whenTreeStop`. `QueryLoopOptions` / `phases.ts` pass `registerChildEngine` onto `ToolContext`. Do not add `clearKeepId`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/session/followup.ts` | `listDescendantSessionIds` BFS; recursive `listOwnedPendingAsks`; `runFollowupAfterSubmit` awaits `whenTreeStop` |
| `packages/core/src/session/followup.test.ts` | grandchild owned-ask + cycle |
| `packages/core/src/loop/session-engine.ts` | export-backed owned asks; descendant `resolveAskTarget`; child map; `abort('cancel')` tree-stop; `whenTreeStop`; treeStopFlight |
| `packages/core/src/loop/session-engine.test.ts` | flip child leftover-ask; live child cancel; idle tree-stop; persist-fail; lastEnd |
| `packages/core/src/types.ts` | `ToolContext.registerChildEngine`; `SessionEngine.whenTreeStop`; `QueryLoopOptions.registerChildEngine` |
| `packages/core/src/loop/phases.ts` | copy registrar onto `ToolContext` |
| `packages/core/src/tools/agent.ts` | register/unregister child engines |
| `packages/core/src/log.ts` | forward `whenTreeStop` |
| `packages/core/src/index.ts` | export `listDescendantSessionIds` |
| `packages/cli/src/serve.ts` | cancel envelope; descendant cache abort; snapshot/parked walk |
| `packages/cli/src/serve.test.ts` | grandchild snapshot; envelope table; child cache abort |
| `packages/cli/src/engine.ts` | forward `whenTreeStop` |
| `packages/cli/src/app.tsx` | `/stop` notice via `whenTreeStop` |
| `packages/cli/src/opentui-app.ts` | same |
| `packages/acp/src/server.ts` | `abort('cancel')` |
| `packages/cli/src/acp-stdio.ts` | pass `'cancel'` |
| `packages/core/src/eval/run.ts` | `parent-tree-stop` runner |
| docs listed in Task 1 / Task 7 | K0 pointers + shipped wording after code |

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 spec + K0 pointers | spec file, this plan, ARCHITECTURE / `.ko.md`, README, SLASH_COMMANDS / `.ko.md`, headless, remaining-roadmap, cancel-reset spec, no-job spec |
| 2 K1 descendant walk | `followup.ts`, `followup.test.ts`, `session-engine.ts` (`listOwnedPendingAsks` + `resolveAskTarget`), `session-engine.test.ts` (grandchild apply), `index.ts`, `serve.ts` snapshot/parked, `serve.test.ts` (grandchild snapshot) |
| 3 K2 child abort | `types.ts`, `session-engine.ts` (registry + abort), `phases.ts`, `agent.ts`, `session-engine.test.ts` (live child + interrupt), `log.ts`, `engine.ts` wrappers |
| 4 K3 persist-before-drop | `session-engine.ts` (`treeStopFlight` / `whenTreeStop` / cancelled epilogue / await sites), `session-engine.test.ts` (flip + idle + persist-fail + lastEnd) |
| 5 K4 serve + hosts | `serve.ts` cancel, `serve.test.ts` envelope, `app.tsx`, `opentui-app.ts`, ACP files + their tests |
| 6 K5 eval | `eval/run.ts`, `fixtures/parent-tree-stop/`, `run.test.ts` already walks the dir |
| 7 shipped docs | spec Status/board after code; CHANGELOG one-liner if the tree already documents cancel as this-session-only |

Task 1 first. Task 2 before 3. Task 3 before 4 (registry needed to wait for child `liveTurn`). Task 5 after 4 (idle envelope). Task 6 last among code. Task 7 last.

---

### Task 1: Spec + K0 pointers

**Files:**
- Add: `docs/superpowers/specs/2026-09-18-parent-tree-stop.md` (already in worktree)
- Add: this plan
- Modify: ARCHITECTURE.md / `.ko.md`, README.md, SLASH_COMMANDS.md / `.ko.md`, `docs/headless.md`, `docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md`, `docs/superpowers/specs/2026-09-18-cancel-reset-followup.md`, `docs/superpowers/specs/2026-09-18-no-job-todo-revert.md`

- [ ] **Step 1: Write the plan (this file) and amend historical OUT lines**

One-line amendment only. Parent `/stop` is no longer “this session only.” Do not reopen keep-id `/clear` or stream `version` / `continuationToken`.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-18-parent-tree-stop.md \
  docs/superpowers/plans/2026-09-18-parent-tree-stop.md \
  ARCHITECTURE.md ARCHITECTURE.ko.md README.md \
  SLASH_COMMANDS.md SLASH_COMMANDS.ko.md docs/headless.md \
  docs/superpowers/specs/2026-09-12-ravenclaw-remaining-roadmap.md \
  docs/superpowers/specs/2026-09-18-cancel-reset-followup.md \
  docs/superpowers/specs/2026-09-18-no-job-todo-revert.md
git commit -m "$(cat <<'EOF'
docs: spec parent tree-stop and point the waist at it

Parent abort('cancel') becomes full tree-stop of descendants.
keep-id /clear and stream version/token stay OUT.
EOF
)"
```

---

### Task 2: K1 descendant walk + applyAskAnswer + snapshot

**Files:** `followup.ts`, `followup.test.ts`, `session-engine.ts` (`listOwnedPendingAsks`, `resolveAskTarget`), `session-engine.test.ts`, `index.ts`, `serve.ts`, `serve.test.ts`

- [ ] **Step 1: Write the failing tests**

In `describe('listOwnedPendingAsks')` add:

```ts
test('includes leftover-asks on grandchild sessions', async () => {
  const store = {
    async listPendingAsks(sessionId: string) {
      if (sessionId === 'grandchild') return [{ callId: 'call_grand' }]
      return []
    },
    async listSessions(filter: { parentSessionId: string }) {
      if (filter.parentSessionId === 'parent') return [{ id: 'child' }]
      if (filter.parentSessionId === 'child') return [{ id: 'grandchild' }]
      return []
    },
  }
  expect(await listOwnedPendingAsks(store, 'parent')).toEqual([{ callId: 'call_grand' }])
})

test('a parentSessionId cycle does not hang', async () => {
  const store = {
    async listPendingAsks() {
      return []
    },
    async listSessions(filter: { parentSessionId: string }) {
      if (filter.parentSessionId === 'a') return [{ id: 'b' }]
      if (filter.parentSessionId === 'b') return [{ id: 'a' }]
      return []
    },
  }
  expect(await listOwnedPendingAsks(store, 'a')).toEqual([])
})
```

In `session-engine.test.ts` add `parent applyAskAnswer settles a grandchild leftover-ask onto the grandchild session`.

In `serve.test.ts` add `GET snapshot pending list includes a grandchild leftover-ask`.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/yeonwoosung/Desktop/RavenClaw/.worktrees/parent-tree-stop-spec
bun test ./packages/core/src/session/followup.test.ts ./packages/core/src/loop/session-engine.test.ts ./packages/cli/src/serve.test.ts
```

- [ ] **Step 3: Implement**

```ts
export async function listDescendantSessionIds(
  store: { listSessions(filter: { parentSessionId: string }): Promise<Array<{ id: string }>> },
  sessionId: string,
): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>([sessionId])
  const queue = [sessionId]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    const children = await store.listSessions({ parentSessionId: current })
    for (const child of children) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      out.push(child.id)
      queue.push(child.id)
    }
  }
  return out
}
```

`listOwnedPendingAsks` = own rows plus `listPendingAsks` on every descendant id. Engine-local copy calls the export. `resolveAskTarget` matches `row.sessionId === this.id` or descendant ids (drop the one-hop `parentSessionId` reject). Serve snapshot / parked publish use the same walk.

- [ ] **Step 4: Re-run targeted tests**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: walk descendant leftover-asks as owned

listDescendantSessionIds is BFS with a seen-set. applyAskAnswer
and serve snapshot use the same walk.
EOF
)"
```

---

### Task 3: K2 registerChildEngine + cancelKind wins

**Files:** `types.ts`, `session-engine.ts` (registry + abort only), `phases.ts`, `agent.ts`, `session-engine.test.ts`, `log.ts`, `engine.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('parent cancel cancels a live child turn', async () => { /* child round_end.reason === 'cancelled' */ })
test('parent interrupt leaves a child leftover-ask', async () => { /* child row stays */ })
```

Keep `interrupt leaves a leftover-ask` green.

- [ ] **Step 2: Run tests to confirm they fail**

- [ ] **Step 3: Implement**

- `ToolContext.registerChildEngine?(engine): () => void`
- Parent `Map<childSessionId, SessionEngine>`; pass registrar on live `ToolContext` and `QueryLoopOptions`
- `spawnChild` registers after `createSessionEngine` (foreground and background); unregisters in `finally` after `engine.close`
- `abort('cancel')`: children first, then this `abortTurn`, then `treeStopFlight` (persist lands in Task 4; flight may be a no-op join until then)
- Wrappers forward `whenTreeStop`

- [ ] **Step 4: Re-run targeted tests**

```bash
bun test ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/tools/agent.test.ts
```

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: abort in-process child engines on parent cancel

registerChildEngine fans abort('cancel') before abortTurn so
cancelKind wins. Steer still ends the child aborted.
EOF
)"
```

---

### Task 4: K3 persist-before-drop descendants

**Files:** `session-engine.ts`, `session-engine.test.ts`

- [ ] **Step 1: Write / flip the failing tests**

Replace `parent cancel leaves a child leftover-ask` with `parent cancel abort-pairs a child leftover-ask`:

- child pending length 0
- exactly one `ABORTED_TEXT` on the **child** session
- none extra on the parent
- no `cancelled, ask still pending` when the walk succeeded
- parent `lastEnd.reason === 'cancelled'`
- `whenTreeStop()` → `{ descendantWork: true }`

Keep `cancel with no live turn does not drop leftover-asks`.

Add:

```ts
test('idle parent tree-stop drops descendant leftover-asks and keeps this session parked', async () => {})
test('idle parent cancel with no descendants reports no descendant work', async () => {})
test('persist-fail on one descendant leftover-ask continues the others', async () => {})
test('live parent cancel writes cancelled lastEnd; idle tree-stop invents none', async () => {})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/core/src/loop/session-engine.test.ts
```

- [ ] **Step 3: Implement treeStopFlight**

Await registered children until `liveTurnId() === null`. Then I2 persist-before-drop per descendant row. This-session I2 stays in the cancelled epilogue and only when this session had a live turn. Await `whenTreeStop()` before `listOwnedPendingAsks` in `submitMessage` / `rewindLast` / follow-up. After I2 + flight, emit `cancelled, ask still pending` only if an owned unpaired row remains.

- [ ] **Step 4: Re-run targeted tests**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: persist-before-drop descendant leftover-asks on tree-stop

Idle parent walks descendants only. This session's parked asks
stay. Persist-fail on one row continues the others.
EOF
)"
```

---

### Task 5: K4 serve envelope + TUI/ACP

**Files:** `serve.ts`, `serve.test.ts`, `app.tsx`, `opentui-app.ts`, `packages/acp/src/server.ts`, `acp-stdio.ts`, their tests

- [ ] **Step 1: Write the failing tests**

```ts
test('POST cancel on a live parent returns ok without awaiting tree-stop', async () => {})
test('POST cancel idle parent with descendant leftover-ask returns ok and walks', async () => {})
test('POST cancel idle parent with no descendant work is no_active_turn', async () => {})
test('POST cancel idle parent with stale turnId still tree-stops descendants', async () => {})
test('POST cancel on a live parent aborts a cached child runtime', async () => {})
```

Keep `POST cancel with stale turnId is a no-op` (live parent, different turn).

ACP: `session/cancel calls engine.abort` asserts `abort` was called with `'cancel'`.

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test ./packages/cli/src/serve.test.ts ./packages/acp/src/server.test.ts ./packages/cli/src/acp-stdio.test.ts ./packages/cli/src/opentui-app.test.ts
```

- [ ] **Step 3: Implement the ruling 4 table, cache abort, TUI notice, ACP `'cancel'`**

- [ ] **Step 4: Re-run targeted tests**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat: serve and host tree-stop cancel envelope

Idle parent with descendant work is 200 { ok: true }. Idle with
nothing stays no_active_turn. ACP cancel means cancel.
EOF
)"
```

---

### Task 6: K5 eval lock

**Files:** `packages/core/src/eval/run.ts`, `packages/core/src/eval/fixtures/parent-tree-stop/case.json`

- [ ] **Step 1: Add fixture + runner that fails if K3.1 / K3.2 / K3.3 regress**

Beats: live parent + child leftover-ask; idle parent + child leftover-ask; idle this-session parked; persist-fail on one of two children (`applyAskAnswer` still matches the failed row).

- [ ] **Step 2: `bun test ./packages/core/src/eval/run.test.ts`**

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
test: lock parent tree-stop in eval fixtures

Fails the runner if descendant persist-before-drop or idle
this-session parked-ask regresses.
EOF
)"
```

---

### Task 7: Shipped wording (after code)

- [ ] Mark this spec’s board K0.1–K5.1 done. Do not claim keep-id `/clear` or stream tokens.

```bash
git commit -m "$(cat <<'EOF'
docs: mark parent tree-stop waves implemented

Board K0–K5 done. Parallel doors stay OUT.
EOF
)"
```

---

## Success checks

1. Parent live cancel abort-pairs a child leftover-ask onto the child session with exactly one `ABORTED_TEXT`.
2. Idle parent cancel abort-pairs descendant leftover-asks and does **not** drop this session’s parked asks.
3. Persist-fail on one descendant leaves that row and continues the others.
4. In-process child live turn ends `cancelled` on parent `abort('cancel')`; interrupt does not abort-pair.
5. Serve idle parent + descendant work is `200 { ok: true }`; idle + nothing is `no_active_turn`; stale live `turnId` is still `no_active_turn`.
6. `listOwnedPendingAsks` is recursive; leftover-ask still wins rewind after the walk.
7. Eval fixture `parent-tree-stop` fails the runner if 1, 2, or 3 regress.
