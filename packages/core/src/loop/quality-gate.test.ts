import { describe, expect, test } from 'bun:test'
import { decidePermission } from '../permissions/pipeline'
import { resumeSession } from '../session/resume'
import { createMemoryStore } from '../session/memory-store'
import { bashTool } from '../tools/bash'
import {
  PersistError,
  type CompactPolicy,
  type Message,
  type ModelProfile,
  type PermissionDecision,
  type PermissionRule,
  type Provider,
  type ProviderChunk,
  type ProviderRequest,
  type SessionRecord,
  type StreamEvent,
  type Tool,
  type ToolContext,
  type Turn,
} from '../types'
import { createSessionEngine } from './session-engine'
import { pairMissing, unpairedToolUseIds, TOOLS_OMITTED_TEXT } from './pairing'
import { repairRoleAlternation } from './repair'

function assertPaired(messages: Message[]): void {
  const unpaired = unpairedToolUseIds(messages)
  if (unpaired.length > 0) {
    throw new Error(`unpaired tool_use: ${unpaired.join(', ')}`)
  }
}

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

function defaultCompact(): CompactPolicy {
  return {
    enabled: true,
    autoCompactBuffer: 13_000,
    blockingBufferWhenManual: 3_000,
    protectLastMessages: 20,
    keepRecentFiles: 5,
    maxCharsPerRestoredFile: 5_000,
    maxCharsRestoredFilesTotal: 50_000,
    maxCharsPerRestoredSkill: 5_000,
    maxCharsRestoredSkillsTotal: 25_000,
    maxConsecutiveFailures: 3,
    llmSummarize: false,
  }
}

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_qg',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'dummy',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

type StreamScript =
  | ProviderChunk[]
  | ((
      req: ProviderRequest,
      signal: AbortSignal,
    ) => AsyncIterable<ProviderChunk>)

function createFakeProvider(scripts: StreamScript[]): Provider & {
  requests: ProviderRequest[]
} {
  const requests: ProviderRequest[] = []
  const queue = [...scripts]
  const provider = {
    id: 'fake',
    apiMode: 'openai_compat' as const,
    requests,
    profile(model: string) {
      return defaultModel(model)
    },
    async *stream(req: ProviderRequest, signal: AbortSignal) {
      requests.push(req)
      const script = queue.shift()
      if (!script) {
        yield { type: 'stop' as const, reason: null }
        return
      }
      const chunks = typeof script === 'function' ? script(req, signal) : script
      for await (const chunk of chunks) {
        if (signal.aborted) return
        yield chunk
      }
    },
  }
  return provider
}

function textThenStop(text: string): ProviderChunk[] {
  return [
    { type: 'text_delta', text },
    { type: 'stop', reason: 'end' },
  ]
}

function toolThenStop(
  id: string,
  name: string,
  input: unknown,
): ProviderChunk[] {
  return [
    { type: 'tool_call', id, name, input },
    { type: 'stop', reason: 'tool_use' },
  ]
}

