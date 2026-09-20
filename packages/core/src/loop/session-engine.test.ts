import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../session/memory-store'
import type {
  CompactPolicy,
  Message,
  ModelProfile,
  Provider,
  ProviderChunk,
  ProviderRequest,
  SessionRecord,
  StreamEvent,
  SystemPart,
  Tool,
} from '../types'
import { memoryTool } from '../tools/memory'
import { enterSessionWorktree, exitSessionWorktree } from '../tools/session-worktree'
import { todoJsonPath } from '../tools/todo'
import { createSessionEngine } from './session-engine'
import { ABORTED_TEXT } from './pairing'
import { drainAgentMail, enqueueAgentMail } from '../tasks/mailbox'
import { applyPermissionMode, buildSystemParts } from '../prompt/builder'

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

function createAskEcho(): Tool<{ text: string }, string> {
  return {
    name: 'Echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    parse(input: unknown) {
      if (!input || typeof input !== 'object' || typeof (input as { text?: unknown }).text !== 'string') {
        return { ok: false as const, message: 'expected { text: string }' }
      }
      return { ok: true as const, value: { text: (input as { text: string }).text } }
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async checkPermissions() {
      return { behavior: 'ask' as const, message: 'Echo?' }
    },
    async execute(input: { text: string }) {
      return input.text
    },
  }
}

function toolThenStop(id: string, name: string, input: unknown): ProviderChunk[] {
  return [
    { type: 'tool_call', id, name, input },
    { type: 'stop', reason: 'tool_use' },
  ]
}

async function consumeUntilAsk(
  gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>,
): Promise<void> {
  while (true) {
    const next = await gen.next()
    if (next.done) throw new Error('ended before permission_ask')
    if (next.value.type === 'permission_ask') return
  }
}

function hangAskUser(
  _event: unknown,
  signal: AbortSignal,
): Promise<'allow' | 'deny' | 'allow_always'> {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
  })
}

function engineOpts(over: {
  provider: Provider
  store: ReturnType<typeof createMemoryStore>
  session: SessionRecord
  tools?: Tool[]
}) {
  return {
    session: over.session,
    provider: over.provider,
    store: over.store,
    tools: over.tools ?? [],
    compact: defaultCompact({ enabled: false }),
    model: defaultModel(),
    maxRounds: 8,
    async askUser() {
      return 'deny' as const
    },
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

describe('setModel', () => {
  test('next submit uses the new id and reserve', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_set_model', model: 'dummy' })
    await store.createSession(sess)
    const seen: ProviderRequest[] = []
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const orig = provider.stream.bind(provider)
    provider.stream = async function* (req, signal) {
      seen.push(req)
      yield* orig(req, signal)
    }
    const engine = await createSessionEngine({
      session: sess,
      provider,
      store,
      tools: [],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 8,
      async askUser() {
        return 'deny'
      },
    })
    await engine.setModel({
      id: 'claude-sonnet-5',
      contextWindow: 1_000_000,
      reserveOutputTokens: 20_000,
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cacheReadUsdPerMTok: 0.2,
      cacheWriteUsdPerMTok: 2.5,
      supportsThinking: true,
    })
    expect(engine.session.model).toBe('claude-sonnet-5')
    const loaded = await store.loadSession(sess.id)
    expect(loaded.session.model).toBe('claude-sonnet-5')

    const gen = engine.submitMessage('hi')
    while (true) {
      const next = await gen.next()
      if (next.done) break
    }
    expect(seen[0]?.model).toBe('claude-sonnet-5')
    expect(seen[0]?.maxTokens).toBe(20_000)
  })
})

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

    const engine = await createSessionEngine({
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

    const engine = await createSessionEngine({
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

    const engine = await createSessionEngine({
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

  test('compactNow during submitMessage does not rewrite messages until the turn ends', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_c' })
    await store.createSession(session)
    const history = [
      user('u0', 'old question', 1),
      asst('a0', 'old reply', 2),
      user('u1', 'recent', 3),
      asst('a1', 'recent reply', 4),
    ]
    await persistAll(store, session.id, history)

    let compactCalls = 0
    const orig = store.recordCompact.bind(store)
    store.recordCompact = async (sessionId, generation, summary, inactivatedIds) => {
      compactCalls += 1
      return orig(sessionId, generation, summary, inactivatedIds)
    }

    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'hi' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const engine = await createSessionEngine({
      ...engineOpts({ provider, store, session }),
      messages: history,
      compact: defaultCompact({ protectLastMessages: 2, llmSummarize: false }),
    })
    const gen = engine.submitMessage('hi')
    await gen.next()
    const before = (await store.loadSession(session.id)).messages.length
    expect(compactCalls).toBe(0)
    await engine.compactNow()
    const mid = (await store.loadSession(session.id)).messages.length
    expect(mid).toBe(before)
    expect(compactCalls).toBe(0)
    while (!(await gen.next()).done) {
      // drain
    }
    expect(compactCalls).toBe(1)
  })
})

describe('steering and image submit', () => {
  test('enqueueSteer suffixes the last tool row after a tool round', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_steer' })
    await store.createSession(sess)
    const engine = await createSessionEngine({
      session: sess,
      provider: createFakeProvider([
        [
          { type: 'tool_call', id: 'c1', name: 'Ping', input: {} },
          { type: 'stop', reason: 'tool' },
        ],
        [
          { type: 'text_delta', text: 'done' },
          { type: 'stop', reason: 'end' },
        ],
      ]),
      store,
      tools: [
        {
          name: 'Ping',
          description: 'ping',
          inputSchema: { type: 'object' },
          parse() {
            return { ok: true as const, value: {} }
          },
          isConcurrencySafe() {
            return true
          },
          isReadOnly() {
            return true
          },
          async checkPermissions() {
            return { behavior: 'allow' as const, reason: 'mode' as const }
          },
          async execute() {
            engine.enqueueSteer('keep going')
            return 'pong'
          },
        },
      ],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 8,
      async askUser() {
        return 'deny'
      },
    })

    const gen = engine.submitMessage('hi')
    while (!(await gen.next()).done) {
      // drain
    }
    const loaded = await store.loadSession(sess.id)
    const users = loaded.messages.filter((msg) => msg.role === 'user')
    expect(users.map((msg) => msg.blocks[0] && 'text' in msg.blocks[0] ? msg.blocks[0].text : '')).toEqual([
      'hi',
    ])
    const toolRow = loaded.messages.find(
      (msg): msg is Extract<Message, { role: 'tool' }> =>
        msg.role === 'tool' && msg.toolUseId === 'c1',
    )
    expect(toolRow?.blocks[0]?.text).toContain('pong')
    expect(toolRow?.blocks[0]?.text).toContain('keep going')
    expect(engine.drainSteering()).toEqual([])
  })

  test('drainQueued suffixes the last tool row once per tool batch', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_queue' })
    await store.createSession(sess)
    const queued = ['first queued', 'second queued']
    const engine = await createSessionEngine({
      session: sess,
      provider: createFakeProvider([
        [
          { type: 'tool_call', id: 'c1', name: 'Ping', input: {} },
          { type: 'stop', reason: 'tool' },
        ],
        [
          { type: 'text_delta', text: 'done' },
          { type: 'stop', reason: 'end' },
        ],
      ]),
      store,
      tools: [
        {
          name: 'Ping',
          description: 'ping',
          inputSchema: { type: 'object' },
          parse() {
            return { ok: true as const, value: {} }
          },
          isConcurrencySafe() {
            return true
          },
          isReadOnly() {
            return true
          },
          async checkPermissions() {
            return { behavior: 'allow' as const, reason: 'mode' as const }
          },
          async execute() {
            return 'pong'
          },
        },
      ],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 8,
      drainQueued: () => queued.shift(),
      async askUser() {
        return 'deny'
      },
    })

    const gen = engine.submitMessage('hi')
    const statuses: string[] = []
    while (true) {
      const next = await gen.next()
      if (next.done) break
      if (next.value.type === 'status') statuses.push(next.value.message)
    }
    const loaded = await store.loadSession(sess.id)
    const toolRow = loaded.messages.find(
      (msg): msg is Extract<Message, { role: 'tool' }> =>
        msg.role === 'tool' && msg.toolUseId === 'c1',
    )
    expect(toolRow?.blocks[0]?.text).toContain('pong')
    expect(toolRow?.blocks[0]?.text).toContain('first queued')
    expect(toolRow?.blocks[0]?.text).not.toContain('second queued')
    expect(queued).toEqual(['second queued'])
    expect(statuses.some((line) => line.startsWith('queued: first queued'))).toBe(true)
  })

  test('bindDrainQueued is used after a tool round; no-tool turns do not drain', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_queue_bind' })
    await store.createSession(sess)
    let drains = 0
    const queued = ['late']
    const engine = await createSessionEngine({
      session: sess,
      provider: createFakeProvider([
        [
          { type: 'text_delta', text: 'plain' },
          { type: 'stop', reason: 'end' },
        ],
        [
          { type: 'tool_call', id: 'c2', name: 'Ping', input: {} },
          { type: 'stop', reason: 'tool' },
        ],
        [
          { type: 'text_delta', text: 'done' },
          { type: 'stop', reason: 'end' },
        ],
      ]),
      store,
      tools: [
        {
          name: 'Ping',
          description: 'ping',
          inputSchema: { type: 'object' },
          parse() {
            return { ok: true as const, value: {} }
          },
          isConcurrencySafe() {
            return true
          },
          isReadOnly() {
            return true
          },
          async checkPermissions() {
            return { behavior: 'allow' as const, reason: 'mode' as const }
          },
          async execute() {
            return 'pong'
          },
        },
      ],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 8,
      async askUser() {
        return 'deny'
      },
    })

    const first = engine.submitMessage('no tools')
    while (!(await first.next()).done) {
      // drain
    }
    expect(drains).toBe(0)
    expect(queued).toEqual(['late'])

    engine.bindDrainQueued(() => {
      drains += 1
      return queued.shift()
    })
    const second = engine.submitMessage('with tools')
    while (!(await second.next()).done) {
      // drain
    }
    const loaded = await store.loadSession(sess.id)
    const toolRow = loaded.messages.find(
      (msg): msg is Extract<Message, { role: 'tool' }> =>
        msg.role === 'tool' && msg.toolUseId === 'c2',
    )
    expect(drains).toBe(1)
    expect(queued).toEqual([])
    expect(toolRow?.blocks[0]?.text).toContain('late')
  })

  test('submitMessage accepts image blocks', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_img' })
    await store.createSession(sess)
    const engine = await createSessionEngine({
      session: sess,
      provider: createFakeProvider([[{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }]]),
      store,
      tools: [],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 4,
      async askUser() {
        return 'deny'
      },
    })
    const gen = engine.submitMessage({
      text: 'see this',
      images: [{ mediaType: 'image/png', data: 'abc' }],
    })
    while (!(await gen.next()).done) {
      // drain
    }
    const loaded = await store.loadSession(sess.id)
    const first = loaded.messages[0]
    expect(first?.role).toBe('user')
    if (first?.role === 'user') {
      expect(first.blocks).toEqual([
        { type: 'text', text: 'see this' },
        { type: 'image', mediaType: 'image/png', data: 'abc' },
      ])
    }
  })

  test('submitMessage turnPolicy does not abort or enqueueSteer', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_policy' })
    await store.createSession(sess)
    const engine = await createSessionEngine({
      session: sess,
      provider: createFakeProvider([[{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }]]),
      store,
      tools: [],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 4,
      async askUser() {
        return 'deny'
      },
    })
    let abortCalls = 0
    const origAbort = engine.abort.bind(engine)
    engine.abort = () => {
      abortCalls += 1
      origAbort()
    }
    const events: StreamEvent[] = []
    const gen = engine.submitMessage({ text: 'hi', turnPolicy: 'steer' })
    let end: { reason: string } | undefined
    while (true) {
      const next = await gen.next()
      if (next.done) {
        end = next.value
        break
      }
      events.push(next.value)
    }
    expect(abortCalls).toBe(0)
    expect(engine.drainSteering()).toEqual([])
    expect(end?.reason).toBe('completed')
    const loaded = await store.loadSession(sess.id)
    const first = loaded.messages[0]
    expect(first?.role).toBe('user')
    if (first?.role === 'user') {
      expect(first.blocks).toEqual([{ type: 'text', text: 'hi' }])
    }
  })
})

