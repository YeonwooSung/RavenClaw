import { describe, expect, test } from 'bun:test'
import {
  PersistError,
  type CompactPolicy,
  type Message,
  type ModelProfile,
  type Provider,
  type ProviderChunk,
  type ProviderRequest,
  type SessionRecord,
  type SessionStore,
  type StreamEvent,
  type Tool,
  type ToolContext,
} from '../types'
import { createSessionEngine } from './session-engine'
import { createMemoryStore } from '../session/memory-store'

const INCOMPLETE_TEXT =
  'incomplete: the process ended before this tool result was saved. The tool was not re-run.'
const TOOLS_OMITTED_TEXT =
  'tools_omitted: tools were disabled on the final round; the call was not executed.'

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

function defaultCompact(): CompactPolicy {
  return {
    enabled: true,
    autoCompactBuffer: 13_000,
    blockingBufferWhenManual: 3_000,
    protectLastMessages: 20,
    keepRecentFiles: 5,
    maxCharsPerRestoredFile: 5_000,
    maxCharsRestoredFilesTotal: 50_000,
    maxCharsPerRestoredSkill: 5_000,
    maxCharsRestoredSkillsTotal: 25_000,
    maxConsecutiveFailures: 3,
    llmSummarize: false,
  }
}

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_1',
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

type StreamScript =
  | ProviderChunk[]
  | ((
      req: ProviderRequest,
      signal: AbortSignal,
    ) => AsyncIterable<ProviderChunk>)

function createFakeProvider(scripts: StreamScript[]): Provider & {
  requests: ProviderRequest[]
  streamCount: number
} {
  const requests: ProviderRequest[] = []
  const queue = [...scripts]
  const provider = {
    id: 'fake',
    apiMode: 'openai_compat' as const,
    requests,
    streamCount: 0,
    profile(model: string) {
      return defaultModel(model)
    },
    async *stream(req: ProviderRequest, signal: AbortSignal) {
      provider.streamCount += 1
      requests.push(req)
      const script = queue.shift()
      if (!script) {
        yield { type: 'stop' as const, reason: null }
        return
      }
      const chunks = typeof script === 'function' ? script(req, signal) : script
      for await (const chunk of chunks) {
        if (signal.aborted) return
        yield chunk
      }
    },
  }
  return provider
}

function textThenStop(text: string): ProviderChunk[] {
  return [
    { type: 'text_delta', text },
    { type: 'stop', reason: 'end' },
  ]
}

function toolThenStop(
  id: string,
  name: string,
  input: unknown,
): ProviderChunk[] {
  return [
    { type: 'tool_call', id, name, input },
    { type: 'stop', reason: 'tool_use' },
  ]
}

function createEcho(opts?: {
  onExecute?: (input: { text: string }, ctx: ToolContext) => Promise<string> | string
}): Tool<{ text: string }, string> & { executeCount: number } {
  const tool = {
    name: 'Echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    executeCount: 0,
    parse(input: unknown) {
      if (
        !input ||
        typeof input !== 'object' ||
        typeof (input as { text?: unknown }).text !== 'string'
      ) {
        return { ok: false as const, message: 'expected { text: string }' }
      }
      return { ok: true as const, value: { text: (input as { text: string }).text } }
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async checkPermissions() {
      return { behavior: 'allow' as const, reason: 'mode' as const }
    },
    async execute(input: { text: string }, ctx: ToolContext) {
      tool.executeCount += 1
      if (opts?.onExecute) return opts.onExecute(input, ctx)
      return input.text
    },
  }
  return tool
}

async function collect(
  gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>,
): Promise<{ events: StreamEvent[]; result: import('../types').RoundEnd }> {
  const events: StreamEvent[] = []
  while (true) {
    const next = await gen.next()
    if (next.done) return { events, result: next.value }
    events.push(next.value)
  }
}

async function consumeUntil(
  gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>,
  pred: (e: StreamEvent) => boolean,
): Promise<{ events: StreamEvent[]; done: boolean; result?: import('../types').RoundEnd }> {
  const events: StreamEvent[] = []
  while (true) {
    const next = await gen.next()
    if (next.done) return { events, done: true, result: next.value }
    events.push(next.value)
    if (pred(next.value)) return { events, done: false }
  }
}

function spyPersist(store: SessionStore): { order: string[] } {
  const order: string[] = []
  const keys = [
    'persistUser',
    'persistAssistant',
    'persistToolCalls',
    'persistToolResults',
  ] as const
  for (const key of keys) {
    const orig = store[key].bind(store)
    ;(store[key] as unknown as (...args: never[]) => Promise<void>) = (async (
      ...args: never[]
    ) => {
      order.push(key)
      return (orig as (...a: never[]) => Promise<void>)(...args)
    }) as never
  }
  return { order }
}

function pairingHolds(messages: Message[]): boolean {
  const uses = new Set<string>()
  const tools = new Map<string, number>()
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const block of msg.blocks) {
        if (block.type === 'tool_use') uses.add(block.id)
      }
    }
    if (msg.role === 'tool') {
      tools.set(msg.toolUseId, (tools.get(msg.toolUseId) ?? 0) + 1)
    }
  }
  for (const id of uses) {
    if (tools.get(id) !== 1) return false
  }
  return true
}

