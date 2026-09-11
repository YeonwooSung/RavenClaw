export type CronSchedule = { kind: 'cron'; expr: string }
export type IntervalSchedule = { kind: 'every'; everyMs: number }
export type JobSchedule = CronSchedule | IntervalSchedule

export type CronFireStatus = 'ok' | 'error' | 'skipped'

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
