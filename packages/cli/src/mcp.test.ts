import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  createMemoryStore,
  createMcpToolBridge,
  defaultConfig,
  loadMcpTools,
  mergeToolPool,
  type McpServerConfig,
  type ModelProfile,
  type Provider,
  type ProviderChunk,
  type ProviderRequest,
  type ResolvedConfig,
  type Tool,
} from '@ravenclaw/core'
import { createRootTools, openEngine } from './engine'
import {
  loadConfiguredMcpTools,
  spawnMcpServer,
  type McpChild,
  type McpSpawnFn,
} from './mcp'

function encodeFrame(message: unknown): string {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
}

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

function fakeTransportListing(tools: Array<{ name: string; description?: string }>) {
  return {
    async request(method) {
      if (method === 'initialize') {
        return { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake' } }
      }
      if (method === 'tools/list') {
        return {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? tool.name,
            inputSchema: { type: 'object' },
          })),
        }
      }
      throw new Error(method)
    },
    async close() {},
  }
}

function fakeMcpChild(tools: Array<{ name: string }>): McpChild & {
  writes: string[]
  killed: boolean
} {
  const stdout = new EventEmitter()
  const writes: string[] = []
  let buffer = ''
  const child = {
    writes,
    killed: false,
    stdin: {
      write(chunk: string | Uint8Array) {
        buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        const messages = decodeFrames(buffer)
        const consumed = buffer.includes('\r\n\r\n')
          ? buffer.length - (buffer.split('\r\n\r\n').pop()?.length ?? 0)
          : 0
        if (consumed > 0) buffer = buffer.slice(consumed)
        for (const message of messages) {
          if (!message || typeof message !== 'object') continue
          const rec = message as { id?: unknown; method?: unknown }
          if (typeof rec.id !== 'number') continue
          if (rec.method === 'initialize') {
            stdout.emit(
              'data',
              encodeFrame({
                jsonrpc: '2.0',
                id: rec.id,
                result: {
                  protocolVersion: '2025-03-26',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'fake' },
                },
              }),
            )
          } else if (rec.method === 'tools/list') {
            stdout.emit(
              'data',
              encodeFrame({
                jsonrpc: '2.0',
                id: rec.id,
                result: {
                  tools: tools.map((tool) => ({
                    name: tool.name,
                    description: tool.name,
                    inputSchema: { type: 'object' },
                  })),
                },
              }),
            )
          } else {
            stdout.emit(
              'data',
              encodeFrame({
                jsonrpc: '2.0',
                id: rec.id,
                error: { code: -32601, message: 'Method not found' },
              }),
            )
          }
        }
        return true
      },
      end() {},
    },
    stdout,
    kill() {
      child.killed = true
      return true
    },
  }
  return child
}

describe('spawnMcpServer', () => {
  test('spawns with piped stdio and env merged onto process.env', () => {
    const calls: Array<{
      command: string
      args: readonly string[]
      options: { stdio: ['pipe', 'pipe', 'ignore']; env: NodeJS.ProcessEnv }
    }> = []
    const child = fakeMcpChild([])
    const spawnFn: McpSpawnFn = (command, args, options) => {
      calls.push({ command, args, options })
      return child
    }

    const spawned = spawnMcpServer(
      {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        env: { FOO: 'bar' },
      },
      spawnFn,
    )

    expect(spawned).toBe(child)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('npx')
    expect(calls[0]?.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '.'])
    expect(calls[0]?.options.stdio).toEqual(['pipe', 'pipe', 'ignore'])
    expect(calls[0]?.options.env.FOO).toBe('bar')
    expect(calls[0]?.options.env.PATH).toBe(process.env.PATH)
  })
})

