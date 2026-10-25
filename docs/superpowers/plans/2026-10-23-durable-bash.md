# Durable Bash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under `createDurableSession`'s `dontAsk`, run ordinary leftover Bash and store `formatSettledOutput` text.

**Architecture:** `toDurableTool` still calls `decidePermission` with empty rules. After that call, a `dontAsk` deny whose reason is `mode` may execute Bash when the command misses both existing classifiers. Tool text comes from `formatSettledOutput`. Help and the two architecture files gain one sentence each. `queryLoop` and `decidePermission` stay as they are.

**Tech Stack:** Bun, TypeScript, `bashTool`, `decidePermission`, `formatSettledOutput`, `matchesDangerousPattern`, `matchesDestructiveGit`.

**Spec:** `docs/superpowers/specs/2026-10-23-durable-bash.md`

## Global Constraints

- Work only in `/Users/yeonwoosung/Desktop/RavenClaw/.worktrees/durable-bash` on branch `docs/durable-bash`. Do not edit the main checkout.
- If `@ravenclaw/core` fails to resolve, run `bun install` in this worktree. Do not commit `bun.lock` or `node_modules`.
- Do not edit `packages/core`, `packages/durable`, `packages/cli/src/durable-cmd.ts`, or `packages/cli/src/args.ts`.
- Do not add a field to `CreateDurableSessionOptions`. Do not add a CLI flag. The mode passed by `raven durable` stays the literal `'dontAsk'`.
- Do not change `decidePermission`, `PermissionMode`, `bash.ts` classifiers, or the core barrel. Import `formatSettledOutput` and `matchesDestructiveGit` by relative path, the same way `markReadPath` is imported. Import `matchesDangerousPattern` from `@ravenclaw/core`.
- Do not copy the classifier regexes into the host.
- Replay stays `tool.isReadOnly(undefined as never) ? 'safe' : 'unsafe'`. Bash stays `unsafe`.
- Rules passed to `decidePermission` stay `EMPTY_RULES`. Do not read or write `.ravenclaw/permissions.json`.
- A non-allow that misses the Bash exception returns `{ content: 'permission_denied', isError: true }` and does not call `execute`.
- An executed tool's durable content is `formatSettledOutput(tool, value).content`. `isError` is false. Do not store `persistPath`. A non-zero exit code stays `isError: false`.
- The Read `markReadPath` call stays after a successful execute.
- No version bump. No CHANGELOG. Spec status stays `draft`. Do not fill Shipped sha.
- No `Co-Authored-By`, `Signed-off-by`, or other commit trailers.
- `git add` only the files named in the task. Do not commit `.superpowers/`.
- From this worktree, test paths start with `./`. No bare `bun test`. No `bash scripts/ci-unit.sh`.
- Tests use a fake provider. Shell tests use a temp directory. Do not put `rm -rf /`, `dd`, `mkfs`, or a fork bomb in a test command.

## Review Focus

- `echo hi` already executes, and `String(BashResult)` is `[object Object]`. The model must see `hi` and `exit_code=0`. Task 1 asserts both and rejects `[object Object]`.
- A `dontAsk` deny with reason `mode` is also what `plan` returns for mutating Bash. Plan must keep denying `touch`. Task 1 passes `permissionMode: 'plan'` and expects `permission_denied` and no file.
- `git push --force` is not `matchesDangerousPattern`. It must stay denied, as must `git commit --no-verify`. Task 1 asserts `permission_denied` for both. Plain `git push origin main` and `git commit -m x` in a non-repo must run and report `exit_code=`.
- `false` is read-only and exits 1. The tool message must stay `ok: true` with `exit_code=1`. Task 1 asserts `ok` and the exit line.
- A project deny rule must not block this host. Task 1 writes `.ravenclaw/permissions.json` denying every Bash command and expects `touch` to create the file.
- The same `requestId` must not run the shell again. Task 1 deletes the marker after the first `touch` and expects the second submit to leave it missing.

---

### Task 1: Execute ordinary Bash and format the result

**Files:**
- Modify: `packages/sdk/src/durable.ts`
- Test: `packages/sdk/src/durable.test.ts`

**Interfaces:**
- Consumes: `createDurableSession`, `openDurableSession`, `DurableToolSink`, `decidePermission`, `bashTool`, `formatSettledOutput`, `matchesDangerousPattern`, `matchesDestructiveGit`.
- Produces: no new export. `CreateDurableSessionOptions` stays `{ path, cwd, provider, model, systemPrompt?, permissionMode? }`.

