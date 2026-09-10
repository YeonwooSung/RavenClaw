import {
  MCP_CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  type McpStdioStreams,
  type McpToolBridge,
  type McpToolDescriptor,
  type McpTransport,
} from './types'

export function createMcpToolBridge(transport: McpTransport): McpToolBridge {
  let initialized = false
  let closed = false

  async function ensureReady(): Promise<void> {
    if (closed) throw new Error('MCP client is closed')
    if (initialized) return
    await transport.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: MCP_CLIENT_INFO.name,
        version: MCP_CLIENT_INFO.version,
      },
    })
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
    async callTool(name, input) {
      await ensureReady()
      return transport.request('tools/call', {
        name,
        arguments: input ?? {},
      })
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
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  const onData = (chunk: Buffer | string): void => {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    buffer = Buffer.concat([buffer, incoming])
    const parsed = consumeJsonRpcFrames(buffer)
    buffer = parsed.rest
    for (const message of parsed.messages) {
      dispatchJsonRpcMessage(pending, message)
    }
  }

  streams.stdout.on('data', onData)

  return {
    request(method, params) {
      if (closed) return Promise.reject(new Error('MCP transport is closed'))
      const id = nextId++
      const payload: Record<string, unknown> = {
        jsonrpc: '2.0',
        id,
        method,
      }
      if (params !== undefined) payload.params = params
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        streams.stdin.write(encodeJsonRpcFrame(payload))
      })
    },
    async close() {
      if (closed) return
      closed = true
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

function dispatchJsonRpcMessage(
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>,
  message: unknown,
): void {
  if (!message || typeof message !== 'object') return
  const rec = message as { id?: unknown; result?: unknown; error?: unknown }
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