describe('loadConfiguredMcpTools', () => {
  test('loads tools from a fake child and mergeToolPool drops colliding Read', async () => {
    const child = fakeMcpChild([{ name: 'Read' }, { name: 'mcp_ping' }])
    const loaded = await loadConfiguredMcpTools(
      [
        {
          name: 'filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        },
      ],
      { spawn: () => child },
    )

    expect(loaded.errors).toEqual([])
    expect(loaded.tools.map((tool) => tool.name)).toEqual([
      'Read',
      'mcp_ping',
      'ListMcpResources',
      'ReadMcpResource',
    ])

    const builtins = createRootTools(createMemoryStore())
    const pool = mergeToolPool(builtins, loaded.tools)
    const names = pool.map((tool) => tool.name)
    expect(names.filter((name) => name === 'Read')).toHaveLength(1)
    expect(names[0]).toBe(builtins.slice().sort((a, b) => a.name.localeCompare(b.name))[0]?.name)
    expect(names.at(-1)).toBe('mcp_ping')
    expect(names.indexOf('mcp_ping')).toBeGreaterThan(names.indexOf('Write'))
    expect(pool.find((tool) => tool.name === 'Read')).toBe(
      builtins.find((tool) => tool.name === 'Read'),
    )

    await loaded.close()
    expect(child.killed).toBe(true)
  })

  test('fake transport listing Read is dropped and mcp_ping is appended after builtins', async () => {
    const mcpTools = await loadMcpTools(
      createMcpToolBridge(fakeTransportListing([{ name: 'Read' }, { name: 'mcp_ping' }])),
    )
    const builtins = createRootTools(createMemoryStore())
    const names = mergeToolPool(builtins, mcpTools).map((tool) => tool.name)
    expect(names.filter((name) => name === 'Read')).toHaveLength(1)
    expect(names.at(-1)).toBe('mcp_ping')
    const lastBuiltin = [...builtins]
      .map((tool) => tool.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .at(-1)
    expect(lastBuiltin).toBeDefined()
    expect(names.indexOf('mcp_ping')).toBe(names.indexOf(lastBuiltin ?? '') + 1)
  })

  test('records a spawn error and still returns tools from the rest', async () => {
    const child = fakeMcpChild([{ name: 'mcp_ping' }])
    const servers: McpServerConfig[] = [
      { name: 'broken', command: 'nope' },
      { name: 'ok', command: 'fake-mcp' },
    ]
    const loaded = await loadConfiguredMcpTools(servers, {
      spawn(command) {
        if (command === 'nope') throw new Error('ENOENT')
        return child
      },
    })
    expect(loaded.errors).toEqual([{ name: 'broken', message: 'ENOENT' }])
    expect(loaded.tools.map((tool) => tool.name)).toEqual([
      'mcp_ping',
      'ListMcpResources',
      'ReadMcpResource',
    ])
    await loaded.close()
  })

  test('records a listTools failure instead of returning a quiet empty pool', async () => {
    const loaded = await loadConfiguredMcpTools([{ name: 'broken', command: 'fake-mcp' }], {
      spawn() {
        const stdout = new EventEmitter()
        return {
          stdin: {
            write() {
              return true
            },
            end() {},
          },
          stdout,
          kill() {
            return true
          },
          on(event, listener) {
            if (event === 'error') {
              queueMicrotask(() => listener(new Error('list failed')))
            }
            return this
          },
          off() {
            return this
          },
        }
      },
    })
    expect(loaded.tools).toEqual([] as Tool[])
    expect(loaded.errors).toHaveLength(1)
    expect(loaded.errors[0]?.name).toBe('broken')
    expect(loaded.errors[0]?.message).toMatch(/list failed|exited/)
    await loaded.close()
  })

  test('applies per-server tools allowlist and excludeTools', async () => {
    const child = fakeMcpChild([{ name: 'keep' }, { name: 'drop' }, { name: 'also' }])
    const loaded = await loadConfiguredMcpTools(
      [{ name: 'fs', command: 'fake-mcp', tools: ['keep', 'drop'], excludeTools: ['drop'] }],
      { spawn: () => child },
    )
    expect(loaded.errors).toEqual([])
    expect(loaded.tools.map((tool) => tool.name)).toEqual([
      'keep',
      'ListMcpResources',
      'ReadMcpResource',
    ])
    await loaded.close()
  })

  test('refresh retries a dead server and returns newly ready tools', async () => {
    const child = fakeMcpChild([{ name: 'late_ping' }])
    let attempts = 0
    const loaded = await loadConfiguredMcpTools([{ name: 'late', command: 'fake-mcp' }], {
      spawn() {
        attempts += 1
        if (attempts === 1) throw new Error('down')
        return child
      },
    })
    expect(loaded.errors).toEqual([{ name: 'late', message: 'down' }])
    expect(loaded.tools.map((tool) => tool.name)).toEqual([])
    expect(loaded.slots()).toEqual([{ name: 'late', state: 'dead' }])

    const added = await loaded.refresh()
    expect(added.map((tool) => tool.name)).toEqual([
      'late_ping',
      'ListMcpResources',
      'ReadMcpResource',
    ])
    expect(loaded.errors).toEqual([])
    expect(loaded.slots()).toEqual([{ name: 'late', state: 'ready' }])
    expect(await loaded.refresh()).toEqual([])
    await loaded.close()
    expect(child.killed).toBe(true)
  })

  test('refresh of a still-dead server does not throw', async () => {
    const loaded = await loadConfiguredMcpTools([{ name: 'broken', command: 'nope' }], {
      spawn() {
        throw new Error('ENOENT')
      },
    })
    expect(loaded.errors).toEqual([{ name: 'broken', message: 'ENOENT' }])
    await expect(loaded.refresh()).resolves.toEqual([])
    expect(loaded.slots()).toEqual([{ name: 'broken', state: 'dead' }])
    await loaded.close()
  })

  test('refresh of a hanging reconnect does not stall and later snapshot can pick it up', async () => {
    const stdout = new EventEmitter()
    const hanging: McpChild & { killed: boolean } = {
      killed: false,
      stdin: { write() {} },
      stdout,
      kill() {
        hanging.killed = true
        return true
      },
    }
    let attempts = 0
    const loaded = await loadConfiguredMcpTools([{ name: 'late', command: 'fake-mcp' }], {
      spawn() {
        attempts += 1
        if (attempts === 1) throw new Error('down')
        return hanging
      },
    })
    const started = Date.now()
    await expect(loaded.refresh()).resolves.toEqual([])
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(loaded.slots()).toEqual([{ name: 'late', state: 'connecting' }])
    await loaded.close()
  })
})

function defaultModel(id = 'dummy'): ModelProfile {
  return {
    id,
    contextWindow: 32_000,
    reserveOutputTokens: 3_200,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
  }
}

function testResolvedConfig(): ResolvedConfig {
  return {
    ...defaultConfig(),
    home: '/tmp',
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    profile: defaultModel('anthropic/claude-sonnet-4'),
  }
}

function createFakeProvider(scripts: ProviderChunk[][] = []): Provider & {
  requests: ProviderRequest[]
} {
  const requests: ProviderRequest[] = []
  const queue = [...scripts]
  return {
    id: 'fake',
    apiMode: 'openai_compat',
    requests,
    profile(model: string) {
      return defaultModel(model)
    },
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderChunk> {
      requests.push(req)
      const script = queue.shift() ?? [{ type: 'stop', reason: null }]
      for (const chunk of script) yield chunk
    },
  }
}

describe('openEngine MCP fail-open', () => {
  test('opens and keeps mcp_ping when a sibling server fails', async () => {
    const child = fakeMcpChild([{ name: 'mcp_ping' }])
    const asks: Array<{ tool: string }> = []
    const provider = createFakeProvider([
      [
        {
          type: 'tool_call',
          id: 'tc1',
          name: 'ToolCall',
          input: { name: 'mcp_ping', arguments: {} },
        },
        { type: 'stop', reason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const { engine, mcpErrors } = await openEngine({
      provider,
      store: createMemoryStore(),
      config: {
        ...testResolvedConfig(),
        mcp: {
          servers: [
            { name: 'broken', command: 'nope' },
            { name: 'ok', command: 'fake-mcp' },
          ],
        },
      },
      cwd: '/tmp',
      async askUser(event) {
        asks.push({ tool: event.tool })
        return 'deny'
      },
      spawnMcp(command) {
        if (command === 'nope') throw new Error('ENOENT nope')
        return child
      },
    })
    expect(engine.session.cwd).toBe('/tmp')
    expect(mcpErrors).toEqual([{ name: 'broken', message: 'ENOENT nope' }])

    const gen = engine.submitMessage('ping')
    while (true) {
      const next = await gen.next()
      if (next.done) break
    }
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toContain('ToolCall')
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).not.toContain('mcp_ping')
    expect(asks.some((ask) => ask.tool === 'mcp_ping')).toBe(true)
  })
})
