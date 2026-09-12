export function slackSessionKey(opts: {
  team: string
  channel: string
  userId: string
  threadId?: string
  isDm: boolean
}): string {
  if (opts.isDm) return `raven:slack:${opts.team}:${opts.userId}`
  const thread = opts.threadId
  if (thread !== undefined && thread !== '') {
    return `raven:slack:${opts.team}:${opts.channel}:${thread}`
  }
  return `raven:slack:${opts.team}:${opts.channel}`
}

export function slackEventIsDm(opts: { channel: string; channelType?: string }): boolean {
  if (opts.channelType === 'im') return true
  return opts.channel.startsWith('D')
}

export function slackUserText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
