export type ChatType = 'dm' | 'group' | 'thread'

export interface InboundEvent {
  platform: string
  chatId: string
  chatType: ChatType
  userId: string
  threadId?: string
  text: string
  messageId?: string
}

// platform:chatType:chatId[:threadId][:userId]
// dm: no extra user; group: append userId; thread: chatId+threadId, no user
export function sessionKey(e: InboundEvent): string {
  const parts = [e.platform, e.chatType, e.chatId]
  if (e.chatType === 'thread') {
    if (e.threadId !== undefined && e.threadId !== '') parts.push(e.threadId)
  } else if (e.chatType === 'group') {
    parts.push(e.userId)
  }
  return parts.join(':')
}