describe('agent mailbox drain', () => {
  test('submitMessage prepends drained mailbox notices to the user text', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_mailbox' })
    await store.createSession(sess)
    await enqueueAgentMail(store, sess.id, 'subagent finished (b_abc):\ndone-a')
    await enqueueAgentMail(store, sess.id, 'subagent finished (b_def):\ndone-b')
    const engine = await createSessionEngine({
      session: sess,
      provider: createFakeProvider([
        [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
      ]),
      store,
      tools: [],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 4,
      async askUser() {
        return 'deny'
      },
    })
    const gen = engine.submitMessage('hello')
    while (!(await gen.next()).done) {
      // drain
    }
    const loaded = await store.loadSession(sess.id)
    const first = loaded.messages[0]
    expect(first?.role).toBe('user')
    if (first?.role === 'user') {
      const text = first.blocks[0] && first.blocks[0].type === 'text' ? first.blocks[0].text : ''
      expect(text).toBe(
        '[mailbox]\nsubagent finished (b_abc):\ndone-a\n\nsubagent finished (b_def):\ndone-b\n\nhello',
      )
    }
    expect(await drainAgentMail(store, sess.id)).toEqual([])
  })

  test('re-enqueues mailbox notices when persistUser fails', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_mail_fail' })
    await store.createSession(sess)
    await enqueueAgentMail(store, sess.id, 'keep-me')
    const orig = store.persistUser.bind(store)
    store.persistUser = async () => {
      throw new Error('disk full')
    }
    const engine = await createSessionEngine({
      session: sess,
      provider: createFakeProvider([]),
      store,
      tools: [],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 4,
      async askUser() {
        return 'deny'
      },
    })
    const gen = engine.submitMessage('hello')
    await expect(gen.next()).rejects.toThrow('disk full')
    store.persistUser = orig
    expect(await drainAgentMail(store, sess.id)).toEqual(['keep-me'])
  })
})

