# `/branch` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shared slash `/branch [n]` that lists the current leaf path and other active tips, then calls existing `SessionEngine.branchAt` with the id the spec chooses.

**Architecture:** `listBranchNodes` is a read-only store method (active rows plus `parentId`, sorted by `createdAt` then `id`). Pure helpers in `branch-cmd.ts` parse the argument and format lines. `dispatchSharedSlash` owns selection. Ink and OpenTUI only implement `SlashHost.onBranched`. `branchAt`, schema 12, and `queryLoop` stay as they are.

**Tech Stack:** Bun, TypeScript, `SessionStore`, `dispatchSharedSlash`, Ink `app.tsx`, OpenTUI `opentui-app.ts`.

**Spec:** `docs/superpowers/specs/2026-10-23-session-branch-ui.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/session-branch-ui` on branch `docs/session-branch-ui`. Do not edit the main checkout.
- If `@ravenclaw/core` fails to resolve, run `bun install` in this worktree. Do not commit `bun.lock` or `node_modules`.
- Schema stays 12. No migration. No package version bump. No CHANGELOG.
- Do not edit `packages/core/src/loop/session-engine.ts`, `packages/core/src/session/rewind.ts`, `packages/core/src/loop/phases.ts`, `packages/core/src/loop/query-loop.ts`, schema SQL, `packages/durable`, `packages/sdk`, `packages/cli/src/serve.ts`, `ARCHITECTURE.md`, or `ARCHITECTURE.ko.md`.
- Do not change `branchAt`'s meaning, refusal order, or return shape. The slash only chooses the id.
- `HOST_ONLY` stays `quit`, `stop`, `clear`, `resume`, `diff`, `retry`, `queue`, `loop`, `bash`. No `/tree` alias. No composer fill. No file, git, or todo restore.
- The slash calls `loadMessages`, never `loadSession`.
- Targeted `bun test ./<files>` only. Paths start with `./`. Do not run bare `bun test` or `bash scripts/ci-unit.sh`.
- Commit subjects only, as given. No `Co-Authored-By` or `Signed-off-by`.

## Review Focus

These are the inputs most likely to move the wrong leaf. Each one has a test in the task that owns it.

- A current-path user row must pass the previous `loadMessages` id, not the selected id and not a hidden inactive parent. Task 3.
- An `other` tip must pass that tip id, not its parent. Task 3.
- `/branch` with no number, `already at the start`, and `already at this point` must not call `branchAt`. Task 3.
- `onBranched` runs only for `{ ok: true, messages }`. A refusal leaves the Ink rows untouched because the callback is not called. Task 3. OpenTUI must not call `view.reset()` and must still show the earlier scrollback. Task 4.
- `listBranchNodes` sorts by `createdAt` then `message.id` in both stores, omits `active = 0`, and does not copy `parentId` onto `Message`. Task 1.

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/types.ts` | `SessionBranchNode`, `SessionStore.listBranchNodes` |
| `packages/core/src/types.test.ts` | `satisfies SessionStore` stub returns `[]` |
| `packages/core/src/session/sqlite-store.ts` | Active rows to nodes, sorted |
| `packages/core/src/session/memory-store.ts` | Same sort, same errors |
| `packages/core/src/session/branch-store-tests.ts` | Shared store cases |
| `packages/cli/src/branch-cmd.ts` | `parseBranchArg`, `formatBranchList`, `formatBranchNotice` |
| `packages/cli/src/branch-cmd.test.ts` | Parse and line fixtures |
| `packages/cli/src/commands.ts` | `SLASH_COMMANDS` row after `rewind` |
| `packages/cli/src/commands.test.ts` | Name array |
| `packages/cli/src/slash/dispatch.ts` | `onBranched`, `case 'branch'` |
| `packages/cli/src/slash/dispatch.test.ts` | Selection and notices |
| `packages/cli/src/app.tsx` | Ink `onBranched` |
| `packages/cli/src/opentui-app.ts` | OpenTUI `onBranched` |
| `packages/cli/src/opentui-app.test.ts` | `fakeEngine.branchAt`, one success test |
| `README.md`, `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md` | One row and one section |

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 Store read | `types.ts`, `types.test.ts`, `sqlite-store.ts`, `memory-store.ts`, `branch-store-tests.ts` |
| 2 Line format | `branch-cmd.ts`, `branch-cmd.test.ts` |
| 3 Slash selection | `commands.ts`, `commands.test.ts`, `slash/dispatch.ts`, `slash/dispatch.test.ts` |
| 4 Host screens | `app.tsx`, `opentui-app.ts`, `opentui-app.test.ts` |
| 5 Docs | `README.md`, `SLASH_COMMANDS.md`, `SLASH_COMMANDS.ko.md` |

Task 1 first. Task 2 is independent of task 1 and may follow it. Task 3 needs 1 and 2. Task 4 needs 3. Task 5 last.

---

### Task 1: `listBranchNodes`

**Files:**
- Modify: `packages/core/src/types.ts` (`SessionStore`, next to `listActiveMessageIds`)
- Modify: `packages/core/src/types.test.ts` (the object that `satisfies SessionStore`)
- Modify: `packages/core/src/session/sqlite-store.ts`
- Modify: `packages/core/src/session/memory-store.ts`
- Modify: `packages/core/src/session/branch-store-tests.ts`
- Test: `packages/core/src/session/sqlite-store.test.ts` and `memory-store.test.ts` already call `registerBranchStoreTests`

**Interfaces:**
- Consumes: `messageFromRow` in sqlite; memory `Stored.parentId` and `rowsOf`. `listActiveMessageIds` already throws `session not found: <id>`.
- Produces:

```ts
export interface SessionBranchNode {
  message: Message
  parentId: string | null
}

