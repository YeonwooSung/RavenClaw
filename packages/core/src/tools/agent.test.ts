import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../session/memory-store'
import { createSessionEngine } from '../loop/session-engine'
import { INCOMPLETE_TEXT } from '../loop/pairing'
import { PersistError } from '../types'
import type {
  CompactPolicy,
  Message,
  ModelProfile,
  Provider,
  ProviderChunk,
  ProviderRequest,
  SessionRecord,
  SessionStore,
  StreamEvent,
  Tool,
  ToolContext,
  Turn,
} from '../types'
import { createPlanModeTools } from './plan-mode'
import { editTool } from './edit'
import { readTool } from './read'
import { createAgentTool } from './agent'

const RESULT_BOUND = 32_000
const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
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
    id: 'sess_parent',
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

function makeTurn(session: SessionRecord, over: Partial<Turn> = {}): Turn {
  const turn: Turn = {
    id: 'turn_parent',
    sessionId: session.id,
    messages: [
      {
        id: 'u_parent',
        role: 'user',
        blocks: [{ type: 'text', text: 'PARENT_SECRET do not leak' }],
        createdAt: 1,
      },
    ],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: session.permissionMode,
    usage: { ...session.usage },
    compactGeneration: session.compactGeneration,
    funding: session.funding,
    cwd: session.cwd,
    model: session.model,
    readFiles: new Set(),
  }
  if (session.prePlanMode !== undefined) turn.prePlanMode = session.prePlanMode
  return { ...turn, ...over }
}

