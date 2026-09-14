import { deliveryKey, type DeliveryLedger } from '@ravenclaw/core'
import { streamChatTurn } from '../chat-host/stream-turn'
import { issueOrReusePending } from '../pairing'
import { singleFlight } from '../serve'
import { admitDiscordEvent } from './admit'
import { createDiscordApi } from './api'
import { connectDiscordGateway } from './gateway'
import { normalizeDiscordMessage } from './normalize'
import { DISCORD_PERMISSION_TIMEOUT_MS, discordEventIsDm, discordSessionKey } from './session-key'
import type {
  DiscordApi,
  DiscordConfig,
  DiscordGateway,
  DiscordInbound,
  DiscordOpenSession,
  DiscordPermissionAnswer,
} from './types'

const DISCORD_TEXT_MAX = 2_000

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
  try {
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
      await streamChatTurn({
        session,
        text: inbound.content,
        clip: clipDiscordText,
        now: opts.now,
        formatError: turnFailureBody,
        transport: {
          async post(body) {
            const posted = await api.createMessage({ channelId: replyChannelId, content: body })
            return { ok: posted.ok, ...(posted.id !== undefined ? { id: posted.id } : {}) }
          },
          async edit(id, body) {
            return api.editMessage({ channelId: replyChannelId, messageId: id, content: body })
          },
        },
      })
    })
  } catch (error) {
    await api.createMessage({
      channelId: replyChannelId,
      content: turnFailureBody(error),
    })
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
