import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INCOMPLETE_TEXT, unpairedToolUseIds } from '../loop/pairing'
import { createSessionEngine } from '../loop/session-engine'
import { createMemoryStore } from '../session/memory-store'
import { enterSessionWorktree, exitSessionWorktree } from '../tools/session-worktree'
import { writeTool } from '../tools/write'
import type {
  CompactPolicy,
  Message,
  ModelProfile,
  Provider,
  ProviderChunk,
  ProviderRequest,
  RoundEnd,
  SessionRecord,
  SessionStore,
  StreamEvent,
  SystemPart,
  TodoItem,
  Tool,
  ToolContext,
} from '../types'

export const DEFAULT_EVAL_FIXTURES_DIR = join(import.meta.dir, 'fixtures')

type EvalExpect = {
  pendingAskPersists?: boolean
  noIncomplete?: boolean
  pairing?: boolean
  writeOutsideCwdDenied?: boolean
  memoryStaysSystem?: boolean
  todosRestored?: boolean
  cancelNotFail?: boolean
  afterSeqReplays?: boolean
  shadowBranchCurrent?: boolean
}

type EvalCase = {
  prompt: string
  expect: EvalExpect
}

export async function runEvalDir(dir: string): Promise<void> {
  const names = listFixtureNames(dir)
  if (names.length === 0) throw new Error(`no eval fixtures in ${dir}`)
  for (const name of names) {
    const spec = readCase(join(dir, name, 'case.json'))
    if (name === 'pending-ask-persist') {
      await runPendingAskPersist(spec)
      continue
    }
    if (name === 'sandbox-cwd') {
      await runSandboxCwd(spec)
      continue
    }
    if (name === 'compact-memory-prefix') {
      await runCompactMemoryPrefix(spec)
      continue
    }
    if (name === 'todo-restore') {
      await runTodoRestore(spec)
      continue
    }
    if (name === 'cancel-not-fail') {
      await runCancelNotFail(spec)
      continue
    }
    if (name === 'stream-reconnect') {
      await runStreamReconnect(spec)
      continue
    }
    if (name === 'job-shadow-branch') {
      await runJobShadowBranch(spec)
      continue
    }
    throw new Error(`unknown eval fixture: ${name}`)
  }
}

function listFixtureNames(dir: string): string[] {
  if (!existsSync(dir)) throw new Error(`eval dir not found: ${dir}`)
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'case.json')))
    .map((entry) => entry.name)
    .sort()
}

function readCase(path: string): EvalCase {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!raw || typeof raw !== 'object') throw new Error(`${path}: case.json must be an object`)
  const obj = raw as Record<string, unknown>
  if ('id' in obj) throw new Error(`${path}: eval fixture must not author id; path is identity`)
  if (typeof obj.prompt !== 'string' || obj.prompt.trim() === '') {
    throw new Error(`${path}: prompt must be a non-empty string`)
  }
  if (!obj.expect || typeof obj.expect !== 'object') {
    throw new Error(`${path}: expect must be an object`)
  }
  const expect = obj.expect as EvalExpect
  return { prompt: obj.prompt, expect }
}

