import { describe, expect, test } from 'bun:test'
import type { ToolContext, Turn } from '../types'
import { sleepTool } from './sleep'

function makeCtx(signal?: AbortSignal): ToolContext {
  const turn: Turn = {
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
    cwd: '/tmp',
    model: 'dummy',
    readFiles: new Set(),
  }
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
  }
}

describe('Sleep', () => {
  test('is a concurrency-safe read-only tool that allows by mode', async () => {
    expect(sleepTool.name).toBe('Sleep')
    expect(sleepTool.isConcurrencySafe({ seconds: 1 })).toBe(true)
    expect(sleepTool.isReadOnly({ seconds: 1 })).toBe(true)
    expect(sleepTool.interruptBehavior?.()).toBe('cancel')
    const decision = await sleepTool.checkPermissions({ seconds: 1 }, makeCtx())
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('parse accepts 0.1–60 seconds', () => {
    expect(sleepTool.parse({ seconds: 0.1 }).ok).toBe(true)
    expect(sleepTool.parse({ seconds: 60 }).ok).toBe(true)
    expect(sleepTool.parse({ seconds: 1 }).ok).toBe(true)
    expect(sleepTool.parse({ seconds: 0 }).ok).toBe(false)
    expect(sleepTool.parse({ seconds: 0.09 }).ok).toBe(false)
    expect(sleepTool.parse({ seconds: 61 }).ok).toBe(false)
    expect(sleepTool.parse({}).ok).toBe(false)
    expect(sleepTool.parse({ seconds: '1' }).ok).toBe(false)
  })

  test('returns slept Ns after waiting', async () => {
    const started = Date.now()
    const out = await sleepTool.execute({ seconds: 0.1 }, makeCtx())
    expect(out).toBe('slept 0.1s')
    expect(Date.now() - started).toBeGreaterThanOrEqual(80)
  })

  test('execute refuses when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(sleepTool.execute({ seconds: 0.1 }, makeCtx(ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  test('aborts a sleep in progress', async () => {
    const ac = new AbortController()
    const pending = sleepTool.execute({ seconds: 30 }, makeCtx(ac.signal))
    setTimeout(() => ac.abort(), 20)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
