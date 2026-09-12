import { describe, expect, test } from 'bun:test'
import { createMcpToolBridge } from './client'
import {
  appendDeferredMcpTools,
  deferUntilUnlocked,
  filterMcpDescriptors,
  loadMcpTools,
  mergeToolPool,
  wrapMcpTool,
  wrapMcpTools,
} from './tools'
import type { McpToolBridge, McpToolDescriptor, McpTransport } from './types'
import type { Tool, ToolContext, Turn } from '../types'

function mockTool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    parse(input: unknown) {
      return { ok: true, value: input }
    },
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return true
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute() {
      return ''
    },
  }
}

function makeTurn(): Turn {
  return {
    id: 'turn_1',
    sessionId: 'sess_1',
    messages: [],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd: '/tmp',
    model: 'dummy',
    readFiles: new Set(),
  }
}

function makeCtx(turn = makeTurn()): ToolContext {
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

function recordingBridge(
  descriptors: McpToolDescriptor[],
  calls: Array<{ name: string; input: unknown }> = [],
  result: unknown = { content: [{ type: 'text', text: 'pong' }] },
): McpToolBridge {
  return {
    async listTools() {
      return descriptors
    },
    async callTool(name, input, _opts) {
      calls.push({ name, input })
      return result
    },
    async listResources() {
      return []
    },
    async readResource(uri) {
      return { uri }
    },
    async close() {},
  }
}

const searchSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['q'],
  properties: {
    q: { type: 'string', minLength: 1 },
  },
}

describe('appendDeferredMcpTools', () => {
  test('appends new names in place and skips collisions', () => {
    const existing = [mockTool('Read'), mockTool('ToolCall')]
    const late = mockTool('mcp_late')
    const out = appendDeferredMcpTools(existing, [mockTool('Read'), late])
    expect(out).toBe(existing)
    expect(out.map((tool) => tool.name)).toEqual(['Read', 'ToolCall', 'mcp_late'])
  })
})

describe('mergeToolPool', () => {
  test('sorts builtins as a contiguous prefix, then sorted MCP tools', () => {
    const pool = mergeToolPool(
      [mockTool('Write'), mockTool('Read'), mockTool('Bash')],
      [mockTool('zeta'), mockTool('alpha')],
    )
    expect(pool.map((tool) => tool.name)).toEqual(['Bash', 'Read', 'Write', 'alpha', 'zeta'])
  })

  test('keeps the builtin prefix even when an MCP name would sort first', () => {
    const pool = mergeToolPool([mockTool('Zebra')], [mockTool('Apple')])
    expect(pool.map((tool) => tool.name)).toEqual(['Zebra', 'Apple'])
  })

  test('drops MCP tools whose names collide with builtins', () => {
    const builtinRead = mockTool('Read')
    const mcpRead = mockTool('Read')
    const mcpSearch = mockTool('search')
    const pool = mergeToolPool([builtinRead], [mcpSearch, mcpRead])
    expect(pool.map((tool) => tool.name)).toEqual(['Read', 'search'])
    expect(pool[0]).toBe(builtinRead)
    expect(pool).not.toContain(mcpRead)
  })

  test('empty MCP list returns only sorted builtins', () => {
    expect(mergeToolPool([mockTool('b'), mockTool('a')], []).map((tool) => tool.name)).toEqual([
      'a',
      'b',
    ])
  })

  test('empty builtin list returns only sorted MCP tools', () => {
    expect(mergeToolPool([], [mockTool('b'), mockTool('a')]).map((tool) => tool.name)).toEqual([
      'a',
      'b',
    ])
  })
})

describe('filterMcpDescriptors', () => {
  const descriptors: McpToolDescriptor[] = [
    { name: 'keep', description: 'keep', inputSchema: { type: 'object' } },
    { name: 'drop', description: 'drop', inputSchema: { type: 'object' } },
    { name: 'also', description: 'also', inputSchema: { type: 'object' } },
  ]

  test('tools allowlist keeps only listed server-native names', () => {
    expect(filterMcpDescriptors(descriptors, { tools: ['keep', 'also'] }).map((d) => d.name)).toEqual([
      'keep',
      'also',
    ])
  })

  test('excludeTools is applied after the allowlist', () => {
    expect(
      filterMcpDescriptors(descriptors, { tools: ['keep', 'drop'], excludeTools: ['drop'] }).map(
        (d) => d.name,
      ),
    ).toEqual(['keep'])
  })

  test('empty tools list yields no descriptors', () => {
    expect(filterMcpDescriptors(descriptors, { tools: [] })).toEqual([])
  })

  test('omitted filter returns the original list', () => {
    expect(filterMcpDescriptors(descriptors)).toBe(descriptors)
  })
})

