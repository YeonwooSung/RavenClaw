import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore, createSqliteStore, type MessageSearchHit } from '@ravenclaw/core'
import { formatSearchNotice, searchNotice } from './search'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-search-cli-'))
  tempDirs.push(dir)
  return join(dir, 'state.db')
}

function hit(over: Partial<MessageSearchHit> = {}): MessageSearchHit {
  return {
    sessionId: 'abcdefghij',
    messageId: 'm1',
    snippet: 'hello world',
    rank: 1,
    ...over,
  }
}

describe('formatSearchNotice', () => {
  test('empty hits is no matches', () => {
    expect(formatSearchNotice([])).toBe('no matches')
  })

  test('lists sessionId[:8] and a single-line snippet, not raw JSON', () => {
    const text = formatSearchNotice([
      hit({ sessionId: 'sess123456', snippet: 'first\nline  with   spaces' }),
      hit({ sessionId: 'other7890', messageId: 'm2', snippet: 'second' }),
    ])
    expect(text).toBe('sess1234  first line with spaces\nother789  second')
    expect(text).not.toContain('{')
    expect(text).not.toContain('messageId')
  })

  test('caps at 8 hits', () => {
    const hits = Array.from({ length: 10 }, (_, i) =>
      hit({ sessionId: `session${i}`, messageId: `m${i}`, snippet: `hit${i}` }),
    )
    const lines = formatSearchNotice(hits).split('\n')
    expect(lines).toHaveLength(8)
    expect(lines[0]).toBe('session0  hit0')
    expect(lines[7]).toBe('session7  hit7')
  })
})

describe('searchNotice', () => {
  test('missing query is usage', () => {
    const store = createMemoryStore()
    expect(searchNotice({ store, sessionId: 's1' })).toBe('usage: /search <query>')
    expect(searchNotice({ store, arg: '   ', sessionId: 's1' })).toBe(
      'usage: /search <query>',
    )
    expect(searchNotice({ store, arg: '--all ', sessionId: 's1' })).toBe(
      'usage: /search <query>',
    )
  })

  test('memory store and empty sqlite results are no matches', async () => {
    expect(
      searchNotice({ store: createMemoryStore(), arg: 'foo', sessionId: 's1' }),
    ).toBe('no matches')

    const store = createSqliteStore(tempDbPath())
    try {
      await store.createSession({
        id: 's1',
        createdAt: 1,
        updatedAt: 1,
        cwd: '/tmp',
        model: 'dummy',
        permissionMode: 'default',
        compactGeneration: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        funding: 'byok',
      })
      expect(searchNotice({ store, arg: 'missingtoken', sessionId: 's1' })).toBe(
        'no matches',
      )
    } finally {
      ;(store as { close(): void }).close()
    }
  })

  test('defaults to current session and --all searches every session', async () => {
    const store = createSqliteStore(tempDbPath())
    try {
      await store.createSession({
        id: 'currentsession',
        createdAt: 1,
        updatedAt: 1,
        cwd: '/tmp',
        model: 'dummy',
        permissionMode: 'default',
        compactGeneration: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        funding: 'byok',
      })
      await store.createSession({
        id: 'othersessionx',
        createdAt: 2,
        updatedAt: 2,
        cwd: '/tmp',
        model: 'dummy',
        permissionMode: 'default',
        compactGeneration: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        funding: 'byok',
      })
      await store.persistUser('currentsession', {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'sharedtoken in current' }],
        createdAt: 1,
      })
      await store.persistUser('othersessionx', {
        id: 'u2',
        role: 'user',
        blocks: [{ type: 'text', text: 'sharedtoken in other' }],
        createdAt: 2,
      })

      expect(
        searchNotice({ store, arg: 'sharedtoken', sessionId: 'currentsession' }),
      ).toBe('currents  sharedtoken in current')

      const all = searchNotice({
        store,
        arg: '--all sharedtoken',
        sessionId: 'currentsession',
      })
      expect(all.split('\n')).toHaveLength(2)
      expect(all).toContain('currents  sharedtoken in current')
      expect(all).toContain('otherses  sharedtoken in other')
    } finally {
      ;(store as { close(): void }).close()
    }
  })
})