async function runPendingAskPersist(spec: EvalCase): Promise<void> {
  const store = createMemoryStore()
  const session = makeSession()
  await store.createSession(session)

  let release!: (answer: 'allow' | 'deny' | 'allow_always') => void
  const held = new Promise<'allow' | 'deny' | 'allow_always'>((resolve) => {
    release = resolve
  })

  const echo = createAskEcho()
  const provider = createFakeProvider([
    toolThenStop('call_eval', 'Echo', { text: 'hi' }),
    textThenStop('done'),
  ])
  const engine = createSessionEngine({
    session,
    provider,
    store,
    tools: [echo],
    compact: defaultCompact(),
    model: defaultModel(),
    maxRounds: 8,
    bare: true,
    askUser: async () => held,
  })

  const gen = engine.submitMessage(spec.prompt)
  const pumping = drain(gen)
  let pending: Awaited<ReturnType<SessionStore['listPendingAsks']>>
  try {
    pending = await waitForPendingAsks(store, session.id)
    if (spec.expect.pendingAskPersists === true && pending.length === 0) {
      throw new Error('pending-ask-persist: expected listPendingAsks nonempty')
    }
  } catch (error) {
    release('deny')
    await pumping
    throw error
  }

  const cloned = await cloneStore(store)
  release('deny')
  await pumping

  const loaded = await cloned.loadSession(session.id)
  if (spec.expect.noIncomplete === true && hasIncompleteToolRow(loaded.messages)) {
    throw new Error('pending-ask-persist: loadSession inserted an incomplete tool row')
  }

  const resumed = createSessionEngine({
    session: loaded.session,
    messages: loaded.messages,
    provider: createFakeProvider([textThenStop('resumed')]),
    store: cloned,
    tools: [createAskEcho()],
    compact: defaultCompact(),
    model: defaultModel(),
    maxRounds: 8,
    bare: true,
    askUser: async () => 'deny',
  })

  if (typeof resumed.applyAskAnswer !== 'function') {
    throw new Error('pending-ask-persist: applyAskAnswer is missing')
  }

  const callId = pending[0]?.callId
  if (spec.expect.pairing === true) {
    if (callId === undefined) {
      throw new Error('pending-ask-persist: no pending callId to pair')
    }
    const status = await resumed.applyAskAnswer(callId, 'deny')
    if (status !== 'matched') {
      throw new Error(`pending-ask-persist: applyAskAnswer deny returned ${status}`)
    }
    const after = await cloned.loadSession(session.id)
    if (unpairedToolUseIds(after.messages).length > 0) {
      throw new Error('pending-ask-persist: applyAskAnswer deny did not pair')
    }
  }

  await engine.close()
  await resumed.close()
}

async function runSandboxCwd(spec: EvalCase): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'raven-eval-sandbox-'))
  const outside = join(tmpdir(), `raven-eval-outside-${crypto.randomUUID()}.txt`)
  try {
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_eval_sandbox_cwd', cwd })
    await store.createSession(session)
    const provider = createFakeProvider([
      toolThenStop('call_eval', 'Write', { path: outside, content: 'x' }),
      textThenStop('done'),
    ])
    const engine = createSessionEngine({
      session,
      provider,
      store,
      tools: [writeTool],
      compact: defaultCompact(),
      model: defaultModel(),
      maxRounds: 8,
      bare: true,
      terminalBackend: 'docker',
      askUser: async () => 'allow',
    })
    await drain(engine.submitMessage(spec.prompt))
    const loaded = await store.loadSession(session.id)
    const writeText = toolResultText(loaded.messages)
    if (spec.expect.writeOutsideCwdDenied === true) {
      if (!/outside workspace|must be Read first|Write failed/.test(writeText)) {
        throw new Error(
          `sandbox-cwd: expected Write to deny outside cwd, got ${JSON.stringify(writeText)}`,
        )
      }
      if (existsSync(outside) || existsSync('/tmp/raven-eval-outside.txt')) {
        throw new Error('sandbox-cwd: write created a file outside cwd')
      }
    }
    await engine.close()
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(outside, { force: true })
  }
}

