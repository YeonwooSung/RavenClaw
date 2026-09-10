import { queryLoop } from '../loop/query-loop'
import { ABORTED_TEXT, INCOMPLETE_TEXT } from '../loop/pairing'
import { isAbortError } from '../loop/abort'
import { generalAgent } from '../agent/general'
import {
  boundChildResult,
  filterChildTools,
  lastAssistantText,
  resolveChildModel,
} from '../agent/definition'
import { PersistError } from '../types'
import type {
  CompactPolicy,
  Message,
  ModelProfile,
  Provider,
  QueryLoopOptions,
  RoundEnd,
  SessionEngineOptions,
  SessionRecord,
  SessionStore,
  StreamEvent,
  SystemPart,
  Tool,
  ToolContext,
  Turn,
} from '../types'
import { parseWithSchema } from './parse'

export interface AgentInput {
  prompt: string
  context?: string
  description?: string
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', minLength: 1 },
    context: { type: 'string' },
    description: { type: 'string' },
  },
}

export function createAgentTool(opts: {
  store: SessionStore
  provider: Provider
  tools: Tool[]
  compact: CompactPolicy
  model: ModelProfile
  askUser: SessionEngineOptions['askUser']
  childMaxRounds?: number
  system?: SystemPart[]
}): Tool<AgentInput, string> {
  const childTools = filterChildTools(opts.tools, generalAgent)
  const maxRounds = opts.childMaxRounds ?? generalAgent.maxRounds

  return {
    name: 'Agent',
    description:
      'Run a nested general agent on an isolated sub-task. Child history and readFiles start empty. Returns the child\'s last assistant text (capped at 32000 characters).',
    inputSchema,
    parse(input: unknown) {
      return parseWithSchema<AgentInput>(inputSchema, input)
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return false
    },
    interruptBehavior() {
      return 'cancel'
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute(input: AgentInput, ctx: ToolContext) {
      if (ctx.signal.aborted) return ABORTED_TEXT

      const now = Date.now()
      const childModel = resolveChildModel(ctx.turn, generalAgent)
      const childSession = buildChildSession(ctx.turn, childModel, now, input.description)
      const userMessage = buildChildUserMessage(input, now)

      await opts.store.createSession(childSession)
      await opts.store.persistUser(childSession.id, userMessage)

      const childAbort = new AbortController()
      const unlink = linkAbort(ctx.signal, childAbort)
      const childTurn = buildChildTurn(childSession, userMessage, childAbort, maxRounds)

      try {
        const loopOpts: QueryLoopOptions = {
          turn: childTurn,
          tools: childTools,
          provider: opts.provider,
          store: opts.store,
          compact: opts.compact,
          model: opts.model,
          askUser: opts.askUser,
        }
        if (generalAgent.inheritParentSystemPrompt && opts.system !== undefined) {
          loopOpts.system = opts.system
        }
        const end = await drainLoop(queryLoop(loopOpts))
        await persistChildSession(opts.store, childSession, childTurn)
        return childResult(end, childTurn.messages, ctx.signal)
      } catch (error) {
        await persistChildSession(opts.store, childSession, childTurn).catch(() => undefined)
        if (error instanceof PersistError) throw error
        if (isAbortError(error) || ctx.signal.aborted || childAbort.signal.aborted) {
          return ABORTED_TEXT
        }
        const text = lastAssistantText(childTurn.messages)
        return text ? boundChildResult(text) : INCOMPLETE_TEXT
      } finally {
        unlink()
      }
    },
  }
}

function buildChildSession(
  parent: Turn,
  model: string,
  now: number,
  title?: string,
): SessionRecord {
  const session: SessionRecord = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    cwd: parent.cwd,
    model,
    permissionMode: parent.permissionMode,
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    parentSessionId: parent.sessionId,
    funding: parent.funding,
  }
  if (parent.prePlanMode !== undefined) session.prePlanMode = parent.prePlanMode
  if (title !== undefined) session.title = title
  return session
}

function buildChildUserMessage(
  input: AgentInput,
  now: number,
): Extract<Message, { role: 'user' }> {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    blocks: [{ type: 'text', text: formatChildPrompt(input) }],
    createdAt: now,
  }
}

function formatChildPrompt(input: AgentInput): string {
  if (input.context === undefined || input.context.length === 0) return input.prompt
  return `${input.prompt}\n\n${input.context}`
}

function buildChildTurn(
  session: SessionRecord,
  user: Extract<Message, { role: 'user' }>,
  abort: AbortController,
  maxRounds: number,
): Turn {
  const turn: Turn = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    messages: [user],
    round: 0,
    maxRounds,
    graceUsed: false,
    abort,
    permissionMode: session.permissionMode,
    usage: { ...session.usage },
    compactGeneration: 0,
    funding: session.funding,
    cwd: session.cwd,
    model: session.model,
    readFiles: new Set(),
  }
  if (session.prePlanMode !== undefined) turn.prePlanMode = session.prePlanMode
  return turn
}

function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  if (parent.aborted) {
    if (!child.signal.aborted) child.abort(parent.reason)
    return () => {}
  }
  const onAbort = () => {
    if (!child.signal.aborted) child.abort(parent.reason)
  }
  parent.addEventListener('abort', onAbort)
  return () => parent.removeEventListener('abort', onAbort)
}

async function drainLoop(
  gen: AsyncGenerator<StreamEvent, RoundEnd>,
): Promise<RoundEnd> {
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
  }
}

async function persistChildSession(
  store: SessionStore,
  session: SessionRecord,
  turn: Turn,
): Promise<void> {
  session.usage = turn.usage
  session.compactGeneration = turn.compactGeneration
  session.permissionMode = turn.permissionMode
  if (turn.prePlanMode !== undefined) session.prePlanMode = turn.prePlanMode
  else if (session.prePlanMode !== undefined) delete session.prePlanMode
  session.updatedAt = Date.now()
  await store.upsertSession(session)
}

function childResult(end: RoundEnd, messages: Message[], parentSignal: AbortSignal): string {
  if (end.reason === 'aborted' || parentSignal.aborted) return ABORTED_TEXT
  const text = lastAssistantText(messages)
  if (
    !text &&
    (end.reason === 'model_error' ||
      end.reason === 'persist_failed' ||
      end.reason === 'results_persist_failed')
  ) {
    return INCOMPLETE_TEXT
  }
  return boundChildResult(text)
}
