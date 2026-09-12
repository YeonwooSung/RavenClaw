import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAskUserTool,
  createMemoryStore,
  createMcpToolBridge,
  createSessionEngine,
  defaultCompactPolicy,
  defaultConfig,
  filterToolsForTurn,
  loadMcpTools,
  type ModelProfile,
  type Provider,
  type ProviderChunk,
  type ProviderRequest,
  type ResolvedConfig,
  type SessionRecord,
  type StreamEvent,
  type SystemPart,
  type Turn,
} from '@ravenclaw/core'
import { runExec } from './exec'
import { createRootTools, createSessionTools, openEngine } from './engine'

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

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_exec',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'dummy',
    permissionMode: 'dontAsk',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

function createFakeProvider(scripts: ProviderChunk[][]): Provider & {
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
    async *stream(req: ProviderRequest) {
      requests.push(req)
      const script = queue.shift() ?? [{ type: 'stop', reason: null }]
      for (const chunk of script) yield chunk
    },
  }
}

describe('createRootTools', () => {
  test('registers the root CLI tools and not Agent', () => {
    const names = createRootTools(createMemoryStore()).map((tool) => tool.name)
    expect(names).toEqual([
      'Read',
      'Grep',
      'Glob',
      'ListDir',
      'ReadSubtree',
      'Edit',
      'Write',
      'ApplyPatch',
      'NotebookEdit',
      'Bash',
      'Skill',
      'TodoWrite',
      'TaskOutput',
      'TaskStop',
      'TaskSteer',
      'AskUser',
      'SetOutput',
      'AddDir',
      'SessionSearch',
      'Memory',
      'LSP',
      'EnterWorktree',
      'ExitWorktree',
      'CronCreate',
      'CronList',
      'CronDelete',
      'CronSetEnabled',
      'EnterPlanMode',
      'ExitPlanMode',
    ])
    expect(names).not.toContain('Fetch')
    expect(names).not.toContain('WebSearch')
    expect(names).not.toContain('Agent')
    expect(names).not.toContain('ToolSearch')
    expect(names).not.toContain('ToolCall')
    expect(names).not.toContain('Sleep')
    expect(names).not.toContain('ThinkDeeply')
    expect(names).not.toContain('SuggestFollowups')
    expect(names).not.toContain('TaskCreate')
  })

  test('filterToolsForTurn hides gated builtins without lsp.json, git, or cron jobs', () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-exec-gate-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-exec-cwd-'))
    tempDirs.push(home, cwd)
    const prev = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    try {
      const tools = createRootTools(createMemoryStore())
      const names = tools.map((tool) => tool.name)
      expect(names).toContain('LSP')
      expect(names).toContain('EnterWorktree')
      expect(names).toContain('ExitWorktree')
      expect(names).toContain('CronCreate')
      expect(names).not.toContain('ToolSearch')

      const turn = makeFilterTurn(cwd)
      const filtered = filterToolsForTurn(tools, turn).map((tool) => tool.name)
      expect(filtered).not.toContain('LSP')
      expect(filtered).not.toContain('EnterWorktree')
      expect(filtered).not.toContain('ExitWorktree')
      expect(filtered).not.toContain('CronCreate')
      expect(filtered).not.toContain('CronList')
      expect(filtered).not.toContain('CronDelete')
      expect(filtered).not.toContain('CronSetEnabled')
      expect(filtered).toContain('Read')
      expect(filtered).toContain('Memory')
      expect(filtered).not.toContain('AskUser')
      expect(filtered).not.toContain('Fetch')
      expect(filtered).not.toContain('WebSearch')
      expect(filtered).toContain('SessionSearch')
      expect(filtered).not.toContain('ToolSearch')
      expect(filtered).not.toContain('ToolCall')
    } finally {
      if (prev === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = prev
    }
  })

  test('createSessionTools appends Agent after the static root tools', () => {
    const store = createMemoryStore()
    const provider = createFakeProvider([])
    const names = createSessionTools({
      store,
      provider,
      compact: defaultCompactPolicy(),
      model: defaultModel(),
      childMaxRounds: 30,
      async askUser() {
        return 'deny'
      },
    }).map((tool) => tool.name)
    expect(names).toEqual([
      'Read',
      'Grep',
      'Glob',
      'ListDir',
      'ReadSubtree',
      'Edit',
      'Write',
      'ApplyPatch',
      'NotebookEdit',
      'Bash',
      'Skill',
      'TodoWrite',
      'TaskOutput',
      'TaskStop',
      'TaskSteer',
      'AskUser',
      'SetOutput',
      'AddDir',
      'SessionSearch',
      'Memory',
      'LSP',
      'EnterWorktree',
      'ExitWorktree',
      'CronCreate',
      'CronList',
      'CronDelete',
      'CronSetEnabled',
      'EnterPlanMode',
      'ExitPlanMode',
      'Fetch',
      'WebSearch',
      'ToolSearch',
      'ToolCall',
      'Agent',
    ])
    expect(names).toContain('ToolSearch')
    expect(names).toContain('ToolCall')
    const filtered = filterToolsForTurn(createSessionTools({
      store,
      provider,
      compact: defaultCompactPolicy(),
      model: defaultModel(),
      childMaxRounds: 30,
      async askUser() {
        return 'deny'
      },
    }), makeFilterTurn('/tmp')).map((tool) => tool.name)
    expect(filtered).toContain('ToolSearch')
    expect(filtered).toContain('ToolCall')
    expect(filtered).toContain('Memory')
    expect(filtered).toContain('Agent')
    expect(filtered).not.toContain('Fetch')
    expect(filtered).not.toContain('WebSearch')
    expect(filtered).not.toContain('AskUser')
    expect(filtered).toContain('SessionSearch')
  })

  test('createSessionTools with network:true puts Fetch/WebSearch on the wire', () => {
    const store = createMemoryStore()
    const tools = createSessionTools({
      store,
      provider: createFakeProvider([]),
      compact: defaultCompactPolicy(),
      model: defaultModel(),
      childMaxRounds: 30,
      network: true,
      async askUser() {
        return 'deny'
      },
    })
    expect(tools.map((tool) => tool.name)).not.toContain('ToolSearch')
    expect(tools.map((tool) => tool.name)).not.toContain('ToolCall')
    const filtered = filterToolsForTurn(tools, makeFilterTurn('/tmp')).map((tool) => tool.name)
    expect(filtered).toContain('Fetch')
    expect(filtered).toContain('WebSearch')
    expect(filtered).not.toContain('ToolSearch')
    expect(filtered).not.toContain('ToolCall')
  })

  test('createSessionTools merges MCP tools after builtins and drops colliding Read', async () => {
    const mcpTools = await loadMcpTools(
      createMcpToolBridge({
        async request(method) {
          if (method === 'initialize') {
            return { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 't' } }
          }
          if (method === 'tools/list') {
            return {
              tools: [
                { name: 'Read', description: 'collide', inputSchema: { type: 'object' } },
                { name: 'mcp_ping', description: 'ping', inputSchema: { type: 'object' } },
              ],
            }
          }
          throw new Error(method)
        },
        async close() {},
      }),
    )
    const store = createMemoryStore()
    const names = createSessionTools({
      store,
      provider: createFakeProvider([]),
      compact: defaultCompactPolicy(),
      model: defaultModel(),
      childMaxRounds: 30,
      mcpTools,
      async askUser() {
        return 'deny'
      },
    }).map((tool) => tool.name)
    expect(names.filter((name) => name === 'Read')).toHaveLength(1)
    expect(names).toContain('Agent')
    expect(names).toContain('ToolSearch')
    expect(names).toContain('ToolCall')
    expect(names.at(-1)).toBe('mcp_ping')
    expect(names.indexOf('mcp_ping')).toBeGreaterThan(names.indexOf('Agent'))

    const turn = makeFilterTurn('/tmp')
    const sessionTools = createSessionTools({
      store,
      provider: createFakeProvider([]),
      compact: defaultCompactPolicy(),
      model: defaultModel(),
      childMaxRounds: 30,
      mcpTools,
      async askUser() {
        return 'deny'
      },
    })
    const exposed = filterToolsForTurn(sessionTools, turn).map((tool) => tool.name)
    expect(exposed).not.toContain('mcp_ping')
    expect(exposed).toContain('ToolSearch')
    expect(exposed).toContain('ToolCall')
    turn.unlockedToolNames = ['mcp_ping']
    const unlocked = filterToolsForTurn(sessionTools, turn).map((tool) => tool.name)
    expect(unlocked).not.toContain('mcp_ping')
  })

  test('AskUser stays off the wire unless a host askTool is bound', () => {
    const store = createMemoryStore()
    const provider = createFakeProvider([])
    const base = {
      store,
      provider,
      compact: defaultCompactPolicy(),
      model: defaultModel(),
      childMaxRounds: 30,
      async askUser() {
        return 'deny' as const
      },
    }
    const unhosted = createSessionTools(base)
    const unhostedAsk = unhosted.find((tool) => tool.name === 'AskUser')
    expect(unhostedAsk).toBeDefined()
    expect(unhostedAsk?.isEnabled?.()).toBe(false)
    expect(filterToolsForTurn(unhosted, makeFilterTurn('/tmp')).map((tool) => tool.name)).not.toContain(
      'AskUser',
    )

    const hosted = createSessionTools({
      ...base,
      askTool: createAskUserTool(async () => 'ok'),
    })
    const hostedAsk = hosted.find((tool) => tool.name === 'AskUser')
    expect(hostedAsk?.isEnabled?.()).toBe(true)
    expect(filterToolsForTurn(hosted, makeFilterTurn('/tmp')).map((tool) => tool.name)).toContain(
      'AskUser',
    )
  })
})

