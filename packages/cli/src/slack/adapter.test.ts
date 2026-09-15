import { describe, expect, mock, test } from 'bun:test'
import { createMemoryStore, type UserSubmitInput } from '@ravenclaw/core'
import { admitSlackEvent } from './admit'
import { permissionBlocks, runSlackAdapter, tryResolvePermit } from './adapter'
import { normalizeSlackEnvelope } from './normalize'
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

function blockActions(over: {
  actionId?: string
  value?: string
  user?: string
  channel?: string
  team?: string
  envelopeId?: string
}): SlackSocketEnvelope {
  return {
    envelope_id: over.envelopeId ?? 'env-action',
    type: 'interactive',
    payload: {
      type: 'block_actions',
      team: { id: over.team ?? 'T1' },
      user: { id: over.user ?? 'U1' },
      channel: { id: over.channel ?? 'D1' },
      actions: [
        {
          action_id: over.actionId ?? 'raven_allow',
          value: over.value ?? 'call_1',
        },
      ],
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

function submitText(input: UserSubmitInput): string {
  return typeof input === 'string' ? input : (input.text ?? '')
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
      async *submitMessage(input: UserSubmitInput) {
        const text = submitText(input)
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

  test('overlapping turns on the same session do not call submitMessage concurrently', async () => {
    const socket = new FakeSlackSocket()
    const submitted: string[] = []
    const policies: Array<string | undefined> = []
    let abortCalls = 0
    let inFlight = 0
    let maxInFlight = 0
    let submits = 0
    let opened = 0
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstBegan!: () => void
    const sawFirst = new Promise<void>((resolve) => {
      firstBegan = resolve
    })
    let secondOpened!: () => void
    const sawSecondOpen = new Promise<void>((resolve) => {
      secondOpened = resolve
    })

    const openSession: SlackOpenSession = async () => {
      opened += 1
      if (opened === 2) secondOpened()
      return {
        sessionId: 'sess-shared',
        abort() {
          abortCalls += 1
        },
        async *submitMessage(input: UserSubmitInput) {
          submits += 1
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          submitted.push(submitText(input))
          policies.push(typeof input === 'string' ? undefined : input.turnPolicy)
          if (submits === 1) {
            firstBegan()
            await firstHeld
          }
          inFlight -= 1
          yield { type: 'text_delta', text: `pong:${submitText(input)}` }
        },
      } as SlackBoundSession
    }

    const running = runOnce({ socket, openSession })
    socket.push(appMention({ text: '<@UBOT> first', ts: '60.0', threadTs: '60.0' }))
    await sawFirst
    socket.push(appMention({ text: '<@UBOT> second', ts: '61.0', threadTs: '60.0' }))
    await sawSecondOpen
    await Promise.resolve()
    await Promise.resolve()
    expect(submits).toBe(1)
    expect(inFlight).toBe(1)
    releaseFirst()
    socket.end()
    await running
    expect(submitted).toEqual(['first', 'second'])
    expect(submits).toBe(2)
    expect(maxInFlight).toBe(1)
    expect(abortCalls).toBe(0)
    expect(policies).toEqual(['queue', 'queue'])
  })

  test('tryResolvePermit does not call abort or enqueueSteer', () => {
    const abort = mock(() => {})
    const enqueueSteer = mock(() => {})
    const permits = new Map<string, { resolve: (answer: 'allow' | 'deny' | 'allow_always') => void; callId: string }>()
    let answered: 'allow' | 'deny' | 'allow_always' | undefined
    permits.set('T1:D1:U1', {
      callId: 'call_1',
      resolve: (answer) => {
        answered = answer
      },
    })
    const resolved = tryResolvePermit(permits, {
      kind: 'block_actions',
      team: 'T1',
      channel: 'D1',
      userId: 'U1',
      text: '',
      ts: '1.0',
      mentioned: false,
      actionId: 'raven_allow',
      actionValue: 'call_1',
    })
    expect(resolved).toBe(true)
    expect(answered).toBe('allow')
    expect(abort).not.toHaveBeenCalled()
    expect(enqueueSteer).not.toHaveBeenCalled()
  })

  test('slack allow button value is the call id', () => {
    const blocks = permissionBlocks('call_1', 'Bash', 'Allow Bash?')
    const actions = (blocks[1] as { elements: Array<{ value: string; action_id: string }> }).elements
    expect(actions[0]?.value).toBe('call_1')
    expect(actions[0]?.action_id).toBe('raven_allow')
  })

  test('slack does not deny a durable pending row on timer', async () => {
    const store = createMemoryStore()
    const sessionId = 'sess_slack'
    const socket = new FakeSlackSocket()
    let answered: string | undefined
    let askStarted!: () => void
    const sawAsk = new Promise<void>((resolve) => {
      askStarted = resolve
    })
    const running = runSlackAdapter({
      config: slackConfig(),
      socket,
      api: new FakeSlackApi(),
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
    })
    socket.push(dmMessage({ text: 'please', ts: '80.0' }))
    await sawAsk
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(answered).toBeUndefined()
    expect(await store.listPendingAsks(sessionId)).toHaveLength(1)
    socket.push(dmMessage({ text: 'deny', ts: '81.0' }))
    socket.end()
    await running
  })

  test('non-allow/deny text does not submit while a pending row exists', async () => {
    const store = createMemoryStore()
    const sessionId = 'sess_stash'
    const socket = new FakeSlackSocket()
    const submitted: string[] = []
    let releaseAsk!: (answer: 'allow' | 'deny') => void
    const askHeld = new Promise<'allow' | 'deny'>((resolve) => {
      releaseAsk = resolve
    })
    let askStarted!: () => void
    const sawAsk = new Promise<void>((resolve) => {
      askStarted = resolve
    })
    const running = runSlackAdapter({
      config: slackConfig(),
      socket,
      api: new FakeSlackApi(),
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
    })
    socket.push(dmMessage({ text: 'please', ts: '90.0' }))
    await sawAsk
    socket.push(dmMessage({ text: 'first extra', ts: '91.0' }))
    socket.push(dmMessage({ text: 'second extra', ts: '92.0' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(submitted).toEqual(['please'])
    releaseAsk('allow')
    socket.end()
    await running
    expect(submitted).toEqual(['please', 'first extra'])
  })

  test('crash-resume allow button calls applyAskAnswer and does not submitMessage', async () => {
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
    const socket = new FakeSlackSocket()
    const running = runSlackAdapter({
      config: slackConfig(),
      socket,
      api: new FakeSlackApi(),
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
    })
    socket.push(blockActions({ actionId: 'raven_allow', value: 'call_1' }))
    socket.end()
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
    const socket = new FakeSlackSocket()
    const running = runSlackAdapter({
      config: slackConfig(),
      socket,
      api: new FakeSlackApi(),
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
    })
    socket.push(dmMessage({ text: 'hello after crash', ts: '100.0' }))
    socket.push(dmMessage({ text: 'second extra', ts: '101.0' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(submitted).toEqual([])
    socket.push(blockActions({ actionId: 'raven_allow', value: 'call_1', envelopeId: 'env-allow' }))
    socket.end()
    await running
    expect(applied).toEqual([{ callId: 'call_1', answer: 'allow' }])
    expect(submitted).toEqual(['hello after crash'])
  })
})

describe('normalizeSlackEnvelope identity', () => {
  test('slack events_api ignores a forged top-level user field', () => {
    const inbound = normalizeSlackEnvelope({
      type: 'events_api',
      payload: {
        team_id: 'T1',
        event: {
          type: 'app_mention',
          user: 'U_REAL',
          channel: 'C1',
          ts: '1.0',
          text: 'hi',
        },
        user: 'U_FORGED',
        userId: 'U_FORGED',
        principalId: 'U_FORGED',
      },
    })
    expect(inbound?.userId).toBe('U_REAL')
  })
})
