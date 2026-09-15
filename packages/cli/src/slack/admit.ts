import { isUserAllowed } from '@ravenclaw/core'
import { slackEventIsDm } from './session-key'
import type { SlackConfig, SlackInbound } from './types'

export type SlackAdmit =
  | 'ok'
  | 'deny-allowFrom'
  | 'ignore-channel'
  | 'ignore-mention'
  | 'ignore'

export function admitSlackEvent(
  event: SlackInbound,
  config: SlackConfig,
  botUserId?: string,
): SlackAdmit {
  if (event.botId !== undefined && event.botId !== '') return 'ignore'
  if (event.subtype !== undefined && event.subtype !== '') return 'ignore'
  if (botUserId !== undefined && event.userId === botUserId) return 'ignore'
  if (!isUserAllowed(event.userId, { allowedUsers: config.allowFrom })) return 'deny-allowFrom'

  const isDm = slackEventIsDm(event)
  if (isDm) return 'ok'
  if (config.channels.length === 0) return 'ignore-channel'
  if (!config.channels.includes(event.channel)) return 'ignore-channel'
  if (event.kind !== 'block_actions' && config.mentionOnly && !event.mentioned) return 'ignore-mention'
  return 'ok'
}