describe('lifecycle Stop / SessionEnd / PreToolUse', () => {
  const tempDirs: string[] = []

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  function writeHooks(dir: string, body: unknown): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'hooks.json'), `${JSON.stringify(body)}\n`, 'utf8')
  }

  async function drain(gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>) {
    const events: StreamEvent[] = []
    while (true) {
      const next = await gen.next()
      if (next.done) return { events, result: next.value }
      events.push(next.value)
    }
  }

  test('Stop fires on completed', async () => {
    const home = tempDir('ravenclaw-stop-home-')
    const cwd = tempDir('ravenclaw-stop-cwd-')
    const saved = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    try {
      writeHooks(home, {
        Stop: [{ command: `printf '%s' '{"message":"stop-ok"}'` }],
      })
      const store = createMemoryStore()
      const sess = makeSession({ id: 'sess_stop', cwd })
      await store.createSession(sess)
      const engine = await createSessionEngine({
        session: sess,
        provider: createFakeProvider([
          [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
          [{ type: 'text_delta', text: 'ok2' }, { type: 'stop', reason: 'end' }],
        ]),
        store,
        tools: [],
        compact: defaultCompact({ enabled: false }),
        model: defaultModel(),
        maxRounds: 4,
        async askUser() {
          return 'deny'
        },
      })
      const { result, events } = await drain(engine.submitMessage('hi'))
      expect(result).toEqual({ reason: 'completed' })
      expect(events.some((event) => event.type === 'status' && event.message === 'stop hook; continuing')).toBe(
        true,
      )
    } finally {
      if (saved === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = saved
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop()
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  test('Stop preventContinuation returns hook_stopped without another API call', async () => {
    const home = tempDir('ravenclaw-stop-prevent-home-')
    const cwd = tempDir('ravenclaw-stop-prevent-cwd-')
    const saved = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    try {
      writeHooks(home, {
        Stop: [
          {
            command: `printf '%s' '{"preventContinuation":true,"message":"halt"}'`,
          },
        ],
      })
      const store = createMemoryStore()
      const sess = makeSession({ id: 'sess_stop_prevent', cwd })
      await store.createSession(sess)
      const provider = createFakeProvider([
        [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
        [{ type: 'text_delta', text: 'should-not-run' }, { type: 'stop', reason: 'end' }],
      ])
      const engine = await createSessionEngine({
        session: sess,
        provider,
        store,
        tools: [],
        compact: defaultCompact({ enabled: false }),
        model: defaultModel(),
        maxRounds: 4,
        async askUser() {
          return 'deny'
        },
      })
      const { result, events } = await drain(engine.submitMessage('hi'))
      expect(result).toEqual({ reason: 'hook_stopped' })
      expect(provider.streamCount).toBe(1)
      expect(events.some((event) => event.type === 'status' && event.message === 'halt')).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = saved
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop()
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  test('Stop is skipped on aborted', async () => {
    const home = tempDir('ravenclaw-stop-abort-home-')
    const cwd = tempDir('ravenclaw-stop-abort-cwd-')
    const saved = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    const marker = join(home, 'stop-abort.txt')
    try {
      writeHooks(home, {
        Stop: [{ command: `printf '%s' '{"message":"stop-ran"}' >> "${marker}"` }],
      })
      const store = createMemoryStore()
      const sess = makeSession({ id: 'sess_stop_abort', cwd })
      await store.createSession(sess)
      const provider: Provider = {
        id: 'fake',
        apiMode: 'openai_compat',
        profile(model: string) {
          return defaultModel(model)
        },
        async *stream(_req, signal) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        },
      }
      const engine = await createSessionEngine({
        session: sess,
        provider,
        store,
        tools: [],
        compact: defaultCompact({ enabled: false }),
        model: defaultModel(),
        maxRounds: 4,
        async askUser() {
          return 'deny'
        },
      })
      const gen = engine.submitMessage('hi')
      const first = await gen.next()
      expect(first.done).toBe(false)
      engine.abort()
      const { result } = await drain(gen)
      expect(result).toEqual({ reason: 'aborted' })
      expect(existsSync(marker)).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = saved
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop()
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  test('SessionEnd fires once on close', async () => {
    const home = tempDir('ravenclaw-end-home-')
    const cwd = tempDir('ravenclaw-end-cwd-')
    const saved = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    const marker = join(home, 'session-end.txt')
    try {
      writeHooks(home, {
        SessionEnd: [{ command: `printf '%s' '{"message":"ended"}' >> "${marker}"` }],
      })
      const store = createMemoryStore()
      const sess = makeSession({ id: 'sess_end', cwd })
      await store.createSession(sess)
      const engine = await createSessionEngine({
        session: sess,
        provider: createFakeProvider([]),
        store,
        tools: [],
        compact: defaultCompact({ enabled: false }),
        model: defaultModel(),
        maxRounds: 4,
        async askUser() {
          return 'deny'
        },
      })
      await engine.close()
      await engine.close()
      expect(readFileSync(marker, 'utf8')).toBe('{"message":"ended"}')
    } finally {
      if (saved === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = saved
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop()
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  test('close({ releaseLock: false }) keeps the session lock', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_keep_lock' })
    await store.createSession(sess)
    await store.acquireSessionLock(sess.id, { holderId: 'h1', holderName: 'tui' })
    const engine = await createSessionEngine({
      session: sess,
      provider: createFakeProvider([]),
      store,
      tools: [],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 4,
      sessionLock: { holderId: 'h1' },
      async askUser() {
        return 'deny'
      },
    })
    await engine.close({ releaseLock: false })
    await store.renewSessionLock(sess.id, 'h1')
    await store.releaseSessionLock(sess.id, 'h1')
  })

  test('PreToolUse updatedInput reaches execute', async () => {
    const home = tempDir('ravenclaw-pre-home-')
    const cwd = tempDir('ravenclaw-pre-cwd-')
    const saved = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    try {
      writeHooks(home, {
        PreToolUse: [{ command: `printf '%s' '{"updatedInput":{"text":"rewritten"}}'` }],
      })
      const store = createMemoryStore()
      const sess = makeSession({ id: 'sess_pre', cwd })
      await store.createSession(sess)
      const seen: string[] = []
      const echo: Tool<{ text: string }, string> = {
        name: 'Echo',
        description: 'echo',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        parse(input: unknown) {
          if (!input || typeof input !== 'object' || typeof (input as { text?: unknown }).text !== 'string') {
            return { ok: false as const, message: 'bad' }
          }
          return { ok: true as const, value: { text: (input as { text: string }).text } }
        },
        isConcurrencySafe: () => true,
        isReadOnly: () => true,
        async checkPermissions() {
          return { behavior: 'allow' as const, reason: 'mode' as const }
        },
        async execute(input) {
          seen.push(input.text)
          return input.text
        },
      }
      const engine = await createSessionEngine({
        session: sess,
        provider: createFakeProvider([
          [
            { type: 'tool_call', id: 'c1', name: 'Echo', input: { text: 'orig' } },
            { type: 'stop', reason: 'tool' },
          ],
          [{ type: 'text_delta', text: 'done' }, { type: 'stop', reason: 'end' }],
        ]),
        store,
        tools: [echo],
        compact: defaultCompact({ enabled: false }),
        model: defaultModel(),
        maxRounds: 4,
        async askUser() {
          return 'deny'
        },
      })
      const { result } = await drain(engine.submitMessage('echo'))
      expect(result).toEqual({ reason: 'completed' })
      expect(seen).toEqual(['rewritten'])
    } finally {
      if (saved === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = saved
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop()
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  test('PreToolUse updatedInput is re-checked by decidePermission before execute', async () => {
    const home = tempDir('ravenclaw-pre-deny-home-')
    const cwd = tempDir('ravenclaw-pre-deny-cwd-')
    const saved = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    try {
      writeHooks(home, {
        PreToolUse: [
          { command: `printf '%s' '{"updatedInput":{"path":".git/hooks/pre-commit","content":"x"}}'` },
        ],
      })
      const store = createMemoryStore()
      const sess = makeSession({ id: 'sess_pre_deny', cwd })
      await store.createSession(sess)
      const seen: string[] = []
      const write: Tool<{ path: string; content: string }, string> = {
        name: 'Write',
        description: 'write',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
        parse(input: unknown) {
          if (!input || typeof input !== 'object') return { ok: false as const, message: 'bad' }
          const rec = input as { path?: unknown; content?: unknown }
          if (typeof rec.path !== 'string' || typeof rec.content !== 'string') {
            return { ok: false as const, message: 'bad' }
          }
          return { ok: true as const, value: { path: rec.path, content: rec.content } }
        },
        isConcurrencySafe: () => false,
        isReadOnly: () => false,
        async checkPermissions() {
          return { behavior: 'ask' as const, message: 'Write?' }
        },
        async execute(input) {
          seen.push(input.path)
          return input.path
        },
      }
      const engine = await createSessionEngine({
        session: sess,
        provider: createFakeProvider([
          [
            { type: 'tool_call', id: 'c1', name: 'Write', input: { path: 'ok.txt', content: 'safe' } },
            { type: 'stop', reason: 'tool' },
          ],
          [{ type: 'text_delta', text: 'done' }, { type: 'stop', reason: 'end' }],
        ]),
        store,
        tools: [write],
        compact: defaultCompact({ enabled: false }),
        model: defaultModel(),
        maxRounds: 4,
        async askUser() {
          return 'allow'
        },
      })
      const { result } = await drain(engine.submitMessage('write'))
      expect(result).toEqual({ reason: 'completed' })
      expect(seen).toEqual([])
      const loaded = await store.loadSession(sess.id)
      const tool = loaded.messages.find((msg) => msg.role === 'tool')
      expect(tool && tool.role === 'tool' ? tool.ok : undefined).toBe(false)
      const deny = tool && tool.role === 'tool' ? tool.blocks[0] : undefined
      expect(deny && deny.type === 'text' ? deny.text : '').toContain('.git/')
    } finally {
      if (saved === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = saved
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop()
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  test('SessionStart awaits once on first submitMessage before UserPromptSubmit', async () => {
    const home = tempDir('ravenclaw-start-home-')
    const cwd = tempDir('ravenclaw-start-cwd-')
    const saved = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    const marker = join(home, 'session-start.txt')
    try {
      writeHooks(home, {
        SessionStart: [{ command: `printf '%s\\n' 'start' >> "${marker}"` }],
        UserPromptSubmit: [{ command: `printf '%s\\n' 'prompt' >> "${marker}"` }],
      })
      const store = createMemoryStore()
      const sess = makeSession({ id: 'sess_start', cwd })
      await store.createSession(sess)
      const engine = await createSessionEngine({
        session: sess,
        provider: createFakeProvider([
          [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
          [{ type: 'text_delta', text: 'ok2' }, { type: 'stop', reason: 'end' }],
        ]),
        store,
        tools: [],
        compact: defaultCompact({ enabled: false }),
        model: defaultModel(),
        maxRounds: 4,
        async askUser() {
          return 'deny'
        },
      })
      expect(() => readFileSync(marker, 'utf8')).toThrow()
      await drain(engine.submitMessage('hi'))
      expect(readFileSync(marker, 'utf8')).toBe('start\nprompt\n')
      await drain(engine.submitMessage('again'))
      expect(readFileSync(marker, 'utf8')).toBe('start\nprompt\nprompt\n')
    } finally {
      if (saved === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = saved
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop()
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})

describe('setPermissionMode volatile rewrite', () => {
  test('next submitMessage sees dontAsk in volatile and unchanged stable', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_mode_volatile' })
    await store.createSession(sess)
    const captured: ProviderRequest[] = []
    const provider: Provider = {
      id: 'fake',
      apiMode: 'openai_compat',
      profile(model: string) {
        return defaultModel(model)
      },
      async *stream(req: ProviderRequest) {
        captured.push(req)
        yield { type: 'text_delta' as const, text: 'ok' }
        yield { type: 'stop' as const, reason: 'end' }
      },
    }
    const system = buildSystemParts({
      cwd: '/workspace/demo',
      permissionMode: 'default',
      projectFilesText: '',
      git: null,
      skills: [],
    })
    const stableBefore = system[0]?.text
    const engine = await createSessionEngine({
      session: sess,
      provider,
      store,
      tools: [],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 4,
      system,
      async askUser() {
        return 'deny'
      },
    })
    await engine.setPermissionMode('dontAsk')
    const events: StreamEvent[] = []
    const gen = engine.submitMessage('hi')
    while (true) {
      const next = await gen.next()
      if (next.done) break
      events.push(next.value)
    }
    expect(captured).toHaveLength(1)
    const req = captured[0]
    const stable = req?.system.find((part) => part.tier === 'stable')
    const volatile = req?.system.find((part) => part.tier === 'volatile')
    expect(stable?.text).toBe(stableBefore)
    expect(stable?.text).not.toContain('Current permission mode:')
    expect(volatile?.text).toContain('Current permission mode: dontAsk')
    expect(volatile?.text).not.toContain('Current permission mode: default')
    expect(applyPermissionMode(system, 'plan')[2]?.text).toContain('Current permission mode: plan')
  })
})

async function drain(engine: Awaited<ReturnType<typeof createSessionEngine>>, text: string): Promise<void> {
  const gen = engine.submitMessage(text)
  while (true) {
    const next = await gen.next()
    if (next.done) return
  }
}

function stubTool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    parse() {
      return { ok: true as const, value: {} }
    },
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return true
    },
    async checkPermissions() {
      return { behavior: 'allow' as const, reason: 'mode' as const }
    },
    async execute() {
      return name
    },
  }
}

describe('background review and nudges', () => {
  test('injects consider Memory on the 10th user turn', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_mem_nudge' })
    await store.createSession(sess)
    const requests: ProviderRequest[] = []
    const provider: Provider = {
      id: 'fake',
      apiMode: 'openai_compat',
      profile: () => defaultModel(),
      async *stream(req) {
        requests.push(req)
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'stop', reason: 'end' }
      },
    }
    const engine = await createSessionEngine({
      session: sess,
      provider,
      store,
      tools: [],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 4,
      async askUser() {
        return 'deny'
      },
    })
    for (let i = 0; i < 10; i++) await drain(engine, `turn ${i}`)
    const last = requests[9]
    const blob = JSON.stringify(last?.messages ?? [])
    expect(blob).toContain('consider Memory')
    expect(JSON.stringify(requests[8]?.messages ?? [])).not.toContain('consider Memory')
  })

  test('forks a persist-detached review with the parent system hash and review tools only', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_bg_review' })
    await store.createSession(sess)
    const system: SystemPart[] = [{ tier: 'stable', text: 'PARENT SYSTEM', cacheBreakpoint: true }]
    let releaseChild!: () => void
    const childStarted = new Promise<void>((resolve) => {
      releaseChild = resolve
    })
    const requests: ProviderRequest[] = []
    const provider: Provider = {
      id: 'fake',
      apiMode: 'openai_compat',
      profile: () => defaultModel(),
      async *stream(req) {
        requests.push(req)
        if (requests.length === 2) releaseChild()
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'stop', reason: 'end' }
      },
    }
    const engine = await createSessionEngine({
      session: sess,
      provider,
      store,
      tools: [stubTool('Read'), stubTool('Grep'), stubTool('Memory'), stubTool('Skill'), stubTool('Bash')],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 4,
      system,
      backgroundReview: true,
      async askUser() {
        return 'deny'
      },
    })
    await drain(engine, 'done')
    await childStarted
    expect(requests.length).toBeGreaterThanOrEqual(2)
    const parent = requests[0]
    const child = requests[1]
    expect(parent?.system).toEqual(system)
    expect(child?.system).toEqual(system)
    expect(child?.tools.map((tool) => tool.name).sort()).toEqual(['Grep', 'Memory', 'Read', 'Skill'])
    expect(child?.tools.map((tool) => tool.name)).not.toContain('Bash')
    const loaded = await store.loadSession(sess.id)
    expect(loaded.messages.some((msg) => JSON.stringify(msg).includes('durable lesson'))).toBe(false)
  })

  test('does not fork included sessions even when backgroundReview is on', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_included', funding: 'included' })
    await store.createSession(sess)
    let streams = 0
    const provider: Provider = {
      id: 'fake',
      apiMode: 'openai_compat',
      profile: () => defaultModel(),
      async *stream() {
        streams += 1
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'stop', reason: 'end' }
      },
    }
    const engine = await createSessionEngine({
      session: sess,
      provider,
      store,
      tools: [stubTool('Memory')],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 4,
      backgroundReview: true,
      async askUser() {
        return 'deny'
      },
    })
    await drain(engine, 'hi')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(streams).toBe(1)
  })

  test('detached review writes Memory when parent permission mode is default', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-bg-memory-'))
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_bg_memory', cwd, permissionMode: 'default' })
    await store.createSession(sess)
    let childDone!: () => void
    const childFinished = new Promise<void>((resolve) => {
      childDone = resolve
    })
    let streams = 0
    const provider: Provider = {
      id: 'fake',
      apiMode: 'openai_compat',
      profile: () => defaultModel(),
      async *stream(req) {
        streams += 1
        if (streams === 1) {
          yield { type: 'text_delta', text: 'ok' }
          yield { type: 'stop', reason: 'end' }
          return
        }
        const awaitingTool = req.messages.some((msg) => msg.role === 'tool')
        if (!awaitingTool) {
          yield {
            type: 'tool_call',
            id: 'mem1',
            name: 'Memory',
            input: { action: 'add', target: 'agent', text: 'use bun test' },
          }
          yield { type: 'stop', reason: 'tool' }
          return
        }
        yield { type: 'text_delta', text: 'saved' }
        yield { type: 'stop', reason: 'end' }
        childDone()
      },
    }
    const engine = await createSessionEngine({
      session: sess,
      provider,
      store,
      tools: [memoryTool],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 4,
      backgroundReview: true,
      async askUser() {
        return 'deny'
      },
    })
    try {
      await drain(engine, 'done')
      await childFinished
      expect(readFileSync(join(cwd, '.ravenclaw', 'MEMORY.md'), 'utf8')).toContain('use bun test')
      expect(sess.permissionMode).toBe('default')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('replayPendingAsks', () => {
  test('resume with a pending row replays permission_ask without submitMessage', async () => {
    const asks: string[] = []
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_tui' })
    await store.createSession(session)
    await store.upsertPendingAsk({
      callId: 'call_1',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Run ls?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([]),
        store,
        session,
      }),
      askUser: async (event) => {
        asks.push(event.id)
        return 'deny'
      },
    })
    const events: StreamEvent[] = []
    for await (const ev of engine.replayPendingAsks()) events.push(ev)
    expect(asks).toEqual(['call_1'])
    expect(events.some((e) => e.type === 'permission_ask' && e.id === 'call_1')).toBe(true)
    expect(await store.listPendingAsks(session.id)).toHaveLength(0)
  })

  test('replayPendingAsks on a child session sets childSessionId', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_child', parentSessionId: 'sess_parent' })
    await store.createSession(makeSession({ id: 'sess_parent' }))
    await store.createSession(session)
    await store.upsertPendingAsk({
      callId: 'call_child',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Run ls?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([]),
        store,
        session,
      }),
      askUser: async () => 'deny',
    })
    const events: StreamEvent[] = []
    for await (const ev of engine.replayPendingAsks()) events.push(ev)
    const ask = events.find((e) => e.type === 'permission_ask')
    expect(ask && ask.type === 'permission_ask' ? ask.childSessionId : undefined).toBe('sess_child')
  })

  test('parent replayPendingAsks yields child leftover-asks with childSessionId', async () => {
    const store = createMemoryStore()
    const parent = makeSession({ id: 'sess_parent' })
    const child = makeSession({ id: 'sess_child', parentSessionId: 'sess_parent' })
    await store.createSession(parent)
    await store.createSession(child)
    await store.upsertPendingAsk({
      callId: 'call_child',
      sessionId: child.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Run ls?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    const seen: string[] = []
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([]),
        store,
        session: parent,
      }),
      askUser: async (event) => {
        seen.push(event.childSessionId ?? '')
        return 'deny'
      },
    })
    const events: StreamEvent[] = []
    for await (const ev of engine.replayPendingAsks()) events.push(ev)
    expect(seen).toEqual(['sess_child'])
    const ask = events.find((e) => e.type === 'permission_ask')
    expect(ask && ask.type === 'permission_ask' ? ask.id : undefined).toBe('call_child')
    expect(await store.listPendingAsks(child.id)).toHaveLength(0)
  })
})

describe('job auto-commit', () => {
  const tempDirs: string[] = []
  const sessionIds: string[] = []
  let seq = 0

  afterEach(() => {
    while (sessionIds.length > 0) {
      const id = sessionIds.pop()
      if (id) exitSessionWorktree(id, 'remove', true)
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  function nextSession(): string {
    const id = `sess_jobac_${Date.now()}_${seq++}`
    sessionIds.push(id)
    return id
  }

  function initGitRepo(dir: string): void {
    const run = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
      expect(result.status).toBe(0)
    }
    run(['init'])
    run(['config', 'user.email', 'test@example.com'])
    run(['config', 'user.name', 'Test'])
    run(['config', 'commit.gpgsign', 'false'])
    run(['commit', '--allow-empty', '-m', 'init'])
  }

  function git(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(result.status).toBe(0)
    return result.stdout.trim()
  }

  async function drain(gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>) {
    const events: StreamEvent[] = []
    while (true) {
      const next = await gen.next()
      if (next.done) return { events, result: next.value }
      events.push(next.value)
    }
  }

  async function startJobSession(over: { jobAutoCommit?: boolean }) {
    const cwd = tempDir('ravenclaw-jobac-')
    initGitRepo(cwd)
    const id = nextSession()
    const entered = enterSessionWorktree(id, cwd)
    expect(entered.ok).toBe(true)
    expect(entered.job).toBeDefined()
    const job = entered.job!
    writeFileSync(join(job.worktreePath, 'note.txt'), 'dirty\n')
    const store = createMemoryStore()
    const sess = makeSession({
      id,
      cwd: job.worktreePath,
      job,
      ...(over.jobAutoCommit === true ? { jobAutoCommit: true } : {}),
    })
    await store.createSession(sess)
    return { store, sess, job, head: git(job.worktreePath, ['rev-parse', 'HEAD']) }
  }

  test('submitMessage with jobAutoCommit does not commit on abort', async () => {
    const { store, sess, job, head } = await startJobSession({ jobAutoCommit: true })
    const provider: Provider = {
      id: 'fake',
      apiMode: 'openai_compat',
      profile(model: string) {
        return defaultModel(model)
      },
      async *stream(_req, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }
    const engine = await createSessionEngine({
      ...engineOpts({ provider, store, session: sess }),
    })
    const gen = engine.submitMessage('hi')
    const first = await gen.next()
    expect(first.done).toBe(false)
    engine.abort()
    const { result } = await drain(gen)
    expect(result).toEqual({ reason: 'aborted' })
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(head)
    expect(git(job.worktreePath, ['status', '--porcelain'])).toContain('note.txt')
  })

  test('submitMessage with jobAutoCommit commits a dirty tree on completed', async () => {
    const { store, sess, job, head } = await startJobSession({ jobAutoCommit: true })
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([[{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }]]),
        store,
        session: sess,
      }),
    })
    const { result } = await drain(engine.submitMessage('hi'))
    expect(result).toEqual({ reason: 'completed' })
    const after = git(job.worktreePath, ['rev-parse', 'HEAD'])
    expect(after).not.toBe(head)
    expect(git(job.worktreePath, ['log', '-1', '--pretty=%s'])).toMatch(/^raven: turn /)
    expect(git(job.worktreePath, ['status', '--porcelain'])).toBe('')
  })

  test('submitMessage does not commit when jobAutoCommit is off', async () => {
    const { store, sess, job, head } = await startJobSession({})
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([[{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }]]),
        store,
        session: sess,
      }),
    })
    const { result } = await drain(engine.submitMessage('hi'))
    expect(result).toEqual({ reason: 'completed' })
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(head)
    expect(git(job.worktreePath, ['status', '--porcelain'])).toContain('note.txt')
  })

  test('jobAutoCommit failure sets session.jobError; completed success clears it', async () => {
    const store = createMemoryStore()
    const bad = makeSession({
      id: 'sess_job_err_commit',
      job: {
        baseBranch: 'main',
        shadowBranch: 'raven/x',
        baseCommitSha: 'abc',
        worktreePath: '',
      },
      jobAutoCommit: true,
      jobError: 'stale',
    })
    await store.createSession(bad)
    const failEngine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([
          [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
        ]),
        store,
        session: bad,
      }),
    })
    const failed = await drain(failEngine.submitMessage('hi'))
    expect(failed.result).toEqual({ reason: 'completed' })
    expect(failEngine.session.lastEnd).toEqual({ reason: 'completed' })
    expect(failEngine.session.jobError).toBe('job commit failed: no worktree')
    const loadedFail = await store.loadSession(bad.id)
    expect(loadedFail.session.jobError).toBe('job commit failed: no worktree')

    const { store: okStore, sess, job } = await startJobSession({ jobAutoCommit: true })
    sess.jobError = 'prior'
    await okStore.upsertSession(sess)
    const okEngine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([
          [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
        ]),
        store: okStore,
        session: sess,
      }),
    })
    writeFileSync(join(job.worktreePath, 'extra.txt'), 'x\n')
    const ok = await drain(okEngine.submitMessage('hi'))
    expect(ok.result).toEqual({ reason: 'completed' })
    expect(okEngine.session.jobError).toBeUndefined()
    const loadedOk = await okStore.loadSession(sess.id)
    expect(loadedOk.session.jobError).toBeUndefined()
  })

  test('createSessionEngine finishes a pending rewind reset; submit is then a no-op on the flag', async () => {
    const cwd = tempDir('ravenclaw-job-finish-construct-')
    initGitRepo(cwd)
    const id = nextSession()
    const entered = enterSessionWorktree(id, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    writeFileSync(join(job.worktreePath, 'extra.txt'), 'later\n')
    expect(spawnSync('git', ['add', '-A'], { cwd: job.worktreePath, encoding: 'utf8' }).status).toBe(0)
    expect(
      spawnSync('git', ['commit', '-m', 'later'], { cwd: job.worktreePath, encoding: 'utf8' }).status,
    ).toBe(0)
    const later = git(job.worktreePath, ['rev-parse', 'HEAD'])
    expect(later).not.toBe(job.baseCommitSha)
    job.pendingResetSha = job.baseCommitSha
    const store = createMemoryStore()
    const sess = makeSession({ id, cwd: job.worktreePath, job })
    await store.createSession(sess)
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([
          [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
        ]),
        store,
        session: sess,
      }),
    })
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(job.baseCommitSha)
    expect(engine.session.job?.pendingResetSha).toBeUndefined()
    await drain(engine.submitMessage('hi'))
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(job.baseCommitSha)
    expect(engine.session.job?.pendingResetSha).toBeUndefined()
  })

  test('createSessionEngine reset-fail does not throw and keeps the flag', async () => {
    const cwd = tempDir('ravenclaw-job-construct-reset-fail-')
    initGitRepo(cwd)
    const id = nextSession()
    const entered = enterSessionWorktree(id, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    job.pendingResetSha = 'not-a-real-commit-sha'
    const store = createMemoryStore()
    const sess = makeSession({ id, cwd: job.worktreePath, job })
    await store.createSession(sess)
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([
          [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
        ]),
        store,
        session: sess,
      }),
    })
    expect(engine.session.job?.pendingResetSha).toBe('not-a-real-commit-sha')
    expect(engine.session.jobError?.startsWith('rewind reset failed:')).toBe(true)
  })

  test('rewindLast finishes a pending reset and does not drop another turn', async () => {
    const cwd = tempDir('ravenclaw-job-finish-rewind-')
    initGitRepo(cwd)
    const id = nextSession()
    const entered = enterSessionWorktree(id, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    writeFileSync(join(job.worktreePath, 'extra.txt'), 'later\n')
    expect(spawnSync('git', ['add', '-A'], { cwd: job.worktreePath, encoding: 'utf8' }).status).toBe(0)
    expect(
      spawnSync('git', ['commit', '-m', 'later'], { cwd: job.worktreePath, encoding: 'utf8' }).status,
    ).toBe(0)
    const later = git(job.worktreePath, ['rev-parse', 'HEAD'])
    expect(later).not.toBe(job.baseCommitSha)
    const store = createMemoryStore()
    const sess = makeSession({
      id,
      cwd: job.worktreePath,
      job,
    })
    await store.createSession(sess)
    const messages: Message[] = [user('u0', 'first', 1), asst('a0', 'ok', 2)]
    await persistAll(store, id, messages)
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([
          [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
        ]),
        store,
        session: sess,
      }),
      messages,
    })
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(later)
    engine.session.job = { ...engine.session.job!, pendingResetSha: job.baseCommitSha }
    await store.upsertSession(engine.session)
    const result = await engine.rewindLast()
    expect(result.ok).toBe(true)
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(job.baseCommitSha)
    expect(engine.session.job?.pendingResetSha).toBeUndefined()
    const loaded = await store.loadSession(id)
    expect(loaded.messages.map((msg) => msg.id)).toEqual(['u0', 'a0'])
  })

  test('rewindLast reset-fail returns droppedText so /retry can restore it', async () => {
    const cwd = tempDir('ravenclaw-job-rewind-droptext-')
    initGitRepo(cwd)
    const id = nextSession()
    const entered = enterSessionWorktree(id, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    job.baseCommitSha = 'not-a-real-commit-sha'
    const store = createMemoryStore()
    const sess = makeSession({
      id,
      cwd: job.worktreePath,
      job,
    })
    await store.createSession(sess)
    const messages: Message[] = [user('u1', 'keep this prompt', 1), asst('a1', 'ok', 2)]
    await persistAll(store, id, messages)
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([
          [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: 'end' }],
        ]),
        store,
        session: sess,
      }),
      messages,
    })
    const result = await engine.rewindLast()
    expect(result.ok).toBe(false)
    expect(result.notice.startsWith('rewind reset failed:')).toBe(true)
    expect(result.droppedText).toBe('keep this prompt')
  })

  test('maybeFinishRewindReset no-ops under a live turn; rewindLast refuses', async () => {
    const cwd = tempDir('ravenclaw-job-finish-live-')
    initGitRepo(cwd)
    const id = nextSession()
    const entered = enterSessionWorktree(id, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    writeFileSync(join(job.worktreePath, 'extra.txt'), 'later\n')
    expect(spawnSync('git', ['add', '-A'], { cwd: job.worktreePath, encoding: 'utf8' }).status).toBe(0)
    expect(
      spawnSync('git', ['commit', '-m', 'later'], { cwd: job.worktreePath, encoding: 'utf8' }).status,
    ).toBe(0)
    const later = git(job.worktreePath, ['rev-parse', 'HEAD'])
    expect(later).not.toBe(job.baseCommitSha)
    const store = createMemoryStore()
    const sess = makeSession({
      id,
      cwd: job.worktreePath,
      job,
    })
    await store.createSession(sess)
    let enteredStream: () => void
    const streamEntered = new Promise<void>((resolve) => {
      enteredStream = resolve
    })
    const provider: Provider = {
      id: 'fake',
      apiMode: 'openai_compat',
      profile(model: string) {
        return defaultModel(model)
      },
      async *stream(_req, signal) {
        enteredStream()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }
    const engine = await createSessionEngine({
      ...engineOpts({ provider, store, session: sess }),
    })
    const gen = engine.submitMessage('hi')
    const pending = drain(gen)
    await streamEntered
    job.pendingResetSha = job.baseCommitSha
    const finished = await engine.maybeFinishRewindReset()
    expect(finished).toEqual({ ran: false, ok: true })
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(later)
    expect(engine.session.job?.pendingResetSha).toBe(job.baseCommitSha)
    const rewind = await engine.rewindLast()
    expect(rewind).toEqual({ ok: false, notice: 'a turn is in progress' })
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(later)
    expect(engine.session.job?.pendingResetSha).toBe(job.baseCommitSha)
    engine.abort()
    await pending
  })
})

