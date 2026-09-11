import { describe, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { decidePermission } from '../permissions/pipeline'
import { MIN_INTERVAL_MS, type CronJob, type CronStore, type JobSchedule } from '../schedule/types'
import type { ToolContext, Turn } from '../types'

const cronParserPath = join(import.meta.dir, '../schedule/cron.ts')
const hasCronParser = existsSync(cronParserPath)

if (!hasCronParser) {
  mock.module('../schedule/cron', () => ({
    parseJobSpec: parseJobSpecForTest,
    nextFireAt: nextFireAtForTest,
    formatSchedule: formatScheduleForTest,
  }))
}

const { createCronTools } = await import('./cron')

const emptyRules = { session: [], user: [], project: [] }

function memoryStore(): CronStore {
  const jobs = new Map<string, CronJob>()
  return {
    list: () => [...jobs.values()],
    get: (id) => jobs.get(id),
    upsert: (job) => {
      jobs.set(job.id, job)
    },
    remove: (id) => {
      const j = jobs.get(id)
      jobs.delete(id)
      return j
    },
    claimDue: () => [],
  }
}

function parseJobSpecForTest(spec: string): JobSchedule {
  const trimmed = spec.trim()
  if (trimmed === '@hourly') return { kind: 'cron', expr: '0 * * * *' }
  if (trimmed === '@daily') return { kind: 'cron', expr: '0 0 * * *' }
  const every = /^every\s+(\d+)\s*(s|m|h)$/i.exec(trimmed)
  if (every) {
    const n = Number(every[1])
    const unit = every[2]!.toLowerCase()
    const everyMs = unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : n * 1_000
    if (everyMs < MIN_INTERVAL_MS) throw new Error(`interval must be at least ${MIN_INTERVAL_MS}ms`)
    return { kind: 'every', everyMs }
  }
  const fields = trimmed.split(/\s+/)
  if (fields.length === 5) return { kind: 'cron', expr: trimmed }
  throw new Error('invalid spec')
}

function nextFireAtForTest(schedule: JobSchedule, now: number): number {
  if (schedule.kind === 'every') return now + schedule.everyMs
  return now + 60_000
}

function formatScheduleForTest(schedule: JobSchedule): string {
  if (schedule.kind === 'cron') return schedule.expr
  if (schedule.everyMs % 3_600_000 === 0) return `every ${schedule.everyMs / 3_600_000}h`
  if (schedule.everyMs % 60_000 === 0) return `every ${schedule.everyMs / 60_000}m`
  if (schedule.everyMs % 1_000 === 0) return `every ${schedule.everyMs / 1_000}s`
  return `every ${schedule.everyMs}ms`
}

function makeTurn(over: Partial<Turn> = {}): Turn {
  return {
    id: 't',
    sessionId: 's',
    messages: [],
    round: 1,
    maxRounds: 8,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd: '/tmp',
    model: 'dummy',
    readFiles: new Set(),
    ...over,
  }
}

function makeCtx(over: Partial<Turn> = {}): ToolContext {
  const turn = makeTurn(over)
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

function sampleJob(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'c_abc12345',
    name: 'sample',
    enabled: true,
    cwd: '/tmp',
    prompt: 'run tests',
    schedule: { kind: 'every', everyMs: 30 * 60_000 },
    nextFireAt: Date.now() + 30 * 60_000,
    createdAt: Date.now(),
    ...over,
  }
}

describe('createCronTools', () => {
  test('names, flags, leftover-ask, and dontAsk via decidePermission', async () => {
    const { create, list, remove, setEnabled } = createCronTools(memoryStore())
    const ctx = makeCtx()

    expect(create.name).toBe('CronCreate')
    expect(list.name).toBe('CronList')
    expect(remove.name).toBe('CronDelete')
    expect(setEnabled.name).toBe('CronSetEnabled')

    expect(create.isReadOnly({ spec: 'every 30m', prompt: 'x' })).toBe(false)
    expect(create.isConcurrencySafe({ spec: 'every 30m', prompt: 'x' })).toBe(false)
    expect(list.isReadOnly({})).toBe(true)
    expect(list.isConcurrencySafe({})).toBe(true)
    expect(remove.isReadOnly({ id: 'c_x' })).toBe(false)
    expect(setEnabled.isReadOnly({ id: 'c_x', enabled: false })).toBe(false)

    const createAsk = await create.checkPermissions({ spec: 'every 30m', prompt: 'x' }, ctx)
    expect(createAsk.behavior).toBe('ask')
    if (createAsk.behavior === 'ask') {
      expect(createAsk.message.length).toBeGreaterThan(0)
      expect(createAsk.saveAs).toBe('session')
    }

    const deleteAsk = await remove.checkPermissions({ id: 'c_x' }, ctx)
    expect(deleteAsk.behavior).toBe('ask')
    if (deleteAsk.behavior === 'ask') {
      expect(deleteAsk.message.length).toBeGreaterThan(0)
      expect(deleteAsk.saveAs).toBe('session')
    }

    const setAsk = await setEnabled.checkPermissions({ id: 'c_x', enabled: true }, ctx)
    expect(setAsk.behavior).toBe('ask')
    if (setAsk.behavior === 'ask') {
      expect(setAsk.message.length).toBeGreaterThan(0)
      expect(setAsk.saveAs).toBe('session')
    }

    expect(await list.checkPermissions({}, ctx)).toEqual({ behavior: 'allow', reason: 'mode' })

    const listDontAsk = await decidePermission({
      name: 'CronList',
      input: {},
      tool: list,
      ctx,
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(listDontAsk.behavior).toBe('allow')

    const createDontAsk = await decidePermission({
      name: 'CronCreate',
      input: { spec: 'every 30m', prompt: 'x' },
      tool: create,
      ctx,
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(createDontAsk.behavior).toBe('deny')
    if (createDontAsk.behavior === 'deny') expect(createDontAsk.reason).toBe('mode')

    const deleteDontAsk = await decidePermission({
      name: 'CronDelete',
      input: { id: 'c_x' },
      tool: remove,
      ctx,
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(deleteDontAsk.behavior).toBe('deny')

    const setDontAsk = await decidePermission({
      name: 'CronSetEnabled',
      input: { id: 'c_x', enabled: false },
      tool: setEnabled,
      ctx,
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(setDontAsk.behavior).toBe('deny')

    const leftover = await decidePermission({
      name: 'CronCreate',
      input: { spec: 'every 30m', prompt: 'x' },
      tool: create,
      ctx,
      mode: 'default',
      rules: emptyRules,
    })
    expect(leftover.behavior).toBe('ask')
    if (leftover.behavior === 'ask') expect(leftover.saveAs).toBe('session')
  })

  test('parse accepts the documented inputs', () => {
    const { create, list, remove, setEnabled } = createCronTools(memoryStore())
    expect(create.parse({ spec: 'every 30m', prompt: 'run tests' }).ok).toBe(true)
    expect(create.parse({ spec: 'every 30m', prompt: 'run tests', name: 'ci' }).ok).toBe(true)
    expect(create.parse({ spec: 'every 30m' }).ok).toBe(false)
    expect(create.parse({ prompt: 'run tests' }).ok).toBe(false)
    expect(list.parse({}).ok).toBe(true)
    expect(remove.parse({ id: 'c_abc' }).ok).toBe(true)
    expect(remove.parse({}).ok).toBe(false)
    expect(setEnabled.parse({ id: 'c_abc', enabled: false }).ok).toBe(true)
    expect(setEnabled.parse({ id: 'c_abc' }).ok).toBe(false)
  })

  test('list renders id, on/off, schedule, and prompt', async () => {
    const store = memoryStore()
    store.upsert(sampleJob())
    store.upsert(
      sampleJob({
        id: 'c_off00001',
        enabled: false,
        prompt: 'nightly',
        schedule: { kind: 'cron', expr: '0 0 * * *' },
      }),
    )
    const { list } = createCronTools(store)
    const out = await list.execute({}, makeCtx())
    expect(out).toContain('c_abc12345  on  every 30m  run tests')
    expect(out).toContain('c_off00001  off  0 0 * * *  nightly')
  })

  test('list is empty when the store has no jobs', async () => {
    const { list } = createCronTools(memoryStore())
    expect(await list.execute({}, makeCtx())).toBe('no jobs')
  })

  test('delete removes a job and fails on unknown ids', async () => {
    const store = memoryStore()
    store.upsert(sampleJob({ id: 'c_del00001' }))
    const { remove } = createCronTools(store)
    const ctx = makeCtx()
    expect(await remove.execute({ id: 'c_missing' }, ctx)).toContain('unknown job')
    expect(await remove.execute({ id: 'c_del00001' }, ctx)).toContain('deleted')
    expect(store.get('c_del00001')).toBeUndefined()
  })

  test('setEnabled toggles a job and fails on unknown ids', async () => {
    const store = memoryStore()
    store.upsert(sampleJob({ id: 'c_en000001' }))
    const { setEnabled } = createCronTools(store)
    const ctx = makeCtx()
    expect(await setEnabled.execute({ id: 'c_missing', enabled: false }, ctx)).toContain('unknown job')
    expect(await setEnabled.execute({ id: 'c_en000001', enabled: false }, ctx)).toContain('disabled')
    expect(store.get('c_en000001')?.enabled).toBe(false)
    expect(await setEnabled.execute({ id: 'c_en000001', enabled: true }, ctx)).toContain('enabled')
    expect(store.get('c_en000001')?.enabled).toBe(true)
  })

  test.skipIf(!hasCronParser)('create parses spec, uses projectCwd, and writes nextFireAt', async () => {
    const store = memoryStore()
    const { create, list } = createCronTools(store)
    const before = Date.now()
    const out = await create.execute(
      { spec: 'every 30m', prompt: 'run tests', name: 'ci' },
      makeCtx({ cwd: '/tmp/worktree', projectCwd: '/tmp/project' }),
    )
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(store.list()).toHaveLength(1)
    const job = store.list()[0]!
    expect(job.id.startsWith('c_')).toBe(true)
    expect(job.id.length).toBe(10)
    expect(job.name).toBe('ci')
    expect(job.enabled).toBe(true)
    expect(job.cwd).toBe('/tmp/project')
    expect(job.prompt).toBe('run tests')
    expect(job.schedule).toEqual({ kind: 'every', everyMs: 30 * 60_000 })
    expect(job.nextFireAt).toBeGreaterThanOrEqual(before)
    expect(job.nextFireAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1_000)
    const listed = await list.execute({}, makeCtx())
    expect(listed).toContain(`${job.id}  on  every 30m  run tests`)

    const bad = await create.execute({ spec: 'every 1s', prompt: 'too soon' }, makeCtx())
    expect(bad).toContain('CronCreate failed')
  })
})