listBranchNodes(sessionId: string): Promise<SessionBranchNode[]>
```

`export * from './types'` already re-exports this. Do not edit `packages/core/src/index.ts`.

- [ ] **Step 1: Write the failing store tests**

Add these cases inside `registerBranchStoreTests` in `branch-store-tests.ts`.

`lists active nodes with parents and skips inactive rows`:

- Create session `s1`. `persistUser` `a` at createdAt 1, `b` at 2, `c` at 3.
- `branchAt('s1', 'a')`, then `persistUser` `d` at 4.
- `recordCompact('s1', 1, 'sum', ['c'])`.
- `listBranchNodes('s1')` mapped to `{ id, parentId, role }` equals, in order: `a/null/user`, `b/a/user`, `d/a/user`. `c` is absent.
- `message` objects have no `parentId` field (`'parentId' in node.message` is false).

`orders equal createdAt by id`:

- `persistUser` `m` and `a`, both `createdAt: 5`, in that call order.
- The two new nodes come out `a` then `m`.

`missing session`:

- `listBranchNodes('missing')` rejects with `PersistError` whose message is exactly `session not found: missing`.

- [ ] **Step 2: Run the store tests and confirm they fail**

Run: `bun test ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/memory-store.test.ts`

Expected: FAIL because `listBranchNodes` is missing. A type error on the new call counts as red.

- [ ] **Step 3: Implement the read**

Add the interface after `listActiveMessageIds`. The types.test.ts stub returns `[]`.

Both stores: missing session throws `new PersistError('unknown', `session not found: ${sessionId}`)` before reading messages. Map `active === 1` rows to `{ message, parentId }`. Do not attach `parentId` to `message`. Sort by `message.createdAt` ascending, then `message.id` ascending using string comparison. Do not sort by sqlite `rowid`. Do not write the leaf or any `active` flag.

Sqlite may read with the existing `selectMessagesBySession` and filter `active === 1`. Memory filters `rowsOf`.

- [ ] **Step 4: Re-run**

Run: `bun test ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/memory-store.test.ts ./packages/core/src/types.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/types.test.ts packages/core/src/session/sqlite-store.ts packages/core/src/session/memory-store.ts packages/core/src/session/branch-store-tests.ts
git commit -m "feat(core): list active branch nodes with parents"
```

---

### Task 2: Parse and format `/branch` lines

**Files:**
- Create: `packages/cli/src/branch-cmd.ts`
- Create: `packages/cli/src/branch-cmd.test.ts`

**Interfaces:**
- Consumes: `Message` from `@ravenclaw/core`.
- Produces:

```ts
export type BranchArg =
  | { action: 'list' }
  | { action: 'select'; n: number }
  | { action: 'error' }

export function parseBranchArg(raw: string | undefined): BranchArg
export function formatBranchList(messages: Message[]): string
export function formatBranchNotice(path: Message[], others: Message[]): string
```

- [ ] **Step 1: Write the failing formatter tests**

`parseBranchArg(undefined)`, `''`, and `'   '` are `{ action: 'list' }`. `'2'` and `'02'` are `{ action: 'select', n: 2 }`. `'0'`, `'foo'`, and `'2 extra'` are `{ action: 'error' }`.

Preview rules, asserted through `formatBranchList`:

- Text blocks `a` and `b` become one preview `a b`.
- `'a\nb'` and `'a  b'` both preview as `a b`.
- No text blocks, or only an image block, previews as `(no text)`.
- 60 `a` characters stay 60. 61 `a` characters become 59 `a` characters plus `…` (U+2026).

`formatBranchList` of a user `hello` then an assistant `world` is exactly:

```text
  1 user  hello
