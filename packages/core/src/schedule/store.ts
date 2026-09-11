import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ravenclawHome } from '../home'
import { nextFireAt } from './cron'
import { CRON_ID_PREFIX, type CronJob, type CronStore } from './types'

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

export function createJsonCronStore(opts?: { home?: string }): CronStore {
  const path = cronJobsPath(opts?.home)
  const lockDir = `${path}.lock`

  return {
    list() {
      return loadJobs(path)
    },
    get(id) {
      return loadJobs(path).find((job) => job.id === id)
    },
    upsert(job) {
      mkdirSync(dirname(path), { recursive: true })
      const jobs = loadJobs(path)
      const index = jobs.findIndex((row) => row.id === job.id)
      const copy = structuredClone(job)
      if (index === -1) jobs.push(copy)
      else jobs[index] = copy
      saveJobs(path, jobs)
    },
    remove(id) {
      const jobs = loadJobs(path)
      const index = jobs.findIndex((row) => row.id === id)
      if (index === -1) return undefined
      const [removed] = jobs.splice(index, 1)
      saveJobs(path, jobs)
      return removed
    },
    claimDue(now) {
      mkdirSync(dirname(path), { recursive: true })
      return withJobsLock(lockDir, () => {
        const jobs = loadJobs(path)
        const claimed: CronJob[] = []
        for (let i = 0; i < jobs.length; i++) {
          const job = jobs[i]
          if (!job || !job.enabled || job.nextFireAt > now) continue
          const updated: CronJob = { ...job, nextFireAt: nextFireAfter(job, now) }
          jobs[i] = updated
          claimed.push(structuredClone(updated))
        }
        saveJobs(path, jobs)
        return claimed
      })
    },
  }
}
