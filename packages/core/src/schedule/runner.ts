import type { CronFireStatus, CronJob, CronLastFirePatch, CronStore } from './types'

export interface CronRunResult {
  ok: boolean
  sessionId?: string
  error?: string
}

export interface FireDueResult {
  job: CronJob
  status: CronFireStatus
}

export async function fireDueJobs(opts: {
  store: CronStore
  run: (job: CronJob) => Promise<CronRunResult>
  now?: number
}): Promise<FireDueResult[]> {
  const now = opts.now ?? Date.now()
  const claimed = opts.store.claimDue(now)
  const out: FireDueResult[] = []
  for (const job of claimed) {
    try {
      const result = await opts.run(job)
      const status: CronFireStatus = result.ok ? 'ok' : 'error'
      const patch: CronLastFirePatch = { lastFireAt: now, lastStatus: status }
      if (result.sessionId !== undefined) patch.lastSessionId = result.sessionId
      if (result.error !== undefined) patch.lastError = result.error
      out.push({ job: persistLastFire(opts.store, job, patch), status })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const patch: CronLastFirePatch = { lastFireAt: now, lastStatus: 'error', lastError: message }
      out.push({ job: persistLastFire(opts.store, job, patch), status: 'error' })
    }
  }
  return out
}

function persistLastFire(store: CronStore, claimed: CronJob, patch: CronLastFirePatch): CronJob {
  const updated = store.patchLastFire(claimed.id, patch)
  if (updated) return updated
  const ephemeral: CronJob = {
    ...claimed,
    lastFireAt: patch.lastFireAt,
    lastStatus: patch.lastStatus,
  }
  delete ephemeral.runningUntil
  if (patch.lastSessionId !== undefined) ephemeral.lastSessionId = patch.lastSessionId
  if (patch.lastError !== undefined) ephemeral.lastError = patch.lastError
  else delete ephemeral.lastError
  return ephemeral
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
