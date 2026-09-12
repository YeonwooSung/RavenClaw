import { deliveryKey, type DeliveryLedger } from '@ravenclaw/core'
import { issueOrReusePending } from '../pairing'
import { singleFlight } from '../serve'
import { admitDiscordEvent } from './admit'
import { createDiscordApi } from './api'
import { connectDiscordGateway } from './gateway'
import { normalizeDiscordMessage } from './normalize'
import { DISCORD_PERMISSION_TIMEOUT_MS, discordEventIsDm, discordSessionKey } from './session-key'
import type {
  DiscordApi,
  DiscordBoundSession,
  DiscordConfig,
  DiscordGateway,
  DiscordInbound,
  DiscordOpenSession,
  DiscordPermissionAnswer,
} from './types'

const STUB_TEXT = '…'
const DISCORD_TEXT_MAX = 2_000
const UPDATE_THROTTLE_MS = 1_000

export async function runDiscordAdapter(opts: {
  config: DiscordConfig
  openSession: DiscordOpenSession
  gateway?: DiscordGateway
  api?: DiscordApi
  ledger: DeliveryLedger
  pairingHome: string
  signal?: AbortSignal
  botUserId?: string
  permissionTimeoutMs?: number
  now?: () => number
  turnFlights?: Map<string, Promise<unknown>>
}): Promise<void> {
  if (opts.config.enabled !== true && opts.gateway === undefined) {
    throw new Error('discord is disabled (set discord.enabled: true in config.yaml)')
  }

  const api = opts.api ?? createDiscordApi(opts.config.token)
  let botUserId = opts.botUserId
  if (botUserId === undefined && api.getBotUserId) {
    try {
      botUserId = await api.getBotUserId()
    } catch {
      // mention detection still matches <@id> when botUserId is provided later
    }
  }

  const ownsGateway = opts.gateway === undefined
  const gateway = opts.gateway ?? (await connectDiscordGateway(opts.config.token, { signal: opts.signal }))
  const inflight = new Set<Promise<void>>()
  const turnFlights = opts.turnFlights ?? new Map<string, Promise<unknown>>()
  const timeoutMs = opts.permissionTimeoutMs ?? DISCORD_PERMISSION_TIMEOUT_MS
  const now = opts.now ?? Date.now

  try {
    for await (const raw of gateway.events()) {
      if (opts.signal?.aborted) break
      const inbound = normalizeDiscordMessage(raw, botUserId)
      if (!inbound) continue
      if (inbound.isBot || inbound.content.trim() === '') continue

      const key = deliveryKey('discord', inbound.id)
      if (!opts.ledger.seen(key)) continue

      const decision = admitDiscordEvent(inbound, opts.config, { home: opts.pairingHome })
      if (decision === 'pair-dm') {
        const issued = issueOrReusePending(opts.pairingHome, 'discord', inbound.userId)
        await api.createMessage({
          channelId: inbound.channelId,
          content: `pair with: raven pairing approve ${issued.code}`,
        })
        continue
      }
      if (decision !== 'ok') continue

      const task = handleTurn({
        inbound,
        api,
        openSession: opts.openSession,
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
    if (ownsGateway) await gateway.close()
  }
}

async function handleTurn(opts: {
  inbound: DiscordInbound
  api: DiscordApi
  openSession: DiscordOpenSession
  timeoutMs: number
  now: () => number
  turnFlights: Map<string, Promise<unknown>>
}): Promise<void> {
  const { inbound, api } = opts
  const isDm = discordEventIsDm({ guildId: inbound.guildId })
  const sessionKey = discordSessionKey({
    channelId: inbound.channelId,
    isDm,
    ...(inbound.guildId !== undefined ? { guildId: inbound.guildId } : {}),
    ...(inbound.threadId !== undefined ? { threadId: inbound.threadId } : {}),
  })
  const permissionMode = isDm ? 'default' : 'dontAsk'
  const replyChannelId = inbound.threadId ?? inbound.channelId
  const session = await opts.openSession({
    sessionKey,
    permissionMode,
    isDm,
    askUser: (_event, signal) =>
      askDiscordPermission({
        signal,
        timeoutMs: opts.timeoutMs,
        isDm,
      }),
  })

  await singleFlight(opts.turnFlights, session.sessionId, async () => {
    const stub = await api.createMessage({
      channelId: replyChannelId,
      content: STUB_TEXT,
    })
    let messageId = stub.ok ? stub.id : undefined
    let acc = ''
    let lastUpdate = 0

    const publish = async (final: boolean) => {
      const body = clipDiscordText(acc === '' ? (final ? '(no output)' : STUB_TEXT) : acc)
      if (messageId !== undefined) {
        const updated = await api.editMessage({
          channelId: replyChannelId,
          messageId,
          content: body,
        })
        if (updated.ok) return
      }
      const posted = await api.createMessage({
        channelId: replyChannelId,
        content: body,
      })
      if (posted.ok && posted.id !== undefined) messageId = posted.id
    }

    try {
      await consumeSubmit(session, inbound.content, async (delta) => {
        acc += delta
        const t = opts.now()
        if (t - lastUpdate >= UPDATE_THROTTLE_MS) {
          lastUpdate = t
          await publish(false)
        }
      })
      await publish(true)
    } catch (error) {
      acc = turnFailureBody(error)
      await publish(true)
    }
  })
}

async function consumeSubmit(
  session: DiscordBoundSession,
  text: string,
  onDelta: (text: string) => Promise<void>,
): Promise<void> {
  const gen = session.submitMessage(text)
  while (true) {
    const next = await gen.next()
    if (next.done) return
    const event = next.value
    if (!isRecord(event) || event.type !== 'text_delta') continue
    if (typeof event.text !== 'string' || event.text === '') continue
    await onDelta(event.text)
  }
}

async function askDiscordPermission(opts: {
  signal: AbortSignal
  timeoutMs: number
  isDm: boolean
}): Promise<DiscordPermissionAnswer> {
  if (!opts.isDm) return 'deny'
  return new Promise((resolve) => {
    let done = false
    const finish = (answer: DiscordPermissionAnswer) => {
      if (done) return
      done = true
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      resolve(answer)
    }
    const onAbort = () => finish('deny')
    const timer = setTimeout(() => finish('deny'), opts.timeoutMs)
    timer.unref?.()
    if (opts.signal.aborted) {
      finish('deny')
      return
    }
    opts.signal.addEventListener('abort', onAbort)
  })
}

function turnFailureBody(error: unknown): string {
  const name =
    error !== null && typeof error === 'object' && 'name' in error
      ? String((error as { name: unknown }).name)
      : ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'SessionLockError' || message.startsWith('session locked')) return message
  return 'turn failed'
}

function clipDiscordText(text: string): string {
  if (text.length <= DISCORD_TEXT_MAX) return text
  return `${text.slice(0, DISCORD_TEXT_MAX - 1)}…`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
