import { runAutocompact } from '../compact/prune'
import { mechanicalSummary } from '../compact/summarize'
import { loadLifecycleHooks } from '../hooks/lifecycle'
import { createFileHistory } from '../session/file-history'
import { createTaskRegistry } from '../tasks/registry'
import type {
  Message,
  PermissionMode,
  QueryLoopOptions,
  RoundEnd,
  SessionEngine,
  SessionEngineOptions,
  StreamEvent,
  SystemPart,
  Turn,
  UserOrToolBlock,
  UserSubmitInput,
} from '../types'
import { abortTurn } from './abort'
import { queryLoop } from './query-loop'
import { selectProtectedTail } from './repair'
import { rewindLastTurn } from '../session/rewind'
import { getSessionWorktree } from '../tools/session-worktree'

const TITLE_MAX = 50

function titleFromUserText(text: string): string | undefined {
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  const line = first.replace(/\s+/g, ' ').trim()
  if (line === '') return undefined
  return line.length <= TITLE_MAX ? line : line.slice(0, TITLE_MAX)
}

export function createSessionEngine(opts: SessionEngineOptions): SessionEngine {
  const session = { ...opts.session }
  let messages: Message[] = opts.messages ? [...opts.messages] : []
  let liveTurn: Turn | null = null
  let system = opts.system
  const tasks = createTaskRegistry()
  const fileHistory = createFileHistory(session.id)
  const steering: string[] = []
  const lifecycle = opts.bare
    ? { run: async () => undefined }
    : loadLifecycleHooks(session.cwd)
  if (!opts.bare) {
    void lifecycle.run('SessionStart', { sessionId: session.id, cwd: session.cwd })
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

    enqueueSteer(text: string) {
      const trimmed = text.trim()
      if (trimmed !== '') steering.push(trimmed)
    },

    drainSteering() {
      return steering.splice(0)
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
      const { text, blocks } = userSubmitToBlocks(input)
      const blocked = await lifecycle.run('UserPromptSubmit', { text })
      if (blocked?.preventContinuation === true) {
        yield { type: 'status', message: blocked.message ?? 'stopped by hook' }
        return { reason: 'completed' }
      }
      const userMsg: Extract<Message, { role: 'user' }> = {
        id: crypto.randomUUID(),
        role: 'user',
        blocks,
        createdAt: Date.now(),
      }
      messages = [...messages, userMsg]
      fileHistory.beginTurn()

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
      const extras = opts.additionalDirectories
      if (extras !== undefined && extras.length > 0) {
        turn.additionalDirectories = [...extras]
      }
      const worktree = getSessionWorktree(session.id)
      if (worktree) turn.projectCwd = worktree.originalCwd
      if (session.prePlanMode !== undefined) turn.prePlanMode = session.prePlanMode
      liveTurn = turn

      try {
        await opts.store.persistUser(session.id, userMsg)
      } catch (error) {
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
          model: opts.model,
          askUser: opts.askUser,
        }
        if (system !== undefined) loopOpts.system = system
        if (opts.hooks !== undefined) loopOpts.hooks = opts.hooks
        loopOpts.tasks = tasks
        loopOpts.fileHistory = fileHistory
        loopOpts.drainSteering = () => steering.splice(0)
        loopOpts.lifecycle = lifecycle
        if (opts.fallbackModel !== undefined) loopOpts.fallbackModel = opts.fallbackModel
        if (opts.jsonSchema !== undefined) loopOpts.jsonSchema = opts.jsonSchema
        const end = yield* queryLoop(loopOpts)
        messages = turn.messages
        session.usage = turn.usage
        session.compactGeneration = turn.compactGeneration
        session.permissionMode = turn.permissionMode
        if (turn.prePlanMode !== undefined) session.prePlanMode = turn.prePlanMode
        session.cwd = turn.cwd
        session.updatedAt = Date.now()
        await opts.store.upsertSession(session)
        return end
      } finally {
        fileHistory.endTurn()
        liveTurn = null
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
        model: opts.model,
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
    },

    abort() {
      if (liveTurn) abortTurn(liveTurn.abort)
    },
  }
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
