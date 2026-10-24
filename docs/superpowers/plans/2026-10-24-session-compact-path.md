# Path-local compact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Autocompact and `/compact` splice a summary onto the current leaf path so a shared prefix stays active for other branches.

**Architecture:** New `SessionStore.spliceCompactPath` inserts the summary (and the assistant stub when the tail starts with a user) as a fresh root and reparents only the first tail row. `recordCompact` still inactivates ids for rewind and clear. `runAutocompact` calls the splice instead of `recordCompact`. The slash notices the two refusal strings.

**Tech Stack:** Bun, TypeScript, `SessionStore`, `runAutocompact`, `dispatchSharedSlash`.

**Spec:** `docs/superpowers/specs/2026-10-24-session-compact-path.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/session-compact-path` on branch `docs/session-compact-path`. Do not edit the main checkout.
- If `@ravenclaw/core` fails to resolve, run `bun install` in this worktree. Do not commit `bun.lock` or `node_modules`.
- Schema stays 12. No migration. No package version bump. No CHANGELOG.
- Do not edit `packages/core/src/session/rewind.ts`, `packages/core/src/loop/session-engine.ts`, `packages/core/src/loop/query-loop.ts`, `packages/core/src/loop/phases.ts`, schema SQL, `packages/durable`, `packages/sdk`, `ARCHITECTURE.md`, or `ARCHITECTURE.ko.md`.
- Do not change `recordCompact`, `recordCompactAndUpsertSession`, or `clearConversation`. They still set `active = 0`.
- Do not clone the tail. Do not put `parentId` on `Message`. Do not change `repairRoleAlternation`.
- `upsertSession` must keep omitting `leaf_id`.
- Targeted `bun test ./<files>` only. Paths start with `./`. Do not run bare `bun test` or `bash scripts/ci-unit.sh`.
- Commit subjects only, as given. No `Co-Authored-By` or `Signed-off-by`.

## Review Focus

These are the inputs most likely to hide another branch. Each one has a test in the task that owns it.

- A splice does not set `active = 0` on the prefix. After branching at `a` and appending `d`, splicing the `a,d` path to one summary leaves `branchAt(c)` as `a,b,c`. Task 1.
- Reparenting the first tail row is refused when an active row outside the leaf path walks through that id. The leaf, that parent, and `compactGeneration` stay as they were. Task 1.
- `runAutocompact` does not call `recordCompact`. `inactivatedIds` is `[]`. The summary row is stored and `loadMessages` on the current leaf is summary then tail, not the old prefix. Task 2.
- A tail that starts with a user persists the assistant stub first. Assert `loadMessages`, not `loadSession`, because `loadSession` may join the summary user with the next user. Do not change that join. Task 2.
- `/compact` notices `compact would move another branch` and `compact boundary is not on this path`. Success still notices `compact requested`. Task 3.

## Ruling

The spec's decision line says the summary's parent is `NULL`. The behavior section is binding when `inserted` has two rows: the assistant stub's `parent_id` is `NULL`, and the summary user's `parent_id` is the stub id. A one-row insert is the summary user with `parent_id` `NULL`. Cost if wrong: the stub is not on the loaded path, and the tail-starts-with-user test fails.

