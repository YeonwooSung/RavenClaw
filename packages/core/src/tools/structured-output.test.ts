import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolContext, Turn } from '../types'
import { takeChildOutput } from './set-output'
import { createStructuredOutputTool, validateAgainstSchema } from './structured-output'

afterEach(() => {
  takeChildOutput('sess_1')
  takeChildOutput('sess_2')
})

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'n'],
  properties: {
    ok: { type: 'boolean' },
    n: { type: 'integer' },
  },
}

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

describe('StructuredOutput', () => {
  test('is a read-only allow leftover that is not concurrency-safe', async () => {
    const tool = createStructuredOutputTool(schema)
    expect(tool.name).toBe('StructuredOutput')
    expect(tool.inputSchema).toBe(schema)
    expect(tool.isConcurrencySafe({ ok: true, n: 1 })).toBe(false)
    expect(tool.isReadOnly({ ok: true, n: 1 })).toBe(true)
    expect(tool.interruptBehavior?.()).toBe('block')
    const decision = await tool.checkPermissions({ ok: true, n: 1 }, makeCtx())
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('parse uses the provided object schema and returns ok:false on failure', () => {
    const tool = createStructuredOutputTool(schema)
    expect(tool.parse({ ok: true, n: 2 }).ok).toBe(true)
    expect(tool.parse({ ok: true }).ok).toBe(false)
    expect(tool.parse({ ok: 'yes', n: 2 }).ok).toBe(false)
    expect(tool.parse({}).ok).toBe(false)
    expect(tool.parse(null).ok).toBe(false)
  })

  test('parse returns ok:false when the schema is not a type-object JSON schema', () => {
    expect(createStructuredOutputTool({ type: 'string' }).parse('hi').ok).toBe(false)
    expect(createStructuredOutputTool('not-a-schema').parse({ a: 1 }).ok).toBe(false)
    expect(createStructuredOutputTool(null).parse({ a: 1 }).ok).toBe(false)
    expect(createStructuredOutputTool([{ type: 'object' }]).parse({ a: 1 }).ok).toBe(false)
  })

  test('execute pretty-prints JSON, stores under sessionId, and returns output set', async () => {
    const tool = createStructuredOutputTool(schema)
    const ctx = makeCtx('sess_1')
    const out = await tool.execute({ ok: true, n: 2 }, ctx)
    expect(out).toBe('output set')
    expect(takeChildOutput('sess_1')).toBe('{\n  "ok": true,\n  "n": 2\n}')
    expect(takeChildOutput('sess_1')).toBeUndefined()
  })

  test('stores are isolated by session', async () => {
    const tool = createStructuredOutputTool(schema)
    await tool.execute({ ok: true, n: 1 }, makeCtx('sess_1'))
    await tool.execute({ ok: false, n: 2 }, makeCtx('sess_2'))
    expect(takeChildOutput('sess_1')).toBe('{\n  "ok": true,\n  "n": 1\n}')
    expect(takeChildOutput('sess_2')).toBe('{\n  "ok": false,\n  "n": 2\n}')
  })

  test('execute refuses when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const tool = createStructuredOutputTool(schema)
    await expect(tool.execute({ ok: true, n: 1 }, makeCtx('sess_1', ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(takeChildOutput('sess_1')).toBeUndefined()
  })
})

describe('validateAgainstSchema', () => {
  test('requires a type-object value and every required key', () => {
    expect(validateAgainstSchema(schema, { ok: true, n: 2 })).toBe(true)
    expect(validateAgainstSchema(schema, { ok: true, n: 2, extra: 1 })).toBe(true)
    expect(validateAgainstSchema(schema, { ok: true })).toBe(false)
    expect(validateAgainstSchema(schema, { n: 2 })).toBe(false)
    expect(validateAgainstSchema(schema, null)).toBe(false)
    expect(validateAgainstSchema(schema, 'nope')).toBe(false)
    expect(validateAgainstSchema(schema, [])).toBe(false)
    expect(validateAgainstSchema(null, { ok: true })).toBe(false)
    expect(validateAgainstSchema({ required: ['a'] }, { a: 1 })).toBe(true)
    expect(validateAgainstSchema({ required: ['a'] }, {})).toBe(false)
    expect(validateAgainstSchema({}, { anything: true })).toBe(true)
  })
})
