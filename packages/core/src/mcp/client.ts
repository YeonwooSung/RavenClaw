import { MCP_ELICIT_TIMEOUT_MS, runMcpElicit } from './elicitation'
import {
  MCP_CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  type McpElicitFn,
  type McpRequestHandler,
  type McpStdioStreams,
  type McpToolBridge,
  type McpToolDescriptor,
  type McpTransport,
  type McpTransportHealth,
} from './types'

export interface McpToolBridgeOpts {
  elicit?: McpElicitFn
  elicitTimeoutMs?: number
}

export function createMcpToolBridge(
  transport: McpTransport,
  opts?: McpToolBridgeOpts,
): McpToolBridge {
  let initialized = false
  let closed = false
  installElicitHandler(transport, opts)

  async function ensureReady(): Promise<void> {
    if (closed) throw new Error('MCP client is closed')
    if (initialized) return
    await transport.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { elicitation: {} },
      clientInfo: {
        name: MCP_CLIENT_INFO.name,
        version: MCP_CLIENT_INFO.version,
      },
    })
    try {
      await transport.notify?.('notifications/initialized', {})
    } catch {
      // optional
    }
    initialized = true
  }

  return {
    async listTools() {
      await ensureReady()
      const tools: McpToolDescriptor[] = []
      let cursor: string | undefined
      do {
        const params = cursor === undefined ? {} : { cursor }
        const raw = await transport.request('tools/list', params)
        const page = parseListToolsResult(raw)
        tools.push(...page.tools)
        cursor = page.nextCursor
      } while (cursor !== undefined)
      return tools
    },
    async callTool(name, input, opts) {
      await ensureReady()
      return transport.request(
        'tools/call',
        {
          name,
          arguments: input ?? {},
        },
        opts,
      )
    },
    async listResources() {
      await ensureReady()
      try {
        const raw = await transport.request('resources/list', {})
        return parseListResourcesResult(raw)
      } catch {
        return []
      }
    },
    async readResource(uri) {
      await ensureReady()
      return parseReadResourceResult(await transport.request('resources/read', { uri }), uri)
    },
    async close() {
      if (closed) return
      closed = true
      await transport.close()
    },
  }
}

export function createStdioMcpTransport(streams: McpStdioStreams): McpTransport {
  let nextId = 1
  let buffer = Buffer.alloc(0)
  let closed = false
  let health: McpTransportHealth = 'connecting'
  let onRequest: McpRequestHandler | undefined
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  const onData = (chunk: Buffer | string): void => {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    buffer = Buffer.concat([buffer, incoming])
    const parsed = consumeJsonRpcFrames(buffer)
    buffer = parsed.rest
    for (const message of parsed.messages) {
      dispatchJsonRpcMessage(pending, message, (id, result, error) => {
        if (closed) return
        const payload: Record<string, unknown> = { jsonrpc: '2.0', id }
        if (error) payload.error = error
        else payload.result = result
        streams.stdin.write(encodeJsonRpcFrame(payload))
      }, () => onRequest)
    }
  }

  streams.stdout.on('data', onData)

  return {
    setRequestHandler(handler) {
      onRequest = handler
    },
    request(method, params, opts) {
      if (closed) return Promise.reject(new Error('MCP transport is closed'))
      const signal = opts?.signal
      if (signal?.aborted) return Promise.reject(abortError())
      const id = nextId++
      const payload: Record<string, unknown> = {
        jsonrpc: '2.0',
        id,
        method,
      }
      if (params !== undefined) payload.params = params
      return new Promise<unknown>((resolve, reject) => {
        const onAbort = () => {
          pending.delete(id)
          reject(abortError())
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
        pending.set(id, {
          resolve(value) {
            signal?.removeEventListener('abort', onAbort)
            if (health === 'connecting') health = 'ready'
            resolve(value)
          },
          reject(error) {
            signal?.removeEventListener('abort', onAbort)
            reject(error)
          },
        })
        streams.stdin.write(encodeJsonRpcFrame(payload))
      })
    },
    health() {
      return closed ? 'dead' : health
    },
    async close() {
      if (closed) return
      closed = true
      health = 'dead'
      streams.stdout.off?.('data', onData)
      streams.stdin.end?.()
      for (const waiter of pending.values()) {
        waiter.reject(new Error('MCP transport is closed'))
      }
      pending.clear()
    },
  }
}

export function encodeJsonRpcFrame(message: unknown): string {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
}

export function consumeJsonRpcFrames(buf: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = []
  let offset = 0
  while (offset < buf.length) {
    const sep = findHeaderSeparator(buf, offset)
    if (!sep) break
    const header = buf.subarray(offset, sep.index).toString('utf8')
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match?.[1]) {
      offset = sep.index + sep.length
      continue
    }
    const length = Number(match[1])
    const bodyStart = sep.index + sep.length
    if (buf.length < bodyStart + length) break
    const body = buf.subarray(bodyStart, bodyStart + length).toString('utf8')
    messages.push(JSON.parse(body))
    offset = bodyStart + length
  }
  return { messages, rest: buf.subarray(offset) }
}

function findHeaderSeparator(
  buf: Buffer,
  offset: number,
): { index: number; length: number } | undefined {
  const crlf = buf.indexOf('\r\n\r\n', offset)
  const lf = buf.indexOf('\n\n', offset)
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, length: 4 }
  if (lf >= 0) return { index: lf, length: 2 }
  return undefined
}