const tempDirs: string[] = []

beforeEach(() => {
  tempDirs.length = 0
})

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeFilterTurn(cwd: string): Turn {
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
    cwd,
    model: 'dummy',
    readFiles: new Set(),
  }
}

describe('runExec', () => {
  test('collects assistant text and events from a fake provider', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'usage', usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 } },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const engine = createSessionEngine({
      session,
      provider,
      store,
      tools: [],
      compact: defaultCompactPolicy(),
      model: defaultModel(),
      maxRounds: 4,
      async askUser() {
        return 'deny'
      },
    })

    const written: string[] = []
    const result = await runExec({
      prompt: 'hi',
      engine,
      write: (chunk) => {
        written.push(chunk)
      },
    })

    expect(result.end).toEqual({ reason: 'completed' })
    expect(result.text).toBe('Hello world')
    expect(result.events.some((e) => e.type === 'text_delta' && e.text === 'Hello')).toBe(
      true,
    )
    expect(written.join('').replace(/\n$/, '')).toBe('Hello world')
    expect(written.some((chunk) => chunk.startsWith('{'))).toBe(false)
  })

  test('--json writes JSONL StreamEvents and not a bare text dump', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_json' })
    await store.createSession(session)
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const engine = createSessionEngine({
      session,
      provider,
      store,
      tools: [],
      compact: defaultCompactPolicy(),
      model: defaultModel(),
      maxRounds: 4,
      async askUser() {
        return 'deny'
      },
    })

    const lines: string[] = []
    const result = await runExec({
      prompt: 'go',
      json: true,
      engine,
      write: (chunk) => {
        lines.push(chunk)
      },
    })

    expect(result.text).toBe('ok')
    expect(lines.length).toBeGreaterThan(0)
    const parsed = lines.map((line) => JSON.parse(line.trimEnd()) as StreamEvent)
    expect(parsed.some((e) => e.type === 'text_delta' && e.text === 'ok')).toBe(true)
    expect(parsed.some((e) => e.type === 'round_end')).toBe(true)
    expect(lines.join('')).not.toBe('ok')
  })

  test('forwards system parts into the provider request', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_system' })
    await store.createSession(session)
    const system: SystemPart[] = [
      { tier: 'stable', text: 'you are raven', cacheBreakpoint: true },
    ]
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'ack' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const engine = createSessionEngine({
      session,
      provider,
      store,
      tools: [],
      compact: defaultCompactPolicy(),
      model: defaultModel(),
      maxRounds: 4,
      system,
      async askUser() {
        return 'deny'
      },
    })

    await runExec({ prompt: 'hi', engine, write: () => {} })
    expect(provider.requests[0]?.system).toEqual(system)
  })
})

