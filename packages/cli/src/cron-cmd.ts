import {
  createJsonCronStore,
  fireDueJobs,
  formatCronLine,
  formatCronList,
  newCronId,
  nextFireAt,
  parseCronSlashArg,
  scanCronPrompt,
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
    const extras = parseCronAddExtras(parsed.prompt)
    if ('error' in extras) return { text: extras.error, code: 2 }
    const threat = scanCronPrompt(extras.prompt)
    if (!threat.ok) return { text: threat.message, code: 2 }
    const job: CronJob = {
      id: newCronId(),
      name: extras.prompt.slice(0, 40),
      enabled: true,
      cwd,
      prompt: extras.prompt,
      schedule: parsed.schedule,
      nextFireAt: fireAt,
      createdAt: now,
    }
    if (extras.timeoutMs !== undefined) job.timeoutMs = extras.timeoutMs
    if (extras.skipMemory === true) job.skipMemory = true
    if (extras.preScript !== undefined) job.preScript = extras.preScript
    if (extras.verifyOnStop === true) job.verifyOnStop = true
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

export interface CronAddExtras {
  prompt: string
  timeoutMs?: number
  skipMemory?: boolean
  preScript?: string
  verifyOnStop?: boolean
}

export function parseCronAddExtras(raw: string): CronAddExtras | { error: string } {
  const tokens = tokenizeCronArg(raw)
  const promptParts: string[] = []
  const extras: Omit<CronAddExtras, 'prompt'> = {}
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === undefined) continue
    if (tok === '--skip-memory') {
      extras.skipMemory = true
      continue
    }
    if (tok === '--verify-on-stop') {
      extras.verifyOnStop = true
      continue
    }
    if (tok === '--timeout-ms' || tok.startsWith('--timeout-ms=')) {
      const value = tok.startsWith('--timeout-ms=') ? tok.slice('--timeout-ms='.length) : tokens[++i]
      if (value === undefined || value === '') return { error: '--timeout-ms requires a value' }
      const n = Number(value)
      if (!Number.isFinite(n)) return { error: '--timeout-ms must be a number' }
      extras.timeoutMs = clampAddTimeoutMs(n)
      continue
    }
    if (tok === '--pre-script' || tok.startsWith('--pre-script=')) {
      const value = tok.startsWith('--pre-script=') ? tok.slice('--pre-script='.length) : tokens[++i]
      if (value === undefined || value === '') return { error: '--pre-script requires a value' }
      extras.preScript = value
      continue
    }
    promptParts.push(tok)
  }
  const prompt = promptParts.join(' ').trim()
  if (prompt === '') return { error: 'cron add requires a prompt' }
  return { prompt, ...extras }
}

function clampAddTimeoutMs(timeoutMs: number): number {
  const n = Math.trunc(timeoutMs)
  if (n < 15_000) return 15_000
  if (n > 3_600_000) return 3_600_000
  return n
}

function tokenizeCronArg(raw: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return out
}
