import { resolve } from 'node:path'
import { runAutocompact } from '../compact/prune'
import { mechanicalSummary } from '../compact/summarize'
import { loadLifecycleHooks } from '../hooks/lifecycle'
import { createFileHistory } from '../session/file-history'
import { createTaskRegistry } from '../tasks/registry'
import {
  SESSION_LOCK_RENEW_MS,
  type Message,
  type PermissionMode,
  type QueryLoopOptions,
  type RoundEnd,
  type SessionEngine,
  type SessionEngineOptions,
  type SessionRecord,
  type SessionStore,
  type StreamEvent,
  type SystemPart,
  type ToolContext,
  type Turn,
  type UserOrToolBlock,
  type UserSubmitInput,
} from '../types'
import { abortTurn } from './abort'
import { queryLoop } from './query-loop'
import { selectProtectedTail } from './repair'
import { formatSettledOutput } from './format-output'
import {
  ABORTED_TEXT,
  denyText,
  executeFailedText,
  INCOMPLETE_TEXT,
  makeToolMessage,
  parseFailedText,
  unknownToolText,
} from './pairing'
import { forgetReadsNotInTail, markReadPath, recordReadFile, stampReadMtime } from '../tools/read-files'
import type { TodoItem } from '../tools/todo'
import { lastUserText, maybeFinishRewindReset, rewindLastTurn, rewindToCheckpoint } from '../session/rewind'
import {
  clearSessionJobError,
  maybeCommitJob,
  setSessionJobError,
  stampCheckpoint,
  stampTodoSnapshot,
} from '../session/job'
import { listDescendantSessionIds, listOwnedPendingAsks as listOwnedPendingAsksFromStore, writeFollowup } from '../session/followup'
import { getSessionWorktree } from '../tools/session-worktree'
import { projectSessionTodos } from '../tools/todo'
import { applyPermissionMode } from '../prompt/builder'
import { injectMidTurnHint } from '../prompt/cache'
import { createMemoryStore } from '../session/memory-store'
import { commandOrPath, persistAllowAlways } from '../permissions/rules'
import type { PendingAsk, PendingAskAnswer } from '../session/pending-asks'
import {
  BACKGROUND_REVIEW_PROMPT,
  backgroundReviewSession,
  filterBackgroundReviewTools,
  LEARN_NUDGE,
  MEMORY_NUDGE,
  shouldNudgeLearn,
  shouldNudgeMemory,
  shouldStartBackgroundReview,
} from '../review/fork'

const TITLE_MAX = 50

function restoreReadFilesFromMessages(turn: Turn, rows: Message[]): void {
  const paths = new Map<string, string>()
  for (const msg of rows) {
    if (msg.role === 'assistant') {
      for (const block of msg.blocks) {
        if (block.type !== 'tool_use' || block.name !== 'Read') continue
        const path = (block.input as { path?: unknown } | undefined)?.path
        if (typeof path === 'string' && path.length > 0) paths.set(block.id, path)
      }
    }
    if (msg.role === 'tool' && msg.ok) {
      const path = paths.get(msg.toolUseId)
      if (path === undefined) continue
      const resolved = resolve(turn.cwd, path)
      if (msg.readMtimeMs !== undefined) recordReadFile(turn, resolved, msg.readMtimeMs)
      else markReadPath(turn, resolved)
    }
  }
}

function titleFromUserText(text: string): string | undefined {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  const line = first.replace(/\s+/g, ' ').trim()
  if (line === '') return undefined
  return line.length <= TITLE_MAX ? line : line.slice(0, TITLE_MAX)
}

function sessionTodosOf(session: { todos?: TodoItem[] }): TodoItem[] | undefined {
  return session.todos
}

function lastAssistant(messages: Message[]): Extract<Message, { role: 'assistant' }> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === 'assistant') return msg
  }
  return undefined
}

function isJobSuccessReason(reason: RoundEnd['reason']): boolean {
  return (
    reason === 'completed' ||
    reason === 'hook_stopped' ||
    reason === 'max_rounds' ||
    reason === 'context_full'
  )
}

function persistableLastEnd(end: RoundEnd): RoundEnd {
  if (end.reason === 'max_rounds') return { reason: 'max_rounds', round: end.round }
  if (
    end.reason === 'model_error' ||
    end.reason === 'persist_failed' ||
    end.reason === 'results_persist_failed'
  ) {
    return { reason: end.reason, error: String(end.error).slice(0, 500) }
  }
  return { reason: end.reason }
}