function createEcho(opts?: {
  onExecute?: (input: { text: string }, ctx: ToolContext) => Promise<string> | string
}): Tool<{ text: string }, string> & {
  executeCount: number
  executedIds: string[]
} {
  const tool = {
    name: 'Echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    executeCount: 0,
    executedIds: [] as string[],
    parse(input: unknown) {
      if (
        !input ||
        typeof input !== 'object' ||
        typeof (input as { text?: unknown }).text !== 'string'
      ) {
        return { ok: false as const, message: 'expected { text: string }' }
      }
      return { ok: true as const, value: { text: (input as { text: string }).text } }
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async checkPermissions() {
      return { behavior: 'allow' as const, reason: 'mode' as const }
    },
    async execute(input: { text: string }, ctx: ToolContext) {
      tool.executeCount += 1
      tool.executedIds.push(input.text)
      if (opts?.onExecute) return opts.onExecute(input, ctx)
      return input.text
    },
  }
  return tool
}

function spyBash(): typeof bashTool & { executeCount: number } {
  const tool = {
    ...bashTool,
    executeCount: 0,
    async execute(
      input: Parameters<typeof bashTool.execute>[0],
      ctx: ToolContext,
    ) {
      tool.executeCount += 1
      return bashTool.execute(input, ctx)
    },
  }
  return tool
}

async function collect(
  gen: AsyncGenerator<StreamEvent, import('../types').RoundEnd>,
): Promise<{ events: StreamEvent[]; result: import('../types').RoundEnd }> {
  const events: StreamEvent[] = []
  while (true) {
    const next = await gen.next()
    if (next.done) return { events, result: next.value }
    events.push(next.value)
  }
}

function engineOpts(over: {
  provider: Provider
  store: ReturnType<typeof createMemoryStore>
  tools?: Tool[]
  session?: SessionRecord
  messages?: Message[]
  maxRounds?: number
}) {
  const session = over.session ?? makeSession()
  const opts: Parameters<typeof createSessionEngine>[0] = {
    session,
    provider: over.provider,
    store: over.store,
    tools: over.tools ?? [],
    compact: defaultCompact(),
    model: defaultModel(),
    maxRounds: over.maxRounds ?? 8,
    async askUser() {
      return 'deny'
    },
  }
  if (over.messages) opts.messages = over.messages
  return opts
}

function makeTurn(over: Partial<Turn> = {}): Turn {
  return {
    id: 'turn_qg',
    sessionId: 'sess_qg',
    messages: [],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd: '/tmp/proj',
    model: 'dummy',
    readFiles: new Set(),
    ...over,
  }
}

describe('quality gate', () => {
  test('unpaired tool_use fails the pairing check', () => {
    const messages: Message[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'go' }],
        createdAt: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: 'call_1', name: 'Echo', input: {} }],
        createdAt: 2,
      },
    ]
    expect(unpairedToolUseIds(messages)).toEqual(['call_1'])
    expect(() => assertPaired(messages)).toThrow(/unpaired tool_use: call_1/)

    const repaired = repairRoleAlternation(messages)
    expect(unpairedToolUseIds(repaired)).toEqual([])
    assertPaired(repaired)

    const paired = [...messages, ...pairMissing(['call_1'], 'incomplete')]
    expect(unpairedToolUseIds(paired)).toEqual([])
    assertPaired(paired)
  })

  test('persistToolCalls fail never executes', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_persist_calls' })
    await store.createSession(session)
    store.persistToolCalls = async () => {
      throw new PersistError('locked', 'locked')
    }
    const echo = createEcho()
    const provider = createFakeProvider([
      toolThenStop('call_x', 'Echo', { text: 'nope' }),
    ])
    const engine = await createSessionEngine(
      engineOpts({ provider, store, session, tools: [echo] }),
    )

    const { result } = await collect(engine.submitMessage('call'))

    expect(echo.executeCount).toBe(0)
    expect(result.reason).toBe('persist_failed')
  })

  test('result INSERT fail resume does not run Bash', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_bash_resume' })
    await store.createSession(session)
    await store.persistUser(session.id, {
      id: 'u_bash',
      role: 'user',
      blocks: [{ type: 'text', text: 'run it' }],
      createdAt: 1,
    })
    await store.persistToolCalls(session.id, {
      id: 'a_bash',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          id: 'bash-1',
          name: 'Bash',
          input: { command: 'echo should-not-run' },
        },
      ],
      createdAt: 2,
    })

    const loaded = await resumeSession(store, session.id)
    const incomplete = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'bash-1',
    )
    expect(incomplete).toBeDefined()
    expect(incomplete?.ok).toBe(false)
    expect(incomplete?.blocks[0]?.text).toBe(
      'incomplete: the process ended before this tool result was saved. The tool was not re-run.',
    )
    assertPaired(loaded.messages)

    const bash = spyBash()
    const provider = createFakeProvider([textThenStop('continuing')])
    const engine = await createSessionEngine(
      engineOpts({
        provider,
        store,
        session: loaded.session,
        messages: loaded.messages,
        tools: [bash],
      }),
    )

    const { result } = await collect(engine.submitMessage('continue'))
    expect(result).toEqual({ reason: 'completed' })
    expect(bash.executeCount).toBe(0)

    const again = await store.loadSession(session.id)
    assertPaired(again.messages)
    const tools = again.messages.filter(
      (m): m is Extract<Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'bash-1',
    )
    expect(tools).toHaveLength(1)
    expect(tools[0]?.blocks[0]?.text).toBe(
      'incomplete: the process ended before this tool result was saved. The tool was not re-run.',
    )
  })

  test('grace + stray tool_use → tools_omitted, no execute, pairing holds', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_grace_stray' })
    await store.createSession(session)
    const echo = createEcho()
    const provider = createFakeProvider([
      toolThenStop('h1', 'Echo', { text: 'one' }),
      toolThenStop('h2', 'Echo', { text: 'two' }),
      toolThenStop('h3', 'Echo', { text: 'should not run' }),
    ])
    const engine = await createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [echo],
        maxRounds: 2,
      }),
    )

    const { result } = await collect(engine.submitMessage('loop'))

    expect(result).toEqual({ reason: 'max_rounds', round: 2 })
    expect(provider.requests[2]?.tools).toEqual([])
    expect(echo.executedIds).not.toContain('should not run')
    expect(echo.executeCount).toBe(2)

    const loaded = await store.loadSession(session.id)
    assertPaired(loaded.messages)
    const omitted = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'h3',
    )
    expect(omitted?.ok).toBe(false)
    expect(omitted?.blocks[0]?.text).toBe(
      'tools_omitted: tools were disabled on the final round; the call was not executed.',
    )
    expect(omitted?.blocks[0]?.text).toBe(TOOLS_OMITTED_TEXT)
  })

  test('acceptEdits cannot promote a tool deny', async () => {
    const emptyRules = {
      session: [] as PermissionRule[],
      user: [] as PermissionRule[],
      project: [] as PermissionRule[],
    }
    const deny: PermissionDecision = {
      behavior: 'deny',
      reason: 'safety',
      message: 'path escape',
    }
    const tool: Tool = {
      name: 'Edit',
      description: 'edit',
      inputSchema: { type: 'object' },
      parse(input: unknown) {
        return { ok: true as const, value: input }
      },
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      async checkPermissions() {
        return deny
      },
      async execute() {
        return 'should not run'
      },
    }
    const turn = makeTurn({ permissionMode: 'acceptEdits', cwd: '/tmp/proj' })
    const decision = await decidePermission({
      tool,
      name: 'Edit',
      input: { path: '../secret.txt', old_string: 'a', new_string: 'b' },
      ctx: { turn, signal: turn.abort.signal, onProgress() {} },
      mode: 'acceptEdits',
      rules: emptyRules,
    })
    expect(decision).toEqual({
      behavior: 'deny',
      reason: 'safety',
      message: 'path escape',
    })
  })
})
