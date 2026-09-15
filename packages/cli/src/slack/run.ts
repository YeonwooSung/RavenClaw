import {
  loadConfig,
  ravenclawHome,
  type ConfigFlags,
  type SessionLockHolderName,
} from '@ravenclaw/core'
import { createChatSessionHost } from '../chat-host/session-host'
import { bootCli } from '../engine'
import { runSlackAdapter } from './adapter'
import { createSlackWebApi } from './api'
import { connectSlackSocket } from './socket'
import type { SlackOpenSession } from './types'

export const SLACK_LOCK_HOLDER: SessionLockHolderName = 'slack'

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

  const shared = await bootCli({
    flags: opts.flags,
    createSession: false,
    surface: 'headless',
    lockHolder: SLACK_LOCK_HOLDER,
  })
  const host = createChatSessionHost({ home, shared })
  const openSession: SlackOpenSession = (req) => host.openSession(req)

  const api = createSlackWebApi({ botToken: slack.botToken })
  let botUserId: string | undefined
  try {
    const auth = await api.authTest?.()
    if (auth?.ok === true && auth.userId !== undefined) botUserId = auth.userId
  } catch {
    // mention-only still matches <@U…> tags
  }

  const stop = new AbortController()
  const stopMailbox = host.startMailbox()
  const shutdown = async () => {
    stop.abort()
    stopMailbox()
    await host.shutdown()
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
        turnFlights: host.turnFlights,
        store: shared.store,
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
