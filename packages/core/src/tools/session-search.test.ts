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
  test('parse accepts query, sessionId, aroundMessageId, and optional limit', () => {
    const tool = createSessionSearchTool(createMemoryStore())
    expect(tool.parse({ query: 'zebra' }).ok).toBe(true)
    expect(tool.parse({ query: 'zebra', limit: 3 }).ok).toBe(true)
    expect(tool.parse({}).ok).toBe(true)
    expect(tool.parse({ sessionId: 'sess_abcd' }).ok).toBe(true)
    expect(tool.parse({ sessionId: 'sess_abcd', aroundMessageId: 'msg_1' }).ok).toBe(true)
    expect(tool.parse({ query: '' }).ok).toBe(false)
    expect(tool.parse({ query: 'zebra', limit: 0 }).ok).toBe(false)
  })

  test('is read-only and leftover-allow', async () => {
    const tool = createSessionSearchTool(createMemoryStore())
    expect(tool.isReadOnly({ query: 'x' })).toBe(true)
    expect(tool.isReadOnly({})).toBe(true)
    expect(tool.isConcurrencySafe({ query: 'x' })).toBe(true)
    expect(await tool.checkPermissions({ query: 'x' }, makeCtx())).toEqual({
      behavior: 'allow',
      reason: 'mode',
    })
  })

  test('isEnabled is true on a memory store for read/browse', () => {
    const tool = createSessionSearchTool(createMemoryStore())
    expect(tool.isEnabled?.(makeCtx())).toBe(true)
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

  test('sessionId reads head/tail visible lines and skips tool rows', async () => {
    const store = createMemoryStore()
    await store.createSession(session({ id: 'sess_abcd1234', cwd: '/tmp' }))
    await store.persistUser('sess_abcd1234', {
      id: 'msg_user1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello there' }],
      createdAt: 1,
    })
    await store.persistAssistant('sess_abcd1234', {
      id: 'msg_asst1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hi back' }],
      createdAt: 2,
    })
    await store.persistToolCalls('sess_abcd1234', {
      id: 'msg_tools',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'c1', name: 'Echo', input: {} }],
      createdAt: 3,
    })
    await store.persistToolResults('sess_abcd1234', [
      {
        id: 'msg_tool1',
        role: 'tool',
        toolUseId: 'c1',
        ok: true,
        blocks: [{ type: 'text', text: 'hidden tool body' }],
        createdAt: 4,
      },
    ])
    const tool = createSessionSearchTool(store)
    const out = await tool.execute({ sessionId: 'sess_abc' }, makeCtx({ cwd: '/tmp' }))
    expect(out).toContain('sess_abc msg_user user hello there')
    expect(out).toContain('sess_abc msg_asst assistant hi back')
    expect(out).not.toContain('hidden tool body')
  })

  test('sessionId + aroundMessageId returns a window around the hit', async () => {
    const store = createMemoryStore()
    await store.createSession(session({ id: 'sess_abcd1234', cwd: '/tmp' }))
    const lines = ['one', 'two', 'three', 'four', 'five']
    for (const [i, text] of lines.entries()) {
      if (i % 2 === 0) {
        await store.persistUser('sess_abcd1234', {
          id: `msg_${text}`,
          role: 'user',
          blocks: [{ type: 'text', text }],
          createdAt: i + 1,
        })
      } else {
        await store.persistAssistant('sess_abcd1234', {
          id: `msg_${text}`,
          role: 'assistant',
          blocks: [{ type: 'text', text }],
          createdAt: i + 1,
        })
      }
    }
    const tool = createSessionSearchTool(store)
    const out = await tool.execute(
      { sessionId: 'sess_abcd1234', aroundMessageId: 'msg_three', limit: 1 },
      makeCtx({ cwd: '/tmp' }),
    )
    expect(out).toContain('two')
    expect(out).toContain('three')
    expect(out).toContain('four')
    expect(out).not.toContain(' one')
    expect(out).not.toContain('five')
  })

  test('browse lists cwd-scoped parent sessions and hides children', async () => {
    const store = createMemoryStore()
    await store.createSession(session({ id: 'sess_parent1', cwd: '/tmp', title: 'Main' }))
    await store.createSession(
      session({ id: 'sess_child1', cwd: '/tmp', parentSessionId: 'sess_parent1', title: 'Child' }),
    )
    await store.createSession(session({ id: 'sess_other', cwd: '/elsewhere', title: 'Away' }))
    const tool = createSessionSearchTool(store)
    const out = await tool.execute({}, makeCtx({ cwd: '/tmp' }))
    expect(out).toContain('sess_par Main')
    expect(out).not.toContain('Child')
    expect(out).not.toContain('Away')
  })

  test('refuses a session outside the workspace cwd', async () => {
    const store = createMemoryStore()
    await store.createSession(session({ id: 'sess_abcd1234', cwd: '/secret' }))
    const tool = createSessionSearchTool(store)
    const out = await tool.execute({ sessionId: 'sess_abcd1234' }, makeCtx({ cwd: '/tmp' }))
    expect(out).toBe('Session not found in this workspace.')
  })
})
