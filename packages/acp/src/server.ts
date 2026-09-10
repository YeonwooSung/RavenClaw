import type { RoundEnd } from '@ravenclaw/core'
import {
  ACP_METHODS,
  AGENT_INFO,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  PROTOCOL_VERSION,
  extractPromptText,
  isJsonRpcRequest,
  isRoundEnd,
  jsonRpcError,
  jsonRpcResult,
  parseIncoming,
  roundEndToStopReason,
  toSessionUpdate,
  type AgentCapabilities,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcIncoming,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type SessionUpdate,
} from './protocol'

export type AcpEngine = {
  submitMessage(text: string): AsyncGenerator<unknown, unknown>
  abort(): void
}

export type AcpServerOptions = {
  engineFactory: (sessionId: string) => AcpEngine
  notify?: (notification: JsonRpcNotification) => void
}

export type AcpServer = {
  handle(message: unknown): Promise<JsonRpcResponse>
}

const AGENT_CAPABILITIES: AgentCapabilities = {
  loadSession: false,
  promptCapabilities: { image: false, audio: false, embeddedContext: false },
}

export function createAcpServer(opts: AcpServerOptions): AcpServer {
  const sessions = new Map<string, AcpEngine>()
  const notify = opts.notify

  function emit(sessionId: string, update: SessionUpdate): void {
    if (!notify) return
    notify({
      jsonrpc: '2.0',
      method: ACP_METHODS.sessionUpdate,
      params: { sessionId, update },
    })
  }

  async function handleInitialize(id: JsonRpcId | null): Promise<JsonRpcResponse> {
    const result: InitializeResult = {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: AGENT_CAPABILITIES,
      agentInfo: AGENT_INFO,
      authMethods: [],
    }
    return jsonRpcResult(id, result)
  }

  function handleSessionNew(id: JsonRpcId | null): JsonRpcResponse {
    const sessionId = crypto.randomUUID()
    sessions.set(sessionId, opts.engineFactory(sessionId))
    return jsonRpcResult(id, { sessionId })
  }

  async function handleSessionPrompt(
    id: JsonRpcId | null,
    params: unknown,
  ): Promise<JsonRpcResponse> {
    const parsed = parseSessionParams(params)
    if (!parsed) {
      return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, 'Invalid params')
    }
    const engine = sessions.get(parsed.sessionId)
    if (!engine) {
      return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, 'Unknown session')
    }
    const text = extractPromptText(
      params && typeof params === 'object' ? (params as { prompt?: unknown }).prompt : undefined,
    )
    const gen = engine.submitMessage(text)
    let end: unknown
    while (true) {
      const next = await gen.next()
      if (next.done) {
        if (isRoundEnd(next.value)) end = next.value
        break
      }
      const event = next.value
      if (isYieldedRoundEnd(event)) {
        end = event.end
        continue
      }
      const update = toSessionUpdate(event)
      if (update) emit(parsed.sessionId, update)
    }
    const stopReason = roundEndToStopReason(end)
    emit(parsed.sessionId, { sessionUpdate: 'done', stopReason })
    return jsonRpcResult(id, { stopReason })
  }

  function handleSessionCancel(id: JsonRpcId | null, params: unknown): JsonRpcResponse {
    const parsed = parseSessionParams(params)
    if (parsed) sessions.get(parsed.sessionId)?.abort()
    return jsonRpcResult(id, null)
  }

  return {
    async handle(message: unknown): Promise<JsonRpcResponse> {
      const incoming = parseIncoming(message)
      if (!incoming) {
        return jsonRpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid Request')
      }
      const id = requestId(incoming)
      switch (incoming.method) {
        case ACP_METHODS.initialize:
          return handleInitialize(id)
        case ACP_METHODS.sessionNew:
          return handleSessionNew(id)
        case ACP_METHODS.sessionPrompt:
          return handleSessionPrompt(id, incoming.params)
        case ACP_METHODS.sessionCancel:
          return handleSessionCancel(id, incoming.params)
        default:
          return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, 'Method not found')
      }
    },
  }
}

function requestId(message: JsonRpcIncoming): JsonRpcId | null {
  return isJsonRpcRequest(message) ? message.id : null
}

function parseSessionParams(params: unknown): { sessionId: string } | undefined {
  if (!params || typeof params !== 'object') return undefined
  const sessionId = (params as { sessionId?: unknown }).sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return { sessionId }
}

function isYieldedRoundEnd(event: unknown): event is { type: 'round_end'; end: RoundEnd } {
  if (!event || typeof event !== 'object') return false
  const e = event as { type?: unknown; end?: unknown }
  return e.type === 'round_end' && isRoundEnd(e.end)
}
