export interface DiscordInbound {
  id: string
  channelId: string
  userId: string
  content: string
  guildId?: string
  threadId?: string
  mentioned: boolean
  isBot: boolean
}

export interface DiscordConfig {
  enabled: boolean
  token: string
  allowFrom: string[]
  channels: string[]
  mentionOnly: boolean
}
