import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from './home'

const LOG_NAME = 'ravenclaw.log'
const ROTATE_COUNT = 2
export const RAVENCLAW_LOG_MAX_BYTES = 5 * 1024 * 1024

const ALLOWED_KEYS = ['type', 'sessionId', 'reason', 'error'] as const

export type RavenclawLogEvent = {
  type: string
  sessionId?: string
  reason?: string
  error?: string
}

export interface RavenclawLog {
  write(event: RavenclawLogEvent): void
  close(): void
}

export function openRavenclawLog(
  home?: string,
  opts?: { maxBytes?: number },
): RavenclawLog {
  const dir = join(home ?? ravenclawHome(), 'logs')
  const path = join(dir, LOG_NAME)
  const maxBytes = opts?.maxBytes ?? RAVENCLAW_LOG_MAX_BYTES
  let closed = false

  return {
    write(event) {
      if (closed) return
      try {
        mkdirSync(dir, { recursive: true })
        rotateIfNeeded(path, maxBytes)
        appendFileSync(path, `${JSON.stringify(sanitize(event))}\n`)
      } catch {
        // Failure to write is silent.
      }
    },
    close() {
      closed = true
    },
  }
}

function sanitize(event: RavenclawLogEvent): RavenclawLogEvent {
  const out: RavenclawLogEvent = { type: typeof event.type === 'string' ? event.type : 'unknown' }
  for (const key of ALLOWED_KEYS) {
    if (key === 'type') continue
    const value = event[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function rotateIfNeeded(path: string, maxBytes: number): void {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size < maxBytes) return
  const oldest = `${path}.${ROTATE_COUNT}`
  try {
    unlinkSync(oldest)
  } catch {
    // no .2 yet
  }
  for (let i = ROTATE_COUNT - 1; i >= 1; i--) {
    try {
      renameSync(`${path}.${i}`, `${path}.${i + 1}`)
    } catch {
      // missing intermediate
    }
  }
  try {
    renameSync(path, `${path}.1`)
  } catch {
    // keep appending if rename fails
  }
}