* 2 assistant  world
```

A one-message list is `* 1 user  hi` (the only row is the leaf).

`formatBranchNotice(path, [otherUser])` for that two-message path and one other user whose text is `earlier tip` is exactly:

```text
  1 user  hello
* 2 assistant  world

other
  3 user  earlier tip
```

`formatBranchNotice([], [otherUser])` is `  1 user  earlier tip` with no `other` header and no star.

- [ ] **Step 2: Run**

Run: `bun test ./packages/cli/src/branch-cmd.test.ts`

Expected: FAIL, module missing.

- [ ] **Step 3: Implement `branch-cmd.ts`**

`parseBranchArg`: trim; empty means list; `/^\d+$/` and `Number(arg) >= 1` means select that number; otherwise error.

Preview: join `type: 'text'` blocks with a single space, replace each `[\r\n]+` run with one space, collapse spaces, trim. Empty result is `(no text)`. Longer than 60 characters is `slice(0, 59) + '…'`.

A path line is `* ` for the last path index and two spaces otherwise, then `${n} ${role}  ${preview}`. `formatBranchList` numbers from 1 and stars the last row. `formatBranchNotice` prints the path, then when `others` is non-empty and the path is non-empty a blank line and the line `other`, then the other messages continuing the numbers. Others are never starred. An empty path with others numbers those others from 1 and omits `other`.

- [ ] **Step 4: Re-run**

Run: `bun test ./packages/cli/src/branch-cmd.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/branch-cmd.ts packages/cli/src/branch-cmd.test.ts
git commit -m "feat(cli): format the /branch list"
```

---

### Task 3: Register `/branch` and select the id

**Files:**
- Modify: `packages/cli/src/commands.ts` (the `rewind` entry, then `diff`)
- Modify: `packages/cli/src/commands.test.ts` (the `toEqual` name array)
- Modify: `packages/cli/src/slash/dispatch.ts` (`SlashHost`, new `case 'branch'` before `default`)
- Modify: `packages/cli/src/slash/dispatch.test.ts`
- Test: those two test files

**Interfaces:**
- Consumes: `parseBranchArg`, `formatBranchList` is not used here, `formatBranchNotice`, `SessionStore.loadMessages`, `SessionStore.listBranchNodes`, `SessionEngine.branchAt`.
- Produces: `SlashHost.onBranched?(messages: Message[]): void`. Dispatch returns `'handled'` for `branch`.

Catalog row, no aliases:

```ts
{ name: 'branch', usage: '/branch [n]', summary: 'list this path, or branch at a numbered message' }
```

Insert `'branch'` in the name array after `'rewind'` and before `'diff'`.

- [ ] **Step 1: Write the failing dispatch tests**

Give `fakeRuntime` an optional store override. Each test uses a store with `loadMessages` and `listBranchNodes`, and an engine whose `branchAt` records the id.

Path messages, in order: user `u1` text `one`, assistant `a1` text `two`, user `u2` text `three`. Other node: user `old` text `tip`, `parentId: 'u1'`. `listBranchNodes` returns path nodes plus that other node. `loadMessages` returns the three path messages.

Assert:

- No arg, `''`, and `'   '` notice the `formatBranchNotice` text. `branchAt` is not called. `onBranched` is not called. Return value is `'handled'`.
- `'/branch'` is not in `HOST_ONLY`: dispatch does not return `'host'`.
- Arg `3` calls `branchAt('a1')` once. Stub returns `{ ok: true, messages: [u1, a1] }`. Notice is `branched at 2 assistant`. `onBranched` receives that array. `runTurn` is not called.
- Arg `1` notices `already at the start` and does not call `branchAt`.
- Arg `2` (the assistant leaf of a path that is only `u1`, `a1`) notices `already at this point` and does not call `branchAt`.
- A path whose first row is an assistant: arg `1` calls `branchAt` with that assistant id. It must not notice `already at the start`.
- Arg `4` calls `branchAt('old')`, not `u1`.
- Arg `9` notices `no message 9`. Arg `foo` notices `usage: /branch [n]`. Neither calls `branchAt`.
- Both reads empty: no-arg notices `nothing to branch`.
- `branchAt` resolving `{ ok: false, notice: 'pending permission ask' }` or `{ ok: false, notice: 'a turn is in progress' }` or `{ ok: true, notice: 'nothing to rewind' }` passes that string through and does not call `onBranched`.
- `loadMessages` rejecting `Error('leaf not found: x')` notices `leaf not found: x`, does not call `listBranchNodes`, and does not call `branchAt`.
- Store object with neither `loadMessages` nor `listBranchNodes`: notice `branch unavailable`.
- `loadMessages` succeeding and `listBranchNodes` rejecting `Error('session not found: s1')` notices that message and does not call `branchAt`.

`commands.test.ts`: the name array includes `branch` in that position. `SLASH_COMMANDS.find(name === 'branch')?.aliases` is `undefined`. Existing `SLASH_HELP.split('\n')` length assertion stays.

- [ ] **Step 2: Run**

Run: `bun test ./packages/cli/src/commands.test.ts ./packages/cli/src/slash/dispatch.test.ts`

Expected: FAIL. `/branch` is still `unknown command: /branch`, or the name array does not match.

- [ ] **Step 3: Implement selection**

Parse first. `{ action: 'error' }` notices `usage: /branch [n]` and returns `'handled'` without reading the store.

If `loadMessages` or `listBranchNodes` is not a function, notice `branch unavailable` and return.

Await `loadMessages(session.id)`. On throw, notice `error.message` or `String(error)` and return. Then await `listBranchNodes`. On throw, same notice rule and return.

Other tips: nodes whose `message.id` is not in the path id set, and whose id is not any node's `parentId`. Keep `listBranchNodes` order.

No-arg: if path and others are both empty, notice `nothing to branch`. Otherwise notice `formatBranchNotice(path, others)`. Do not call `branchAt`.

Select `n` with this rule and no other:

```text
entries length = path.length + others.length
n > length -> notice `no message ${n}`
n <= path.length and path[n - 1].role === 'user' and n === 1 -> `already at the start`
n <= path.length and role === 'user' -> target = path[n - 2].id
n <= path.length -> target = path[n - 1].id
else -> target = others[n - path.length - 1].message.id
path non-empty and target === path[path.length - 1].id -> `already at this point`
else engine.branchAt(target) once
```

`{ ok: true, messages }` notices ``branched at ${messages.length} ${messages[messages.length - 1].role}`` and calls `host.onBranched?.(messages)`. Every other result notices `result.notice` and does not call `onBranched`.

- [ ] **Step 4: Re-run**

Run: `bun test ./packages/cli/src/commands.test.ts ./packages/cli/src/slash/dispatch.test.ts ./packages/cli/src/branch-cmd.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands.ts packages/cli/src/commands.test.ts packages/cli/src/slash/dispatch.ts packages/cli/src/slash/dispatch.test.ts
git commit -m "feat(cli): move the session leaf from /branch"
```

---

### Task 4: Show the new path in Ink and OpenTUI

**Files:**
- Modify: `packages/cli/src/app.tsx` (the `dispatchSharedSlash` host object near the `notice: setNotice` field)
- Modify: `packages/cli/src/opentui-app.ts` (the host object near `notice`)
- Modify: `packages/cli/src/opentui-app.test.ts` (`fakeEngine` and `fakeStore`)
- Test: `packages/cli/src/opentui-app.test.ts`

**Interfaces:**
- Consumes: `onBranched?(messages: Message[])` from Task 3. `formatBranchList` from Task 2. `rowsFromMessages` already imported in `app.tsx`.
- Produces: no new export.

- [ ] **Step 1: Write the failing OpenTUI test**

Add `branchAt` to `fakeEngine`, defaulting to `{ ok: false, notice: 'branch unavailable' }`, so the `SessionEngine` return has the method.

Extend `fakeStore` so `loadMessages(sessionId)` returns `extras.messages?.[sessionId] ?? []`, and `listBranchNodes(sessionId)` returns `extras.branchNodes?.[sessionId] ?? []`.

One test:

- Session messages: user `u1` `one`, assistant `a1` `two`, user `u2` `three`.
- `branchNodes` for that session: those three with parents `null`, `u1`, `a1`, and no other tip.
- `engine.branchAt` records the id and returns `{ ok: true, messages: [u1, a1] }`.
- Input lines: `hello`, then `/branch 3`, then `/quit`.
- The joined write contains `you  hello`, `branched at 2 assistant`, and `* 2 assistant  two`.
- It still contains `you  hello` after the branch notice (scrollback was not cleared).
- `branchAt` was called with `a1` only.
- No prompt was submitted (`submitted` stays empty). The write is not `view.reset` output: do not assert a cleared screen. Assert `you  hello` remains.

- [ ] **Step 2: Run**

Run: `bun test ./packages/cli/src/opentui-app.test.ts`

Expected: FAIL. `/branch` is unknown, or `branchAt` is missing, until the host and the fake are updated. If the fake typecheck fails first, that is red.

- [ ] **Step 3: Wire both hosts**

Ink, inside the existing shared-host object:

```ts
onBranched(messages) {
  setRows(rowsFromMessages(messages))
  setSelectedIndex(undefined)
  setExpandedIds(new Set())
}
```

Do not change draft, todos, tasks, model, mode, or diff selection. Do not put a second `case 'branch'` in the host `switch`.

OpenTUI, inside its shared-host object:

```ts
onBranched(messages) {
  write(`${formatBranchList(messages)}\n`)
}
```

Do not call `view.reset()`. Do not put `branch` in `HOST_ONLY`. Do not write an `other` section here.

- [ ] **Step 4: Re-run**

Run: `bun test ./packages/cli/src/opentui-app.test.ts ./packages/cli/src/slash/dispatch.test.ts`

Expected: PASS. There is no Ink component test harness. Do not add one. The Ink behavior is the three state updates above, and Task 3 already proves `onBranched` is skipped on refusal.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/app.tsx packages/cli/src/opentui-app.ts packages/cli/src/opentui-app.test.ts
git commit -m "feat(cli): show the branched path in both TUIs"
```

