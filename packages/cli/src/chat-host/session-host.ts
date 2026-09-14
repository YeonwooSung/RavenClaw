import { AsyncLocalStorage } from 'node:async_hooks'
import { loadSessionMap, resolveSessionId, saveSessionMap } from '@ravenclaw/core'
import { openNewSession, resumeRuntime, type CliRuntime } from '../engine'
import { singleFlight, startMailboxPoller } from '../serve'

export type ChatPermissionAnswer = 'allow' | 'deny' | 'allow_always'

export type ChatAsk = (
  event: { id: string; tool: string; message: string },
  signal: AbortSignal,
) => Promise<ChatPermissionAnswer>

export interface ChatOpenSessionReq {
  sessionKey: string
  permissionMode: 'default' | 'dontAsk'
  askUser: ChatAsk
}

export interface ChatBoundSession {
  sessionId: string
  submitMessage: (text: string) => AsyncGenerator<unknown, unknown>
}

export interface ChatSessionHost {
  engines: Map<string, CliRuntime>
  turnFlights: Map<string, Promise<unknown>>
  openSession(req: ChatOpenSessionReq): Promise<ChatBoundSession>
  startMailbox(): () => void
  shutdown(): Promise<void>
}

export function createChatSessionHost(opts: {
  home: string
  shared: CliRuntime
  newId?: () => string
  openNewSession?: typeof openNewSession
  resumeRuntime?: typeof resumeRuntime
}): ChatSessionHost {
  const map = loadSessionMap(opts.home)
  const engines = new Map<string, CliRuntime>()
  const opening = new Map<string, Promise<CliRuntime>>()
  const turnFlights = new Map<string, Promise<unknown>>()
  const askStore = new AsyncLocalStorage<ChatAsk>()
  const openNew = opts.openNewSession ?? openNewSession
  const resume = opts.resumeRuntime ?? resumeRuntime
  const newId = opts.newId ?? (() => crypto.randomUUID())

  opts.shared.ask.bind(async (event, signal) => {
    const ask = askStore.getStore()
    if (!ask) return 'deny'
    return ask({ id: event.id, tool: event.tool, message: event.message }, signal)
  })

  async function openSession(req: ChatOpenSessionReq): Promise<ChatBoundSession> {
    const resolvedId = resolveSessionId(map, req.sessionKey, newId)
    if (resolvedId.created) saveSessionMap(map, opts.home)
    const runtime = await singleFlight(opening, resolvedId.id, async () => {
      const cached = engines.get(resolvedId.id)
      if (cached) return cached
      const boot = {
        ...opts.shared,
        config: { ...opts.shared.config, permissionMode: req.permissionMode },
      }
      const opened = resolvedId.created
        ? await openNew(boot, { sessionId: resolvedId.id })
        : await resume(boot, resolvedId.id)
      if (opened.engine.session.permissionMode !== req.permissionMode) {
        await opened.engine.setPermissionMode(req.permissionMode)
      }
      engines.set(resolvedId.id, opened)
      return opened
    })
    return {
      sessionId: runtime.engine.session.id,
      async *submitMessage(text: string) {
        const gen = runtime.engine.submitMessage(text)
        while (true) {
          const next = await askStore.run(req.askUser, () => gen.next())
          if (next.done) return next.value
          yield next.value
        }
      },
    }
  }

  let stopped = false
  async function shutdown(): Promise<void> {
    if (stopped) return
    stopped = true
    await Promise.allSettled([...turnFlights.values()])
    for (const runtime of engines.values()) {
      await runtime.engine.close?.()
      await runtime.mcpCloser?.()
    }
  }

  return {
    engines,
    turnFlights,
    openSession,
    startMailbox() {
      return startMailboxPoller(engines, turnFlights)
    },
    shutdown,
  }
}
