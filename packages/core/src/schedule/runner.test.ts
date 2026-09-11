import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fireDueJobs, formatCronList } from './runner'
import { CRON_RUNNING_LEASE_MS, createJsonCronStore } from './store'
import type { CronJob, CronLastFirePatch, CronStore } from './types'

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'c_abc',
    name: 'ping',
    enabled: true,
    cwd: '/tmp',
    prompt: 'say pong',
    schedule: { kind: 'every', everyMs: 30_000 },
    nextFireAt: 1,
    createdAt: 1,
    ...over,
  }
}

function applyPatch(row: CronJob, patch: CronLastFirePatch): CronJob {
  const updated: CronJob = {
    ...row,
    lastFireAt: patch.lastFireAt,
    lastStatus: patch.lastStatus,
  }
  delete updated.runningUntil
  if (patch.lastSessionId !== undefined) updated.lastSessionId = patch.lastSessionId
  if (patch.lastError !== undefined) updated.lastError = patch.lastError
  else delete updated.lastError
  return updated
}

function memory(jobs: CronJob[]): CronStore {
  const map = new Map(jobs.map((row) => [row.id, row]))
  return {
    list: () => [...map.values()],
    get: (id) => map.get(id),
    upsert(next) {
      map.set(next.id, next)
    },
    remove(id) {
      const row = map.get(id)
      map.delete(id)
      return row
    },
    claimDue(now) {
      const claimed: CronJob[] = []
      for (const row of [...map.values()]) {
        if (!row.enabled || row.nextFireAt > now) continue
        if (row.runningUntil !== undefined && row.runningUntil > now) {
          map.set(row.id, {
            ...row,
            nextFireAt: now + 30_000,
            lastFireAt: now,
            lastStatus: 'skipped',
          })
          continue
        }
        const updated = { ...row, nextFireAt: now + 30_000, runningUntil: now + CRON_RUNNING_LEASE_MS }
        map.set(row.id, updated)
        claimed.push(updated)
      }
      return claimed
    },
    patchLastFire(id, patch) {
      const current = map.get(id)
      if (!current) return undefined
      const updated = applyPatch(current, patch)
      map.set(id, updated)
      return updated
    },
  }
}

describe('fireDueJobs', () => {
  test('runs claimed jobs and records lastStatus', async () => {
    const store = memory([job()])
    const fired = await fireDueJobs({
      store,
      now: 10,
      async run() {
        return { ok: true, sessionId: 'sess_1' }
      },
    })
    expect(fired).toHaveLength(1)
    expect(fired[0]?.status).toBe('ok')
    expect(store.get('c_abc')?.lastSessionId).toBe('sess_1')
    expect(store.get('c_abc')?.lastStatus).toBe('ok')
    expect(store.get('c_abc')?.runningUntil).toBeUndefined()
  })

  test('run throw records error', async () => {
    const store = memory([job({ id: 'c_err' })])
    const fired = await fireDueJobs({
      store,
      now: 10,
      async run() {
        throw new Error('boom')
      },
    })
    expect(fired[0]?.status).toBe('error')
    expect(store.get('c_err')?.lastError).toBe('boom')
    expect(store.get('c_err')?.runningUntil).toBeUndefined()
  })

  test('deleted job is not resurrected after fire', async () => {
    const store = memory([job({ id: 'c_del' })])
    const fired = await fireDueJobs({
      store,
      now: 10,
      async run() {
        store.remove('c_del')
        return { ok: true, sessionId: 'sess_gone' }
      },
    })
    expect(fired[0]?.status).toBe('ok')
    expect(store.get('c_del')).toBeUndefined()
    expect(store.list()).toEqual([])
  })

  test('fire patches last* only and keeps current enabled nextFireAt and prompt', async () => {
    const store = memory([job({ nextFireAt: 10 })])
    const fired = await fireDueJobs({
      store,
      now: 10,
      async run() {
        const current = store.get('c_abc')
        expect(current?.runningUntil).toBe(10 + CRON_RUNNING_LEASE_MS)
        store.upsert({ ...current!, enabled: false, prompt: 'changed', nextFireAt: 99_000 })
        return { ok: true, sessionId: 's2' }
      },
    })
    expect(fired[0]?.status).toBe('ok')
    const saved = store.get('c_abc')
    expect(saved?.enabled).toBe(false)
    expect(saved?.prompt).toBe('changed')
    expect(saved?.nextFireAt).toBe(99_000)
    expect(saved?.lastStatus).toBe('ok')
    expect(saved?.lastSessionId).toBe('s2')
    expect(saved?.runningUntil).toBeUndefined()
  })

  test('json store delete during run does not resurrect', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-cron-run-'))
    try {
      const store = createJsonCronStore({ home })
      store.upsert(job({ id: 'c_json01', nextFireAt: 10 }))
      const fired = await fireDueJobs({
        store,
        now: 10,
        async run() {
          store.remove('c_json01')
          return { ok: false, error: 'late' }
        },
      })
      expect(fired[0]?.status).toBe('error')
      expect(store.get('c_json01')).toBeUndefined()
      expect(store.list()).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('json store patchLastFire after fire clears runningUntil', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-cron-run-'))
    try {
      const store = createJsonCronStore({ home })
      store.upsert(job({ id: 'c_json02', nextFireAt: 10, schedule: { kind: 'every', everyMs: 30_000 } }))
      const fired = await fireDueJobs({
        store,
        now: 10,
        async run() {
          expect(store.get('c_json02')?.runningUntil).toBe(10 + CRON_RUNNING_LEASE_MS)
          return { ok: true, sessionId: 'sess_json' }
        },
      })
      expect(fired[0]?.status).toBe('ok')
      expect(store.get('c_json02')?.runningUntil).toBeUndefined()
      expect(store.get('c_json02')?.nextFireAt).toBe(10 + 30_000)
      expect(store.get('c_json02')?.lastSessionId).toBe('sess_json')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('formatCronList', () => {
  test('empty and one line', () => {
    expect(formatCronList([])).toBe('no cron jobs')
    expect(formatCronList([job()])).toContain('c_abc')
    expect(formatCronList([job()])).toContain('on')
    expect(formatCronList([job()])).toContain('every 30s')
  })
})
