import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { decidePermission } from '../permissions/pipeline'
import { enterWorktreeTool } from './enter-worktree'
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
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-enter-wt-'))
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
  const sessionId = `sess_enter_${Date.now()}_${seq++}`
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

describe('EnterWorktree', () => {
  test('is an unsafe mutating tool that leftover-asks and blocks interrupt', async () => {
    expect(enterWorktreeTool.name).toBe('EnterWorktree')
    expect(enterWorktreeTool.isConcurrencySafe({})).toBe(false)
    expect(enterWorktreeTool.isReadOnly({})).toBe(false)
    expect(enterWorktreeTool.interruptBehavior?.()).toBe('block')
    const decision = await enterWorktreeTool.checkPermissions({}, makeCtx('/tmp'))
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }
  })

  test('default mode leftover ask stays ask', async () => {
    const decision = await decidePermission({
      name: 'EnterWorktree',
      input: {},
      tool: enterWorktreeTool,
      ctx: makeCtx('/tmp'),
      mode: 'default',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('ask')
  })

  test('parse accepts an optional name', () => {
    expect(enterWorktreeTool.parse({}).ok).toBe(true)
    expect(enterWorktreeTool.parse({ name: 'iso' }).ok).toBe(true)
    expect(enterWorktreeTool.parse({ name: '' }).ok).toBe(false)
  })

  test('sets cwd to the worktree and keeps projectCwd as the original', async () => {
    const root = fixtureRoot()
    initGitRepo(root)
    const ctx = makeCtx(root)
    const out = await enterWorktreeTool.execute({ name: 'iso' }, ctx)
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    const expected = join(root, '.ravenclaw', 'worktrees', 'iso')
    expect(ctx.turn.cwd).toBe(expected)
    expect(ctx.turn.projectCwd).toBe(root)
    expect(existsSync(join(expected, '.git'))).toBe(true)
    expect(out).toContain(expected)
  })

  test('does not overwrite an existing projectCwd', async () => {
    const project = fixtureRoot()
    initGitRepo(project)
    const ctx = makeCtx(project)
    ctx.turn.projectCwd = project
    const out = await enterWorktreeTool.execute({ name: 'child' }, ctx)
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(ctx.turn.projectCwd).toBe(project)
    expect(ctx.turn.cwd).toBe(join(project, '.ravenclaw', 'worktrees', 'child'))
  })

  test('returns EnterWorktree failed when the cwd is not a git repo', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    const out = await enterWorktreeTool.execute({}, ctx)
    expect(out.startsWith('EnterWorktree failed:')).toBe(true)
    expect(ctx.turn.cwd).toBe(root)
    expect(ctx.turn.projectCwd).toBeUndefined()
  })

  test('execute refuses when the signal is already aborted', async () => {
    const root = fixtureRoot()
    const ac = new AbortController()
    ac.abort()
    await expect(enterWorktreeTool.execute({}, makeCtx(root, ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
