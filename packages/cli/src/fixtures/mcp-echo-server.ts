import { reply, replyError, serveStdio } from './mcp-stdio'

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

if (import.meta.main) {
  void serveStdio(handleMessage)
}