describe('deferUntilUnlocked', () => {
  test('isEnabled is false until the turn unlocks the name', () => {
    const tool = deferUntilUnlocked(mockTool('search_docs'))
    const locked = makeTurn()
    expect(tool.isEnabled?.(makeCtx(locked))).toBe(false)
    locked.unlockedToolNames = ['search_docs']
    expect(tool.isEnabled?.(makeCtx(locked))).toBe(true)
  })

  test('still honors a prior isEnabled gate after unlock', () => {
    const inner = mockTool('search_docs')
    inner.isEnabled = () => false
    const tool = deferUntilUnlocked(inner)
    const turn = makeTurn()
    turn.unlockedToolNames = ['search_docs']
    expect(tool.isEnabled?.(makeCtx(turn))).toBe(false)
  })
})

describe('wrapMcpTool', () => {
  test('copies name, description, and inputSchema onto a RavenClaw Tool', () => {
    const descriptor: McpToolDescriptor = {
      name: 'search_docs',
      description: 'Search docs',
      inputSchema: searchSchema,
    }
    const tool = wrapMcpTool(recordingBridge([descriptor]), descriptor)
    expect(tool.name).toBe('search_docs')
    expect(tool.description).toBe('Search docs')
    expect(tool.inputSchema).toBe(searchSchema)
  })

  test('checkPermissions leftover-asks unless the descriptor is read-only', async () => {
    const mutating: McpToolDescriptor = {
      name: 'search_docs',
      description: 'Search docs',
      inputSchema: searchSchema,
    }
    const mutatingTool = wrapMcpTool(recordingBridge([mutating]), mutating)
    const leftover = await mutatingTool.checkPermissions({ q: 'mcp' }, makeCtx())
    expect(leftover.behavior).toBe('ask')
    if (leftover.behavior === 'ask') {
      expect(leftover.message.length).toBeGreaterThan(0)
      expect(leftover.saveAs).toBe('session')
    }

    const readonly = {
      name: 'search_docs',
      description: 'Search docs',
      inputSchema: searchSchema,
      readOnly: true,
    }
    const readonlyTool = wrapMcpTool(recordingBridge([readonly]), readonly)
    expect(await readonlyTool.checkPermissions({ q: 'mcp' }, makeCtx())).toEqual({
      behavior: 'allow',
      reason: 'mode',
    })
  })

  test('parse accepts input that matches the MCP schema', () => {
    const descriptor: McpToolDescriptor = {
      name: 'search_docs',
      description: 'Search docs',
      inputSchema: searchSchema,
    }
    const tool = wrapMcpTool(recordingBridge([descriptor]), descriptor)
    expect(tool.parse({ q: 'mcp' })).toEqual({ ok: true, value: { q: 'mcp' } })
  })

  test('parse rejects invalid input via parseWithSchema', () => {
    const descriptor: McpToolDescriptor = {
      name: 'search_docs',
      description: 'Search docs',
      inputSchema: searchSchema,
    }
    const tool = wrapMcpTool(recordingBridge([descriptor]), descriptor)
    const result = tool.parse({ q: '' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected parse failure')
    expect(result.message.length).toBeGreaterThan(0)
  })

  test('execute calls tools/call through the bridge and returns text content', async () => {
    const descriptor: McpToolDescriptor = {
      name: 'search_docs',
      description: 'Search docs',
      inputSchema: searchSchema,
    }
    const calls: Array<{ name: string; input: unknown }> = []
    const tool = wrapMcpTool(
      recordingBridge([descriptor], calls, {
        content: [{ type: 'text', text: 'hit 1' }, { type: 'text', text: 'hit 2' }],
      }),
      descriptor,
    )
    const output = await tool.execute({ q: 'mcp' }, makeCtx())
    expect(calls).toEqual([{ name: 'search_docs', input: { q: 'mcp' } }])
    expect(output).toBe('hit 1\nhit 2')
  })

  test('execute throws when the MCP result is an error', async () => {
    const descriptor: McpToolDescriptor = {
      name: 'search_docs',
      description: 'Search docs',
      inputSchema: searchSchema,
    }
    const tool = wrapMcpTool(
      recordingBridge([descriptor], [], {
        isError: true,
        content: [{ type: 'text', text: 'boom' }],
      }),
      descriptor,
    )
    await expect(tool.execute({ q: 'mcp' }, makeCtx())).rejects.toThrow(/boom/)
  })

  test('isEnabled is false until the turn unlocks the tool name', () => {
    const descriptor: McpToolDescriptor = {
      name: 'search_docs',
      description: 'Search docs',
      inputSchema: searchSchema,
    }
    const tool = wrapMcpTool(recordingBridge([descriptor]), descriptor)
    const turn = makeTurn()
    expect(tool.isEnabled?.(makeCtx(turn))).toBe(false)
    turn.unlockedToolNames = ['search_docs']
    expect(tool.isEnabled?.(makeCtx(turn))).toBe(true)
  })

  test('interruptBehavior is cancel', () => {
    const descriptor: McpToolDescriptor = {
      name: 'search_docs',
      description: 'Search docs',
      inputSchema: searchSchema,
    }
    expect(wrapMcpTool(recordingBridge([descriptor]), descriptor).interruptBehavior?.()).toBe('cancel')
  })

  test('execute abort mid-flight rejects and does not hang', async () => {
    const descriptor: McpToolDescriptor = {
      name: 'search_docs',
      description: 'Search docs',
      inputSchema: searchSchema,
    }
    const ac = new AbortController()
    const bridge: McpToolBridge = {
      async listTools() {
        return [descriptor]
      },
      async callTool(_name, _input, opts) {
        return new Promise((_resolve, reject) => {
          const signal = opts?.signal
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal?.aborted) {
            fail()
            return
          }
          signal?.addEventListener('abort', fail, { once: true })
        })
      },
      async listResources() {
        return []
      },
      async readResource(uri) {
        return { uri }
      },
      async close() {},
    }
    const tool = wrapMcpTool(bridge, descriptor)
    const pending = tool.execute({ q: 'mcp' }, { turn: makeTurn(), signal: ac.signal, onProgress() {} })
    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('execute refuses to start when the signal is already aborted', async () => {
    const descriptor: McpToolDescriptor = {
      name: 'search_docs',
      description: 'Search docs',
      inputSchema: searchSchema,
    }
    const calls: Array<{ name: string; input: unknown }> = []
    const tool = wrapMcpTool(recordingBridge([descriptor], calls), descriptor)
    const turn = makeTurn()
    turn.abort.abort()
    await expect(tool.execute({ q: 'mcp' }, makeCtx(turn))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(calls).toEqual([])
  })
})

describe('wrapMcpTools / loadMcpTools', () => {
  test('wrapMcpTools maps each descriptor', () => {
    const descriptors: McpToolDescriptor[] = [
      { name: 'b', description: 'B', inputSchema: { type: 'object' } },
      { name: 'a', description: 'A', inputSchema: { type: 'object' } },
    ]
    const tools = wrapMcpTools(recordingBridge(descriptors), descriptors)
    expect(tools.map((tool) => tool.name)).toEqual(['b', 'a'])
  })

  test('loadMcpTools applies tools and excludeTools after listTools', async () => {
    const descriptors: McpToolDescriptor[] = [
      { name: 'keep', description: 'keep', inputSchema: { type: 'object' } },
      { name: 'drop', description: 'drop', inputSchema: { type: 'object' } },
      { name: 'also', description: 'also', inputSchema: { type: 'object' } },
    ]
    const tools = await loadMcpTools(recordingBridge(descriptors), {
      tools: ['keep', 'drop', 'also'],
      excludeTools: ['drop'],
    })
    expect(tools.map((tool) => tool.name)).toEqual(['keep', 'also'])
  })

  test('loadMcpTools lists from the bridge and wraps each as a Tool', async () => {
    const transport: McpTransport = {
      async request(method) {
        if (method === 'initialize') {
          return { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 't' } }
        }
        if (method === 'tools/list') {
          return {
            tools: [
              {
                name: 'echo',
                description: 'Echo',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
              },
            ],
          }
        }
        if (method === 'tools/call') {
          return { content: [{ type: 'text', text: 'from-server' }] }
        }
        throw new Error(method)
      },
      async close() {},
    }
    const bridge = createMcpToolBridge(transport)
    const tools = await loadMcpTools(bridge)
    expect(tools).toHaveLength(1)
    const echo = tools[0]
    if (!echo) throw new Error('expected echo tool')
    expect(echo.name).toBe('echo')
    expect(echo.parse({ text: 'hi' }).ok).toBe(true)
    await expect(echo.execute({ text: 'hi' }, makeCtx())).resolves.toBe('from-server')
  })

  test('merged pool keeps builtins as a sorted prefix after loading MCP tools', async () => {
    const mcp = wrapMcpTools(recordingBridge([]), [
      { name: 'Apple', description: 'mcp', inputSchema: { type: 'object' } },
      { name: 'Read', description: 'collide', inputSchema: { type: 'object' } },
    ])
    const pool = mergeToolPool([mockTool('Write'), mockTool('Read')], mcp)
    expect(pool.map((tool) => tool.name)).toEqual(['Read', 'Write', 'Apple'])
    expect(pool[0]?.description).toBe('Read')
  })
})