function makeCtx(turn: Turn): ToolContext {
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

type StreamScript =
  | ProviderChunk[]
  | ((
      req: ProviderRequest,
      signal: AbortSignal,
    ) => AsyncIterable<ProviderChunk>)

function createFakeProvider(scripts: StreamScript[]): Provider & {
  requests: ProviderRequest[]
  streamCount: number
} {
  const requests: ProviderRequest[] = []
  const queue = [...scripts]
  const provider = {
    id: 'fake',
    apiMode: 'openai_compat' as const,
    requests,
    streamCount: 0,
    profile(model: string) {
      return defaultModel(model)
    },
    async *stream(req: ProviderRequest, signal: AbortSignal) {
      provider.streamCount += 1
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

function toolThenStop(id: string, name: string, input: unknown): ProviderChunk[] {
  return [
    { type: 'tool_call', id, name, input },
    { type: 'stop', reason: 'tool_use' },
  ]
}

function stubTool(name: string): Tool {
  return {
    name,
    description: `${name} stub`,
    inputSchema: { type: 'object' },
    parse() {
      return { ok: true, value: {} }
    },
    isConcurrencySafe() {
      return name !== 'Agent' && name !== 'Edit' && name !== 'Write' && name !== 'Bash'
    },
    isReadOnly() {
      return name !== 'Agent' && name !== 'Edit' && name !== 'Write' && name !== 'Bash'
    },
    interruptBehavior() {
      return name === 'Agent' ? 'cancel' : 'block'
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute() {
      return name
    },
  }
}

function parentPool(extras: Tool[] = []): Tool[] {
  return [
    stubTool('Read'),
    stubTool('Grep'),
    stubTool('Glob'),
    stubTool('Edit'),
    stubTool('Write'),
    stubTool('Bash'),
    stubTool('Skill'),
    stubTool('Agent'),
    stubTool('EnterPlanMode'),
    stubTool('ExitPlanMode'),
    ...extras,
  ]
}

async function askUser() {
  return 'deny' as const
}

function createTestAgent(
  over: {
    store?: SessionStore
    provider?: Provider
    tools?: Tool[]
    model?: ModelProfile
    childMaxRounds?: number
  } = {},
) {
  const store = over.store ?? createMemoryStore()
  const provider = over.provider ?? createFakeProvider([textThenStop('child done')])
  const opts: Parameters<typeof createAgentTool>[0] = {
    store,
    provider,
    tools: over.tools ?? parentPool(),
    compact: defaultCompact(),
    model: over.model ?? defaultModel(),
    askUser,
  }
  if (over.childMaxRounds !== undefined) opts.childMaxRounds = over.childMaxRounds
  return { store, provider, tool: createAgentTool(opts) }
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

describe('createAgentTool', () => {
  test('name, flags, permissions, and input schema', async () => {
    const { tool } = createTestAgent()
    const session = makeSession()
    const ctx = makeCtx(makeTurn(session))

    expect(tool.name).toBe('Agent')
    expect(tool.isConcurrencySafe({ prompt: 'x' })).toBe(false)
    expect(tool.isReadOnly({ prompt: 'x' })).toBe(false)
    expect(tool.interruptBehavior?.()).toBe('cancel')
    expect(await tool.checkPermissions({ prompt: 'x' }, ctx)).toEqual({
      behavior: 'allow',
      reason: 'mode',
    })

    const parsed = tool.parse({ prompt: 'do work', context: 'extra', description: 'desc' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        prompt: 'do work',
        context: 'extra',
        description: 'desc',
      })
    }

    const missing = tool.parse({})
    expect(missing.ok).toBe(false)

    const withModel = tool.parse({ prompt: 'x', model: 'other' })
    expect(withModel.ok).toBe(false)
  })

  test('child history starts empty; parent messages are not in the child request', async () => {
    const provider = createFakeProvider([textThenStop('isolated')])
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    await store.persistUser(session.id, {
      id: 'u_parent',
      role: 'user',
      blocks: [{ type: 'text', text: 'PARENT_SECRET do not leak' }],
      createdAt: 1,
    })
    const { tool } = createTestAgent({ store, provider })
    const turn = makeTurn(session)
    const result = await tool.execute({ prompt: 'child goal', context: 'ctx-note' }, makeCtx(turn))

    expect(result).toBe('isolated')
    expect(provider.streamCount).toBe(1)
    const req = provider.requests[0]
    expect(req).toBeDefined()
    const texts = (req?.messages ?? []).flatMap((msg) =>
      msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
        ? msg.blocks.map((block) => ('text' in block ? block.text : ''))
        : [],
    )
    expect(texts.some((text) => text.includes('PARENT_SECRET'))).toBe(false)
    expect(texts.some((text) => text.includes('child goal'))).toBe(true)
    expect(req?.messages).toHaveLength(1)
    expect(req?.messages[0]?.role).toBe('user')
  })

  test('child readFiles is empty so Edit without Read fails', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-agent-'))
    tempDirs.push(cwd)
    const filePath = join(cwd, 'note.txt')
    writeFileSync(filePath, 'hello')

    const store = createMemoryStore()
    const session = makeSession({ cwd })
    await store.createSession(session)
    const provider = createFakeProvider([
      toolThenStop('e1', 'Edit', {
        path: 'note.txt',
        old_string: 'hello',
        new_string: 'world',
      }),
      textThenStop('edit attempted'),
    ])
    const { tool } = createTestAgent({
      store,
      provider,
      tools: [readTool, editTool, stubTool('Agent'), stubTool('EnterPlanMode'), stubTool('ExitPlanMode')],
    })
    const turn = makeTurn(session, { readFiles: new Set([filePath]), cwd })
    const result = await tool.execute({ prompt: 'rewrite the note' }, makeCtx(turn))

    expect(result).toBe('edit attempted')
    expect(readFileSync(filePath, 'utf8')).toBe('hello')

    const children = await store.listSessions({ parentSessionId: session.id })
    expect(children).toHaveLength(1)
    const childId = children[0]?.id
    expect(childId).toBeDefined()
    const loaded = await store.loadSession(childId!)
    const editResult = loaded.messages.find(
      (msg): msg is Extract<Message, { role: 'tool' }> =>
        msg.role === 'tool' && msg.toolUseId === 'e1',
    )
    expect(editResult?.ok).toBe(true)
    expect(editResult?.blocks[0]?.text).toContain('must be Read first')
  })

  test('child tools list has no Agent or plan tools', async () => {
    const provider = createFakeProvider([textThenStop('ok')])
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const { tool } = createTestAgent({ store, provider })
    await tool.execute({ prompt: 'list tools' }, makeCtx(makeTurn(session)))

    const names = provider.requests[0]?.tools.map((entry) => entry.name) ?? []
    expect(names).not.toContain('Agent')
    expect(names).not.toContain('EnterPlanMode')
    expect(names).not.toContain('ExitPlanMode')
    expect(names).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'Skill'])
  })

  test('child.model equals parent.model; included funding stays parent.model', async () => {
    const byokProvider = createFakeProvider([textThenStop('byok')])
    const byokStore = createMemoryStore()
    const byokSession = makeSession({ model: 'parent-model', funding: 'byok' })
    await byokStore.createSession(byokSession)
    const byok = createTestAgent({
      store: byokStore,
      provider: byokProvider,
      model: defaultModel('parent-model'),
    })
    await byok.tool.execute(
      { prompt: 'byok child' },
      makeCtx(makeTurn(byokSession, { model: 'parent-model' })),
    )
    expect(byokProvider.requests[0]?.model).toBe('parent-model')
    const byokChild = (await byokStore.listSessions({ parentSessionId: byokSession.id }))[0]
    expect(byokChild?.model).toBe('parent-model')

    const includedProvider = createFakeProvider([textThenStop('included')])
    const includedStore = createMemoryStore()
    const includedSession = makeSession({
      id: 'sess_included',
      model: 'parent-model',
      funding: 'included',
    })
    await includedStore.createSession(includedSession)
    const included = createTestAgent({
      store: includedStore,
      provider: includedProvider,
      model: defaultModel('parent-model'),
    })
    await included.tool.execute(
      { prompt: 'included child' },
      makeCtx(makeTurn(includedSession, { model: 'parent-model', funding: 'included' })),
    )
    expect(includedProvider.requests[0]?.model).toBe('parent-model')
    const includedChild = (
      await includedStore.listSessions({ parentSessionId: includedSession.id })
    )[0]
    expect(includedChild?.model).toBe('parent-model')
    expect(includedChild?.funding).toBe('included')
  })

  test('result is truncated at 32k', async () => {
    const long = 'x'.repeat(RESULT_BOUND + 50)
    const provider = createFakeProvider([textThenStop(long)])
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const { tool } = createTestAgent({ store, provider })
    const result = await tool.execute({ prompt: 'ramble' }, makeCtx(makeTurn(session)))
    expect(result.length).toBe(RESULT_BOUND)
    expect(result).toBe(long.slice(0, RESULT_BOUND))
  })

  test('parentSessionId is set; child is listable and not merged into parent', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    await store.persistUser(session.id, {
      id: 'u_parent',
      role: 'user',
      blocks: [{ type: 'text', text: 'PARENT_SECRET do not leak' }],
      createdAt: 1,
    })
    const provider = createFakeProvider([
      toolThenStop('r1', 'Read', { path: 'unused.txt' }),
      textThenStop('CHILD_ONLY_TEXT'),
    ])
    const { tool } = createTestAgent({ store, provider })
    const result = await tool.execute({ prompt: 'inspect' }, makeCtx(makeTurn(session)))
    expect(result).toBe('CHILD_ONLY_TEXT')

    const children = await store.listSessions({ parentSessionId: session.id })
    expect(children).toHaveLength(1)
    expect(children[0]?.parentSessionId).toBe(session.id)
    expect(children[0]?.cwd).toBe(session.cwd)
    expect(children[0]?.compactGeneration).toBe(0)

    const parentLoaded = await store.loadSession(session.id)
    const parentTexts = parentLoaded.messages.flatMap((msg) =>
      msg.blocks.map((block) => ('text' in block ? block.text : '')),
    )
    expect(parentTexts.some((text) => text.includes('CHILD_ONLY_TEXT'))).toBe(false)
    expect(
      parentLoaded.messages.some(
        (msg) =>
          msg.role === 'assistant' &&
          msg.blocks.some((block) => block.type === 'tool_use' && block.id === 'r1'),
      ),
    ).toBe(false)

    const childLoaded = await store.loadSession(children[0]!.id)
    expect(
      childLoaded.messages.some(
        (msg) =>
          msg.role === 'assistant' &&
          msg.blocks.some((block) => block.type === 'tool_use' && block.id === 'r1'),
      ),
    ).toBe(true)
  })

  test('abort parent during child returns aborted/incomplete and does not respawn', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_abort_child' })
    await store.createSession(session)

    let childStarted!: () => void
    const childGate = new Promise<void>((resolve) => {
      childStarted = resolve
    })
    const provider = createFakeProvider([
      toolThenStop('agent_1', 'Agent', { prompt: 'subtask' }),
      async function* (_req, signal) {
        childStarted()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    ])

    const base = createTestAgent({ store, provider, tools: parentPool() })
    let executeCount = 0
    const orig = base.tool.execute.bind(base.tool)
    base.tool.execute = async (input, ctx) => {
      executeCount += 1
      return orig(input, ctx)
    }

    const engine = createSessionEngine({
      session,
      provider,
      store,
      tools: [base.tool],
      compact: defaultCompact(),
      model: defaultModel(),
      maxRounds: 8,
      askUser,
    })

    const gen = engine.submitMessage('delegate')
    const drained = collect(gen)
    await childGate
    engine.abort()
    const { result } = await drained

    expect(result).toEqual({ reason: 'aborted' })
    expect(executeCount).toBe(1)

    const loaded = await store.loadSession(session.id)
    const agentResult = loaded.messages.find(
      (msg): msg is Extract<Message, { role: 'tool' }> =>
        msg.role === 'tool' && msg.toolUseId === 'agent_1',
    )
    const text = agentResult?.blocks[0]?.text ?? ''
    expect(/aborted|incomplete/i.test(text)).toBe(true)

    const children = await store.listSessions({ parentSessionId: session.id })
    expect(children.length).toBeGreaterThanOrEqual(1)

    const resumeProvider = createFakeProvider([textThenStop('resumed parent')])
    const resumeEngine = createSessionEngine({
      session: loaded.session,
      messages: loaded.messages,
      provider: resumeProvider,
      store,
      tools: [base.tool],
      compact: defaultCompact(),
      model: defaultModel(),
      maxRounds: 8,
      askUser,
    })
    const resume = await collect(resumeEngine.submitMessage('continue'))
    expect(resume.result).toEqual({ reason: 'completed' })
    expect(executeCount).toBe(1)
    expect(resumeProvider.streamCount).toBe(1)
  })

  test('resume parent with unpaired Agent tool_use does not call execute again', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_orphan_agent' })
    await store.createSession(session)
    await store.persistUser(session.id, {
      id: 'u_orphan',
      role: 'user',
      blocks: [{ type: 'text', text: 'please delegate' }],
      createdAt: 1,
    })
    await store.persistToolCalls(session.id, {
      id: 'a_orphan',
      role: 'assistant',
      blocks: [
        { type: 'tool_use', id: 'call_orphan', name: 'Agent', input: { prompt: 'sub' } },
      ],
      createdAt: 2,
    })

    const loaded = await store.loadSession(session.id)
    const incomplete = loaded.messages.find(
      (msg): msg is Extract<Message, { role: 'tool' }> =>
        msg.role === 'tool' && msg.toolUseId === 'call_orphan',
    )
    expect(incomplete).toBeDefined()
    expect(incomplete?.ok).toBe(false)
    expect(incomplete?.blocks[0]?.text).toBe(INCOMPLETE_TEXT)

    const provider = createFakeProvider([textThenStop('continuing')])
    const { tool } = createTestAgent({ store, provider })
    let executeCount = 0
    const orig = tool.execute.bind(tool)
    tool.execute = async (input, ctx) => {
      executeCount += 1
      return orig(input, ctx)
    }

    const engine = createSessionEngine({
      session: loaded.session,
      messages: loaded.messages,
      provider,
      store,
      tools: [tool],
      compact: defaultCompact(),
      model: defaultModel(),
      maxRounds: 8,
      askUser,
    })
    const { result } = await collect(engine.submitMessage('continue'))
    expect(result).toEqual({ reason: 'completed' })
    expect(executeCount).toBe(0)
    expect(provider.streamCount).toBe(1)
  })

  test('child inherits plan permissionMode', async () => {
    const store = createMemoryStore()
    const session = makeSession({ permissionMode: 'plan', prePlanMode: 'acceptEdits' })
    await store.createSession(session)
    const provider = createFakeProvider([textThenStop('planning')])
    const plan = createPlanModeTools(store)
    const { tool } = createTestAgent({
      store,
      provider,
      tools: [...parentPool(), plan.enter, plan.exit],
    })
    const turn = makeTurn(session, { permissionMode: 'plan', prePlanMode: 'acceptEdits' })
    await tool.execute({ prompt: 'explore' }, makeCtx(turn))

    const child = (await store.listSessions({ parentSessionId: session.id }))[0]
    expect(child?.permissionMode).toBe('plan')
    expect(child?.prePlanMode).toBe('acceptEdits')
  })

  test('persistUser failure on child does not call provider.stream', async () => {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_child_persist' })
    await store.createSession(session)
    const orig = store.persistUser.bind(store)
    store.persistUser = async (sessionId, message) => {
      if (sessionId !== session.id) {
        throw new PersistError('readonly', 'cannot write child user')
      }
      return orig(sessionId, message)
    }
    const provider = createFakeProvider([textThenStop('should not run')])
    const { tool } = createTestAgent({ store, provider })

    await expect(
      tool.execute({ prompt: 'never start' }, makeCtx(makeTurn(session))),
    ).rejects.toBeInstanceOf(PersistError)
    expect(provider.streamCount).toBe(0)
  })
})
