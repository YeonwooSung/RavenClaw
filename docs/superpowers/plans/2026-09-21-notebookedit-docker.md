# NotebookEdit docker — Implementation Plan

I'm using the writing-plans skill to create the implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Bash is actually a docker `TerminalBackend` (kind + image), NotebookEdit reads and writes `.ipynb` bytes through that same port: one `cat` exec, one `tee` exec with stdin. Every backend (including today’s local singleton) grows a cwd jail before any I/O. Parse/stringify stay host. SDK still omits the tool. WorkspaceFs / Read / Write stay host. Spec + this plan first; then TDD in this isolated worktree.

**Architecture:** `createNotebookEditTool(backend?: TerminalBackend)` wraps the existing leftover-ask tool. Omit / `kind !== 'docker'` / image-less `createTerminalBackend('docker')` → host `readFileSync` / `writeFileSync` **after** the new jail. `kind === 'docker'` → two `backend.exec` calls (`cat` then `tee`+stdin), never a combined script, never host `writeFileSync` as the write path. Shared `stdin?: string | Uint8Array` lands on `TerminalExecOpts` / `TerminalRunRequest` (absent at `0a1176f`). Default export `notebookEditTool = createNotebookEditTool()` stays local. CLI `createRootTools` already takes optional last `backend`; when it is set, pass it into the factory. `createSessionEngine` still has no backend instance.

**Tech Stack:** Bun, TypeScript, existing `TerminalBackend` / `createDockerTerminalBackend` / `resolveWritePath` / `isHardDeniedWritePath` / `isInTreePath` / `wasRead` / `notebook-format.ts`. Fake `runCommand` like `terminal-backend.test.ts`. No live docker required to merge.

**Spec:** `docs/superpowers/specs/2026-09-21-notebookedit-docker.md`

## Global Constraints

- One `queryLoop`. Hosts only `submitMessage` for new user text. `applyAskAnswer` stays the only non-`submitMessage` closer. NotebookEdit stays leftover-ask (`checkPermissions` `{ behavior: 'ask', message: 'Edit this notebook?', saveAs: 'session' }`).
- Default prefix small and frozen. No new always-on tool. Factory wraps NotebookEdit.
- `dontAsk` never becomes `bypass`. `acceptEdits` / `dontAsk` still do not promote NotebookEdit. `dontAsk` leftover of NotebookEdit stays deny at `decidePermission`.
- BYOK. Ads never touch BYOK.
- Clean-room. No vendor copy. **No web UI, no Next.js BFF, no Prisma Task, no Socket.IO, no wiki, no WorkspaceFs docker I/O, no Read/Write/Edit docker, no dismiss-on-message, no LSP museum, no SDK NotebookEdit, no schema bump.**
- Targeted `bun test ./<files>` only (path must start with `./`). Isolated `.worktrees/` + TDD. Do not implement on `main`. Do not push. All commands below assume cwd is this worktree.
- `createSessionEngine` stays the existing async factory and still takes **no** `TerminalBackend` instance. Eval that needs docker NotebookEdit would inject `createNotebookEditTool(fakeBackend)` in `tools`. This door adds **no** eval fixture (`sandbox-fs` does not exist at `0a1176f`).
- Independent of WorkspaceFs docker. Do **not** wait for, and do **not** implement, Read/Write docker. Do **not** edit `workspace-fs.ts`, `read.ts`, `write.ts`, `edit.ts`, `apply-patch.ts`, `list-dir.ts`, `read-subtree.ts`, `loop/`, schema, SDK `createRootTools` tool list, or `notebook-format.ts`.
- Secrets: allowlist env only (`PATH` / `HOME` / `TERM` / `LANG`). No docker.sock. No `ANTHROPIC_API_KEY` in the container.

### Plan rulings (amend the spec where they disagree)

The spec stays the product authority. These lines resolve underspecification only.

1. **IN is NotebookEdit only.** Parse/stringify stay host (`notebook-format.ts` unchanged as a format library). Only bytes on disk move through the docker port.

2. **Independent of WorkspaceFs docker.** Private cat/tee helpers live in `notebook-edit.ts`. Do **not** create `sandbox-fs.ts` (it does not exist at `0a1176f`). Do **not** import `workspace-fs.ts`. If a sibling already added `sandbox-fs.ts`, you MAY import it — this worktree must not create WorkspaceFs docker behavior. Copy the one-line `shQuote` locally; do not import `sandbox-search.ts`.

3. **`createNotebookEditTool(backend?: TerminalBackend)`.** Omit / `backend.kind !== 'docker'` / image-less docker constructor (`createTerminalBackend('docker')` stamps `kind: 'local'`) → today’s host `readFileSync`/`writeFileSync` **after** the new jail. `export const notebookEditTool = createNotebookEditTool()` stays the local singleton so existing tests stay green.

4. **CLI `createRootTools` already takes optional last `backend?: TerminalBackend` and already includes `notebookEditTool` (engine.ts:216–233).** When `backend !== undefined`, use `createNotebookEditTool(backend)`; when omitted keep the singleton (identity-stable). SDK `createRootTools` **still omits** NotebookEdit — do not add it.

5. **Cwd jail before any I/O on BOTH backends.** After `resolveWritePath(ctx.turn.cwd, input.path)` the execute order is locked: (1) `isHardDeniedWritePath(resolved)` → exactly `` `NotebookEdit failed: write denied to protected path: ${input.path}` ``; (2) `isInTreePath(ctx.turn.cwd, resolved)` from `packages/core/src/permissions/modes.ts:72` with **no** `extraRoots` / `additionalDirectories`; miss → exactly `NotebookEdit failed: outside workspace` (return the string; do not throw-and-wrap); (3) `wasRead` → `` `NotebookEdit failed: path must be Read first: ${input.path}` ``; (4) I/O. Jail miss and hard-deny do **no** `backend.exec` and **no** host read/write. Adding this jail on the **local** path is in-scope.

6. **`wasRead` unchanged.** Keys stay host resolved paths (`resolved` plus `resolve(cwd, input.path)`). Missing prior Read → `NotebookEdit failed: path must be Read first:` with no exec.

7. **Docker: two `backend.exec` calls, not a combined script.** Read command is exactly `` `cat ${shQuote(resolved)}` `` (stdout = notebook JSON text). Write command is exactly `` `tee ${shQuote(resolved)}` `` with `stdin: stringifyNotebook(nb)` (a `string`, not embedded in `bash -c`). Timeout `30_000` on both. `cwd: ctx.turn.cwd`. Do not call `backend.start`.

