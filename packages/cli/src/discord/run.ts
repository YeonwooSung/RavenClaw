import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSqliteDeliveries,
  loadConfig,
  loadDotEnv,
  parseConfigYaml,
  ravenclawHome,
  sqliteStoreDatabase,
  type ConfigFlags,
  type SessionLockHolderName,
} from '@ravenclaw/core'
import { createChatSessionHost } from '../chat-host/session-host'
import { bootCli } from '../engine'
import { runDiscordAdapter } from './adapter'
import type { DiscordOpenSession } from './types'

export const DISCORD_LOCK_HOLDER: SessionLockHolderName = 'discord'

const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000

export async function runDiscord(opts: { flags: ConfigFlags }): Promise<number> {
  const home = ravenclawHome()
  let resolved
  try {
    resolved = loadConfig({ home, flags: opts.flags })
  } catch (error) {
    const peeked = peekDiscord(home)
    if (peeked === undefined || peeked.enabled !== true) {
      process.stderr.write('discord is disabled (set discord.enabled: true in config.yaml)\n')
      return 1
    }
    if (peeked.token === '') {
      process.stderr.write('discord requires DISCORD_BOT_TOKEN\n')
      return 1
    }
    throw error
  }
  const discord = resolved.discord
  if (discord === undefined || discord.enabled !== true) {
    process.stderr.write('discord is disabled (set discord.enabled: true in config.yaml)\n')
    return 1
  }
  if (discord.token === '') {
    process.stderr.write('discord requires DISCORD_BOT_TOKEN\n')
    return 1
  }

  const shared = await bootCli({
    flags: opts.flags,
    createSession: false,
    surface: 'headless',
    lockHolder: DISCORD_LOCK_HOLDER,
  })
  const host = createChatSessionHost({ home, shared })
  const openSession: DiscordOpenSession = (req) => host.openSession(req)

  const db = sqliteStoreDatabase(shared.store)
  if (db === undefined) throw new Error('discord ledger requires sqlite session store')
  const ledger = createSqliteDeliveries(db)
  ledger.gc(Date.now() - DELIVERY_TTL_MS)

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

  process.stdout.write('raven discord  Gateway (allowlist)\n')
  try {
    while (!stop.signal.aborted) {
      try {
        await runDiscordAdapter({
          config: discord,
          openSession,
          ledger,
          pairingHome: home,
          turnFlights: host.turnFlights,
          signal: stop.signal,
        })
      } catch (error) {
        if (stop.signal.aborted) break
        process.stderr.write(
          `discord gateway: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        await sleep(2_000)
        continue
      }
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

function peekDiscord(home: string): { enabled: boolean; token: string } | undefined {
  const yamlPath = join(home, 'config.yaml')
  if (!existsSync(yamlPath)) return undefined
  let parsed
  try {
    parsed = parseConfigYaml(readFileSync(yamlPath, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed.discord === undefined) return undefined
  const envPath = join(home, '.env')
  const fileEnv = loadDotEnv(existsSync(envPath) ? readFileSync(envPath, 'utf8') : '')
  const raw = parsed.discord.token
  const token = raw !== '' ? raw : (process.env.DISCORD_BOT_TOKEN ?? fileEnv.DISCORD_BOT_TOKEN ?? '')
  return { enabled: parsed.discord.enabled, token }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
