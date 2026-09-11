import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteStore, type SessionRecord } from '@ravenclaw/core'
import { formatResumeSessionLine, listCliSessions } from './resume'

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'abcdefghijklmnop',
    createdAt: 1,
    updatedAt: 99,
    cwd: '/tmp',
    model: 'dummy-model',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

describe('formatResumeSessionLine', () => {
  test('uses title when present', () => {
    expect(formatResumeSessionLine(session({ title: 'Fix login' }))).toBe(
      'abcdefgh  Fix login  99',
    )
  })

  test('falls back to model when title is missing or empty', () => {
    expect(formatResumeSessionLine(session())).toBe('abcdefgh  dummy-model  99')
    expect(formatResumeSessionLine(session({ title: '' }))).toBe('abcdefgh  dummy-model  99')
  })
})

describe('listCliSessions', () => {
  test('lists top-level sessions for cwd and skips children', async () => {
    const home = join(tmpdir(), `raven-sessions-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    const cwd = join(home, 'proj')
    mkdirSync(cwd)
    const store = createSqliteStore(join(home, 'state.db')) as ReturnType<
      typeof createSqliteStore
    > & { close(): void }
    const parent = session({ id: 'parent0001', cwd, title: 'Parent', updatedAt: 200 })
    const child = session({
      id: 'child00001',
      cwd,
      title: 'Child',
      parentSessionId: parent.id,
      updatedAt: 300,
    })
    const other = session({ id: 'other00001', cwd: join(home, 'else'), title: 'Other', updatedAt: 400 })
    await store.upsertSession(parent)
    await store.upsertSession(child)
    await store.upsertSession(other)
    store.close()

    const rows = await listCliSessions({ home, cwd, limit: 20 })
    expect(rows.map((row) => row.id)).toEqual(['parent0001'])
  })

  test('empty home yields no sessions', async () => {
    const home = join(tmpdir(), `raven-sessions-empty-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    expect(await listCliSessions({ home, cwd: home })).toEqual([])
  })
})
