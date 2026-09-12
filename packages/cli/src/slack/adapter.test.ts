import { describe, expect, test } from 'bun:test'
import { admitSlackEvent } from './admit'
import { runSlackAdapter } from './adapter'
import { slackEventIsDm, slackSessionKey, slackUserText } from './session-key'
import type {
  SlackApi,
  SlackBoundSession,
  SlackConfig,
  SlackOpenSession,
  SlackPostMessageOpts,
  SlackSocket,
  SlackSocketEnvelope,
  SlackUpdateMessageOpts,
} from './types'

class FakeSlackSocket implements SlackSocket {
  acks: string[] = []
  private readonly items: Array<SlackSocketEnvelope | null> = []
  private readonly waiters: Array<(value: IteratorResult<SlackSocketEnvelope>) => void> = []

  push(envelope: SlackSocketEnvelope): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: envelope, done: false })
    else this.items.push(envelope)
  }

  end(): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: undefined as never, done: true })
    else this.items.push(null)
  }

  async *events(): AsyncGenerator<SlackSocketEnvelope> {
    for (;;) {
      const queued = this.items.shift()
      if (queued === null) return
      if (queued !== undefined) {
        yield queued
        continue
      }
      const next = await new Promise<IteratorResult<SlackSocketEnvelope>>((resolve) => {
        this.waiters.push(resolve)
      })
      if (next.done) return
      yield next.value
    }
  }

  async ack(envelopeId: string): Promise<void> {
    this.acks.push(envelopeId)
  }

  async close(): Promise<void> {
    this.end()
  }
}

class FakeSlackApi implements SlackApi {
  posts: Array<SlackPostMessageOpts & { ts: string }> = []
  updates: Array<SlackUpdateMessageOpts> = []
  updateFails = false

  async postMessage(opts: SlackPostMessageOpts) {
    const ts = `${this.posts.length + 1}.0`
    this.posts.push({ ...opts, ts })
    return { ok: true, ts }
  }

  async updateMessage(opts: SlackUpdateMessageOpts) {
    if (this.updateFails) return { ok: false }
    this.updates.push(opts)
    return { ok: true }
  }
}

function slackConfig(over: Partial<SlackConfig> = {}): SlackConfig {
  return {
    enabled: true,
    appToken: 'xapp-test',
    botToken: 'xoxb-test',
    allowFrom: ['U1'],
    channels: ['C1'],
    mentionOnly: true,
    ...over,
  }
}

function appMention(over: {
  text?: string
  user?: string
  channel?: string
  team?: string
  ts?: string
  threadTs?: string
  envelopeId?: string
}): SlackSocketEnvelope {
  const event: Record<string, unknown> = {
    type: 'app_mention',
    user: over.user ?? 'U1',
    text: over.text ?? '<@UBOT> hello',
    channel: over.channel ?? 'C1',
    ts: over.ts ?? '10.0',
  }
  if (over.threadTs !== undefined) event.thread_ts = over.threadTs
  return {
    envelope_id: over.envelopeId ?? 'env-mention',
    type: 'events_api',
    payload: { team_id: over.team ?? 'T1', event },
  }
}

function dmMessage(over: {
  text?: string
  user?: string
  channel?: string
  team?: string
  ts?: string
  envelopeId?: string
}): SlackSocketEnvelope {
  return {
    envelope_id: over.envelopeId ?? 'env-dm',
    type: 'events_api',
    payload: {
      team_id: over.team ?? 'T1',
      event: {
        type: 'message',
        channel_type: 'im',
        user: over.user ?? 'U1',
        text: over.text ?? 'hello dm',
        channel: over.channel ?? 'D1',
        ts: over.ts ?? '20.0',
      },
    },
  }
}

function channelMessage(over: {
  text?: string
  user?: string
  channel?: string
  team?: string
  ts?: string
}): SlackSocketEnvelope {
  return {
    envelope_id: 'env-msg',
    type: 'events_api',
    payload: {
      team_id: over.team ?? 'T1',
      event: {
        type: 'message',
        channel_type: 'channel',
        user: over.user ?? 'U1',
        text: over.text ?? 'no mention',
        channel: over.channel ?? 'C1',
        ts: over.ts ?? '30.0',
      },
    },
  }
}