8. **Shared stdin field (Task 3 owns it).** At `0a1176f` `TerminalExecOpts` and `TerminalRunRequest` have no `stdin`. Add `stdin?: string | Uint8Array` to **both**. `runSpawned` uses `stdio: ['pipe', 'pipe', 'pipe']` only when `stdin !== undefined`; otherwise keep `['ignore', 'pipe', 'pipe']`. Write the chunk then `end()`. Docker argv already has `-i` — do not change `dockerRunRequest` argv. Local `exec` / `start` honor the same field. If a sibling already added that field, consume it and do not fork a second stdin API.

9. **Fail-closed, split by cause.** No daemon / missing `cat`/`tee` / non-zero cat or tee / 30s timeout (`exitCode === 124`) → `NotebookEdit failed:` + stderr/stdout/message, **no** host `writeFileSync`, in-memory parsed notebook discarded. Turn abort (`ctx.signal` / `AbortError` from `backend.exec`) **throws `AbortError`**. Do not stringify abort into `NotebookEdit failed:`. Tool keeps `interruptBehavior: 'block'` (phases.ts already maps).

10. **Snapshot order unchanged.** After a successful in-memory edit, `fileHistory.snapshot(resolved)` on the host bind path, **then** docker tee / host write. Cat / parse / apply failure: no snapshot and no write exec. Lint is N/A. Undo stays host file-history.

11. **Permissions unchanged.** Leftover-ask. `acceptEdits` / `dontAsk` do not promote. `dontAsk` leftover of NotebookEdit stays deny at `decidePermission`. Do not edit `pipeline.ts`.

12. **No new eval fixture.** `packages/core/src/eval/fixtures/` has `sandbox-search` and `sandbox-cwd`; there is no `sandbox-fs`. Skip eval. Unit tests are required.

13. **Secrets / schema / export.** Allowlist env only. No docker.sock. No schema bump. No new tool. Export `createNotebookEditTool` from `packages/core/src/index.ts` next to `notebookEditTool`.

14. **Worktree.** Implement in this worktree (`/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/notebookedit-docker`) or a later isolated worktree. Never on `main`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/core/src/tools/notebook-edit.ts` | cwd jail; `createNotebookEditTool`; docker cat/tee helpers |
| `packages/core/src/tools/notebook-edit.test.ts` | keep every existing test; add jail + factory + docker describes |
| `packages/core/src/tools/terminal-backend.ts` | Task 3: `stdin?` on opts + request; pipe stdio only when set; argv unchanged |
| `packages/core/src/tools/terminal-backend.test.ts` | Task 3: local + docker `runCommand` receive stdin |
| `packages/core/src/index.ts` | export `createNotebookEditTool` |
| `packages/cli/src/engine.ts` | `createRootTools` uses factory when `backend` is set |
| `packages/cli/src/exec.test.ts` | singleton identity with/without backend |
| `packages/sdk/src/index.ts` | **do not add NotebookEdit** |
| `packages/sdk/src/index.test.ts` | lock: still omits NotebookEdit |
| docs listed in Task 4 | honesty after code; spec Status → implemented **after code** |

Do not touch: `workspace-fs.ts`, `read.ts`, `write.ts`, `edit.ts`, `apply-patch.ts`, `list-dir.ts`, `read-subtree.ts`, `loop/`, schema, SDK `createRootTools` tool list, `notebook-format.ts`.

## File partitions

| Task | Owns (only these) |
|---|---|
| 1 N0.1 cwd jail on local path | `notebook-edit.ts` (jail only; still singleton), `notebook-edit.test.ts` (outside-cwd + hard-deny-before-jail) |
| 2 N0.2 factory + CLI wiring + core export | `notebook-edit.ts` (factory wrap; **no docker exec yet**), `notebook-edit.test.ts` (factory local), `packages/core/src/index.ts`, `packages/cli/src/engine.ts`, `packages/cli/src/exec.test.ts`, `packages/sdk/src/index.test.ts` (omit lock). Do **not** edit `packages/sdk/src/index.ts` |
| 3 N1 docker cat/tee + stdin + fail-closed + abort | `terminal-backend.ts` (stdin field), `terminal-backend.test.ts` (stdin), `notebook-edit.ts` (docker branch), `notebook-edit.test.ts` (docker describe) |
| 4 N2 remaining permission tests + docs honesty | `notebook-edit.test.ts` (`acceptEdits` / `dontAsk`), `ARCHITECTURE.md` / `.ko.md`, `docs/headless.md`, E2.1 pointer, spec Status → implemented **after code**, `CHANGELOG.md` Unreleased |

Task 1 first. Task 2 after 1. Task 3 after 2 (stdin is needed here; Tasks 1–2 do not add it). Task 4 last, after code.

---

### Task 1: N0.1 cwd jail on the local path (no docker exec yet)

**Files:**
- Modify: `packages/core/src/tools/notebook-edit.ts` (`execute` ~55–91)
- Modify: `packages/core/src/tools/notebook-edit.test.ts` (keep every existing test; add jail cases)

**Interfaces:**
- Consumes: `resolveWritePath`, `isHardDeniedWritePath` from `./write`; `wasRead` from `./read-files`; `isInTreePath` from `../permissions/modes`
- Produces: after `resolveWritePath`, hard-deny then `isInTreePath(ctx.turn.cwd, resolved)` with no extra roots; outside-cwd returns exactly `NotebookEdit failed: outside workspace` and does not read or write

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/tools/notebook-edit.test.ts`, add `mkdirSync` to the `node:fs` import. Keep every existing test. Add inside `describe('NotebookEdit')`:

