import { runAutocompact } from '../compact/prune'
import { mechanicalSummary } from '../compact/summarize'
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
} from '../types'
import { abortTurn } from './abort'
import { queryLoop } from './query-loop'
import { selectProtectedTail } from './repair'

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

  return {
    get session() {
      return session
    },

    async *submitMessage(text: string): AsyncGenerator<StreamEvent, RoundEnd> {
      const userMsg: Extract<Message, { role: 'user' }> = {
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [{ type: 'text', text }],
        createdAt: Date.now(),
      }
      messages = [...messages, userMsg]

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
      liveTurn = turn

      try {
        await opts.store.persistUser(session.id, userMsg)
      } catch (error) {
        messages = messages.slice(0, -1)
        liveTurn = null
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
        const end = yield* queryLoop(loopOpts)
        messages = turn.messages
        session.usage = turn.usage
        session.compactGeneration = turn.compactGeneration
        session.permissionMode = turn.permissionMode
        if (turn.prePlanMode !== undefined) session.prePlanMode = turn.prePlanMode
        session.updatedAt = Date.now()
        await opts.store.upsertSession(session)
        return end
      } finally {
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
