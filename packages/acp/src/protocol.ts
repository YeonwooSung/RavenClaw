import { readPackageVersion, type RoundEnd, type StreamEvent, type ToolResult } from '@ravenclaw/core'

export const PROTOCOL_VERSION = 1

export const ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionUpdate: 'session/update',
  sessionRequestPermission: 'session/request_permission',
} as const

export const PERMISSION_TIMEOUT_MS = 120_000

export const JSON_RPC_PARSE_ERROR = -32700
export const JSON_RPC_INVALID_REQUEST = -32600
export const JSON_RPC_METHOD_NOT_FOUND = -32601
export const JSON_RPC_INVALID_PARAMS = -32602
export const JSON_RPC_INTERNAL_ERROR = -32603

export const AGENT_INFO = {
  name: 'ravenclaw',
  title: 'RavenClaw',
  version: readPackageVersion(import.meta.url),
} as const

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcIncoming = JsonRpcRequest | JsonRpcNotification

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  result: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  error: JsonRpcErrorObject
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

export interface ImplementationInfo {
  name: string
  title?: string
  version?: string
}

export interface PromptCapabilities {
  image?: boolean
  audio?: boolean
  embeddedContext?: boolean
}

export interface AgentCapabilities {
  loadSession?: boolean
  promptCapabilities?: PromptCapabilities
}

export interface InitializeParams {
  protocolVersion: number
  clientCapabilities?: Record<string, unknown>
  clientInfo?: ImplementationInfo
}

export interface InitializeResult {
  protocolVersion: number
  agentCapabilities: AgentCapabilities
  agentInfo: ImplementationInfo
  authMethods: unknown[]
}

export interface SessionNewParams {
  cwd?: string
  mcpServers?: unknown[]
  model?: string
}

export type AcpPermissionAnswer = 'allow' | 'deny' | 'allow_always'

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

export interface PermissionOption {
  optionId: string
  name: string
  kind: PermissionOptionKind
}

export const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
]

export interface SessionRequestPermissionParams {
  sessionId: string
  title: string
  description?: string
  toolCall: {
    toolCallId: string
    title: string
    kind?: string
    status?: ToolCallStatus
    rawInput?: unknown
  }
  options: PermissionOption[]
}

export type SessionRequestPermissionResult =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } }

export interface SessionNewResult {
  sessionId: string
}

export interface SessionLoadParams {
  sessionId: string
}

export interface SessionLoadResult {
  sessionId: string
}

export type TextContentBlock = { type: 'text'; text: string }

export type ImageContentBlock = { type: 'image'; mimeType: string; data: string }

export type PromptContentBlock = TextContentBlock | ImageContentBlock | { type: string; text?: string }

export interface SessionPromptParams {
  sessionId: string
  prompt: PromptContentBlock[] | string
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'

export interface SessionPromptResult {
  stopReason: StopReason
}

export interface SessionCancelParams {
  sessionId: string
}

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type SessionUpdate =
  | {
      sessionUpdate: 'agent_message_chunk'
      content: TextContentBlock
    }
  | {
      sessionUpdate: 'tool_call'
      toolCallId: string
      title: string
      kind?: string
      status?: ToolCallStatus
      rawInput?: unknown
    }
  | {
      sessionUpdate: 'tool_result'
      toolCallId: string
      status?: ToolCallStatus
      content?: Array<{ type: 'content'; content: TextContentBlock }>
    }
  | {
      sessionUpdate: 'done'
      stopReason: StopReason
    }

export interface SessionUpdateParams {
  sessionId: string
  update: SessionUpdate
}

export function jsonRpcResult(id: JsonRpcId | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

export function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  const error: JsonRpcErrorObject = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id, error }
}

export function isJsonRpcRequest(message: JsonRpcIncoming): message is JsonRpcRequest {
  return 'id' in message && message.id !== undefined
}

export function extractPromptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  const parts: string[] = []
  for (const block of prompt) {
    if (!block || typeof block !== 'object') continue
    const text = (block as { text?: unknown }).text
    const type = (block as { type?: unknown }).type
    if (typeof text === 'string' && (type === undefined || type === 'text')) {
      parts.push(text)
    }
  }
  return parts.join('')
}

/** Inline ACP image parts only. uri-only images are ignored — we do not fetch. */
export function extractPromptImages(prompt: unknown): Array<{ mediaType: string; data: string }> {
  if (!Array.isArray(prompt)) return []
  const images: Array<{ mediaType: string; data: string }> = []
  for (const block of prompt) {
    if (!block || typeof block !== 'object') continue
    const rec = block as { type?: unknown; mimeType?: unknown; data?: unknown }
    if (rec.type !== 'image') continue
    if (typeof rec.mimeType !== 'string' || rec.mimeType === '') continue
    if (typeof rec.data !== 'string' || rec.data === '') continue
    images.push({ mediaType: rec.mimeType, data: rec.data })
  }
  return images
}

export function promptToSubmit(
  prompt: unknown,
): string | { text: string; images: Array<{ mediaType: string; data: string }> } {
  const text = extractPromptText(prompt)
  const images = extractPromptImages(prompt)
  if (images.length === 0) return text
  return { text, images }
}