```ts
  test('refuses a path outside cwd and does not write', async () => {
    const root = fixtureRoot()
    const outside = fixtureRoot()
    const outsideNb = writeNotebook(outside, 'nb.ipynb', [
      { id: 'abc', cell_type: 'code', source: ['old'] },
    ])
    const before = readFileSync(outsideNb, 'utf8')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(outside, 'nb.ipynb'))
    const out = await notebookEditTool.execute(
      { path: outsideNb, new_source: 'hacked' },
      ctx,
    )
    expect(out).toBe('NotebookEdit failed: outside workspace')
    expect(readFileSync(outsideNb, 'utf8')).toBe(before)
  })

  test('refuses a relative path that escapes cwd and does not write', async () => {
    const parent = fixtureRoot()
    const cwd = join(parent, 'proj')
    mkdirSync(cwd)
    writeNotebook(parent, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const before = readFileSync(join(parent, 'nb.ipynb'), 'utf8')
    const ctx = makeCtx(cwd)
    ctx.turn.readFiles.add(resolvedOf(parent, 'nb.ipynb'))
    const out = await notebookEditTool.execute(
      { path: '../nb.ipynb', new_source: 'hacked' },
      ctx,
    )
    expect(out).toBe('NotebookEdit failed: outside workspace')
    expect(readFileSync(join(parent, 'nb.ipynb'), 'utf8')).toBe(before)
  })

  test('hard-deny still runs before the cwd jail', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add('/etc/shadow')
    const out = await notebookEditTool.execute(
      { path: '/etc/shadow', new_source: 'x' },
      ctx,
    )
    expect(out).toBe('NotebookEdit failed: write denied to protected path: /etc/shadow')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/tools/notebook-edit.test.ts`

Expected: FAIL — the outside-cwd cases currently succeed (no jail; host `writeFileSync` mutates the file). Hard-deny `/etc/shadow` already matches; it must stay green after Step 3 (hard-deny still first). Existing in-tree / `wasRead` / leftover-ask tests stay green.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/tools/notebook-edit.ts`, import:

```ts
import { isInTreePath } from '../permissions/modes'
```

In `execute`, after `resolveWritePath` and the existing hard-deny block, **before** `wasRead`:

```ts
    if (!isInTreePath(ctx.turn.cwd, resolved)) {
      return 'NotebookEdit failed: outside workspace'
    }
