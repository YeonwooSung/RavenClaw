import { describe, expect, test } from 'bun:test'
import { PersistError, type CompactPolicy, type Message, type ModelProfile, type Tool, type Turn } from '../types'
import { createMemoryStore } from '../session/memory-store'
import {
  assembleRequest,
  beginRound,
  buildAssistantMessage,
  persistResultsWithRetry,
  type LoopState,
} from './phases'

function model(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'dummy',
    contextWindow: 32_000,
    reserveOutputTokens: 128,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
    ...over,
  }
}

function compact(): CompactPolicy {
  return {
    enabled: false,
    autoCompactBuffer: 100,
    blockingBufferWhenManual: 50,
    protectLastMessages: 2,
    keepRecentFiles: 1,
    maxCharsPerRestoredFile: 100,
    maxCharsRestoredFilesTotal: 100,
    maxCharsPerRestoredSkill: 100,
    maxCharsRestoredSkillsTotal: 100,
    maxConsecutiveFailures: 3,
    llmSummarize: false,
  }
}

function echo(): Tool {
  return {
    name: 'Echo',
    description: 'echo',
    inputSchema: { type: 'object' },
    parse(input) {
      return { ok: true, value: input }
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute() {
      return 'ok'
    },
  }
}

function gated(): Tool {
  return {
    ...echo(),
    name: 'Gated',
    isEnabled() {
      return false
    },
  }
}

function turn(over: Partial<Turn> = {}): Turn {
  return {
    id: 't1',
    sessionId: 's1',
    messages: [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'hi' }],
        createdAt: 1,
      },
    ],
    round: 0,
    maxRounds: 4,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd: '/tmp',
    model: 'dummy',
    readFiles: new Set(),
    ...over,
  }
}

function state(over: Partial<LoopState> = {}): LoopState {
  return {
    turn: turn(),
    tools: [echo(), gated()],
    provider: {
      id: 'fake',
      apiMode: 'openai_compat',
      profile: () => model(),
      async *stream() {
        yield { type: 'stop', reason: null }
      },
    },
    store: createMemoryStore(),
    compact: compact(),
    model: model(),
    askUser: async () => 'deny',
    lastHadToolUse: false,
    pendingText: '',
    pendingThinking: '',
    pendingToolCalls: [],
    pendingUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    streamAborted: false,
    assistantMessage: null,
    toolResults: [],
    compactFailures: 0,
    overflowCompacted: false,
    lastStopReason: null,
    fallbackUsed: false,
    outputNudges: 0,
    schemaNudges: 0,
    emptyNudges: 0,
    verifyNudges: 0,
    mutatedThisTurn: false,
    sawVerifyCommand: false,
    ...over,
  }
}

describe('buildAssistantMessage', () => {
  test('includes thinking, text, tool_use, and usage when present', () => {
    const msg = buildAssistantMessage(
      state({
        pendingThinking: 'think',
        pendingText: 'hello',
        pendingToolCalls: [{ id: 'c1', name: 'Echo', input: { n: 1 } }],
        pendingUsage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 },
      }),
    )
    expect(msg.role).toBe('assistant')
    expect(msg.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(msg.usage).toEqual({ input: 3, output: 2, cacheRead: 1, cacheWrite: 0 })
  })

  test('omits usage when all counters are zero', () => {
    const msg = buildAssistantMessage(state({ pendingText: 'hi' }))
    expect(msg.usage).toBeUndefined()
  })
})

describe('assembleRequest', () => {
  test('drops isEnabled-false tools and uses turn.model', () => {
    const req = assembleRequest(state())
    expect(req.model).toBe('dummy')
    expect(req.tools.map((tool) => tool.name)).toEqual(['Echo'])
  })

  test('strips thinking when the model does not support it', () => {
    const asst: Extract<Message, { role: 'assistant' }> = {
      id: 'a1',
      role: 'assistant',
      blocks: [
        { type: 'thinking', text: 'secret' },
        { type: 'text', text: 'visible' },
      ],
      createdAt: 1,
    }
    const req = assembleRequest(state({ turn: turn({ messages: [asst] }) }))
    const out = req.messages[0]
    expect(out?.role).toBe('assistant')
    if (out && out.role === 'assistant') {
      expect(out.blocks).toEqual([{ type: 'text', text: 'visible' }])
    }
  })

  test('grace round sends no tools', () => {
    const req = assembleRequest(state({ turn: turn({ graceUsed: true }) }))
    expect(req.tools).toEqual([])
  })
})

describe('beginRound', () => {
  test('returns aborted when the turn signal is already aborted', async () => {
    const current = state()
    current.turn.abort.abort()
    const gen = beginRound(current)
    const next = await gen.next()
    expect(next.done).toBe(true)
    expect(next.value).toEqual({ action: 'return', end: { reason: 'aborted' } })
  })

  test('increments the round and emits round_start', async () => {
    const current = state()
    const gen = beginRound(current)
    const start = await gen.next()
    expect(start.value).toEqual({ type: 'round_start', round: 1 })
    const done = await gen.next()
    expect(done.done).toBe(true)
    expect(done.value).toEqual({ action: 'continue' })
    expect(current.turn.round).toBe(1)
  })
})

describe('persistResultsWithRetry', () => {
  test('returns undefined on first success', async () => {
    const current = state()
    await current.store.createSession({
      id: 's1',
      createdAt: 1,
      updatedAt: 1,
      cwd: '/tmp',
      model: 'dummy',
      permissionMode: 'default',
      compactGeneration: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      funding: 'byok',
    })
    const result = {
      id: 'tr1',
      role: 'tool' as const,
      toolUseId: 'c1',
      ok: true,
      blocks: [{ type: 'text' as const, text: 'ok' }],
      createdAt: 1,
    }
    expect(await persistResultsWithRetry(current, [result])).toBeUndefined()
  })

  test('retries incomplete then returns results_persist_failed', async () => {
    let calls = 0
    const store = createMemoryStore()
    const failing = {
      ...store,
      async persistToolResults() {
        calls += 1
        if (calls === 1) throw new PersistError('busy', 'busy')
      },
    }
    const current = state({ store: failing })
    const result = {
      id: 'tr1',
      role: 'tool' as const,
      toolUseId: 'c1',
      ok: true,
      blocks: [{ type: 'text' as const, text: 'ok' }],
      createdAt: 1,
    }
    current.turn.messages = [result]
    const end = await persistResultsWithRetry(current, [result])
    expect(end?.reason).toBe('results_persist_failed')
    expect(calls).toBe(2)
    const stored = current.turn.messages[0]
    expect(stored && stored.role === 'tool' ? stored.ok : undefined).toBe(false)
  })
})
