import { AsyncLocalStorage } from 'node:async_hooks'
import {
  loadConfig,
  loadSessionMap,
  ravenclawHome,
  resolveSessionId,
  saveSessionMap,
  type ConfigFlags,
} from '@ravenclaw/core'
import { bootCli, openNewSession, resumeRuntime, type CliRuntime } from '../engine'
import { singleFlight, startMailboxPoller } from '../serve'
import { runSlackAdapter } from './adapter'
import { createSlackWebApi } from './api'
import { connectSlackSocket } from './socket'
import type { SlackOpenSession, SlackPermissionAnswer } from './types'

type SlackAsk = (
  event: { id: string; tool: string; message: string },
  signal: AbortSignal,
) => Promise<SlackPermissionAnswer>

const askStore = new AsyncLocalStorage<SlackAsk>()

export async function runSlack(opts: { flags: ConfigFlags }): Promise<number> {
  const home = ravenclawHome()
  const resolved = loadConfig({ home, flags: opts.flags })
  const slack = resolved.slack
  if (slack === undefined || slack.enabled !== true) {
    process.stderr.write('slack is disabled (set slack.enabled: true in config.yaml)\n')
    return 1
  }
  if (slack.appToken === '' || slack.botToken === '') {
    process.stderr.write('slack requires slack.appToken (xapp-) and slack.botToken (xoxb-)\n')
    return 1
  }

  const map = loadSessionMap(home)
  const engines = new Map<string, CliRuntime>()
  const opening = new Map<string, Promise<CliRuntime>>()
  const mailboxFlights = new Map<string, Promise<unknown>>()
  const shared = await bootCli({
    flags: opts.flags,
    createSession: false,
    surface: 'headless',
    lockHolder: 'serve',
  })
  shared.ask.bind(async (event, signal) => {
    const ask = askStore.getStore()
    if (!ask) return 'deny'
    return ask({ id: event.id, tool: event.tool, message: event.message }, signal)
  })

  const api = createSlackWebApi({ botToken: slack.botToken })
  let botUserId: string | undefined
  try {
    const auth = await api.authTest?.()
    if (auth?.ok === true && auth.userId !== undefined) botUserId = auth.userId
  } catch {
    // mention-only still matches <@U…> tags
  }

  const openSession: SlackOpenSession = async (req) => {
    const resolvedId = resolveSessionId(map, req.sessionKey, () => crypto.randomUUID())
    if (resolvedId.created) saveSessionMap(map, home)
    const runtime = await singleFlight(opening, resolvedId.id, async () => {
      const cached = engines.get(resolvedId.id)
      if (cached) return cached
      const boot = {
        ...shared,
        config: { ...shared.config, permissionMode: req.permissionMode },
      }
      const opened = resolvedId.created
        ? await openNewSession(boot, { sessionId: resolvedId.id })
        : await resumeRuntime(boot, resolvedId.id)
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

  const stop = new AbortController()
  const stopMailbox = startMailboxPoller(engines, mailboxFlights)
  let stopped = false
  const shutdown = async () => {
    if (stopped) return
    stopped = true
    stop.abort()
    stopMailbox()
    await Promise.allSettled([...mailboxFlights.values()])
    for (const runtime of engines.values()) {
      await runtime.engine.close?.()
      await runtime.mcpCloser?.()
    }
  }
  const onStop = () => {
    void shutdown()
  }
  process.once('SIGINT', onStop)
  process.once('SIGTERM', onStop)

  process.stdout.write('raven slack  Socket Mode (allowlist)\n')
  try {
    while (!stop.signal.aborted) {
      let socket
      try {
        socket = await connectSlackSocket({ appToken: slack.appToken, signal: stop.signal })
      } catch (error) {
        if (stop.signal.aborted) break
        process.stderr.write(
          `slack socket: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        await sleep(2_000)
        continue
      }
      const adapterOpts: Parameters<typeof runSlackAdapter>[0] = {
        config: slack,
        openSession,
        socket,
        api,
        signal: stop.signal,
      }
      if (botUserId !== undefined) adapterOpts.botUserId = botUserId
      await runSlackAdapter(adapterOpts)
      if (stop.signal.aborted) break
      await sleep(1_000)
    }
  } finally {
    process.removeListener('SIGINT', onStop)
    process.removeListener('SIGTERM', onStop)
    await shutdown()
  }
  return 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
