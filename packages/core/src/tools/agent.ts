import { createSessionEngine } from '../loop/session-engine'
import { openRavenclawLog, wrapSessionEngineLog } from '../log'
import { ABORTED_TEXT, INCOMPLETE_TEXT, PERSIST_FAILED_TEXT, makeToolMessage } from '../loop/pairing'
import { isAbortError } from '../loop/abort'
import { getAgentDefinition } from '../agent/catalog'
import { loadDiskAgents } from '../agent/load'
import { rootAgent } from '../agent/root'
import { decidePermission } from '../permissions/pipeline'
import { loadPermissionRules } from '../permissions/rules'
import {
  addTokenUsage,
  boundChildResult,
  buildChildPreamble,
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
  RoundEnd,
  SessionEngine,
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
import { takeChildOutput } from './set-output'
import { isTurnAlwaysTool } from './skill'
import { prepareChildWorktree, type IsolationMode } from './worktree'
import { createFileHistory } from '../session/file-history'
import { MAX_PARALLEL_CHILDREN } from '../tasks/mailbox'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from '../home'

export { MAX_PARALLEL_CHILDREN }

export interface AgentChildInput {
  prompt: string
  context?: string
  description?: string
  subagent?: string
  isolation?: IsolationMode
  command?: string
  run_in_background?: boolean
}

export interface AgentInput extends AgentChildInput {
  agents?: AgentChildInput[]
}

const childInputProperties = {
  prompt: { type: 'string', minLength: 1 },
  context: { type: 'string' },
  description: { type: 'string' },
  subagent: { type: 'string', minLength: 1 },
  isolation: { type: 'string', enum: ['none', 'worktree'] },
  command: { type: 'string', minLength: 1 },
  run_in_background: { type: 'boolean' },
}

const childInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: childInputProperties,
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    ...childInputProperties,
    agents: {
      type: 'array',
      items: childInputSchema,
    },
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
      'Run a nested agent on an isolated sub-task. Optional subagent selects a catalog definition (default general). Optional agents[] runs several children in parallel. Optional run_in_background returns a task id immediately (TaskOutput/TaskStop). Child readFiles start empty; history is empty unless the definition includes it.',
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

      const batch = input.agents
      const background = input.run_in_background === true
      if (background && batch !== undefined && batch.length > 0) {
        return 'Agent failed: agents[] cannot run in the background'
      }
      if (batch !== undefined && batch.length > MAX_PARALLEL_CHILDREN) {
        return `Agent failed: at most ${MAX_PARALLEL_CHILDREN} parallel children`
      }

      const runOne = (childInput: AgentChildInput) => spawnChild(childInput, ctx, opts)
      if (batch !== undefined && batch.length > 0) {
        const settled = await Promise.allSettled(batch.map((child) => runOne(child)))
        return formatParallelResults(batch, settled)
      }
      if (background && ctx.tasks) {
        const running = ctx.tasks
          .list()
          .filter((task) => task.type === 'agent' && task.status === 'running').length
        if (running >= MAX_PARALLEL_CHILDREN) {
          return `Agent failed: at most ${MAX_PARALLEL_CHILDREN} background agents`
        }
        return startBackgroundAgent(input, ctx, opts)
      }
      return runOne(input)
    },
  }
}

type AgentToolOpts = Parameters<typeof createAgentTool>[0]

