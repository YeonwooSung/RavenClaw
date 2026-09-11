import { queryLoop } from '../loop/query-loop'
import { ABORTED_TEXT, INCOMPLETE_TEXT } from '../loop/pairing'
import { isAbortError } from '../loop/abort'
import { getAgentDefinition } from '../agent/catalog'
import { loadDiskAgents } from '../agent/load'
import { rootAgent } from '../agent/root'
import { decidePermission } from '../permissions/pipeline'
import { loadPermissionRules } from '../permissions/rules'
import {
  addTokenUsage,
  boundChildResult,
  buildChildMessages,
  childSystemParts,
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
import type { PermissionHook } from '../permissions/hooks'
import { parseWithSchema } from './parse'
import { filterToolsForTurn } from './skill'
import { prepareChildWorktree, type IsolationMode } from './worktree'

export interface AgentInput {
  prompt: string
  context?: string
  description?: string
  subagent?: string
  isolation?: IsolationMode
  command?: string
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', minLength: 1 },
    context: { type: 'string' },
    description: { type: 'string' },
    subagent: { type: 'string', minLength: 1 },
    isolation: { type: 'string', enum: ['none', 'worktree'] },
    command: { type: 'string', minLength: 1 },
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
  hooks?: PermissionHook[]
}): Tool<AgentInput, string> {
  return {
    name: 'Agent',
    description:
      'Run a nested agent on an isolated sub-task. Optional subagent selects a catalog definition (default general). Child history and readFiles start empty. Returns the child\'s last assistant text (capped at 32000 characters).',
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
      return { behavior: 'ask', message: 'Spawn a nested agent?', saveAs: 'session' }
    },
    async execute(input: AgentInput, ctx: ToolContext) {
      if (ctx.signal.aborted) return ABORTED_TEXT

      const projectCwd = ctx.turn.projectCwd ?? ctx.turn.cwd
      const spawnable = new Set([
        ...rootAgent.spawnableAgents,
        ...loadDiskAgents(projectCwd).map((agent) => agent.id),
      ])
      if (input.subagent !== undefined && !spawnable.has(input.subagent)) {
        return `Subagent '${input.subagent}' is not spawnable`
      }

      const definition = getAgentDefinition(
        input.subagent ?? 'general',
        ctx.turn.projectCwd ?? ctx.turn.cwd,
      )
      if (!definition) return `Unknown subagent: ${input.subagent}`

      const maxRounds = opts.childMaxRounds ?? definition.maxRounds
      const now = Date.now()
      const childModel = resolveChildModel(ctx.turn, definition)
      const childSession = buildChildSession(ctx.turn, childModel, now, input.description)
      const isolated = prepareChildWorktree(
        ctx.turn.cwd,
        childSession.id,
        input.isolation ?? 'none',
      )
      const userMessage = buildChildUserMessage(input, definition, now)
      const childMessages = buildChildMessages(definition, ctx.turn.messages, userMessage)

      const childAbort = new AbortController()
      const unlink = linkAbort(ctx.signal, childAbort)
      const childTurn = buildChildTurn(childSession, childMessages, childAbort, maxRounds, ctx.turn)
      // Worktree path is live-only. session.cwd stays the parent so resume
      // still has a real directory after cleanup removes the worktree.
      childTurn.cwd = isolated.cwd
      childTurn.projectCwd = ctx.turn.projectCwd ?? ctx.turn.cwd
      const childTools = filterToolsForTurn(filterChildTools(opts.tools, definition), childTurn)

      try {
        await opts.store.createSession(childSession)
        await opts.store.persistUser(childSession.id, userMessage)

        const oneShot = await maybeRunCommandRunner(
          input,
          definition,
          childTools,
          childTurn,
          ctx,
          opts,
        )
        if (oneShot?.done) return oneShot.text
        if (oneShot && !oneShot.done) appendCommandOutput(userMessage, oneShot.text)

        const loopOpts: QueryLoopOptions = {
          turn: childTurn,
          tools: childTools,
          provider: opts.provider,
          store: opts.store,
          compact: opts.compact,
          model: opts.model,
          askUser: opts.askUser,
        }
        const system = childSystemParts(definition, opts.system)
        if (system !== undefined) loopOpts.system = system
        if (opts.hooks !== undefined) loopOpts.hooks = opts.hooks
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
        ctx.turn.usage = addTokenUsage(ctx.turn.usage, childTurn.usage)
        unlink()
        isolated.cleanup()
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
  definition: { id: string },
  now: number,
): Extract<Message, { role: 'user' }> {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    blocks: [{ type: 'text', text: formatChildPrompt(input, definition) }],
    createdAt: now,
  }
}

function formatChildPrompt(input: AgentInput, definition: { id: string }): string {
  const body =
    input.context === undefined || input.context.length === 0
      ? input.prompt
      : `${input.prompt}\n\n${input.context}`
  if (definition.id !== 'file-finder') return body
  return `Reply with at most 20 lines of: path — reason\n\n${body}`
}

function buildChildTurn(
  session: SessionRecord,
  messages: Message[],
  abort: AbortController,
  maxRounds: number,
  parent: Turn,
): Turn {
  const turn: Turn = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    messages,
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
  if (parent.skillAllowedTools !== undefined) {
    turn.skillAllowedTools = [...parent.skillAllowedTools]
  }
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

const COMMAND_RUNNER_ONESHOT_LIMIT = 2000

async function maybeRunCommandRunner(
  input: AgentInput,
  definition: { id: string },
  childTools: Tool[],
  childTurn: Turn,
  ctx: ToolContext,
  opts: { store: SessionStore; hooks?: PermissionHook[] },
): Promise<{ done: true; text: string } | { done: false; text: string } | undefined> {
  if (definition.id !== 'command-runner') return undefined
  const command = resolveCommand(input)
  if (command === undefined) return undefined
  const bash = childTools.find((tool) => tool.name === 'Bash')
  if (!bash) return undefined

  const parsed = bash.parse({ command })
  const value = commandInput(parsed, command)
  const rules = await loadPermissionRules({
    cwd: childTurn.projectCwd ?? childTurn.cwd,
    store: opts.store,
    sessionId: childTurn.sessionId,
  })
  const decision = await decidePermission({
    tool: bash,
    name: 'Bash',
    input: value,
    ctx: { turn: childTurn, signal: ctx.signal, onProgress: ctx.onProgress },
    mode: childTurn.permissionMode,
    rules,
    ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
  })
  if (decision.behavior === 'deny') {
    return { done: true, text: decision.message }
  }
  if (decision.behavior === 'ask') return undefined

  const output = await bash.execute(value, {
    turn: childTurn,
    signal: childTurn.abort.signal,
    onProgress: ctx.onProgress,
  })
  const text = formatToolOutput(bash, output)
  if (text.length < COMMAND_RUNNER_ONESHOT_LIMIT) {
    return { done: true, text: boundChildResult(text) }
  }
  return { done: false, text }
}

function resolveCommand(input: AgentInput): string | undefined {
  if (input.command !== undefined && input.command.length > 0) return input.command
  const prompt = input.prompt.trim()
  if (looksLikeCommand(prompt)) return prompt
  return undefined
}

function looksLikeCommand(prompt: string): boolean {
  if (!prompt || /[\n?]/.test(prompt)) return false
  if (
    /^(please|could you|can you|find|search|look|list|show|help|write|edit|read|explain)\b/i.test(
      prompt,
    )
  ) {
    return false
  }
  if (/^(run|do)\s+[a-z][a-z\s]+$/i.test(prompt) && !/[|&><;]/.test(prompt)) return false
  if (
    /^(ls|git|npm|npx|bun|pnpm|yarn|cat|echo|pwd|cd|mkdir|rm|cp|mv|chmod|grep|find|curl|wget|python3?|node|cargo|make|go|docker|kubectl)\b/.test(
      prompt,
    )
  ) {
    return true
  }
  if (/^[./~]/.test(prompt)) return true
  return /[|&><;]/.test(prompt)
}

function appendCommandOutput(user: Extract<Message, { role: 'user' }>, output: string): void {
  const block = user.blocks[0]
  if (block && block.type === 'text') {
    block.text += `\n\nCommand output:\n${output}`
  }
}

function commandInput(
  parsed: { ok: true; value: unknown } | { ok: false; message: string },
  command: string,
): unknown {
  if (
    parsed.ok &&
    typeof parsed.value === 'object' &&
    parsed.value !== null &&
    'command' in parsed.value &&
    typeof (parsed.value as { command: unknown }).command === 'string'
  ) {
    return parsed.value
  }
  return { command }
}

function formatToolOutput(tool: Tool, output: unknown): string {
  if (typeof output === 'string') return output
  if (tool.renderResult) return tool.renderResult(output)
  if (output === undefined || output === null) return ''
  if (typeof output === 'object' && output !== null && 'content' in output) {
    const content = (output as { content?: unknown }).content
    if (typeof content === 'string') return content
  }
  if (typeof output === 'object') return JSON.stringify(output)
  return String(output)
}
