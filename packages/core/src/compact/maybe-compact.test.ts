import { describe, expect, test } from 'bun:test'
import { maybeCompact, type LoopState } from '../loop/phases'
import { createMemoryStore } from '../session/memory-store'
import type {
  CompactPolicy,
  Message,
  ModelProfile,
  Provider,
  SessionRecord,
  StreamEvent,
  TokenUsage,
} from '../types'
import { defaultCompactPolicy } from './policy'

function model(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'test',
    contextWindow: 32_000,
    reserveOutputTokens: 3_200,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
    ...over,
  }
}

function compact(over: Partial<CompactPolicy> = {}): CompactPolicy {
  return { ...defaultCompactPolicy(), protectLastMessages: 2, ...over }
}

function session(): SessionRecord {
  return {
    id: 's1',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'test',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
  }
}

function user(id: string, text: string, createdAt: number): Message {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt }
}

function asstText(
  id: string,
  text: string,
  createdAt: number,
  usage?: TokenUsage,
): Message {
  const msg: Extract<Message, { role: 'assistant' }> = {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    createdAt,
  }
  if (usage) msg.usage = usage
  return msg
}

function dummyProvider(): Provider {
  return {
    id: 'fake',
    apiMode: 'openai_compat',
    profile(id: string) {
      return model({ id })
    },
    async *stream() {
      yield { type: 'stop', reason: null }
    },
  }
}

async function drain(state: LoopState) {
  const events: StreamEvent[] = []
  const gen = maybeCompact(state)
  while (true) {
    const next = await gen.next()
    if (next.done) return { events, result: next.value }
    events.push(next.value)
  }
}

async function makeState(over: {
  messages: Message[]
  compact?: CompactPolicy
  model?: ModelProfile
  compactFailures?: number
  persist?: boolean
}): Promise<LoopState> {
  const store = createMemoryStore()
  const sess = session()
  await store.createSession(sess)
  if (over.persist !== false) {
    for (const msg of over.messages) {
      if (msg.role === 'user') await store.persistUser(sess.id, msg)
      else if (msg.role === 'assistant') await store.persistAssistant(sess.id, msg)
      else await store.persistToolResults(sess.id, [msg])
    }
  }
  const state: LoopState = {
    turn: {
      id: 't1',
      sessionId: sess.id,
      messages: over.messages,
      round: 1,
      maxRounds: 8,
      graceUsed: false,
      abort: new AbortController(),
      permissionMode: 'default',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactGeneration: 0,
      funding: 'byok',
      cwd: '/tmp',
      model: 'test',
      readFiles: new Set(),
    },
    tools: [],
    provider: dummyProvider(),
    store,
    compact: over.compact ?? compact(),
    model: over.model ?? model(),
    async askUser() {
      return 'deny'
    },
    lastHadToolUse: false,
    pendingText: '',
    pendingThinking: '',
    pendingToolCalls: [],
    pendingUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    streamAborted: false,
    assistantMessage: null,
    toolResults: [],
    compactFailures: over.compactFailures ?? 0,
  }
  return state
}

describe('maybeCompact', () => {
  test('tiny messages continue without compacting', async () => {
    const state = await makeState({
      messages: [user('u1', 'hi', 1)],
    })
    const { events, result } = await drain(state)
    expect(result).toEqual({ action: 'continue' })
    expect(events).toEqual([])
    expect(state.turn.compactGeneration).toBe(0)
    expect(state.turn.messages.map((msg) => msg.id)).toEqual(['u1'])
  })

  test('compact off + over hard limit → context_full', async () => {
    const state = await makeState({
      messages: [user('u1', 'x'.repeat(4_000), 1)],
      compact: compact({ enabled: false, blockingBufferWhenManual: 10 }),
      model: model({ contextWindow: 200, reserveOutputTokens: 20 }),
    })
    const { result } = await drain(state)
    expect(result).toEqual({ action: 'return', end: { reason: 'context_full' } })
  })

  test('anchored over threshold yields compact and bumps generation', async () => {
    const messages = [
      user('u0', 'old', 1),
      asstText('a0', 'old reply', 2),
      user('u1', 'recent', 3),
      asstText('a1', 'recent reply', 4, {
        input: 200,
        output: 20,
        cacheRead: 10,
        cacheWrite: 0,
      }),
    ]
    const state = await makeState({
      messages,
      compact: compact({ autoCompactBuffer: 13 }),
      model: model({ contextWindow: 200, reserveOutputTokens: 20 }),
    })
    const { events, result } = await drain(state)
    expect(result).toEqual({ action: 'continue' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'compact', generation: 1 })
    expect(state.turn.compactGeneration).toBe(1)
    expect(state.turn.messages.some((msg) => msg.id === 'u0')).toBe(false)
  })

  test('circuit-breaker skips after 3 failures', async () => {
    const messages = [
      user('u0', 'old', 1),
      asstText('a0', 'old reply', 2, {
        input: 200,
        output: 20,
        cacheRead: 10,
        cacheWrite: 0,
      }),
      user('u1', 'recent', 3),
      asstText('a1', 'ok', 4),
    ]
    const state = await makeState({
      messages,
      compact: compact({ autoCompactBuffer: 13, blockingBufferWhenManual: 10 }),
      model: model({ contextWindow: 200, reserveOutputTokens: 20 }),
      compactFailures: 3,
    })
    const { events, result } = await drain(state)
    expect(result).toEqual({ action: 'continue' })
    expect(events).toEqual([])
    expect(state.turn.compactGeneration).toBe(0)
    expect(state.turn.messages.map((msg) => msg.id)).toEqual(['u0', 'a0', 'u1', 'a1'])
  })
})
