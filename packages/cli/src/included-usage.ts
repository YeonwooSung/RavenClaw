import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

const LOCK_DIRNAME = 'included-usage.lock'
const LOCK_WAIT_MS = 2_000
const LOCK_STALE_MS = 2_000

export function tryRecordIncludedSession(home: string, cap: number, now = Date.now()): boolean {
  try {
    mkdirSync(home, { recursive: true })
  } catch {
    return false
  }
  const lockDir = join(home, LOCK_DIRNAME)
  const deadline = Date.now() + LOCK_WAIT_MS
  while (true) {
    try {
      mkdirSync(lockDir)
      try {
        const current = readIncludedUsage(home, now)
        if (current.count >= cap) return false
        try {
          writeIncludedUsage(home, { day: current.day, count: current.count + 1 })
        } catch {
          return false
        }
        return true
      } finally {
        try {
          rmSync(lockDir, { recursive: true, force: true })
        } catch {
          // lock cleanup is best-effort
        }
      }
    } catch (error) {
      if (!isAlreadyExists(error)) return false
      if (isStaleLock(lockDir)) {
        try {
          rmSync(lockDir, { recursive: true, force: true })
        } catch {
          return false
        }
        continue
      }
      if (Date.now() > deadline) return false
      sleepMs(5)
    }
  }
}

export function includedCapReached(home: string, cap: number, now = Date.now()): boolean {
  return readIncludedUsage(home, now).count >= cap
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'EEXIST'
  )
}

function isStaleLock(lockDir: string): boolean {
  try {
    const age = Date.now() - statSync(lockDir).mtimeMs
    return Number.isFinite(age) && age > LOCK_STALE_MS
  } catch {
    return true
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function writeIncludedUsage(home: string, usage: IncludedUsage): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'included-usage.json'), `${JSON.stringify(usage)}\n`, 'utf8')
}