type JsonRpcErrorBody = { code: number; message: string }

function dispatchJsonRpcMessage(
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>,
  message: unknown,
  reply?: (id: unknown, result: unknown, error?: JsonRpcErrorBody) => void,
  handlerOf?: () => McpRequestHandler | undefined,
): void {
  if (!message || typeof message !== 'object') return
  const rec = message as {
    id?: unknown
    method?: unknown
    params?: unknown
    result?: unknown
    error?: unknown
  }
  if (
    typeof rec.method === 'string' &&
    isJsonRpcId(rec.id) &&
    rec.result === undefined &&
    rec.error === undefined
  ) {
    void answerServerRequest(rec.method, rec.params, rec.id, reply, handlerOf)
    return
  }
  if (typeof rec.id !== 'number') return
  const waiter = pending.get(rec.id)
  if (!waiter) return
  pending.delete(rec.id)
  if (rec.error !== undefined && rec.error !== null) {
    waiter.reject(jsonRpcError(rec.error))
    return
  }
  waiter.resolve(rec.result)
}

async function answerServerRequest(
  method: string,
  params: unknown,
  id: unknown,
  reply?: (id: unknown, result: unknown, error?: JsonRpcErrorBody) => void,
  handlerOf?: () => McpRequestHandler | undefined,
): Promise<void> {
  const handler = handlerOf?.()
  if (!handler || !reply) {
    reply?.(id, undefined, { code: -32601, message: 'Method not found' })
    return
  }
  try {
    reply(id, await handler(method, params))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error'
    const code = /not found/i.test(message) ? -32601 : -32603
    reply(id, undefined, { code, message })
  }
}

function isJsonRpcId(id: unknown): id is number | string {
  return typeof id === 'number' || (typeof id === 'string' && id.length > 0)
}

function installElicitHandler(transport: McpTransport, opts?: McpToolBridgeOpts): void {
  if (!transport.setRequestHandler) return
  transport.setRequestHandler(async (method, params) => {
    if (method !== 'elicitation/create') {
      throw Object.assign(new Error('Method not found'), { code: -32601 })
    }
    return runMcpElicit(params, opts?.elicit, opts?.elicitTimeoutMs ?? MCP_ELICIT_TIMEOUT_MS)
  })
}

function jsonRpcError(error: unknown): Error {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return new Error(message)
  }
  return new Error('MCP JSON-RPC error')
}

function parseListToolsResult(raw: unknown): { tools: McpToolDescriptor[]; nextCursor?: string } {
  if (!raw || typeof raw !== 'object' || !('tools' in raw) || !Array.isArray((raw as { tools: unknown }).tools)) {
    throw new Error('MCP tools/list returned a malformed payload')
  }
  const rec = raw as { tools: unknown[]; nextCursor?: unknown }
  const tools: McpToolDescriptor[] = []
  for (const item of rec.tools) {
    const descriptor = normalizeToolDescriptor(item)
    if (descriptor) tools.push(descriptor)
  }
  if (typeof rec.nextCursor === 'string' && rec.nextCursor.length > 0) {
    return { tools, nextCursor: rec.nextCursor }
  }
  return { tools }
}

function parseListResourcesResult(raw: unknown): import('./types').McpResource[] {
  if (!raw || typeof raw !== 'object' || !('resources' in raw) || !Array.isArray((raw as { resources: unknown }).resources)) {
    return []
  }
  const out: import('./types').McpResource[] = []
  for (const item of (raw as { resources: unknown[] }).resources) {
    if (!item || typeof item !== 'object') continue
    const rec = item as { uri?: unknown; name?: unknown; mimeType?: unknown; description?: unknown }
    if (typeof rec.uri !== 'string' || rec.uri.length === 0) continue
    const row: import('./types').McpResource = { uri: rec.uri }
    if (typeof rec.name === 'string') row.name = rec.name
    if (typeof rec.mimeType === 'string') row.mimeType = rec.mimeType
    if (typeof rec.description === 'string') row.description = rec.description
    out.push(row)
  }
  return out
}

function parseReadResourceResult(raw: unknown, uri: string): import('./types').McpResourceContents {
  if (!raw || typeof raw !== 'object') return { uri }
  const rec = raw as { contents?: unknown }
  const first = Array.isArray(rec.contents) ? rec.contents[0] : raw
  if (!first || typeof first !== 'object') return { uri }
  const item = first as { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown }
  const out: import('./types').McpResourceContents = {
    uri: typeof item.uri === 'string' && item.uri.length > 0 ? item.uri : uri,
  }
  if (typeof item.mimeType === 'string') out.mimeType = item.mimeType
  if (typeof item.text === 'string') out.text = item.text
  if (typeof item.blob === 'string') out.blob = item.blob
  return out
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

function normalizeToolDescriptor(item: unknown): McpToolDescriptor | undefined {
  if (!item || typeof item !== 'object') return undefined
  const rec = item as { name?: unknown; description?: unknown; inputSchema?: unknown }
  if (typeof rec.name !== 'string' || rec.name.length === 0) return undefined
  return {
    name: rec.name,
    description: typeof rec.description === 'string' ? rec.description : '',
    inputSchema:
      rec.inputSchema && typeof rec.inputSchema === 'object' ? rec.inputSchema : { type: 'object' },
  }
}
