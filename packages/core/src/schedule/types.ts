export type CronSchedule = { kind: 'cron'; expr: string }
export type IntervalSchedule = { kind: 'every'; everyMs: number }
export type JobSchedule = CronSchedule | IntervalSchedule

export type CronFireStatus = 'ok' | 'error' | 'skipped'

export const DEFAULT_CRON_TIMEOUT_MS = 600_000
export const MIN_CRON_TIMEOUT_MS = 15_000
export const MAX_CRON_TIMEOUT_MS = 3_600_000
export const CRON_PRE_SCRIPT_TIMEOUT_MS = 30_000

export function clampCronTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_CRON_TIMEOUT_MS
  const n = Math.trunc(timeoutMs)
  if (n < MIN_CRON_TIMEOUT_MS) return MIN_CRON_TIMEOUT_MS
  if (n > MAX_CRON_TIMEOUT_MS) return MAX_CRON_TIMEOUT_MS
  return n
}

export interface CronJob {
  id: string
  name: string
  enabled: boolean
  cwd: string
  prompt: string
  schedule: JobSchedule
  nextFireAt: number
  createdAt: number
  lastFireAt?: number
  lastStatus?: CronFireStatus
  lastError?: string
  lastSessionId?: string
  runningUntil?: number
  timeoutMs?: number
  skipMemory?: boolean
  preScript?: string
  verifyOnStop?: boolean
}

export interface CronLastFirePatch {
  lastFireAt: number
  lastStatus: CronFireStatus
  lastError?: string
  lastSessionId?: string
}

export interface CronStore {
  list(): CronJob[]
  get(id: string): CronJob | undefined
  upsert(job: CronJob): void
  remove(id: string): CronJob | undefined
  claimDue(now: number): CronJob[]
  patchLastFire(id: string, patch: CronLastFirePatch): CronJob | undefined
}

export const CRON_ID_PREFIX = 'c_'
export const MIN_INTERVAL_MS = 15_000
export const TICK_MS = 15_000
