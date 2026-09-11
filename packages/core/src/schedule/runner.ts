import type { CronFireStatus, CronJob, CronStore } from './types'

export interface CronRunResult {
  ok: boolean
  sessionId?: string
  error?: string
}

export interface FireDueResult {
  job: CronJob
  status: CronFireStatus
}

const running = new Set<string>()

export async function fireDueJobs(opts: {
  store: CronStore
  run: (job: CronJob) => Promise<CronRunResult>
  now?: number
}): Promise<FireDueResult[]> {
  const now = opts.now ?? Date.now()
  const claimed = opts.store.claimDue(now)
  const out: FireDueResult[] = []
  for (const job of claimed) {
    if (running.has(job.id)) {
      const skipped: CronJob = { ...job, lastFireAt: now, lastStatus: 'skipped' }
      opts.store.upsert(skipped)
      out.push({ job: skipped, status: 'skipped' })
      continue
    }
    running.add(job.id)
    try {
      const result = await opts.run(job)
      const status: CronFireStatus = result.ok ? 'ok' : 'error'
      const updated: CronJob = { ...job, lastFireAt: now, lastStatus: status }
      if (result.sessionId !== undefined) updated.lastSessionId = result.sessionId
      if (result.error !== undefined) updated.lastError = result.error
      else delete updated.lastError
      opts.store.upsert(updated)
      out.push({ job: updated, status })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const updated: CronJob = {
        ...job,
        lastFireAt: now,
        lastStatus: 'error',
        lastError: message,
      }
      opts.store.upsert(updated)
      out.push({ job: updated, status: 'error' })
    } finally {
      running.delete(job.id)
    }
  }
  return out
}

export function formatCronList(jobs: CronJob[]): string {
  if (jobs.length === 0) return 'no cron jobs'
  return jobs.map(formatCronLine).join('\n')
}

export function formatCronLine(job: CronJob): string {
  const on = job.enabled ? 'on' : 'off'
  const spec = formatScheduleSafe(job)
  const prompt = job.prompt.replace(/\s+/g, ' ').trim()
  const clipped = prompt.length <= 60 ? prompt : `${prompt.slice(0, 57)}...`
  const last = job.lastStatus ? `  last ${job.lastStatus}` : ''
  return `${job.id}  ${on}  ${spec}  ${clipped}${last}`
}

function formatScheduleSafe(job: CronJob): string {
  if (job.schedule.kind === 'every') {
    const ms = job.schedule.everyMs
    if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`
    if (ms % 60_000 === 0) return `every ${ms / 60_000}m`
    if (ms % 1000 === 0) return `every ${ms / 1000}s`
    return `every ${ms}ms`
  }
  return job.schedule.expr
}