export function createSessionEngine(opts: SessionEngineOptions): SessionEngine {
  const session = { ...opts.session }
  let messages: Message[] = opts.messages ? [...opts.messages] : []
  let liveTurn: Turn | null = null
  const liveTurnIdleWaiters: Array<() => void> = []
  let clearTail: Promise<void> = Promise.resolve()
  let compactQueued = false
  let system = opts.system
  let model = opts.model
  const tasks = createTaskRegistry()
  const fileHistory = opts.fileHistory ?? createFileHistory(session.id)
  const ownsHistoryTurn = opts.fileHistory === undefined || opts.fileHistoryOwnsTurn === true
  const steering: string[] = []
  let drainQueued = opts.drainQueued
  const injectedAgentsDirs = new Set<string>()
  let closed = false
  let sessionStartDone = false
  let userTurns = 0
  let cancelBackgroundReview: (() => void) | undefined
  let replayAbort: AbortController | undefined
  const applyFlights = new Map<string, Promise<unknown>>()
  const executedAsks = new Set<string>()
  const claimedAsks = new Set<string>()
  const childEngines = new Map<string, SessionEngine>()
  type TreeStopResult = { descendantWork: boolean; thisSessionWork: boolean }
  let treeStopFlight: Promise<TreeStopResult> | undefined
  let treeStopRequested = false
  let treeStopAbortedLiveChild = false
  let leftoverFlightRequested = false

  function registerChildEngine(engine: SessionEngine): () => void {
    const id = engine.session.id
    childEngines.set(id, engine)
    return () => {
      if (childEngines.get(id) === engine) childEngines.delete(id)
    }
  }

  function claimAsk(callId: string): boolean {
    if (claimedAsks.has(callId) || executedAsks.has(callId)) return false
    claimedAsks.add(callId)
    return true
  }

  function setLiveTurn(next: Turn | null): void {
    liveTurn = next
    if (next !== null) return
    const waiters = liveTurnIdleWaiters.splice(0)
    for (const waiter of waiters) waiter()
  }

  function waitForIdleTurn(): Promise<void> {
    if (liveTurn === null) return Promise.resolve()
    return new Promise((resolve) => {
      liveTurnIdleWaiters.push(resolve)
    })
  }
  const lifecycle = opts.bare
    ? { run: async () => undefined }
    : loadLifecycleHooks(session.cwd)

  async function persistSettledTool(
    row: Extract<Message, { role: 'tool' }>,
    targetSessionId = session.id,
  ): Promise<void> {
    await opts.store.persistToolResults(targetSessionId, [row])
    if (targetSessionId !== session.id) return
    messages = [...messages, row]
    if (liveTurn) liveTurn.messages = [...liveTurn.messages, row]
  }

  async function dropPendingAsk(callId: string): Promise<void> {
    try {
      await opts.store.deletePendingAsk(callId)
    } catch {
      // persist already won; a later apply deletes the leftover row
    }
  }

  function hasToolResult(callId: string, rows: Message[]): boolean {
    return rows.some((msg) => msg.role === 'tool' && msg.toolUseId === callId)
  }

  async function isCallPaired(callId: string, targetSessionId = session.id): Promise<boolean> {
    if (targetSessionId === session.id && hasToolResult(callId, messages)) return true
    if (opts.store.loadMessages === undefined) return false
    try {
      return hasToolResult(callId, await opts.store.loadMessages(targetSessionId))
    } catch {
      return false
    }
  }

  async function listOwnedPendingAsks(): Promise<PendingAsk[]> {
    return (await listOwnedPendingAsksFromStore(opts.store, session.id)) as PendingAsk[]
  }

  async function persistBeforeDropAsk(row: PendingAsk): Promise<boolean> {
    if (!(await isCallPaired(row.callId, row.sessionId))) {
      try {
        await persistSettledTool(makeToolMessage(row.callId, false, ABORTED_TEXT), row.sessionId)
      } catch {
        return true
      }
    }
    try {
      await opts.store.deletePendingAsk(row.callId)
      return false
    } catch {
      return true
    }
  }

  async function waitRegisteredChildrenIdle(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      let busy = false
      for (const child of childEngines.values()) {
        if (child.liveTurnId() !== null) {
          busy = true
          break
        }
      }
      if (!busy) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  async function runTreeStopPass(abortedLiveChild: boolean): Promise<{ descendantWork: boolean }> {
    await waitRegisteredChildrenIdle()
    let attemptedAsk = false
    const ids = await listDescendantSessionIds(opts.store, session.id)
    for (const id of ids) {
      const child = childEngines.get(id)
      if (child && child.liveTurnId() !== null) continue
      const rows = await opts.store.listPendingAsks(id)
      for (const row of rows) {
        attemptedAsk = true
        try {
          await persistBeforeDropAsk(row)
        } catch {
          // continue other descendant rows
        }
      }
    }
    return { descendantWork: abortedLiveChild || attemptedAsk }
  }

  function startTreeStopFlight(abortedLiveChild: boolean): void {
    treeStopRequested = true
    treeStopAbortedLiveChild = treeStopAbortedLiveChild || abortedLiveChild
  }

  function startThisSessionLeftoverFlight(): void {
    leftoverFlightRequested = true
  }

  async function runThisSessionLeftoverPass(): Promise<{ thisSessionWork: boolean }> {
    let attempted = false
    const rows = await opts.store.listPendingAsks(session.id)
    for (const row of rows) {
      attempted = true
      try {
        await persistBeforeDropAsk(row)
      } catch {
        // continue other this-session rows
      }
    }
    return { thisSessionWork: attempted }
  }

  function whenTreeStop(): Promise<TreeStopResult> {
    const needTree = treeStopRequested
    const abortedLiveChild = treeStopAbortedLiveChild
    const needLeftover = leftoverFlightRequested
    if (needTree) {
      treeStopRequested = false
      treeStopAbortedLiveChild = false
    }
    if (needLeftover) leftoverFlightRequested = false
    if (!needTree && !needLeftover) {
      return treeStopFlight ?? Promise.resolve({ descendantWork: false, thisSessionWork: false })
    }
    const prev = treeStopFlight
    const pass = (async () => {
      const prior = prev ? await prev : { descendantWork: false, thisSessionWork: false }
      let descendantWork = prior.descendantWork
      let thisSessionWork = prior.thisSessionWork
      try {
        if (needTree) {
          const next = await runTreeStopPass(abortedLiveChild)
          descendantWork = descendantWork || next.descendantWork
        }
        if (needLeftover) {
          const next = await runThisSessionLeftoverPass()
          thisSessionWork = thisSessionWork || next.thisSessionWork
        }
      } catch {
        descendantWork = descendantWork || (needTree && abortedLiveChild)
        thisSessionWork = thisSessionWork || needLeftover
      }
      return { descendantWork, thisSessionWork }
    })()
    treeStopFlight = pass
    return pass
  }

  async function hasUnpairedChildAsk(): Promise<boolean> {
    const children = opts.store.listSessions
      ? await opts.store.listSessions({ parentSessionId: session.id })
      : []
    for (const child of children) {
      for (const row of await opts.store.listPendingAsks(child.id)) {
        if (!(await isCallPaired(row.callId, child.id))) return true
      }
    }
    return false
  }

  function wipedSessionRecord(generation: number): SessionRecord {
    const next: SessionRecord = {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      cwd: session.cwd,
      model: session.model,
      permissionMode: session.permissionMode,
      compactGeneration: generation,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      funding: session.funding,
      todos: [],
    }
    if (session.prePlanMode !== undefined) next.prePlanMode = session.prePlanMode
    if (session.parentSessionId !== undefined) next.parentSessionId = session.parentSessionId
    if (session.job !== undefined) next.job = session.job
    if (session.jobAutoCommit === true) next.jobAutoCommit = true
    return next
  }

  function assignWipedSession(next: SessionRecord): void {
    session.updatedAt = next.updatedAt
    session.compactGeneration = next.compactGeneration
    session.usage = next.usage
    session.todos = next.todos
    delete session.title
    delete session.followup
    delete session.lastEnd
    delete session.jobError
  }

  async function resolveAskTarget(callId: string): Promise<
    | { status: 'unmatched' }
    | { status: 'paired' }
    | {
        status: 'open'
        row: PendingAsk
        sessionId: string
        messages: Message[]
        cwd: string
        permissionMode: PermissionMode
        prePlanMode?: PermissionMode
      }
  > {
    const row = await opts.store.getPendingAsk(callId)
    if (!row) {
      if (await isCallPaired(callId)) return { status: 'paired' }
      return { status: 'unmatched' }
    }
    if (row.sessionId === session.id) {
      if (await isCallPaired(callId, session.id)) {
        await dropPendingAsk(callId)
        return { status: 'paired' }
      }
      return {
        status: 'open',
        row,
        sessionId: session.id,
        messages,
        cwd: session.cwd,
        permissionMode: session.permissionMode,
        ...(session.prePlanMode !== undefined ? { prePlanMode: session.prePlanMode } : {}),
      }
    }
    const descendants = new Set(await listDescendantSessionIds(opts.store, session.id))
    if (!descendants.has(row.sessionId)) return { status: 'unmatched' }
    let child: Awaited<ReturnType<SessionStore['loadSession']>>
    try {
      child = await opts.store.loadSession(row.sessionId)
    } catch {
      return { status: 'unmatched' }
    }
    if (await isCallPaired(callId, row.sessionId)) {
      await dropPendingAsk(callId)
      return { status: 'paired' }
    }
    return {
      status: 'open',
      row,
      sessionId: row.sessionId,
      messages: child.messages,
      cwd: child.session.cwd,
      permissionMode: child.session.permissionMode,
      ...(child.session.prePlanMode !== undefined
        ? { prePlanMode: child.session.prePlanMode }
        : {}),
    }
  }

  async function applyAskAnswerOnce(
    callId: string,
    answer: PendingAskAnswer,
  ): Promise<'matched' | 'unmatched'> {
    const target = await resolveAskTarget(callId)
    if (target.status === 'unmatched') return 'unmatched'
    if (target.status === 'paired') return 'matched'

    const { row } = target
    if (executedAsks.has(callId)) {
      try {
        await persistSettledTool(makeToolMessage(callId, false, INCOMPLETE_TEXT), target.sessionId)
      } catch {
        // already executed; pairing is best-effort
      }
      await dropPendingAsk(callId)
      return 'matched'
    }

    if (!claimAsk(callId)) return 'matched'

    if (answer === 'deny') {
      await persistSettledTool(makeToolMessage(callId, false, denyText(row.message)), target.sessionId)
      await dropPendingAsk(callId)
      return 'matched'
    }

    if (answer === 'allow_always') {
      await persistAllowAlways({
        store: opts.store,
        sessionId: target.sessionId,
        cwd: target.cwd,
        scope: row.saveAs ?? 'session',
        tool: row.tool,
        spec: commandOrPath(row.input) ?? {},
      })
    }

    const tool = opts.tools.find((item) => item.name === row.tool)
    if (!tool) {
      await persistSettledTool(makeToolMessage(callId, false, unknownToolText(row.tool)), target.sessionId)
      await dropPendingAsk(callId)
      return 'matched'
    }

    const parsed = tool.parse(row.input)
    if (!parsed.ok) {
      await persistSettledTool(
        makeToolMessage(callId, false, parseFailedText(parsed.message)),
        target.sessionId,
      )
      await dropPendingAsk(callId)
      return 'matched'
    }

    const turn: Turn = {
      id: crypto.randomUUID(),
      sessionId: target.sessionId,
      messages: target.messages,
      round: 0,
      maxRounds: opts.maxRounds,
      graceUsed: false,
      abort: new AbortController(),
      permissionMode: target.permissionMode,
      usage: { ...session.usage },
      compactGeneration: session.compactGeneration,
      funding: session.funding,
      cwd: target.cwd,
      terminalBackend: opts.terminalBackend ?? 'local',
      model: session.model,
      readFiles:
        liveTurn && target.sessionId === session.id ? new Set(liveTurn.readFiles) : new Set(),
      readFileMtimes:
        liveTurn && target.sessionId === session.id && liveTurn.readFileMtimes
          ? new Map(liveTurn.readFileMtimes)
          : new Map(),
    }
    if (target.prePlanMode !== undefined) turn.prePlanMode = target.prePlanMode
    const extras = opts.additionalDirectories
    if (extras !== undefined && extras.length > 0) {
      turn.additionalDirectories = [...extras]
    }
    const worktree = getSessionWorktree(target.sessionId)
    if (worktree) turn.projectCwd = worktree.originalCwd
    if (!liveTurn || target.sessionId !== session.id) {
      restoreReadFilesFromMessages(turn, target.messages)
    }
    const ctx: ToolContext = {
      turn,
      signal: turn.abort.signal,
      onProgress: () => {},
      store: opts.store,
      tasks,
      fileHistory,
      registerChildEngine,
    }
    if (target.sessionId === session.id) ctx.session = session

    let toolRow: Extract<Message, { role: 'tool' }>
    try {
      const output = await tool.execute(parsed.value, ctx)
      const formatted = formatSettledOutput(tool, output)
      toolRow = makeToolMessage(callId, true, formatted.content, formatted.persistPath)
      stampReadMtime(turn, row.tool, parsed.value, toolRow)
    } catch (error) {
      const text = executeFailedText(error instanceof Error ? error.message : String(error))
      toolRow = makeToolMessage(callId, false, text)
    }
    executedAsks.add(callId)
    try {
      await persistSettledTool(toolRow, target.sessionId)
    } catch (first) {
      const incomplete = makeToolMessage(callId, false, INCOMPLETE_TEXT)
      try {
        await persistSettledTool(incomplete, target.sessionId)
      } catch {
        throw first
      }
    }
    await dropPendingAsk(callId)
    return 'matched'
  }

  function applyAskAnswer(
    callId: string,
    answer: PendingAskAnswer,
  ): Promise<'matched' | 'unmatched'> {
    const existing = applyFlights.get(callId)
    const task = (async () => {
      try {
        if (existing) {
          try {
            await existing
          } catch {
            // prior flight owns its error
          }
        }
        return await applyAskAnswerOnce(callId, answer)
      } finally {
        if (applyFlights.get(callId) === task) applyFlights.delete(callId)
      }
    })()
    applyFlights.set(callId, task)
    return task
  }

  async function runCompactNow(): Promise<void> {
    const source = liveTurn?.messages ?? messages
    const tail = selectProtectedTail(source, opts.compact.protectLastMessages)
    const cut = source.length - tail.length
    if (cut <= 0) return

    const todos = sessionTodosOf(session)
    const result = await runAutocompact({
      messages: source,
      compact: opts.compact,
      model,
      store: opts.store,
      sessionId: session.id,
      generation: liveTurn?.compactGeneration ?? session.compactGeneration,
      cwd: liveTurn?.projectCwd ?? liveTurn?.cwd ?? session.cwd,
      ...(todos !== undefined ? { todos } : {}),
      ...(opts.compact.llmSummarize
        ? {
            provider: opts.provider,
            signal: liveTurn?.abort.signal ?? new AbortController().signal,
          }
        : { summary: mechanicalSummary(source.slice(0, cut)) }),
    })
    messages = result.messages
    if (liveTurn) {
      liveTurn.messages = result.messages
      forgetReadsNotInTail(liveTurn, result.messages)
      liveTurn.compactGeneration = result.generation
    }
    session.compactGeneration = result.generation
    session.updatedAt = Date.now()
    await opts.store.upsertSession(session)
  }

  async function* replayPendingAsks(): AsyncGenerator<StreamEvent, void> {
    replayAbort = new AbortController()
    try {
      for (const row of await listOwnedPendingAsks()) {
        const event: Extract<StreamEvent, { type: 'permission_ask' }> = {
          type: 'permission_ask',
          id: row.callId,
          tool: row.tool,
          input: row.input,
          message: row.message,
        }
        if (row.saveAs !== undefined) event.saveAs = row.saveAs
        if (row.sessionId !== session.id) event.childSessionId = row.sessionId
        else if (session.parentSessionId !== undefined) event.childSessionId = session.id
        yield event
        const answer = await opts.askUser(event, replayAbort.signal)
        await applyAskAnswer(row.callId, answer)
      }
    } finally {
      replayAbort = undefined
    }
  }

  return {
    get session() {
      return session
    },
    get tasks() {
      return tasks
    },
    get fileHistory() {
      return fileHistory
    },

    applyAskAnswer,
    replayPendingAsks,

    enqueueSteer(text: string) {
      const trimmed = text.trim()
      if (trimmed !== '') steering.push(trimmed)
    },

    drainSteering() {
      return steering.splice(0)
    },

    bindDrainQueued(fn) {
      drainQueued = fn
    },

    async rewindLast() {
      const finished = await this.maybeFinishRewindReset()
      if (finished.ran) {
        return finished.ok
          ? { ok: true, notice: finished.notice ?? 'nothing to rewind' }
          : { ok: false, notice: finished.notice ?? 'rewind reset failed' }
      }
      await this.whenTreeStop()
      const pending = await listOwnedPendingAsks()
      for (const row of pending) {
        if (!(await isCallPaired(row.callId, row.sessionId))) {
          return { ok: false, notice: 'pending permission ask' }
        }
      }
      const droppedText = lastUserText(messages)
      const priorLen = messages.length
      if (liveTurn) {
        return { ok: false, notice: 'a turn is in progress' }
      }
      if (tasks.list().some((task) => task.status === 'running' && task.type === 'agent')) {
        return { ok: false, notice: 'a turn is in progress' }
      }
      if (session.job) {
        const result = await rewindToCheckpoint({
          session,
          messages,
          store: opts.store,
        })
        messages = result.messages
        return {
          ok: result.ok,
          notice: result.notice,
          ...(droppedText !== undefined && (result.ok || messages.length < priorLen)
            ? { droppedText }
            : {}),
        }
      }
      const result = await rewindLastTurn({
        fileHistory,
        messages,
        store: opts.store,
        sessionId: session.id,
        generation: session.compactGeneration,
        session,
      })
      messages = result.messages
      return {
        ok: result.ok,
        notice: result.notice,
        ...(droppedText !== undefined && (result.ok || messages.length < priorLen)
          ? { droppedText }
          : {}),
      }
    },

    maybeFinishRewindReset() {
      if (liveTurn !== null) return Promise.resolve({ ran: false, ok: true })
      return maybeFinishRewindReset({ session, store: opts.store, messages })
    },

    async clearKeepId() {
      const prev = clearTail
      let release!: () => void
      clearTail = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        await prev
        if (closed) return { ok: false as const, notice: 'session closed' }
        if (await hasUnpairedChildAsk()) {
          return { ok: false as const, notice: 'pending permission ask' }
        }
        if (liveTurn !== null) {
          this.abort('cancel')
          await waitForIdleTurn()
        }
        if (await hasUnpairedChildAsk()) {
          return { ok: false as const, notice: 'pending permission ask' }
        }
        let rows: Message[]
        try {
          rows = opts.store.loadMessages
            ? await opts.store.loadMessages(session.id)
            : messages
        } catch {
          return { ok: false as const, notice: 'clear persist failed' }
        }
        const ids = rows.map((msg) => msg.id)
        const generation = ids.length > 0 ? session.compactGeneration + 1 : session.compactGeneration
        const next = wipedSessionRecord(generation)
        try {
          await opts.store.clearConversation({
            session: next,
            inactivatedIds: ids,
            generation,
          })
        } catch {
          return { ok: false as const, notice: 'clear persist failed' }
        }
        messages = []
        assignWipedSession(next)
        fileHistory.reset()
        steering.splice(0)
        userTurns = 0
        const root = getSessionWorktree(session.id)?.originalCwd ?? session.cwd
        try {
          projectSessionTodos(root, [])
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return { ok: true as const, notice: `session cleared; todo.json write failed: ${detail}` }
        }
        return { ok: true as const, notice: 'session cleared' }
      } finally {
        release()
      }
    },

    async *submitMessage(input: UserSubmitInput): AsyncGenerator<StreamEvent, RoundEnd> {
      cancelBackgroundReview?.()
      cancelBackgroundReview = undefined
      const lock = opts.sessionLock
      if (lock) {
        await opts.store.renewSessionLock(session.id, lock.holderId, lock.ttlMs)
      }
      const stopLockRenew = lock ? startLockRenew(opts.store, session.id, lock) : undefined
      try {
      await maybeFinishRewindReset({ session, store: opts.store, messages })
      await whenTreeStop()
      const pending = await listOwnedPendingAsks()
      let askBlocked = false
      for (const row of pending) {
        if (await isCallPaired(row.callId, row.sessionId)) {
          await dropPendingAsk(row.callId)
          continue
        }
        askBlocked = true
      }
      if (askBlocked) {
        yield { type: 'status', message: 'pending permission ask' }
        return { reason: 'completed' as const }
      }
      const { text, blocks } = userSubmitToBlocks(input)
      if (!sessionStartDone) {
        sessionStartDone = true
        await lifecycle.run('SessionStart', { sessionId: session.id, cwd: session.cwd })
      }
      const blocked = await lifecycle.run('UserPromptSubmit', { text })
      if (blocked?.preventContinuation === true) {
        yield { type: 'status', message: blocked.message ?? 'stopped by hook' }
        const stop = await lifecycle.run('Stop', { sessionId: session.id, reason: 'completed' })
        if (stop?.message) yield { type: 'status', message: stop.message }
        if (stop?.preventContinuation === true) {
          session.lastEnd = { reason: 'hook_stopped' }
          session.updatedAt = Date.now()
          await opts.store.upsertSession(session)
          return { reason: 'hook_stopped' as const }
        }
        return { reason: 'completed' as const }
      }
      const userMsg: Extract<Message, { role: 'user' }> = {
        id: crypto.randomUUID(),
        role: 'user',
        blocks,
        createdAt: Date.now(),
      }
      messages = [...messages, userMsg]
      if (ownsHistoryTurn) fileHistory.beginTurn()

      const turn: Turn = {
        id: crypto.randomUUID(),
        sessionId: session.id,
        messages,
        round: 0,
        maxRounds: opts.maxRounds,
        graceUsed: false,
        abort: new AbortController(),
        permissionMode: session.permissionMode,
        usage: { ...session.usage },
        compactGeneration: session.compactGeneration,
        funding: session.funding,
        cwd: session.cwd,
        terminalBackend: opts.terminalBackend ?? 'local',
        model: session.model,
        readFiles: new Set(),
        readFileMtimes: new Map(),
        injectedAgentsDirs,
      }
      const extras = opts.additionalDirectories
      if (extras !== undefined && extras.length > 0) {
        turn.additionalDirectories = [...extras]
      }
      const worktree = getSessionWorktree(session.id)
      if (worktree) turn.projectCwd = worktree.originalCwd
      if (session.prePlanMode !== undefined) turn.prePlanMode = session.prePlanMode
      setLiveTurn(turn)

      const notices = await opts.store.drainAgentMail(session.id)
      if (notices.length > 0) {
        const mailboxText = mergeMailboxNotices(notices, text)
        const first = userMsg.blocks[0]
        if (first && first.type === 'text') first.text = mailboxText
        else userMsg.blocks.unshift({ type: 'text', text: mailboxText })
      }

      try {
        await opts.store.persistUser(session.id, userMsg)
      } catch (error) {
        for (const notice of notices) {
          try {
            await opts.store.enqueueAgentMail(session.id, notice)
          } catch {
            // keep the persist error
          }
        }
        messages = messages.slice(0, -1)
        setLiveTurn(null)
        fileHistory.endTurn()
        if (compactQueued) {
          compactQueued = false
          try {
            await runCompactNow()
          } catch {
            // keep the persist error
          }
        }
        throw error
      }

      if (session.title === undefined || session.title === '') {
        const title = titleFromUserText(text)
        if (title !== undefined) {
          session.title = title
          session.updatedAt = Date.now()
          await opts.store.upsertSession(session)
        }
      }

      try {
        const loopOpts: QueryLoopOptions = {
          turn,
          tools: opts.tools,
          provider: opts.provider,
          store: opts.store,
          compact: opts.compact,
          model,
          askUser: async (event, signal) => {
            const answer = await opts.askUser(event, signal)
            if (answer !== 'deny') claimAsk(event.id)
            return answer
          },
        }
        if (session.parentSessionId !== undefined) loopOpts.parentSessionId = session.parentSessionId
        if (system !== undefined) loopOpts.system = system
        if (opts.hooks !== undefined) loopOpts.hooks = opts.hooks
        loopOpts.tasks = tasks
        loopOpts.fileHistory = fileHistory
        loopOpts.drainSteering = () => steering.splice(0)
        loopOpts.drainQueued = () => drainQueued?.()
        loopOpts.lifecycle = lifecycle
        if (opts.fallbackModel !== undefined) loopOpts.fallbackModel = opts.fallbackModel
        if (opts.jsonSchema !== undefined) loopOpts.jsonSchema = opts.jsonSchema
        if (opts.verifyOnStop === true) loopOpts.verifyOnStop = true
        if (opts.refreshTools !== undefined) loopOpts.refreshTools = opts.refreshTools
        loopOpts.registerChildEngine = registerChildEngine
        loopOpts.session = session
        const todos = sessionTodosOf(session)
        if (todos !== undefined) loopOpts.todos = todos
        userTurns += 1
        if (shouldNudgeMemory(userTurns)) {
          turn.messages = injectMidTurnHint(turn.messages, MEMORY_NUDGE)
          messages = turn.messages
        }
        const end = yield* queryLoop(loopOpts)
        if (end.reason === 'cancelled') {
          const leftover = await opts.store.listPendingAsks(session.id)
          let remaining = false
          for (const row of leftover) {
            try {
              if (await persistBeforeDropAsk(row)) remaining = true
            } catch {
              remaining = true
            }
          }
          await whenTreeStop()
          if (!remaining) {
            for (const row of await listOwnedPendingAsks()) {
              if (!(await isCallPaired(row.callId, row.sessionId))) remaining = true
            }
          }
          if (remaining) {
            yield { type: 'status', message: 'cancelled, ask still pending' }
          }
        }
        if (end.reason === 'aborted') {
          await whenTreeStop()
        }
        messages = turn.messages
        if (end.reason === 'completed' && shouldNudgeLearn(turn.round)) {
          messages = injectMidTurnHint(messages, LEARN_NUDGE)
          turn.messages = messages
        }
        session.usage = turn.usage
        session.compactGeneration = turn.compactGeneration
        session.permissionMode = turn.permissionMode
        if (turn.prePlanMode !== undefined) session.prePlanMode = turn.prePlanMode
        session.cwd = turn.cwd
        session.lastEnd = persistableLastEnd(end)
        if (session.job && end.reason === 'completed') clearSessionJobError(session)
        session.updatedAt = Date.now()
        await opts.store.upsertSession(session)
        if (
          session.job &&
          isJobSuccessReason(end.reason) &&
          (await opts.store.listPendingAsks(session.id)).length === 0
        ) {
          if (session.jobAutoCommit === true) {
            const result = maybeCommitJob({
              job: session.job,
              turnId: turn.id,
              cwd: session.job.worktreePath,
            })
            if (result.notice) yield { type: 'status', message: result.notice }
            if (result.notice && !result.committed) {
              setSessionJobError(session, result.notice)
              session.updatedAt = Date.now()
              await opts.store.upsertSession(session)
            } else if (result.committed) {
              clearSessionJobError(session)
              session.updatedAt = Date.now()
              await opts.store.upsertSession(session)
            }
          }
          const asst = lastAssistant(turn.messages)
          if (asst) {
            stampCheckpoint(asst, session.job, session.todos, session.job.worktreePath)
            if (asst.checkpoint) {
              try {
                if (asst.blocks.some((block) => block.type === 'tool_use')) {
                  await opts.store.persistToolCalls(session.id, asst)
                } else {
                  await opts.store.persistAssistant(session.id, asst)
                }
              } catch {
                // checkpoint persist must not fail the turn
              }
            }
          }
        }
        if (
          !session.job &&
          isJobSuccessReason(end.reason) &&
          (await opts.store.listPendingAsks(session.id)).length === 0
        ) {
          const asst = lastAssistant(turn.messages)
          if (asst) {
            stampTodoSnapshot(asst, session.todos)
            try {
              if (asst.blocks.some((block) => block.type === 'tool_use')) {
                await opts.store.persistToolCalls(session.id, asst)
              } else {
                await opts.store.persistAssistant(session.id, asst)
              }
            } catch {
              // todo snapshot persist must not fail the turn
            }
          }
        }
        if (end.reason === 'context_full') {
          const stop = await lifecycle.run('Stop', { sessionId: session.id, reason: end.reason })
          if (stop?.message) yield { type: 'status', message: stop.message }
        }
        if (
          shouldStartBackgroundReview({
            enabled: opts.backgroundReview,
            reason: end.reason,
            funding: session.funding,
            permissionMode: session.permissionMode,
          })
        ) {
          cancelBackgroundReview = startDetachedReview({
            provider: opts.provider,
            parentSession: session,
            messages,
            system,
            tools: opts.tools,
            compact: opts.compact,
            model,
          })
        }
        return end
      } finally {
        if (ownsHistoryTurn) fileHistory.endTurn()
        setLiveTurn(null)
        if (compactQueued) {
          compactQueued = false
          await runCompactNow()
        }
      }
      } finally {
        stopLockRenew?.()
      }
    },

    async compactNow() {
      if (liveTurn !== null) {
        compactQueued = true
        return
      }
      await runCompactNow()
    },

    reloadSystem(next: SystemPart[]) {
      system = next
    },

    async setModel(next: SessionEngineOptions['model']) {
      session.model = next.id
      session.updatedAt = Date.now()
      model = next
      await opts.store.upsertSession(session)
    },

    async setPermissionMode(mode: PermissionMode) {
      const current = liveTurn?.permissionMode ?? session.permissionMode
      if (mode === 'plan') {
        if (current !== 'plan') {
          session.prePlanMode = current
          if (liveTurn) liveTurn.prePlanMode = current
        }
      } else if (current === 'plan') {
        if (session.prePlanMode !== undefined) delete session.prePlanMode
        if (liveTurn && liveTurn.prePlanMode !== undefined) delete liveTurn.prePlanMode
      }
      session.permissionMode = mode
      if (liveTurn) liveTurn.permissionMode = mode
      session.updatedAt = Date.now()
      await opts.store.upsertSession(session)
      if (system !== undefined) system = applyPermissionMode(system, mode)
    },

    async setFollowup(text: string) {
      return writeFollowup(session, opts.store, text)
    },

    async clearFollowup() {
      await writeFollowup(session, opts.store, null)
    },

    getFollowup() {
      return session.followup ?? null
    },

    liveTurnId() {
      return liveTurn?.id ?? null
    },

    whenTreeStop,

    abort(kind?: 'cancel' | 'interrupt') {
      cancelBackgroundReview?.()
      cancelBackgroundReview = undefined
      replayAbort?.abort()
      if (kind === 'cancel') {
        let abortedLiveChild = false
        for (const child of childEngines.values()) {
          if (child.liveTurnId() !== null) abortedLiveChild = true
          child.abort('cancel')
        }
        if (liveTurn) {
          if (liveTurn.cancelKind === undefined) liveTurn.cancelKind = 'cancel'
          abortTurn(liveTurn.abort)
          startTreeStopFlight(abortedLiveChild)
          return
        }
        startTreeStopFlight(abortedLiveChild)
        startThisSessionLeftoverFlight()
        return
      }
      if (liveTurn) {
        if (liveTurn.cancelKind === undefined) liveTurn.cancelKind = kind ?? 'interrupt'
        abortTurn(liveTurn.abort)
      }
      startThisSessionLeftoverFlight()
    },

    async close(closeOpts) {
      cancelBackgroundReview?.()
      cancelBackgroundReview = undefined
      if (closed) return
      closed = true
      try {
        await lifecycle.run('SessionEnd', { sessionId: session.id, cwd: session.cwd })
      } finally {
        if (closeOpts?.releaseLock === false) return
        const lock = opts.sessionLock
        if (!lock) return
        try {
          await opts.store.releaseSessionLock(session.id, lock.holderId)
        } catch {
          // best-effort lock release
        }
      }
    },
  }
}