describe('applyAskAnswer descendants', () => {
  test('parent applyAskAnswer settles a grandchild leftover-ask onto the grandchild session', async () => {
    const store = createMemoryStore()
    const parent = makeSession({ id: 'sess_apply_grand_parent' })
    const child = makeSession({ id: 'sess_apply_grand_child', parentSessionId: parent.id })
    const grand = makeSession({ id: 'sess_apply_grand', parentSessionId: child.id })
    await store.createSession(parent)
    await store.createSession(child)
    await store.createSession(grand)
    await store.persistToolCalls(grand.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'call_grand', name: 'Echo', input: { text: 'hi' } }],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_grand',
      sessionId: grand.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 1,
    })
    const echo = createAskEcho()
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([]),
        store,
        session: parent,
        tools: [echo],
      }),
    })
    expect(await engine.applyAskAnswer('call_grand', 'allow')).toBe('matched')
    expect(await store.listPendingAsks(grand.id)).toHaveLength(0)
    const grandLoaded = await store.loadSession(grand.id)
    const tools = grandLoaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'call_grand')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.ok).toBe(true)
    const parentLoaded = await store.loadSession(parent.id)
    expect(parentLoaded.messages.some((m) => m.role === 'tool')).toBe(false)
  })

  test('applyAskAnswer stays unmatched for a non-descendant leftover-ask', async () => {
    const store = createMemoryStore()
    const parent = makeSession({ id: 'sess_apply_other_parent' })
    const other = makeSession({ id: 'sess_apply_other' })
    await store.createSession(parent)
    await store.createSession(other)
    await store.upsertPendingAsk({
      callId: 'call_other',
      sessionId: other.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 1,
    })
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([]),
        store,
        session: parent,
        tools: [createAskEcho()],
      }),
    })
    expect(await engine.applyAskAnswer('call_other', 'deny')).toBe('unmatched')
    expect(await store.listPendingAsks(other.id)).toHaveLength(1)
  })
})