async function runOnce(opts: {
  config?: SlackConfig
  socket: FakeSlackSocket
  api?: FakeSlackApi
  openSession: SlackOpenSession
  botUserId?: string
}): Promise<FakeSlackApi> {
  const api = opts.api ?? new FakeSlackApi()
  const adapterOpts: Parameters<typeof runSlackAdapter>[0] = {
    config: opts.config ?? slackConfig(),
    openSession: opts.openSession,
    socket: opts.socket,
    api,
  }
  if (opts.botUserId !== undefined) adapterOpts.botUserId = opts.botUserId
  await runSlackAdapter(adapterOpts)
  return api
}

function recordingSession(
  submitted: string[],
  keys: string[],
  modes?: string[],
): SlackOpenSession {
  return async (req) => {
    keys.push(req.sessionKey)
    modes?.push(req.permissionMode)
    const session: SlackBoundSession = {
      sessionId: `sess-${keys.length}`,
      async *submitMessage(text: string) {
        submitted.push(text)
        yield { type: 'text_delta', text: `pong:${text}` }
      },
    }
    return session
  }
}

describe('slackSessionKey', () => {
  test('DMs are per user; channels share a thread', () => {
    expect(
      slackSessionKey({ team: 'T1', channel: 'D9', userId: 'U1', isDm: true }),
    ).toBe('raven:slack:T1:U1')
    expect(
      slackSessionKey({ team: 'T1', channel: 'D8', userId: 'U1', isDm: true, threadId: '99.0' }),
    ).toBe('raven:slack:T1:U1')
    expect(
      slackSessionKey({ team: 'T1', channel: 'C1', userId: 'U2', isDm: false }),
    ).toBe('raven:slack:T1:C1')
    expect(
      slackSessionKey({ team: 'T1', channel: 'C1', userId: 'U2', isDm: false, threadId: '12.0' }),
    ).toBe('raven:slack:T1:C1:12.0')
    expect(
      slackSessionKey({ team: 'T1', channel: 'C1', userId: 'U9', isDm: false, threadId: '12.0' }),
    ).toBe('raven:slack:T1:C1:12.0')
  })

  test('keys are stable for the same conversation', () => {
    const a = slackSessionKey({ team: 'T1', channel: 'C1', userId: 'U1', isDm: false, threadId: '1.0' })
    const b = slackSessionKey({ team: 'T1', channel: 'C1', userId: 'U2', isDm: false, threadId: '1.0' })
    expect(a).toBe(b)
    expect(slackEventIsDm({ channel: 'D1', channelType: 'im' })).toBe(true)
    expect(slackEventIsDm({ channel: 'C1' })).toBe(false)
    expect(slackUserText('<@UBOT>  ship it')).toBe('ship it')
  })
})

describe('admitSlackEvent', () => {
  test('empty allowFrom denies everyone', () => {
    expect(
      admitSlackEvent(
        {
          kind: 'app_mention',
          team: 'T1',
          channel: 'C1',
          userId: 'U1',
          text: 'hi',
          ts: '1',
          mentioned: true,
        },
        slackConfig({ allowFrom: [] }),
      ),
    ).toBe('deny-allowFrom')
  })

  test('channel not in list is ignored', () => {
    expect(
      admitSlackEvent(
        {
          kind: 'app_mention',
          team: 'T1',
          channel: 'C999',
          userId: 'U1',
          text: 'hi',
          ts: '1',
          mentioned: true,
        },
        slackConfig({ channels: ['C1'] }),
      ),
    ).toBe('ignore-channel')
  })
})