function startDetachedReview(opts: {
  provider: SessionEngineOptions['provider']
  parentSession: import('../types').SessionRecord
  messages: Message[]
  system: SystemPart[] | undefined
  tools: SessionEngineOptions['tools']
  compact: SessionEngineOptions['compact']
  model: SessionEngineOptions['model']
}): () => void {
  const reviewTools = filterBackgroundReviewTools(opts.tools)
  if (reviewTools.length === 0) return () => {}
  const store = createMemoryStore()
  const session = backgroundReviewSession(opts.parentSession)
  let cancelled = false
  let child: SessionEngine | undefined
  void (async () => {
    try {
      await store.createSession(session)
      const childOpts: SessionEngineOptions = {
        session,
        messages: opts.messages.map((msg) => ({ ...msg, blocks: [...msg.blocks] })) as Message[],
        provider: opts.provider,
        store,
        tools: reviewTools,
        compact: opts.compact,
        model: opts.model,
        maxRounds: 8,
        askUser: async () => 'deny',
        bare: true,
      }
      if (opts.system !== undefined) childOpts.system = opts.system
      child = createSessionEngine(childOpts)
      if (cancelled) {
        child.abort()
        return
      }
      const gen = child.submitMessage(BACKGROUND_REVIEW_PROMPT)
      for await (const _ of gen) {
        if (cancelled) {
          child.abort()
          break
        }
      }
    } catch {
      // persist-detached; the parent turn already finished
    } finally {
      try {
        child?.abort()
        await child?.close({ releaseLock: false })
      } catch {
        // ignore
      }
    }
  })()
  return () => {
    cancelled = true
    child?.abort()
  }
}

function startLockRenew(
  store: SessionEngineOptions['store'],
  sessionId: string,
  lock: { holderId: string; ttlMs?: number },
): () => void {
  const timer = setInterval(() => {
    void store.renewSessionLock(sessionId, lock.holderId, lock.ttlMs).catch(() => {
      // keep the turn going; next renew or submit will fail closed
    })
  }, SESSION_LOCK_RENEW_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

function mergeMailboxNotices(notices: string[], text: string): string {
  const body = `[mailbox]\n${notices.join('\n\n')}`
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '[mailbox]') return body
  return `${body}\n\n${text}`
}

function userSubmitToBlocks(input: UserSubmitInput): { text: string; blocks: UserOrToolBlock[] } {
  if (typeof input === 'string') {
    return { text: input, blocks: [{ type: 'text', text: input }] }
  }
  const text = input.text ?? ''
  const blocks: UserOrToolBlock[] = []
  if (text !== '') blocks.push({ type: 'text', text })
  for (const image of input.images ?? []) {
    if (image.data.length === 0) continue
    blocks.push({ type: 'image', mediaType: image.mediaType, data: image.data })
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return { text, blocks }
}
