import {
  createJsonCronStore,
  fireDueJobs,
  formatCronLine,
  formatCronList,
  newCronId,
  nextFireAt,
  parseCronSlashArg,
  type CronJob,
} from '@ravenclaw/core'

export function handleCronCli(
  arg: string | undefined,
  cwd: string,
  home?: string,
): { text: string; code: number } {
  const verb = (arg ?? 'list').trim().split(/\s+/)[0]?.toLowerCase()
  // -1: main should boot a provider and run tick/watch
  if (verb === 'tick' || verb === 'watch') return { text: '', code: -1 }
  return applyCronMutate(arg, cwd, home)
}

export function applyCronMutate(
  arg: string | undefined,
  cwd: string,
  home?: string,
): { text: string; code: number } {
  const parsed = parseCronSlashArg(arg ?? 'list')
  const store = createJsonCronStore(home !== undefined ? { home } : undefined)

  if (parsed.action === 'error') return { text: parsed.message, code: 2 }

  if (parsed.action === 'list') {
    return { text: formatCronList(store.list()), code: 0 }
  }

  if (parsed.action === 'add') {
    const now = Date.now()
    let fireAt: number
    try {
      fireAt = nextFireAt(parsed.schedule, now)
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), code: 2 }
    }
    const job: CronJob = {
      id: newCronId(),
      name: parsed.prompt.slice(0, 40),
      enabled: true,
      cwd,
      prompt: parsed.prompt,
      schedule: parsed.schedule,
      nextFireAt: fireAt,
      createdAt: now,
    }
    store.upsert(job)
    return { text: formatCronLine(job), code: 0 }
  }

  if (parsed.action === 'rm') {
    const removed = store.remove(parsed.id)
    if (!removed) return { text: `unknown job ${parsed.id}`, code: 1 }
    return { text: `deleted ${removed.id}`, code: 0 }
  }

  const job = store.get(parsed.id)
  if (!job) return { text: `unknown job ${parsed.id}`, code: 1 }
  const next = { ...job, enabled: parsed.action === 'on' }
  store.upsert(next)
  return { text: formatCronLine(next), code: 0 }
}

export async function runCronTick(opts: {
  cwd?: string
  home?: string
  now?: number
  run: (job: CronJob) => Promise<{ ok: boolean; sessionId?: string; error?: string }>
}): Promise<string> {
  const store = createJsonCronStore(opts.home !== undefined ? { home: opts.home } : undefined)
  const fired = await fireDueJobs({
    store,
    run: opts.run,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  })
  if (fired.length === 0) return 'no due cron jobs'
  return fired.map((row) => formatCronLine(row.job)).join('\n')
}