describe('cancel', () => {
  async function drain(gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>) {
    const events: StreamEvent[] = []
    while (true) {
      const next = await gen.next()
      if (next.done) return { events, result: next.value }
      events.push(next.value)
    }
  }

  test('host cancel yields cancelled and a later submit runs', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_host_cancel' })
    await store.createSession(sess)
    let streams = 0
    let enteredFirst: () => void
    const firstStreamEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const provider: Provider = {
      id: 'fake',
      apiMode: 'openai_compat',
      profile(model: string) {
        return defaultModel(model)
      },
      async *stream(_req, signal) {
        streams += 1
        if (streams === 1) {
          enteredFirst()
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return
        }
        yield { type: 'text_delta', text: 'ok' }
        yield { type: 'stop', reason: 'end' }
      },
    }
    const engine = await createSessionEngine({
      ...engineOpts({ provider, store, session: sess }),
    })
    const gen = engine.submitMessage('hi')
    const pending = drain(gen)
    await firstStreamEntered
    engine.abort('cancel')
    const { result } = await pending
    expect(result).toEqual({ reason: 'cancelled' })

    const second = await drain(engine.submitMessage('again'))
    expect(second.result).toEqual({ reason: 'completed' })
    expect(streams).toBe(2)
  })

  test('live cancel abort-pairs a leftover-ask and does not emit ask still pending', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_cancel_ask' })
    await store.createSession(sess)
    const held = new Promise<'allow' | 'deny' | 'allow_always'>(() => {})
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([toolThenStop('call_park', 'Echo', { text: 'hi' })]),
        store,
        session: sess,
        tools: [createAskEcho()],
      }),
      askUser: async (_event, signal) => Promise.race([held, hangAskUser(_event, signal)]),
    })
    const gen = engine.submitMessage('hi')
    await consumeUntilAsk(gen)
    expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
    engine.abort('cancel')
    const { events, result } = await drain(gen)
    expect(result).toEqual({ reason: 'cancelled' })
    expect(
      events.some((e) => e.type === 'status' && e.message === 'cancelled, ask still pending'),
    ).toBe(false)
    expect(await store.listPendingAsks(sess.id)).toHaveLength(0)
    const loaded = await store.loadSession(sess.id)
    const tools = loaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'call_park')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.ok).toBe(false)
    expect((tools[0]?.blocks[0] as { text?: string })?.text).toBe(ABORTED_TEXT)
    expect(await engine.applyAskAnswer('call_park', 'deny')).toBe('matched')
  })

  test('unpaired persist-fail on cancel leaves the row and the status line', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_cancel_persist_fail' })
    await store.createSession(sess)
    let enteredFirst: () => void
    const firstStreamEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: {
          id: 'fake',
          apiMode: 'openai_compat',
          profile: (model: string) => defaultModel(model),
          async *stream(_req, signal) {
            enteredFirst()
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
          },
        },
        store,
        session: sess,
      }),
    })
    const gen = engine.submitMessage('hi')
    const pending = drain(gen)
    await firstStreamEntered
    await store.upsertPendingAsk({
      callId: 'parked_1',
      sessionId: sess.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Run ls?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    store.persistToolResults = async () => {
      throw new Error('disk')
    }
    engine.abort('cancel')
    const { events, result } = await pending
    expect(result).toEqual({ reason: 'cancelled' })
    expect(
      events.some((e) => e.type === 'status' && e.message === 'cancelled, ask still pending'),
    ).toBe(true)
    expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
  })

  test('already-paired delete-fail on cancel leaves the row and the status line', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_cancel_drop_fail' })
    await store.createSession(sess)
    await store.persistToolCalls(sess.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'call_park', name: 'Echo', input: { text: 'hi' } }],
      createdAt: 1,
    })
    await store.persistToolResults(sess.id, [
      {
        id: 't1',
        role: 'tool',
        toolUseId: 'call_park',
        ok: false,
        blocks: [{ type: 'text', text: ABORTED_TEXT }],
        createdAt: 2,
      },
    ])
    let enteredFirst: () => void
    const firstStreamEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: {
          id: 'fake',
          apiMode: 'openai_compat',
          profile: (model: string) => defaultModel(model),
          async *stream(_req, signal) {
            enteredFirst()
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
          },
        },
        store,
        session: sess,
      }),
    })
    const gen = engine.submitMessage('hi')
    const pending = drain(gen)
    await firstStreamEntered
    await store.upsertPendingAsk({
      callId: 'call_park',
      sessionId: sess.id,
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 3,
    })
    store.deletePendingAsk = async () => {
      throw new Error('disk')
    }
    engine.abort('cancel')
    const { events, result } = await pending
    expect(result).toEqual({ reason: 'cancelled' })
    expect(
      events.some((e) => e.type === 'status' && e.message === 'cancelled, ask still pending'),
    ).toBe(true)
    expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
  })

  test('interrupt leaves a leftover-ask', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_interrupt_ask' })
    await store.createSession(sess)
    let enteredFirst: () => void
    const firstStreamEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: {
          id: 'fake',
          apiMode: 'openai_compat',
          profile: (model: string) => defaultModel(model),
          async *stream(_req, signal) {
            enteredFirst()
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
          },
        },
        store,
        session: sess,
      }),
    })
    const gen = engine.submitMessage('hi')
    const pending = drain(gen)
    await firstStreamEntered
    await store.upsertPendingAsk({
      callId: 'parked_1',
      sessionId: sess.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Run ls?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    engine.abort('interrupt')
    const { result } = await pending
    expect(result.reason).toBe('aborted')
    expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
  })

  test('parent cancel abort-pairs a child leftover-ask', async () => {
    const store = createMemoryStore()
    const parent = makeSession({ id: 'sess_parent_cancel' })
    const child = makeSession({ id: 'sess_child_ask', parentSessionId: parent.id })
    await store.createSession(parent)
    await store.createSession(child)
    await store.persistToolCalls(child.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'call_child', name: 'Bash', input: { command: 'ls' } }],
      createdAt: 1,
    })
    let enteredFirst: () => void
    const firstStreamEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: {
          id: 'fake',
          apiMode: 'openai_compat',
          profile: (model: string) => defaultModel(model),
          async *stream(_req, signal) {
            enteredFirst()
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
          },
        },
        store,
        session: parent,
      }),
    })
    const gen = engine.submitMessage('hi')
    const pending = drain(gen)
    await firstStreamEntered
    await store.upsertPendingAsk({
      callId: 'call_child',
      sessionId: child.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Run ls?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    engine.abort('cancel')
    const { events, result } = await pending
    expect(result).toEqual({ reason: 'cancelled' })
    await expect(engine.whenTreeStop()).resolves.toEqual({ descendantWork: true })
    expect(await store.listPendingAsks(child.id)).toHaveLength(0)
    expect(await store.listPendingAsks(parent.id)).toHaveLength(0)
    expect(
      events.some((e) => e.type === 'status' && e.message === 'cancelled, ask still pending'),
    ).toBe(false)
    const childLoaded = await store.loadSession(child.id)
    const childTools = childLoaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'call_child')
    expect(childTools).toHaveLength(1)
    expect(childTools[0]?.ok).toBe(false)
    expect((childTools[0]?.blocks[0] as { text?: string })?.text).toBe(ABORTED_TEXT)
    const parentLoaded = await store.loadSession(parent.id)
    expect(parentLoaded.messages.filter((m) => m.role === 'tool')).toHaveLength(0)
    expect(engine.session.lastEnd).toEqual({ reason: 'cancelled' })
  })

  test('parent cancel cancels a live child turn', async () => {
    const store = createMemoryStore()
    const parent = makeSession({ id: 'sess_parent_live_child' })
    const child = makeSession({ id: 'sess_child_live', parentSessionId: parent.id })
    await store.createSession(parent)
    await store.createSession(child)
    let childEntered: () => void
    const childStreamEntered = new Promise<void>((resolve) => {
      childEntered = resolve
    })
    const childEngine = await createSessionEngine({
      ...engineOpts({
        provider: {
          id: 'fake',
          apiMode: 'openai_compat',
          profile: (model: string) => defaultModel(model),
          async *stream(_req, signal) {
            childEntered()
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
          },
        },
        store,
        session: child,
      }),
    })
    const register = {
      name: 'RegisterChild',
      description: 'register',
      inputSchema: { type: 'object', properties: {} },
      parse() {
        return { ok: true as const, value: {} }
      },
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      async checkPermissions() {
        return { behavior: 'allow' as const, reason: 'mode' as const }
      },
      async execute(_input: unknown, ctx: { registerChildEngine?: (engine: typeof childEngine) => () => void }) {
        ctx.registerChildEngine?.(childEngine)
        return 'ok'
      },
    }
    let parentEntered: () => void
    const parentStreamEntered = new Promise<void>((resolve) => {
      parentEntered = resolve
    })
    let parentStreams = 0
    const parentEngine = await createSessionEngine({
      ...engineOpts({
        provider: {
          id: 'fake',
          apiMode: 'openai_compat',
          profile: (model: string) => defaultModel(model),
          async *stream(_req, signal) {
            parentStreams += 1
            if (parentStreams === 1) {
              yield { type: 'tool_call' as const, id: 'reg', name: 'RegisterChild', input: {} }
              yield { type: 'stop' as const, reason: 'tool_use' }
              return
            }
            parentEntered()
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
          },
        },
        store,
        session: parent,
        tools: [register as never],
      }),
    })
    expect(typeof createSessionEngine).toBe('function')
    const childPending = drain(childEngine.submitMessage('child'))
    await childStreamEntered
    const parentPending = drain(parentEngine.submitMessage('parent'))
    await parentStreamEntered
    parentEngine.abort('cancel')
    expect((await childPending).result).toEqual({ reason: 'cancelled' })
    expect((await parentPending).result).toEqual({ reason: 'cancelled' })
    expect(childEngine.session.lastEnd).toEqual({ reason: 'cancelled' })
  })

  test('parent interrupt leaves a child leftover-ask', async () => {
    const store = createMemoryStore()
    const parent = makeSession({ id: 'sess_parent_interrupt' })
    const child = makeSession({ id: 'sess_child_interrupt', parentSessionId: parent.id })
    await store.createSession(parent)
    await store.createSession(child)
    let enteredFirst: () => void
    const firstStreamEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: {
          id: 'fake',
          apiMode: 'openai_compat',
          profile: (model: string) => defaultModel(model),
          async *stream(_req, signal) {
            enteredFirst()
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
          },
        },
        store,
        session: parent,
      }),
    })
    const gen = engine.submitMessage('hi')
    const pending = drain(gen)
    await firstStreamEntered
    await store.upsertPendingAsk({
      callId: 'call_child',
      sessionId: child.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Run ls?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    engine.abort('interrupt')
    const { result } = await pending
    expect(result.reason).toBe('aborted')
    expect(await store.listPendingAsks(child.id)).toHaveLength(1)
  })

  test('idle parent tree-stop drops descendant leftover-asks and keeps this session parked', async () => {
    const store = createMemoryStore()
    const parent = makeSession({ id: 'sess_idle_parent_tree' })
    const child = makeSession({ id: 'sess_idle_child_tree', parentSessionId: parent.id })
    await store.createSession(parent)
    await store.createSession(child)
    await store.persistToolCalls(child.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'call_child', name: 'Bash', input: { command: 'ls' } }],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_child',
      sessionId: child.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Run ls?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'parked_parent',
      sessionId: parent.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Run pwd?',
      input: { command: 'pwd' },
      createdAt: 2,
    })
    const engine = await createSessionEngine({
      ...engineOpts({ provider: createFakeProvider([]), store, session: parent }),
    })
    expect(engine.session.lastEnd).toBeUndefined()
    engine.abort('cancel')
    await expect(engine.whenTreeStop()).resolves.toEqual({ descendantWork: true })
    expect(await store.listPendingAsks(child.id)).toHaveLength(0)
    expect(await store.listPendingAsks(parent.id)).toHaveLength(1)
    expect(engine.session.lastEnd).toBeUndefined()
    const reloaded = await store.loadSession(parent.id)
    expect(reloaded.session.lastEnd).toBeUndefined()
    const childLoaded = await store.loadSession(child.id)
    expect(childLoaded.session.lastEnd).toBeUndefined()
    const childTools = childLoaded.messages.filter((m) => m.role === 'tool' && m.toolUseId === 'call_child')
    expect(childTools).toHaveLength(1)
    expect((childTools[0]?.blocks[0] as { text?: string })?.text).toBe(ABORTED_TEXT)
  })

  test('idle parent cancel with no descendants reports no descendant work', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_idle_no_desc' })
    await store.createSession(sess)
    await store.upsertPendingAsk({
      callId: 'parked',
      sessionId: sess.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Run ls?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    const engine = await createSessionEngine({
      ...engineOpts({ provider: createFakeProvider([]), store, session: sess }),
    })
    engine.abort('cancel')
    await expect(engine.whenTreeStop()).resolves.toEqual({ descendantWork: false })
    expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
  })

  test('persist-fail on one descendant leftover-ask continues the others', async () => {
    const store = createMemoryStore()
    const parent = makeSession({ id: 'sess_persist_fail_parent' })
    const childA = makeSession({ id: 'sess_persist_fail_a', parentSessionId: parent.id })
    const childB = makeSession({ id: 'sess_persist_fail_b', parentSessionId: parent.id })
    const childC = makeSession({ id: 'sess_persist_fail_c', parentSessionId: parent.id })
    await store.createSession(parent)
    await store.createSession(childA)
    await store.createSession(childB)
    await store.createSession(childC)
    for (const [sess, callId] of [
      [childA, 'call_a'],
      [childB, 'call_b'],
      [childC, 'call_c'],
    ] as const) {
      await store.persistToolCalls(sess.id, {
        id: `a_${callId}`,
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command: 'ls' } }],
        createdAt: 1,
      })
      await store.upsertPendingAsk({
        callId,
        sessionId: sess.id,
        kind: 'leftover',
        tool: 'Bash',
        message: 'Run ls?',
        input: { command: 'ls' },
        createdAt: 1,
      })
    }
    const innerPersist = store.persistToolResults.bind(store)
    store.persistToolResults = async (sessionId, messages) => {
      if (sessionId === childA.id) throw new Error('disk')
      return innerPersist(sessionId, messages)
    }
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([]),
        store,
        session: parent,
      }),
    })
    engine.abort('cancel')
    await expect(engine.whenTreeStop()).resolves.toEqual({ descendantWork: true })
    expect(await store.listPendingAsks(childA.id)).toHaveLength(1)
    expect(await store.listPendingAsks(childB.id)).toHaveLength(0)
    expect(await store.listPendingAsks(childC.id)).toHaveLength(0)
    store.persistToolResults = innerPersist
    expect(await engine.applyAskAnswer('call_a', 'deny')).toBe('matched')
  })

  test('cancel with no live turn does not drop leftover-asks', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_idle_cancel' })
    await store.createSession(sess)
    await store.upsertPendingAsk({
      callId: 'parked',
      sessionId: sess.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Run ls?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    const engine = await createSessionEngine({
      ...engineOpts({ provider: createFakeProvider([]), store, session: sess }),
    })
    engine.abort('cancel')
    expect(await store.listPendingAsks(sess.id)).toHaveLength(1)
  })

  test('cancelled turn persists lastEnd; pending-gate submit does not overwrite it', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_last_end_cancel' })
    await store.createSession(session)
    let enteredFirst: () => void
    const firstStreamEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const provider: Provider = {
      id: 'fake',
      apiMode: 'openai_compat',
      profile(model: string) {
        return defaultModel(model)
      },
      async *stream(_req, signal) {
        enteredFirst()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }
    const engine = await createSessionEngine({
      ...engineOpts({ provider, store, session }),
    })
    const gen = engine.submitMessage('go')
    const pending = drain(gen)
    await firstStreamEntered
    engine.abort('cancel')
    expect((await pending).result).toEqual({ reason: 'cancelled' })
    expect(engine.session.lastEnd).toEqual({ reason: 'cancelled' })
    const loaded = await store.loadSession(session.id)
    expect(loaded.session.lastEnd).toEqual({ reason: 'cancelled' })

    await store.upsertPendingAsk({
      callId: 'parked',
      sessionId: session.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Bash?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    const gated = await drain(engine.submitMessage('again'))
    expect(gated.result).toEqual({ reason: 'completed' })
    expect(engine.session.lastEnd).toEqual({ reason: 'cancelled' })
  })
})

describe('no-job todo stamp', () => {
  async function drain(gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>) {
    const events: StreamEvent[] = []
    while (true) {
      const next = await gen.next()
      if (next.done) return { events, result: next.value }
      events.push(next.value)
    }
  }

  test('no-job success turn stamps a sha-less todo snapshot', async () => {
    const store = createMemoryStore()
    const sess = makeSession({
      id: 'sess_stamp_todo',
      todos: [{ text: 'b', status: 'pending' }],
    })
    await store.createSession(sess)
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([
          [{ type: 'text_delta', text: 'ok' }, { type: 'stop', reason: null }],
        ]),
        store,
        session: sess,
      }),
    })
    const result = await drain(engine.submitMessage('hi'))
    expect(result.result.reason).toBe('completed')
    const loaded = await store.loadSession(sess.id)
    const last = [...loaded.messages].reverse().find((msg) => msg.role === 'assistant')
    expect(last && last.role === 'assistant' ? last.checkpoint : undefined).toEqual({
      todoSnapshot: [{ text: 'b', status: 'pending' }],
      dirty: false,
    })
  })

  test('cancelled no-job turn does not stamp', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_stamp_cancel' })
    await store.createSession(sess)
    let enteredFirst: () => void
    const firstStreamEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: {
          id: 'fake',
          apiMode: 'openai_compat',
          profile: (model: string) => defaultModel(model),
          async *stream(_req, signal) {
            enteredFirst()
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
          },
        },
        store,
        session: sess,
      }),
    })
    const pending = drain(engine.submitMessage('hi'))
    await firstStreamEntered
    engine.abort('cancel')
    await pending
    const loaded = await store.loadSession(sess.id)
    for (const msg of loaded.messages) {
      if (msg.role === 'assistant') expect(msg.checkpoint).toBeUndefined()
    }
  })
})

