import { describe, expect, test } from 'bun:test'
import { createMemoryStore } from '../session/memory-store'
import { createSessionEngine } from '../loop/session-engine'
import type {
  CompactPolicy,
  ModelProfile,
  PermissionDecision,
  Provider,
  ProviderChunk,
  ProviderRequest,
  SessionEngineOptions,
  SessionRecord,
  StreamEvent,
  Tool,
  ToolContext,
} from '../types'
import { createPlanModeTools } from '../tools/plan-mode'
import { denyText } from '../loop/pairing'

function defaultModel(): ModelProfile {
  return {
    id: 'dummy',
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
    id: 'sess_perm',
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

type StreamScript = ProviderChunk[] | ((req: ProviderRequest, signal: AbortSignal) => AsyncIterable<ProviderChunk>)

function createFakeProvider(scripts: StreamScript[]): Provider {
  const queue = [...scripts]
  return {
    id: 'fake',
    apiMode: 'openai_compat',
    profile(model: string) {
      return { ...defaultModel(), id: model }
    },
    async *stream(req: ProviderRequest, signal: AbortSignal) {
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
}

function textThenStop(text: string): ProviderChunk[] {
  return [
    { type: 'text_delta', text },
    { type: 'stop', reason: 'end' },
  ]
}

function toolThenStop(id: string, name: string, input: unknown): ProviderChunk[] {
  return [
    { type: 'tool_call', id, name, input },
    { type: 'stop', reason: 'tool_use' },
  ]
}

function mockTool(opts: {
  name: string
  check: PermissionDecision | ((input: unknown) => PermissionDecision)
  execute?: (input: unknown, ctx: ToolContext) => Promise<string> | string
  readOnly?: boolean
}): Tool & { executeCount: number } {
  const tool = {
    name: opts.name,
    description: opts.name,
    inputSchema: { type: 'object' },
    executeCount: 0,
    parse(input: unknown) {
      return { ok: true as const, value: input }
    },
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return opts.readOnly ?? false
    },
    async checkPermissions(input: unknown) {
      return typeof opts.check === 'function' ? opts.check(input) : opts.check
    },
    async execute(input: unknown, ctx: ToolContext) {
      tool.executeCount += 1
      if (opts.execute) return opts.execute(input, ctx)
      return 'ok'
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
  askUser?: SessionEngineOptions['askUser']
}): SessionEngineOptions {
  const session = over.session ?? makeSession()
  return {
    session,
    provider: over.provider,
    store: over.store,
    tools: over.tools ?? [],
    compact: defaultCompact(),
    model: defaultModel(),
    maxRounds: 8,
    askUser: over.askUser ?? (async () => 'deny'),
  }
}

describe('permission pipeline in queryLoop', () => {
  test('1. acceptEdits + checkPermissions deny (path escape) stays deny', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_accept_deny', permissionMode: 'acceptEdits' })
    await store.createSession(session)
    const edit = mockTool({
      name: 'Edit',
      check: { behavior: 'deny', reason: 'safety', message: 'path escape' },
    })
    const provider = createFakeProvider([
      toolThenStop('e1', 'Edit', { path: '../secret.txt', old_string: 'a', new_string: 'b' }),
      textThenStop('done'),
    ])
    const engine = createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [edit],
        askUser: async () => 'allow',
      }),
    )

    const { events, result } = await collect(engine.submitMessage('edit outside'))
    expect(result).toEqual({ reason: 'completed' })
    expect(edit.executeCount).toBe(0)
    expect(events.some((e) => e.type === 'permission_ask')).toBe(false)

    const loaded = await store.loadSession(session.id)
    const toolMsg = loaded.messages.find(
      (m): m is Extract<import('../types').Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'e1',
    )
    expect(toolMsg?.ok).toBe(false)
    expect(toolMsg?.blocks[0]?.text).toBe(denyText('path escape'))
  })

  test('2. dontAsk + checkPermissions allow executes', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_dontask_allow', permissionMode: 'dontAsk' })
    await store.createSession(session)
    const echo = mockTool({
      name: 'Echo',
      readOnly: true,
      check: { behavior: 'allow', reason: 'mode' },
      execute: async (input) => {
        const rec = input as { text?: string }
        return rec.text ?? 'ok'
      },
    })
    const provider = createFakeProvider([
      toolThenStop('c1', 'Echo', { text: 'ping' }),
      textThenStop('done'),
    ])
    const engine = createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [echo],
        askUser: async () => 'deny',
      }),
    )

    const { result } = await collect(engine.submitMessage('echo'))
    expect(result).toEqual({ reason: 'completed' })
    expect(echo.executeCount).toBe(1)

    const loaded = await store.loadSession(session.id)
    const toolMsg = loaded.messages.find(
      (m): m is Extract<import('../types').Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'c1',
    )
    expect(toolMsg?.ok).toBe(true)
    expect(toolMsg?.blocks[0]?.text).toBe('ping')
  })

  test('3. two asks in one batch are sequential; results stay in arrival order', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_two_ask' })
    await store.createSession(session)

    let firstEntered = 0
    let secondEntered = 0
    let firstActive = false
    let overlap = false
    let releaseFirst!: () => void
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstSaw = new Promise<void>((resolve) => {
      firstStarted = resolve
    })

    const askA = mockTool({
      name: 'AskA',
      check: { behavior: 'ask', message: 'allow A?' },
      execute: () => 'A',
    })
    const askB = mockTool({
      name: 'AskB',
      check: { behavior: 'ask', message: 'allow B?' },
      execute: () => 'B',
    })

    const provider = createFakeProvider([
      [
        { type: 'tool_call', id: 'ask_1', name: 'AskA', input: {} },
        { type: 'tool_call', id: 'ask_2', name: 'AskB', input: {} },
        { type: 'stop', reason: 'tool_use' },
      ],
      textThenStop('done'),
    ])

    const engine = createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [askA, askB],
        askUser: async (event) => {
          if (event.id === 'ask_1') {
            firstEntered += 1
            firstActive = true
            firstStarted()
            await firstHold
            firstActive = false
            return 'allow'
          }
          secondEntered += 1
          if (firstActive) overlap = true
          return 'allow'
        },
      }),
    )

    const drained = collect(engine.submitMessage('ask both'))
    await firstSaw
    expect(secondEntered).toBe(0)
    releaseFirst()
    const { events, result } = await drained

    expect(result).toEqual({ reason: 'completed' })
    expect(firstEntered).toBe(1)
    expect(secondEntered).toBe(1)
    expect(overlap).toBe(false)
    expect(askA.executeCount).toBe(1)
    expect(askB.executeCount).toBe(1)

    const asks = events.filter((e) => e.type === 'permission_ask')
    expect(asks.map((e) => (e.type === 'permission_ask' ? e.id : ''))).toEqual(['ask_1', 'ask_2'])

    const results = events.filter((e) => e.type === 'tool_result')
    expect(results.map((e) => (e.type === 'tool_result' ? e.id : ''))).toEqual(['ask_1', 'ask_2'])
    expect(
      results.map((e) => (e.type === 'tool_result' ? e.result.content : '')),
    ).toEqual(['A', 'B'])
  })

  test('EnterPlanMode upserts plan, mutating Edit is a deny tool message, ExitPlanMode restores', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_plan_loop', permissionMode: 'acceptEdits' })
    await store.createSession(session)
    const { enter, exit } = createPlanModeTools(store)
    let editRan = 0
    const edit = mockTool({
      name: 'Edit',
      check: { behavior: 'allow', reason: 'mode' },
      execute: () => {
        editRan += 1
        return 'edited'
      },
    })
    const provider = createFakeProvider([
      toolThenStop('enter_1', 'EnterPlanMode', {}),
      toolThenStop('edit_1', 'Edit', { path: 'a.txt', old_string: 'a', new_string: 'b' }),
      toolThenStop('exit_1', 'ExitPlanMode', {}),
      textThenStop('done'),
    ])
    const engine = createSessionEngine(
      engineOpts({
        provider,
        store,
        session,
        tools: [enter, exit, edit],
      }),
    )

    const { result } = await collect(engine.submitMessage('plan then edit'))
    expect(result).toEqual({ reason: 'completed' })
    expect(editRan).toBe(0)
    expect(engine.session.permissionMode).toBe('acceptEdits')
    expect(engine.session.prePlanMode).toBeUndefined()

    const loaded = await store.loadSession(session.id)
    const enterMsg = loaded.messages.find(
      (m): m is Extract<import('../types').Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'enter_1',
    )
    const editMsg = loaded.messages.find(
      (m): m is Extract<import('../types').Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'edit_1',
    )
    const exitMsg = loaded.messages.find(
      (m): m is Extract<import('../types').Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'exit_1',
    )
    expect(enterMsg?.ok).toBe(true)
    expect(enterMsg?.blocks[0]?.text).toBe('mode=plan')
    expect(editMsg?.ok).toBe(false)
    expect(editMsg?.blocks[0]?.text.startsWith('permission_denied:')).toBe(true)
    expect(exitMsg?.ok).toBe(true)
    expect(exitMsg?.blocks[0]?.text).toBe('mode=acceptEdits')
    expect(loaded.session.permissionMode).toBe('acceptEdits')
  })

  test('session engine hooks deny leftover ask', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_file_hook' })
    await store.createSession(session)
    const bash = mockTool({
      name: 'Bash',
      check: { behavior: 'ask', message: 'allow bash?' },
    })
    const provider = createFakeProvider([
      toolThenStop('h1', 'Bash', { command: 'ls' }),
      textThenStop('done'),
    ])
    const engine = createSessionEngine({
      ...engineOpts({
        provider,
        store,
        session,
        tools: [bash],
        askUser: async () => 'allow',
      }),
      hooks: [() => ({ behavior: 'deny', reason: 'hook', message: 'file hook' })],
    })

    const { events, result } = await collect(engine.submitMessage('run ls'))
    expect(result).toEqual({ reason: 'completed' })
    expect(bash.executeCount).toBe(0)
    expect(events.some((e) => e.type === 'permission_ask')).toBe(false)
    const loaded = await store.loadSession(session.id)
    const toolMsg = loaded.messages.find(
      (m): m is Extract<import('../types').Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'h1',
    )
    expect(toolMsg?.ok).toBe(false)
    expect(toolMsg?.blocks[0]?.text).toBe(denyText('file hook'))
  })

  test('setPermissionMode upserts permissionMode and prePlanMode before return', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_mode_set', permissionMode: 'default' })
    await store.createSession(session)
    const engine = createSessionEngine(
      engineOpts({
        provider: createFakeProvider([]),
        store,
        session,
      }),
    )

    await engine.setPermissionMode('plan')
    expect(engine.session.permissionMode).toBe('plan')
    expect(engine.session.prePlanMode).toBe('default')
    const planned = await store.loadSession(session.id)
    expect(planned.session.permissionMode).toBe('plan')
    expect(planned.session.prePlanMode).toBe('default')

    await engine.setPermissionMode('default')
    expect(engine.session.permissionMode).toBe('default')
    expect(engine.session.prePlanMode).toBeUndefined()
    const restored = await store.loadSession(session.id)
    expect(restored.session.permissionMode).toBe('default')
    expect(restored.session.prePlanMode).toBeUndefined()
  })
})