```

Do not pass `ctx.turn.additionalDirectories`. Do not throw `new Error('outside workspace')` and wrap it. Do not take a docker exec branch yet. Host `readFileSync` / `writeFileSync` stay.

Locked order:

```ts
    const resolved = resolveWritePath(ctx.turn.cwd, input.path)
    if (isHardDeniedWritePath(resolved)) {
      return `NotebookEdit failed: write denied to protected path: ${input.path}`
    }
    if (!isInTreePath(ctx.turn.cwd, resolved)) {
      return 'NotebookEdit failed: outside workspace'
    }
    if (!wasRead(ctx.turn.readFiles, resolved, resolve(ctx.turn.cwd, input.path))) {
      return `NotebookEdit failed: path must be Read first: ${input.path}`
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/tools/notebook-edit.test.ts`

Expected: PASS. Existing replace / insert / delete / hard-deny `state.db` / abort-already / leftover-ask tests stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/notebook-edit.ts packages/core/src/tools/notebook-edit.test.ts
git commit -m "$(cat <<'EOF'
fix(core): jail NotebookEdit to the turn cwd

Refuse outside-cwd paths with NotebookEdit failed: outside
workspace before any host I/O. Hard-deny still runs first.
EOF
)"
```

---

### Task 2: N0.2 `createNotebookEditTool` + CLI wiring + core export

**Files:**
- Modify: `packages/core/src/tools/notebook-edit.ts` (extract factory; `void backend` until Task 3)
- Modify: `packages/core/src/tools/notebook-edit.test.ts` (factory local path)
- Modify: `packages/core/src/index.ts` (`notebookEditTool` export ~103)
- Modify: `packages/cli/src/engine.ts` (imports ~46; `createRootTools` ~216–233)
- Modify: `packages/cli/src/exec.test.ts` (`createRootTools` ~80–140)
- Modify: `packages/sdk/src/index.test.ts` (`createRootTools` ~168 — omit lock only)
- Do **not** modify `packages/sdk/src/index.ts`

**Interfaces:**
- Consumes: existing `notebookEditTool` execute path (with Task 1 jail); CLI `createRootTools(..., backend?: TerminalBackend)`
- Produces:
  ```ts
  export function createNotebookEditTool(backend?: TerminalBackend): Tool<NotebookEditInput, string>
  export const notebookEditTool: Tool<NotebookEditInput, string> = createNotebookEditTool()
  ```
  CLI: `backend !== undefined ? createNotebookEditTool(backend) : notebookEditTool`. SDK list unchanged.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/tools/notebook-edit.test.ts`, import `createNotebookEditTool` next to `notebookEditTool`. Add:

```ts
  test('createNotebookEditTool without backend still replaces after Read', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const tool = createNotebookEditTool()
    expect(tool.name).toBe('NotebookEdit')
    expect(tool.isConcurrencySafe({ path: 'nb.ipynb', new_source: 'x' })).toBe(false)
    expect(tool.isReadOnly({ path: 'nb.ipynb', new_source: 'x' })).toBe(false)
    expect(tool.interruptBehavior?.()).toBe('block')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    const out = await tool.execute({ path: 'nb.ipynb', new_source: 'print(9)' }, ctx)
    expect(out).toContain('nb.ipynb')
    const parsed = parseNotebook(readFileSync(join(root, 'nb.ipynb'), 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected notebook')
    expect(parsed.value.cells[0]?.source).toEqual(['print(9)'])
  })
```

In `packages/cli/src/exec.test.ts`, import `notebookEditTool` from `@ravenclaw/core` (next to `grepTool` / `globTool`). Extend the existing backend identity tests:

```ts
  test('createRootTools with a backend does not reuse the NotebookEdit singleton', () => {
    const backend = createLocalTerminalBackend()
    const tools = createRootTools(createMemoryStore(), bashTool, askUserTool, false, backend)
    const notebook = tools.find((tool) => tool.name === 'NotebookEdit')
    expect(notebook).toBeDefined()
    expect(notebook).not.toBe(notebookEditTool)
  })

  test('createRootTools without a backend keeps the NotebookEdit singleton', () => {
    const tools = createRootTools(createMemoryStore())
    expect(tools.find((tool) => tool.name === 'NotebookEdit')).toBe(notebookEditTool)
  })
```

Keep the name-list test unchanged (`NotebookEdit` still present, still no new tool). The existing Grep/Glob identity tests stay.

In `packages/sdk/src/index.test.ts` `describe('createRootTools')`, add a lock (this assertion is already true today — do **not** “fix” it by adding the tool):

```ts
  test('omits NotebookEdit with and without a backend', () => {
    const unnamed = createRootTools(createMemoryStore()).map((tool) => tool.name)
    expect(unnamed).not.toContain('NotebookEdit')
    const named = createRootTools(
      createMemoryStore(),
      bashTool,
      false,
      createLocalTerminalBackend(),
    ).map((tool) => tool.name)
    expect(named).not.toContain('NotebookEdit')
  })
```

Do not add a Task 2 test that a docker-kind backend still host-writes (Task 3 would have to flip it).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/tools/notebook-edit.test.ts ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts`

Expected: FAIL — `createNotebookEditTool` is not exported; CLI `createRootTools` with a backend still returns the `notebookEditTool` singleton. SDK omit lock PASSES (keep it passing; do not add NotebookEdit to `packages/sdk/src/index.ts`).

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/tools/notebook-edit.ts` — extract the current tool object into `createNotebookEditTool`. Accept `backend` so callers can pass it. **Do not take the docker exec branch yet** (Task 3):

```ts
import type { TerminalBackend } from './terminal-backend'

export function createNotebookEditTool(
  backend?: TerminalBackend,
): Tool<NotebookEditInput, string> {
  return {
    name: 'NotebookEdit',
    description:
      'Edit a Jupyter .ipynb notebook. path is resolved relative to the turn cwd. Requires a prior successful Read of that path. edit_mode is replace (default), insert, or delete. replace updates the cell with cell_id or the last cell. insert adds a cell after cell_id or at the start. delete removes cell_id. Refuses protected paths.',
    inputSchema,
    parse(input: unknown) {
      return parseWithSchema<NotebookEditInput>(inputSchema, input)
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return false
    },
    interruptBehavior() {
      return 'block'
    },
    async checkPermissions() {
      return { behavior: 'ask', message: 'Edit this notebook?', saveAs: 'session' }
    },
    async execute(input: NotebookEditInput, ctx: ToolContext) {
      void backend
      // Task 1 body unchanged (jail + host read/write)
    },
  }
}

export const notebookEditTool: Tool<NotebookEditInput, string> = createNotebookEditTool()
```

`packages/core/src/index.ts` — change the notebook export:

```ts
export { notebookEditTool, createNotebookEditTool } from './tools/notebook-edit'
```

CLI `packages/cli/src/engine.ts` — add `createNotebookEditTool` to the `@ravenclaw/core` import next to `notebookEditTool`. In `createRootTools` list, replace the bare `notebookEditTool` slot:

```ts
    backend !== undefined ? createNotebookEditTool(backend) : notebookEditTool,
```

Do not change `createSessionTools` signature (it already forwards `opts.backend` as the 5th argument). Do not add a backend field on `createSessionEngine`. Do not edit SDK `createRootTools`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/tools/notebook-edit.test.ts ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts`

Expected: PASS. Existing singleton tests that import `notebookEditTool` stay green. `createRootTools(store)` name list unchanged. SDK still omits NotebookEdit.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/notebook-edit.ts \
  packages/core/src/tools/notebook-edit.test.ts \
  packages/core/src/index.ts \
  packages/cli/src/engine.ts \
  packages/cli/src/exec.test.ts \
  packages/sdk/src/index.test.ts
git commit -m "$(cat <<'EOF'
feat: add createNotebookEditTool and wire CLI backend

Factory wraps the local host path. CLI createRootTools
passes the same TerminalBackend object as Bash/Grep/Glob
when set. SDK still omits NotebookEdit.
EOF
)"
```

---

### Task 3: N1 docker cat then tee/stdin + fail-closed + abort

**Files:**
- Modify: `packages/core/src/tools/terminal-backend.ts` (`TerminalExecOpts` ~3, `TerminalRunRequest` ~29, `execLocal` ~96, `startLocal` ~117, `dockerRunRequest` ~144, `runSpawned` ~273)
- Modify: `packages/core/src/tools/terminal-backend.test.ts` (stdin cases)
- Modify: `packages/core/src/tools/notebook-edit.ts` (docker branch in `createNotebookEditTool.execute`)
- Modify: `packages/core/src/tools/notebook-edit.test.ts` (new `describe('NotebookEdit docker backend')`)

**Interfaces:**
- Consumes: `createDockerTerminalBackend({ image, runCommand })`, `backend.exec`, `stringifyNotebook`, Task 1 jail, Task 2 factory
- Produces:
  ```ts
  export interface TerminalExecOpts {
    command: string
    cwd: string
    timeoutMs: number
    signal: AbortSignal
    onOutput?: (text: string) => void
    stdin?: string | Uint8Array
  }
  export interface TerminalRunRequest {
    command: string
    args: string[]
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    signal: AbortSignal
    onOutput?: (text: string) => void
    stdin?: string | Uint8Array
  }
  ```
  Docker NotebookEdit: exactly two `backend.exec` calls, timeout `30_000`, read = `cat ${shQuote(resolved)}`, write = `tee ${shQuote(resolved)}` with `stdin: stringifyNotebook(nb)`. Host `writeFileSync` is not the write path. Abort throws `AbortError`.

If `stdin` is **already** present on both types when you start this task, consume it and skip the field-add; still add the notebook tests and honor pipe-stdio-only-when-set.

- [ ] **Step 1: Write the failing tests**

In `packages/core/src/tools/terminal-backend.test.ts`, add inside `describe('createLocalTerminalBackend')`:

```ts
  test('pipes stdin into the child when set', async () => {
    const root = fixtureRoot()
    const result = await createLocalTerminalBackend().exec({
      command: 'cat',
      cwd: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      stdin: 'hello-stdin\n',
    })
    expect(result.stdout).toContain('hello-stdin')
    expect(result.exitCode).toBe(0)
  })

  test('accepts Uint8Array stdin', async () => {
    const root = fixtureRoot()
    const result = await createLocalTerminalBackend().exec({
      command: 'cat',
      cwd: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      stdin: new Uint8Array([104, 105, 10]),
    })
    expect(result.stdout).toContain('hi')
    expect(result.exitCode).toBe(0)
  })
```

Add a docker `runCommand` case (new describe or inside the existing docker describe):

```ts
test('docker runCommand receives stdin and keeps -i', async () => {
  const root = fixtureRoot()
  let seen: TerminalRunRequest | undefined
  const backend = createDockerTerminalBackend({
    image: 'bash:5',
    runCommand: async (req) => {
      seen = req
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  })
  await backend.exec({
    command: 'tee /tmp/x',
    cwd: root,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    stdin: 'payload',
  })
  expect(seen?.stdin).toBe('payload')
  expect(seen?.command).toBe('docker')
  expect(seen?.args).toContain('-i')
})
```

In `packages/core/src/tools/notebook-edit.test.ts`, add this import (Task 2 already added `createNotebookEditTool` next to `notebookEditTool`; `parseNotebook` stays as-is):

```ts
import {
  createDockerTerminalBackend,
  createLocalTerminalBackend,
  createTerminalBackend,
  type TerminalRunRequest,
} from './terminal-backend'
```

Shared fake helper (copy locally; do not import from `terminal-backend.test.ts`):

```ts
function fakeDocker(
  runCommand: (req: TerminalRunRequest) => Promise<{
    stdout: string
    stderr: string
    exitCode: number
  }>,
) {
  return createDockerTerminalBackend({ image: 'bash:5', runCommand })
}
```

New `describe('NotebookEdit docker backend')`:

```ts
describe('NotebookEdit docker backend', () => {
  test('two execs: cat then tee with stdin; host writeFileSync is not the write path', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const before = readFileSync(join(root, 'nb.ipynb'), 'utf8')
    const history = mockHistory()
    const calls: TerminalRunRequest[] = []
    let started = false
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      const script = req.args.at(-1) ?? ''
      if (script.includes('cat ')) {
        return { stdout: before, stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const start = backend.start
    backend.start = (opts) => {
      started = true
      return start!(opts)
    }
    const ctx = makeCtx(root, undefined, history)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    const out = await createNotebookEditTool(backend).execute(
      { path: 'nb.ipynb', new_source: 'print(9)' },
      ctx,
    )
    expect(out).toContain('nb.ipynb')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(started).toBe(false)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.command).toBe('docker')
    expect(calls[0]?.timeoutMs).toBe(30_000)
    expect(calls[0]?.args).toContain('-v')
    expect(calls[0]?.args).toContain(`${root}:${root}`)
    expect(calls[0]?.args).toContain('-w')
    expect(calls[0]?.args).toContain(root)
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM'])
    expect(calls[0]?.env?.ANTHROPIC_API_KEY).toBeUndefined()
    const readScript = calls[0]?.args.at(-1) ?? ''
    const writeScript = calls[1]?.args.at(-1) ?? ''
    const resolved = resolvedOf(root, 'nb.ipynb')
    expect(readScript).toContain(`cat '${resolved}'`)
    expect(readScript).not.toContain('tee')
    expect(writeScript).toContain(`tee '${resolved}'`)
    expect(writeScript).not.toMatch(/\bcat\b/)
    expect(calls[0]?.stdin).toBeUndefined()
    expect(typeof calls[1]?.stdin).toBe('string')
    const teed = parseNotebook(String(calls[1]?.stdin ?? ''))
    expect(teed.ok).toBe(true)
    if (!teed.ok) throw new Error('expected teed notebook')
    expect(teed.value.cells[0]?.source).toEqual(['print(9)'])
    expect(JSON.stringify(calls[1]?.args)).not.toContain('print(9)')
    expect(readFileSync(join(root, 'nb.ipynb'), 'utf8')).toBe(before)
    expect(history.snaps).toContain(resolved)
    expect(calls[1]?.timeoutMs).toBe(30_000)
  })

  test('outside-cwd fails at the jail and does not exec', async () => {
    const root = fixtureRoot()
    const outside = fixtureRoot()
    const outsideNb = writeNotebook(outside, 'nb.ipynb', [
      { id: 'abc', cell_type: 'code', source: ['old'] },
    ])
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const ctx = makeCtx(root)
    ctx.turn.terminalBackend = 'docker'
    ctx.turn.readFiles.add(resolvedOf(outside, 'nb.ipynb'))
    const out = await createNotebookEditTool(backend).execute(
      { path: outsideNb, new_source: 'hacked' },
      ctx,
    )
    expect(calls).toHaveLength(0)
    expect(out).toBe('NotebookEdit failed: outside workspace')
  })

  test('wasRead miss does not exec', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const out = await createNotebookEditTool(backend).execute(
      { path: 'nb.ipynb', new_source: 'new' },
      makeCtx(root),
    )
    expect(calls).toHaveLength(0)
    expect(out).toBe('NotebookEdit failed: path must be Read first: nb.ipynb')
  })

  test('hard-deny does not exec', async () => {
    const root = fixtureRoot()
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add('/etc/shadow')
    const out = await createNotebookEditTool(backend).execute(
      { path: '/etc/shadow', new_source: 'x' },
      ctx,
    )
    expect(calls).toHaveLength(0)
    expect(out).toBe('NotebookEdit failed: write denied to protected path: /etc/shadow')
  })

  test('no daemon returns NotebookEdit failed: and does not host-write', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const before = readFileSync(join(root, 'nb.ipynb'), 'utf8')
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
      exitCode: 1,
    }))
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    const out = await createNotebookEditTool(backend).execute(
      { path: 'nb.ipynb', new_source: 'print(9)' },
      ctx,
    )
    expect(out).toMatch(/^NotebookEdit failed:/)
    expect(out).toContain('Cannot connect to the Docker daemon')
    expect(readFileSync(join(root, 'nb.ipynb'), 'utf8')).toBe(before)
  })

  test('missing cat returns NotebookEdit failed: and does not host-write', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const before = readFileSync(join(root, 'nb.ipynb'), 'utf8')
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'cat: not found',
      exitCode: 127,
    }))
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    const out = await createNotebookEditTool(backend).execute(
      { path: 'nb.ipynb', new_source: 'print(9)' },
      ctx,
    )
    expect(out).toMatch(/^NotebookEdit failed:/)
    expect(readFileSync(join(root, 'nb.ipynb'), 'utf8')).toBe(before)
  })

  test('tee fail after cat leaves the host file unchanged', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const before = readFileSync(join(root, 'nb.ipynb'), 'utf8')
    let n = 0
    const backend = fakeDocker(async () => {
      n += 1
      if (n === 1) return { stdout: before, stderr: '', exitCode: 0 }
      return { stdout: '', stderr: 'tee: not found', exitCode: 127 }
    })
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    const out = await createNotebookEditTool(backend).execute(
      { path: 'nb.ipynb', new_source: 'print(9)' },
      ctx,
    )
    expect(out).toMatch(/^NotebookEdit failed:/)
    expect(readFileSync(join(root, 'nb.ipynb'), 'utf8')).toBe(before)
  })

  test('30s timeout returns NotebookEdit failed: and does not host-write', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const before = readFileSync(join(root, 'nb.ipynb'), 'utf8')
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'timed out',
      exitCode: 124,
    }))
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    const out = await createNotebookEditTool(backend).execute(
      { path: 'nb.ipynb', new_source: 'print(9)' },
      ctx,
    )
    expect(out).toMatch(/^NotebookEdit failed:/)
    expect(readFileSync(join(root, 'nb.ipynb'), 'utf8')).toBe(before)
  })

  test('turn abort throws AbortError and does not stringify NotebookEdit failed:', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const ac = new AbortController()
    const backend = fakeDocker(async ({ signal }) => {
      return new Promise((_, reject) => {
        const fail = () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal.aborted) {
          fail()
          return
        }
        signal.addEventListener('abort', fail, { once: true })
      })
    })
    const ctx = makeCtx(root, ac.signal)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    const pending = createNotebookEditTool(backend).execute(
      { path: 'nb.ipynb', new_source: 'x' },
      ctx,
    )
    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await pending.catch((error: unknown) => {
      expect(String(error)).not.toMatch(/NotebookEdit failed:/)
    })
  })

  test('createTerminalBackend docker without image stays on the host path', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const backend = createTerminalBackend('docker')
    expect(backend.kind).toBe('local')
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    const out = await createNotebookEditTool(backend).execute(
      { path: 'nb.ipynb', new_source: 'print(9)' },
      ctx,
    )
    expect(out).toContain('nb.ipynb')
    const parsed = parseNotebook(readFileSync(join(root, 'nb.ipynb'), 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected notebook')
    expect(parsed.value.cells[0]?.source).toEqual(['print(9)'])
  })

  test('local-kind backend still host-writes after the jail', async () => {
    const root = fixtureRoot()
    writeNotebook(root, 'nb.ipynb', [{ id: 'abc', cell_type: 'code', source: ['old'] }])
    const ctx = makeCtx(root)
    ctx.turn.readFiles.add(resolvedOf(root, 'nb.ipynb'))
    const out = await createNotebookEditTool(createLocalTerminalBackend()).execute(
      { path: 'nb.ipynb', new_source: 'print(9)' },
      ctx,
    )
    expect(out).toContain('nb.ipynb')
    const parsed = parseNotebook(readFileSync(join(root, 'nb.ipynb'), 'utf8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected notebook')
    expect(parsed.value.cells[0]?.source).toEqual(['print(9)'])
  })
})
```

Keep the existing singleton abort-already-aborted test green.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./packages/core/src/tools/terminal-backend.test.ts ./packages/core/src/tools/notebook-edit.test.ts`

