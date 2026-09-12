import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  createMcpToolBridge,
  createStdioMcpTransport,
  encodeJsonRpcFrame,
} from './client'
import { MCP_CLIENT_INFO, MCP_PROTOCOL_VERSION, type McpTransport } from './types'

type Handler = (params: unknown) => unknown | Promise<unknown>

function fakeTransport(
  handlers: Record<string, Handler>,
): McpTransport & { calls: Array<{ method: string; params?: unknown }>; closed: boolean } {
  const calls: Array<{ method: string; params?: unknown }> = []
  const transport: McpTransport & {
    calls: Array<{ method: string; params?: unknown }>
    closed: boolean
  } = {
    calls,
    closed: false,
    async request(method, params) {
      calls.push(params === undefined ? { method } : { method, params })
      const handler = handlers[method]
      if (!handler) throw new Error(`unexpected MCP method: ${method}`)
      return handler(params)
    },
    async close() {
      transport.closed = true
    },
  }
  return transport
}

function defaultHandlers(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    initialize: () => ({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '1.0.0' },
    }),
    'tools/list': () => ({ tools: [] }),
    'tools/call': () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...over,
  }
}

describe('createMcpToolBridge', () => {
  test('listTools requests tools/list after initialize and returns descriptors', async () => {
    const transport = fakeTransport(
      defaultHandlers({
        'tools/list': () => ({
          tools: [
            {
              name: 'search_docs',
              description: 'Search docs',
              inputSchema: {
                type: 'object',
                properties: { q: { type: 'string' } },
                required: ['q'],
              },
            },
            { name: 'ping' },
          ],
        }),
      }),
    )
    const bridge = createMcpToolBridge(transport)

    const tools = await bridge.listTools()

    expect(transport.calls.map((call) => call.method)).toEqual(['initialize', 'tools/list'])
    expect(transport.calls[0]?.params).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO,
    })
    expect(tools).toEqual([
      {
        name: 'search_docs',
        description: 'Search docs',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
      {
        name: 'ping',
        description: '',
        inputSchema: { type: 'object' },
      },
    ])
  })

  test('listTools follows nextCursor until the catalog is complete', async () => {
    const pages = [
      {
        tools: [{ name: 'alpha', description: 'A', inputSchema: { type: 'object' } }],
        nextCursor: 'page-2',
      },
      {
        tools: [{ name: 'beta', description: 'B', inputSchema: { type: 'object' } }],
      },
    ]
    const transport = fakeTransport(
      defaultHandlers({
        'tools/list': (params) => {
          const cursor =
            params && typeof params === 'object' && 'cursor' in params
              ? (params as { cursor?: unknown }).cursor
              : undefined
          if (cursor === 'page-2') return pages[1]
          return pages[0]
        },
      }),
    )
    const bridge = createMcpToolBridge(transport)

    const tools = await bridge.listTools()

    expect(tools.map((tool) => tool.name)).toEqual(['alpha', 'beta'])
    const listCalls = transport.calls.filter((call) => call.method === 'tools/list')
    expect(listCalls).toHaveLength(2)
    expect(listCalls[1]?.params).toEqual({ cursor: 'page-2' })
  })

  test('callTool sends tools/call with name and arguments', async () => {
    const transport = fakeTransport(
      defaultHandlers({
        'tools/call': (params) => ({
          content: [{ type: 'text', text: `echo:${JSON.stringify(params)}` }],
        }),
      }),
    )
    const bridge = createMcpToolBridge(transport)

    const result = await bridge.callTool('search_docs', { q: 'mcp' })

    expect(transport.calls.map((call) => call.method)).toEqual(['initialize', 'tools/call'])
    expect(transport.calls[1]?.params).toEqual({
      name: 'search_docs',
      arguments: { q: 'mcp' },
    })
    expect(result).toEqual({
      content: [{ type: 'text', text: 'echo:{"name":"search_docs","arguments":{"q":"mcp"}}' }],
    })
  })

  test('initialize is sent only once across listTools and callTool', async () => {
    const transport = fakeTransport(defaultHandlers())
    const bridge = createMcpToolBridge(transport)

    await bridge.listTools()
    await bridge.callTool('ping', {})

    expect(transport.calls.filter((call) => call.method === 'initialize')).toHaveLength(1)
  })

  test('close closes the transport and later calls fail', async () => {
    const transport = fakeTransport(defaultHandlers())
    const bridge = createMcpToolBridge(transport)

    await bridge.close()
    expect(transport.closed).toBe(true)
    await expect(bridge.listTools()).rejects.toThrow(/closed/i)
    await expect(bridge.callTool('ping', {})).rejects.toThrow(/closed/i)
  })

  test('listTools skips entries without a string name', async () => {
    const transport = fakeTransport(
      defaultHandlers({
        'tools/list': () => ({
          tools: [{ description: 'no name' }, { name: 12 }, { name: 'ok', description: 'kept' }],
        }),
      }),
    )
    const bridge = createMcpToolBridge(transport)
    const tools = await bridge.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['ok'])
  })

  test('listTools rejects a malformed tools/list payload', async () => {
    const transport = fakeTransport(
      defaultHandlers({
        'tools/list': () => ({ toolz: [] }),
      }),
    )
    const bridge = createMcpToolBridge(transport)
    await expect(bridge.listTools()).rejects.toThrow(/tools\/list/i)
  })
})

