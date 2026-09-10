import type {
  Message,
  PermissionMode,
  QueryLoopOptions,
  RoundEnd,
  SessionEngine,
  SessionEngineOptions,
  StreamEvent,
  Turn,
} from '../types'
import { abortTurn } from './abort'
import { queryLoop } from './query-loop'

export function createSessionEngine(opts: SessionEngineOptions): SessionEngine {
  const session = { ...opts.session }
  let messages: Message[] = opts.messages ? [...opts.messages] : []
  let liveTurn: Turn | null = null

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
        if (opts.system !== undefined) loopOpts.system = opts.system
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

    async compactNow() {},

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
