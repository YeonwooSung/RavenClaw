import type { SessionStore } from '@ravenclaw/core'
import { streamChatTurn } from '../chat-host/stream-turn'
import { singleFlight } from '../serve'
import { admitSlackEvent } from './admit'
import { createSlackWebApi } from './api'
import { normalizeSlackEnvelope } from './normalize'
import { slackEventIsDm, slackSessionKey, slackUserText } from './session-key'
import { connectSlackSocket } from './socket'
import type {
  SlackApi,
  SlackBoundSession,
  SlackConfig,
  SlackInbound,
  SlackOpenSession,
  SlackPermissionAnswer,
  SlackSocket,
} from './types'

export const SLACK_PERMISSION_TIMEOUT_MS = 120_000
const SLACK_TEXT_MAX = 39_000

export async function runSlackAdapter(opts: {
  config: SlackConfig
  openSession: SlackOpenSession
  socket?: SlackSocket
  api?: SlackApi
  signal?: AbortSignal
  botUserId?: string
  permissionTimeoutMs?: number
  now?: () => number
  turnFlights?: Map<string, Promise<unknown>>
  store?: Pick<SessionStore, 'getPendingAsk' | 'listPendingAsks' | 'upsertPendingAsk'>
}): Promise<void> {
  if (opts.config.enabled !== true && opts.socket === undefined) {
    throw new Error('slack is disabled (set slack.enabled: true in config.yaml)')
  }

  const api = opts.api ?? createSlackWebApi({ botToken: opts.config.botToken })
  let botUserId = opts.botUserId
  if (botUserId === undefined && api.authTest) {
    try {
      const auth = await api.authTest()
      if (auth.ok && auth.userId !== undefined) botUserId = auth.userId
    } catch {
      // mention detection falls back to any <@U…> tag
    }
  }

  const ownsSocket = opts.socket === undefined
  const socket = opts.socket ?? (await connectLive(opts.config, opts.signal))
  const permits = new Map<string, PendingPermit[]>()
  const seen = new Set<string>()
  const inflight = new Set<Promise<void>>()
  const turnFlights = opts.turnFlights ?? new Map<string, Promise<unknown>>()
  const stashed = new Map<string, string>()
  const timeoutMs = opts.permissionTimeoutMs ?? SLACK_PERMISSION_TIMEOUT_MS
  const now = opts.now ?? Date.now
  const store = opts.store

  try {
    for await (const envelope of socket.events()) {
      if (opts.signal?.aborted) break
      const envelopeId = envelope.envelope_id
      if (typeof envelopeId === 'string' && envelopeId !== '') {
        void socket.ack(envelopeId)
      }
      const inbound = normalizeSlackEnvelope(envelope, botUserId)
      if (!inbound) continue
      if (tryResolvePermit(permits, inbound)) continue

      const decision = admitSlackEvent(inbound, opts.config, botUserId)
      if (decision !== 'ok') continue
      if (
        await trySettleDurableAsk({
          inbound,
          api,
          openSession: opts.openSession,
          permits,
          timeoutMs,
          store,
          stashed,
          turnFlights,
          now,
        })
      ) {
        continue
      }
      const text = slackUserText(inbound.text)
      if (text === '') continue
      const dedupe = `${inbound.team}:${inbound.channel}:${inbound.ts}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      if (seen.size > 2_000) {
        const first = seen.values().next().value
        if (first !== undefined) seen.delete(first)
      }

      const task = handleTurn({
        inbound,
        text,
        api,
        openSession: opts.openSession,
        permits,
        timeoutMs,
        now,
        turnFlights,
        stashed,
        store,
      }).catch(() => {
        // turn failures are reported in-channel when possible
      })
      inflight.add(task)
      void task.finally(() => inflight.delete(task))
    }
  } finally {
    await Promise.allSettled([...inflight])
    if (ownsSocket) await socket.close()
  }
}

async function connectLive(config: SlackConfig, signal?: AbortSignal): Promise<SlackSocket> {
  if (config.appToken === '' || config.botToken === '') {
    throw new Error('slack requires slack.appToken (xapp-) and slack.botToken (xoxb-)')
  }
  const connectOpts: Parameters<typeof connectSlackSocket>[0] = { appToken: config.appToken }
  if (signal !== undefined) connectOpts.signal = signal
  return connectSlackSocket(connectOpts)
}

async function handleTurn(opts: {
  inbound: SlackInbound
  text: string
  api: SlackApi
  openSession: SlackOpenSession
  permits: Map<string, PendingPermit[]>
  timeoutMs: number
  now: () => number
  turnFlights: Map<string, Promise<unknown>>
  stashed: Map<string, string>
  store?: Pick<SessionStore, 'getPendingAsk' | 'listPendingAsks' | 'upsertPendingAsk'>
}): Promise<void> {
  const { inbound, text } = opts
  const session = await openSlackSession(opts, inbound)
  const pending = await listSessionPending(session, opts.store)
  if (pending.length > 0) {
    stashOne(opts.stashed, session.sessionId, text)
    return
  }
  await submitSlackText(opts, session, inbound, text)
  await flushSlackStash(opts, session, inbound)
}

async function trySettleDurableAsk(opts: {
  inbound: SlackInbound
  api: SlackApi
  openSession: SlackOpenSession
  permits: Map<string, PendingPermit[]>
  timeoutMs: number
  store?: Pick<SessionStore, 'getPendingAsk' | 'listPendingAsks' | 'upsertPendingAsk'>
  stashed: Map<string, string>
  turnFlights: Map<string, Promise<unknown>>
  now: () => number
}): Promise<boolean> {
  const answer = permissionAnswerOf(opts.inbound)
  if (answer === undefined) return false

  let callId =
    opts.inbound.kind === 'block_actions' &&
    (opts.inbound.actionValue !== undefined && opts.inbound.actionValue !== '')
      ? opts.inbound.actionValue
      : undefined
  if (callId !== undefined && opts.store) {
    const row = await opts.store.getPendingAsk(callId)
    if (!row) return false
  }

  const session = await openSlackSession(opts, opts.inbound, false)
  if (callId === undefined) {
    const pending = await listSessionPending(session, opts.store)
    callId = pending[0]?.callId
  }
  if (callId === undefined || session.applyAskAnswer === undefined) return false
  const settled = await session.applyAskAnswer(callId, answer)
  if (settled !== 'matched') return false
  await flushSlackStash(opts, session, opts.inbound)
  return true
}

function stashOne(stashed: Map<string, string>, sessionId: string, text: string): void {
  if (!stashed.has(sessionId)) stashed.set(sessionId, text)
}

async function submitSlackText(
  opts: {
    api: SlackApi
    now: () => number
    turnFlights: Map<string, Promise<unknown>>
  },
  session: SlackBoundSession,
  inbound: SlackInbound,
  text: string,
): Promise<void> {
  const threadTs = inbound.threadTs ?? inbound.ts
  await singleFlight(opts.turnFlights, session.sessionId, async () => {
    await streamChatTurn({
      session,
      text,
      clip: clipSlackText,
      now: opts.now,
      transport: {
        async post(body) {
          const posted = await opts.api.postMessage({
            channel: inbound.channel,
            text: body,
            threadTs,
          })
          return { ok: posted.ok, ...(posted.ts !== undefined ? { id: posted.ts } : {}) }
        },
        async edit(id, body) {
          return opts.api.updateMessage({ channel: inbound.channel, ts: id, text: body })
        },
      },
    })
  })
}

async function flushSlackStash(
  opts: {
    api: SlackApi
    now: () => number
    turnFlights: Map<string, Promise<unknown>>
    stashed: Map<string, string>
  },
  session: SlackBoundSession,
  inbound: SlackInbound,
): Promise<void> {
  const extra = opts.stashed.get(session.sessionId)
  if (extra === undefined) return
  opts.stashed.delete(session.sessionId)
  await submitSlackText(opts, session, inbound, extra)
}

async function openSlackSession(
  opts: {
    openSession: SlackOpenSession
    api: SlackApi
    permits: Map<string, PendingPermit[]>
    timeoutMs: number
    store?: Pick<SessionStore, 'getPendingAsk' | 'listPendingAsks' | 'upsertPendingAsk'>
  },
  inbound: SlackInbound,
  replayPending = true,
): Promise<SlackBoundSession> {
  const isDm = slackEventIsDm(inbound)
  const threadTs = inbound.threadTs ?? inbound.ts
  const sessionKey = slackSessionKey({
    team: inbound.team,
    channel: inbound.channel,
    userId: inbound.userId,
    isDm,
    ...(isDm ? {} : { threadId: threadTs }),
  })
  const req: Parameters<SlackOpenSession>[0] = {
    sessionKey,
    permissionMode: isDm ? 'default' : 'dontAsk',
    isDm,
    team: inbound.team,
    channel: inbound.channel,
    userId: inbound.userId,
    askUser: (event, signal) =>
      askSlackPermission({
        api: opts.api,
        inbound,
        event,
        signal,
        permits: opts.permits,
        timeoutMs: opts.timeoutMs,
        isDm,
        getPendingAsk: opts.store?.getPendingAsk.bind(opts.store),
      }),
  }
  if (inbound.threadTs !== undefined) req.threadTs = inbound.threadTs
  if (!replayPending) req.replayPending = false
  return opts.openSession(req)
}

async function listSessionPending(
  session: SlackBoundSession,
  store?: Pick<SessionStore, 'listPendingAsks'>,
): Promise<Array<{ callId: string }>> {
  if (session.listPendingAsks) return session.listPendingAsks()
  if (store) return store.listPendingAsks(session.sessionId)
  return []
}

interface PendingPermit {
  resolve: (answer: SlackPermissionAnswer) => void
  callId: string
}

function permitKey(team: string, channel: string, userId: string): string {
  return `${team}:${channel}:${userId}`
}

function takePermit(
  permits: Map<string, PendingPermit[]>,
  key: string,
  resolve: PendingPermit['resolve'],
): boolean {
  const list = permits.get(key)
  if (!list) return false
  const idx = list.findIndex((row) => row.resolve === resolve)
  if (idx < 0) return false
  list.splice(idx, 1)
  if (list.length === 0) permits.delete(key)
  return true
}

export function tryResolvePermit(
  permits: Map<string, PendingPermit[]>,
  inbound: SlackInbound,
): boolean {
  const key = permitKey(inbound.team, inbound.channel, inbound.userId)
  const list = permits.get(key)
  if (!list || list.length === 0) return false

  if (inbound.kind === 'block_actions') {
    const action = inbound.actionId ?? ''
    const byCall = inbound.actionValue
      ? list.find((row) => row.callId === inbound.actionValue)
      : undefined
    if (inbound.actionValue && !byCall) return false
    const pending = byCall ?? list[0]
    if (!pending) return false
    if (action === 'raven_allow' || inbound.actionValue === 'allow') {
      pending.resolve('allow')
      return true
    }
    if (action === 'raven_deny' || inbound.actionValue === 'deny') {
      pending.resolve('deny')
      return true
    }
    return false
  }

  const answer = parsePermitReply(inbound.text)
  if (answer === undefined) return false
  list[0]?.resolve(answer)
  return true
}

function permissionAnswerOf(inbound: SlackInbound): SlackPermissionAnswer | undefined {
  if (inbound.kind === 'block_actions') {
    const action = inbound.actionId ?? ''
    if (action === 'raven_allow') return 'allow'
    if (action === 'raven_deny') return 'deny'
    return undefined
  }
  return parsePermitReply(inbound.text)
}

function parsePermitReply(text: string): SlackPermissionAnswer | undefined {
  const trimmed = slackUserText(text).toLowerCase()
  if (trimmed === 'allow' || trimmed === 'yes') return 'allow'
  if (trimmed === 'deny' || trimmed === 'no') return 'deny'
  return undefined
}

async function askSlackPermission(opts: {
  api: SlackApi
  inbound: SlackInbound
  event: { id: string; tool: string; message: string; childSessionId?: string }
  signal: AbortSignal
  permits: Map<string, PendingPermit[]>
  timeoutMs: number
  isDm: boolean
  getPendingAsk?: (callId: string) => Promise<unknown>
}): Promise<SlackPermissionAnswer> {
  if (!opts.isDm) return 'deny'
  const key = permitKey(opts.inbound.team, opts.inbound.channel, opts.inbound.userId)

  const child = opts.event.childSessionId ? ` child ${opts.event.childSessionId}` : ''
  const durable = opts.getPendingAsk !== undefined
  const prompt = durable
    ? `Allow \`${opts.event.tool}\`${child}? Reply *allow* or *deny*.`
    : `Allow \`${opts.event.tool}\`${child}? Reply *allow* or *deny* (${Math.round(opts.timeoutMs / 1000)}s).`

  let settle!: (answer: SlackPermissionAnswer) => void
  let fail!: (error: Error) => void
  const waiter = new Promise<SlackPermissionAnswer>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (answer: SlackPermissionAnswer) => {
    if (!takePermit(opts.permits, key, finish)) return
    if (timer !== undefined) clearTimeout(timer)
    opts.signal.removeEventListener('abort', onAbort)
    settle(answer)
  }
  const abortWaiter = () => {
    if (!takePermit(opts.permits, key, finish)) return
    if (timer !== undefined) clearTimeout(timer)
    opts.signal.removeEventListener('abort', onAbort)
    fail(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  }
  const onAbort = () => {
    if (durable) abortWaiter()
    else finish('deny')
  }
  const list = opts.permits.get(key) ?? []
  list.push({ resolve: finish, callId: opts.event.id })
  opts.permits.set(key, list)
  if (!durable) {
    timer = setTimeout(() => finish('deny'), opts.timeoutMs)
    timer.unref?.()
  }
  if (opts.signal.aborted) {
    onAbort()
    return waiter
  }
  opts.signal.addEventListener('abort', onAbort)
  try {
    const posted = await opts.api.postMessage({
      channel: opts.inbound.channel,
      text: prompt,
      threadTs: opts.inbound.threadTs ?? opts.inbound.ts,
      blocks: permissionBlocks(opts.event.id, opts.event.tool, prompt),
    })
    if (posted.ok === false) throw new Error('slack post failed')
  } catch (error) {
    if (takePermit(opts.permits, key, finish)) {
      if (timer !== undefined) clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
    }
    throw error
  }
  return waiter
}

export function permissionBlocks(callId: string, tool: string, prompt: string): unknown[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: prompt || `Allow \`${tool}\`?` } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Allow' },
          action_id: 'raven_allow',
          value: callId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          action_id: 'raven_deny',
          value: callId,
          style: 'danger',
        },
      ],
    },
  ]
}

function clipSlackText(text: string): string {
  if (text.length <= SLACK_TEXT_MAX) return text
  return `${text.slice(0, SLACK_TEXT_MAX - 1)}…`
}
