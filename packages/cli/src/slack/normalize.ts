import type { SlackInbound, SlackSocketEnvelope } from './types'

export function normalizeSlackEnvelope(
  envelope: SlackSocketEnvelope,
  botUserId?: string,
): SlackInbound | undefined {
  const type = envelope.type
  const payload = asRecord(envelope.payload)
  if (type === 'interactive' || looksInteractive(payload)) {
    return normalizeInteractive(envelope.envelope_id, payload)
  }
  if (type === 'events_api' || payload?.type === 'event_callback' || payload?.event !== undefined) {
    return normalizeEvent(envelope.envelope_id, payload, botUserId)
  }
  return undefined
}

function normalizeEvent(
  envelopeId: string | undefined,
  payload: Record<string, unknown> | undefined,
  botUserId?: string,
): SlackInbound | undefined {
  if (!payload) return undefined
  const event = asRecord(payload.event)
  if (!event) return undefined
  const kindRaw = asString(event.type)
  if (kindRaw !== 'message' && kindRaw !== 'app_mention') return undefined
  const channel = asString(event.channel)
  const userId = asString(event.user)
  const text = asString(event.text) ?? ''
  const ts = asString(event.ts) ?? asString(event.event_ts) ?? ''
  if (channel === undefined || userId === undefined || ts === '') return undefined
  const team =
    asString(payload.team_id) ?? asString(event.team) ?? asString(asRecord(payload.team)?.id) ?? ''
  const threadTs = asString(event.thread_ts)
  const channelType = asString(event.channel_type)
  const botId = asString(event.bot_id)
  const subtype = asString(event.subtype)
  const mentioned = kindRaw === 'app_mention' || mentionsBot(text, botUserId)
  const inbound: SlackInbound = {
    kind: kindRaw,
    team,
    channel,
    userId,
    text,
    ts,
    mentioned,
  }
  if (envelopeId !== undefined) inbound.envelopeId = envelopeId
  if (threadTs !== undefined) inbound.threadTs = threadTs
  if (channelType !== undefined) inbound.channelType = channelType
  if (botId !== undefined) inbound.botId = botId
  if (subtype !== undefined) inbound.subtype = subtype
  return inbound
}

function normalizeInteractive(
  envelopeId: string | undefined,
  payload: Record<string, unknown> | undefined,
): SlackInbound | undefined {
  if (!payload) return undefined
  if (asString(payload.type) !== 'block_actions') return undefined
  const user = asRecord(payload.user)
  const channel = asRecord(payload.channel)
  const team = asRecord(payload.team)
  const userId = asString(user?.id)
  const channelId = asString(channel?.id)
  if (userId === undefined || channelId === undefined) return undefined
  const action = firstAction(payload.actions)
  const inbound: SlackInbound = {
    kind: 'block_actions',
    team: asString(team?.id) ?? asString(payload.team_id) ?? '',
    channel: channelId,
    userId,
    text: '',
    ts: asString(payload.message_ts) ?? asString(asRecord(payload.message)?.ts) ?? '',
    mentioned: false,
  }
  if (envelopeId !== undefined) inbound.envelopeId = envelopeId
  const threadTs = asString(asRecord(payload.message)?.thread_ts)
  if (threadTs !== undefined) inbound.threadTs = threadTs
  const channelType = asString(channel?.id)?.startsWith('D') ? 'im' : undefined
  if (channelType !== undefined) inbound.channelType = channelType
  if (action?.actionId !== undefined) inbound.actionId = action.actionId
  if (action?.value !== undefined) inbound.actionValue = action.value
  return inbound
}

function firstAction(
  raw: unknown,
): { actionId?: string; value?: string } | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const rec = asRecord(raw[0])
  if (!rec) return undefined
  const actionId = asString(rec.action_id)
  const value = asString(rec.value)
  const out: { actionId?: string; value?: string } = {}
  if (actionId !== undefined) out.actionId = actionId
  if (value !== undefined) out.value = value
  return out
}

function looksInteractive(payload: Record<string, unknown> | undefined): boolean {
  return payload?.type === 'block_actions'
}

export function mentionsBot(text: string, botUserId?: string): boolean {
  if (botUserId !== undefined && botUserId !== '') {
    return text.includes(`<@${botUserId}>`)
  }
  return /<@[A-Z0-9]+>/i.test(text)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
