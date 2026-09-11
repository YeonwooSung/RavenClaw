import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteStore, type SessionRecord } from '@ravenclaw/core'
import {
  formatMessageLine,
  formatResumeSessionLine,
  listCliSessions,
  deleteCliSession,
  showCliSession,
} from './resume'

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

describe('showCliSession', () => {
  test('prints header and messages; accepts an 8-char prefix', async () => {
    const home = join(tmpdir(), `raven-show-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    const store = createSqliteStore(join(home, 'state.db')) as ReturnType<
      typeof createSqliteStore
    > & { close(): void }
    const rec = session({ id: 'showid001234', cwd: home, title: 'Demo', updatedAt: 5 })
    await store.upsertSession(rec)
    await store.persistUser(rec.id, {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      createdAt: 1,
    })
    await store.persistAssistant(rec.id, {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hi there' }],
      createdAt: 2,
    })
    store.close()

    const shown = await showCliSession('showid00', { home })
    expect(shown).toHaveProperty('text')
    if (!('text' in shown)) throw new Error('expected text')
    expect(shown.text).toContain('showid00  Demo  5')
    expect(shown.text).toContain('user: hello')
    expect(shown.text).toContain('assistant: hi there')
  })

  test('missing id is an error', async () => {
    const home = join(tmpdir(), `raven-show-miss-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    expect(await showCliSession('nope', { home })).toEqual({
      error: 'session not found: nope',
    })
  })

  test('formatMessageLine clips long tool output', () => {
    const line = formatMessageLine({
      id: 't1',
      role: 'tool',
      toolUseId: 'c1',
      ok: true,
      blocks: [{ type: 'text', text: 'x'.repeat(250) }],
      createdAt: 1,
    })
    expect(line.startsWith('tool(ok): ')).toBe(true)
    expect(line.endsWith('…')).toBe(true)
    expect(line.length).toBeLessThan(220)
  })
})

describe('deleteCliSession', () => {
  test('removes a session so show cannot find it', async () => {
    const home = join(tmpdir(), `raven-rm-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    const store = createSqliteStore(join(home, 'state.db')) as ReturnType<
      typeof createSqliteStore
    > & { close(): void }
    const rec = session({ id: 'rmid00001234', cwd: home, title: 'Gone' })
    await store.upsertSession(rec)
    store.close()

    const deleted = await deleteCliSession('rmid0000', { home })
    expect(deleted).toEqual({ id: 'rmid00001234' })
    expect(await showCliSession('rmid0000', { home })).toEqual({
      error: 'session not found: rmid0000',
    })
  })
})
