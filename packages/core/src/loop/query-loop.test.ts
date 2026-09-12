import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { skillTool } from '../tools/skill'
import { GRACE_NOTICE } from './budget'

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
  verifyOnStop?: boolean
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
  if (over.verifyOnStop === true) opts.verifyOnStop = true
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
    const graceReq = provider.requests[2]
    const graceToolText = graceReq?.messages
      .filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool')
      .at(-1)
      ?.blocks.find((b) => b.type === 'text')
    expect(graceToolText && graceToolText.type === 'text' ? graceToolText.text : '').toContain(
      GRACE_NOTICE,
    )
    const loaded = await store.loadSession(session.id)
    for (const msg of loaded.messages) {
      if (msg.role !== 'tool') continue
      for (const block of msg.blocks) {
        if (block.type === 'text') expect(block.text).not.toContain(GRACE_NOTICE)
      }
    }
  })

  test('8b. two concurrency-safe tools in one round keep arrival order', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_parallel' })
    await store.createSession(session)
    const echo = createEcho()
    const provider = createFakeProvider([
      [
        { type: 'tool_call', id: 'p1', name: 'Echo', input: { text: 'first' } },
        { type: 'tool_call', id: 'p2', name: 'Echo', input: { text: 'second' } },
        { type: 'stop', reason: 'tool_use' },
      ],
      textThenStop('done'),
    ])
    const engine = createSessionEngine(
      engineOpts({ provider, store, session, tools: [echo] }),
    )

    const { result } = await collect(engine.submitMessage('both'))

    expect(result).toEqual({ reason: 'completed' })
    expect(echo.executeCount).toBe(2)
    const loaded = await store.loadSession(session.id)
    const toolRows = loaded.messages.filter(
      (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
    )
    expect(toolRows.map((row) => row.toolUseId)).toEqual(['p1', 'p2'])
    expect(toolRows.map((row) => row.blocks[0]?.text)).toEqual(['first', 'second'])
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

  test('truncated no-tool stop persists assistant+user and streams again without persistToolCalls', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_truncate' })
    await store.createSession(session)
    const { order } = spyPersist(store)
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'cut' },
        { type: 'stop', reason: 'max_tokens' },
      ],
      textThenStop('rest'),
    ])
    const engine = createSessionEngine(engineOpts({ provider, store, session }))
    const { result } = await collect(engine.submitMessage('hi'))
    expect(result).toEqual({ reason: 'completed' })
    expect(provider.streamCount).toBe(2)
    expect(order.filter((step) => step === 'persistAssistant').length).toBe(2)
    expect(order).toContain('persistUser')
    expect(order).not.toContain('persistToolCalls')
  })

  test('fallback-model is the model id on the next provider request', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_fallback', model: 'primary' })
    await store.createSession(session)
    const boom = Object.assign(new Error('overloaded'), { retryable: true, status: 529 })
    let calls = 0
    const provider = createFakeProvider([
      async function* () {
        calls += 1
        throw boom
      },
      textThenStop('ok'),
    ])
    const opts = engineOpts({ provider, store, session })
    opts.fallbackModel = 'backup'
    const engine = createSessionEngine(opts)
    const { result, events } = await collect(engine.submitMessage('hi'))
    expect(result).toEqual({ reason: 'completed' })
    expect(provider.requests[0]?.model).toBe('primary')
    expect(provider.requests[1]?.model).toBe('backup')
    expect(events.some((event) => event.type === 'status' && event.message.includes('backup'))).toBe(
      true,
    )
    expect(calls).toBe(1)
  })

  test('Skill allowed-tools shrinks the live pool on the next assemble', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-ql-skill-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-ql-skill-cwd-'))
    const savedHome = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    try {
      const skillDir = join(cwd, '.ravenclaw', 'skills', 'narrow')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: narrow',
          'description: Narrow skill',
          'allowed-tools: [Read, Grep]',
          '---',
          '',
          'Use Read and Grep only.',
        ].join('\n'),
      )

      const store = createMemoryStore()
      const session = makeSession({ id: 'sess_skill_shrink', cwd })
      await store.createSession(session)
      const provider = createFakeProvider([
        toolThenStop('sk1', 'Skill', { name: 'narrow' }),
        textThenStop('done'),
      ])
      const tools = [
        stubNamedTool('Read'),
        stubNamedTool('Grep'),
        stubNamedTool('Edit'),
        stubNamedTool('Write'),
        stubNamedTool('Bash'),
        skillTool,
        stubNamedTool('Agent'),
        stubNamedTool('EnterPlanMode'),
        stubNamedTool('ExitPlanMode'),
      ]
      const engine = createSessionEngine(engineOpts({ provider, store, session, tools }))

      const { result } = await collect(engine.submitMessage('use narrow'))

      expect(result).toEqual({ reason: 'completed' })
      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual([
        'Read',
        'Grep',
        'Edit',
        'Write',
        'Bash',
        'Skill',
        'Agent',
        'EnterPlanMode',
        'ExitPlanMode',
      ])
      expect(provider.requests[1]?.tools.map((tool) => tool.name)).toEqual([
        'Read',
        'Grep',
        'Skill',
        'Agent',
        'EnterPlanMode',
        'ExitPlanMode',
      ])
      expect(provider.requests[1]?.tools.map((tool) => tool.name)).not.toContain('Edit')
      expect(provider.requests[1]?.tools.map((tool) => tool.name)).not.toContain('Write')
      expect(provider.requests[1]?.tools.map((tool) => tool.name)).not.toContain('Bash')

      const loaded = await store.loadSession(session.id)
      expect(pairingHolds(loaded.messages)).toBe(true)
      const skillResult = loaded.messages.find(
        (m): m is Extract<Message, { role: 'tool' }> =>
          m.role === 'tool' && m.toolUseId === 'sk1',
      )
      expect(skillResult?.ok).toBe(true)
      expect(skillResult?.blocks[0]?.text).toContain('This skill suggests: Read, Grep.')
      expect(skillResult?.blocks[0]?.text).toContain('Use Read and Grep only.')
    } finally {
      if (savedHome === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = savedHome
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('Skill allowed-tools: Read does not execute a later Edit tool_call', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-ql-skill-jail-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-ql-skill-jail-cwd-'))
    const savedHome = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    try {
      const skillDir = join(cwd, '.ravenclaw', 'skills', 'readonly')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: readonly',
          'description: Read-only skill',
          'allowed-tools: Read',
          '---',
          '',
          'Use Read only.',
        ].join('\n'),
      )

      const store = createMemoryStore()
      const session = makeSession({ id: 'sess_skill_jail', cwd })
      await store.createSession(session)
      const edit = stubNamedTool('Edit')
      let editCount = 0
      const origExecute = edit.execute.bind(edit)
      edit.execute = async (input, ctx) => {
        editCount += 1
        return origExecute(input, ctx)
      }
      const provider = createFakeProvider([
        toolThenStop('sk1', 'Skill', { name: 'readonly' }),
        toolThenStop('ed1', 'Edit', { path: 'secret.txt', old_string: 'a', new_string: 'b' }),
        textThenStop('recovered'),
      ])
      const tools = [
        stubNamedTool('Read'),
        stubNamedTool('Grep'),
        edit,
        stubNamedTool('Write'),
        stubNamedTool('Bash'),
        skillTool,
        stubNamedTool('Agent'),
        stubNamedTool('EnterPlanMode'),
        stubNamedTool('ExitPlanMode'),
      ]
      const engine = createSessionEngine(engineOpts({ provider, store, session, tools }))

      const { result } = await collect(engine.submitMessage('use readonly then edit'))

      expect(result).toEqual({ reason: 'completed' })
      expect(editCount).toBe(0)

      const loaded = await store.loadSession(session.id)
      expect(pairingHolds(loaded.messages)).toBe(true)
      const editResult = loaded.messages.find(
        (m): m is Extract<Message, { role: 'tool' }> =>
          m.role === 'tool' && m.toolUseId === 'ed1',
      )
      expect(editResult?.ok).toBe(false)
      expect(editResult?.blocks[0]?.text.startsWith('unknown_tool:')).toBe(true)
    } finally {
      if (savedHome === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = savedHome
      rmSync(home, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('Bash-like { content, persistPath } lands on the stored tool message', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_persist_path' })
    await store.createSession(session)
    const dump: Tool<{ text: string }, { content: string; persistPath: string }> = {
      name: 'Dump',
      description: 'dump',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
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
      async execute(input) {
        return { content: input.text, persistPath: '/tmp/dump.txt' }
      },
      renderResult(output) {
        return output.content
      },
    }
    const provider = createFakeProvider([
      toolThenStop('d1', 'Dump', { text: 'preview' }),
      textThenStop('done'),
    ])
    const engine = createSessionEngine(
      engineOpts({ provider, store, session, tools: [dump] }),
    )

    const { events, result } = await collect(engine.submitMessage('dump'))
    expect(result).toEqual({ reason: 'completed' })
    const toolEvent = events.find((event) => event.type === 'tool_result')
    expect(toolEvent && toolEvent.type === 'tool_result' ? toolEvent.result.persistPath : undefined).toBe(
      '/tmp/dump.txt',
    )

    const loaded = await store.loadSession(session.id)
    const toolMsg = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'd1',
    )
    expect(toolMsg?.ok).toBe(true)
    expect(toolMsg?.blocks[0]?.text).toBe('preview')
    expect(toolMsg?.persistPath).toBe('/tmp/dump.txt')
  })

  test('413 compact-retries once then completes; second overflow is context_full', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_overflow_once' })
    await store.createSession(session)
    const prior: Message[] = [
      {
        id: 'u0',
        role: 'user',
        blocks: [{ type: 'text', text: 'old question' }],
        createdAt: 1,
      },
      {
        id: 'a0',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'old answer' }],
        createdAt: 2,
      },
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'recent' }],
        createdAt: 3,
      },
      {
        id: 'a1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'recent reply' }],
        createdAt: 4,
      },
    ]
    for (const msg of prior) {
      if (msg.role === 'user') await store.persistUser(session.id, msg)
      else if (msg.role === 'assistant') await store.persistAssistant(session.id, msg)
    }

    const overflow = Object.assign(new Error('prompt too long'), {
      retryable: false,
      status: 413,
    })
    const provider = createFakeProvider([
      async function* () {
        throw overflow
      },
      textThenStop('after compact'),
    ])
    const recorded: string[] = []
    const orig = store.recordCompact.bind(store)
    store.recordCompact = async (sessionId, generation, summary, inactivatedIds) => {
      recorded.push(summary)
      return orig(sessionId, generation, summary, inactivatedIds)
    }
    const engine = createSessionEngine({
      ...engineOpts({ provider, store, session, messages: prior }),
      compact: { ...defaultCompact(), protectLastMessages: 2 },
    })

    const { events, result } = await collect(engine.submitMessage('go'))
    expect(result).toEqual({ reason: 'completed' })
    expect(provider.streamCount).toBe(2)
    expect(recorded).toHaveLength(1)
    expect(events.some((event) => event.type === 'compact')).toBe(true)
    expect(provider.requests[1]!.messages.length).toBeLessThan(
      provider.requests[0]!.messages.length,
    )

    const again = makeSession({ id: 'sess_overflow_twice' })
    await store.createSession(again)
    for (const msg of prior) {
      if (msg.role === 'user') await store.persistUser(again.id, msg)
      else if (msg.role === 'assistant') await store.persistAssistant(again.id, msg)
    }
    const twice = createFakeProvider([
      async function* () {
        throw overflow
      },
      async function* () {
        throw Object.assign(new Error('context length exceeded'), {
          retryable: false,
          status: 413,
        })
      },
    ])
    const engine2 = createSessionEngine({
      ...engineOpts({ provider: twice, store, session: again, messages: prior }),
      compact: { ...defaultCompact(), protectLastMessages: 2 },
    })
    const second = await collect(engine2.submitMessage('go again'))
    expect(second.result.reason).toBe('context_full')
    expect(twice.streamCount).toBe(2)
  })

  test('context-length message compact-retries; retryable 429 still retries without compact', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_overflow_msg' })
    await store.createSession(session)
    const prior: Message[] = [
      {
        id: 'u0',
        role: 'user',
        blocks: [{ type: 'text', text: 'old question' }],
        createdAt: 1,
      },
      {
        id: 'a0',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'old answer' }],
        createdAt: 2,
      },
    ]
    for (const msg of prior) {
      if (msg.role === 'user') await store.persistUser(session.id, msg)
      else if (msg.role === 'assistant') await store.persistAssistant(session.id, msg)
    }
    const provider = createFakeProvider([
      async function* () {
        throw new Error('This model maximum context length was exceeded')
      },
      textThenStop('ok'),
    ])
    let compactCalls = 0
    const orig = store.recordCompact.bind(store)
    store.recordCompact = async (sessionId, generation, summary, inactivatedIds) => {
      compactCalls += 1
      return orig(sessionId, generation, summary, inactivatedIds)
    }
    const engine = createSessionEngine({
      ...engineOpts({ provider, store, session, messages: prior }),
      compact: { ...defaultCompact(), protectLastMessages: 1 },
    })
    const { result } = await collect(engine.submitMessage('go'))
    expect(result).toEqual({ reason: 'completed' })
    expect(provider.streamCount).toBe(2)
    expect(compactCalls).toBe(1)

    const retrySession = makeSession({ id: 'sess_retryable' })
    await store.createSession(retrySession)
    const retryable = Object.assign(new Error('rate limited'), {
      retryable: true,
      status: 429,
    })
    const retryProvider = createFakeProvider([
      async function* () {
        throw retryable
      },
      textThenStop('after backoff'),
    ])
    let retryCompacts = 0
    store.recordCompact = async (sessionId, generation, summary, inactivatedIds) => {
      retryCompacts += 1
      return orig(sessionId, generation, summary, inactivatedIds)
    }
    const retryEngine = createSessionEngine(
      engineOpts({ provider: retryProvider, store, session: retrySession }),
    )
    const retried = await collect(retryEngine.submitMessage('hi'))
    expect(retried.result).toEqual({ reason: 'completed' })
    expect(retryProvider.streamCount).toBe(2)
    expect(retryCompacts).toBe(0)
  })

  test('block interruptBehavior finishes execute after abort; leftover siblings abort', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_block_interrupt' })
    await store.createSession(session)

    let releaseExecute!: () => void
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve
    })
    let finish!: () => void
    const finishGate = new Promise<void>((resolve) => {
      finish = resolve
    })
    let sawAbortOnCtx = false
    let secondStarted = 0

    const block: Tool<Record<string, never>, string> = {
      name: 'BlockWrite',
      description: 'block',
      inputSchema: { type: 'object' },
      parse() {
        return { ok: true, value: {} }
      },
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      interruptBehavior() {
        return 'block'
      },
      async checkPermissions() {
        return { behavior: 'allow', reason: 'mode' }
      },
      async execute(_input, ctx) {
        releaseExecute()
        await finishGate
        sawAbortOnCtx = ctx.signal.aborted
        return 'saved'
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
      interruptBehavior() {
        return 'cancel'
      },
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
        { type: 'tool_call', id: 'block_1', name: 'BlockWrite', input: {} },
        { type: 'tool_call', id: 'second_1', name: 'Second', input: {} },
        { type: 'stop', reason: 'tool_use' },
      ],
    ])
    const engine = createSessionEngine(
      engineOpts({ provider, store, session, tools: [block, second] }),
    )

    const gen = engine.submitMessage('write then more')
    const drained = collect(gen)
    await executeGate
    engine.abort()
    finish()
    const { result } = await drained

    expect(result).toEqual({ reason: 'aborted' })
    expect(sawAbortOnCtx).toBe(false)
    expect(secondStarted).toBe(0)

    const loaded = await store.loadSession(session.id)
    const blockResult = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'block_1',
    )
    expect(blockResult?.ok).toBe(true)
    expect(blockResult?.blocks[0]?.text).toBe('saved')
    const secondResult = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'second_1',
    )
    expect(secondResult?.ok).toBe(false)
    expect(secondResult?.blocks[0]?.text.startsWith('aborted:')).toBe(true)
  })

  test('empty completion twice then a reply: two nudges then completed', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_empty_then_reply' })
    await store.createSession(session)
    const provider = createFakeProvider([
      [{ type: 'stop', reason: 'end' }],
      [{ type: 'text_delta', text: '   \n' }, { type: 'stop', reason: 'end' }],
      textThenStop('hello'),
    ])
    const engine = createSessionEngine(engineOpts({ provider, store, session }))
    const { result, events } = await collect(engine.submitMessage('hi'))
    expect(result).toEqual({ reason: 'completed' })
    expect(provider.streamCount).toBe(3)
    expect(
      events.filter((event) => event.type === 'status' && event.message === 'empty completion; retrying'),
    ).toHaveLength(2)
    const loaded = await store.loadSession(session.id)
    const nudges = loaded.messages.filter(
      (msg) =>
        msg.role === 'user' &&
        msg.blocks[0]?.type === 'text' &&
        msg.blocks[0].text.includes('Your previous reply was empty'),
    )
    expect(nudges).toHaveLength(2)
  })

  test('three empty completions complete after two nudges', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_empty_three' })
    await store.createSession(session)
    const provider = createFakeProvider([
      [{ type: 'stop', reason: 'end' }],
      [{ type: 'stop', reason: 'end' }],
      [{ type: 'stop', reason: 'end' }],
      textThenStop('should not run'),
    ])
    const engine = createSessionEngine(engineOpts({ provider, store, session }))
    const { result, events } = await collect(engine.submitMessage('hi'))
    expect(result).toEqual({ reason: 'completed' })
    expect(provider.streamCount).toBe(3)
    expect(
      events.filter((event) => event.type === 'status' && event.message === 'empty completion; retrying'),
    ).toHaveLength(2)
  })

  test('edit then complete without tests nudges verify-on-stop', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_verify_edit' })
    await store.createSession(session)
    const edit = stubNamedTool('Edit')
    const provider = createFakeProvider([
      toolThenStop('e1', 'Edit', { path: 'a.ts', old_string: 'a', new_string: 'b' }),
      textThenStop('done'),
      textThenStop('skipping verification'),
      textThenStop('ok'),
    ])
    const engine = createSessionEngine(
      engineOpts({ provider, store, session, tools: [edit], verifyOnStop: true }),
    )
    const { result, events } = await collect(engine.submitMessage('edit it'))
    expect(result).toEqual({ reason: 'completed' })
    expect(provider.streamCount).toBe(4)
    expect(
      events.filter((event) => event.type === 'status' && event.message === 'verify on stop; retrying'),
    ).toHaveLength(2)
    const loaded = await store.loadSession(session.id)
    expect(
      loaded.messages.some(
        (msg) =>
          msg.role === 'user' &&
          msg.blocks[0]?.type === 'text' &&
          msg.blocks[0].text.includes('Code changed this turn but no test or lint command ran'),
      ),
    ).toBe(true)
  })

  test('edit plus bun test bash does not verify-nudge', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_verify_tested' })
    await store.createSession(session)
    const edit = stubNamedTool('Edit')
    const bash = stubNamedTool('Bash')
    const provider = createFakeProvider([
      toolThenStop('e1', 'Edit', { path: 'a.ts', old_string: 'a', new_string: 'b' }),
      toolThenStop('b1', 'Bash', { command: 'bun test' }),
      textThenStop('all good'),
    ])
    const engine = createSessionEngine(
      engineOpts({ provider, store, session, tools: [edit, bash], verifyOnStop: true }),
    )
    const { result, events } = await collect(engine.submitMessage('edit and test'))
    expect(result).toEqual({ reason: 'completed' })
    expect(provider.streamCount).toBe(3)
    expect(
      events.some((event) => event.type === 'status' && event.message === 'verify on stop; retrying'),
    ).toBe(false)
  })

  test('exec path does not verify-nudge after an edit', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_verify_exec' })
    await store.createSession(session)
    const edit = stubNamedTool('Edit')
    const provider = createFakeProvider([
      toolThenStop('e1', 'Edit', { path: 'a.ts', old_string: 'a', new_string: 'b' }),
      textThenStop('done'),
    ])
    const engine = createSessionEngine(engineOpts({ provider, store, session, tools: [edit] }))
    const { result, events } = await collect(engine.submitMessage('edit it'))
    expect(result).toEqual({ reason: 'completed' })
    expect(provider.streamCount).toBe(2)
    expect(
      events.some((event) => event.type === 'status' && event.message.includes('verify')),
    ).toBe(false)
  })

  test('Read of pkg/foo/a.ts injects pkg/foo/AGENTS.md once', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-ql-agents-'))
    try {
      mkdirSync(join(cwd, 'pkg', 'foo'), { recursive: true })
      writeFileSync(join(cwd, 'AGENTS.md'), 'ROOT_SHOULD_NOT_INJECT\n')
      writeFileSync(join(cwd, 'pkg', 'foo', 'AGENTS.md'), 'PKG_FOO_AGENTS\n')
      writeFileSync(join(cwd, 'pkg', 'foo', 'a.ts'), 'export const a = 1\n')
      const store = createMemoryStore()
      const session = makeSession({ id: 'sess_subdir_agents', cwd })
      await store.createSession(session)
      const read = stubNamedTool('Read')
      const provider = createFakeProvider([
        toolThenStop('r1', 'Read', { path: 'pkg/foo/a.ts' }),
        toolThenStop('r2', 'Read', { path: 'pkg/foo/a.ts' }),
        textThenStop('done'),
      ])
      const engine = createSessionEngine(engineOpts({ provider, store, session, tools: [read] }))
      const { result } = await collect(engine.submitMessage('read it'))
      expect(result).toEqual({ reason: 'completed' })
      const loaded = await store.loadSession(session.id)
      const toolRows = loaded.messages.filter(
        (msg): msg is Extract<Message, { role: 'tool' }> => msg.role === 'tool',
      )
      expect(toolRows).toHaveLength(2)
      const first = toolRows[0]?.blocks[0]?.type === 'text' ? toolRows[0].blocks[0].text : ''
      const second = toolRows[1]?.blocks[0]?.type === 'text' ? toolRows[1].blocks[0].text : ''
      expect(first).toContain('[AGENTS.md: pkg/foo]')
      expect(first).toContain('PKG_FOO_AGENTS')
      expect(first).not.toContain('ROOT_SHOULD_NOT_INJECT')
      expect(second).not.toContain('[AGENTS.md:')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

function stubNamedTool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    parse(input: unknown) {
      return { ok: true as const, value: input }
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async checkPermissions() {
      return { behavior: 'allow' as const, reason: 'mode' as const }
    },
    async execute() {
      return name
    },
  }
}
