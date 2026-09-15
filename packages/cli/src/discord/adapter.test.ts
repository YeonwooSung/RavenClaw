import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMemoryDeliveries,
  createMemoryStore,
  SessionLockError,
  sessionLockedMessage,
  type UserSubmitInput,
} from '@ravenclaw/core'
import { runDiscordAdapter } from './adapter'
import type {
  DiscordApi,
  DiscordBoundSession,
  DiscordConfig,
  DiscordGateway,
  DiscordOpenSession,
} from './types'

class FakeDiscordGateway implements DiscordGateway {
  private readonly items: Array<unknown | null> = []
  private readonly waiters: Array<(value: IteratorResult<unknown>) => void> = []

  push(event: unknown): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.items.push(event)
  }

  end(): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: undefined as never, done: true })
    else this.items.push(null)
  }

  async *events(): AsyncGenerator<unknown> {
    for (;;) {
      const queued = this.items.shift()
      if (queued === null) return
      if (queued !== undefined) {
        yield queued
        continue
      }
      const next = await new Promise<IteratorResult<unknown>>((resolve) => {
        this.waiters.push(resolve)
      })
      if (next.done) return
      yield next.value
    }
  }

  async close(): Promise<void> {
    this.end()
  }
}

class FakeDiscordApi implements DiscordApi {
  posts: Array<{ channelId: string; content: string; id: string }> = []
  edits: Array<{ channelId: string; messageId: string; content: string }> = []

  async createMessage(opts: { channelId: string; content: string }) {
    const id = `${this.posts.length + 1}`
    this.posts.push({ ...opts, id })
    return { ok: true, id }
  }

  async editMessage(opts: { channelId: string; messageId: string; content: string }) {
    this.edits.push(opts)
    return { ok: true }
  }
}

