import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface IncludedUsage {
  day: string
  count: number
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function readIncludedUsage(home: string, now = Date.now()): IncludedUsage {
  const today = utcDay(now)
  const path = join(home, 'included-usage.json')
  if (!existsSync(path)) return { day: today, count: 0 }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { day: today, count: 0 }
    const rec = raw as Record<string, unknown>
    const day = typeof rec.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.day) ? rec.day : today
    const count =
      typeof rec.count === 'number' && Number.isFinite(rec.count) && rec.count >= 0
        ? Math.floor(rec.count)
        : 0
    if (day !== today) return { day: today, count: 0 }
    return { day, count }
  } catch {
    return { day: today, count: 0 }
  }
}

export function recordIncludedSession(home: string, now = Date.now()): IncludedUsage {
  const current = readIncludedUsage(home, now)
  const next = { day: current.day, count: current.count + 1 }
  try {
    writeIncludedUsage(home, next)
  } catch {
    // best-effort; missing ledger must not fail the session
  }
  return next
}

export function includedCapReached(home: string, cap: number, now = Date.now()): boolean {
  return readIncludedUsage(home, now).count >= cap
}

function writeIncludedUsage(home: string, usage: IncludedUsage): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'included-usage.json'), `${JSON.stringify(usage)}\n`, 'utf8')
}