function decodeFrames(raw: string): unknown[] {
  const messages: unknown[] = []
  let rest = raw
  while (rest.length > 0) {
    const headerEnd = rest.indexOf('\r\n\r\n')
    if (headerEnd < 0) break
    const header = rest.slice(0, headerEnd)
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match?.[1]) break
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    messages.push(JSON.parse(rest.slice(bodyStart, bodyStart + length)))
    rest = rest.slice(bodyStart + length)
  }
  return messages
}

function mockChild() {
  const stdout = new EventEmitter()
  const writes: string[] = []
  return {
    writes,
    stdin: {
      write(chunk: string | Uint8Array) {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        return true
      },
      end() {},
    },
    stdout,
    emit(data: string | Buffer) {
      stdout.emit('data', data)
    },
    lastRequest(): { jsonrpc: string; id: number; method: string; params?: unknown } {
      const raw = writes.join('')
      const messages = decodeFrames(raw)
      const last = messages.at(-1)
      if (!last || typeof last !== 'object') throw new Error('expected JSON-RPC request')
      return last as { jsonrpc: string; id: number; method: string; params?: unknown }
    },
  }
}

describe('createStdioMcpTransport', () => {
  test('writes Content-Length framed JSON-RPC and resolves the matching id', async () => {
    const child = mockChild()
    const transport = createStdioMcpTransport(child)
    const pending = transport.request('tools/list', {})

    const request = child.lastRequest()
    expect(request.jsonrpc).toBe('2.0')
    expect(request.method).toBe('tools/list')
    expect(typeof request.id).toBe('number')
    expect(child.writes[0]).toMatch(/^Content-Length: \d+\r\n\r\n/)

    child.emit(
      encodeJsonRpcFrame({
        jsonrpc: '2.0',
        id: request.id,
        result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] },
      }),
    )

    await expect(pending).resolves.toEqual({
      tools: [{ name: 'ping', inputSchema: { type: 'object' } }],
    })
    await transport.close()
  })

  test('reassembles a response split across data chunks', async () => {
    const child = mockChild()
    const transport = createStdioMcpTransport(child)
    const pending = transport.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION })
    const request = child.lastRequest()
    const frame = encodeJsonRpcFrame({
      jsonrpc: '2.0',
      id: request.id,
      result: { protocolVersion: MCP_PROTOCOL_VERSION },
    })
    child.emit(frame.slice(0, 12))
    child.emit(frame.slice(12))
    await expect(pending).resolves.toEqual({ protocolVersion: MCP_PROTOCOL_VERSION })
    await transport.close()
  })

  test('rejects JSON-RPC error responses', async () => {
    const child = mockChild()
    const transport = createStdioMcpTransport(child)
    const pending = transport.request('tools/call', { name: 'missing', arguments: {} })
    const request = child.lastRequest()
    child.emit(
      encodeJsonRpcFrame({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Method not found' },
      }),
    )
    await expect(pending).rejects.toThrow(/Method not found/)
    await transport.close()
  })

  test('matches concurrent responses by id, not arrival order', async () => {
    const child = mockChild()
    const transport = createStdioMcpTransport(child)
    const first = transport.request('tools/call', { name: 'one', arguments: {} })
    const firstId = child.lastRequest().id
    const second = transport.request('tools/call', { name: 'two', arguments: {} })
    const secondId = child.lastRequest().id

    child.emit(encodeJsonRpcFrame({ jsonrpc: '2.0', id: secondId, result: { ok: 2 } }))
    child.emit(encodeJsonRpcFrame({ jsonrpc: '2.0', id: firstId, result: { ok: 1 } }))

    await expect(first).resolves.toEqual({ ok: 1 })
    await expect(second).resolves.toEqual({ ok: 2 })
    await transport.close()
  })

  test('abort mid-flight rejects with AbortError and does not hang', async () => {
    const child = mockChild()
    const transport = createStdioMcpTransport(child)
    const ac = new AbortController()
    const pending = transport.request('tools/call', { name: 'slow', arguments: {} }, { signal: ac.signal })
    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await transport.close()
  })

  test('already-aborted signal rejects immediately', async () => {
    const child = mockChild()
    const transport = createStdioMcpTransport(child)
    const ac = new AbortController()
    ac.abort()
    await expect(
      transport.request('tools/call', { name: 'slow', arguments: {} }, { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await transport.close()
  })
})