async function runCompactMemoryPrefix(spec: EvalCase): Promise<void> {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_eval_compact_memory' })
  await store.createSession(session)
  const memoryPart: SystemPart = {
    tier: 'stable',
    text: 'MEMORY.md unique-bytes-xyz',
  }
  const history: Message[] = [
    { id: 'u0', role: 'user', blocks: [{ type: 'text', text: 'old' }], createdAt: 1 },
    { id: 'a0', role: 'assistant', blocks: [{ type: 'text', text: 'old reply' }], createdAt: 2 },
    { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'recent' }], createdAt: 3 },
    {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'recent reply' }],
      createdAt: 4,
      usage: { input: 200, output: 20, cacheRead: 10, cacheWrite: 0 },
    },
  ]
  for (const msg of history) {
    if (msg.role === 'user') await store.persistUser(session.id, msg)
    else await store.persistAssistant(session.id, msg)
  }

  const seen: ProviderRequest[] = []
  const provider = createFakeProvider([textThenStop('after compact')])
  const orig = provider.stream.bind(provider)
  provider.stream = async function* (req: ProviderRequest, signal: AbortSignal) {
    seen.push(req)
    yield* orig(req, signal)
  }

  const engine = createSessionEngine({
    session,
    messages: history,
    provider,
    store,
    tools: [],
    compact: {
      ...defaultCompact(),
      autoCompactBuffer: 13,
      protectLastMessages: 2,
      llmSummarize: false,
    },
    model: { ...defaultModel(), contextWindow: 200, reserveOutputTokens: 20 },
    maxRounds: 8,
    bare: true,
    system: [memoryPart],
    askUser: async () => 'deny',
  })

  const before = JSON.stringify([memoryPart])
  await engine.compactNow()
  if (engine.session.compactGeneration < 1) {
    throw new Error('compact-memory-prefix: compactNow did not compact')
  }

  if (spec.expect.memoryStaysSystem === true) {
    await drain(engine.submitMessage(spec.prompt))
    const system = seen[0]?.system
    if (JSON.stringify(system) !== before) {
      throw new Error(
        `compact-memory-prefix: system snapshot changed: ${JSON.stringify(system)}`,
      )
    }
    if (!system?.some((part) => 'text' in part && part.text.includes('unique-bytes-xyz'))) {
      throw new Error('compact-memory-prefix: MEMORY left the system snapshot')
    }
    const loaded = await store.loadSession(session.id)
    const blob = JSON.stringify(loaded.messages)
    if (blob.includes('unique-bytes-xyz') && system === undefined) {
      throw new Error('compact-memory-prefix: MEMORY moved into messages and system was dropped')
    }
    const prefix = system[0]?.text ?? ''
    if (prefix !== 'MEMORY.md unique-bytes-xyz') {
      throw new Error('compact-memory-prefix: compact summary is the new system prefix')
    }
  }

  await engine.close()
}

async function runTodoRestore(spec: EvalCase): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'raven-eval-todo-'))
  try {
    const todos: TodoItem[] = [
      { id: 't1', text: 'one', status: 'pending' },
      { id: 't2', text: 'two', status: 'in_progress' },
      { id: 't3', text: 'three', status: 'done' },
    ]
    const store = createMemoryStore()
    const session = makeSession({ id: 'sess_eval_todo_restore', cwd, todos })
    await store.createSession(session)
    const history: Message[] = [
      { id: 'u0', role: 'user', blocks: [{ type: 'text', text: 'old' }], createdAt: 1 },
      {
        id: 'a0',
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: 'td', name: 'TodoWrite', input: { items: [] } }],
        createdAt: 2,
      },
      {
        id: 't0',
        role: 'tool',
        toolUseId: 'td',
        ok: true,
        blocks: [{ type: 'text', text: 'Wrote 3' }],
        createdAt: 3,
      },
      { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'recent' }], createdAt: 4 },
      {
        id: 'a1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'recent reply' }],
        createdAt: 5,
        usage: { input: 200, output: 20, cacheRead: 10, cacheWrite: 0 },
      },
    ]
    await persistHistory(store, session.id, history)

    const seen: ProviderRequest[] = []
    const provider = createFakeProvider([textThenStop('after compact')])
    const orig = provider.stream.bind(provider)
    provider.stream = async function* (req: ProviderRequest, signal: AbortSignal) {
      seen.push(req)
      yield* orig(req, signal)
    }

    const engine = createSessionEngine({
      session,
      messages: history,
      provider,
      store,
      tools: [],
      compact: { ...defaultCompact(), protectLastMessages: 2, llmSummarize: false },
      model: defaultModel(),
      maxRounds: 8,
      bare: true,
      askUser: async () => 'deny',
    })

    await engine.compactNow()
    if (engine.session.compactGeneration < 1) {
      throw new Error('todo-restore: compactNow did not compact')
    }

    await drain(engine.submitMessage(spec.prompt))
    const blob = messageText(seen[0]?.messages ?? [])
    if (spec.expect.todosRestored === true) {
      for (const text of ['one', 'two', 'three'] as const) {
        if (!blob.includes(text)) {
          throw new Error(`todo-restore: compacted request missing ${text}: ${blob}`)
        }
      }
      if (!blob.includes('Todos:\n- [pending] one\n- [in_progress] two\n- [done] three')) {
        throw new Error(`todo-restore: restore-note missing from next request: ${blob}`)
      }
    }
    await engine.close()
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function runCancelNotFail(spec: EvalCase): Promise<void> {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_eval_cancel_not_fail' })
  await store.createSession(session)

  let streams = 0
  let enteredFirst!: () => void
  const firstStreamEntered = new Promise<void>((resolve) => {
    enteredFirst = resolve
  })
  const provider: Provider = {
    id: 'fake',
    apiMode: 'openai_compat',
    profile(model: string) {
      return defaultModel(model)
    },
    async *stream(_req: ProviderRequest, signal: AbortSignal) {
      streams += 1
      if (streams === 1) {
        enteredFirst()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return
      }
      yield { type: 'text_delta' as const, text: 'ok' }
      yield { type: 'stop' as const, reason: 'end' }
    },
  }

  const engine = createSessionEngine({
    session,
    provider,
    store,
    tools: [],
    compact: defaultCompact(),
    model: defaultModel(),
    maxRounds: 8,
    bare: true,
    askUser: async () => 'deny',
  })

  const gen = engine.submitMessage(spec.prompt)
  const pending = drain(gen)
  await firstStreamEntered
  engine.abort('cancel')
  const cancelled = await pending
  if (spec.expect.cancelNotFail === true) {
    if (!isRoundEnd(cancelled) || cancelled.reason !== 'cancelled') {
      throw new Error(`cancel-not-fail: expected { reason: 'cancelled' }, got ${JSON.stringify(cancelled)}`)
    }
    const second = await drain(engine.submitMessage('again'))
    if (!isRoundEnd(second) || second.reason !== 'completed') {
      throw new Error(`cancel-not-fail: second submit did not complete: ${JSON.stringify(second)}`)
    }
  }
  await engine.close()
}