---

### Task 5: Document `/branch`

**Files:**
- Modify: `README.md` (slash table, the `/rewind` row)
- Modify: `SLASH_COMMANDS.md` (section after `### /rewind`, before `### /retry [text]`; the live-turn refuse row; the session-surgery table)
- Modify: `SLASH_COMMANDS.ko.md` (classification row after `rewind`; section after `### /rewind`; surgery row)
- Do not edit the Korean mermaid or the `HOST_ONLY` list of nine names.

**Interfaces:**
- Consumes: the notice strings and host split from Tasks 3 and 4.
- Produces: no code.

- [ ] **Step 1: Update the three docs**

README row, directly under `/rewind`:

```markdown
| `/branch [n]` | List the current leaf path, or move the leaf to a numbered message |
```

`SLASH_COMMANDS.md` section `### /branch [n]`:

- Aliases: none. Kind: shared.
- `/branch` lists `loadMessages`. The leaf line starts with `* `. Other active tips follow a line whose text is `other`.
- A current-path user number passes the previous path id. User number 1 notices `already at the start`.
- An assistant or tool on the path passes that id. An other-tip number passes that tip id, not its parent.
- Success notice is `branched at <k> <role>`. Ink replaces transcript rows from the returned messages. OpenTUI prints `formatBranchList` of that path under the notice and does not clear scrollback.
- Refusals from `branchAt` are printed unchanged, including `a turn is in progress` and `pending permission ask`.
- Does not rewind files, git, or todos, and does not fill the composer.
- Spec: `docs/superpowers/specs/2026-10-23-session-branch-ui.md`.

