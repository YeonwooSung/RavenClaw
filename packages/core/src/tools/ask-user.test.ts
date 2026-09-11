import { describe, expect, test } from 'bun:test'
import type { ToolContext, Turn } from '../types'
import { decidePermission } from '../permissions/pipeline'
import { askUserTool, createAskUserTool, formatAskUserPrompt, type AskUserInput } from './ask-user'

const emptyRules = { session: [], user: [], project: [] }

const sample: AskUserInput = {
  questions: [
    {
      header: 'Style',
      question: 'Which formatter?',
      options: [
        { label: 'prettier', description: 'default' },
        { label: 'biome' },
      ],
    },
    {
      question: 'Ship it?',
      multiSelect: true,
      options: [{ label: 'yes' }, { label: 'no' }, { label: 'later' }],
    },
  ],
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

function makeCtx(signal?: AbortSignal): ToolContext {
  const turn = makeTurn()
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
  }
}

describe('AskUser', () => {
  test('is a leftover-ask read-only tool that blocks interrupt', async () => {
    expect(askUserTool.name).toBe('AskUser')
    expect(askUserTool.isConcurrencySafe(sample)).toBe(false)
    expect(askUserTool.isReadOnly(sample)).toBe(true)
    expect(askUserTool.interruptBehavior?.()).toBe('block')
    const decision = await askUserTool.checkPermissions(sample, makeCtx())
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }
  })

  test('default mode leftover ask stays ask', async () => {
    const decision = await decidePermission({
      name: 'AskUser',
      input: sample,
      tool: askUserTool,
      ctx: makeCtx(),
      mode: 'default',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.saveAs).toBe('session')
    }
  })

  test('parse requires at least one question with two options', () => {
    expect(askUserTool.parse(sample).ok).toBe(true)
    expect(askUserTool.parse({}).ok).toBe(false)
    expect(askUserTool.parse({ questions: [] }).ok).toBe(false)
    expect(
      askUserTool.parse({
        questions: [{ question: 'only one', options: [{ label: 'a' }] }],
      }).ok,
    ).toBe(false)
    expect(
      askUserTool.parse({
        questions: [{ question: 'ok', options: [{ label: 'a' }, { label: 'b' }] }],
      }).ok,
    ).toBe(true)
  })

  test('formatAskUserPrompt lists headers, options, and multi-select', () => {
    const text = formatAskUserPrompt(sample)
    expect(text).toContain('1. Style: Which formatter?')
    expect(text).toContain('a) prettier — default')
    expect(text).toContain('b) biome')
    expect(text).toContain('2. Ship it? (multi-select)')
    expect(text).toContain('c) later')
  })

  test('headless execute returns formatted questions when no ask fn is set', async () => {
    const out = await askUserTool.execute(sample, makeCtx())
    expect(out.startsWith('AskUser (no host):\n')).toBe(true)
    expect(out).toContain('Which formatter?')
    expect(out).toContain('prettier')
  })

  test('factory ask fn return value is the tool result', async () => {
    const tool = createAskUserTool(async () => 'chose prettier')
    const out = await tool.execute(sample, makeCtx())
    expect(out).toBe('chose prettier')
  })

  test('factory ask fn receives the input and abort signal', async () => {
    let seen: AskUserInput | undefined
    const ac = new AbortController()
    const tool = createAskUserTool(async (input, signal) => {
      seen = input
      expect(signal).toBe(ac.signal)
      return 'ok'
    })
    await tool.execute(sample, makeCtx(ac.signal))
    expect(seen).toEqual(sample)
  })

  test('execute refuses when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(askUserTool.execute(sample, makeCtx(ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