function engineOpts(over: {
  provider: Provider
  store: SessionStore
  tools?: Tool[]
  session?: SessionRecord
  messages?: Message[]
  maxRounds?: number
}) {
  const session = over.session ?? makeSession()
  const opts: Parameters<typeof createSessionEngine>[0] = {
    session,
    provider: over.provider,
    store: over.store,
    tools: over.tools ?? [],
    compact: defaultCompact(),
    model: defaultModel(),
    maxRounds: over.maxRounds ?? 8,
    async askUser() {
      return 'deny'
    },
  }
  if (over.messages) opts.messages = over.messages
  return opts
}

describe('queryLoop via SessionEngine', () => {
  test('1. completed (no tools) persists user + assistant only', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const { order } = spyPersist(store)
    const provider = createFakeProvider([textThenStop('hello')])
    const engine = createSessionEngine(engineOpts({ provider, store, session }))

    const { result } = await collect(engine.submitMessage('hi'))

    expect(result).toEqual({ reason: 'completed' })
    expect(order).toContain('persistUser')
    expect(order).toContain('persistAssistant')
    expect(order).not.toContain('persistToolCalls')
    expect(provider.streamCount).toBe(1)

    const loaded = await store.loadSession(session.id)
    expect(loaded.messages.some((m) => m.role === 'user')).toBe(true)
    expect(loaded.messages.some((m) => m.role === 'assistant')).toBe(true)
  })

  test('2. one tool round: persistToolCalls before execute, then persistToolResults', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_tool' })
    await store.createSession(session)
    const order: string[] = []
    const origCalls = store.persistToolCalls.bind(store)
    store.persistToolCalls = async (id, msg) => {
      order.push('persistToolCalls')
      return origCalls(id, msg)
    }
    const origResults = store.persistToolResults.bind(store)
    store.persistToolResults = async (id, msgs) => {
      order.push('persistToolResults')
      return origResults(id, msgs)
    }
    const echo = createEcho({
      onExecute: async (input) => {
        order.push('execute')
        return input.text
      },
    })
    const provider = createFakeProvider([
      toolThenStop('call_1', 'Echo', { text: 'ping' }),
      textThenStop('done'),
    ])
    const engine = createSessionEngine(
      engineOpts({ provider, store, session, tools: [echo] }),
    )

    const { result } = await collect(engine.submitMessage('echo ping'))

    expect(result).toEqual({ reason: 'completed' })
    expect(order).toEqual(['persistToolCalls', 'execute', 'persistToolResults'])
    expect(echo.executeCount).toBe(1)

    const loaded = await store.loadSession(session.id)
    expect(pairingHolds(loaded.messages)).toBe(true)
    const toolMsg = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'call_1',
    )
    expect(toolMsg).toBeDefined()
    expect(toolMsg?.ok).toBe(true)
    expect(toolMsg?.blocks[0]?.text).toBe('ping')
  })

  test('3. abort mid-stream returns aborted and does not execute', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_abort_stream' })
    await store.createSession(session)
    const echo = createEcho()
    const provider = createFakeProvider([
      async function* (_req, signal) {
        yield { type: 'text_delta' as const, text: 'partial' }
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    ])
    const engine = createSessionEngine(
      engineOpts({ provider, store, session, tools: [echo] }),
    )

    const gen = engine.submitMessage('go')
    const mid = await consumeUntil(gen, (e) => e.type === 'text_delta')
    expect(mid.done).toBe(false)
    engine.abort()
    const rest = await collect(gen)

    expect(rest.result).toEqual({ reason: 'aborted' })
    expect(echo.executeCount).toBe(0)
  })

  test('4. abort mid-tools pairs aborted and does not start remaining', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_abort_tools' })
    await store.createSession(session)

    let releaseExecute!: () => void
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve
    })
    let secondStarted = 0

    const slow: Tool<Record<string, never>, string> = {
      name: 'Slow',
      description: 'slow',
      inputSchema: { type: 'object' },
      parse() {
        return { ok: true, value: {} }
      },
      isConcurrencySafe: () => false,
      isReadOnly: () => true,
      async checkPermissions() {
        return { behavior: 'allow', reason: 'mode' }
      },
      async execute(_input, ctx) {
        releaseExecute()
        await new Promise<void>((resolve, reject) => {
          if (ctx.signal.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            return
          }
          ctx.signal.addEventListener(
            'abort',
            () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            },
            { once: true },
          )
        })
        return 'never'
      },
    }
    const second: Tool<Record<string, never>, string> = {
      name: 'Second',
      description: 'second',
      inputSchema: { type: 'object' },
      parse() {
        return { ok: true, value: {} }
      },
      isConcurrencySafe: () => false,
      isReadOnly: () => true,
      async checkPermissions() {
        return { behavior: 'allow', reason: 'mode' }
      },
      async execute() {
        secondStarted += 1
        return 'second'
      },
    }
    const provider = createFakeProvider([
      [
        { type: 'tool_call', id: 'slow_1', name: 'Slow', input: {} },
        { type: 'tool_call', id: 'second_1', name: 'Second', input: {} },
        { type: 'stop', reason: 'tool_use' },
      ],
    ])
    const engine = createSessionEngine(
      engineOpts({ provider, store, session, tools: [slow, second] }),
    )

    const gen = engine.submitMessage('run both')
    const drained = collect(gen)
    await executeGate
    engine.abort()
    const { result } = await drained

    expect(result).toEqual({ reason: 'aborted' })
    expect(secondStarted).toBe(0)

    const loaded = await store.loadSession(session.id)
    const slowResult = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'slow_1',
    )
    expect(slowResult?.ok).toBe(false)
    expect(slowResult?.blocks[0]?.text.startsWith('aborted:')).toBe(true)
  })

  test('5. persistToolCalls fail does not execute and returns persist_failed', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_persist_calls' })
    await store.createSession(session)
    store.persistToolCalls = async () => {
      throw new PersistError('locked', 'locked')
    }
    const echo = createEcho()
    const provider = createFakeProvider([
      toolThenStop('call_x', 'Echo', { text: 'nope' }),
    ])
    const engine = createSessionEngine(
      engineOpts({ provider, store, session, tools: [echo] }),
    )

    const { result } = await collect(engine.submitMessage('call'))

    expect(result.reason).toBe('persist_failed')
    expect(echo.executeCount).toBe(0)
  })

  test('6. persistToolResults fail after execute: retry once, no next assemble', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_persist_results' })
    await store.createSession(session)
    let resultCalls = 0
    store.persistToolResults = async () => {
      resultCalls += 1
      throw new PersistError('locked', 'locked')
    }
    const echo = createEcho()
    const provider = createFakeProvider([
      toolThenStop('call_y', 'Echo', { text: 'once' }),
      textThenStop('should not run'),
    ])
    const engine = createSessionEngine(
      engineOpts({ provider, store, session, tools: [echo] }),
    )

    const { result } = await collect(engine.submitMessage('call'))

    expect(echo.executeCount).toBe(1)
    expect(resultCalls).toBe(2)
    expect(result.reason).toBe('results_persist_failed')
    expect(provider.streamCount).toBe(1)
  })

  test('6b. persistToolResults fail then incomplete retry succeeds: still no next assemble', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_persist_results_retry_ok' })
    await store.createSession(session)
    let resultCalls = 0
    const inner = store.persistToolResults.bind(store)
    store.persistToolResults = async (sessionId, messages) => {
      resultCalls += 1
      if (resultCalls === 1) throw new PersistError('locked', 'locked')
      return inner(sessionId, messages)
    }
    const echo = createEcho()
    const provider = createFakeProvider([
      toolThenStop('call_z', 'Echo', { text: 'once' }),
      textThenStop('should not run'),
    ])
    const engine = createSessionEngine(
      engineOpts({ provider, store, session, tools: [echo] }),
    )

    const { result } = await collect(engine.submitMessage('call'))

    expect(echo.executeCount).toBe(1)
    expect(resultCalls).toBe(2)
    expect(result.reason).toBe('results_persist_failed')
    expect(provider.streamCount).toBe(1)
    const loaded = await store.loadSession(session.id)
    const toolRow = loaded.messages.find((msg) => msg.role === 'tool')
    expect(toolRow?.ok).toBe(false)
    expect(toolRow && toolRow.role === 'tool' ? toolRow.blocks[0]?.text : '').toBe(
      INCOMPLETE_TEXT,
    )
  })

  test('7. resume of unpaired tool_use inserts incomplete and never executes', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_resume' })
    await store.createSession(session)
    const user: Extract<Message, { role: 'user' }> = {
      id: 'u_resume',
      role: 'user',
      blocks: [{ type: 'text', text: 'please echo' }],
      createdAt: 1,
    }
    await store.persistUser(session.id, user)
    await store.persistToolCalls(session.id, {
      id: 'a_resume',
      role: 'assistant',
      blocks: [
        { type: 'tool_use', id: 'call_orphan', name: 'Echo', input: { text: 'hi' } },
      ],
      createdAt: 2,
    })

    const loaded = await store.loadSession(session.id)
    const incomplete = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'call_orphan',
    )
    expect(incomplete).toBeDefined()
    expect(incomplete?.ok).toBe(false)
    expect(incomplete?.blocks[0]?.text).toBe(INCOMPLETE_TEXT)

    const echo = createEcho()
    const provider = createFakeProvider([textThenStop('continuing')])
    const engine = createSessionEngine(
      engineOpts({
        provider,
        store,
        session: loaded.session,
        messages: loaded.messages,
        tools: [echo],
      }),
    )

    const { result } = await collect(engine.submitMessage('continue'))
    expect(result).toEqual({ reason: 'completed' })
    expect(echo.executeCount).toBe(0)
  })

  test('8. maxRounds: 2 with tool-use on round 2 → grace stream tools:[]', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_grace' })
    await store.createSession(session)
    const echo = createEcho()
    const provider = createFakeProvider([
      toolThenStop('g1', 'Echo', { text: 'one' }),
      toolThenStop('g2', 'Echo', { text: 'two' }),
      textThenStop('final answer'),
    ])
    const engine = createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [echo],
        maxRounds: 2,
      }),
    )

    const { result } = await collect(engine.submitMessage('loop'))

    expect(result).toEqual({ reason: 'max_rounds', round: 2 })
    expect(provider.requests).toHaveLength(3)
    expect(provider.requests[0]?.tools.map((t) => t.name)).toEqual(['Echo'])
    expect(provider.requests[1]?.tools.map((t) => t.name)).toEqual(['Echo'])
    expect(provider.requests[2]?.tools).toEqual([])
    expect(echo.executeCount).toBe(2)
  })

  test('9. grace provider emitting tool_use pairs tools_omitted and does not execute', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_grace_hallucinate' })
    await store.createSession(session)
    const echo = createEcho()
    const provider = createFakeProvider([
      toolThenStop('h1', 'Echo', { text: 'one' }),
      toolThenStop('h2', 'Echo', { text: 'two' }),
      toolThenStop('h3', 'Echo', { text: 'should not run' }),
    ])
    const engine = createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [echo],
        maxRounds: 2,
      }),
    )

    const { result } = await collect(engine.submitMessage('loop'))

    expect(result).toEqual({ reason: 'max_rounds', round: 2 })
    expect(echo.executeCount).toBe(2)
    expect(provider.requests[2]?.tools).toEqual([])

    const loaded = await store.loadSession(session.id)
    expect(pairingHolds(loaded.messages)).toBe(true)
    const omitted = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'h3',
    )
    expect(omitted?.ok).toBe(false)
    expect(omitted?.blocks[0]?.text).toBe(TOOLS_OMITTED_TEXT)
  })

  test('10. unknown tool name yields error tool message and can complete', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_unknown' })
    await store.createSession(session)
    const echo = createEcho()
    const provider = createFakeProvider([
      toolThenStop('u1', 'NotATool', { foo: 1 }),
      textThenStop('recovered'),
    ])
    const engine = createSessionEngine(
      engineOpts({ provider, store, session, tools: [echo] }),
    )

    const { result } = await collect(engine.submitMessage('unknown'))

    expect(result).toEqual({ reason: 'completed' })
    expect(echo.executeCount).toBe(0)

    const loaded = await store.loadSession(session.id)
    const err = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'u1',
    )
    expect(err?.ok).toBe(false)
    expect(err?.blocks[0]?.text.startsWith('unknown_tool:')).toBe(true)
    expect(pairingHolds(loaded.messages)).toBe(true)
  })

  test('persistUser failure does not call provider.stream', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_user_fail' })
    await store.createSession(session)
    store.persistUser = async () => {
      throw new PersistError('readonly', 'cannot write user')
    }
    const provider = createFakeProvider([textThenStop('nope')])
    const engine = createSessionEngine(engineOpts({ provider, store, session }))

    await expect(collect(engine.submitMessage('hi'))).rejects.toBeInstanceOf(
      PersistError,
    )
    expect(provider.streamCount).toBe(0)
  })
})
