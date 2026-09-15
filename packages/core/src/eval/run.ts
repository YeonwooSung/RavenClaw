import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INCOMPLETE_TEXT, unpairedToolUseIds } from '../loop/pairing'
import { createSessionEngine } from '../loop/session-engine'
import { createMemoryStore } from '../session/memory-store'
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
} from '../types'

export const DEFAULT_EVAL_FIXTURES_DIR = join(import.meta.dir, 'fixtures')

type EvalExpect = {
  pendingAskPersists?: boolean
  noIncomplete?: boolean
  pairing?: boolean
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

function makeSession(): SessionRecord {
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

async function drain(gen: AsyncGenerator<StreamEvent, unknown>): Promise<void> {
  while (true) {
    const next = await gen.next()
    if (next.done) return
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
