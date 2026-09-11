import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ravenclawHome } from '../home'
import { nextFireAt } from './cron'
import { CRON_ID_PREFIX, type CronJob, type CronLastFirePatch, type CronStore } from './types'

export const CRON_RUNNING_LEASE_MS = 2 * 60 * 60 * 1000

const LOCK_WAIT_MS = 200
const LOCK_POLL_MS = 5
const STALE_LOCK_MS = 5_000

export function cronJobsPath(home?: string): string {
  return join(home ?? ravenclawHome(), 'cron', 'jobs.json')
}

export function newCronId(): string {
  return `${CRON_ID_PREFIX}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
}

function nextFireAfter(job: CronJob, now: number): number {
  const next = nextFireAt(job.schedule, now)
  return next > now ? next : now + 1
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'EEXIST'
  )
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// mkdir lock at `${jobsPath}.lock`; retry/fail after ~200ms on EEXIST.
function withJobsLock<T>(lockDir: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS
  while (true) {
    try {
      mkdirSync(lockDir)
      try {
        return fn()
      } finally {
        try {
          rmdirSync(lockDir)
        } catch {
          // lock cleanup is best-effort
        }
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > STALE_LOCK_MS) {
          rmdirSync(lockDir)
          continue
        }
      } catch {
        // lock vanished or is not a dir
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for cron lock: ${lockDir}`)
      }
      sleepMs(LOCK_POLL_MS)
    }
  }
}

function loadJobs(path: string): CronJob[] {
  if (!existsSync(path)) return []
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`invalid cron jobs file: ${path}`)
  }
  const jobs = (raw as { jobs?: unknown }).jobs
  if (!Array.isArray(jobs)) {
    throw new Error(`invalid cron jobs file: ${path}`)
  }
  return jobs.map((job) => structuredClone(job) as CronJob)
}

function saveJobs(path: string, jobs: CronJob[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ jobs }, null, 2)}\n`, 'utf8')
}

function applyLastFirePatch(job: CronJob, patch: CronLastFirePatch): CronJob {
  const updated: CronJob = {
    ...job,
    lastFireAt: patch.lastFireAt,
    lastStatus: patch.lastStatus,
  }
  delete updated.runningUntil
  if (patch.lastSessionId !== undefined) updated.lastSessionId = patch.lastSessionId
  if (patch.lastError !== undefined) updated.lastError = patch.lastError
  else delete updated.lastError
  return updated
}

export function createJsonCronStore(opts?: { home?: string }): CronStore {
  const path = cronJobsPath(opts?.home)
  const lockDir = `${path}.lock`

  function withStoreLock<T>(fn: () => T): T {
    mkdirSync(dirname(path), { recursive: true })
    return withJobsLock(lockDir, fn)
  }

  return {
    list() {
      return loadJobs(path)
    },
    get(id) {
      return loadJobs(path).find((job) => job.id === id)
    },
    upsert(job) {
      withStoreLock(() => {
        const jobs = loadJobs(path)
        const index = jobs.findIndex((row) => row.id === job.id)
        const copy = structuredClone(job)
        if (index === -1) jobs.push(copy)
        else jobs[index] = copy
        saveJobs(path, jobs)
      })
    },
    remove(id) {
      return withStoreLock(() => {
        const jobs = loadJobs(path)
        const index = jobs.findIndex((row) => row.id === id)
        if (index === -1) return undefined
        const [removed] = jobs.splice(index, 1)
        saveJobs(path, jobs)
        return removed
      })
    },
    claimDue(now) {
      return withStoreLock(() => {
        const jobs = loadJobs(path)
        const claimed: CronJob[] = []
        for (let i = 0; i < jobs.length; i++) {
          const job = jobs[i]
          if (!job || !job.enabled || job.nextFireAt > now) continue
          if (job.runningUntil !== undefined && job.runningUntil > now) {
            jobs[i] = {
              ...job,
              nextFireAt: nextFireAfter(job, now),
              lastFireAt: now,
              lastStatus: 'skipped',
            }
            continue
          }
          const updated: CronJob = {
            ...job,
            nextFireAt: nextFireAfter(job, now),
            runningUntil: now + CRON_RUNNING_LEASE_MS,
          }
          jobs[i] = updated
          claimed.push(structuredClone(updated))
        }
        saveJobs(path, jobs)
        return claimed
      })
    },
    patchLastFire(id, patch) {
      return withStoreLock(() => {
        const jobs = loadJobs(path)
        const index = jobs.findIndex((row) => row.id === id)
        if (index === -1) return undefined
        const current = jobs[index]
        if (!current) return undefined
        const updated = applyLastFirePatch(current, patch)
        jobs[index] = updated
        saveJobs(path, jobs)
        return structuredClone(updated)
      })
    },
  }
}