Expected: FAIL — `stdin` is not on `TerminalExecOpts` (local `cat` gets no payload; docker `runCommand` sees `undefined`); `createNotebookEditTool(docker)` still host-writes (`before` mutates, `calls.length === 0` or no `tee`); abort does not reject `AbortError` from exec.

- [ ] **Step 3: Write minimal implementation**

`packages/core/src/tools/terminal-backend.ts` — add the field, pass it through, pipe stdio only when set. **Do not touch docker argv** (`-i` already present at `dockerRunRequest` args `['run', '--rm', '-i']`).

```ts
export interface TerminalExecOpts {
  command: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  onOutput?: (text: string) => void
  stdin?: string | Uint8Array
}

export interface TerminalRunRequest {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal: AbortSignal
  onOutput?: (text: string) => void
  stdin?: string | Uint8Array
}
```

In `execLocal` / `startLocal` `runSpawned` request objects, and in `dockerRunRequest` return, copy stdin when present:

```ts
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
```

In `runSpawned` `spawn` options:

```ts
    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: req.env,
      stdio: req.stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    })
    if (req.stdin !== undefined) {
      const chunk = typeof req.stdin === 'string' ? req.stdin : Buffer.from(req.stdin)
      child.stdin?.write(chunk)
      child.stdin?.end()
    }
```