function home(): string {
  const dir = join(tmpdir(), `raven-discord-adapter-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function cfg(over: Partial<DiscordConfig> = {}): DiscordConfig {
  return {
    enabled: true,
    token: 't',
    allowFrom: ['U1'],
    channels: ['C1'],
    mentionOnly: true,
    ...over,
  }
}

function guildMention(over: {
  id?: string
  content?: string
  userId?: string
  channelId?: string
  guildId?: string
  bot?: boolean
} = {}): Record<string, unknown> {
  return {
    id: over.id ?? 'm1',
    channel_id: over.channelId ?? 'C1',
    guild_id: over.guildId ?? 'G1',
    author: { id: over.userId ?? 'U1', bot: over.bot ?? false },
    content: over.content ?? '<@BOT> hello',
    mentions: [{ id: 'BOT' }],
  }
}

function dmMessage(over: {
  id?: string
  content?: string
  userId?: string
  channelId?: string
} = {}): Record<string, unknown> {
  return {
    id: over.id ?? 'dm1',
    channel_id: over.channelId ?? 'D1',
    author: { id: over.userId ?? 'U9', bot: false },
    content: over.content ?? 'hello',
  }
}

function dmPayload(over: {
  id?: string
  content?: string
  authorId?: string
  channelId?: string
} = {}): Record<string, unknown> {
  return {
    id: over.id ?? 'm-dm',
    channel_id: over.channelId ?? 'D1',
    author: { id: over.authorId ?? 'U1', bot: false },
    content: over.content ?? 'please',
  }
}

async function runOnce(opts: {
  config?: DiscordConfig
  gateway: FakeDiscordGateway
  api?: FakeDiscordApi
  openSession: DiscordOpenSession
  pairingHome?: string
}): Promise<FakeDiscordApi> {
  const api = opts.api ?? new FakeDiscordApi()
  await runDiscordAdapter({
    config: opts.config ?? cfg(),
    openSession: opts.openSession,
    gateway: opts.gateway,
    api,
    ledger: createMemoryDeliveries(),
    pairingHome: opts.pairingHome ?? home(),
    botUserId: 'BOT',
  })
  return api
}

function submitText(input: UserSubmitInput): string {
  return typeof input === 'string' ? input : (input.text ?? '')
}

function recordingSession(
  submitted: string[],
  keys: string[],
  modes?: string[],
): DiscordOpenSession {
  return async (req) => {
    keys.push(req.sessionKey)
    modes?.push(req.permissionMode)
    const session: DiscordBoundSession = {
      sessionId: `sess-${keys.length}`,
      async *submitMessage(input: UserSubmitInput) {
        const text = submitText(input)
        submitted.push(text)
        yield { type: 'text_delta', text: `pong:${text}` }
      },
    }
    return session
  }
}

describe('runDiscordAdapter', () => {
  test('guild mention submits once with dontAsk and guild session key', async () => {
    const gateway = new FakeDiscordGateway()
    const submitted: string[] = []
    const keys: string[] = []
    const modes: string[] = []
    const running = runOnce({
      gateway,
      openSession: recordingSession(submitted, keys, modes),
    })
    gateway.push(guildMention({ content: '<@BOT> hello', id: 'm1' }))
    gateway.end()
    await running
    expect(submitted).toHaveLength(1)
    expect(modes).toEqual(['dontAsk'])
    expect(keys).toEqual(['raven:discord:G1:C1'])
  })

  test('same message id is ledger-deduped', async () => {
    const gateway = new FakeDiscordGateway()
    const submitted: string[] = []
    const running = runOnce({
      gateway,
      openSession: recordingSession(submitted, []),
    })
    const msg = guildMention({ id: 'm-dup', content: '<@BOT> once' })
    gateway.push(msg)
    gateway.push({ ...msg })
    gateway.end()
    await running
    expect(submitted).toHaveLength(1)
  })

  test('unapproved DM sends pairing line and does not openSession', async () => {
    const gateway = new FakeDiscordGateway()
    let opened = 0
    const api = new FakeDiscordApi()
    const running = runOnce({
      gateway,
      api,
      openSession: async () => {
        opened += 1
        return {
          sessionId: 'x',
          async *submitMessage() {
            // unapproved DMs must not reach a session
          },
        }
      },
    })
    gateway.push(dmMessage({ userId: 'U9', content: 'hi' }))
    gateway.end()
    await running
    expect(opened).toBe(0)
    expect(api.posts).toHaveLength(1)
    expect(api.posts[0]?.content.startsWith('pair with: raven pairing approve ')).toBe(true)
  })

  test('bot and empty messages are not ledgered', async () => {
    const gateway = new FakeDiscordGateway()
    const submitted: string[] = []
    const running = runOnce({
      gateway,
      openSession: recordingSession(submitted, []),
    })
    gateway.push(guildMention({ id: 'm-bot', bot: true, content: '<@BOT> from bot' }))
    gateway.push(guildMention({ id: 'm-bot', content: '<@BOT> from user' }))
    gateway.push(guildMention({ id: 'm-empty', content: '   ' }))
    gateway.push(guildMention({ id: 'm-empty', content: '<@BOT> after empty' }))
    gateway.end()
    await running
    expect(submitted).toHaveLength(2)
  })

  test('submitMessage throw replies turn failed, not the exception', async () => {
    const gateway = new FakeDiscordGateway()
    const api = new FakeDiscordApi()
    const running = runOnce({
      gateway,
      api,
      openSession: async () => ({
        sessionId: 'sess-boom',
        async *submitMessage() {
          throw new Error('boom')
        },
      }),
    })
    gateway.push(guildMention({ id: 'm-boom' }))
    gateway.end()
    await running
    const texts = [...api.posts.map((p) => p.content), ...api.edits.map((e) => e.content)]
    expect(texts.some((t) => t === 'turn failed')).toBe(true)
    expect(texts.some((t) => t.includes('boom'))).toBe(false)
  })

  test('openSession SessionLockError posts lock line, not silence', async () => {
    const gateway = new FakeDiscordGateway()
    const api = new FakeDiscordApi()
    const expiresAt = Date.parse('2026-09-13T00:00:00.000Z')
    const lockLine = sessionLockedMessage('discord', expiresAt)
    const running = runOnce({
      gateway,
      api,
      openSession: async () => {
        throw new SessionLockError(lockLine, { holderName: 'discord', expiresAt })
      },
    })
    gateway.push(guildMention({ id: 'm-lock' }))
    gateway.end()
    await running
    expect(api.posts.map((p) => p.content)).toEqual([lockLine])
    expect(api.edits).toEqual([])
  })

  test('turnFlights serializes two messages on the same session', async () => {
    const gateway = new FakeDiscordGateway()
    const order: string[] = []
    let started = 0
    let releaseFirst!: () => void
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstStartedP = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const running = runOnce({
      gateway,
      openSession: async () => ({
        sessionId: 'sess-shared',
        async *submitMessage() {
          started += 1
          const n = started
          order.push(`start:${n}`)
          if (n === 1) {
            firstStarted()
            await firstHold
          }
          order.push(`end:${n}`)
        },
      }),
    })
    gateway.push(guildMention({ id: 'm1', content: '<@BOT> first' }))
    gateway.push(guildMention({ id: 'm2', content: '<@BOT> second' }))
    await firstStartedP
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['start:1'])
    releaseFirst()
    gateway.end()
    await running
    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2'])
  })

  test('DM leftover-ask times out to deny', async () => {
    let answer: string | undefined
    const gateway = new FakeDiscordGateway()
    const running = runDiscordAdapter({
      config: cfg({ allowFrom: ['U1'] }),
      pairingHome: home(),
      ledger: createMemoryDeliveries(),
      permissionTimeoutMs: 20,
      openSession: async (req) => {
        expect(req.permissionMode).toBe('default')
        return {
          sessionId: 'sess_dm',
          async *submitMessage() {
            const ac = new AbortController()
            const result = await req.askUser({ id: 'p1', tool: 'Bash', message: 'run?' }, ac.signal)
            answer = result
          },
        }
      },
      gateway,
      api: new FakeDiscordApi(),
    })
    gateway.push(dmPayload({ id: 'm-dm', authorId: 'U1', content: 'please' }))
    gateway.end()
    await running
    expect(answer).toBe('deny')
  })

  test('discord does not deny a durable pending row on timer', async () => {
    const store = createMemoryStore()
    const sessionId = 'sess_discord'
    let answered: string | undefined
    let askStarted!: () => void
    const sawAsk = new Promise<void>((resolve) => {
      askStarted = resolve
    })
    const gateway = new FakeDiscordGateway()
    const running = runDiscordAdapter({
      config: cfg({ allowFrom: ['U1'] }),
      pairingHome: home(),
      ledger: createMemoryDeliveries(),
      permissionTimeoutMs: 5,
      store,
      openSession: async (req) => ({
        sessionId,
        async *submitMessage() {
          await store.upsertPendingAsk({
            callId: 'call_1',
            sessionId,
            kind: 'leftover',
            tool: 'Bash',
            message: 'Allow Bash?',
            input: { command: 'ls' },
            createdAt: 1,
          })
          const ac = new AbortController()
          askStarted()
          answered = await req.askUser({ id: 'call_1', tool: 'Bash', message: 'Allow Bash?' }, ac.signal)
        },
      }),
      gateway,
      api: new FakeDiscordApi(),
    })
    gateway.push(dmPayload({ id: 'm-durable', authorId: 'U1', content: 'please' }))
    await sawAsk
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(answered).toBeUndefined()
    expect(await store.listPendingAsks(sessionId)).toHaveLength(1)
    gateway.push(dmPayload({ id: 'm-deny', authorId: 'U1', content: 'deny' }))
    gateway.end()
    await running
  })

  test('discord leftover-ask labels childSessionId', async () => {
    const api = new FakeDiscordApi()
    const gateway = new FakeDiscordGateway()
    let askStarted!: () => void
    const sawAsk = new Promise<void>((resolve) => {
      askStarted = resolve
    })
    const running = runDiscordAdapter({
      config: cfg({ allowFrom: ['U1'] }),
      pairingHome: home(),
      ledger: createMemoryDeliveries(),
      store: createMemoryStore(),
      botUserId: 'BOT',
      openSession: async (req) => ({
        sessionId: 'sess_parent',
        async *submitMessage() {
          const ac = new AbortController()
          askStarted()
          await req.askUser(
            {
              id: 'call_child',
              tool: 'Bash',
              message: 'child bash?',
              childSessionId: 'sess_child',
            },
            ac.signal,
          )
        },
      }),
      gateway,
      api,
    })
    gateway.push(dmPayload({ id: 'm-child', authorId: 'U1', content: 'please' }))
    await sawAsk
    await new Promise((resolve) => setTimeout(resolve, 20))
    const prompt = api.posts.find((post) => post.content.includes('Allow'))
    expect(prompt?.content).toContain('child sess_child')
    gateway.push(dmPayload({ id: 'm-child-deny', authorId: 'U1', content: 'deny' }))
    gateway.end()
    await running
  })

  test('failed discord permission post does not auto-deny the next ask', async () => {
    const store = createMemoryStore()
    const gateway = new FakeDiscordGateway()
    const api = new FakeDiscordApi()
    const orig = api.createMessage.bind(api)
    let allowPosts = 0
    api.createMessage = async (opts) => {
      if (opts.content.includes('Allow')) {
        allowPosts += 1
        if (allowPosts === 1) throw new Error('discord down')
      }
      return orig(opts)
    }
    const answers: string[] = []
    let asks = 0
    let sawSecond!: () => void
    const secondAsk = new Promise<void>((resolve) => {
      sawSecond = resolve
    })
    const running = runDiscordAdapter({
      config: cfg({ allowFrom: ['U1'] }),
      pairingHome: home(),
      ledger: createMemoryDeliveries(),
      store,
      openSession: async (req) => ({
        sessionId: 'sess_post_fail',
        async *submitMessage() {
          asks += 1
          const ac = new AbortController()
          if (asks === 2) sawSecond()
          try {
            answers.push(
              await req.askUser({ id: `call_${asks}`, tool: 'Bash', message: 'Allow Bash?' }, ac.signal),
            )
          } catch {
            answers.push('threw')
          }
        },
      }),
      gateway,
      api,
    })
    gateway.push(dmPayload({ id: 'm-fail-1', authorId: 'U1', content: 'first' }))
    for (let i = 0; i < 40 && answers.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(answers).toEqual(['threw'])
    gateway.push(dmPayload({ id: 'm-fail-2', authorId: 'U1', content: 'second' }))
    await secondAsk
    await Promise.resolve()
    await Promise.resolve()
    expect(answers).toEqual(['threw'])
    gateway.push(dmPayload({ id: 'm-fail-allow', authorId: 'U1', content: 'allow' }))
    gateway.end()
    await running
    expect(answers).toEqual(['threw', 'allow'])
  })

  test('durable discord waiter abort does not deny the pending row', async () => {
    const store = createMemoryStore()
    const sessionId = 'sess_discord_abort'
    let answered: string | undefined
    let askError: unknown
    let abortAsk!: () => void
    let applied = 0
    let askStarted!: () => void
    const sawAsk = new Promise<void>((resolve) => {
      askStarted = resolve
    })
    const gateway = new FakeDiscordGateway()
    const api = new FakeDiscordApi()
    const running = runDiscordAdapter({
      config: cfg({ allowFrom: ['U1'] }),
      pairingHome: home(),
      ledger: createMemoryDeliveries(),
      store,
      openSession: async (req) => ({
        sessionId,
        async *submitMessage() {
          await store.upsertPendingAsk({
            callId: 'call_1',
            sessionId,
            kind: 'leftover',
            tool: 'Bash',
            message: 'Allow Bash?',
            input: { command: 'ls' },
            createdAt: 1,
          })
          const ac = new AbortController()
          abortAsk = () => ac.abort()
          const pending = req.askUser({ id: 'call_1', tool: 'Bash', message: 'Allow Bash?' }, ac.signal)
          askStarted()
          try {
            answered = await pending
          } catch (error) {
            askError = error
          }
        },
        async applyAskAnswer() {
          applied += 1
          return 'matched'
        },
      }),
      gateway,
      api,
    })
    gateway.push(dmPayload({ id: 'm-abort', authorId: 'U1', content: 'please' }))
    await sawAsk
    for (let i = 0; i < 20 && !api.posts.some((post) => post.content.includes('Allow')); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    abortAsk()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(answered).toBeUndefined()
    expect(askError).toBeInstanceOf(Error)
    expect((askError as Error).name).toBe('AbortError')
    expect(applied).toBe(0)
    expect(await store.listPendingAsks(sessionId)).toHaveLength(1)
    gateway.end()
    await running
  })

  test('non-allow/deny text does not submit while a pending row exists', async () => {
    const store = createMemoryStore()
    const sessionId = 'sess_stash'
    const submitted: string[] = []
    let releaseAsk!: (answer: 'allow' | 'deny') => void
    const askHeld = new Promise<'allow' | 'deny'>((resolve) => {
      releaseAsk = resolve
    })
    let askStarted!: () => void
    const sawAsk = new Promise<void>((resolve) => {
      askStarted = resolve
    })
    const gateway = new FakeDiscordGateway()
    const running = runDiscordAdapter({
      config: cfg({ allowFrom: ['U1'] }),
      pairingHome: home(),
      ledger: createMemoryDeliveries(),
      store,
      openSession: async (req) => ({
        sessionId,
        async *submitMessage(input: UserSubmitInput) {
          const text = submitText(input)
          submitted.push(text)
          if (text !== 'please') return
          await store.upsertPendingAsk({
            callId: 'call_stash',
            sessionId,
            kind: 'leftover',
            tool: 'Bash',
            message: 'Allow Bash?',
            input: { command: 'ls' },
            createdAt: 1,
          })
          const ac = new AbortController()
          askStarted()
          const answer = await Promise.race([
            req.askUser({ id: 'call_stash', tool: 'Bash', message: 'Allow Bash?' }, ac.signal),
            askHeld,
          ])
          if (answer === 'allow' || answer === 'deny') {
            await store.deletePendingAsk('call_stash')
          }
        },
        async listPendingAsks() {
          return store.listPendingAsks(sessionId)
        },
      }),
      gateway,
      api: new FakeDiscordApi(),
    })
    gateway.push(dmPayload({ id: 'm-please', authorId: 'U1', content: 'please' }))
    await sawAsk
    gateway.push(dmPayload({ id: 'm-first', authorId: 'U1', content: 'first extra' }))
    gateway.push(dmPayload({ id: 'm-second', authorId: 'U1', content: 'second extra' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(submitted).toEqual(['please'])
    releaseAsk('allow')
    gateway.end()
    await running
    expect(submitted).toEqual(['please', 'first extra'])
  })

  test('crash-resume allow text calls applyAskAnswer and does not submitMessage', async () => {
    const store = createMemoryStore()
    const sessionId = 'sess_resume'
    await store.upsertPendingAsk({
      callId: 'call_1',
      sessionId,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Allow Bash?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    const applied: Array<{ callId: string; answer: string }> = []
    const submitted: string[] = []
    const gateway = new FakeDiscordGateway()
    const running = runDiscordAdapter({
      config: cfg({ allowFrom: ['U1'] }),
      pairingHome: home(),
      ledger: createMemoryDeliveries(),
      store,
      openSession: async () => ({
        sessionId,
        async *submitMessage(input: UserSubmitInput) {
          submitted.push(submitText(input))
        },
        async applyAskAnswer(callId, answer) {
          applied.push({ callId, answer })
          await store.deletePendingAsk(callId)
          return 'matched'
        },
        listPendingAsks: () => store.listPendingAsks(sessionId),
        getPendingAsk: (callId) => store.getPendingAsk(callId),
      }),
      gateway,
      api: new FakeDiscordApi(),
    })
    gateway.push(dmPayload({ id: 'm-allow', authorId: 'U1', content: 'allow' }))
    gateway.end()
    await running
    expect(applied).toEqual([{ callId: 'call_1', answer: 'allow' }])
    expect(submitted).toEqual([])
    expect(await store.listPendingAsks(sessionId)).toHaveLength(0)
  })

  test('crash-resume extra is stashed until applyAskAnswer', async () => {
    const store = createMemoryStore()
    const sessionId = 'sess_resume_stash'
    await store.upsertPendingAsk({
      callId: 'call_1',
      sessionId,
      kind: 'leftover',
      tool: 'Bash',
      message: 'Allow Bash?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    const applied: Array<{ callId: string; answer: string }> = []
    const submitted: string[] = []
    const gateway = new FakeDiscordGateway()
    const running = runDiscordAdapter({
      config: cfg({ allowFrom: ['U1'] }),
      pairingHome: home(),
      ledger: createMemoryDeliveries(),
      store,
      openSession: async () => ({
        sessionId,
        async *submitMessage(input: UserSubmitInput) {
          submitted.push(submitText(input))
        },
        async applyAskAnswer(callId, answer) {
          applied.push({ callId, answer })
          await store.deletePendingAsk(callId)
          return 'matched'
        },
        listPendingAsks: () => store.listPendingAsks(sessionId),
        getPendingAsk: (callId) => store.getPendingAsk(callId),
      }),
      gateway,
      api: new FakeDiscordApi(),
    })
    gateway.push(dmPayload({ id: 'm-hello', authorId: 'U1', content: 'hello after crash' }))
    gateway.push(dmPayload({ id: 'm-second', authorId: 'U1', content: 'second extra' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(submitted).toEqual([])
    gateway.push(dmPayload({ id: 'm-allow', authorId: 'U1', content: 'allow' }))
    gateway.end()
    await running
    expect(applied).toEqual([{ callId: 'call_1', answer: 'allow' }])
    expect(submitted).toEqual(['hello after crash'])
  })
})
