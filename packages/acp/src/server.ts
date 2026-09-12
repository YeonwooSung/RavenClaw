import type { RoundEnd, UserSubmitInput } from '@ravenclaw/core'
import {
  ACP_METHODS,
  AGENT_INFO,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  PERMISSION_OPTIONS,
  PERMISSION_TIMEOUT_MS,
  PROTOCOL_VERSION,
  isJsonRpcRequest,
  isRoundEnd,
  jsonRpcError,
  jsonRpcResult,
  parseIncoming,
  permissionOutcome,
  promptToSubmit,
  roundEndToStopReason,
  toSessionUpdate,
  editProposalFromInput,
  isSensitiveEditInput,
  type AcpPermissionAnswer,
  type AgentCapabilities,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcIncoming,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SessionNewParams,
  type SessionRequestPermissionParams,
  type SessionUpdate,
} from './protocol'

export type AcpEngine = {
  submitMessage(input: UserSubmitInput): AsyncGenerator<unknown, unknown>
  abort(): void
}

export type AcpSessionNewOptions = SessionNewParams

export type AcpPermissionAsk = {
  id: string
  tool: string
  input: unknown
  message: string
}

export type AcpEngineFactoryOpts = AcpSessionNewOptions & {
  requestPermission?: (
    event: AcpPermissionAsk,
    signal?: AbortSignal,
  ) => Promise<AcpPermissionAnswer>
}

export type AcpEngineFactory = (sessionId: string, opts?: AcpEngineFactoryOpts) => AcpEngine

export type AcpServerOptions = {
  engineFactory: AcpEngineFactory
  loadEngine?: (
    sessionId: string,
    opts?: AcpEngineFactoryOpts,
  ) => AcpEngine | Promise<AcpEngine>
  notify?: (notification: JsonRpcNotification) => void
  request?: (req: JsonRpcRequest) => Promise<unknown>
  permissionTimeoutMs?: number
  wait?: (ms: number) => Promise<void>
}

export type AcpServer = {
  handle(message: unknown): Promise<JsonRpcResponse>
}

