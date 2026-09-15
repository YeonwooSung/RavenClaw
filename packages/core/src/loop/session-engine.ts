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
  type StreamEvent,
  type SystemPart,
  type Tool,
  type ToolContext,
  type Turn,
  type UserOrToolBlock,
  type UserSubmitInput,
} from '../types'
import { abortTurn } from './abort'
import { queryLoop } from './query-loop'
import { selectProtectedTail } from './repair'
import {
  denyText,
  executeFailedText,
  makeToolMessage,
  parseFailedText,
  unknownToolText,
} from './pairing'
import { rewindLastTurn } from '../session/rewind'
import { getSessionWorktree } from '../tools/session-worktree'
import { applyPermissionMode } from '../prompt/builder'
import { injectMidTurnHint } from '../prompt/cache'
import { createMemoryStore } from '../session/memory-store'
import { commandOrPath, persistAllowAlways } from '../permissions/rules'
import type { PendingAskAnswer } from '../session/pending-asks'
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

function titleFromUserText(text: string): string | undefined {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  const line = first.replace(/\s+/g, ' ').trim()
  if (line === '') return undefined
  return line.length <= TITLE_MAX ? line : line.slice(0, TITLE_MAX)
}

function formatSettledOutput(
  tool: Tool,
  output: unknown,
): { content: string; persistPath?: string } {
  const persistPath =
    output &&
    typeof output === 'object' &&
    'persistPath' in output &&
    typeof (output as { persistPath?: unknown }).persistPath === 'string' &&
    (output as { persistPath: string }).persistPath.length > 0
      ? (output as { persistPath: string }).persistPath
      : undefined
  let content: string
  if (typeof output === 'string') content = output
  else if (tool.renderResult) content = tool.renderResult(output)
  else if (output === undefined || output === null) content = ''
  else if (typeof output === 'object') {
    const body = (output as { content?: unknown }).content
    content = typeof body === 'string' ? body : JSON.stringify(output)
  } else {
    content = String(output)
  }
  return persistPath !== undefined ? { content, persistPath } : { content }
}

export function createSessionEngine(opts: SessionEngineOptions): SessionEngine {
  const session = { ...opts.session }
  let messages: Message[] = opts.messages ? [...opts.messages] : []
  let liveTurn: Turn | null = null
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
  const lifecycle = opts.bare
    ? { run: async () => undefined }
    : loadLifecycleHooks(session.cwd)

  async function persistSettledTool(
    row: Extract<Message, { role: 'tool' }>,
  ): Promise<void> {
    await opts.store.persistToolResults(session.id, [row])
    messages = [...messages, row]
    if (liveTurn) liveTurn.messages = [...liveTurn.messages, row]
  }

  async function applyAskAnswer(
    callId: string,
    answer: PendingAskAnswer,
  ): Promise<'matched' | 'unmatched'> {
    const row = await opts.store.getPendingAsk(callId)
    if (!row || row.sessionId !== session.id) return 'unmatched'

    if (answer === 'deny') {
      await persistSettledTool(makeToolMessage(callId, false, denyText(row.message)))
      await opts.store.deletePendingAsk(callId)
      return 'matched'
    }

    if (answer === 'allow_always') {
      await persistAllowAlways({
        store: opts.store,
        sessionId: session.id,
        cwd: session.cwd,
        scope: row.saveAs ?? 'session',
        tool: row.tool,
        spec: commandOrPath(row.input) ?? {},
      })
    }

    const tool = opts.tools.find((item) => item.name === row.tool)
    if (!tool) {
      await persistSettledTool(makeToolMessage(callId, false, unknownToolText(row.tool)))
      await opts.store.deletePendingAsk(callId)
      return 'matched'
    }

    const parsed = tool.parse(row.input)
    if (!parsed.ok) {
      await persistSettledTool(makeToolMessage(callId, false, parseFailedText(parsed.message)))
      await opts.store.deletePendingAsk(callId)
      return 'matched'
    }

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
      model: session.model,
      readFiles: new Set(),
    }
    if (session.prePlanMode !== undefined) turn.prePlanMode = session.prePlanMode
    const ctx: ToolContext = {
      turn,
      signal: turn.abort.signal,
      onProgress: () => {},
      store: opts.store,
      tasks,
      fileHistory,
    }

    let toolRow: Extract<Message, { role: 'tool' }>
    try {
      const output = await tool.execute(parsed.value, ctx)
      const formatted = formatSettledOutput(tool, output)
      toolRow = makeToolMessage(callId, true, formatted.content, formatted.persistPath)
    } catch (error) {
      const text = executeFailedText(error instanceof Error ? error.message : String(error))
      toolRow = makeToolMessage(callId, false, text)
    }
    await persistSettledTool(toolRow)
    await opts.store.deletePendingAsk(callId)
    return 'matched'
  }

  async function* replayPendingAsks(): AsyncGenerator<StreamEvent, void> {
    replayAbort = new AbortController()
    try {
      for (const row of await opts.store.listPendingAsks(session.id)) {
        const event: Extract<StreamEvent, { type: 'permission_ask' }> = {
          type: 'permission_ask',
          id: row.callId,
          tool: row.tool,
          input: row.input,
          message: row.message,
        }
        if (row.saveAs !== undefined) event.saveAs = row.saveAs
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
      if (liveTurn) {
        return { ok: false, notice: 'a turn is in progress' }
      }
      if (tasks.list().some((task) => task.status === 'running' && task.type === 'agent')) {
        return { ok: false, notice: 'a turn is in progress' }
      }
      const result = await rewindLastTurn({
        fileHistory,
        messages,
        store: opts.store,
        sessionId: session.id,
        generation: session.compactGeneration,
      })
      messages = result.messages
      return { ok: result.ok, notice: result.notice }
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
      if ((await opts.store.listPendingAsks(session.id)).length > 0) {
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
        return stop?.preventContinuation === true
          ? { reason: 'hook_stopped' as const }
          : { reason: 'completed' as const }
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
      liveTurn = turn

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
        liveTurn = null
        fileHistory.endTurn()
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
          askUser: opts.askUser,
        }
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
        userTurns += 1
        if (shouldNudgeMemory(userTurns)) {
          turn.messages = injectMidTurnHint(turn.messages, MEMORY_NUDGE)
          messages = turn.messages
        }
        const end = yield* queryLoop(loopOpts)
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
        session.updatedAt = Date.now()
        await opts.store.upsertSession(session)
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
        liveTurn = null
      }
      } finally {
        stopLockRenew?.()
      }
    },

    async compactNow() {
      const source = liveTurn?.messages ?? messages
      const tail = selectProtectedTail(source, opts.compact.protectLastMessages)
      const cut = source.length - tail.length
      if (cut <= 0) return

      const result = await runAutocompact({
        messages: source,
        compact: opts.compact,
        model,
        store: opts.store,
        sessionId: session.id,
        generation: liveTurn?.compactGeneration ?? session.compactGeneration,
        cwd: liveTurn?.projectCwd ?? liveTurn?.cwd ?? session.cwd,
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
        liveTurn.compactGeneration = result.generation
      }
      session.compactGeneration = result.generation
      session.updatedAt = Date.now()
      await opts.store.upsertSession(session)
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

    abort() {
      cancelBackgroundReview?.()
      cancelBackgroundReview = undefined
      replayAbort?.abort()
      if (liveTurn) abortTurn(liveTurn.abort)
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
