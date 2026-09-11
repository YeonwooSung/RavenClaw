import { describe, expect, test } from 'bun:test'
import { createHttpMcpTransport } from './http'

describe('createHttpMcpTransport', () => {
  test('POSTs JSON-RPC and returns result, forwarding session id', async () => {
    const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      const body = JSON.parse(String(init?.body)) as unknown
      calls.push({ url, body, headers })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
      })
    }
    const transport = createHttpMcpTransport({
      url: 'https://example.com/mcp',
      headers: { authorization: 'Bearer x' },
      fetchImpl,
    })
    const result = await transport.request('initialize', { protocolVersion: 'x' })
    expect(result).toEqual({ ok: true })
    expect(calls[0]?.url).toBe('https://example.com/mcp')
    expect(calls[0]?.headers.authorization).toBe('Bearer x')
    expect((calls[0]?.body as { method: string }).method).toBe('initialize')

    await transport.request('tools/list', {})
    expect(calls[1]?.headers['mcp-session-id']).toBe('sess-1')
  })

  test('parses an SSE data frame', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    const transport = createHttpMcpTransport({ url: 'https://example.com/mcp', fetchImpl })
    const result = await transport.request('tools/list')
    expect(result).toEqual({ tools: [] })
  })
})
