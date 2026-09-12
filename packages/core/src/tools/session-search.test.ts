import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../session/memory-store'
import { createSqliteStore } from '../session/sqlite-store'
import type { SessionRecord, SessionStore, ToolContext, Turn } from '../types'
import { createSessionSearchTool } from './session-search'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTurn(over: Partial<Turn> = {}): Turn {
  return {
    id: 'turn_1',
    sessionId: 'sess_live',
    messages: [],
    round: 1,
    maxRounds: 80,
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

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_abcd1234',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'dummy',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

describe('SessionSearch', () => {
  test('parse requires query and accepts optional limit', () => {
    const tool = createSessionSearchTool(createMemoryStore())
    expect(tool.parse({ query: 'zebra' }).ok).toBe(true)
    expect(tool.parse({ query: 'zebra', limit: 3 }).ok).toBe(true)
    expect(tool.parse({}).ok).toBe(false)
    expect(tool.parse({ query: '' }).ok).toBe(false)
    expect(tool.parse({ query: 'zebra', limit: 0 }).ok).toBe(false)
  })

  test('is read-only and leftover-allow', async () => {
    const tool = createSessionSearchTool(createMemoryStore())
    expect(tool.isReadOnly({ query: 'x' })).toBe(true)
    expect(tool.isConcurrencySafe({ query: 'x' })).toBe(true)
    expect(await tool.checkPermissions({ query: 'x' }, makeCtx())).toEqual({
      behavior: 'allow',
      reason: 'mode',
    })
  })

  test('isEnabled is false on a memory store', () => {
    const tool = createSessionSearchTool(createMemoryStore())
    expect(tool.isEnabled?.(makeCtx())).toBe(false)
  })

  test('isEnabled is true when the store implements search', () => {
    const store = createMemoryStore() as SessionStore & {
      search: SessionStore['search']
    }
    store.search = () => []
    const tool = createSessionSearchTool(store)
    expect(tool.isEnabled?.(makeCtx())).toBe(true)
  })

  test('formats ranked sessionId[:8] messageId[:8] snippet lines', async () => {
    const store = createMemoryStore() as SessionStore & {
      search: NonNullable<SessionStore['search']>
    }
    store.search = () => [
      {
        sessionId: 'abcdefghij',
        messageId: '1234567890',
        snippet: 'hello\nworld  uniquezebra',
        rank: -1,
      },
    ]
    const tool = createSessionSearchTool(store)
    const out = await tool.execute({ query: 'uniquezebra' }, makeCtx({ sessionId: 'other' }))
    expect(out).toBe('abcdefgh 12345678 hello world uniquezebra')
  })

  test('sqlite store is enabled and returns cwd-scoped snippets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-session-search-'))
    tempDirs.push(dir)
    const store = createSqliteStore(join(dir, 'state.db')) as ReturnType<typeof createSqliteStore> & {
      close(): void
    }
    try {
      const tool = createSessionSearchTool(store)
      expect(tool.isEnabled?.(makeCtx({ cwd: dir }))).toBe(true)
      await store.createSession(session({ id: 'sess_abcd1234', cwd: dir }))
      await store.persistUser('sess_abcd1234', {
        id: 'msg_efgh5678',
        role: 'user',
        blocks: [{ type: 'text', text: 'uniquezebra from last week' }],
        createdAt: 1,
      })
      const out = await tool.execute(
        { query: 'uniquezebra' },
        makeCtx({ cwd: dir, sessionId: 'sess_live' }),
      )
      expect(out.startsWith('sess_abc msg_efgh ')).toBe(true)
      expect(out).toContain('uniquezebra')
    } finally {
      store.close()
    }
  })
})
