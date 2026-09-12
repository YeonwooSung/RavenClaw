import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../session/memory-store'
import { resumeSession } from '../session/resume'
import { createSessionEngine } from '../loop/session-engine'
import { INCOMPLETE_TEXT } from '../loop/pairing'
import { PersistError } from '../types'
import { decidePermission } from '../permissions/pipeline'
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
  SystemPart,
  TokenUsage,
  Tool,
  ToolContext,
  Turn,
} from '../types'
import { createPlanModeTools } from './plan-mode'
import { editTool } from './edit'
import { readTool } from './read'
import { setChildOutput } from './set-output'
import { skillTool } from './skill'
import { createAgentTool, MAX_PARALLEL_CHILDREN } from './agent'
import { createTaskRegistry } from '../tasks/registry'
import { drainAgentMail } from '../tasks/mailbox'
import { createFileHistory } from '../session/file-history'
import { writeTool } from './write'

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

function makeCtx(turn: Turn, extra?: Partial<ToolContext>): ToolContext {
  return { turn, signal: turn.abort.signal, onProgress() {}, ...extra }
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
    system?: SystemPart[]
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
  if (over.system !== undefined) opts.system = over.system
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
    const decision = await tool.checkPermissions({ prompt: 'x' }, ctx)
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }

    const leftover = await decidePermission({
      name: 'Agent',
      input: { prompt: 'x' },
      tool,
      ctx,
      mode: 'default',
      rules: { session: [], user: [], project: [] },
    })
    expect(leftover.behavior).toBe('ask')
    if (leftover.behavior === 'ask') {
      expect(leftover.message.length).toBeGreaterThan(0)
      expect(leftover.saveAs).toBe('session')
    }

    const denied = await decidePermission({
      name: 'Agent',
      input: { prompt: 'x' },
      tool,
      ctx,
      mode: 'dontAsk',
      rules: { session: [], user: [], project: [] },
    })
    expect(denied.behavior).toBe('deny')
    if (denied.behavior === 'deny') expect(denied.reason).toBe('mode')

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

    const withSubagent = tool.parse({ prompt: 'x', subagent: 'file-finder' })
    expect(withSubagent.ok).toBe(true)
    if (withSubagent.ok) expect(withSubagent.value.subagent).toBe('file-finder')

    const withIsolation = tool.parse({ prompt: 'x', isolation: 'worktree' })
    expect(withIsolation.ok).toBe(true)
    if (withIsolation.ok) expect(withIsolation.value.isolation).toBe('worktree')

    const withCommand = tool.parse({ prompt: 'x', command: 'ls -la' })
    expect(withCommand.ok).toBe(true)
    if (withCommand.ok) expect(withCommand.value.command).toBe('ls -la')

    const badIsolation = tool.parse({ prompt: 'x', isolation: 'remote' })
    expect(badIsolation.ok).toBe(false)

    const withAgents = tool.parse({
      prompt: 'ignored',
      agents: [
        { prompt: 'one', subagent: 'general' },
        { prompt: 'two', isolation: 'none', context: 'ctx', description: 'd' },
      ],
    })
    expect(withAgents.ok).toBe(true)
    if (withAgents.ok) {
      expect(withAgents.value.agents).toEqual([
        { prompt: 'one', subagent: 'general' },
        { prompt: 'two', isolation: 'none', context: 'ctx', description: 'd' },
      ])
    }

    const agentsMissingPrompt = tool.parse({ prompt: 'x', agents: [{ subagent: 'general' }] })
    expect(agentsMissingPrompt.ok).toBe(false)

    const agentsExtraField = tool.parse({
      prompt: 'x',
      agents: [{ prompt: 'y', model: 'other' }],
    })
    expect(agentsExtraField.ok).toBe(false)
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
    const session = makeSession({ cwd, permissionMode: 'acceptEdits' })
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

  test('isolation=none child Write snapshots land on the parent fileHistory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-agent-hist-'))
    tempDirs.push(cwd)
    const store = createMemoryStore()
    const session = makeSession({ cwd, permissionMode: 'acceptEdits' })
    await store.createSession(session)
    const provider = createFakeProvider([
      toolThenStop('w1', 'Write', { path: 'out.txt', content: 'from-child' }),
      textThenStop('wrote'),
    ])
    const { tool } = createTestAgent({
      store,
      provider,
      tools: [writeTool, stubTool('Read'), stubTool('Skill')],
    })
    const history = createFileHistory(session.id, cwd)
    history.beginTurn()
    const turn = makeTurn(session, { cwd })
    const result = await tool.execute(
      { prompt: 'write the file' },
      makeCtx(turn, { fileHistory: history }),
    )
    expect(result).toBe('wrote')
    expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe('from-child')
    expect(history.turnWriteCount()).toBe(1)
    history.endTurn()
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
      askUser: async () => 'allow',
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

  test('file-finder child tools are Read, Grep, Glob only', async () => {
    const provider = createFakeProvider([textThenStop('found')])
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const { tool } = createTestAgent({ store, provider })
    await tool.execute(
      { prompt: 'find ts files', subagent: 'file-finder' },
      makeCtx(makeTurn(session)),
    )

    const names = provider.requests[0]?.tools.map((entry) => entry.name) ?? []
    expect(names).toEqual(['Read', 'Grep', 'Glob'])
    expect(names).not.toContain('Agent')
    expect(names).not.toContain('EnterPlanMode')
    expect(names).not.toContain('ExitPlanMode')
    expect(names).not.toContain('Bash')
    expect(names).not.toContain('Edit')
  })

  test('command-runner child tools are Read and Bash only', async () => {
    const provider = createFakeProvider([textThenStop('ran')])
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const { tool } = createTestAgent({ store, provider })
    await tool.execute(
      { prompt: 'run tests', subagent: 'command-runner' },
      makeCtx(makeTurn(session)),
    )

    const names = provider.requests[0]?.tools.map((entry) => entry.name) ?? []
    expect(names).toEqual(['Read', 'Bash'])
    expect(names).not.toContain('Agent')
    expect(names).not.toContain('EnterPlanMode')
    expect(names).not.toContain('ExitPlanMode')
    expect(names).not.toContain('Grep')
    expect(names).not.toContain('Edit')
  })

  test('explicit general subagent matches the default tool list', async () => {
    const provider = createFakeProvider([textThenStop('ok')])
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const { tool } = createTestAgent({ store, provider })
    await tool.execute(
      { prompt: 'list tools', subagent: 'general' },
      makeCtx(makeTurn(session)),
    )

    const names = provider.requests[0]?.tools.map((entry) => entry.name) ?? []
    expect(names).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'Skill'])
  })

  test('unknown subagent returns an error and does not spawn', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const provider = createFakeProvider([textThenStop('should not run')])
    const { tool } = createTestAgent({ store, provider })
    const result = await tool.execute(
      { prompt: 'find files', subagent: 'nope' },
      makeCtx(makeTurn(session)),
    )

    expect(result).toMatch(/unknown subagent|not spawnable/i)
    expect(provider.streamCount).toBe(0)
    const children = await store.listSessions({ parentSessionId: session.id })
    expect(children).toHaveLength(0)
  })

  test('included funding pins specialist child.model to parent.model', async () => {
    const provider = createFakeProvider([textThenStop('included')])
    const store = createMemoryStore()
    const session = makeSession({
      id: 'sess_specialist_included',
      model: 'parent-model',
      funding: 'included',
    })
    await store.createSession(session)
    const { tool } = createTestAgent({
      store,
      provider,
      model: defaultModel('parent-model'),
    })
    await tool.execute(
      { prompt: 'find', subagent: 'file-finder' },
      makeCtx(makeTurn(session, { model: 'parent-model', funding: 'included' })),
    )

    expect(provider.requests[0]?.model).toBe('parent-model')
    const child = (await store.listSessions({ parentSessionId: session.id }))[0]
    expect(child?.model).toBe('parent-model')
    expect(child?.funding).toBe('included')
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

  test('isolation worktree creates then removes a git worktree', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-agent-wt-'))
    tempDirs.push(cwd)
    initGitRepo(cwd)

    const store = createMemoryStore()
    const session = makeSession({ cwd })
    await store.createSession(session)

    let liveCwd: string | undefined
    let existedDuring = false
    const recorder: Tool = {
      ...stubTool('Read'),
      async execute(_input, ctx) {
        liveCwd = ctx.turn.cwd
        existedDuring = Boolean(liveCwd && existsSync(liveCwd))
        return 'ok'
      },
    }
    const provider = createFakeProvider([
      toolThenStop('r1', 'Read', { path: 'unused.txt' }),
      textThenStop('isolated-ok'),
    ])
    const { tool } = createTestAgent({
      store,
      provider,
      tools: parentPool().map((item) => (item.name === 'Read' ? recorder : item)),
    })
    const result = await tool.execute(
      { prompt: 'work isolated', isolation: 'worktree' },
      makeCtx(makeTurn(session, { cwd })),
    )

    expect(result).toBe('isolated-ok')
    expect(liveCwd?.startsWith(join(cwd, '.ravenclaw', 'worktrees') + '/')).toBe(true)
    expect(existedDuring).toBe(true)
    expect(liveCwd && existsSync(liveCwd)).toBe(false)

    const child = (await store.listSessions({ parentSessionId: session.id }))[0]
    expect(child?.cwd).toBe(cwd)
    expect(existsSync(child!.cwd)).toBe(true)

    const loaded = await resumeSession(store, child!.id)
    expect(loaded.session.cwd).toBe(cwd)
    expect(existsSync(loaded.session.cwd)).toBe(true)
  })

  test('isolation worktree child sees parent project skills and permissions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-agent-wt-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-agent-wt-proj-'))
    tempDirs.push(home, cwd)
    const savedHome = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    initGitRepo(cwd)

    const skillDir = join(cwd, '.ravenclaw', 'skills', 'from-parent')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: from-parent',
        'description: Project skill in the parent cwd',
        '---',
        '',
        'PARENT_PROJECT_SKILL_BODY',
      ].join('\n'),
    )
    writeFileSync(
      join(cwd, '.ravenclaw', 'permissions.json'),
      JSON.stringify([{ tool: 'Write', spec: {}, behavior: 'deny' }]),
    )

    const store = createMemoryStore()
    const session = makeSession({ cwd })
    await store.createSession(session)

    let liveCwd: string | undefined
    let childProjectCwd: string | undefined
    const recorder: Tool = {
      ...stubTool('Read'),
      async execute(_input, ctx) {
        liveCwd = ctx.turn.cwd
        childProjectCwd = ctx.turn.projectCwd
        return 'ok'
      },
    }
    const writeStub = stubTool('Write')
    let writeCount = 0
    writeStub.execute = async () => {
      writeCount += 1
      return 'wrote'
    }

    const provider = createFakeProvider([
      toolThenStop('sk1', 'Skill', { name: 'from-parent' }),
      toolThenStop('w1', 'Write', { path: 'x.txt' }),
      toolThenStop('r1', 'Read', { path: 'unused.txt' }),
      textThenStop('isolated-ok'),
    ])
    const { tool } = createTestAgent({
      store,
      provider,
      tools: parentPool().map((item) => {
        if (item.name === 'Read') return recorder
        if (item.name === 'Skill') return skillTool
        if (item.name === 'Write') return writeStub
        return item
      }),
    })

    try {
      const result = await tool.execute(
        { prompt: 'use parent project files', isolation: 'worktree' },
        makeCtx(makeTurn(session, { cwd })),
      )

      expect(result).toBe('isolated-ok')
      expect(liveCwd?.startsWith(join(cwd, '.ravenclaw', 'worktrees') + '/')).toBe(true)
      expect(childProjectCwd).toBe(cwd)
      expect(writeCount).toBe(0)

      const children = await store.listSessions({ parentSessionId: session.id })
      expect(children).toHaveLength(1)
      const loaded = await store.loadSession(children[0]!.id)
      const skillResult = loaded.messages.find(
        (msg): msg is Extract<Message, { role: 'tool' }> =>
          msg.role === 'tool' && msg.toolUseId === 'sk1',
      )
      expect(skillResult?.ok).toBe(true)
      expect(skillResult?.blocks[0]?.text).toContain('PARENT_PROJECT_SKILL_BODY')

      const writeResult = loaded.messages.find(
        (msg): msg is Extract<Message, { role: 'tool' }> =>
          msg.role === 'tool' && msg.toolUseId === 'w1',
      )
      expect(writeResult?.ok).toBe(false)
      expect(writeResult?.blocks[0]?.text).toMatch(/denied by project rule/)

      expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
      expect(existsSync(join(cwd, '.ravenclaw', 'permissions.json'))).toBe(true)
      expect(liveCwd && existsSync(liveCwd)).toBe(false)
      expect(existsSync(cwd)).toBe(true)
    } finally {
      if (savedHome === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = savedHome
    }
  })

  test('parent skillAllowedTools binds the child tool list and turn', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)

    let childAllowed: string[] | undefined
    const recorder: Tool = {
      ...stubTool('Read'),
      async execute(_input, ctx) {
        childAllowed = ctx.turn.skillAllowedTools
        return 'ok'
      },
    }
    const provider = createFakeProvider([
      toolThenStop('r1', 'Read', { path: 'unused.txt' }),
      textThenStop('bound'),
    ])
    const { tool } = createTestAgent({
      store,
      provider,
      tools: parentPool().map((item) => (item.name === 'Read' ? recorder : item)),
    })
    const result = await tool.execute(
      { prompt: 'stay read-only' },
      makeCtx(makeTurn(session, { skillAllowedTools: ['Read'] })),
    )

    expect(result).toBe('bound')
    expect(childAllowed).toEqual(['Read'])

    const names = provider.requests[0]?.tools.map((entry) => entry.name) ?? []
    expect(names).toContain('Read')
    expect(names).toContain('Skill')
    expect(names).not.toContain('Edit')
    expect(names).not.toContain('Write')
    expect(names).not.toContain('Bash')
    expect(names).not.toContain('Agent')
    expect(names).not.toContain('EnterPlanMode')
    expect(names).not.toContain('ExitPlanMode')
  })

  test('disk agent ids are spawnable', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-agent-disk-'))
    tempDirs.push(cwd)
    mkdirSync(join(cwd, '.ravenclaw', 'agents'), { recursive: true })
    writeFileSync(
      join(cwd, '.ravenclaw', 'agents', 'disk-helper.md'),
      '---\nname: disk-helper\nallowed-tools: Read\n---\nReview only.\n',
    )
    const store = createMemoryStore()
    const session = makeSession({ cwd })
    await store.createSession(session)
    const provider = createFakeProvider([textThenStop('reviewed')])
    const { tool } = createTestAgent({ store, provider })
    const result = await tool.execute(
      { prompt: 'review', subagent: 'disk-helper' },
      makeCtx(makeTurn(session, { cwd })),
    )
    expect(result).toBe('reviewed')
    expect(provider.streamCount).toBe(1)
  })

  test('subagent not in root spawnableAgents returns an error and does not spawn', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const provider = createFakeProvider([textThenStop('should not run')])
    const { tool } = createTestAgent({ store, provider })
    const result = await tool.execute(
      { prompt: 'find files', subagent: 'root' },
      makeCtx(makeTurn(session)),
    )

    expect(result).toMatch(/not spawnable/i)
    expect(provider.streamCount).toBe(0)
    const children = await store.listSessions({ parentSessionId: session.id })
    expect(children).toHaveLength(0)
  })

  test('default general subagent is allowed without an explicit subagent field', async () => {
    const provider = createFakeProvider([textThenStop('ok')])
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const { tool } = createTestAgent({ store, provider })
    const result = await tool.execute({ prompt: 'list tools' }, makeCtx(makeTurn(session)))
    expect(result).toBe('ok')
    expect(provider.streamCount).toBe(1)
  })

  test('general inherits parent system; specialists use definition.systemPrompt', async () => {
    const parentSystem: SystemPart[] = [{ tier: 'stable', text: 'PARENT_SYSTEM_UNIQUE' }]
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)

    const generalProvider = createFakeProvider([textThenStop('g')])
    const general = createTestAgent({ store, provider: generalProvider, system: parentSystem })
    await general.tool.execute({ prompt: 'go', subagent: 'general' }, makeCtx(makeTurn(session)))
    expect(generalProvider.requests[0]?.system).toEqual(parentSystem)

    const finderProvider = createFakeProvider([textThenStop('f')])
    const finder = createTestAgent({ store, provider: finderProvider, system: parentSystem })
    await finder.tool.execute(
      { prompt: 'find', subagent: 'file-finder' },
      makeCtx(makeTurn(session)),
    )
    const finderSystem = finderProvider.requests[0]?.system ?? []
    expect(finderSystem).toHaveLength(1)
    expect(finderSystem[0]?.text).toContain('path — reason')
    expect(finderSystem.some((part) => part.text.includes('PARENT_SYSTEM_UNIQUE'))).toBe(false)

    const runnerProvider = createFakeProvider([textThenStop('r')])
    const runner = createTestAgent({ store, provider: runnerProvider, system: parentSystem })
    await runner.tool.execute(
      { prompt: 'run tests', subagent: 'command-runner' },
      makeCtx(makeTurn(session)),
    )
    const runnerSystem = runnerProvider.requests[0]?.system ?? []
    expect(runnerSystem).toHaveLength(1)
    expect(runnerSystem[0]?.text).toMatch(/command/i)
    expect(runnerSystem.some((part) => part.text.includes('PARENT_SYSTEM_UNIQUE'))).toBe(false)
  })

  test('file-finder child prompt asks for path — reason lines; empty last text is returned', async () => {
    const provider = createFakeProvider([textThenStop('')])
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const { tool } = createTestAgent({ store, provider })
    const result = await tool.execute(
      { prompt: 'find ts files', subagent: 'file-finder' },
      makeCtx(makeTurn(session)),
    )

    expect(result).toBe('')
    const texts = (provider.requests[0]?.messages ?? []).flatMap((msg) =>
      msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
        ? msg.blocks.map((block) => ('text' in block ? block.text : ''))
        : [],
    )
    expect(texts.some((text) => text.includes('path — reason'))).toBe(true)
    expect(texts.some((text) => text.includes('find ts files'))).toBe(true)
  })

  test('command-runner with command runs Bash once and skips the child loop', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)

    let bashCalls = 0
    let seenCommand: string | undefined
    const bash: Tool = {
      ...stubTool('Bash'),
      async execute(input) {
        bashCalls += 1
        seenCommand = (input as { command?: string }).command
        return 'stdout from ls\nexit_code=0\n'
      },
    }
    const provider = createFakeProvider([textThenStop('should not run')])
    const { tool } = createTestAgent({
      store,
      provider,
      tools: parentPool().map((item) => (item.name === 'Bash' ? bash : item)),
    })
    const result = await tool.execute(
      { prompt: 'run this', subagent: 'command-runner', command: 'ls -la' },
      makeCtx(makeTurn(session)),
    )

    expect(result).toContain('stdout from ls')
    expect(seenCommand).toBe('ls -la')
    expect(bashCalls).toBe(1)
    expect(provider.streamCount).toBe(0)
    const children = await store.listSessions({ parentSessionId: session.id })
    expect(children).toHaveLength(1)
  })

  test('command-runner long bash output runs one helper round', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)

    const longOut = 'x'.repeat(2000)
    const bash: Tool = {
      ...stubTool('Bash'),
      async execute() {
        return longOut
      },
    }
    const provider = createFakeProvider([textThenStop('summarized')])
    const { tool } = createTestAgent({
      store,
      provider,
      tools: parentPool().map((item) => (item.name === 'Bash' ? bash : item)),
    })
    const result = await tool.execute(
      { prompt: 'run this', subagent: 'command-runner', command: 'yes | head' },
      makeCtx(makeTurn(session)),
    )

    expect(result).toBe('summarized')
    expect(provider.streamCount).toBe(1)
    const texts = (provider.requests[0]?.messages ?? []).flatMap((msg) =>
      msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
        ? msg.blocks.map((block) => ('text' in block ? block.text : ''))
        : [],
    )
    expect(texts.some((text) => text.includes(longOut))).toBe(true)
  })

  test('includeMessageHistory copies parent messages and excludes the current Agent tool_use', async () => {
    const { fileFinderAgent } = await import('../agent/file-finder')
    const prev = fileFinderAgent.includeMessageHistory
    fileFinderAgent.includeMessageHistory = true
    try {
      const provider = createFakeProvider([textThenStop('found')])
      const store = createMemoryStore()
      const session = makeSession()
      await store.createSession(session)
      const { tool } = createTestAgent({ store, provider })
      const turn = makeTurn(session, {
        messages: [
          {
            id: 'u_parent',
            role: 'user',
            blocks: [{ type: 'text', text: 'PARENT_SECRET do not leak unless history' }],
            createdAt: 1,
          },
          {
            id: 'a_parent',
            role: 'assistant',
            blocks: [
              { type: 'text', text: 'searching' },
              {
                type: 'tool_use',
                id: 'agent_now',
                name: 'Agent',
                input: { prompt: 'find ts', subagent: 'file-finder' },
              },
            ],
            createdAt: 2,
          },
        ],
      })
      const result = await tool.execute(
        { prompt: 'find ts', subagent: 'file-finder' },
        makeCtx(turn),
      )
      expect(result).toBe('found')
      const texts = (provider.requests[0]?.messages ?? []).flatMap((msg) =>
        msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
          ? msg.blocks.map((block) => ('text' in block ? block.text : ''))
          : [],
      )
      expect(texts.some((text) => text.includes('PARENT_SECRET'))).toBe(true)
      expect(texts.some((text) => text.includes('find ts'))).toBe(true)
      expect(
        (provider.requests[0]?.messages ?? []).some(
          (msg) =>
            msg.role === 'assistant' &&
            msg.blocks.some((block) => block.type === 'tool_use' && block.id === 'agent_now'),
        ),
      ).toBe(false)
    } finally {
      fileFinderAgent.includeMessageHistory = prev
    }
  })

  test('child token usage is added to the parent turn after the child completes', async () => {
    const usage: TokenUsage = { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 }
    const provider = createFakeProvider([
      [
        { type: 'text_delta', text: 'done' },
        { type: 'usage', usage },
        { type: 'stop', reason: 'end' },
      ],
    ])
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const { tool } = createTestAgent({ store, provider })
    const turn = makeTurn(session, {
      usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 1 },
    })
    const result = await tool.execute({ prompt: 'work' }, makeCtx(turn))
    expect(result).toBe('done')
    expect(turn.usage).toEqual({ input: 15, output: 8, cacheRead: 3, cacheWrite: 3 })
  })

  test('parallel agents run two children and ignore the top-level prompt', async () => {
    function replyFromPrompt() {
      return async function* (req: ProviderRequest) {
        const texts = req.messages.flatMap((msg) =>
          msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
            ? msg.blocks.map((block) => ('text' in block ? block.text : ''))
            : [],
        )
        const prompt = texts.find((text) => text.includes('task-a') || text.includes('task-b')) ?? ''
        const label = prompt.includes('task-a') ? 'out-a' : 'out-b'
        yield { type: 'text_delta' as const, text: label }
        yield { type: 'stop' as const, reason: 'end' }
      }
    }
    const provider = createFakeProvider([replyFromPrompt(), replyFromPrompt()])
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const { tool } = createTestAgent({ store, provider })
    const turn = makeTurn(session, {
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    })
    const result = await tool.execute(
      {
        prompt: 'TOP_LEVEL_SHOULD_NOT_RUN',
        agents: [
          { prompt: 'task-a', subagent: 'general' },
          { prompt: 'task-b', subagent: 'file-finder' },
        ],
      },
      makeCtx(turn),
    )

    expect(result).toBe('## 1 (general)\nout-a\n\n## 2 (file-finder)\nout-b')
    expect(provider.streamCount).toBe(2)
    const children = await store.listSessions({ parentSessionId: session.id })
    expect(children).toHaveLength(2)
    const allReqText = provider.requests.flatMap((req) =>
      req.messages.flatMap((msg) =>
        msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
          ? msg.blocks.map((block) => ('text' in block ? block.text : ''))
          : [],
      ),
    )
    expect(allReqText.some((text) => text.includes('TOP_LEVEL_SHOULD_NOT_RUN'))).toBe(false)
    expect(tool.isConcurrencySafe({ prompt: 'x', agents: [{ prompt: 'a' }] })).toBe(false)
  })

  test('parallel agents include rejected reasons', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const orig = store.persistUser.bind(store)
    store.persistUser = async (sessionId, message) => {
      const text =
        message.blocks[0] && message.blocks[0].type === 'text' ? message.blocks[0].text : ''
      if (text.includes('fail-child')) {
        throw new PersistError('readonly', 'second child persist failed')
      }
      return orig(sessionId, message)
    }
    const provider = createFakeProvider([textThenStop('first-ok'), textThenStop('should-not')])
    const { tool } = createTestAgent({ store, provider })
    const result = await tool.execute(
      {
        prompt: 'ignored',
        agents: [{ prompt: 'ok-child' }, { prompt: 'fail-child', subagent: 'general' }],
      },
      makeCtx(makeTurn(session)),
    )

    expect(result).toContain('## 1 (general)\nfirst-ok')
    expect(result).toContain('## 2 (general)')
    expect(result).toMatch(/second child persist failed/)
  })

  test('takeChildOutput is preferred over last assistant text', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    let childId: string | undefined
    const orig = store.createSession.bind(store)
    store.createSession = async (next) => {
      if (next.parentSessionId === session.id) childId = next.id
      return orig(next)
    }
    const provider = createFakeProvider([
      async function* () {
        expect(childId).toBeDefined()
        setChildOutput(childId!, 'structured-out')
        yield { type: 'text_delta' as const, text: 'last message text' }
        yield { type: 'stop' as const, reason: 'end' }
      },
    ])
    const { tool } = createTestAgent({ store, provider })
    const result = await tool.execute({ prompt: 'produce output' }, makeCtx(makeTurn(session)))
    expect(result).toBe('structured-out')
    expect(result).not.toBe('last message text')
  })

  test('unknown subagent in agents[] is reported and does not spawn that child', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const provider = createFakeProvider([textThenStop('ok')])
    const { tool } = createTestAgent({ store, provider })
    const result = await tool.execute(
      {
        prompt: 'ignored',
        agents: [
          { prompt: 'good', subagent: 'general' },
          { prompt: 'bad', subagent: 'nope' },
        ],
      },
      makeCtx(makeTurn(session)),
    )

    expect(result).toContain('## 1 (general)\nok')
    expect(result).toMatch(/## 2 \(nope\)/)
    expect(result).toMatch(/unknown subagent|not spawnable/i)
    expect(provider.streamCount).toBe(1)
    const children = await store.listSessions({ parentSessionId: session.id })
    expect(children).toHaveLength(1)
  })

  test('reviewer has no tools and receives parent history', async () => {
    const provider = createFakeProvider([textThenStop('no findings')])
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const { tool } = createTestAgent({ store, provider })
    const turn = makeTurn(session, {
      messages: [
        {
          id: 'u_parent',
          role: 'user',
          blocks: [{ type: 'text', text: 'PARENT_SECRET recent edit in src/a.ts' }],
          createdAt: 1,
        },
        {
          id: 'a_parent',
          role: 'assistant',
          blocks: [
            { type: 'text', text: 'delegating review' },
            {
              type: 'tool_use',
              id: 'agent_now',
              name: 'Agent',
              input: { prompt: 'review edits', subagent: 'reviewer' },
            },
          ],
          createdAt: 2,
        },
      ],
    })
    const result = await tool.execute(
      { prompt: 'review edits', subagent: 'reviewer' },
      makeCtx(turn),
    )
    expect(result).toBe('no findings')
    expect(provider.requests[0]?.tools.map((entry) => entry.name) ?? []).toEqual([])
    const texts = (provider.requests[0]?.messages ?? []).flatMap((msg) =>
      msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
        ? msg.blocks.map((block) => ('text' in block ? block.text : ''))
        : [],
    )
    expect(texts.some((text) => text.includes('PARENT_SECRET'))).toBe(true)
    expect(
      (provider.requests[0]?.messages ?? []).some(
        (msg) =>
          msg.role === 'assistant' &&
          msg.blocks.some((block) => block.type === 'tool_use' && block.id === 'agent_now'),
      ),
    ).toBe(false)
  })

  test('researcher-web child tools are WebSearch and Fetch when present', async () => {
    const provider = createFakeProvider([textThenStop('cited')])
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const { tool } = createTestAgent({
      store,
      provider,
      tools: [...parentPool(), stubTool('WebSearch'), stubTool('Fetch')],
    })
    await tool.execute(
      { prompt: 'research bun test', subagent: 'researcher-web' },
      makeCtx(makeTurn(session)),
    )
    expect(provider.requests[0]?.tools.map((entry) => entry.name) ?? []).toEqual([
      'WebSearch',
      'Fetch',
    ])
  })

  test('agents[] longer than MAX_PARALLEL_CHILDREN is rejected without spawning', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const provider = createFakeProvider([textThenStop('should-not')])
    const { tool } = createTestAgent({ store, provider })
    const agents = Array.from({ length: MAX_PARALLEL_CHILDREN + 1 }, (_, i) => ({
      prompt: `child-${i}`,
    }))
    const result = await tool.execute({ prompt: 'ignored', agents }, makeCtx(makeTurn(session)))
    expect(result).toBe('Agent failed: at most 6 parallel children')
    expect(provider.streamCount).toBe(0)
    expect(await store.listSessions({ parentSessionId: session.id })).toHaveLength(0)
  })

  test('run_in_background rejects when live agent slots are full', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const provider = createFakeProvider([textThenStop('should-not')])
    const { tool } = createTestAgent({ store, provider })
    const tasks = createTaskRegistry()
    const ctx = { ...makeCtx(makeTurn(session)), tasks }
    for (let i = 0; i < 6; i++) {
      tasks.register({
        type: 'agent',
        command: `hold-${i}`,
        outputFile: '/tmp/hold',
        kill: () => {},
      })
    }
    const result = await tool.execute({ prompt: 'one more', run_in_background: true }, ctx)
    expect(result).toBe('Agent failed: at most 6 background agents')
    expect(provider.streamCount).toBe(0)
  })

  test('run_in_background with agents[] is rejected', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const provider = createFakeProvider([textThenStop('should-not')])
    const { tool } = createTestAgent({ store, provider })
    const tasks = createTaskRegistry()
    const ctx = { ...makeCtx(makeTurn(session)), tasks }
    const result = await tool.execute(
      {
        prompt: 'ignored',
        run_in_background: true,
        agents: [{ prompt: 'one' }, { prompt: 'two' }],
      },
      ctx,
    )
    expect(result).toBe('Agent failed: agents[] cannot run in the background')
    expect(provider.streamCount).toBe(0)
    expect(tasks.list()).toHaveLength(0)
  })

  test('run_in_background returns dispatched JSON and enqueues mailbox on complete', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-agent-bg-'))
    tempDirs.push(home)
    const savedHome = process.env.RAVENCLAW_HOME
    process.env.RAVENCLAW_HOME = home
    const session = makeSession()
    const store = createMemoryStore()
    try {
      await store.createSession(session)
      const provider = createFakeProvider([textThenStop('bg-done')])
      const { tool } = createTestAgent({ store, provider })
      const tasks = createTaskRegistry()
      const turn = makeTurn(session)
      const ctx = { ...makeCtx(turn), tasks }
      const result = await tool.execute({ prompt: 'bg work', run_in_background: true }, ctx)
      const parsed = JSON.parse(result) as {
        status: string
        taskId: string
        childSessionId: string
      }
      expect(parsed).toEqual({
        status: 'dispatched',
        taskId: parsed.taskId,
        childSessionId: parsed.childSessionId,
      })
      expect(parsed.taskId.length).toBeGreaterThan(0)
      expect(parsed.childSessionId.length).toBeGreaterThan(0)
      expect(result).not.toContain('\n')

      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const task = tasks.get(parsed.taskId)
        if (task && task.status !== 'running') break
        await Bun.sleep(10)
      }
      expect(tasks.get(parsed.taskId)?.status).toBe('completed')
      const children = await store.listSessions({ parentSessionId: session.id })
      expect(children).toHaveLength(1)
      expect(children[0]?.id).toBe(parsed.childSessionId)

      const notices = await drainAgentMail(store, session.id)
      expect(notices).toHaveLength(1)
      expect(notices[0]).toBe(`subagent finished (${parsed.taskId}):\nbg-done`)
    } finally {
      await drainAgentMail(store, session.id)
      if (savedHome === undefined) delete process.env.RAVENCLAW_HOME
      else process.env.RAVENCLAW_HOME = savedHome
    }
  })

  test('command-runner one-shot persists tool_use before Bash.execute', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)

    const order: string[] = []
    const origPersist = store.persistToolCalls.bind(store)
    store.persistToolCalls = async (sessionId, message) => {
      order.push('persistToolCalls')
      return origPersist(sessionId, message)
    }

    let bashCalls = 0
    const bash: Tool = {
      ...stubTool('Bash'),
      async execute(input) {
        order.push('execute')
        bashCalls += 1
        return `ran ${(input as { command?: string }).command}`
      },
    }
    const provider = createFakeProvider([textThenStop('should not run')])
    const { tool } = createTestAgent({
      store,
      provider,
      tools: parentPool().map((item) => (item.name === 'Bash' ? bash : item)),
    })
    const result = await tool.execute(
      { prompt: 'run this', subagent: 'command-runner', command: 'ls -la' },
      makeCtx(makeTurn(session)),
    )

    expect(result).toContain('ran ls -la')
    expect(bashCalls).toBe(1)
    expect(provider.streamCount).toBe(0)
    expect(order).toEqual(['persistToolCalls', 'execute'])

    const child = (await store.listSessions({ parentSessionId: session.id }))[0]
    expect(child).toBeDefined()
    const loaded = await store.loadSession(child!.id)
    const asst = loaded.messages.find(
      (msg): msg is Extract<Message, { role: 'assistant' }> =>
        msg.role === 'assistant' &&
        msg.blocks.some((block) => block.type === 'tool_use' && block.name === 'Bash'),
    )
    expect(asst).toBeDefined()
    const toolUse = asst?.blocks.find(
      (block): block is Extract<(typeof asst.blocks)[number], { type: 'tool_use' }> =>
        block.type === 'tool_use' && block.name === 'Bash',
    )
    expect(toolUse?.input).toEqual({ command: 'ls -la' })
    const toolResult = loaded.messages.find(
      (msg): msg is Extract<Message, { role: 'tool' }> =>
        msg.role === 'tool' && msg.toolUseId === toolUse?.id,
    )
    expect(toolResult?.ok).toBe(true)
    expect(toolResult?.blocks[0]?.text).toContain('ran ls -la')
  })

  test('command-runner persistToolCalls failure does not execute Bash', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    store.persistToolCalls = async () => {
      throw new PersistError('readonly', 'cannot persist child tool_use')
    }

    let bashCalls = 0
    const bash: Tool = {
      ...stubTool('Bash'),
      async execute() {
        bashCalls += 1
        return 'should not run'
      },
    }
    const provider = createFakeProvider([textThenStop('should not run')])
    const { tool } = createTestAgent({
      store,
      provider,
      tools: parentPool().map((item) => (item.name === 'Bash' ? bash : item)),
    })
    const result = await tool.execute(
      { prompt: 'run this', subagent: 'command-runner', command: 'echo hi' },
      makeCtx(makeTurn(session)),
    )

    expect(bashCalls).toBe(0)
    expect(provider.streamCount).toBe(0)
    expect(result).toMatch(/persist_failed/)
  })

  test('spawnChild persistUsers once via submitMessage (one user row, not two)', async () => {
    const store = createMemoryStore()
    const session = makeSession()
    await store.createSession(session)
    const provider = createFakeProvider([textThenStop('child done')])
    const { tool } = createTestAgent({ store, provider })
    const result = await tool.execute({ prompt: 'single user row' }, makeCtx(makeTurn(session)))
    expect(result).toBe('child done')

    const child = (await store.listSessions({ parentSessionId: session.id }))[0]
    expect(child).toBeDefined()
    const loaded = await store.loadSession(child!.id)
    const users = loaded.messages.filter((msg) => msg.role === 'user')
    expect(users).toHaveLength(1)
    const text = users[0]?.blocks[0]?.type === 'text' ? users[0].blocks[0].text : ''
    expect(text).toContain('single user row')
  })

  test('isolation worktree falls back to parent cwd when not a git repo', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ravenclaw-agent-nowt-'))
    tempDirs.push(cwd)
    const store = createMemoryStore()
    const session = makeSession({ cwd })
    await store.createSession(session)
    const provider = createFakeProvider([textThenStop('fallback')])
    const { tool } = createTestAgent({ store, provider })
    const result = await tool.execute(
      { prompt: 'no git', isolation: 'worktree' },
      makeCtx(makeTurn(session, { cwd })),
    )
    expect(result).toBe('fallback')
    const child = (await store.listSessions({ parentSessionId: session.id }))[0]
    expect(child?.cwd).toBe(cwd)
  })
})

function initGitRepo(dir: string): void {
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    expect(result.status).toBe(0)
  }
  run(['init'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['commit', '--allow-empty', '-m', 'init'])
}

