import type { RavenClawConfig, UserSubmitInput } from '@ravenclaw/core'

export type SlackConfig = NonNullable<RavenClawConfig['slack']>

export type SlackPermissionAnswer = 'allow' | 'deny' | 'allow_always'

export interface SlackSocketEnvelope {
  envelope_id?: string
  type?: string
  payload?: unknown
}

export interface SlackSocket {
  events(): AsyncIterable<SlackSocketEnvelope>
  ack(envelopeId: string): Promise<void>
  close(): Promise<void>
}

export interface SlackPostMessageOpts {
  channel: string
  text: string
  threadTs?: string
  blocks?: unknown[]
}

export interface SlackPostMessageResult {
  ok: boolean
  ts?: string
}

export interface SlackUpdateMessageOpts {
  channel: string
  ts: string
  text: string
}

export interface SlackApi {
  postMessage(opts: SlackPostMessageOpts): Promise<SlackPostMessageResult>
  updateMessage(opts: SlackUpdateMessageOpts): Promise<{ ok: boolean }>
  authTest?(): Promise<{ ok: boolean; userId?: string; teamId?: string }>
}

export interface SlackInbound {
  envelopeId?: string
  kind: 'message' | 'app_mention' | 'block_actions'
  team: string
  channel: string
  userId: string
  text: string
  ts: string
  threadTs?: string
  channelType?: string
  botId?: string
  subtype?: string
  mentioned: boolean
  actionId?: string
  actionValue?: string
}

export type SlackPermissionMode = 'default' | 'dontAsk'

export interface SlackOpenSessionOpts {
  sessionKey: string
  permissionMode: SlackPermissionMode
  isDm: boolean
  team: string
  channel: string
  userId: string
  threadTs?: string
  askUser: (
    event: { id: string; tool: string; message: string },
    signal: AbortSignal,
  ) => Promise<SlackPermissionAnswer>
  replayPending?: boolean
}

export interface SlackBoundSession {
  sessionId: string
  submitMessage: (input: UserSubmitInput) => AsyncGenerator<unknown, unknown>
  applyAskAnswer?: (
    callId: string,
    answer: SlackPermissionAnswer,
  ) => Promise<'matched' | 'unmatched'>
  listPendingAsks?: () => Promise<Array<{ callId: string }>>
  getPendingAsk?: (callId: string) => Promise<{ callId: string } | undefined>
}

export type SlackOpenSession = (opts: SlackOpenSessionOpts) => Promise<SlackBoundSession>