`packages/core/src/tools/notebook-edit.ts` — docker branch after jail + `wasRead`, before host I/O. Private helpers in this file only:

```ts
const NOTEBOOK_TIMEOUT_MS = 30_000

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function isDockerNotebook(backend?: TerminalBackend): boolean {
  return backend?.kind === 'docker'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function readNotebookText(
  resolved: string,
  ctx: ToolContext,
  backend?: TerminalBackend,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  if (!isDockerNotebook(backend) || backend === undefined) {
    try {
      return { ok: true, text: readFileSync(resolved, 'utf8') }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }
  try {
    const result = await backend.exec({
      command: `cat ${shQuote(resolved)}`,
      cwd: ctx.turn.cwd,
      timeoutMs: NOTEBOOK_TIMEOUT_MS,
      signal: ctx.signal,
    })
    if (ctx.signal.aborted) throw abortError()
    if (result.exitCode !== 0) {
      const err = (result.stderr || result.stdout || 'docker cat failed').trim()
      return { ok: false, message: err }
    }
    return { ok: true, text: result.stdout }
  } catch (error) {
    if (isAbortError(error) || ctx.signal.aborted) throw abortError()
    return { ok: false, message: errorMessage(error) }
  }
}

async function writeNotebookText(
  resolved: string,
  text: string,
  ctx: ToolContext,
  backend?: TerminalBackend,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isDockerNotebook(backend) || backend === undefined) {
    try {
      writeFileSync(resolved, text, 'utf8')
      return { ok: true }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }
  try {
    const result = await backend.exec({
      command: `tee ${shQuote(resolved)}`,
      cwd: ctx.turn.cwd,
      timeoutMs: NOTEBOOK_TIMEOUT_MS,
      signal: ctx.signal,
      stdin: text,
    })
    if (ctx.signal.aborted) throw abortError()
    if (result.exitCode !== 0) {
      const err = (result.stderr || result.stdout || 'docker tee failed').trim()
      return { ok: false, message: err }
    }
    return { ok: true }
  } catch (error) {
    if (isAbortError(error) || ctx.signal.aborted) throw abortError()
    return { ok: false, message: errorMessage(error) }
  }
}
```

Replace the host-only read/write body in `execute` (after `wasRead`) with:

