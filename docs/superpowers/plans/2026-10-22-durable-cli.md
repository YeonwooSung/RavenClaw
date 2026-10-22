# `raven durable` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one CLI command, `raven durable --path <file> <prompt>`, that opens `createDurableSession` and reprints a finished answer for the same path and prompt.

**Architecture:** `parseArgv` learns the command and `--path`. `runDurableCommand` checks usage, then the provider, then submits with a stable `requestId`. `index.ts` dispatches that function and does not call `bootCli`. Help, completions, the CLI package dependency, and one architecture sentence follow.

**Tech Stack:** Bun, TypeScript, existing `@ravenclaw/sdk` `createDurableSession`, `loadConfig`, `providerFromConfig`.

**Spec:** `docs/superpowers/specs/2026-10-22-durable-cli.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/durable-cli` on branch `docs/durable-cli`. Do not edit the main checkout.
- Do not edit `packages/sdk/src/durable.ts`, `packages/sdk/src/index.ts`, `packages/durable`, or `packages/core`.
- Do not change `createDurableSession`'s arguments or return type. Do not call `buildSystemParts`. Do not pass `systemPrompt`.
- `permissionMode` passed to `createDurableSession` is the literal `'dontAsk'`.
- Do not call `bootCli`. Do not open `state.db`. Provider comes from `loadConfig` then `providerFromConfig`.
- `--path` is valid only when the command is `durable`. Any other command with `--path` or `--path=` throws `unknown flag: --path`.
- Missing path or missing prompt: stderr `usage: raven durable --path <file> <prompt>` and return 2. Do not call `createDurableSession`.
- No provider: stderr `SETUP_HINT` plus a newline, return 1. Do not call `createDurableSession`.
- `requestId` is `durable:` plus the hex SHA-256 of `path.resolve(path) + '\0' + prompt`.
- `done` writes `text` to stdout as one line ending in `\n`, return 0. `unanswered` writes `reason` and a newline to stderr, return 1. Any thrown error, including `DurableBusy`, writes `error.message` and a newline to stderr, return 1.
- Call `close()` after a session was opened, on success and on failure. If `createDurableSession` throws, there is no session to close.
- Tests replace `createDurableSession`. No live model. No bare `bun test`. No `bash scripts/ci-unit.sh`.
- From this worktree, test paths start with `./`.
- No version bump. No CHANGELOG. No `Co-Authored-By` or other commit trailers.
- `git add` only the files named in the task. Do not commit `.superpowers/` or `node_modules`.
- Spec status stays `draft`. Do not fill Shipped sha.

## Review Focus

- `--path` on `exec` must throw `unknown flag: --path` before any session file is opened. Task 1 asserts `parseArgv(['exec', '--path', 'sess.sqlite', 'hi'])` throws that message.
- A missing path or prompt must return 2 and leave the session factory uncalled, even when a provider key exists. Task 2 asserts the factory call count stays 0.
- Two spellings of the same file plus the same prompt must produce one `requestId`, so a re-run does not add a user entry. Task 2 compares `path.resolve` spellings.
- The runner must not call `bootCli` or mention `state.db`. Task 2 reads `durable-cmd.ts` and asserts both strings are absent.
- `close()` must run when `submit` or `wait` throws, so the sqlite file is not left locked. Task 2 counts `close` on the thrown-error path and on `done`.

---

### Task 1: Parse `durable` and `--path`

**Files:**
- Modify: `packages/cli/src/args.ts`
- Test: `packages/cli/src/durable-cmd.test.ts`

**Interfaces:**
- Consumes: existing `parseArgv` and `ParsedArgv`.
- Produces: `ParsedArgv.cmd` includes `'durable'`. `ParsedArgv.path?: string`. For `durable`, `flags.dontAsk` is `true` and `prompt` is the remaining positionals joined by one space. `--path <file>` and `--path=<file>` both set `path`. The flag may appear before or after the command word. A missing `--path` value throws `--path requires a value`.

- [ ] **Step 1: Write the failing parse tests**

Create `packages/cli/src/durable-cmd.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { parseArgv } from './args'

describe('parseArgv durable', () => {
  test('reads the command, path, and prompt', () => {
    const parsed = parseArgv(['durable', '--path', 'sess.sqlite', 'hello', 'there'])
    expect(parsed.cmd).toBe('durable')
    expect(parsed.path).toBe('sess.sqlite')
    expect(parsed.prompt).toBe('hello there')
    expect(parsed.flags.dontAsk).toBe(true)
  })

  test('accepts --path= and a path before the command', () => {
    const eq = parseArgv(['durable', '--path=sess.sqlite', 'hi'])
    expect(eq.path).toBe('sess.sqlite')
    expect(eq.prompt).toBe('hi')
    const before = parseArgv(['--path', 'sess.sqlite', 'durable', 'hi'])
    expect(before.cmd).toBe('durable')
    expect(before.path).toBe('sess.sqlite')
    expect(before.prompt).toBe('hi')
  })

  test('rejects --path on exec', () => {
    expect(() => parseArgv(['exec', '--path', 'sess.sqlite', 'hi'])).toThrow('unknown flag: --path')
  })

  test('rejects --path= on resume', () => {
    expect(() => parseArgv(['resume', '--path=sess.sqlite'])).toThrow('unknown flag: --path')
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test ./packages/cli/src/durable-cmd.test.ts`

