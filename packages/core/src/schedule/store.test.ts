import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CRON_RUNNING_LEASE_MS, cronJobsPath, createJsonCronStore, newCronId } from './store'
import {
  clampCronTimeoutMs,
  CRON_ID_PREFIX,
  DEFAULT_CRON_TIMEOUT_MS,
  MAX_CRON_TIMEOUT_MS,
  MIN_CRON_TIMEOUT_MS,
  type CronJob,
} from './types'

const ENV_KEY = 'RAVENCLAW_HOME'
let savedHome: string | undefined
const tempDirs: string[] = []

beforeEach(() => {
  savedHome = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (savedHome === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedHome
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-cron-'))
  tempDirs.push(dir)
  return dir
}

function makeJob(over: Partial<CronJob> = {}): CronJob {
  const job: CronJob = {
    id: over.id ?? 'c_aaa11111',
    name: over.name ?? 'job',
    enabled: over.enabled ?? true,
    cwd: over.cwd ?? '/tmp',
    prompt: over.prompt ?? 'do work',
    schedule: over.schedule ?? { kind: 'every', everyMs: 30_000 },
    nextFireAt: over.nextFireAt ?? 1_000,
    createdAt: over.createdAt ?? 1,
  }
  if (over.lastFireAt !== undefined) job.lastFireAt = over.lastFireAt
  if (over.lastStatus !== undefined) job.lastStatus = over.lastStatus
  if (over.lastError !== undefined) job.lastError = over.lastError
  if (over.lastSessionId !== undefined) job.lastSessionId = over.lastSessionId
  if (over.runningUntil !== undefined) job.runningUntil = over.runningUntil
  if (over.timeoutMs !== undefined) job.timeoutMs = over.timeoutMs
  if (over.skipMemory !== undefined) job.skipMemory = over.skipMemory
  if (over.preScript !== undefined) job.preScript = over.preScript
  if (over.verifyOnStop !== undefined) job.verifyOnStop = over.verifyOnStop
  return job
}

async function spawnClaimDue(home: string, now: number): Promise<number> {
  const modulePath = new URL('./store.ts', import.meta.url).href
  const proc = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { createJsonCronStore } from ${JSON.stringify(modulePath)}
const claimed = createJsonCronStore({ home: ${JSON.stringify(home)} }).claimDue(${now})
process.stdout.write(String(claimed.length))`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(stderr || `child exited ${code}`)
  return Number(stdout)
}

async function spawnUpsert(home: string, job: CronJob): Promise<void> {
  const modulePath = new URL('./store.ts', import.meta.url).href
  const proc = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { createJsonCronStore } from ${JSON.stringify(modulePath)}
createJsonCronStore({ home: ${JSON.stringify(home)} }).upsert(${JSON.stringify(job)})
process.stdout.write('1')`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(stderr || `child exited ${code}`)
}

async function spawnRemove(home: string, id: string): Promise<void> {
  const modulePath = new URL('./store.ts', import.meta.url).href
  const proc = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { createJsonCronStore } from ${JSON.stringify(modulePath)}
createJsonCronStore({ home: ${JSON.stringify(home)} }).remove(${JSON.stringify(id)})
process.stdout.write('1')`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(stderr || `child exited ${code}`)
}

describe('cronJobsPath', () => {
  test('joins home/cron/jobs.json', () => {
    expect(cronJobsPath('/tmp/rc-home')).toBe(join('/tmp/rc-home', 'cron', 'jobs.json'))
  })

  test('defaults to RAVENCLAW_HOME', () => {
    const home = tempHome()
    process.env[ENV_KEY] = home
    expect(cronJobsPath()).toBe(join(home, 'cron', 'jobs.json'))
  })
})

describe('newCronId', () => {
  test('is c_ plus 8 hex', () => {
    const id = newCronId()
    expect(id.startsWith(CRON_ID_PREFIX)).toBe(true)
    expect(id).toMatch(/^c_[0-9a-f]{8}$/)
    expect(newCronId()).not.toBe(id)
  })
})

describe('createJsonCronStore', () => {
  test('upsert list get and remove persist pretty JSON', () => {
    const home = tempHome()
    const store = createJsonCronStore({ home })
    const first = makeJob({ id: 'c_one00001', name: 'one', lastStatus: 'error' })
    const second = makeJob({ id: 'c_two00002', name: 'two', nextFireAt: 2_000 })

    expect(store.list()).toEqual([])
    expect(store.get('c_one00001')).toBeUndefined()
    expect(store.remove('missing')).toBeUndefined()

    store.upsert(first)
    store.upsert(second)
    store.upsert(makeJob({ id: 'c_one00001', name: 'one-updated', lastStatus: 'error' }))

    expect(store.list().map((job) => job.id)).toEqual(['c_one00001', 'c_two00002'])
    expect(store.get('c_one00001')?.name).toBe('one-updated')
    expect(existsSync(join(home, 'cron'))).toBe(true)

    const path = cronJobsPath(home)
    const raw = readFileSync(path, 'utf8')
    expect(raw.startsWith('{\n  "jobs": [')).toBe(true)
    const parsed = JSON.parse(raw) as { jobs: CronJob[] }
    expect(parsed.jobs).toHaveLength(2)
    expect(parsed.jobs[0]?.name).toBe('one-updated')

    const removed = store.remove('c_two00002')
    expect(removed?.id).toBe('c_two00002')
    expect(store.list()).toHaveLength(1)
    expect(store.get('c_two00002')).toBeUndefined()
  })

  test('createJsonCronStore uses ravenclawHome when opts.home is omitted', () => {
    const home = tempHome()
    process.env[ENV_KEY] = home
    const store = createJsonCronStore()
    store.upsert(makeJob())
    expect(existsSync(join(home, 'cron', 'jobs.json'))).toBe(true)
  })

  test('claimDue advances nextFireAt and a second claim is empty', () => {
    const home = tempHome()
    const store = createJsonCronStore({ home })
    const now = 10_000
    store.upsert(
      makeJob({
        id: 'c_due00001',
        schedule: { kind: 'every', everyMs: 30_000 },
        nextFireAt: now,
        lastStatus: 'error',
        lastError: 'boom',
      }),
    )
    store.upsert(
      makeJob({
        id: 'c_off00002',
        enabled: false,
        nextFireAt: now,
      }),
    )
    store.upsert(
      makeJob({
        id: 'c_later003',
        nextFireAt: now + 1,
      }),
    )

    const claimed = store.claimDue(now)
    expect(claimed.map((job) => job.id)).toEqual(['c_due00001'])
    expect(claimed[0]?.nextFireAt).toBe(now + 30_000)
    expect(claimed[0]?.lastStatus).toBe('error')
    expect(claimed[0]?.lastError).toBe('boom')
    expect(claimed[0]?.runningUntil).toBe(now + CRON_RUNNING_LEASE_MS)

    const persisted = store.get('c_due00001')
    expect(persisted?.nextFireAt).toBe(now + 30_000)
    expect(persisted?.lastStatus).toBe('error')
    expect(persisted?.runningUntil).toBe(now + CRON_RUNNING_LEASE_MS)
    expect(store.get('c_off00002')?.nextFireAt).toBe(now)
    expect(store.get('c_later003')?.nextFireAt).toBe(now + 1)

    expect(store.claimDue(now)).toEqual([])
    expect(store.get('c_due00001')?.nextFireAt).toBe(now + 30_000)
  })

  test('overlapping claimDue lock serializes so only one claims', async () => {
    const home = tempHome()
    const now = 50_000
    createJsonCronStore({ home }).upsert(
      makeJob({
        id: 'c_lock0001',
        schedule: { kind: 'every', everyMs: 15_000 },
        nextFireAt: now,
      }),
    )

    const counts = await Promise.all([spawnClaimDue(home, now), spawnClaimDue(home, now)])
    expect(counts.sort()).toEqual([0, 1])
    expect(createJsonCronStore({ home }).get('c_lock0001')?.nextFireAt).toBe(now + 15_000)
  })

  test('claimDue waits for a short-lived lock then claims', async () => {
    const home = tempHome()
    const now = 70_000
    const store = createJsonCronStore({ home })
    store.upsert(makeJob({ id: 'c_wait0001', nextFireAt: now, schedule: { kind: 'every', everyMs: 15_000 } }))
    const lockDir = `${cronJobsPath(home)}.lock`
    mkdirSync(lockDir)

    const pending = spawnClaimDue(home, now)
    await Bun.sleep(40)
    rmdirSync(lockDir)
    expect(await pending).toBe(1)
    expect(store.get('c_wait0001')?.nextFireAt).toBe(now + 15_000)
  })

  test('claimDue fails after ~200ms if the lock is held', () => {
    const home = tempHome()
    const store = createJsonCronStore({ home })
    store.upsert(makeJob({ nextFireAt: 1 }))
    const lockDir = `${cronJobsPath(home)}.lock`
    mkdirSync(lockDir)
    const started = Date.now()
    expect(() => store.claimDue(1)).toThrow(/cron lock/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(store.get('c_aaa11111')?.nextFireAt).toBe(1)
  })

  test('upsert fails after ~200ms if the lock is held', () => {
    const home = tempHome()
    const store = createJsonCronStore({ home })
    store.upsert(makeJob({ nextFireAt: 1 }))
    const lockDir = `${cronJobsPath(home)}.lock`
    mkdirSync(lockDir)
    const started = Date.now()
    expect(() => store.upsert(makeJob({ nextFireAt: 2, name: 'stale' }))).toThrow(/cron lock/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(store.get('c_aaa11111')?.nextFireAt).toBe(1)
    expect(store.get('c_aaa11111')?.name).toBe('job')
  })

  test('remove fails after ~200ms if the lock is held', () => {
    const home = tempHome()
    const store = createJsonCronStore({ home })
    store.upsert(makeJob({ nextFireAt: 1 }))
    const lockDir = `${cronJobsPath(home)}.lock`
    mkdirSync(lockDir)
    const started = Date.now()
    expect(() => store.remove('c_aaa11111')).toThrow(/cron lock/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(store.get('c_aaa11111')?.id).toBe('c_aaa11111')
  })

  test('overlapping claimDue and upsert keep the claimed nextFireAt', async () => {
    const home = tempHome()
    const now = 90_000
    const due = makeJob({
      id: 'c_due00009',
      schedule: { kind: 'every', everyMs: 15_000 },
      nextFireAt: now,
    })
    const extra = makeJob({
      id: 'c_extra000',
      nextFireAt: now + 99_000,
    })
    createJsonCronStore({ home }).upsert(due)

    await Promise.all([spawnClaimDue(home, now), spawnUpsert(home, extra)])

    const store = createJsonCronStore({ home })
    expect(store.get('c_due00009')?.nextFireAt).toBe(now + 15_000)
    expect(store.get('c_extra000')?.id).toBe('c_extra000')
  })

  test('overlapping claimDue and remove keep the claimed nextFireAt', async () => {
    const home = tempHome()
    const now = 91_000
    const store = createJsonCronStore({ home })
    store.upsert(
      makeJob({
        id: 'c_due00010',
        schedule: { kind: 'every', everyMs: 15_000 },
        nextFireAt: now,
      }),
    )
    store.upsert(makeJob({ id: 'c_extra001', nextFireAt: now + 99_000 }))

    await Promise.all([spawnClaimDue(home, now), spawnRemove(home, 'c_extra001')])

    expect(store.get('c_due00010')?.nextFireAt).toBe(now + 15_000)
    expect(store.get('c_extra001')).toBeUndefined()
  })

  test('claimDue skips a due job that is still running and advances nextFireAt', () => {
    const home = tempHome()
    const store = createJsonCronStore({ home })
    const now = 80_000
    store.upsert(
      makeJob({
        id: 'c_run00001',
        schedule: { kind: 'every', everyMs: 15_000 },
        nextFireAt: now,
        runningUntil: now + 1,
        lastStatus: 'ok',
      }),
    )

    expect(store.claimDue(now)).toEqual([])
    const persisted = store.get('c_run00001')
    expect(persisted?.nextFireAt).toBe(now + 15_000)
    expect(persisted?.lastStatus).toBe('skipped')
    expect(persisted?.lastFireAt).toBe(now)
    expect(persisted?.runningUntil).toBe(now + 1)
  })

  test('claimDue claims a due job whose runningUntil lease has expired', () => {
    const home = tempHome()
    const store = createJsonCronStore({ home })
    const now = 81_000
    store.upsert(
      makeJob({
        id: 'c_exp00001',
        schedule: { kind: 'every', everyMs: 15_000 },
        nextFireAt: now,
        runningUntil: now,
      }),
    )

    const claimed = store.claimDue(now)
    expect(claimed.map((job) => job.id)).toEqual(['c_exp00001'])
    expect(claimed[0]?.runningUntil).toBe(now + CRON_RUNNING_LEASE_MS)
    expect(store.get('c_exp00001')?.runningUntil).toBe(now + CRON_RUNNING_LEASE_MS)
  })

  test('patchLastFire does not rewind nextFireAt or re-enable', () => {
    const home = tempHome()
    const store = createJsonCronStore({ home })
    const now = 82_000
    store.upsert(
      makeJob({
        id: 'c_patch001',
        enabled: true,
        prompt: 'old',
        schedule: { kind: 'every', everyMs: 30_000 },
        nextFireAt: now,
      }),
    )

    const claimed = store.claimDue(now)
    expect(claimed[0]?.nextFireAt).toBe(now + 30_000)
    expect(claimed[0]?.runningUntil).toBe(now + CRON_RUNNING_LEASE_MS)

    const current = store.get('c_patch001')
    expect(current).toBeDefined()
    store.upsert({ ...current!, enabled: false, prompt: 'new' })

    const patched = store.patchLastFire('c_patch001', {
      lastFireAt: now,
      lastStatus: 'ok',
      lastSessionId: 'sess_1',
    })
    expect(patched?.enabled).toBe(false)
    expect(patched?.prompt).toBe('new')
    expect(patched?.nextFireAt).toBe(now + 30_000)
    expect(patched?.lastStatus).toBe('ok')
    expect(patched?.lastSessionId).toBe('sess_1')
    expect(patched?.runningUntil).toBeUndefined()
    expect(store.get('c_patch001')?.enabled).toBe(false)
    expect(store.get('c_patch001')?.nextFireAt).toBe(now + 30_000)
    expect(store.get('c_patch001')?.runningUntil).toBeUndefined()
  })

  test('patchLastFire does not resurrect a deleted job', () => {
    const home = tempHome()
    const store = createJsonCronStore({ home })
    expect(
      store.patchLastFire('c_missing1', { lastFireAt: 1, lastStatus: 'ok' }),
    ).toBeUndefined()
    expect(store.list()).toEqual([])
  })

  test('patchLastFire clears runningUntil after a claimed run', () => {
    const home = tempHome()
    const store = createJsonCronStore({ home })
    const now = 83_000
    store.upsert(
      makeJob({
        id: 'c_lease001',
        schedule: { kind: 'every', everyMs: 15_000 },
        nextFireAt: now,
        lastError: 'old',
      }),
    )
    expect(store.claimDue(now)[0]?.runningUntil).toBe(now + CRON_RUNNING_LEASE_MS)

    const patched = store.patchLastFire('c_lease001', { lastFireAt: now, lastStatus: 'error', lastError: 'boom' })
    expect(patched?.runningUntil).toBeUndefined()
    expect(patched?.lastStatus).toBe('error')
    expect(patched?.lastError).toBe('boom')
    expect(patched?.nextFireAt).toBe(now + 15_000)
    expect(store.get('c_lease001')?.runningUntil).toBeUndefined()
  })

  test('upsert/load preserves timeoutMs skipMemory preScript verifyOnStop', () => {
    const home = tempHome()
    const store = createJsonCronStore({ home })
    store.upsert(
      makeJob({
        id: 'c_opts0001',
        timeoutMs: 45_000,
        skipMemory: true,
        preScript: 'git status',
        verifyOnStop: true,
      }),
    )

    const loaded = store.get('c_opts0001')
    expect(loaded?.timeoutMs).toBe(45_000)
    expect(loaded?.skipMemory).toBe(true)
    expect(loaded?.preScript).toBe('git status')
    expect(loaded?.verifyOnStop).toBe(true)

    const raw = JSON.parse(readFileSync(cronJobsPath(home), 'utf8')) as { jobs: CronJob[] }
    expect(raw.jobs[0]?.timeoutMs).toBe(45_000)
    expect(raw.jobs[0]?.skipMemory).toBe(true)
    expect(raw.jobs[0]?.preScript).toBe('git status')
    expect(raw.jobs[0]?.verifyOnStop).toBe(true)

    const relisted = createJsonCronStore({ home }).get('c_opts0001')
    expect(relisted?.timeoutMs).toBe(45_000)
    expect(relisted?.skipMemory).toBe(true)
    expect(relisted?.preScript).toBe('git status')
    expect(relisted?.verifyOnStop).toBe(true)
  })

  test('old jobs without new fields stay valid', () => {
    const home = tempHome()
    const store = createJsonCronStore({ home })
    store.upsert(makeJob({ id: 'c_old00001' }))
    const loaded = store.get('c_old00001')
    expect(loaded?.timeoutMs).toBeUndefined()
    expect(loaded?.skipMemory).toBeUndefined()
    expect(loaded?.preScript).toBeUndefined()
    expect(loaded?.verifyOnStop).toBeUndefined()
    expect(loaded?.prompt).toBe('do work')
  })
})

describe('clampCronTimeoutMs', () => {
  test('defaults and clamps to the allowed window', () => {
    expect(clampCronTimeoutMs()).toBe(DEFAULT_CRON_TIMEOUT_MS)
    expect(clampCronTimeoutMs(Number.NaN)).toBe(DEFAULT_CRON_TIMEOUT_MS)
    expect(clampCronTimeoutMs(1)).toBe(MIN_CRON_TIMEOUT_MS)
    expect(clampCronTimeoutMs(9_999_999)).toBe(MAX_CRON_TIMEOUT_MS)
    expect(clampCronTimeoutMs(45_000)).toBe(45_000)
  })
})
