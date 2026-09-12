import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { decidePermission } from '../permissions/pipeline'
import { enterWorktreeTool } from './enter-worktree'
import { exitWorktreeTool } from './exit-worktree'
import { exitSessionWorktree } from './session-worktree'

const emptyRules = { session: [], user: [], project: [] }
const tempDirs: string[] = []
const sessionIds: string[] = []
let seq = 0

afterEach(() => {
  while (sessionIds.length > 0) {
    const id = sessionIds.pop()
    if (id) exitSessionWorktree(id, 'remove', true)
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-exit-wt-'))
  tempDirs.push(root)
  return root
}

function initGitRepo(dir: string): void {
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    expect(result.status).toBe(0)
  }
  run(['init'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['commit', '--allow-empty', '-m', 'init'])
}

function makeTurn(cwd: string): Turn {
  const sessionId = `sess_exit_${Date.now()}_${seq++}`
  sessionIds.push(sessionId)
  return {
    id: 'turn_1',
    sessionId,
    messages: [],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd,
    model: 'dummy',
    readFiles: new Set(),
  }
}

function makeCtx(cwd: string, signal?: AbortSignal): ToolContext {
  const turn = makeTurn(cwd)
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
  }
}

describe('ExitWorktree', () => {
  test('is an unsafe mutating tool that leftover-asks and blocks interrupt', async () => {
    expect(exitWorktreeTool.name).toBe('ExitWorktree')
    expect(exitWorktreeTool.isConcurrencySafe({ action: 'keep' })).toBe(false)
    expect(exitWorktreeTool.isReadOnly({ action: 'remove' })).toBe(false)
    expect(exitWorktreeTool.interruptBehavior?.()).toBe('block')
    const decision = await exitWorktreeTool.checkPermissions({ action: 'keep' }, makeCtx('/tmp'))
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }
  })

  test('default mode leftover ask stays ask', async () => {
    const decision = await decidePermission({
      name: 'ExitWorktree',
      input: { action: 'remove' },
      tool: exitWorktreeTool,
      ctx: makeCtx('/tmp'),
      mode: 'default',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('ask')
  })

  test('parse requires keep or remove', () => {
    expect(exitWorktreeTool.parse({ action: 'keep' }).ok).toBe(true)
    expect(exitWorktreeTool.parse({ action: 'remove', discard_changes: true }).ok).toBe(true)
    expect(exitWorktreeTool.parse({}).ok).toBe(false)
    expect(exitWorktreeTool.parse({ action: 'drop' }).ok).toBe(false)
  })

  test('isEnabled is false without a session worktree', () => {
    expect(exitWorktreeTool.isEnabled?.(makeCtx('/tmp'))).toBe(false)
  })

  test('isEnabled is true after EnterWorktree', async () => {
    const root = fixtureRoot()
    initGitRepo(root)
    const ctx = makeCtx(root)
    expect(exitWorktreeTool.isEnabled?.(ctx)).toBe(false)
    await enterWorktreeTool.execute({ name: 'iso' }, ctx)
    expect(exitWorktreeTool.isEnabled?.(ctx)).toBe(true)
  })

  test('returns a no-op string when the session has no worktree', async () => {
    const out = await exitWorktreeTool.execute({ action: 'keep' }, makeCtx('/tmp'))
    expect(out.toLowerCase()).toMatch(/no session worktree|not in/)
  })

  test('keep restores cwd and leaves the worktree on disk', async () => {
    const root = fixtureRoot()
    initGitRepo(root)
    const ctx = makeCtx(root)
    await enterWorktreeTool.execute({ name: 'kept' }, ctx)
    const worktree = ctx.turn.cwd
    const out = await exitWorktreeTool.execute({ action: 'keep' }, ctx)
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(ctx.turn.cwd).toBe(root)
    expect(existsSync(worktree)).toBe(true)
  })

  test('remove deletes the worktree and restores cwd', async () => {
    const root = fixtureRoot()
    initGitRepo(root)
    const ctx = makeCtx(root)
    await enterWorktreeTool.execute({ name: 'gone' }, ctx)
    const worktree = ctx.turn.cwd
    const out = await exitWorktreeTool.execute({ action: 'remove' }, ctx)
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(ctx.turn.cwd).toBe(root)
    expect(existsSync(worktree)).toBe(false)
  })

  test('remove of a dirty worktree fails unless discard_changes is set', async () => {
    const root = fixtureRoot()
    initGitRepo(root)
    const ctx = makeCtx(root)
    await enterWorktreeTool.execute({ name: 'dirty' }, ctx)
    const worktree = ctx.turn.cwd
    writeFileSync(join(worktree, 'scratch.txt'), 'x\n')
    const blocked = await exitWorktreeTool.execute({ action: 'remove' }, ctx)
    expect(blocked.startsWith('ExitWorktree failed:')).toBe(true)
    expect(ctx.turn.cwd).toBe(worktree)
    expect(existsSync(worktree)).toBe(true)

    const forced = await exitWorktreeTool.execute(
      { action: 'remove', discard_changes: true },
      ctx,
    )
    expect(forced.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(ctx.turn.cwd).toBe(root)
    expect(existsSync(worktree)).toBe(false)
  })

  test('execute refuses when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      exitWorktreeTool.execute({ action: 'keep' }, makeCtx('/tmp', ac.signal)),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