The spec's file list does not name `session-engine.test.ts`, but the verification command runs it. Those tests spy on `recordCompact` for the summary text. Task 2 retargets the spies to `spliceCompactPath`. Do not edit `session-engine.ts`.

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/types.ts` | `spliceCompactPath` on `SessionStore` |
| `packages/core/src/types.test.ts` | Stub on the `satisfies SessionStore` object |
| `packages/core/src/session/sqlite-store.ts` | Transactional splice |
| `packages/core/src/session/memory-store.ts` | Same rules and the same generation error |
| `packages/core/src/session/branch-store-tests.ts` | Shared store cases |
| `packages/core/src/compact/prune.ts` | `runAutocompact` calls the splice |
| `packages/core/src/compact/prune.test.ts` | Expectations that assumed inactivation |
| `packages/core/src/loop/session-engine.test.ts` | Spies that read the summary |
| `packages/cli/src/slash/dispatch.ts` | Notice the two refusal messages |
| `packages/cli/src/slash/dispatch.test.ts` | Those notices and success |

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 Store splice | `types.ts`, `types.test.ts`, `sqlite-store.ts`, `memory-store.ts`, `branch-store-tests.ts` |
| 2 Autocompact | `prune.ts`, `prune.test.ts`, `session-engine.test.ts` |
| 3 Slash notice | `slash/dispatch.ts`, `slash/dispatch.test.ts` |

Task 1 first. Task 2 needs the store method. Task 3 only needs `compactNow` to throw and can follow Task 2.

---

### Task 1: `spliceCompactPath`

**Files:**
- Modify: `packages/core/src/types.ts` (`SessionStore`, next to `recordCompact`)
- Modify: `packages/core/src/types.test.ts` (the object that `satisfies SessionStore`)
- Modify: `packages/core/src/session/sqlite-store.ts`
- Modify: `packages/core/src/session/memory-store.ts`
- Modify: `packages/core/src/session/branch-store-tests.ts`
- Test: `sqlite-store.test.ts` and `memory-store.test.ts` already call `registerBranchStoreTests`

**Interfaces:**
- Consumes: leaf walk (`readLeafPath` / the memory equivalent), `messageBind` plus `parent_id`, `indexMessageFts`, `insertBoundary`, `bumpCompact`. Do not call `insertMessageRow` or `pushMessage`. Those parent the new row to the current leaf and move the leaf.
- Produces:

```ts
spliceCompactPath(sessionId: string, opts: {
  generation: number
  summaryText: string
  inserted: Message[]
  boundaryId: string | null
}): Promise<void>
```

A duplicate `compact_boundaries` generation throws `PersistError` with message exactly `compact generation already used`. Memory has no SQL primary key, so it records generations used by this method and throws that same message. Sqlite catches the unique failure inside the transaction and throws that message so the transaction rolls back.

- [ ] **Step 1: Write the failing store tests**

Add these cases inside `registerBranchStoreTests`. Leave `inactivating a shared prefix hides it from the other branch` unchanged.

`splice keeps a shared prefix on the other branch`:

- Persist users `a`, `b`, `c`. `branchAt('s1', 'a')`. Persist user `d`.
- `spliceCompactPath` with `generation: 1`, `summaryText: 'sum'`, `inserted: [user(summaryId, 'sum', 10)]`, `boundaryId: null`.
- `loadMessages` ids are `[summaryId]`.
- `branchAt('s1', 'c')` ids are `['a', 'b', 'c']`.
- `listActiveMessageIds` still contains `a` and `d`.
- `listBranchNodes` shows the summary node's `parentId` as `null`.

`splice reparents only the first tail row`:

- Persist `u0`, `a0`, `u1`, `a1` in that order. Leaf is `a1`.
- Insert a stub assistant and a summary user. `boundaryId: 'u1'`.
- `loadMessages` ids are `[stubId, summaryId, 'u1', 'a1']`.
- The stub node's `parentId` is `null`. The summary node's `parentId` is `stubId`. `u1`'s `parentId` is `summaryId`.
- `loadSession(...).session.leafId` is still `a1`.
- `u0` and `a0` stay active. `a0`'s `parentId` is still `u0`.

`splice refuses a boundary another branch walks through`:

- Persist `a`, `b`, `c`. `branchAt('s1', 'b')`. Persist `d`, so the leaf path is `a, b, d` and `c` is a child of `b`.
- Splice with `boundaryId: 'b'` and one summary user.
- The call rejects with message `compact would move another branch`.
- `loadMessages` is still `['a', 'b', 'd']`. `compactGeneration` is still `0`. `b`'s `parentId` is still `a`.

`splice rejects a boundary off the leaf path`:

- Persist `a`, `b`. Call with `boundaryId: 'missing'`.
- Rejects with `compact boundary is not on this path`. Leaf path stays `a, b`.

`second splice of the same generation rolls back`:

- First splice succeeds at `generation: 1` with `boundaryId: null`.
- Second splice at `generation: 1` rejects with `compact generation already used`.
- `loadMessages` is still the first summary. `compactGeneration` is `1`.

`invalid compact splice`:

- `inserted: []` rejects with `invalid compact splice` and does not move the leaf.

- [ ] **Step 2: Run the store tests and confirm they fail**

Run: `bun test ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/memory-store.test.ts`

Expected: FAIL because `spliceCompactPath` is missing. A type error on the new call counts as red.

- [ ] **Step 3: Implement the splice**

Add the method after `recordCompact`. The types.test.ts stub resolves.

Both stores, one transaction or an equivalent snapshot rollback:

1. Missing session throws `session not found: <id>` before any write.
2. `inserted` length is 1 and that role is `user`, or length is 2 with roles `assistant` then `user`. Otherwise `invalid compact splice`.
3. An inserted id that already exists throws `duplicate message id <id>`.
4. The leaf path is the current active walk. If `boundaryId` is non-null and not on that path, throw `compact boundary is not on this path`.
5. If `boundaryId` is non-null, walk `parent_id` from every active row whose id is not on that path. Follow parents even when they are inactive. A repeated id throws `message cycle`. If the walk includes `boundaryId`, throw `compact would move another branch` before any insert.
6. Insert `inserted` in order. First `parent_id` is `null`. The second, if any, parents to the first id. Do not move the leaf. New rows are `active = 1`. Sqlite indexes them with `indexMessageFts`.
7. If `boundaryId` is non-null, set only that row's `parent_id` to the last inserted id. Leave `active` and the leaf. If `boundaryId` is null, set the leaf to the last inserted id.
8. Record the compact boundary and set `compact_generation` to `opts.generation`. On a duplicate generation, throw `compact generation already used` and roll back steps 6 and 7.

Do not set any prefix row to `active = 0`. Do not unindex those rows.

- [ ] **Step 4: Re-run**

Run: `bun test ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/memory-store.test.ts ./packages/core/src/types.test.ts ./packages/core/src/session/rewind.test.ts`

Expected: PASS. The rewind file is unchanged and still passes.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/types.test.ts packages/core/src/session/sqlite-store.ts packages/core/src/session/memory-store.ts packages/core/src/session/branch-store-tests.ts
git commit -m "feat(core): splice a compact onto the current leaf path"
```

