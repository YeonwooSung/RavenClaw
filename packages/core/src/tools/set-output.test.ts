import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolContext, Turn } from '../types'
import { setChildOutput, setOutputTool, takeChildOutput } from './set-output'

afterEach(() => {
  takeChildOutput('sess_1')
  takeChildOutput('sess_2')
})

function makeTurn(sessionId = 'sess_1'): Turn {
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
    cwd: '/tmp',
    model: 'dummy',
    readFiles: new Set(),
  }
}

function makeCtx(sessionId = 'sess_1', signal?: AbortSignal): ToolContext {
  const turn = makeTurn(sessionId)
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
  }
}

describe('SetOutput', () => {
  test('is a read-only allow leftover that is not concurrency-safe', async () => {
    expect(setOutputTool.name).toBe('SetOutput')
    expect(setOutputTool.isConcurrencySafe({ data: {} })).toBe(false)
    expect(setOutputTool.isReadOnly({ data: {} })).toBe(true)
    expect(setOutputTool.interruptBehavior?.()).toBe('block')
    const decision = await setOutputTool.checkPermissions({ data: { ok: true } }, makeCtx())
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('parse requires data', () => {
    expect(setOutputTool.parse({ data: { a: 1 } }).ok).toBe(true)
    expect(setOutputTool.parse({ data: 'plain' }).ok).toBe(true)
    expect(setOutputTool.parse({ data: null }).ok).toBe(true)
    expect(setOutputTool.parse({}).ok).toBe(false)
  })

  test('execute pretty-prints JSON, stores under sessionId, and take removes it', async () => {
    const ctx = makeCtx('sess_1')
    const out = await setOutputTool.execute({ data: { ok: true, n: 2 } }, ctx)
    expect(out).toBe('output set')
    const stored = takeChildOutput('sess_1')
    expect(stored).toBe('{\n  "ok": true,\n  "n": 2\n}')
    expect(takeChildOutput('sess_1')).toBeUndefined()
  })

  test('string data is JSON-stringified', async () => {
    await setOutputTool.execute({ data: 'hello' }, makeCtx('sess_1'))
    expect(takeChildOutput('sess_1')).toBe('"hello"')
  })

  test('setChildOutput and takeChildOutput are isolated by session', () => {
    setChildOutput('sess_1', 'one')
    setChildOutput('sess_2', 'two')
    expect(takeChildOutput('sess_1')).toBe('one')
    expect(takeChildOutput('sess_2')).toBe('two')
    expect(takeChildOutput('sess_1')).toBeUndefined()
  })

  test('execute refuses when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(setOutputTool.execute({ data: 1 }, makeCtx('sess_1', ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(takeChildOutput('sess_1')).toBeUndefined()
  })
})
