import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryDeliveries } from '@ravenclaw/core'
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
      async *submitMessage(text: string) {
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
})
