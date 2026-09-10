import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersistError, type Message, type SessionRecord, type SessionStore } from '../types'
import { INCOMPLETE_TEXT } from '../loop/pairing'
import { searchMessages } from './search'
import { createSqliteStore } from './sqlite-store'

type ClosableStore = SessionStore & { close(): void }

const tempDirs: string[] = []
const stores: ClosableStore[] = []

afterEach(() => {
  while (stores.length > 0) {
    const store = stores.pop()
    try {
      store?.close()
    } catch {
      // already closed
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-sqlite-'))
  tempDirs.push(dir)
  return join(dir, 'state.db')
}

function openStore(path = tempDbPath()): ClosableStore {
  const store = createSqliteStore(path) as ClosableStore
  stores.push(store)
  return store
}

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1',
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

describe('createSqliteStore', () => {
  test('fresh install uses WAL and schema_version 2', () => {
    const path = tempDbPath()
    openStore(path)
    const db = new Database(path, { readonly: true })
    try {
      const journal = db.query('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(journal.journal_mode.toLowerCase()).toBe('wal')
      const version = db
        .query("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string }
      expect(version.value).toBe('2')
      expect(
        db
          .query("SELECT 1 AS ok FROM sqlite_master WHERE name = 'messages_fts'")
          .get(),
      ).toBeTruthy()
    } finally {
      db.close()
    }
  })

  test('persistAssistant rejects tool_use; persistToolCalls rejects text-only', async () => {
    const store = openStore()
    await store.createSession(session())
    const withTools: Extract<Message, { role: 'assistant' }> = {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'c1', name: 'Echo', input: {} }],
      createdAt: 1,
    }
    const textOnly: Extract<Message, { role: 'assistant' }> = {
      id: 'a2',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hi' }],
      createdAt: 2,
    }
    await expect(store.persistAssistant('s1', withTools)).rejects.toBeInstanceOf(Error)
    await expect(store.persistToolCalls('s1', textOnly)).rejects.toBeInstanceOf(Error)
  })

  test('same assistant id cannot be written by both persist methods', async () => {
    const store = openStore()
    await store.createSession(session())
    const textOnly: Extract<Message, { role: 'assistant' }> = {
      id: 'same',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hi' }],
      createdAt: 1,
    }
    const withTools: Extract<Message, { role: 'assistant' }> = {
      id: 'same',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'c1', name: 'Echo', input: {} }],
      createdAt: 1,
    }
    await store.persistAssistant('s1', textOnly)
    await expect(store.persistToolCalls('s1', withTools)).rejects.toBeInstanceOf(Error)
  })

  test('recordCompact inactivates ids; loadSession returns only active=1', async () => {
    const store = openStore()
    await store.createSession(session())
    await store.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'old' }],
      createdAt: 1,
    })
    await store.persistUser('s1', {
      id: 'u2',
      role: 'user',
      blocks: [{ type: 'text', text: 'new' }],
      createdAt: 2,
    })
    await store.recordCompact('s1', 3, 'sum', ['u1'])
    const loaded = await store.loadSession('s1')
    expect(loaded.session.compactGeneration).toBe(3)
    expect(loaded.messages.map((m) => m.id)).toEqual(['u2'])
  })

  test('listSessions lists child via parentSessionId; children are not replayed', async () => {
    const store = openStore()
    await store.createSession(session({ id: 'a', cwd: '/a', updatedAt: 3 }))
    await store.persistUser('a', {
      id: 'parent-u',
      role: 'user',
      blocks: [{ type: 'text', text: 'parent' }],
      createdAt: 1,
    })
    await store.createSession(
      session({ id: 'b', cwd: '/b', updatedAt: 2, parentSessionId: 'a' }),
    )
    await store.persistUser('b', {
      id: 'child-u',
      role: 'user',
      blocks: [{ type: 'text', text: 'child' }],
      createdAt: 2,
    })
    await store.createSession(session({ id: 'c', cwd: '/a', updatedAt: 1 }))

    const inA = await store.listSessions({ cwd: '/a' })
    expect(inA.map((s) => s.id)).toEqual(['a', 'c'])

    const children = await store.listSessions({ parentSessionId: 'a' })
    expect(children.map((s) => s.id)).toEqual(['b'])

    const roots = await store.listSessions({ parentSessionId: null })
    expect(roots.map((s) => s.id).sort()).toEqual(['a', 'c'])

    const limited = await store.listSessions({ cwd: '/a', limit: 1 })
    expect(limited.map((s) => s.id)).toEqual(['a'])

    const parentLoaded = await store.loadSession('a')
    expect(parentLoaded.messages.map((m) => m.id)).toEqual(['parent-u'])
  })

  test('withWrite serializes overlapping writes and retries busy/locked once', async () => {
    const store = openStore()
    let busyCalls = 0
    const value = await store.withWrite(async () => {
      busyCalls += 1
      if (busyCalls === 1) throw new PersistError('busy', 'busy')
      return 7
    })
    expect(value).toBe(7)
    expect(busyCalls).toBe(2)

    await expect(
      store.withWrite(async () => {
        throw new PersistError('corrupt', 'nope')
      }),
    ).rejects.toMatchObject({ code: 'corrupt' })

    const order: number[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = store.withWrite(async () => {
      order.push(1)
      await gate
      order.push(2)
    })
    const second = store.withWrite(async () => {
      order.push(3)
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual([1])
    release()
    await Promise.all([first, second])
    expect(order).toEqual([1, 2, 3])
  })

  test('permission rules round-trip at session scope', async () => {
    const store = openStore()
    await store.createSession(session())
    await store.setPermissionRules('s1', [
      { id: 'r1', sessionId: 's1', tool: 'Bash', spec: { cmd: 'ls' }, behavior: 'ask' },
    ])
    const rules = await store.listPermissionRules('s1')
    expect(rules).toHaveLength(1)
    expect(rules[0]).toEqual({
      id: 'r1',
      sessionId: 's1',
      tool: 'Bash',
      spec: { cmd: 'ls' },
      behavior: 'ask',
    })
    expect(await store.listPermissionRules('other')).toEqual([])

    await store.setPermissionRules('s1', [
      { id: 'r2', sessionId: 's1', tool: 'Edit', spec: {}, behavior: 'allow' },
    ])
    const replaced = await store.listPermissionRules('s1')
    expect(replaced.map((r) => r.id)).toEqual(['r2'])
  })

  test('loadSession persists durable incomplete for unpaired tool_use', async () => {
    const store = openStore()
    await store.createSession(session())
    await store.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }],
      createdAt: 1,
    })
    await store.persistToolCalls('s1', {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'echo hi' } }],
      createdAt: 2,
    })
    const loaded = await store.loadSession('s1')
    const tool = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
    )
    expect(tool?.toolUseId).toBe('c1')
    expect(tool?.ok).toBe(false)
    expect(tool?.blocks[0]?.text).toBe(INCOMPLETE_TEXT)

    const again = await store.loadSession('s1')
    const tools = again.messages.filter((m) => m.role === 'tool')
    expect(tools).toHaveLength(1)
  })

  test('persist indexes FTS and compact hides inactive rows', async () => {
    const path = tempDbPath()
    const store = openStore(path)
    await store.createSession(session())
    await store.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'findmeplease oldunique' }],
      createdAt: 1,
    })
    await store.persistAssistant('s1', {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'thinking', text: 'pondering quietly' }],
      createdAt: 2,
    })
    await store.persistToolCalls('s1', {
      id: 'a2',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'secretfile' } }],
      createdAt: 3,
    })
    await store.persistToolResults('s1', [
      {
        id: 't1',
        role: 'tool',
        toolUseId: 'c1',
        ok: true,
        blocks: [{ type: 'text', text: 'filecontents' }],
        createdAt: 4,
      },
    ])

    const db = new Database(path)
    try {
      expect(searchMessages(db, 'findmeplease').map((h) => h.messageId)).toEqual(['u1'])
      expect(searchMessages(db, 'pondering').map((h) => h.messageId)).toEqual(['a1'])
      expect(searchMessages(db, 'secretfile').map((h) => h.messageId)).toEqual(['a2'])
      expect(searchMessages(db, 'filecontents').map((h) => h.messageId)).toEqual(['t1'])
    } finally {
      db.close()
    }

    await store.recordCompact('s1', 1, 'sum', ['u1'])
    const after = new Database(path)
    try {
      expect(searchMessages(after, 'oldunique')).toEqual([])
      expect(searchMessages(after, 'pondering').map((h) => h.messageId)).toEqual(['a1'])
    } finally {
      after.close()
    }
  })

  test('broken FTS does not throw from persist or compact', async () => {
    const path = tempDbPath()
    const store = openStore(path)
    await store.createSession(session())
    const db = new Database(path)
    db.exec('DROP TABLE messages_fts')
    db.close()

    await expect(
      store.persistUser('s1', {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'hi' }],
        createdAt: 1,
      }),
    ).resolves.toBeUndefined()
    await expect(
      store.persistAssistant('s1', {
        id: 'a1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'ok' }],
        createdAt: 2,
      }),
    ).resolves.toBeUndefined()
    await expect(
      store.persistToolCalls('s1', {
        id: 'a2',
        role: 'assistant',
        blocks: [{ type: 'tool_use', id: 'c1', name: 'Echo', input: {} }],
        createdAt: 3,
      }),
    ).resolves.toBeUndefined()
    await expect(
      store.persistToolResults('s1', [
        {
          id: 't1',
          role: 'tool',
          toolUseId: 'c1',
          ok: true,
          blocks: [{ type: 'text', text: 'done' }],
          createdAt: 4,
        },
      ]),
    ).resolves.toBeUndefined()
    await expect(store.recordCompact('s1', 1, 'sum', ['u1'])).resolves.toBeUndefined()

    const loaded = await store.loadSession('s1')
    expect(loaded.messages.map((m) => m.id).sort()).toEqual(['a1', 'a2', 't1'])
  })

  test('second store instance on the same file may read', async () => {
    const path = tempDbPath()
    const writer = openStore(path)
    await writer.createSession(session())
    await writer.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hi' }],
      createdAt: 1,
    })
    const reader = openStore(path)
    const loaded = await reader.loadSession('s1')
    expect(loaded.messages.map((m) => m.id)).toEqual(['u1'])
  })
})
