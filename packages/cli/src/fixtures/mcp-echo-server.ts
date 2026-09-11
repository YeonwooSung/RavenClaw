const PROTOCOL_VERSION = '2025-03-26'

const ECHO_TOOL = {
  name: 'echo_n',
  description: 'Echo text back as MCP content',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
}

function encodeFrame(message: unknown): string {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
}

function consumeFrames(buf: Buffer): { messages: unknown[]; rest: Buffer } {
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

function reply(id: string | number, result: unknown): void {
  process.stdout.write(encodeFrame({ jsonrpc: '2.0', id, result }))
}

function replyError(id: string | number, message: string): void {
  process.stdout.write(
    encodeFrame({ jsonrpc: '2.0', id, error: { code: -32601, message } }),
  )
}

function handleMessage(message: unknown): void {
  if (!message || typeof message !== 'object') return
  const rec = message as { id?: unknown; method?: unknown; params?: unknown }
  if (typeof rec.method !== 'string') return
  if (typeof rec.id !== 'number' && typeof rec.id !== 'string') return

  if (rec.method === 'initialize') {
    reply(rec.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'echo', version: '0.0.0' },
    })
    return
  }

  if (rec.method === 'tools/list') {
    reply(rec.id, { tools: [ECHO_TOOL] })
    return
  }

  if (rec.method === 'tools/call') {
    const params = rec.params
    const name =
      params && typeof params === 'object' && 'name' in params
        ? (params as { name?: unknown }).name
        : undefined
    if (name !== 'echo_n') {
      replyError(rec.id, 'Unknown tool')
      return
    }
    const args =
      params && typeof params === 'object' && 'arguments' in params
        ? (params as { arguments?: unknown }).arguments
        : undefined
    const text =
      args && typeof args === 'object' && 'text' in args && typeof (args as { text?: unknown }).text === 'string'
        ? (args as { text: string }).text
        : ''
    reply(rec.id, { content: [{ type: 'text', text }] })
    return
  }

  replyError(rec.id, 'Method not found')
}

async function main(): Promise<void> {
  let buffer = Buffer.alloc(0)
  for await (const chunk of process.stdin) {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    buffer = Buffer.concat([buffer, incoming])
    const parsed = consumeFrames(buffer)
    buffer = parsed.rest
    for (const message of parsed.messages) {
      handleMessage(message)
    }
  }
}

if (import.meta.main) {
  void main()
}