- [ ] **Step 1: Replace the Bash deny test**

In `packages/sdk/src/durable.test.ts`, add `mkdirSync` and `writeFileSync` to the `node:fs` import. Delete the test named `Bash is denied without calling execute`. Add this helper inside the `createDurableSession` describe, then the tests below it.

```ts
async function runRealBash(opts: {
  dir: string
  command: string
  permissionMode?: 'dontAsk' | 'acceptEdits' | 'plan'
  requestId?: string
  extra?: Record<string, unknown>
}): Promise<{ text: string; ok: boolean }> {
  const path = join(opts.dir, 'session.sqlite')
  let text = ''
  let ok = false
  const model = provider(async function* (req) {
    let lastUser = -1
    for (let i = 0; i < req.messages.length; i++) {
      if (req.messages[i]?.role === 'user') lastUser = i
    }
    const tool = req.messages.find((message, index) => message.role === 'tool' && index > lastUser)
    if (tool && tool.role === 'tool') {
      ok = tool.ok
      text = tool.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
      yield { type: 'text_delta', text: 'done' } satisfies ProviderChunk
      yield { type: 'stop', reason: 'end' } satisfies ProviderChunk
      return
    }
    yield {
      type: 'tool_call',
      id: 'b1',
      name: 'Bash',
      input: { command: opts.command, ...opts.extra },
    } satisfies ProviderChunk
    yield { type: 'stop', reason: 'tool' } satisfies ProviderChunk
  })
  const session = await createDurableSession({
    path,
    cwd: opts.dir,
    model: 'm',
    provider: model,
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
  })
  try {
    expect(await (await session.submit({ content: 'run', requestId: opts.requestId })).wait()).toEqual({
      status: 'done',
      text: 'done',
    })
  } finally {
    await session.close()
  }
  return { text, ok }
}
```