Expected: FAIL because `durable` is not a command or `--path` is an unknown flag.

- [ ] **Step 3: Teach `parseArgv`**

Add `'durable'` to the `ParsedArgv['cmd']` union and to the command-word list. Add `path?: string`. Store `--path` and `--path=` the same way `--cwd` is stored, without putting the file on the positional list. After the loop, if a path was seen and `cmd !== 'durable'`, throw `new Error('unknown flag: --path')`. Set `flags.dontAsk = true` for `durable` in the same statement that sets it for `exec`. Copy `path` onto the result only when it was present.

- [ ] **Step 4: Re-run the test**

Run: `bun test ./packages/cli/src/durable-cmd.test.ts`

Expected: 4 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/args.ts packages/cli/src/durable-cmd.test.ts
git commit -m "feat(cli): parse raven durable --path"
```

### Task 2: Run one durable prompt

**Files:**
- Create: `packages/cli/src/durable-cmd.ts`
- Modify: `packages/cli/src/durable-cmd.test.ts`
- Modify: `packages/cli/package.json` (add `"@ravenclaw/sdk": "workspace:*"` next to the other `@ravenclaw/*` dependencies)

**Interfaces:**
- Consumes: `CreateDurableSessionOptions` from `@ravenclaw/sdk`. `loadConfig` and `ResolvedConfig` from `@ravenclaw/core`. `providerFromConfig` from `./engine`. `SETUP_HINT` and `providerConfigured` from `./first-run`. `ConfigFlags` from `@ravenclaw/core`.
- Produces:

```ts
export const DURABLE_USAGE = 'usage: raven durable --path <file> <prompt>'

export function durableRequestId(filePath: string, prompt: string): string

export async function runDurableCommand(input: {
  path: string | undefined
  prompt: string | undefined
  flags: ConfigFlags
  cwd?: string
  home?: string
  io?: {
    stdout?: { write(chunk: string): void }
    stderr?: { write(chunk: string): void }
  }
  createSession?: (opts: CreateDurableSessionOptions) => Promise<{
    submit(input: { content: string; requestId?: string }): Promise<{
      wait(): Promise<
        { status: 'done'; text: string } | { status: 'unanswered'; reason: string }
      >
    }>
    close(): Promise<void>
  }>
  resolveProvider?: (config: ResolvedConfig) => Promise<import('@ravenclaw/core').Provider>
}): Promise<number>
```

Default `createSession` is `createDurableSession`. Default `resolveProvider` is `providerFromConfig`. Default `home` is `await ensureHomeDir()`. Default streams are `process.stdout` and `process.stderr`. Session `cwd` is `input.cwd ?? input.flags.cwd ?? process.cwd()`. `requestId` uses `path.resolve` from `node:path`, which follows `process.cwd()`, not the session cwd.

Order inside the function: usage, then `providerConfigured`, then `loadConfig({ home, flags })`, then `resolveProvider`, then `createSession({ path, cwd, provider, model: config.model, permissionMode: 'dontAsk' })` with no `systemPrompt` property, then `submit({ content: prompt, requestId })`, then `wait()`. Track the exit code in a variable. In `finally`, `close()` only if the session was assigned. A `close()` error writes its message to stderr and sets the code to 1.

- [ ] **Step 1: Append failing runner tests**

Keep the Task 1 tests. Add tests that call `runDurableCommand` with a fake `createSession` and a fake `resolveProvider`. Use a temp home directory with no `.env` for the missing-provider case, and a temp home whose `providerConfigured` succeeds for the cases that open a session. Capture writes in `{ stdout, stderr }` objects. Assert:

- `path: undefined` or `prompt: ''` returns 2, stderr is `usage: raven durable --path <file> <prompt>\n`, and the factory is not called.
- An unconfigured home returns 1, stderr is `` `${SETUP_HINT}\n` ``, and the factory is not called.
- The factory receives `permissionMode: 'dontAsk'`, no `systemPrompt` key, `model` from the resolved config, and `cwd` from `flags.cwd` when set.
- `durableRequestId('/tmp/foo/../sess.sqlite', 'hi')` equals `durableRequestId('/tmp/sess.sqlite', 'hi')`, starts with `durable:`, and differs from `durableRequestId('/tmp/sess.sqlite', 'bye')`. The id passed to `submit` is that value.
- A fake session whose `wait` returns `{ status: 'done', text: 'hello' }` makes stdout `hello\n`, code 0, and `close` called once.
- `{ status: 'unanswered', reason: 'task_parked' }` makes stderr `task_parked\n`, code 1, and `close` called once.
- `submit` throwing `new Error('durable session is busy')` makes stderr that message plus a newline, code 1, and `close` called once.
- The factory throwing `new Error('durable session path must not be state.db')` makes stderr that message plus a newline, code 1, and does not call `close`.
- `await Bun.file(new URL('./durable-cmd.ts', import.meta.url)).text()` does not contain `bootCli` or `state.db`, and does contain `providerFromConfig` and `loadConfig`.

Do not import `./index`.

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `bun test ./packages/cli/src/durable-cmd.test.ts`

Expected: the new tests fail because `runDurableCommand` is missing. The Task 1 tests still pass.

- [ ] **Step 3: Implement `runDurableCommand`**

Add the package dependency. Implement the function above. Do not import `./engine`'s `bootCli`. Import `providerFromConfig` only.

- [ ] **Step 4: Re-run the test**

Run: `bun test ./packages/cli/src/durable-cmd.test.ts`

Expected: all pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/durable-cmd.ts packages/cli/src/durable-cmd.test.ts packages/cli/package.json
git commit -m "feat(cli): run a durable prompt from its sqlite file"
```

### Task 3: Dispatch, help, completions, and the dependency sentence

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/help.ts`
- Modify: `packages/cli/src/help.test.ts`
- Modify: `packages/cli/src/completions.ts`
- Modify: `ARCHITECTURE.md`
- Modify: `ARCHITECTURE.ko.md`
- Modify: `docs/superpowers/specs/2026-10-22-durable-cli.md` (status note only)
- The plan file stays in the tree. Add it in this commit.

**Interfaces:**
- Consumes: `runDurableCommand` and `ParsedArgv.path`.
- Produces: `main` returns `runDurableCommand({ path: parsed.path, prompt: parsed.prompt, flags: parsed.flags })` when `parsed.cmd === 'durable'`. Place that branch next to `play`, before the `exec` / TUI `bootCli` path.

- [ ] **Step 1: Write the failing help assertion**

In `packages/cli/src/help.test.ts`, assert `HELP_TEXT` contains `raven durable`.

- [ ] **Step 2: Run help and completions tests**

Run: `bun test ./packages/cli/src/help.test.ts ./packages/cli/src/completions.test.ts`

Expected: help fails because the line is missing. Completions still pass.

- [ ] **Step 3: Wire the command and the docs**

Help usage line, in the Usage block: `  raven durable --path <file> <prompt>`. Command blurb: `  durable       Resume a sqlite session file; forces --dont-ask`.

Add `'durable'` to `COMPLETION_COMMANDS` after `'exec'`.

`index.ts` imports `runDurableCommand` and returns it for `durable` as specified. Do not add `durable` to the `bootCli` command group.

`ARCHITECTURE.md` dependency paragraph becomes: CLI depends on core, providers, ads, acp, and tui-opentui, and depends on `@ravenclaw/sdk` only for `raven durable`. SDK depends on core, providers, and durable. SDK does not depend on CLI. Ads depends on nothing in the monorepo.

In that file's durable package row, replace "no host imports it in v1" with "The SDK host imports it. CLI reaches it only through `createDurableSession`."

Replace the sentence that says CLI, SDK, ACP, and HTTP still enter turns only through `queryLoop` with: Default CLI sessions, `createRavenSession`, ACP, and HTTP still enter turns only through `queryLoop`. `raven durable` calls `createDurableSession` and does not call `queryLoop` or open `state.db`.

`ARCHITECTURE.ko.md`: change the durable row's "v1 호스트는 import하지 않는다" to "SDK가 import한다. CLI는 `raven durable`에서 `createDurableSession`으로만 닿는다." After the layout table's following paragraph, add: CLI는 `raven durable`을 위해 `@ravenclaw/sdk`를 의존한다. SDK는 CLI를 의존하지 않는다. `raven durable`은 `queryLoop`와 `state.db`를 열지 않는다.

Spec header: replace the "구현 전이므로" sentence with "동작은 이 브랜치에 구현되어 있다. 머지 전이므로 Shipped sha는 없다." Add a line `Implementation plan: [2026-10-22-durable-cli.md](../plans/2026-10-22-durable-cli.md)`. Leave Status `draft`.

- [ ] **Step 4: Re-run the spec's verification command**

Run: `bun test ./packages/cli/src/durable-cmd.test.ts ./packages/cli/src/help.test.ts ./packages/cli/src/completions.test.ts`

Expected: all pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/help.ts packages/cli/src/help.test.ts packages/cli/src/completions.ts ARCHITECTURE.md ARCHITECTURE.ko.md docs/superpowers/specs/2026-10-22-durable-cli.md docs/superpowers/plans/2026-10-22-durable-cli.md
git commit -m "feat(cli): dispatch raven durable"
```
