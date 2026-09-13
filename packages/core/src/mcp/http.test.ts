import { describe, expect, test } from 'bun:test'
import { createHttpMcpTransport } from './http'
import { MCP_AUTH_REQUIRED } from './oauth'

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

  test('POST SSE answers elicitation/create before the request result', async () => {
    let elicitPosted: unknown
    const enc = new TextEncoder()
    const fetchImpl: typeof fetch = async (_input, init) => {
      const raw = init?.body === undefined ? undefined : JSON.parse(String(init.body))
      if (raw && typeof raw === 'object' && 'result' in raw) {
        elicitPosted = raw
        return new Response(null, { status: 202 })
      }
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            enc.encode(
              'data: {"jsonrpc":"2.0","id":99,"method":"elicitation/create","params":{"requestedSchema":{"type":"object","properties":{"ok":{"type":"boolean"}}}}}\n\n',
            ),
          )
          const deadline = Date.now() + 500
          while (elicitPosted === undefined && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
          controller.enqueue(enc.encode('data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    const transport = createHttpMcpTransport({ url: 'https://example.com/mcp', fetchImpl })
    transport.setRequestHandler?.(async (method) => {
      if (method !== 'elicitation/create') throw new Error('Method not found')
      return { action: 'accept', content: { ok: true } }
    })
    await expect(transport.request('tools/call', { name: 'needs_confirm' })).resolves.toEqual({
      ok: true,
    })
    expect(elicitPosted).toEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { action: 'accept', content: { ok: true } },
    })
    await transport.close()
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

  test('sse mode waits on GET event stream when POST returns 202', async () => {
    const methods: string[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      methods.push(method)
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      if (method === 'GET') {
        expect(headers.accept).toBe('text/event-stream')
        expect(headers.authorization).toBe('Bearer x')
        return new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response(null, { status: 202 })
    }
    const transport = createHttpMcpTransport({
      url: 'https://example.com/mcp',
      headers: { authorization: 'Bearer x' },
      fetchImpl,
      mode: 'sse',
    })
    const result = await transport.request('tools/list')
    expect(result).toEqual({ tools: [] })
    expect(methods).toContain('GET')
    expect(methods).toContain('POST')
    await transport.close()
  })

  test('sse mode uses POST JSON result when the body is present', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        return new Response('', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const transport = createHttpMcpTransport({
      url: 'https://example.com/mcp',
      fetchImpl,
      mode: 'sse',
    })
    await expect(transport.request('initialize')).resolves.toEqual({ ok: true })
    await transport.close()
  })

  test('sse close aborts the GET stream', async () => {
    let getAborted = false
    const fetchImpl: typeof fetch = async (_input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          const abort = () => {
            getAborted = true
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          }
          if (signal?.aborted) {
            abort()
            return
          }
          signal?.addEventListener('abort', abort, { once: true })
        })
      }
      return new Response(null, { status: 202 })
    }
    const transport = createHttpMcpTransport({
      url: 'https://example.com/mcp',
      fetchImpl,
      mode: 'sse',
    })
    const pending = transport.request('tools/list')
    await transport.close()
    await expect(pending).rejects.toThrow(/closed|aborted/i)
    expect(getAborted).toBe(true)
  })

  test('request abort mid-flight rejects with AbortError and does not hang', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const signal = init?.signal
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal?.aborted) {
          abort()
          return
        }
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
    const transport = createHttpMcpTransport({ url: 'https://example.com/mcp', fetchImpl })
    const ac = new AbortController()
    const pending = transport.request('tools/call', { name: 'slow' }, { signal: ac.signal })
    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await transport.close()
  })

  test('401 refreshes the bearer token and retries once', async () => {
    const statuses: number[] = []
    const auths: Array<string | undefined> = []
    let token = 'old'
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      auths.push(headers.authorization)
      if (token === 'old') {
        statuses.push(401)
        return new Response('nope', { status: 401 })
      }
      statuses.push(200)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const transport = createHttpMcpTransport({
      url: 'https://example.com/mcp',
      fetchImpl,
      oauth: {
        async getAccessToken() {
          return token
        },
        async refreshAccessToken() {
          token = 'new'
          return token
        },
      },
    })
    await expect(transport.request('tools/list')).resolves.toEqual({ ok: true })
    expect(statuses).toEqual([401, 200])
    expect(auths).toEqual(['Bearer old', 'Bearer new'])
    await transport.close()
  })

  test('401 without a refresh fails closed as auth required', async () => {
    const transport = createHttpMcpTransport({
      url: 'https://example.com/mcp',
      fetchImpl: async () => new Response('nope', { status: 401 }),
      oauth: {
        async getAccessToken() {
          return 'stale'
        },
        async refreshAccessToken() {
          return undefined
        },
      },
    })
    await expect(transport.request('tools/list')).rejects.toMatchObject({ message: MCP_AUTH_REQUIRED })
    await transport.close()
  })
})
