import { deliveryKey, type DeliveryLedger, type SessionStore } from '@ravenclaw/core'
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
  DiscordBoundSession,
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
  store?: Pick<SessionStore, 'getPendingAsk' | 'listPendingAsks' | 'upsertPendingAsk'>
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
  const stashed = new Map<string, string>()
  const permits = new Map<string, PendingPermit[]>()
  const timeoutMs = opts.permissionTimeoutMs ?? DISCORD_PERMISSION_TIMEOUT_MS
  const now = opts.now ?? Date.now
  const store = opts.store

  try {
    for await (const raw of gateway.events()) {
      if (opts.signal?.aborted) break
      const inbound = normalizeDiscordMessage(raw, botUserId)
      if (!inbound) continue
      if (inbound.isBot || inbound.content.trim() === '') continue

      const key = deliveryKey('discord', inbound.id)
      if (!opts.ledger.seen(key)) continue

      if (tryResolvePermit(permits, inbound)) continue

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

      const task = handleTurn({
        inbound,
        api,
        openSession: opts.openSession,
        timeoutMs,
        now,
        turnFlights,
        stashed,
        permits,
        store,
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
  stashed: Map<string, string>
  permits: Map<string, PendingPermit[]>
  store?: Pick<SessionStore, 'getPendingAsk' | 'listPendingAsks' | 'upsertPendingAsk'>
}): Promise<void> {
  const { inbound, api } = opts
  const replyChannelId = inbound.threadId ?? inbound.channelId
  try {
    const session = await openDiscordSession(opts, inbound)
    const pending = session.listPendingAsks
      ? await session.listPendingAsks()
      : opts.store
        ? await opts.store.listPendingAsks(session.sessionId)
        : []
    if (pending.length > 0) {
      if (!opts.stashed.has(session.sessionId)) opts.stashed.set(session.sessionId, inbound.content)
      return
    }
    await submitDiscordText(opts, session, inbound)
    await flushDiscordStash(opts, session, inbound)
  } catch (error) {
    await api.createMessage({
      channelId: replyChannelId,
      content: turnFailureBody(error),
    })
  }
}

async function trySettleDurableAsk(opts: {
  inbound: DiscordInbound
  api: DiscordApi
  openSession: DiscordOpenSession
  permits: Map<string, PendingPermit[]>
  timeoutMs: number
  store?: Pick<SessionStore, 'getPendingAsk' | 'listPendingAsks' | 'upsertPendingAsk'>
  stashed: Map<string, string>
  turnFlights: Map<string, Promise<unknown>>
  now: () => number
}): Promise<boolean> {
  const answer = parsePermitReply(opts.inbound.content)
  if (answer === undefined) return false
  const session = await openDiscordSession(opts, opts.inbound, false)
  const pending = session.listPendingAsks
    ? await session.listPendingAsks()
    : opts.store
      ? await opts.store.listPendingAsks(session.sessionId)
      : []
  const callId = pending[0]?.callId
  if (callId === undefined || session.applyAskAnswer === undefined) return false
  const settled = await session.applyAskAnswer(callId, answer)
  if (settled !== 'matched') return false
  await flushDiscordStash(opts, session, opts.inbound)
  return true
}

async function submitDiscordText(
  opts: {
    api: DiscordApi
    now: () => number
    turnFlights: Map<string, Promise<unknown>>
  },
  session: DiscordBoundSession,
  inbound: DiscordInbound,
  text = inbound.content,
): Promise<void> {
  const replyChannelId = inbound.threadId ?? inbound.channelId
  await singleFlight(opts.turnFlights, session.sessionId, async () => {
    await streamChatTurn({
      session,
      text,
      clip: clipDiscordText,
      now: opts.now,
      formatError: turnFailureBody,
      transport: {
        async post(body) {
          const posted = await opts.api.createMessage({ channelId: replyChannelId, content: body })
          return { ok: posted.ok, ...(posted.id !== undefined ? { id: posted.id } : {}) }
        },
        async edit(id, body) {
          return opts.api.editMessage({ channelId: replyChannelId, messageId: id, content: body })
        },
      },
    })
  })
}

async function flushDiscordStash(
  opts: {
    api: DiscordApi
    now: () => number
    turnFlights: Map<string, Promise<unknown>>
    stashed: Map<string, string>
  },
  session: DiscordBoundSession,
  inbound: DiscordInbound,
): Promise<void> {
  const extra = opts.stashed.get(session.sessionId)
  if (extra === undefined) return
  opts.stashed.delete(session.sessionId)
  await submitDiscordText(opts, session, inbound, extra)
}

async function openDiscordSession(
  opts: {
    openSession: DiscordOpenSession
    api: DiscordApi
    permits: Map<string, PendingPermit[]>
    timeoutMs: number
    store?: Pick<SessionStore, 'getPendingAsk' | 'listPendingAsks' | 'upsertPendingAsk'>
  },
  inbound: DiscordInbound,
  replayPending = true,
): Promise<DiscordBoundSession> {
  const isDm = discordEventIsDm({ guildId: inbound.guildId })
  const sessionKey = discordSessionKey({
    channelId: inbound.channelId,
    isDm,
    ...(inbound.guildId !== undefined ? { guildId: inbound.guildId } : {}),
    ...(inbound.threadId !== undefined ? { threadId: inbound.threadId } : {}),
  })
  const req: Parameters<DiscordOpenSession>[0] = {
    sessionKey,
    permissionMode: isDm ? 'default' : 'dontAsk',
    isDm,
    askUser: (event, signal) =>
      askDiscordPermission({
        event,
        signal,
        timeoutMs: opts.timeoutMs,
        isDm,
        api: opts.api,
        inbound,
        permits: opts.permits,
        getPendingAsk: opts.store?.getPendingAsk.bind(opts.store),
      }),
  }
  if (!replayPending) req.replayPending = false
  return opts.openSession(req)
}

interface PendingPermit {
  resolve: (answer: DiscordPermissionAnswer) => void
  callId: string
}

function permitKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`
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

function tryResolvePermit(permits: Map<string, PendingPermit[]>, inbound: DiscordInbound): boolean {
  const list = permits.get(permitKey(inbound.channelId, inbound.userId))
  if (!list || list.length === 0) return false
  const answer = parsePermitReply(inbound.content)
  if (answer === undefined) return false
  list[0]?.resolve(answer)
  return true
}

function parsePermitReply(text: string): DiscordPermissionAnswer | undefined {
  const trimmed = text.replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  if (trimmed === 'allow' || trimmed === 'yes') return 'allow'
  if (trimmed === 'deny' || trimmed === 'no') return 'deny'
  if (trimmed === 'skip' || trimmed === 'ignore' || trimmed === 'ignored') return 'ignored'
  return undefined
}

async function askDiscordPermission(opts: {
  event: { id: string; tool: string; message: string; childSessionId?: string }
  signal: AbortSignal
  timeoutMs: number
  isDm: boolean
  api: DiscordApi
  inbound: DiscordInbound
  permits: Map<string, PendingPermit[]>
  getPendingAsk?: (callId: string) => Promise<unknown>
}): Promise<DiscordPermissionAnswer> {
  if (!opts.isDm) return 'deny'
  const key = permitKey(opts.inbound.channelId, opts.inbound.userId)

  const child = opts.event.childSessionId ? ` child ${opts.event.childSessionId}` : ''
  const durable = opts.getPendingAsk !== undefined
  const prompt = durable
    ? `Allow \`${opts.event.tool}\`${child}? Reply allow, deny, or skip.`
    : `Allow \`${opts.event.tool}\`${child}? Reply allow, deny, or skip (${Math.round(opts.timeoutMs / 1000)}s).`

  let settle!: (answer: DiscordPermissionAnswer) => void
  let fail!: (error: Error) => void
  const waiter = new Promise<DiscordPermissionAnswer>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (answer: DiscordPermissionAnswer) => {
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
    const posted = await opts.api.createMessage({
      channelId: opts.inbound.threadId ?? opts.inbound.channelId,
      content: prompt,
    })
    if (posted.ok === false) throw new Error('discord post failed')
  } catch (error) {
    if (takePermit(opts.permits, key, finish)) {
      if (timer !== undefined) clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
    }
    throw error
  }
  return waiter
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