async function runStreamReconnect(spec: EvalCase): Promise<void> {
  const store = createMemoryStore()
  const session = makeSession({ id: 'sess_eval_stream_reconnect' })
  await store.createSession(session)
  const events: StreamEvent[] = [
    { type: 'text_delta', text: 'one' },
    { type: 'text_delta', text: 'two' },
    { type: 'text_delta', text: 'three' },
  ]
  const seqs: number[] = []
  for (const event of events) {
    seqs.push(await store.appendStreamEvent(session.id, event))
  }
  if (seqs[0] !== 1 || seqs[1] !== 2 || seqs[2] !== 3) {
    throw new Error(`stream-reconnect: expected seqs 1,2,3 got ${JSON.stringify(seqs)}`)
  }
  const after = await store.listStreamEventsAfter(session.id, 1)
  if (spec.expect.afterSeqReplays === true) {
    if (after.length !== 2) {
      throw new Error(`stream-reconnect: expected 2 events after seq 1, got ${JSON.stringify(after)}`)
    }
    if (after[0]?.seq !== 2 || after[0].type !== 'text_delta' || after[0].text !== 'two') {
      throw new Error(`stream-reconnect: event 2 mismatch: ${JSON.stringify(after[0])}`)
    }
    if (after[1]?.seq !== 3 || after[1].type !== 'text_delta' || after[1].text !== 'three') {
      throw new Error(`stream-reconnect: event 3 mismatch: ${JSON.stringify(after[1])}`)
    }
  }
}

async function runJobShadowBranch(spec: EvalCase): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'raven-eval-job-'))
  const sessionId = `sess_eval_job_${crypto.randomUUID()}`
  try {
    initGitRepo(cwd)
    const result = enterSessionWorktree(sessionId, cwd)
    if (!result.ok || result.job === undefined) {
      throw new Error(`job-shadow-branch: enterSessionWorktree failed: ${result.error ?? 'no job'}`)
    }
    if (spec.expect.shadowBranchCurrent === true) {
      if (!result.job.shadowBranch.startsWith('raven/')) {
        throw new Error(`job-shadow-branch: shadow is not raven/*: ${result.job.shadowBranch}`)
      }
      const branch = spawnSync('git', ['-C', result.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
      })
      const current = branch.stdout.trim()
      if (current !== result.job.shadowBranch) {
        throw new Error(
          `job-shadow-branch: current ${JSON.stringify(current)} !== ${result.job.shadowBranch}`,
        )
      }
      const head = spawnSync('git', ['-C', result.cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
      if (head.stdout.trim() !== result.job.baseCommitSha) {
        throw new Error(
          `job-shadow-branch: HEAD ${JSON.stringify(head.stdout.trim())} !== ${result.job.baseCommitSha}`,
        )
      }
    }
  } finally {
    exitSessionWorktree(sessionId, 'remove', true)
    rmSync(cwd, { recursive: true, force: true })
  }
}

function initGitRepo(dir: string): void {
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`job-shadow-branch: git ${args.join(' ')} failed: ${result.stderr}`)
    }
  }
  run(['init'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['commit', '--allow-empty', '-m', 'init'])
}

