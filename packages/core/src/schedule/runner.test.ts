import { describe, expect, test } from 'bun:test'
import { fireDueJobs, formatCronList } from './runner'
import type { CronJob, CronStore } from './types'

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
      for (const row of map.values()) {
        if (!row.enabled || row.nextFireAt > now) continue
        const updated = { ...row, nextFireAt: now + 30_000 }
        map.set(row.id, updated)
        claimed.push(updated)
      }
      return claimed
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