---

### Task 2: `runAutocompact` splices

**Files:**
- Modify: `packages/core/src/compact/prune.ts` (`runAutocompact` only)
- Modify: `packages/core/src/compact/prune.test.ts`
- Modify: `packages/core/src/loop/session-engine.test.ts` (the `recordCompact` spies inside `describe('compactNow')`)
- Test: those two test files

**Interfaces:**
- Consumes: `buildPostCompactMessages`, `spliceCompactPath` from Task 1.
- Produces: no new export. `runAutocompact` still returns `{ messages, generation, inactivatedIds }`.

- [ ] **Step 1: Update the failing expectations**

In `prune.test.ts`:

- Replace the spy and the title of `calls store.recordCompact with middle ids; load omits inactivated`. Spy on `spliceCompactPath`. Expect one call with `generation: 1`, `summaryText: 'SUMMARY'`, and `boundaryId: 'u1'`.
- `result.inactivatedIds` is `[]`. `result.generation` is `1`.
- `result.messages` starts with the assistant stub `(conversation summary follows)`, then a user whose text is `SUMMARY`, then ids `u1`, `a1`. It does not contain `u0` or `a0`.
- `loadMessages` equals those result ids. `listActiveMessageIds` still contains `u0` and `a0`. Do not assert `loadSession` for this path.

In `tail starting on tool expands via selectProtectedTail`:

- `inactivatedIds` is `[]`.
- `result.messages[0]` is the summary user `SUMMARY`. The rest are `a2`, `t1`.
- `loadMessages` ids equal `result.messages` ids. `u1`, `a1`, and `u2` stay active.

