import { isUserAllowed, ravenclawHome } from '@ravenclaw/core'
import { isPairingApproved } from '../pairing'
import { discordEventIsDm } from './session-key'
import type { DiscordConfig, DiscordInbound } from './types'

export type DiscordAdmit =
  | 'ok'
  | 'pair-dm'
  | 'deny-allowFrom'
  | 'ignore-channel'
  | 'ignore-mention'
  | 'ignore'

export function admitDiscordEvent(
  event: DiscordInbound,
  config: DiscordConfig,
  opts?: { home?: string },
): DiscordAdmit {
  if (event.isBot === true || event.content.trim() === '') return 'ignore'

  const home = opts?.home ?? ravenclawHome()
  const allowed =
    isUserAllowed(event.userId, { allowedUsers: config.allowFrom }) ||
    isPairingApproved(home, 'discord', event.userId)

  if (discordEventIsDm({ guildId: event.guildId })) {
    return allowed ? 'ok' : 'pair-dm'
  }

  if (config.channels.length === 0 || !config.channels.includes(event.channelId)) {
    return 'ignore-channel'
  }
  if (config.mentionOnly && !event.mentioned) return 'ignore-mention'
  if (!allowed) return 'deny-allowFrom'
  return 'ok'
}