export function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
  if (!message || typeof message !== 'object') return false
  const obj = message as Record<string, unknown>
  if ('method' in obj && obj.method !== undefined) return false
  if (obj.id === undefined) return false
  if (obj.id !== null && typeof obj.id !== 'string' && typeof obj.id !== 'number') return false
  return 'result' in obj || 'error' in obj
}

export function permissionOutcome(result: unknown): AcpPermissionAnswer {
  if (result === 'allow' || result === 'deny' || result === 'allow_always') return result
  if (typeof result === 'string') return mapPermissionOptionId(result)
  if (!result || typeof result !== 'object') return 'deny'
  const obj = result as Record<string, unknown>
  if (obj.outcome === 'cancelled') return 'deny'
  if (typeof obj.optionId === 'string') return mapPermissionOptionId(obj.optionId)
  const outcome = obj.outcome
  if (typeof outcome === 'string') return mapPermissionOptionId(outcome)
  if (outcome && typeof outcome === 'object') {
    const inner = outcome as Record<string, unknown>
    if (inner.outcome === 'cancelled') return 'deny'
    if (typeof inner.optionId === 'string') return mapPermissionOptionId(inner.optionId)
    if (typeof inner.outcome === 'string') return mapPermissionOptionId(inner.outcome)
  }
  return 'deny'
}

function mapPermissionOptionId(id: string): AcpPermissionAnswer {
  switch (id) {
    case 'allow':
    case 'allow_once':
    case 'allow-once':
    case 'allowOnce':
      return 'allow'
    case 'allow_always':
    case 'allow-always':
    case 'allowAlways':
      return 'allow_always'
    default:
      // Unknown outcomes are not approval (ACP: do not treat as selected allow).
      return 'deny'
  }
}

export function isRoundEnd(value: unknown): value is RoundEnd {
  if (!value || typeof value !== 'object') return false
  const reason = (value as { reason?: unknown }).reason
  return (
    reason === 'completed' ||
    reason === 'max_rounds' ||
    reason === 'aborted' ||
    reason === 'context_full' ||
    reason === 'model_error' ||
    reason === 'persist_failed' ||
    reason === 'results_persist_failed'
  )
}

export function roundEndToStopReason(end: unknown): StopReason {
  if (!isRoundEnd(end)) return 'end_turn'
  switch (end.reason) {
    case 'completed':
      return 'end_turn'
    case 'aborted':
      return 'cancelled'
    case 'max_rounds':
      return 'max_turn_requests'
    case 'context_full':
      return 'max_tokens'
    case 'model_error':
    case 'persist_failed':
    case 'results_persist_failed':
      return 'refusal'
  }
}

function toolResultContent(event: Record<string, unknown>): { text: string; ok: boolean } {
  const result = event.result
  if (result && typeof result === 'object') {
    const tr = result as Partial<ToolResult>
    return {
      text: typeof tr.content === 'string' ? tr.content : '',
      ok: tr.ok !== false,
    }
  }
  return {
    text: typeof event.content === 'string' ? event.content : '',
    ok: event.ok !== false,
  }
}

function toolResultId(event: Record<string, unknown>): string | undefined {
  if (typeof event.id === 'string') return event.id
  const result = event.result
  if (result && typeof result === 'object') {
    const id = (result as Partial<ToolResult>).toolUseId
    if (typeof id === 'string') return id
  }
  return undefined
}

export function toSessionUpdate(event: unknown): SessionUpdate | undefined {
  if (!event || typeof event !== 'object') return undefined
  const e = event as Record<string, unknown> & Partial<StreamEvent>
  switch (e.type) {
    case 'text_delta': {
      if (typeof e.text !== 'string') return undefined
      return {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: e.text },
      }
    }
    case 'tool_call': {
      if (typeof e.id !== 'string' || typeof e.name !== 'string') return undefined
      const update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }> = {
        sessionUpdate: 'tool_call',
        toolCallId: e.id,
        title: e.name,
        kind: 'other',
        status: 'pending',
      }
      if ('input' in e) update.rawInput = e.input
      return update
    }
    case 'tool_result': {
      const toolCallId = toolResultId(e)
      if (toolCallId === undefined) return undefined
      const { text, ok } = toolResultContent(e)
      return {
        sessionUpdate: 'tool_result',
        toolCallId,
        status: ok ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text } }],
      }
    }
    default:
      return undefined
  }
}

export function parseIncoming(message: unknown): JsonRpcIncoming | undefined {
  const raw = typeof message === 'string' ? parseJson(message) : message
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.method !== 'string') return undefined
  const incoming: JsonRpcIncoming = {
    jsonrpc: '2.0',
    method: obj.method,
  }
  if (obj.params !== undefined) incoming.params = obj.params
  if (obj.id !== undefined && obj.id !== null) {
    if (typeof obj.id !== 'string' && typeof obj.id !== 'number') return undefined
    return { ...incoming, id: obj.id }
  }
  return incoming
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
