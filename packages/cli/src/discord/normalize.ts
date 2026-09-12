import type { DiscordInbound } from './types'

export function normalizeDiscordMessage(raw: unknown, botUserId?: string): DiscordInbound | undefined {
  const rec = asRecord(raw)
  if (!rec) return undefined
  const payload = unwrapMessageCreate(rec)
  if (!payload) return undefined

  const id = asString(payload.id)
  const channelRaw = asString(payload.channel_id)
  const author = asRecord(payload.author)
  const userId = asString(author?.id)
  if (id === undefined || channelRaw === undefined || userId === undefined) return undefined

  const content = typeof payload.content === 'string' ? payload.content : ''
  const guildId = asString(payload.guild_id)
  const isBot = author?.bot === true
  const mentioned = isMentioned(payload, content, botUserId)
  const isThread = payload.channel_type === 11 || payload.channel_type === 12
  const channelId = isThread && typeof payload.parent_id === 'string' ? payload.parent_id : channelRaw
  const threadId = isThread ? channelRaw : undefined

  const inbound: DiscordInbound = {
    id,
    channelId,
    userId,
    content,
    mentioned,
    isBot,
  }
  if (guildId !== undefined) inbound.guildId = guildId
  if (threadId !== undefined) inbound.threadId = threadId
  return inbound
}

function unwrapMessageCreate(rec: Record<string, unknown>): Record<string, unknown> | undefined {
  const t = rec.t ?? rec.type
  if (t === 'MESSAGE_CREATE' && asRecord(rec.d)) return asRecord(rec.d)
  if (typeof t === 'string' && t !== 'MESSAGE_CREATE') return undefined
  if (typeof rec.id === 'string' && typeof rec.channel_id === 'string') return rec
  return undefined
}

function isMentioned(
  payload: Record<string, unknown>,
  content: string,
  botUserId?: string,
): boolean {
  if (botUserId === undefined || botUserId === '') return false
  const mentions = payload.mentions
  if (Array.isArray(mentions)) {
    for (const mention of mentions) {
      if (mention === botUserId) return true
      const rec = asRecord(mention)
      if (rec?.id === botUserId) return true
    }
  }
  return content.includes(`<@${botUserId}>`) || content.includes(`<@!${botUserId}>`)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
