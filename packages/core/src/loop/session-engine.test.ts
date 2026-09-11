import { describe, expect, test } from 'bun:test'
import { createMemoryStore } from '../session/memory-store'
import type {
  CompactPolicy,
  Message,
  ModelProfile,
  Provider,
  ProviderChunk,
  ProviderRequest,
  SessionRecord,
} from '../types'
import { createSessionEngine } from './session-engine'

function defaultModel(id = 'dummy'): ModelProfile {
  return {
    id,
    contextWindow: 32_000,
    reserveOutputTokens: 3_200,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
  }
}

function defaultCompact(over: Partial<CompactPolicy> = {}): CompactPolicy {
  return {
    enabled: true,
    autoCompactBuffer: 13_000,
    blockingBufferWhenManual: 3_000,
    protectLastMessages: 2,
    keepRecentFiles: 5,
    maxCharsPerRestoredFile: 5_000,
    maxCharsRestoredFilesTotal: 50_000,
    maxCharsPerRestoredSkill: 5_000,
    maxCharsRestoredSkillsTotal: 25_000,
    maxConsecutiveFailures: 3,
    llmSummarize: false,
    ...over,
  }
}

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_compact_now',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'dummy',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

function user(id: string, text: string, createdAt: number): Message {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt }
}

function asst(id: string, text: string, createdAt: number): Message {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], createdAt }
}

function createFakeProvider(scripts: ProviderChunk[][]): Provider & {
  streamCount: number
} {
  const queue = [...scripts]
  const provider = {
    id: 'fake',
    apiMode: 'openai_compat' as const,
    streamCount: 0,
    profile(model: string) {
      return defaultModel(model)
    },
    async *stream(_req: ProviderRequest, signal: AbortSignal) {
      provider.streamCount += 1
      const script = queue.shift() ?? [{ type: 'stop' as const, reason: null }]
      for (const chunk of script) {
        if (signal.aborted) return
        yield chunk
      }
    },
  }
  return provider
}

async function persistAll(
  store: ReturnType<typeof createMemoryStore>,
  sessionId: string,
  messages: Message[],
): Promise<void> {
  for (const msg of messages) {
    if (msg.role === 'user') await store.persistUser(sessionId, msg)
    else if (msg.role === 'assistant') await store.persistAssistant(sessionId, msg)
    else await store.persistToolResults(sessionId, [msg])
  }
}

describe('compactNow', () => {
  test('llmSummarize true omits mechanical override and records the LLM summary', async () => {
    const store = createMemoryStore()
    const sess = makeSession()
    await store.createSession(sess)
    const messages = [
      user('u0', 'old question', 1),
      asst('a0', 'old reply', 2),
      user('u1', 'recent', 3),
      asst('a1', 'recent reply', 4),
    ]
    await persistAll(store, sess.id, messages)

    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'LLM SUMMARY' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    let recorded = ''
    const orig = store.recordCompact.bind(store)
    store.recordCompact = async (sessionId, generation, summary, inactivatedIds) => {
      recorded = summary
      return orig(sessionId, generation, summary, inactivatedIds)
    }

    const engine = createSessionEngine({
      session: sess,
      messages,
      provider,
      store,
      tools: [],
      compact: defaultCompact({ llmSummarize: true }),
      model: defaultModel(),
      maxRounds: 8,
      async askUser() {
        return 'deny'
      },
    })

    await engine.compactNow()
    expect(provider.streamCount).toBe(1)
    expect(recorded).toBe('LLM SUMMARY')
    expect(engine.session.compactGeneration).toBe(1)
  })

  test('llmSummarize false keeps mechanical summary and does not stream', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_compact_mech' })
    await store.createSession(sess)
    const messages = [
      user('u0', 'old question', 1),
      asst('a0', 'old reply', 2),
      user('u1', 'recent', 3),
      asst('a1', 'recent reply', 4),
    ]
    await persistAll(store, sess.id, messages)

    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'should not run' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    let recorded = ''
    const orig = store.recordCompact.bind(store)
    store.recordCompact = async (sessionId, generation, summary, inactivatedIds) => {
      recorded = summary
      return orig(sessionId, generation, summary, inactivatedIds)
    }

    const engine = createSessionEngine({
      session: sess,
      messages,
      provider,
      store,
      tools: [],
      compact: defaultCompact({ llmSummarize: false }),
      model: defaultModel(),
      maxRounds: 8,
      async askUser() {
        return 'deny'
      },
    })

    await engine.compactNow()
    expect(provider.streamCount).toBe(0)
    expect(recorded).toContain('old question')
    expect(recorded).not.toBe('should not run')
  })

  test('llmSummarize true falls back to mechanical when the provider throws', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_compact_fallback' })
    await store.createSession(sess)
    const messages = [
      user('u0', 'old question', 1),
      asst('a0', 'old reply', 2),
      user('u1', 'recent', 3),
      asst('a1', 'recent reply', 4),
    ]
    await persistAll(store, sess.id, messages)

    const provider: Provider & { streamCount: number } = {
      id: 'fake',
      apiMode: 'openai_compat',
      streamCount: 0,
      profile(model: string) {
        return defaultModel(model)
      },
      async *stream() {
        provider.streamCount += 1
        throw new Error('provider down')
      },
    }
    let recorded = ''
    const orig = store.recordCompact.bind(store)
    store.recordCompact = async (sessionId, generation, summary, inactivatedIds) => {
      recorded = summary
      return orig(sessionId, generation, summary, inactivatedIds)
    }

    const engine = createSessionEngine({
      session: sess,
      messages,
      provider,
      store,
      tools: [],
      compact: defaultCompact({ llmSummarize: true }),
      model: defaultModel(),
      maxRounds: 8,
      async askUser() {
        return 'deny'
      },
    })

    await engine.compactNow()
    expect(provider.streamCount).toBe(1)
    expect(recorded).toContain('old question')
  })
})