export function createAcpServer(opts: AcpServerOptions): AcpServer {
  const sessions = new Map<string, AcpEngine>()
  const notify = opts.notify
  const answered = new Map<string, AcpPermissionAnswer>()
  let nextRequestId = 1
  // Inline ACP image blocks map onto UserSubmitInput.images (mediaType + data).
  const capabilities: AgentCapabilities = {
    loadSession: opts.loadEngine !== undefined,
    promptCapabilities: { image: true, audio: false, embeddedContext: false },
  }

  function emit(sessionId: string, update: SessionUpdate): void {
    if (!notify) return
    notify({
      jsonrpc: '2.0',
      method: ACP_METHODS.sessionUpdate,
      params: { sessionId, update },
    })
  }

  function factoryOpts(sessionId: string, extra?: AcpSessionNewOptions): AcpEngineFactoryOpts {
    return {
      ...extra,
      requestPermission: (event, signal) => askPermission(sessionId, event, signal),
    }
  }

  async function askPermission(
    sessionId: string,
    event: AcpPermissionAsk,
    signal?: AbortSignal,
  ): Promise<AcpPermissionAnswer> {
    const cached = answered.get(event.id)
    if (cached) return cached

    if (!opts.request || signal?.aborted) {
      answered.set(event.id, 'deny')
      return 'deny'
    }

    const proposal = editProposalFromInput(event.tool, event.input)
    const sensitive = isSensitiveEditInput(event.tool, event.input)
    const params: SessionRequestPermissionParams = {
      sessionId,
      title: `Allow ${event.tool}?`,
      toolCall: {
        toolCallId: event.id,
        title: event.tool,
        kind: 'other',
        status: 'pending',
        rawInput: event.input,
      },
      options: sensitive
        ? PERMISSION_OPTIONS.filter((option) => option.optionId !== 'allow_always')
        : PERMISSION_OPTIONS,
    }
    if (event.message !== '') params.description = event.message
    if (proposal) {
      params.path = proposal.path
      params.newText = proposal.newText
      if (proposal.oldText !== undefined) params.oldText = proposal.oldText
    }

    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: `rc-perm-${nextRequestId++}`,
      method: ACP_METHODS.sessionRequestPermission,
      params,
    }

    const timeoutMs = opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS
    const wait = opts.wait ?? defaultWait
    const answer = await racePermission(opts.request(req), wait(timeoutMs), signal)
    const resolved = sensitive && answer === 'allow_always' ? 'allow' : answer
    answered.set(event.id, resolved)
    return resolved
  }

  async function handleInitialize(id: JsonRpcId | null): Promise<JsonRpcResponse> {
    const result: InitializeResult = {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: capabilities,
      agentInfo: AGENT_INFO,
      authMethods: [],
    }
    return jsonRpcResult(id, result)
  }

  function handleSessionNew(id: JsonRpcId | null, params: unknown): JsonRpcResponse {
    const sessionId = crypto.randomUUID()
    sessions.set(sessionId, opts.engineFactory(sessionId, factoryOpts(sessionId, parseSessionNewParams(params))))
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
    const input = promptToSubmit(
      params && typeof params === 'object' ? (params as { prompt?: unknown }).prompt : undefined,
    )
    const gen = engine.submitMessage(input)
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
      if (isPermissionAsk(event)) {
        await askPermission(parsed.sessionId, event)
        continue
      }
      const update = toSessionUpdate(event)
      if (update) emit(parsed.sessionId, update)
    }
    const stopReason = roundEndToStopReason(end)
    emit(parsed.sessionId, { sessionUpdate: 'done', stopReason })
    return jsonRpcResult(id, { stopReason })
  }

  async function handleSessionLoad(
    id: JsonRpcId | null,
    params: unknown,
  ): Promise<JsonRpcResponse> {
    const parsed = parseSessionParams(params)
    if (!parsed) {
      return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, 'Invalid params')
    }
    if (sessions.has(parsed.sessionId)) {
      return jsonRpcResult(id, { sessionId: parsed.sessionId })
    }
    if (!opts.loadEngine) {
      return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, 'Method not found')
    }
    try {
      sessions.set(
        parsed.sessionId,
        await opts.loadEngine(parsed.sessionId, factoryOpts(parsed.sessionId)),
      )
      return jsonRpcResult(id, { sessionId: parsed.sessionId })
    } catch (error) {
      return jsonRpcError(
        id,
        JSON_RPC_INVALID_PARAMS,
        error instanceof Error ? error.message : 'Unknown session',
      )
    }
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
          return handleSessionNew(id, incoming.params)
        case ACP_METHODS.sessionLoad:
          return handleSessionLoad(id, incoming.params)
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

function parseSessionNewParams(params: unknown): AcpSessionNewOptions {
  if (!params || typeof params !== 'object') return {}
  const rec = params as Record<string, unknown>
  const out: AcpSessionNewOptions = {}
  if (typeof rec.cwd === 'string' && rec.cwd !== '') out.cwd = rec.cwd
  if (typeof rec.model === 'string' && rec.model !== '') out.model = rec.model
  if (Array.isArray(rec.mcpServers)) out.mcpServers = rec.mcpServers
  return out
}

function isYieldedRoundEnd(event: unknown): event is { type: 'round_end'; end: RoundEnd } {
  if (!event || typeof event !== 'object') return false
  const e = event as { type?: unknown; end?: unknown }
  return e.type === 'round_end' && isRoundEnd(e.end)
}

function isPermissionAsk(event: unknown): event is AcpPermissionAsk & { type: 'permission_ask' } {
  if (!event || typeof event !== 'object') return false
  const e = event as { type?: unknown; id?: unknown; tool?: unknown; input?: unknown; message?: unknown }
  if (e.type !== 'permission_ask' || typeof e.id !== 'string' || typeof e.tool !== 'string') {
    return false
  }
  return true
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function racePermission(
  request: Promise<unknown>,
  timeout: Promise<void>,
  signal?: AbortSignal,
): Promise<AcpPermissionAnswer> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (answer: AcpPermissionAnswer) => {
      if (settled) return
      settled = true
      resolve(answer)
    }
    void request.then((result) => finish(permissionOutcome(result))).catch(() => finish('deny'))
    void timeout.then(() => finish('deny')).catch(() => finish('deny'))
    if (!signal) return
    const onAbort = () => finish('deny')
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
