import { describe, expect, test } from 'bun:test'
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
import { createSessionEngine } from './session-engine'
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
    const engine = createSessionEngine({
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

describe('steering and image submit', () => {
  test('enqueueSteer suffixes the last tool row after a tool round', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_steer' })
    await store.createSession(sess)
    const engine = createSessionEngine({
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
    const engine = createSessionEngine({
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
    const engine = createSessionEngine({
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
    const engine = createSessionEngine({
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
})

describe('agent mailbox drain', () => {
  test('submitMessage prepends drained mailbox notices to the user text', async () => {
    const store = createMemoryStore()
    const sess = makeSession({ id: 'sess_mailbox' })
    await store.createSession(sess)
    await enqueueAgentMail(store, sess.id, 'subagent finished (b_abc):\ndone-a')
    await enqueueAgentMail(store, sess.id, 'subagent finished (b_def):\ndone-b')
    const engine = createSessionEngine({
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
    const engine = createSessionEngine({
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
      const engine = createSessionEngine({
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
      const engine = createSessionEngine({
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
      const engine = createSessionEngine({
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
      const engine = createSessionEngine({
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
    const engine = createSessionEngine({
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
      const engine = createSessionEngine({
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
      const engine = createSessionEngine({
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
      const engine = createSessionEngine({
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
    const engine = createSessionEngine({
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

async function drain(engine: ReturnType<typeof createSessionEngine>, text: string): Promise<void> {
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
    const engine = createSessionEngine({
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
    const engine = createSessionEngine({
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
    const engine = createSessionEngine({
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
    const engine = createSessionEngine({
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
    const engine = createSessionEngine({
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
})
