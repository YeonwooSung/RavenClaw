import type { UserSubmitInput } from '@ravenclaw/core'

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

export interface DiscordApi {
  createMessage(opts: { channelId: string; content: string }): Promise<{ ok: boolean; id?: string }>
  editMessage(opts: { channelId: string; messageId: string; content: string }): Promise<{ ok: boolean }>
  getBotUserId?(): Promise<string | undefined>
}

export interface DiscordGateway {
  events(): AsyncIterable<unknown>
  close(): Promise<void>
}

export type DiscordPermissionAnswer = 'allow' | 'deny' | 'allow_always' | 'ignored'

export interface DiscordBoundSession {
  sessionId: string
  submitMessage: (input: UserSubmitInput) => AsyncGenerator<unknown, unknown>
  applyAskAnswer?: (
    callId: string,
    answer: DiscordPermissionAnswer,
  ) => Promise<'matched' | 'unmatched'>
  listPendingAsks?: () => Promise<Array<{ callId: string }>>
  getPendingAsk?: (callId: string) => Promise<{ callId: string } | undefined>
}

export type DiscordOpenSession = (req: {
  sessionKey: string
  permissionMode: 'default' | 'dontAsk'
  isDm: boolean
  askUser: (
    event: { id: string; tool: string; message: string },
    signal: AbortSignal,
  ) => Promise<DiscordPermissionAnswer>
  replayPending?: boolean
}) => Promise<DiscordBoundSession>
