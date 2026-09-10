import { describe, expect, test } from 'bun:test'
import {
  createMemoryStore,
  createSessionEngine,
  defaultCompactPolicy,
  type ModelProfile,
  type Provider,
  type ProviderChunk,
  type ProviderRequest,
  type SessionRecord,
  type StreamEvent,
  type SystemPart,
} from '@ravenclaw/core'
import { runExec } from './exec'
import { createRootTools } from './engine'

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
      'Edit',
      'Write',
      'Bash',
      'Skill',
      'EnterPlanMode',
      'ExitPlanMode',
    ])
    expect(names).not.toContain('Agent')
  })
})

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
