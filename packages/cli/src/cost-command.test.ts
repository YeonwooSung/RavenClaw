import { describe, expect, test } from 'bun:test'
import {
  CostTracker,
  createMemoryStore,
  createSessionEngine,
  defaultCompactPolicy,
  getModelProfile,
  type CompactPolicy,
  type Message,
  type ModelProfile,
  type Provider,
  type SessionRecord,
  type StreamEvent,
  type TokenUsage,
} from '@ravenclaw/core'
import { formatCostNotice, formatIncludedCap } from './cost-format'

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over }
}

function model(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'test',
    contextWindow: 200,
    reserveOutputTokens: 20,
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    cacheReadUsdPerMTok: 0.3,
    cacheWriteUsdPerMTok: 3.75,
    supportsThinking: false,
    ...over,
  }
}

function compact(over: Partial<CompactPolicy> = {}): CompactPolicy {
  return { ...defaultCompactPolicy(), protectLastMessages: 2, autoCompactBuffer: 13, ...over }
}

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'test',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: usage(),
    funding: 'byok',
    ...over,
  }
}

function user(id: string, text: string, createdAt: number): Message {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt }
}

function asst(
  id: string,
  text: string,
  createdAt: number,
  tokens?: TokenUsage,
): Message {
  const msg: Extract<Message, { role: 'assistant' }> = {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    createdAt,
  }
  if (tokens) msg.usage = tokens
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
      yield { type: 'text_delta', text: 'ok' }
      yield { type: 'stop', reason: 'end' }
    },
  }
}

async function drain(gen: AsyncGenerator<StreamEvent, unknown>) {
  const events: StreamEvent[] = []
  while (true) {
    const next = await gen.next()
    if (next.done) return { events, result: next.value }
    events.push(next.value)
  }
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

describe('/cost', () => {
  test('notice is the tracker display string', () => {
    const profile = getModelProfile('anthropic/claude-sonnet-4')
    const tokens = usage({ input: 50_000, output: 4_000 })
    expect(formatCostNotice({ usage: tokens, profile, funding: 'byok' })).toBe('$0.21')
    expect(formatCostNotice({ usage: tokens, profile, funding: 'included' })).toBe(
      '$0.00 included',
    )
    expect(
      formatCostNotice({ usage: tokens, profile, funding: 'included', remaining: 3 }),
    ).toBe('$0.00 included 3 left')
  })

  test('formatIncludedCap skips unknown remaining', () => {
    expect(formatIncludedCap(3)).toBe('included 3 left')
    expect(formatIncludedCap(0)).toBe('included 0 left')
    expect(formatIncludedCap()).toBeUndefined()
    expect(formatIncludedCap(Number.NaN)).toBeUndefined()
  })
})

describe('/resume', () => {
  test('resumed session.usage feeds the tracker and status USD', () => {
    const profile = getModelProfile('anthropic/claude-sonnet-4')
    const sess = session({
      usage: usage({ input: 50_000, output: 4_000 }),
      funding: 'byok',
    })
    const tracker = new CostTracker(profile, sess.funding, sess.usage)
    expect(tracker.display()).toBe('$0.21')
    expect(formatCostNotice({ usage: sess.usage, profile, funding: sess.funding })).toBe(
      '$0.21',
    )
  })
})

describe('/compact', () => {
  test('compactNow records a compact when over threshold', async () => {
    const store = createMemoryStore()
    const sess = session()
    await store.createSession(sess)
    const messages = [
      user('u0', 'old question', 1),
      asst('a0', 'old reply', 2, {
        input: 200,
        output: 20,
        cacheRead: 10,
        cacheWrite: 0,
      }),
      user('u1', 'recent', 3),
      asst('a1', 'recent reply', 4),
    ]
    await persistAll(store, sess.id, messages)

    const recorded: number[] = []
    const orig = store.recordCompact.bind(store)
    store.recordCompact = async (sessionId, generation, summary, inactivatedIds) => {
      recorded.push(generation)
      return orig(sessionId, generation, summary, inactivatedIds)
    }

    const engine = createSessionEngine({
      session: sess,
      messages,
      provider: dummyProvider(),
      store,
      tools: [],
      compact: compact(),
      model: model(),
      maxRounds: 8,
      async askUser() {
        return 'deny'
      },
    })

    await engine.compactNow()
    expect(recorded).toEqual([1])
    expect(engine.session.compactGeneration).toBe(1)

    const loaded = await store.loadSession(sess.id)
    expect(loaded.session.compactGeneration).toBe(1)
    expect(loaded.messages.map((msg) => msg.id)).not.toContain('u0')
    expect(loaded.messages.map((msg) => msg.id)).toContain('u1')
  })

  test('compactNow resolves without throwing when nothing to compact', async () => {
    const store = createMemoryStore()
    const sess = session()
    await store.createSession(sess)
    const engine = createSessionEngine({
      session: sess,
      messages: [user('u1', 'hi', 1)],
      provider: dummyProvider(),
      store,
      tools: [],
      compact: compact(),
      model: model(),
      maxRounds: 8,
      async askUser() {
        return 'deny'
      },
    })
    await engine.compactNow()
    expect(engine.session.compactGeneration).toBe(0)
  })
})

describe('session title', () => {
  test('first user submit sets a short single-line title and upserts', async () => {
    const store = createMemoryStore()
    const sess = session()
    await store.createSession(sess)
    const engine = createSessionEngine({
      session: sess,
      provider: dummyProvider(),
      store,
      tools: [],
      compact: compact(),
      model: model({ contextWindow: 32_000, reserveOutputTokens: 3_200 }),
      maxRounds: 8,
      async askUser() {
        return 'deny'
      },
    })

    await drain(
      engine.submitMessage(
        'Please investigate the unexpected compact generation bump\nwhen resuming a long session later',
      ),
    )

    const title = engine.session.title
    expect(title).toBeDefined()
    expect(title).not.toContain('\n')
    expect(title!.length).toBeGreaterThanOrEqual(40)
    expect(title!.length).toBeLessThanOrEqual(60)
    expect(
      'Please investigate the unexpected compact generation bump'.startsWith(title!) ||
        title!.startsWith('Please investigate the unexpected compact generation bump'),
    ).toBe(true)

    const loaded = await store.loadSession(sess.id)
    expect(loaded.session.title).toBe(title)
  })

  test('does not overwrite an existing title', async () => {
    const store = createMemoryStore()
    const sess = session({ title: 'Existing' })
    await store.createSession(sess)
    const engine = createSessionEngine({
      session: sess,
      provider: dummyProvider(),
      store,
      tools: [],
      compact: compact(),
      model: model({ contextWindow: 32_000, reserveOutputTokens: 3_200 }),
      maxRounds: 8,
      async askUser() {
        return 'deny'
      },
    })
    await drain(engine.submitMessage('a brand new prompt that would otherwise become the title'))
    expect(engine.session.title).toBe('Existing')
  })
})