async function spawnChild(
  input: AgentChildInput,
  ctx: ToolContext,
  opts: AgentToolOpts,
  childSessionId?: string,
): Promise<string> {
  const projectCwd = ctx.turn.projectCwd ?? ctx.turn.cwd
  const spawnable = new Set([
    ...rootAgent.spawnableAgents,
    ...loadDiskAgents(projectCwd).map((agent) => agent.id),
  ])
  if (input.subagent !== undefined && !spawnable.has(input.subagent)) {
    return `Subagent '${input.subagent}' is not spawnable`
  }

  const definition = getAgentDefinition(input.subagent ?? 'general', projectCwd)
  if (!definition) return `Unknown subagent: ${input.subagent}`

  const maxRounds = opts.childMaxRounds ?? definition.maxRounds
  const now = Date.now()
  const childModel = resolveChildModel(
    {
      model: ctx.turn.model,
      funding: ctx.turn.funding,
      specialistModel: ctx.turn.specialistModel ?? opts.compact.specialistModel,
    },
    definition,
  )
  const childSession = buildChildSession(
    ctx.turn,
    childModel,
    now,
    input.description,
    childSessionId,
  )
  const isolated = prepareChildWorktree(ctx.turn.cwd, childSession.id, input.isolation ?? 'none')
  const userMessage = buildChildUserMessage(input, definition, now)
  const preambleMessages = buildChildPreamble(definition, ctx.turn.messages)
  const parentCwd = childSession.cwd

  const childAbort = new AbortController()
  const unlink = linkAbort(ctx.signal, childAbort)
  const childTurn = buildChildTurn(
    childSession,
    [...preambleMessages, userMessage],
    childAbort,
    maxRounds,
    ctx.turn,
  )
  // Worktree path is live-only. session.cwd stays the parent so resume
  // still has a real directory after cleanup removes the worktree.
  childTurn.cwd = isolated.cwd
  childTurn.projectCwd = projectCwd
  const childTools = bindChildTurnFields(
    filterChildPool(filterChildTools(opts.tools, definition), childTurn),
    {
      cwd: isolated.cwd,
      projectCwd,
      skillAllowedTools: ctx.turn.skillAllowedTools,
      unlockedToolNames: ctx.turn.unlockedToolNames,
    },
  )
  let engine: SessionEngine | undefined

  try {
    await opts.store.createSession(childSession)

    const oneShot = await maybeRunCommandRunner(input, definition, childTools, childTurn, ctx, opts)
    if (oneShot?.done) return oneShot.text
    if (oneShot && !oneShot.done) appendCommandOutput(userMessage, oneShot.text)

    const userPayload = userText(userMessage)

    const engineOpts: SessionEngineOptions = {
      session: childSession,
      messages: preambleMessages,
      provider: opts.provider,
      store: opts.store,
      tools: childTools,
      compact: opts.compact,
      model: opts.model,
      maxRounds,
      askUser: opts.askUser,
      bare: true,
    }
    const system = childSystemParts(definition, opts.system)
    if (system !== undefined) engineOpts.system = system
    if (opts.hooks !== undefined) engineOpts.hooks = opts.hooks
    if (ctx.fileHistory && isolated.cwd === parentCwd) {
      engineOpts.fileHistory = ctx.fileHistory
      engineOpts.fileHistoryOwnsTurn = false
    }
    engine = wrapSessionEngineLog(createSessionEngine(engineOpts), openRavenclawLog(), {
      closeLog: false,
    })
    const unlinkEngine = linkEngineAbort(ctx.signal, engine)
    try {
      const end = await drainLoop(engine.submitMessage(userPayload))
      syncChildFromEngine(childSession, childTurn, engine, parentCwd)
      const loaded = await opts.store.loadSession(childSession.id).catch(() => undefined)
      if (loaded) childTurn.messages = loaded.messages
      await persistChildSession(opts.store, childSession, childTurn)
      return childResult(end, childTurn.messages, ctx.signal, childSession.id)
    } finally {
      unlinkEngine()
      await engine.close({ releaseLock: false }).catch(() => undefined)
    }
  } catch (error) {
    if (engine) syncChildFromEngine(childSession, childTurn, engine, parentCwd)
    childSession.cwd = parentCwd
    await persistChildSession(opts.store, childSession, childTurn).catch(() => undefined)
    if (error instanceof PersistError) throw error
    if (isAbortError(error) || ctx.signal.aborted || childAbort.signal.aborted) {
      return ABORTED_TEXT
    }
    const structured = takeChildOutput(childSession.id)
    if (structured !== undefined) return boundChildResult(structured)
    const loaded = await opts.store.loadSession(childSession.id).catch(() => undefined)
    const text = lastAssistantText(loaded?.messages ?? childTurn.messages)
    return text ? boundChildResult(text) : INCOMPLETE_TEXT
  } finally {
    ctx.turn.usage = addTokenUsage(
      ctx.turn.usage,
      engine ? engine.session.usage : childTurn.usage,
    )
    unlink()
    isolated.cleanup()
  }
}

function startBackgroundAgent(
  input: AgentChildInput,
  ctx: ToolContext,
  opts: AgentToolOpts,
): string {
  const tasks = ctx.tasks
  if (!tasks) return 'background agent failed: no task registry'
  mkdirSync(join(ravenclawHome(), 'tasks'), { recursive: true })
  const outputFile = join(ravenclawHome(), 'tasks', `${crypto.randomUUID()}.log`)
  writeFileSync(outputFile, '', 'utf8')
  const abort = new AbortController()
  const task = tasks.register({
    type: 'agent',
    command: input.prompt,
    description: input.description ?? input.prompt,
    outputFile,
    kill: () => {
      if (!abort.signal.aborted) abort.abort()
    },
  })
  const childSessionId = crypto.randomUUID()
  const childHistory = createFileHistory(`bg_${task.id}`)
  childHistory.beginTurn()
  const bgCtx: ToolContext = { ...ctx, signal: abort.signal, fileHistory: childHistory }
  void spawnChild({ ...input, run_in_background: false }, bgCtx, opts, childSessionId).then(
    async (text) => {
      try {
        writeFileSync(outputFile, text, 'utf8')
      } catch {
        // keep empty log if the final write fails
      }
      try {
        await opts.store.enqueueAgentMail(
          ctx.turn.sessionId,
          `subagent finished (${task.id}):\n` + text.slice(0, 4000),
        )
      } catch {
        // mailbox is best-effort; still mark the task complete
      }
      tasks.complete(task.id, 0)
    },
    () => {
      tasks.complete(task.id, 1)
    },
  ).finally(() => {
    childHistory.endTurn()
  })
  return JSON.stringify({ status: 'dispatched', taskId: task.id, childSessionId })
}

