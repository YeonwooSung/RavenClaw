import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { thinkDeeplyTool } from './think-deeply'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-think-'))
  tempDirs.push(root)
  return root
}

function makeTurn(cwd = '/tmp'): Turn {
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

function makeCtx(cwd = '/tmp', signal?: AbortSignal): ToolContext {
  const turn = makeTurn(cwd)
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
  }
}

describe('ThinkDeeply', () => {
  test('is a concurrency-safe read-only tool that allows by mode', async () => {
    expect(thinkDeeplyTool.name).toBe('ThinkDeeply')
    expect(thinkDeeplyTool.isConcurrencySafe({ thought: 'why' })).toBe(true)
    expect(thinkDeeplyTool.isReadOnly({ thought: 'why' })).toBe(true)
    expect(thinkDeeplyTool.interruptBehavior?.()).toBe('cancel')
    const decision = await thinkDeeplyTool.checkPermissions({ thought: 'why' }, makeCtx())
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('parse requires a non-empty thought string', () => {
    expect(thinkDeeplyTool.parse({ thought: 'consider the tests' }).ok).toBe(true)
    expect(thinkDeeplyTool.parse({ thought: '' }).ok).toBe(false)
    expect(thinkDeeplyTool.parse({}).ok).toBe(false)
    expect(thinkDeeplyTool.parse({ thought: 1 }).ok).toBe(false)
  })

  test('execute returns thought logged and does not write files', async () => {
    const root = fixtureRoot()
    const before = readdirSync(root)
    const out = await thinkDeeplyTool.execute({ thought: 'maybe the cache is stale' }, makeCtx(root))
    expect(out).toBe('thought logged')
    expect(readdirSync(root)).toEqual(before)
  })

  test('execute refuses when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      thinkDeeplyTool.execute({ thought: 'nope' }, makeCtx('/tmp', ac.signal)),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
