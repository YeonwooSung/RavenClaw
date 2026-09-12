import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from '@ravenclaw/core'

export const PAIRING_TTL_MS = 10 * 60 * 1000

export type PairingPlatform = 'discord'

export type PairingStore = {
  discord: Record<string, { approvedAt: number; note?: string }>
}

export type PairingPending = {
  [code: string]: { platform: PairingPlatform; userId: string; expiresAt: number }
}

export function pairingPaths(home: string): { store: string; pending: string } {
  return {
    store: join(home, 'pairing.json'),
    pending: join(home, 'pairing-pending.json'),
  }
}

function emptyStore(): PairingStore {
  return { discord: {} }
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJsonFile(path: string, value: unknown): void {
  const json = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(path, json, { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600)
}

export function loadPairingStore(home: string): PairingStore {
  const raw = readJsonFile(pairingPaths(home).store)
  if (!raw || typeof raw !== 'object') return emptyStore()
  const discord = (raw as { discord?: unknown }).discord
  if (!discord || typeof discord !== 'object') return emptyStore()
  return { discord: discord as PairingStore['discord'] }
}

export function loadPairingPending(home: string): PairingPending {
  const raw = readJsonFile(pairingPaths(home).pending)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as PairingPending
}

function savePairingStore(home: string, store: PairingStore): void {
  writeJsonFile(pairingPaths(home).store, store)
}

function savePairingPending(home: string, pending: PairingPending): void {
  writeJsonFile(pairingPaths(home).pending, pending)
}

export function isPairingApproved(home: string, platform: PairingPlatform, userId: string): boolean {
  const store = loadPairingStore(home)
  return store[platform]?.[userId] !== undefined
}

function defaultCode(): string {
  return String(100000 + Math.floor(Math.random() * 900000))
}

export function issueOrReusePending(
  home: string,
  platform: PairingPlatform,
  userId: string,
  opts?: { now?: () => number; randomCode?: () => string },
): { code: string; reused: boolean } {
  const now = opts?.now ?? Date.now
  const randomCode = opts?.randomCode ?? defaultCode
  const t = now()
  const pending = loadPairingPending(home)

  for (const [code, row] of Object.entries(pending)) {
    if (row.platform === platform && row.userId === userId && row.expiresAt > t) {
      return { code, reused: true }
    }
  }

  const code = randomCode()
  pending[code] = { platform, userId, expiresAt: t + PAIRING_TTL_MS }
  savePairingPending(home, pending)
  return { code, reused: false }
}

export function approvePairingCode(
  home: string,
  code: string,
  opts?: { now?: () => number },
): { ok: true; platform: PairingPlatform; userId: string } | { ok: false; error: string } {
  const now = opts?.now ?? Date.now
  const t = now()
  const trimmed = code.trim()
  const pending = loadPairingPending(home)
  const row = pending[trimmed]
  if (!row || row.expiresAt <= t) {
    return { ok: false, error: 'unknown or expired code' }
  }

  const store = loadPairingStore(home)
  store[row.platform][row.userId] = { approvedAt: t }
  savePairingStore(home, store)
  delete pending[trimmed]
  savePairingPending(home, pending)
  return { ok: true, platform: row.platform, userId: row.userId }
}

export function revokePairing(home: string, platform: PairingPlatform, userId: string): boolean {
  const store = loadPairingStore(home)
  if (store[platform]?.[userId] === undefined) return false
  delete store[platform][userId]
  savePairingStore(home, store)
  return true
}

export function formatPairingList(home: string, opts?: { now?: () => number }): string {
  void opts
  const lines: string[] = []
  const store = loadPairingStore(home)
  for (const [userId] of Object.entries(store.discord)) {
    lines.push(`discord ${userId} approved`)
  }
  const pending = loadPairingPending(home)
  for (const [code, row] of Object.entries(pending)) {
    lines.push(`pending ${code} ${row.platform} ${row.userId} expires ${new Date(row.expiresAt).toISOString()}`)
  }
  return lines.join('\n') + (lines.length ? '\n' : '')
}

export async function handlePairingCli(
  args: string[],
  opts?: { home?: string; now?: () => number },
): Promise<number> {
  const home = opts?.home ?? ravenclawHome()
  const now = opts?.now

  if (args.length === 0 || args[0] === 'list') {
    process.stdout.write(formatPairingList(home, { now }))
    return 0
  }

  if (args[0] === 'approve' && args[1]) {
    const result = approvePairingCode(home, args[1], { now })
    if (!result.ok) {
      process.stderr.write(`${result.error}\n`)
      return 1
    }
    process.stdout.write(`approved ${result.platform} ${result.userId}\n`)
    return 0
  }

  if (args[0] === 'revoke' && args[1] === 'discord' && args[2]) {
    const ok = revokePairing(home, 'discord', args[2])
    if (!ok) {
      process.stderr.write('not paired\n')
      return 1
    }
    process.stdout.write(`revoked discord ${args[2]}\n`)
    return 0
  }

  process.stderr.write('usage: raven pairing [list|approve <code>|revoke discord <userId>]\n')
  return 2
}