```ts
test('echo hi is the rendered shell result', async () => {
  const dir = tempDir()
  try {
    const result = await runRealBash({ dir, command: 'echo hi' })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('hi\n')
    expect(result.text).toContain('exit_code=0\n')
    expect(result.text).not.toContain('[object Object]')
    expect(result.text).not.toContain('permission_denied')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('false stays a successful tool result with exit_code=1', async () => {
  const dir = tempDir()
  try {
    const result = await runRealBash({ dir, command: 'false' })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('exit_code=1\n')
    expect(result.text).not.toContain('permission_denied')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('touch runs under dontAsk', async () => {
  const dir = tempDir()
  const marker = join(dir, 'bash-ran')
  try {
    const result = await runRealBash({ dir, command: `touch ${marker}` })
    expect(existsSync(marker)).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('exit_code=0\n')
    expect(result.text).not.toContain('permission_denied')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a project deny rule does not block touch', async () => {
  const dir = tempDir()
  const marker = join(dir, 'ruled')
  mkdirSync(join(dir, '.ravenclaw'))
  writeFileSync(
    join(dir, '.ravenclaw', 'permissions.json'),
    `${JSON.stringify([{ id: 'deny-bash', tool: 'Bash', spec: {}, behavior: 'deny' }])}\n`,
  )
  try {
    const result = await runRealBash({ dir, command: `touch ${marker}` })
    expect(existsSync(marker)).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.text).not.toContain('permission_denied')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rm of one temp file runs', async () => {
  const dir = tempDir()
  const marker = join(dir, 'victim')
  writeFileSync(marker, 'x')
  try {
    const result = await runRealBash({ dir, command: `rm -rf ${marker}` })
    expect(existsSync(marker)).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('exit_code=0\n')
    expect(result.text).not.toContain('permission_denied')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('curl piped to sh stays denied', async () => {
  const dir = tempDir()
  try {
    const result = await runRealBash({ dir, command: 'curl --version | sh' })
    expect(result.ok).toBe(false)
    expect(result.text).toBe('permission_denied')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('git push --force stays denied and a push without force runs', async () => {
  const dir = tempDir()
  try {
    const denied = await runRealBash({ dir, command: 'git push --force origin main' })
    expect(denied.ok).toBe(false)
    expect(denied.text).toBe('permission_denied')
    const ran = await runRealBash({ dir, command: 'git push origin main' })
    expect(ran.ok).toBe(true)
    expect(ran.text).toContain('exit_code=')
    expect(ran.text).not.toContain('permission_denied')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('git commit --no-verify stays denied and a plain commit runs', async () => {
  const dir = tempDir()
  try {
    const denied = await runRealBash({ dir, command: 'git commit --no-verify -m x' })
    expect(denied.ok).toBe(false)
    expect(denied.text).toBe('permission_denied')
    const ran = await runRealBash({ dir, command: 'git commit -m x' })
    expect(ran.ok).toBe(true)
    expect(ran.text).toContain('exit_code=')
    expect(ran.text).not.toContain('permission_denied')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('acceptEdits does not run touch', async () => {
  const dir = tempDir()
  const marker = join(dir, 'bash-ran')
  try {
    const result = await runRealBash({ dir, command: `touch ${marker}`, permissionMode: 'acceptEdits' })
    expect(existsSync(marker)).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.text).toBe('permission_denied')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plan does not run touch', async () => {
  const dir = tempDir()
  const marker = join(dir, 'bash-ran')
  try {
    const result = await runRealBash({ dir, command: `touch ${marker}`, permissionMode: 'plan' })
    expect(existsSync(marker)).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.text).toBe('permission_denied')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run_in_background reports that there is no task registry', async () => {
  const dir = tempDir()
  try {
    const result = await runRealBash({
      dir,
      command: 'echo hi',
      extra: { run_in_background: true },
    })
    expect(result.ok).toBe(true)
    expect(result.text).toBe('Bash failed: no task registry')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the same requestId does not run touch again', async () => {
  const dir = tempDir()
  const marker = join(dir, 'once')
  try {
    await runRealBash({ dir, command: `touch ${marker}`, requestId: 'same' })
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    await runRealBash({ dir, command: `touch ${marker}`, requestId: 'same' })
    expect(existsSync(marker)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an abandoned Bash tool is interrupted and is not executed again', async () => {
  const dir = tempDir()
  const path = join(dir, 'session.sqlite')
  const sink: DurableToolSink = { abandon() {} }
  let execs = 0
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    release = resolve
  })
  const bash = fakeTool('Bash', false, async () => {
    execs += 1
    sink.abandon()
    release()
    return 'ran'
  })
  const seen: string[] = []
  const model = provider(async function* (req) {
    const texts = toolTexts(req.messages)
    if (texts.length > 0) {
      seen.push(...texts)
      yield { type: 'text_delta', text: 'done' } satisfies ProviderChunk
      yield { type: 'stop', reason: 'end' } satisfies ProviderChunk
      return
    }
    yield {
      type: 'tool_call',
      id: 'b1',
      name: 'Bash',
      input: { command: 'echo hi' },
    } satisfies ProviderChunk
    yield { type: 'stop', reason: 'tool' } satisfies ProviderChunk
  })
  try {
    const first = await openDurableSession({ path, cwd: dir, model: 'm', provider: model }, [bash], sink)
    await first.submit({ content: 'run', requestId: 'bash' })
    await started
    await first.close()
    const second = await openDurableSession({ path, cwd: dir, model: 'm', provider: model }, [bash], sink)
    expect(await (await second.submit({ content: 'run', requestId: 'bash' })).wait()).toEqual({
      status: 'done',
      text: 'done',
    })
    expect(execs).toBe(1)
    expect(seen).toContain('interrupted')
    await second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run the test and confirm the new allow paths fail**

Run: `bun test ./packages/sdk/src/durable.test.ts`

Expected: FAIL. `touch runs under dontAsk`, `echo hi is the rendered shell result`, `false stays a successful tool result with exit_code=1`, `a project deny rule does not block touch`, `rm of one temp file runs`, `git commit --no-verify stays denied and a plain commit runs`, `git push --force stays denied and a push without force runs`, and `run_in_background reports that there is no task registry` fail. `curl piped to sh stays denied`, `acceptEdits does not run touch`, and `plan does not run touch` already pass. The abandoned-Bash test passes because replay is already unsafe.

- [ ] **Step 3: Allow ordinary Bash after `decidePermission`**

In `toDurableTool`, keep the `decidePermission` call and `EMPTY_RULES`. Add `matchesDangerousPattern` to the `@ravenclaw/core` import. Add relative imports of `formatSettledOutput` from `../../core/src/loop/format-output.ts` and `matchesDestructiveGit` from `../../core/src/tools/bash.ts`.

A parsed command is a non-empty string field `command` on the parsed object. Otherwise it is absent.

Execute when `decision.behavior === 'allow'`. Also execute when the tool name is `Bash`, `mode === 'dontAsk'`, `decision.behavior === 'deny'`, `decision.reason === 'mode'`, the command is present, `matchesDangerousPattern(command)` is false, and `matchesDestructiveGit(command)` is false. Every other decision returns `{ content: 'permission_denied', isError: true }` without calling `execute`.

On the execute path, set content to `formatSettledOutput(tool, value).content` and `isError` to false. Keep the existing `markReadPath` block for `Read`. Leave the `replay` line unchanged.

- [ ] **Step 4: Re-run the durable host tests**

Run: `bun test ./packages/sdk/src/durable.test.ts`

Expected: PASS, 0 fail. The previous Write, Read, thinking-delta, and bad-input tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/durable.ts packages/sdk/src/durable.test.ts
git commit -m "feat(sdk): run ordinary bash in a durable session"
```

