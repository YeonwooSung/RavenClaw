import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  Tool,
} from '../types'
import { createSessionEngine } from './session-engine'
import { drainAgentMail, enqueueAgentMail } from '../tasks/mailbox'

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

describe('steering and image submit', () => {
  test('enqueueSteer injects a user row after a tool round', async () => {
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
      'keep going',
    ])
    expect(engine.drainSteering()).toEqual([])
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
      expect(events.some((event) => event.type === 'status' && event.message === 'stop-ok')).toBe(true)
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
})