```ts
    const read = await readNotebookText(resolved, ctx, backend)
    if (!read.ok) return `NotebookEdit failed: ${read.message}`

    const parsed = parseNotebook(read.text)
    if (!parsed.ok) return `NotebookEdit failed: ${parsed.message}`

    const mode = input.edit_mode ?? 'replace'
    const edited = applyNotebookEdit(parsed.value, {
      cell_id: input.cell_id,
      new_source: input.new_source,
      cell_type: input.cell_type,
      edit_mode: mode,
    })
    if (!edited.ok) return `NotebookEdit failed: ${edited.message}`

    try {
      ctx.fileHistory?.snapshot(resolved)
      const written = await writeNotebookText(
        resolved,
        stringifyNotebook(parsed.value),
        ctx,
        backend,
      )
      if (!written.ok) return `NotebookEdit failed: ${written.message}`
    } catch (error) {
      if (isAbortError(error) || ctx.signal.aborted) throw abortError()
      return `NotebookEdit failed: ${errorMessage(error)}`
    }
    return statusLine(mode, input.path)
```

Remove `void backend`. Do not call `backend.start`. Do not embed `stringifyNotebook` in the command string. Do not edit `workspace-fs.ts`. Do not edit `notebook-format.ts`. Do not change `interruptBehavior`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./packages/core/src/tools/terminal-backend.test.ts ./packages/core/src/tools/notebook-edit.test.ts`

Expected: PASS. Existing local singleton tests still host-write in-tree notebooks. Outside-cwd still no exec. Docker argv tests in `terminal-backend.test.ts` still contain `-i`. Live docker tests (if any) unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/terminal-backend.ts \
  packages/core/src/tools/terminal-backend.test.ts \
  packages/core/src/tools/notebook-edit.ts \
  packages/core/src/tools/notebook-edit.test.ts
git commit -m "$(cat <<'EOF'
feat: run NotebookEdit bytes through docker TerminalBackend

Cat then tee with shared stdin. Cwd jail stays first.
Exec failures are NotebookEdit failed with no host write.
Turn abort throws AbortError.
EOF
)"
```

---

### Task 4: N2 remaining permission tests + docs honesty (after code)

**Files:**
- Modify: `packages/core/src/tools/notebook-edit.test.ts` (`acceptEdits` / `dontAsk` leftover)
- Modify: `ARCHITECTURE.md` (openEngine bullet ~129; NotebookEdit row ~498)
- Modify: `ARCHITECTURE.ko.md` (NotebookEdit row ~398; docker sentence ~714; terminal-backend bullet ~730)
- Modify: `docs/headless.md` (Optional Docker sandbox ~44–46)
- Modify: `docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md` (E2.1 shipped pointer ~176)
- Modify: `docs/superpowers/specs/2026-09-21-notebookedit-docker.md` (Status → implemented; board waves done; shipped sha)
- Modify: `CHANGELOG.md` Unreleased ### Added (prepend)
- Modify: `docs/research/eve-analysis.md` / `eve-analysis.ko.md` one-line closer if they still say NotebookEdit never uses the docker port

Spec Status stays **draft until this task**. Do not mark it implemented in Task 1–3.

**Interfaces:**
- Consumes: shipped behavior from Tasks 1–3; `decidePermission`
- Produces: `acceptEdits` stays `ask`; `dontAsk` leftover stays `deny` / `reason: 'mode'`; docs that name NotebookEdit docker without claiming Read/Write are docker

- [ ] **Step 1: Write the remaining failing tests**

In `packages/core/src/tools/notebook-edit.test.ts` `describe('NotebookEdit')` (singleton / permissions; `decidePermission` is already imported):

```ts
  test('acceptEdits does not promote NotebookEdit', async () => {
    const root = fixtureRoot()
    const decision = await decidePermission({
      name: 'NotebookEdit',
      input: { path: 'a.ipynb', new_source: 'x' },
      tool: notebookEditTool,
      ctx: makeCtx(root),
      mode: 'acceptEdits',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('ask')
  })

  test('dontAsk leftover of NotebookEdit is deny', async () => {
    const root = fixtureRoot()
    const decision = await decidePermission({
      name: 'NotebookEdit',
      input: { path: 'a.ipynb', new_source: 'x' },
      tool: notebookEditTool,
      ctx: makeCtx(root),
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('deny')
    if (decision.behavior === 'deny') {
      expect(decision.reason).toBe('mode')
    }
  })
```

These should already PASS on current `pipeline.ts` (do not edit `pipeline.ts` to make them pass). They are a lock that Task 1–3 must not have broken.

- [ ] **Step 2: Run tests**

Run: `bun test ./packages/core/src/tools/notebook-edit.test.ts ./packages/cli/src/exec.test.ts ./packages/sdk/src/index.test.ts`

Expected: PASS (including Task 1–3 cases plus the two permission locks). SDK still omits NotebookEdit.

- [ ] **Step 3: Point docs at the shipped behavior**

`docs/headless.md` Optional Docker sandbox paragraph becomes: when Bash is actually docker (backend **and** image), allowed Bash, Grep/Glob, **and NotebookEdit bytes** `docker run` in that container (`-v cwd:cwd -w cwd`). NotebookEdit is two execs (`cat` then `tee`+stdin). Omit, local, or `createTerminalBackend('docker')` without an image keeps NotebookEdit on host `readFileSync`/`writeFileSync` **after the cwd jail**. Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree stay the host WorkspaceFs jail. It is not a substitute for `dontAsk`. Do **not** claim Read/Write are docker-exec.

`ARCHITECTURE.md`:
- openEngine bullet ~129: pass the same backend object to Bash, Grep/Glob, **and** NotebookEdit (`createNotebookEditTool` via `createRootTools`). Docker kind needs an image; without image, NotebookEdit stays host I/O after the cwd jail.
- NotebookEdit row ~498: leftover-ask; CLI-root-only (not SDK); `acceptEdits`/`dontAsk` do not promote; cwd jail on every backend (`NotebookEdit failed: outside workspace`); docker kind: two `backend.exec` (`cat` then `tee`+stdin), fail-closed (`NotebookEdit failed:`), abort → `AbortError` / `ABORTED_TEXT`; omit/local/image-less docker: host read/write after the jail. Read/Write stay host WorkspaceFs.

