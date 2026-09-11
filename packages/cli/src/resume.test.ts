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
  exportCliSession,
  formatSessionMarkdown,
  parseTitleArg,
  resolveCliSessionId,
  showCliSession,
  titleCliSession,
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
      'abcdefgh  Fix login  1970-01-01T00:00:00.099Z',
    )
  })

  test('falls back to model when title is missing or empty', () => {
    expect(formatResumeSessionLine(session())).toBe(
      'abcdefgh  dummy-model  1970-01-01T00:00:00.099Z',
    )
    expect(formatResumeSessionLine(session({ title: '' }))).toBe(
      'abcdefgh  dummy-model  1970-01-01T00:00:00.099Z',
    )
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
    expect(shown.text).toContain('showid00  Demo  1970-01-01T00:00:00.005Z')
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

describe('exportCliSession', () => {
  test('writes markdown with full tool bodies', async () => {
    const home = join(tmpdir(), `raven-export-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    const store = createSqliteStore(join(home, 'state.db')) as ReturnType<
      typeof createSqliteStore
    > & { close(): void }
    const rec = session({ id: 'expid0001234', cwd: home, title: 'Export me', updatedAt: 5 })
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

    const exported = await exportCliSession('expid000', { home })
    expect(exported).toHaveProperty('text')
    if (!('text' in exported)) throw new Error('expected text')
    expect(exported.text).toContain('# Export me')
    expect(exported.text).toContain('## User')
    expect(exported.text).toContain('hello')
    expect(exported.text).toContain('## Assistant')
    expect(exported.text).toContain('hi there')
    expect(exported.text).toContain('1970-01-01T00:00:00.005Z')
  })

  test('formatSessionMarkdown includes a fenced tool body', () => {
    const md = formatSessionMarkdown(session({ title: 'T' }), [
      {
        id: 't1',
        role: 'tool',
        toolUseId: 'c1',
        ok: true,
        blocks: [{ type: 'text', text: 'x'.repeat(250) }],
        createdAt: 1,
      },
    ])
    expect(md).toContain('### Tool (ok)')
    expect(md).toContain('```')
    expect(md).toContain('x'.repeat(250))
  })
})

describe('titleCliSession', () => {
  test('parseTitleArg splits id and the rest of the line', () => {
    expect(parseTitleArg('abc Fix login')).toEqual({ id: 'abc', title: 'Fix login' })
    expect(parseTitleArg('abc')).toBeUndefined()
    expect(parseTitleArg('')).toBeUndefined()
  })

  test('updates the stored title', async () => {
    const home = join(tmpdir(), `raven-title-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    const store = createSqliteStore(join(home, 'state.db')) as ReturnType<
      typeof createSqliteStore
    > & { close(): void }
    await store.upsertSession(session({ id: 'titleid01234', cwd: home, title: 'Old' }))
    store.close()

    const result = await titleCliSession('titleid0 New name', { home })
    expect(result).toEqual({ id: 'titleid01234', title: 'New name' })
    const shown = await showCliSession('titleid0', { home })
    if (!('text' in shown)) throw new Error('expected text')
    expect(shown.text).toContain('New name')
    expect(shown.text).not.toContain('Old')
  })
})

describe('resolveCliSessionId', () => {
  test('resolves a prefix to the full id', async () => {
    const home = join(tmpdir(), `raven-resume-id-${Date.now()}`)
    mkdirSync(home, { recursive: true })
    const store = createSqliteStore(join(home, 'state.db')) as ReturnType<
      typeof createSqliteStore
    > & { close(): void }
    await store.upsertSession(session({ id: 'resumeid0123', cwd: home, title: 'R' }))
    store.close()
    expect(await resolveCliSessionId('resumeid', { home })).toBe('resumeid0123')
    expect(await resolveCliSessionId('nope', { home })).toEqual({
      error: 'session not found: nope',
    })
  })
})
