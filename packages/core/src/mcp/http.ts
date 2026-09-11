import type { McpTransport } from './types'

export interface HttpMcpTransportOpts {
  url: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  mode?: 'http' | 'sse'
}

export function createHttpMcpTransport(opts: HttpMcpTransportOpts): McpTransport {
  const fetchImpl = opts.fetchImpl ?? fetch
  let nextId = 1
  let sessionId: string | undefined
  let closed = false

  async function send(body: Record<string, unknown>, expectResult: boolean): Promise<unknown> {
    if (closed) throw new Error('MCP transport is closed')
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...opts.headers,
    }
    if (sessionId) headers['mcp-session-id'] = sessionId
    const res = await fetchImpl(opts.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const returnedSession = res.headers.get('mcp-session-id')
    if (returnedSession) sessionId = returnedSession
    if (!expectResult) return undefined
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(errText || `MCP HTTP ${res.status}`)
    }
    const ctype = res.headers.get('content-type') ?? ''
    if (ctype.includes('text/event-stream')) {
      return readSseResult(res, body.id)
    }
    const json = (await res.json()) as { result?: unknown; error?: { message?: string } }
    if (json.error) throw new Error(json.error.message || 'MCP JSON-RPC error')
    return json.result
  }

  return {
    request(method, params) {
      const id = nextId++
      const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method }
      if (params !== undefined) payload.params = params
      return send(payload, true)
    },
    async notify(method, params) {
      const payload: Record<string, unknown> = { jsonrpc: '2.0', method }
      if (params !== undefined) payload.params = params
      await send(payload, false)
    },
    async close() {
      closed = true
    },
  }
}

async function readSseResult(res: Response, id: unknown): Promise<unknown> {
  const text = await res.text()
  for (const block of text.split(/\n\n/)) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
    if (dataLines.length === 0) continue
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as {
        id?: unknown
        result?: unknown
        error?: { message?: string }
      }
      if (parsed.id !== id && parsed.id !== undefined) continue
      if (parsed.error) throw new Error(parsed.error.message || 'MCP JSON-RPC error')
      return parsed.result
    } catch (error) {
      if (error instanceof Error && error.message !== 'MCP JSON-RPC error') continue
      throw error
    }
  }
  throw new Error('MCP SSE response missing result')
}
