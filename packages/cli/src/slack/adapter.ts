import { streamChatTurn } from '../chat-host/stream-turn'
import { singleFlight } from '../serve'
import { admitSlackEvent } from './admit'
import { createSlackWebApi } from './api'
import { normalizeSlackEnvelope } from './normalize'
import { slackEventIsDm, slackSessionKey, slackUserText } from './session-key'
import { connectSlackSocket } from './socket'
import type {
  SlackApi,
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
  const permits = new Map<string, PendingPermit>()
  const seen = new Set<string>()
  const inflight = new Set<Promise<void>>()
  const turnFlights = opts.turnFlights ?? new Map<string, Promise<unknown>>()
  const timeoutMs = opts.permissionTimeoutMs ?? SLACK_PERMISSION_TIMEOUT_MS
  const now = opts.now ?? Date.now

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
  permits: Map<string, PendingPermit>
  timeoutMs: number
  now: () => number
  turnFlights: Map<string, Promise<unknown>>
}): Promise<void> {
  const { inbound, text, api } = opts
  const isDm = slackEventIsDm(inbound)
  const threadTs = inbound.threadTs ?? inbound.ts
  const sessionKey = slackSessionKey({
    team: inbound.team,
    channel: inbound.channel,
    userId: inbound.userId,
    isDm,
    ...(isDm ? {} : { threadId: threadTs }),
  })
  const permissionMode = isDm ? 'default' : 'dontAsk'
  const session = await opts.openSession({
    sessionKey,
    permissionMode,
    isDm,
    team: inbound.team,
    channel: inbound.channel,
    userId: inbound.userId,
    ...(inbound.threadTs !== undefined ? { threadTs: inbound.threadTs } : {}),
    askUser: (event, signal) =>
      askSlackPermission({
        api,
        inbound,
        event,
        signal,
        permits: opts.permits,
        timeoutMs: opts.timeoutMs,
        isDm,
      }),
  })

  await singleFlight(opts.turnFlights, session.sessionId, async () => {
    await streamChatTurn({
      session,
      text,
      clip: clipSlackText,
      now: opts.now,
      transport: {
        async post(body) {
          const posted = await api.postMessage({
            channel: inbound.channel,
            text: body,
            threadTs,
          })
          return { ok: posted.ok, ...(posted.ts !== undefined ? { id: posted.ts } : {}) }
        },
        async edit(id, body) {
          return api.updateMessage({ channel: inbound.channel, ts: id, text: body })
        },
      },
    })
  })
}

interface PendingPermit {
  resolve: (answer: SlackPermissionAnswer) => void
}

function permitKey(team: string, channel: string, userId: string): string {
  return `${team}:${channel}:${userId}`
}

function tryResolvePermit(permits: Map<string, PendingPermit>, inbound: SlackInbound): boolean {
  const key = permitKey(inbound.team, inbound.channel, inbound.userId)
  const pending = permits.get(key)
  if (!pending) return false

  if (inbound.kind === 'block_actions') {
    const action = inbound.actionId ?? ''
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
  pending.resolve(answer)
  return true
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
  event: { id: string; tool: string; message: string }
  signal: AbortSignal
  permits: Map<string, PendingPermit>
  timeoutMs: number
  isDm: boolean
}): Promise<SlackPermissionAnswer> {
  if (!opts.isDm) return 'deny'
  const key = permitKey(opts.inbound.team, opts.inbound.channel, opts.inbound.userId)
  if (opts.permits.has(key)) return 'deny'

  const prompt = `Allow \`${opts.event.tool}\`? Reply *allow* or *deny* (${Math.round(opts.timeoutMs / 1000)}s).`
  await opts.api.postMessage({
    channel: opts.inbound.channel,
    text: prompt,
    threadTs: opts.inbound.threadTs ?? opts.inbound.ts,
    blocks: permissionBlocks(opts.event.tool, prompt),
  })

  return new Promise((resolve) => {
    const finish = (answer: SlackPermissionAnswer) => {
      if (!opts.permits.has(key)) return
      opts.permits.delete(key)
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      resolve(answer)
    }
    const onAbort = () => finish('deny')
    const timer = setTimeout(() => finish('deny'), opts.timeoutMs)
    timer.unref?.()
    opts.permits.set(key, { resolve: finish })
    if (opts.signal.aborted) {
      finish('deny')
      return
    }
    opts.signal.addEventListener('abort', onAbort)
  })
}

function permissionBlocks(tool: string, prompt: string): unknown[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: prompt } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Allow' },
          action_id: 'raven_allow',
          value: tool,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          action_id: 'raven_deny',
          value: tool,
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
