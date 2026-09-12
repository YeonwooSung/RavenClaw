export const DISCORD_PERMISSION_TIMEOUT_MS = 120_000

export function discordSessionKey(opts: {
  guildId?: string
  channelId: string
  threadId?: string
  isDm: boolean
}): string {
  if (opts.isDm) return `raven:discord:dm:${opts.channelId}`
  const guildId = opts.guildId ?? ''
  const thread = opts.threadId
  if (thread !== undefined && thread !== '') {
    return `raven:discord:${guildId}:${opts.channelId}:${thread}`
  }
  return `raven:discord:${guildId}:${opts.channelId}`
}

export function discordEventIsDm(opts: { guildId?: string }): boolean {
  return opts.guildId === undefined || opts.guildId === ''
}