async function persistHistory(store: SessionStore, sessionId: string, messages: Message[]): Promise<void> {
  for (const msg of messages) {
    if (msg.role === 'user') await store.persistUser(sessionId, msg)
    else if (msg.role === 'assistant') {
      if (msg.blocks.some((block) => block.type === 'tool_use')) {
        await store.persistToolCalls(sessionId, msg)
      } else {
        await store.persistAssistant(sessionId, msg)
      }
    } else {
      await store.persistToolResults(sessionId, [msg])
    }
  }
}

function isRoundEnd(value: unknown): value is RoundEnd {
  return !!value && typeof value === 'object' && 'reason' in value && typeof (value as RoundEnd).reason === 'string'
}

function messageText(messages: Message[]): string {
  return messages
    .flatMap((msg) => msg.blocks)
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function toolResultText(messages: Message[]): string {
  return messages
    .filter((msg): msg is Extract<Message, { role: 'tool' }> => msg.role === 'tool')
    .flatMap((msg) => msg.blocks)
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

async function waitForPendingAsks(
  store: SessionStore,
  sessionId: string,
): Promise<Awaited<ReturnType<SessionStore['listPendingAsks']>>> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const pending = await store.listPendingAsks(sessionId)
    if (pending.length > 0) return pending
    await sleep(25)
  }
  throw new Error('pending-ask-persist: expected listPendingAsks nonempty')
}

async function cloneStore(source: SessionStore): Promise<SessionStore> {
  const dest = createMemoryStore()
  for (const session of await source.listSessions()) {
    await dest.createSession({ ...session })
    const messages = source.loadMessages
      ? await source.loadMessages(session.id)
      : (await source.loadSession(session.id)).messages
    for (const msg of messages) {
      if (msg.role === 'user') await dest.persistUser(session.id, msg)
      else if (msg.role === 'assistant') {
        if (msg.blocks.some((block) => block.type === 'tool_use')) {
          await dest.persistToolCalls(session.id, msg)
        } else {
          await dest.persistAssistant(session.id, msg)
        }
      } else {
        await dest.persistToolResults(session.id, [msg])
      }
    }
    const rules = await source.listPermissionRules(session.id)
    if (rules.length > 0) await dest.setPermissionRules(session.id, rules)
    for (const row of await source.listPendingAsks(session.id)) {
      await dest.upsertPendingAsk({ ...row })
    }
  }
  return dest
}

function hasIncompleteToolRow(messages: Message[]): boolean {
  return messages.some(
    (msg) =>
      msg.role === 'tool' &&
      msg.blocks.some((block) => block.type === 'text' && block.text.includes(INCOMPLETE_TEXT)),
  )
}

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_eval_pending_ask',
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

function createFakeProvider(scripts: ProviderChunk[][]): Provider {
  const queue = [...scripts]
  return {
    id: 'fake',
    apiMode: 'openai_compat',
    profile(model: string) {
      return defaultModel(model)
    },
    async *stream(_req: ProviderRequest, signal: AbortSignal) {
      const script = queue.shift() ?? [{ type: 'stop' as const, reason: null }]
      for (const chunk of script) {
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

function createAskEcho(): Tool<{ text: string }, string> {
  return {
    name: 'Echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
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
      return { behavior: 'ask' as const, message: 'Echo?' }
    },
    async execute(input: { text: string }, _ctx: ToolContext) {
      return input.text
    },
  }
}

async function drain(gen: AsyncGenerator<StreamEvent, unknown>): Promise<unknown> {
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