describe('followup slot', () => {
  test('setFollowup overwrites; empty is an error; clear removes', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_followup' })
    await store.createSession(sess)
    const engine = await createSessionEngine({
      session: sess,
      provider: createFakeProvider([]),
      store,
      tools: [],
      compact: defaultCompact({ enabled: false }),
      model: defaultModel(),
      maxRounds: 8,
      async askUser() {
        return 'deny'
      },
    })

    expect(await engine.setFollowup('  ')).toEqual({ ok: false, notice: 'follow-up text required' })
    expect(engine.session.followup).toBeUndefined()
    expect(engine.getFollowup()).toBeNull()

    expect(await engine.setFollowup('first')).toEqual({ ok: true })
    expect(await engine.setFollowup('second')).toEqual({ ok: true })
    expect(engine.getFollowup()).toBe('second')
    expect((await store.loadSession(sess.id)).session.followup).toBe('second')

    await engine.clearFollowup()
    expect(engine.getFollowup()).toBeNull()
    expect((await store.loadSession(sess.id)).session.followup).toBeUndefined()
  })
})

describe('clearKeepId', () => {
  const tempDirs: string[] = []
  const sessionIds: string[] = []
  let seq = 0

  afterEach(() => {
    while (sessionIds.length > 0) {
      const id = sessionIds.pop()
      if (id) exitSessionWorktree(id, 'remove', true)
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  function nextSession(): string {
    const id = `sess_clear_${Date.now()}_${seq++}`
    sessionIds.push(id)
    return id
  }

  function initGitRepo(dir: string): void {
    const run = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
      expect(result.status).toBe(0)
    }
    run(['init'])
    run(['config', 'user.email', 'test@example.com'])
    run(['config', 'user.name', 'Test'])
    run(['config', 'commit.gpgsign', 'false'])
    run(['commit', '--allow-empty', '-m', 'init'])
  }

  function git(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(result.status).toBe(0)
    return result.stdout.trim()
  }

  async function drain(gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>) {
    const events: StreamEvent[] = []
    while (true) {
      const next = await gen.next()
      if (next.done) return { events, result: next.value }
      events.push(next.value)
    }
  }

  test('idle wipe keeps id and empties conversation', async () => {
    const store = createMemoryStore()
    const sess = makeSession({
      id: 'sess_clear_idle',
      title: 'old title',
      followup: 'run tests',
      lastEnd: { reason: 'completed' },
      jobError: 'stale',
      todos: [{ text: 'ship', status: 'pending' }],
      usage: { input: 9, output: 3, cacheRead: 1, cacheWrite: 2 },
    })
    await store.createSession(sess)
    const messages: Message[] = [user('u1', 'hello', 1), asst('a1', 'hi', 2)]
    await persistAll(store, sess.id, messages)
    await store.upsertPendingAsk({
      callId: 'parked',
      sessionId: sess.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Bash?',
      input: { command: 'ls' },
      createdAt: 3,
    })
    await store.appendStreamEvent(sess.id, { type: 'text_delta', text: 'x' })
    const engine = await createSessionEngine({
      ...engineOpts({ provider: createFakeProvider([]), store, session: sess }),
      messages,
    })
    engine.enqueueSteer('later')
    const result = await engine.clearKeepId()
    expect(result).toEqual({ ok: true, notice: 'session cleared' })
    expect(engine.session.id).toBe('sess_clear_idle')
    expect(engine.session.title).toBeUndefined()
    expect(engine.session.followup).toBeUndefined()
    expect(engine.session.lastEnd).toBeUndefined()
    expect(engine.session.jobError).toBeUndefined()
    expect(engine.session.todos).toEqual([])
    expect(engine.session.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(engine.drainSteering()).toEqual([])
    expect(await store.loadMessages!(sess.id)).toEqual([])
    expect(await store.listPendingAsks(sess.id)).toEqual([])
    expect(await store.lastStreamSeq(sess.id)).toBe(0)
    const loaded = await store.loadSession(sess.id)
    expect(loaded.session.id).toBe('sess_clear_idle')
    expect(loaded.messages).toEqual([])
    expect(engine.fileHistory.undo()).toEqual({ restored: [], removed: [] })
  })

  test('persist fail leaves memory and disk unchanged', async () => {
    const store = createMemoryStore()
    const sess = makeSession({
      id: 'sess_clear_persist_fail',
      todos: [{ text: 'keep', status: 'pending' }],
    })
    await store.createSession(sess)
    const messages: Message[] = [user('u1', 'keep me', 1)]
    await persistAll(store, sess.id, messages)
    const engine = await createSessionEngine({
      ...engineOpts({ provider: createFakeProvider([]), store, session: sess }),
      messages,
    })
    store.clearConversation = async () => {
      throw new Error('disk')
    }
    const result = await engine.clearKeepId()
    expect(result).toEqual({ ok: false, notice: 'clear persist failed' })
    expect(engine.session.todos).toEqual([{ text: 'keep', status: 'pending' }])
    expect(await store.loadMessages!(sess.id)).toEqual(messages)
  })

  test('closed engine does not persist', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_clear_closed' })
    await store.createSession(sess)
    const engine = await createSessionEngine({
      ...engineOpts({ provider: createFakeProvider([]), store, session: sess }),
    })
    let called = false
    store.clearConversation = async () => {
      called = true
    }
    await engine.close()
    expect(await engine.clearKeepId()).toEqual({ ok: false, notice: 'session closed' })
    expect(called).toBe(false)
  })

  test('empty transcript is an idempotent success', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_clear_empty', followup: 'x', lastEnd: { reason: 'completed' } })
    await store.createSession(sess)
    const engine = await createSessionEngine({
      ...engineOpts({ provider: createFakeProvider([]), store, session: sess }),
    })
    expect(await engine.clearKeepId()).toEqual({ ok: true, notice: 'session cleared' })
    expect(await engine.clearKeepId()).toEqual({ ok: true, notice: 'session cleared' })
    expect(engine.session.id).toBe('sess_clear_empty')
    expect(engine.session.followup).toBeUndefined()
    expect(await store.loadMessages!(sess.id)).toEqual([])
  })

  test('mid-turn abort cancel then wipe', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_clear_live' })
    await store.createSession(sess)
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: createFakeProvider([toolThenStop('call_park', 'Echo', { text: 'hi' })]),
        store,
        session: sess,
        tools: [createAskEcho()],
      }),
      askUser: async (_event, signal) => hangAskUser(_event, signal),
    })
    const gen = engine.submitMessage('hi')
    await consumeUntilAsk(gen)
    expect(engine.liveTurnId()).not.toBeNull()
    const kinds: Array<string | undefined> = []
    const origAbort = engine.abort.bind(engine)
    engine.abort = (kind) => {
      kinds.push(kind)
      origAbort(kind)
    }
    const pending = drain(gen)
    const first = engine.clearKeepId()
    const second = engine.clearKeepId()
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual({ ok: true, notice: 'session cleared' })
    expect(b).toEqual({ ok: true, notice: 'session cleared' })
    expect(kinds).toEqual(['cancel'])
    expect(engine.liveTurnId()).toBeNull()
    await pending
    expect(await store.loadMessages!(sess.id)).toEqual([])
    expect(await store.listPendingAsks(sess.id)).toEqual([])
  })

  test('refuses unpaired child ask before abort', async () => {
    const store = createMemoryStore()
    const parent = makeSession({ id: 'sess_clear_parent' })
    const child = makeSession({ id: 'sess_clear_child', parentSessionId: parent.id })
    await store.createSession(parent)
    await store.createSession(child)
    const messages: Message[] = [user('u1', 'parent keep', 1)]
    await persistAll(store, parent.id, messages)
    let enteredFirst: () => void
    const firstStreamEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const engine = await createSessionEngine({
      ...engineOpts({
        provider: {
          id: 'fake',
          apiMode: 'openai_compat',
          profile: (model: string) => defaultModel(model),
          async *stream(_req, signal) {
            enteredFirst()
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              signal.addEventListener('abort', () => resolve(), { once: true })
            })
          },
        },
        store,
        session: parent,
      }),
      messages,
    })
    const gen = engine.submitMessage('live')
    const pending = drain(gen)
    await firstStreamEntered
    await store.upsertPendingAsk({
      callId: 'call_child',
      sessionId: child.id,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Run ls?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    expect(engine.liveTurnId()).not.toBeNull()
    const kinds: Array<string | undefined> = []
    const origAbort = engine.abort.bind(engine)
    engine.abort = (kind) => {
      kinds.push(kind)
      origAbort(kind)
    }
    expect(await engine.clearKeepId()).toEqual({ ok: false, notice: 'pending permission ask' })
    expect(kinds).toEqual([])
    expect(engine.liveTurnId()).not.toBeNull()
    expect((await store.loadMessages!(parent.id)).map((msg) => msg.id)).toContain('u1')
    expect(await store.listPendingAsks(child.id)).toHaveLength(1)

    engine.abort('cancel')
    await pending
    expect(await store.listPendingAsks(child.id)).toHaveLength(0)
    expect(await engine.applyAskAnswer('call_child', 'deny')).toBe('unmatched')
    expect(await engine.clearKeepId()).toEqual({ ok: true, notice: 'session cleared' })
    expect((await store.loadSession(child.id)).session.id).toBe(child.id)
    expect((await store.loadSession(child.id)).session.parentSessionId).toBe(parent.id)
  })

  test('job worktree and dirty files survive; chat fields wipe', async () => {
    const cwd = tempDir('ravenclaw-clear-job-')
    initGitRepo(cwd)
    const id = nextSession()
    const entered = enterSessionWorktree(id, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    const dirty = join(job.worktreePath, 'dirty.txt')
    writeFileSync(dirty, 'dirty\n')
    const head = git(job.worktreePath, ['rev-parse', 'HEAD'])
    const store = createMemoryStore()
    const sess = makeSession({
      id,
      cwd: job.worktreePath,
      job,
      title: 'job title',
      followup: 'next',
      lastEnd: { reason: 'completed' },
      jobError: 'stale',
      todos: [{ text: 'ship', status: 'pending' }],
      usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0 },
    })
    await store.createSession(sess)
    const messages: Message[] = [user('u1', 'job hello', 1), asst('a1', 'ok', 2)]
    await persistAll(store, id, messages)
    const engine = await createSessionEngine({
      ...engineOpts({ provider: createFakeProvider([]), store, session: sess }),
      messages,
    })
    engine.session.job = { ...engine.session.job!, pendingResetSha: job.baseCommitSha }
    await store.upsertSession(engine.session)
    expect(await engine.clearKeepId()).toEqual({ ok: true, notice: 'session cleared' })
    expect(engine.session.id).toBe(id)
    expect(engine.session.job).toEqual({ ...job, pendingResetSha: job.baseCommitSha })
    expect(engine.session.job?.pendingResetSha).toBe(job.baseCommitSha)
    expect(engine.session.cwd).toBe(job.worktreePath)
    expect(engine.session.todos).toEqual([])
    expect(engine.session.title).toBeUndefined()
    expect(engine.session.followup).toBeUndefined()
    expect(engine.session.lastEnd).toBeUndefined()
    expect(engine.session.jobError).toBeUndefined()
    expect(engine.session.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(head)
    expect(readFileSync(dirty, 'utf8')).toBe('dirty\n')
    expect(readFileSync(todoJsonPath(cwd), 'utf8')).toBe('[]\n')
    expect(await store.loadMessages!(id)).toEqual([])
  })
})
