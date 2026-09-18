import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from './home'
import type { RoundEnd, SessionEngine, StreamEvent } from './types'

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

export type WrapSessionEngineLogOpts = {
  /** When true, engine.close() also closes the log. Leave false for a shared process log. */
  closeLog?: boolean
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

export function wrapSessionEngineLog(
  engine: SessionEngine,
  log: RavenclawLog,
  opts?: WrapSessionEngineLogOpts,
): SessionEngine {
  const closeLog = opts?.closeLog === true
  return {
    get session() {
      return engine.session
    },
    get tasks() {
      return engine.tasks
    },
    get fileHistory() {
      return engine.fileHistory
    },
    submitMessage(input) {
      return logSubmit(engine.submitMessage(input), engine.session.id, log)
    },
    applyAskAnswer(callId, answer) {
      return engine.applyAskAnswer(callId, answer)
    },
    replayPendingAsks() {
      return engine.replayPendingAsks()
    },
    enqueueSteer(text) {
      engine.enqueueSteer(text)
    },
    drainSteering() {
      return engine.drainSteering()
    },
    bindDrainQueued(fn) {
      engine.bindDrainQueued(fn)
    },
    rewindLast() {
      return engine.rewindLast()
    },
    maybeFinishRewindReset() {
      return engine.maybeFinishRewindReset()
    },
    whenTreeStop() {
      return engine.whenTreeStop()
    },
    compactNow() {
      return engine.compactNow()
    },
    setModel(profile) {
      return engine.setModel(profile)
    },
    setPermissionMode(mode) {
      return engine.setPermissionMode(mode)
    },
    reloadSystem(system) {
      engine.reloadSystem(system)
    },
    abort(kind) {
      engine.abort(kind)
    },
    liveTurnId() {
      return engine.liveTurnId()
    },
    async close(closeOpts) {
      try {
        await engine.close(closeOpts)
      } finally {
        if (closeLog) log.close()
      }
    },
  }
}

async function* logSubmit(
  gen: AsyncGenerator<StreamEvent, RoundEnd>,
  sessionId: string,
  log: RavenclawLog,
): AsyncGenerator<StreamEvent, RoundEnd> {
  const end = yield* gen
  log.write({ type: 'round_end', sessionId, reason: end.reason })
  if (end.reason === 'persist_failed' || end.reason === 'results_persist_failed') {
    const error = stringifyLogError('error' in end ? end.error : undefined)
    log.write({
      type: end.reason,
      sessionId,
      ...(error !== undefined ? { error } : {}),
    })
  }
  return end
}

function stringifyLogError(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return 'error'
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
