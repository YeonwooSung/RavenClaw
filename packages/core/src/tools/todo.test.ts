import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { todoWriteTool } from './todo'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-todo-'))
  tempDirs.push(root)
  return root
}

function makeTurn(cwd: string): Turn {
  return {
    id: 'turn_1',
    sessionId: 'sess_1',
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

function makeCtx(cwd: string): ToolContext {
  const turn = makeTurn(cwd)
  return {
    turn,
    signal: turn.abort.signal,
    onProgress() {},
  }
}

describe('TodoWrite', () => {
  test('is an allow leftover write of the agent checklist', async () => {
    expect(todoWriteTool.name).toBe('TodoWrite')
    expect(todoWriteTool.isConcurrencySafe({ items: [] })).toBe(false)
    expect(todoWriteTool.isReadOnly({ items: [] })).toBe(false)
    const decision = await todoWriteTool.checkPermissions(
      { items: [{ text: 'a', status: 'pending' }] },
      makeCtx('/tmp'),
    )
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('parse requires items with text and status', () => {
    expect(
      todoWriteTool.parse({ items: [{ text: 'ship', status: 'pending' }] }).ok,
    ).toBe(true)
    expect(todoWriteTool.parse({ items: [{ text: 'ship' }] }).ok).toBe(false)
    expect(todoWriteTool.parse({ items: [{ text: 'x', status: 'nope' }] }).ok).toBe(false)
    expect(todoWriteTool.parse({}).ok).toBe(false)
  })

  test('writes .ravenclaw/todo.json under the turn cwd and fills missing ids', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    const out = await todoWriteTool.execute(
      {
        items: [
          { id: 't1', text: 'one', status: 'done' },
          { text: 'two', status: 'in_progress' },
        ],
      },
      ctx,
    )
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    const path = join(root, '.ravenclaw', 'todo.json')
    expect(existsSync(path)).toBe(true)
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Array<{
      id: string
      text: string
      status: string
    }>
    expect(raw).toHaveLength(2)
    expect(raw[0]).toEqual({ id: 't1', text: 'one', status: 'done' })
    expect(raw[1]?.text).toBe('two')
    expect(raw[1]?.status).toBe('in_progress')
    expect(raw[1]?.id.length).toBeGreaterThan(0)
  })

  test('uses projectCwd when the turn is isolated', async () => {
    const project = fixtureRoot()
    const worktree = fixtureRoot()
    const turn = makeTurn(worktree)
    turn.projectCwd = project
    const ctx: ToolContext = { turn, signal: turn.abort.signal, onProgress() {} }
    await todoWriteTool.execute({ items: [{ text: 'iso', status: 'pending' }] }, ctx)
    expect(existsSync(join(project, '.ravenclaw', 'todo.json'))).toBe(true)
    expect(existsSync(join(worktree, '.ravenclaw', 'todo.json'))).toBe(false)
  })
})