function testResolvedConfig(): ResolvedConfig {
  return {
    ...defaultConfig(),
    home: '/tmp',
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    profile: defaultModel('anthropic/claude-sonnet-4'),
  }
}

describe('openEngine', () => {
  test('does not spawn when mcp.servers is empty', async () => {
    let spawned = 0
    const store = createMemoryStore()
    const { engine } = await openEngine({
      provider: createFakeProvider([]),
      store,
      config: testResolvedConfig(),
      cwd: '/tmp',
      async askUser() {
        return 'deny'
      },
      spawnMcp() {
        spawned += 1
        throw new Error('should not spawn')
      },
    })
    expect(spawned).toBe(0)
    expect(engine.session.cwd).toBe('/tmp')
  })

  test('explicit tools: [] is a text-only turn and does not spawn MCP', async () => {
    let spawned = 0
    const store = createMemoryStore()
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'pong' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const { engine } = await openEngine({
      provider,
      store,
      config: {
        ...testResolvedConfig(),
        mcp: { servers: [{ name: 'echo', command: 'false' }] },
      },
      cwd: '/tmp',
      tools: [],
      maxRounds: 1,
      async askUser() {
        return 'deny'
      },
      spawnMcp() {
        spawned += 1
        throw new Error('should not spawn')
      },
    })
    const gen = engine.submitMessage('ping')
    while (true) {
      const next = await gen.next()
      if (next.done) break
    }
    expect(spawned).toBe(0)
    expect(provider.requests[0]?.tools).toEqual([])
  })

  test('verifyOnStop does not enable AskUser on the wire', async () => {
    const store = createMemoryStore()
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const { engine } = await openEngine({
      provider,
      store,
      config: testResolvedConfig(),
      cwd: '/tmp',
      verifyOnStop: true,
      maxRounds: 1,
      async askUser() {
        return 'deny'
      },
    })
    const gen = engine.submitMessage('hi')
    while (true) {
      const next = await gen.next()
      if (next.done) break
    }
    const names = (provider.requests[0]?.tools ?? []).map((tool) => tool.name)
    expect(names).toContain('Read')
    expect(names).not.toContain('AskUser')
  })

  test('askUserHost enables AskUser on the wire', async () => {
    const store = createMemoryStore()
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const { engine } = await openEngine({
      provider,
      store,
      config: testResolvedConfig(),
      cwd: '/tmp',
      askUserHost: true,
      maxRounds: 1,
      async askUser() {
        return 'deny'
      },
    })
    const gen = engine.submitMessage('hi')
    while (true) {
      const next = await gen.next()
      if (next.done) break
    }
    const names = (provider.requests[0]?.tools ?? []).map((tool) => tool.name)
    expect(names).toContain('AskUser')
  })
})