Add `/branch` to the refuse row that names `/rewind` and `/retry`. Add a session-surgery row: files unchanged, transcript becomes the selected leaf path, other tips stay active, session id unchanged. Extend the sentence that only `/rewind` and open-generation `/undo` refuse a live turn so it includes `/branch`.

Korean classification row after `rewind`: `` `branch` ``, shared, list or move the leaf, engine refusal notices passed through, success `` `branched at <k> <role>` ``. Korean section after `/rewind` states the same rules. Quote the English notice strings. Surgery row matches the English one. Leave the mermaid and the nine-name `HOST_ONLY` list unchanged.

- [ ] **Step 2: Check the words and run the spec command**

```bash
rg -n "/branch" README.md SLASH_COMMANDS.md SLASH_COMMANDS.ko.md
bun test ./packages/cli/src/branch-cmd.test.ts ./packages/cli/src/commands.test.ts ./packages/cli/src/slash/dispatch.test.ts ./packages/cli/src/opentui-app.test.ts ./packages/core/src/session/sqlite-store.test.ts ./packages/core/src/session/memory-store.test.ts ./packages/core/src/types.test.ts
```

Expected: all three docs mention `/branch`. The test command passes. `rg` does not need to match `ARCHITECTURE.md`.

- [ ] **Step 3: Commit**

```bash
git add README.md SLASH_COMMANDS.md SLASH_COMMANDS.ko.md
git commit -m "docs: describe /branch"
```

Do not commit the spec or this plan in that commit. They stay with the docs commit only if they are still untracked when implementation starts; if so, add them in a separate commit first:

```bash
git add docs/superpowers/specs/2026-10-23-session-branch-ui.md docs/superpowers/plans/2026-10-23-session-branch-ui.md
git commit -m "docs: add the /branch spec and plan"
```

That docs commit is before Task 1, not part of Task 5.