`ARCHITECTURE.ko.md`:
- NotebookEdit row ~398: leftover-ask; `acceptEdits`/`dontAsk`가 승격하지 않는다; 모든 백엔드에서 cwd jail (`NotebookEdit failed: outside workspace`); docker(+image)면 `cat` 다음 `tee`+stdin 두 번 `backend.exec`; 실패는 `NotebookEdit failed:`(호스트 `writeFileSync` 없음); 턴 abort는 `AbortError` / `ABORTED_TEXT`; omit/local/이미지 없는 docker는 호스트 I/O(jail 후). SDK `createRootTools`에는 없다. Read/Write는 호스트 WorkspaceFs jail.
- docker sentence ~714 / terminal-backend bullet ~730: Bash·Grep/Glob·NotebookEdit가 같은 객체를 쓴다. Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree는 호스트 WorkspaceFs jail. `dontAsk` 대체가 아니다.

E2.1 shipped pointer ~176: NotebookEdit docker unparked by [`2026-09-21-notebookedit-docker.md`](2026-09-21-notebookedit-docker.md) (this spec). Grep/Glob docker-exec already landed. **WorkspaceFs docker-exec (Read/Write/Edit/ApplyPatch/ListDir/ReadSubtree) stays parked** unless that sibling spec has shipped. Web UI stays OUT. Do not claim Read/Write are docker because this door shipped.

`docs/research/eve-analysis.md` / `.ko.md`: one closer sentence — NotebookEdit bytes share Bash’s docker port when kind+image; Read/Write stay host WorkspaceFs jail; WorkspaceFs docker still parked.

`CHANGELOG.md` Unreleased ### Added, **prepend**:

```md
- NotebookEdit shares Bash’s `TerminalBackend` when kind+image construct docker: two `backend.exec` calls (`cat` then `tee` with stdin). Omit/local/`createTerminalBackend('docker')` without image stays host `readFileSync`/`writeFileSync` after a new cwd jail (`NotebookEdit failed: outside workspace`). Fail-closed (`NotebookEdit failed:`; no host write). Turn abort throws `AbortError` / `ABORTED_TEXT`. Leftover-ask unchanged; SDK still omits the tool. Read/Write stay the host WorkspaceFs jail. Spec: [docs/superpowers/specs/2026-09-21-notebookedit-docker.md](docs/superpowers/specs/2026-09-21-notebookedit-docker.md). Plan: [docs/superpowers/plans/2026-09-21-notebookedit-docker.md](docs/superpowers/plans/2026-09-21-notebookedit-docker.md).
```

Spec `docs/superpowers/specs/2026-09-21-notebookedit-docker.md`: set Status to **implemented**, check board N0.1–N2.1 **done** vs this worktree, record the shipped sha when known. Do not reopen WorkspaceFs docker, SDK NotebookEdit, `acceptEdits` promotion, or schema.

- [ ] **Step 4: No further unit test for docs**

Docs-only besides the permission locks in Step 1.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/notebook-edit.test.ts \
  ARCHITECTURE.md ARCHITECTURE.ko.md \
  docs/headless.md CHANGELOG.md \
  docs/superpowers/specs/2026-09-21-notebookedit-docker.md \
  docs/superpowers/specs/2026-09-15-eve-inspired-roadmap.md \
  docs/research/eve-analysis.md docs/research/eve-analysis.ko.md
git commit -m "$(cat <<'EOF'
docs: NotebookEdit shares docker Bash backend

Cwd jail is on every backend. Read/Write stay the host
WorkspaceFs jail. SDK still omits the tool.
EOF
)"
```

---

## Success checks

1. Local NotebookEdit of a path outside cwd returns `NotebookEdit failed: outside workspace` and does not write. Hard-deny still returns `NotebookEdit failed: write denied to protected path:` and runs first.
2. Docker fake backend: in-tree `.ipynb` that was Read first is cat’d then teed via two `backend.exec` calls; host `writeFileSync` is not the write path; tee stdin parses to the edited notebook; JSON is not embedded in `bash -c`.
3. Exec fail (no daemon / missing cat|tee / 30s timeout) → `NotebookEdit failed:` and the host notebook is unchanged.
4. Turn abort throws `AbortError` and is not stringified as `NotebookEdit failed:`.
5. `wasRead` miss still fails with no exec. Hard-deny still fails with no exec.
6. `acceptEdits` stays `ask`. `dontAsk` leftover stays `deny`.
7. SDK `createRootTools` still omits NotebookEdit. CLI without `backend` keeps the `notebookEditTool` singleton; with `backend` does not.
8. Read/Write/Edit still use host WorkspaceFs (this door did not wire them; `workspace-fs.ts` untouched).

---

## Self-review

**Spec coverage:** N0.1 cwd jail (local + docker, hard-deny first) → Task 1 (local) + Task 3 (docker no-exec). N0.2 factory + CLI wiring + core export + SDK omits → Task 2. N1.1 two execs + stdin + fail-closed + abort + snapshot-then-tee → Task 3. N2.1 remaining permission tests + docs + spec Status → Task 4 (after code). Independent of WorkspaceFs docker. `notebook-format.ts` untouched. No eval fixture (`sandbox-fs` absent). No schema bump. No new tool.

**Placeholder scan:** none. Targeted bun commands start with `./`. Commits are HEREDOC. No TBD / “similar to Task N” / empty tests.

**Type consistency:** `createNotebookEditTool(backend?: TerminalBackend)`; `stdin?: string | Uint8Array` on `TerminalExecOpts` and `TerminalRunRequest`; fail strings exact (`NotebookEdit failed: outside workspace`, `NotebookEdit failed: write denied to protected path:`, `NotebookEdit failed: path must be Read first:`, `NotebookEdit failed:` prefix on exec fail). CLI `createRootTools(..., backend?)` already exists. SDK `createRootTools` tool list unchanged. `createSessionEngine` still has no backend instance.

**Tensions resolved (underspec only):**
- Jail vs hard-deny vs wasRead order: hard-deny, then `isInTreePath(cwd, resolved)` with no extra roots, then `wasRead`, then I/O.
- Two execs vs combined script: locked `cat ${shQuote(resolved)}` then `tee ${shQuote(resolved)}` + stdin string.
- Stdin missing at `0a1176f`: Task 3 adds the shared field; consume if already present.
- `sandbox-fs.ts` does not exist: private helpers in `notebook-edit.ts`; skip eval.
- Host writeFileSync on docker success: test asserts the host file is unchanged and tee stdin holds stringify bytes (fake does not bind-write).
- Abort vs daemon: throw `AbortError` vs return `NotebookEdit failed:`.
- SDK omit: lock test in Task 2; do not add the tool.