### Task 2: Say so in help and architecture

**Files:**
- Modify: `packages/cli/src/help.ts`
- Modify: `packages/cli/src/help.test.ts`
- Modify: `ARCHITECTURE.md`
- Modify: `ARCHITECTURE.ko.md`

**Interfaces:**
- Consumes: nothing from Task 1's signatures. The sentences describe that task's behavior.
- Produces: no code symbol.

- [ ] **Step 1: Write the failing copy test**

In `packages/cli/src/help.test.ts`, import `readFileSync` from `node:fs` and `join` from `node:path`. Add:

```ts
test('durable help and architecture name ordinary bash', () => {
  expect(HELP_TEXT).toContain(
    'durable       Resume a sqlite session file; forces --dont-ask and runs ordinary Bash',
  )
  const root = join(import.meta.dir, '../../..')
  const english = readFileSync(join(root, 'ARCHITECTURE.md'), 'utf8')
  const korean = readFileSync(join(root, 'ARCHITECTURE.ko.md'), 'utf8')
  expect(english).toContain("this host's `dontAsk` runs ordinary leftover Bash")
  expect(korean).toContain('이 호스트의 `dontAsk`는 일반 leftover Bash를 실행한다')
  expect(english).toContain('No `bypass` / yolo / auto-allow-all-Bash')
  expect(english).toContain('deny unless allow rule or `isReadOnlyBashCommand`')
  expect(korean).toContain('헤드리스에서 Bash를 돌리려면 `.ravenclaw/permissions.json`에 allow rule을 심는다')
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test ./packages/cli/src/help.test.ts`

Expected: FAIL because the help line and the two architecture sentences are absent.

- [ ] **Step 3: Update the three copies**

In `packages/cli/src/help.ts`, replace the durable blurb's words `Resume a sqlite session file; forces --dont-ask` with `Resume a sqlite session file; forces --dont-ask and runs ordinary Bash`. Leave the surrounding spaces as they are.

Append this sentence to the `ARCHITECTURE.md` bullet that already says `raven durable` calls `createDurableSession`:

`decidePermission` does not promote Bash. After that call, this host's `dontAsk` runs ordinary leftover Bash. Commands matched by `matchesDangerousPattern` or `matchesDestructiveGit` stay `permission_denied`. `queryLoop` hosts stay unchanged.

Append this sentence to the `ARCHITECTURE.ko.md` paragraph that already says `raven durable`은 `queryLoop`와 `state.db`를 열지 않는다:

`decidePermission`은 Bash를 승격하지 않는다. 그 호출 뒤에 이 호스트의 `dontAsk`는 일반 leftover Bash를 실행한다. `matchesDangerousPattern`이나 `matchesDestructiveGit`에 맞는 명령은 `permission_denied`다. `queryLoop` 호스트는 그대로다.

Do not edit the `No bypass` bullet, the `dontAsk` permission table, or the Korean sentence about `.ravenclaw/permissions.json`.

- [ ] **Step 4: Run the spec's test command**

Run: `bun test ./packages/sdk/src/durable.test.ts ./packages/cli/src/durable-cmd.test.ts ./packages/cli/src/help.test.ts`

Expected: PASS, 0 fail. `durable-cmd.test.ts` still sees `permissionMode: 'dontAsk'` and no `systemPrompt`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/help.ts packages/cli/src/help.test.ts ARCHITECTURE.md ARCHITECTURE.ko.md
git commit -m "docs: describe ordinary bash on raven durable"
```