In `session-engine.test.ts`, the three spies that read `recorded` from `recordCompact`, and the `compactCalls` counter, spy on `spliceCompactPath` instead. Read `opts.summaryText`. Keep the assertions on `provider.streamCount`, `compactGeneration`, and `compactCalls` (0 during the live turn, 1 after it). Do not change `session-engine.ts`.

- [ ] **Step 2: Run and confirm failure**

Run: `bun test ./packages/core/src/compact/prune.test.ts ./packages/core/src/loop/session-engine.test.ts`

Expected: FAIL because `runAutocompact` still calls `recordCompact` and inactivates the prefix.

- [ ] **Step 3: Switch the call**

Inside `runAutocompact`, after the summary and the post-compact array exist:

```ts
const generation = opts.generation + 1
const tailIds = new Set(tail.map((msg) => msg.id))
const inserted = messages.filter((msg) => !tailIds.has(msg.id))
await opts.store.spliceCompactPath(opts.sessionId, {
  generation,
  summaryText: summary,
  inserted,
  boundaryId: tail[0]?.id ?? null,
})
return { messages, generation, inactivatedIds: [] }
```

`messages` here is the array from `appendUserNotes(buildPostCompactMessages(...))`, which is what the function already returns. Do not call `recordCompact`. If the store throws, do not catch it.

- [ ] **Step 4: Re-run**

Run: `bun test ./packages/core/src/compact/prune.test.ts ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/session/rewind.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/compact/prune.ts packages/core/src/compact/prune.test.ts packages/core/src/loop/session-engine.test.ts
git commit -m "feat(core): keep other branches when autocompact runs"
```

---

### Task 3: `/compact` notices a refusal

**Files:**
- Modify: `packages/cli/src/slash/dispatch.ts` (the `compact` case)
- Modify: `packages/cli/src/slash/dispatch.test.ts`
- Test: `packages/cli/src/slash/dispatch.test.ts`

**Interfaces:**
- Consumes: `runtime.engine.compactNow()`. The fake in the dispatch tests is `async compactNow() {}`.
- Produces: no new export.

- [ ] **Step 1: Write the failing dispatch tests**

Override `compactNow` on the fake engine:

- It throws `new PersistError('unknown', 'compact would move another branch')`. The notice is that string. The result is `'handled'`. `compact requested` is not noticed.
- A second test throws `compact boundary is not on this path` and expects that notice.
- A successful `compactNow` still notices `compact requested`.
- Import `PersistError` from `@ravenclaw/core` if the tests construct it. A plain `Error` with the same message must also be noticed, because the `catch` checks `error.message`.

- [ ] **Step 2: Run**

Run: `bun test ./packages/cli/src/slash/dispatch.test.ts`

Expected: FAIL. The refusal throws out of `dispatchSharedSlash` instead of being noticed.

- [ ] **Step 3: Catch only those two messages**

```ts
case 'compact':
  try {
    await runtime.engine.compactNow()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      message === 'compact would move another branch' ||
      message === 'compact boundary is not on this path'
    ) {
      host.notice(message)
      return 'handled'
    }
    throw error
  }
  host.notice('compact requested')
  return 'handled'
```

Do not catch other errors. Do not change the success string.

- [ ] **Step 4: Re-run the spec command**

```bash
bun test ./packages/core/src/compact/prune.test.ts ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/memory-store.test.ts ./packages/core/src/session/rewind.test.ts ./packages/core/src/loop/session-engine.test.ts ./packages/core/src/types.test.ts ./packages/cli/src/slash/dispatch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/slash/dispatch.ts packages/cli/src/slash/dispatch.test.ts
git commit -m "feat(cli): notice when compact would move another branch"
```

Do not commit the spec or this plan in that commit. If they are still untracked when implementation starts, commit them first:

```bash
git add docs/superpowers/specs/2026-10-24-session-compact-path.md docs/superpowers/plans/2026-10-24-session-compact-path.md
git commit -m "docs: add the path-local compact spec and plan"
```

That docs commit is before Task 1, not part of Task 3.