describe('runSlackAdapter', () => {
  test('app_mention calls submitMessage with the stripped text', async () => {
    const socket = new FakeSlackSocket()
    const submitted: string[] = []
    const keys: string[] = []
    const modes: string[] = []
    const running = runOnce({
      socket,
      openSession: recordingSession(submitted, keys, modes),
    })
    socket.push(appMention({ text: '<@UBOT> hello world', ts: '11.0' }))
    socket.end()
    const api = await running
    expect(submitted).toEqual(['hello world'])
    expect(keys).toEqual(['raven:slack:T1:C1:11.0'])
    expect(modes).toEqual(['dontAsk'])
    expect(api.posts.length).toBeGreaterThanOrEqual(1)
    expect(api.posts[0]?.text).toBe('…')
    expect(api.updates.some((u) => u.text.includes('pong:hello world'))).toBe(true)
    expect(socket.acks).toContain('env-mention')
  })

  test('DM calls submitMessage with the text', async () => {
    const socket = new FakeSlackSocket()
    const submitted: string[] = []
    const keys: string[] = []
    const modes: string[] = []
    const running = runOnce({
      socket,
      openSession: recordingSession(submitted, keys, modes),
    })
    socket.push(dmMessage({ text: 'hello dm' }))
    socket.end()
    await running
    expect(submitted).toEqual(['hello dm'])
    expect(keys).toEqual(['raven:slack:T1:U1'])
    expect(modes).toEqual(['default'])
  })

  test('empty allowFrom denies inbound', async () => {
    const socket = new FakeSlackSocket()
    const submitted: string[] = []
    const running = runOnce({
      config: slackConfig({ allowFrom: [] }),
      socket,
      openSession: recordingSession(submitted, []),
    })
    socket.push(appMention({ text: '<@UBOT> hello' }))
    socket.push(dmMessage({ text: 'hello dm' }))
    socket.end()
    await running
    expect(submitted).toEqual([])
  })

  test('channel not in list is ignored', async () => {
    const socket = new FakeSlackSocket()
    const submitted: string[] = []
    const running = runOnce({
      config: slackConfig({ channels: ['C1'] }),
      socket,
      openSession: recordingSession(submitted, []),
    })
    socket.push(appMention({ channel: 'C999', text: '<@UBOT> nope' }))
    socket.end()
    await running
    expect(submitted).toEqual([])
  })

  test('empty channels list ignores channel messages and still accepts DMs', async () => {
    const socket = new FakeSlackSocket()
    const submitted: string[] = []
    const running = runOnce({
      config: slackConfig({ channels: [] }),
      socket,
      openSession: recordingSession(submitted, []),
    })
    socket.push(appMention({ text: '<@UBOT> channel' }))
    socket.push(dmMessage({ text: 'just a dm' }))
    socket.end()
    await running
    expect(submitted).toEqual(['just a dm'])
  })

  test('mentionOnly skips channel messages without an @mention', async () => {
    const socket = new FakeSlackSocket()
    const submitted: string[] = []
    const running = runOnce({
      config: slackConfig({ mentionOnly: true }),
      socket,
      botUserId: 'UBOT',
      openSession: recordingSession(submitted, []),
    })
    socket.push(channelMessage({ text: 'no mention here' }))
    socket.end()
    await running
    expect(submitted).toEqual([])
  })

  test('session key is stable across two messages in the same thread', async () => {
    const socket = new FakeSlackSocket()
    const keys: string[] = []
    const submitted: string[] = []
    const running = runOnce({
      socket,
      openSession: recordingSession(submitted, keys),
    })
    socket.push(appMention({ text: '<@UBOT> first', ts: '40.0', threadTs: '40.0' }))
    socket.push(appMention({ text: '<@UBOT> second', ts: '41.0', threadTs: '40.0' }))
    socket.end()
    await running
    expect(submitted).toEqual(['first', 'second'])
    expect(keys).toEqual(['raven:slack:T1:C1:40.0', 'raven:slack:T1:C1:40.0'])
  })

  test('chat.update follows the stub; failed update posts a new message', async () => {
    const socket = new FakeSlackSocket()
    const api = new FakeSlackApi()
    const running = runOnce({
      socket,
      api,
      openSession: recordingSession([], []),
    })
    socket.push(appMention({ text: '<@UBOT> hi', ts: '50.0' }))
    socket.end()
    await running
    expect(api.posts[0]?.text).toBe('…')
    expect(api.updates[0]?.ts).toBe('1.0')
    expect(api.updates[0]?.text).toContain('pong:hi')

    const socket2 = new FakeSlackSocket()
    const api2 = new FakeSlackApi()
    api2.updateFails = true
    const running2 = runOnce({
      socket: socket2,
      api: api2,
      openSession: recordingSession([], []),
    })
    socket2.push(appMention({ text: '<@UBOT> hi', ts: '51.0' }))
    socket2.end()
    await running2
    expect(api2.posts[0]?.text).toBe('…')
    expect(api2.posts.some((post) => post.text.includes('pong:hi'))).toBe(true)
    expect(api2.updates).toEqual([])
  })
})