function formatParallelResults(
  agents: AgentChildInput[],
  settled: PromiseSettledResult<string>[],
): string {
  return settled
    .map((row, index) => {
      const name = agents[index]?.subagent ?? 'general'
      const text = row.status === 'fulfilled' ? row.value : settledReason(row.reason)
      return `## ${index + 1} (${name})\n${text}`
    })
    .join('\n\n')
}

function settledReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  return String(reason)
}

function buildChildSession(
  parent: Turn,
  model: string,
  now: number,
  title?: string,
  id?: string,
): SessionRecord {
  const session: SessionRecord = {
    id: id ?? crypto.randomUUID(),
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
  if (parent.specialistModel !== undefined) turn.specialistModel = parent.specialistModel
  if (parent.skillAllowedTools !== undefined) {
    turn.skillAllowedTools = [...parent.skillAllowedTools]
  }
  if (parent.unlockedToolNames !== undefined) {
    turn.unlockedToolNames = [...parent.unlockedToolNames]
  }
  return turn
}

/** Skill jail only. Keep isEnabled-false deferred tools so ToolCall can unwrap them. */
function filterChildPool(pool: Tool[], turn: Turn): Tool[] {
  if (turn.skillAllowedTools === undefined) return pool
  const allow = new Set(turn.skillAllowedTools)
  return pool.filter((tool) => allow.has(tool.name) || isTurnAlwaysTool(tool.name))
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

function linkEngineAbort(parent: AbortSignal, engine: SessionEngine): () => void {
  if (parent.aborted) {
    engine.abort()
    return () => {}
  }
  const onAbort = () => engine.abort()
  parent.addEventListener('abort', onAbort)
  return () => parent.removeEventListener('abort', onAbort)
}

function userText(message: Extract<Message, { role: 'user' }>): string {
  const block = message.blocks[0]
  return block && block.type === 'text' ? block.text : ''
}

function syncChildFromEngine(
  session: SessionRecord,
  turn: Turn,
  engine: SessionEngine,
  parentCwd: string,
): void {
  session.usage = engine.session.usage
  session.compactGeneration = engine.session.compactGeneration
  session.permissionMode = engine.session.permissionMode
  if (engine.session.prePlanMode !== undefined) session.prePlanMode = engine.session.prePlanMode
  else if (session.prePlanMode !== undefined) delete session.prePlanMode
  session.cwd = parentCwd
  session.updatedAt = Date.now()
  turn.usage = engine.session.usage
  turn.compactGeneration = engine.session.compactGeneration
  turn.permissionMode = engine.session.permissionMode
  if (engine.session.prePlanMode !== undefined) turn.prePlanMode = engine.session.prePlanMode
}

function bindChildTurnFields(
  tools: Tool[],
  live: {
    cwd: string
    projectCwd: string
    skillAllowedTools?: string[]
    unlockedToolNames?: string[]
  },
): Tool[] {
  const stamp = (turn: Turn) => {
    turn.cwd = live.cwd
    turn.projectCwd = live.projectCwd
    if (live.skillAllowedTools !== undefined && turn.skillAllowedTools === undefined) {
      turn.skillAllowedTools = [...live.skillAllowedTools]
    }
    if (live.unlockedToolNames !== undefined && turn.unlockedToolNames === undefined) {
      turn.unlockedToolNames = [...live.unlockedToolNames]
    }
  }
  return tools.map((tool) => {
    const bound: Tool = {
      ...tool,
      async checkPermissions(input, ctx) {
        stamp(ctx.turn)
        return tool.checkPermissions(input, ctx)
      },
      async execute(input, ctx) {
        stamp(ctx.turn)
        return tool.execute(input, ctx)
      },
    }
    if (tool.isEnabled) {
      bound.isEnabled = (ctx) => {
        stamp(ctx.turn)
        return tool.isEnabled!(ctx)
      }
    }
    return bound
  })
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

function childResult(
  end: RoundEnd,
  messages: Message[],
  parentSignal: AbortSignal,
  childSessionId: string,
): string {
  if (end.reason === 'aborted' || parentSignal.aborted) return ABORTED_TEXT
  const structured = takeChildOutput(childSessionId)
  if (structured !== undefined) return boundChildResult(structured)
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

  const toolUseId = crypto.randomUUID()
  const asst: Extract<Message, { role: 'assistant' }> = {
    id: crypto.randomUUID(),
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: value }],
    createdAt: Date.now(),
  }
  try {
    await opts.store.persistToolCalls(childTurn.sessionId, asst)
  } catch {
    return { done: true, text: PERSIST_FAILED_TEXT }
  }

  const output = await bash.execute(value, {
    turn: childTurn,
    signal: childTurn.abort.signal,
    onProgress: ctx.onProgress,
  })
  const text = formatToolOutput(bash, output)
  try {
    await opts.store.persistToolResults(childTurn.sessionId, [makeToolMessage(toolUseId, true, text)])
  } catch {
    // pairing is best-effort once the one-shot has returned
  }
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
