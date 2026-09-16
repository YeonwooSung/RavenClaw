import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { applyMigrations, FTS5_SQL, INIT_SQL } from './schema'
import {
  clipSearchBody,
  headTailMessages,
  rebuildMessagesFts,
  searchMessages,
  visibleSessionMessages,
  windowAroundMessages,
} from './search'

function seedSession(db: Database, id = 's1'): void {
  db.query(
    `INSERT INTO sessions (
       id, created_at, updated_at, cwd, model, permission_mode,
       compact_generation, usage_json, funding
     ) VALUES (?, 1, 1, '/tmp', 'dummy', 'default', 0, '{}', 'byok')`,
  ).run(id)
}

function insertMessage(
  db: Database,
  over: {
    id: string
    sessionId?: string
    createdAt?: number
    role?: string
    blocks: unknown
    active?: number
  },
): void {
  db.query(
    `INSERT INTO messages (
       id, session_id, created_at, role, blocks_json, active, generation
     ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    over.id,
    over.sessionId ?? 's1',
    over.createdAt ?? 1,
    over.role ?? 'user',
    JSON.stringify(over.blocks),
    over.active ?? 1,
  )
}

describe('messages FTS5', () => {
  test('migrates schema 1 to 7 and is replayable', () => {
    const db = new Database(':memory:')
    db.exec(INIT_SQL)
    db.query(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`).run()
    seedSession(db)
    insertMessage(db, {
      id: 'u1',
      blocks: [{ type: 'text', text: 'uniquezebra from v1' }],
    })

    expect(
      db
        .query("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string },
    ).toEqual({ value: '1' })
    expect(
      db
        .query("SELECT 1 AS ok FROM sqlite_master WHERE name = 'messages_fts'")
        .get(),
    ).toBeNull()

    applyMigrations(db)
    const version = db
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string }
    expect(version.value).toBe('7')
    expect(
      db
        .query("SELECT 1 AS ok FROM sqlite_master WHERE name = 'messages_fts'")
        .get(),
    ).toBeTruthy()

    const hits = searchMessages(db, 'uniquezebra')
    expect(hits.map((h) => h.messageId)).toEqual(['u1'])
    expect(hits[0]?.sessionId).toBe('s1')
    expect(typeof hits[0]?.snippet).toBe('string')
    expect(typeof hits[0]?.rank).toBe('number')

    expect(() => db.exec(FTS5_SQL)).not.toThrow()
    applyMigrations(db)
    const again = db
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string }
    expect(again.value).toBe('7')
    expect(searchMessages(db, 'uniquezebra').map((h) => h.messageId)).toEqual(['u1'])
    db.close()
  })

  test('insert then search finds text, thinking, and tool_use name+input', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    seedSession(db)
    insertMessage(db, {
      id: 'u1',
      createdAt: 1,
      blocks: [{ type: 'text', text: 'please inspect secretfile' }],
    })
    insertMessage(db, {
      id: 'a1',
      createdAt: 2,
      role: 'assistant',
      blocks: [
        { type: 'thinking', text: 'pondering the path' },
        {
          type: 'tool_use',
          id: 'c1',
          name: 'Read',
          input: { path: 'secretfile' },
        },
      ],
    })
    insertMessage(db, {
      id: 'bin1',
      createdAt: 3,
      blocks: [
        { type: 'image', data: 'binarypayload' },
        { type: 'text', text: 'visibletext\0nulled' },
      ],
    })
    rebuildMessagesFts(db)

    expect(searchMessages(db, 'secretfile').map((h) => h.messageId).sort()).toEqual([
      'a1',
      'u1',
    ])
    expect(searchMessages(db, 'pondering').map((h) => h.messageId)).toEqual(['a1'])
    expect(searchMessages(db, 'Read').map((h) => h.messageId)).toEqual(['a1'])
    expect(searchMessages(db, 'binarypayload')).toEqual([])
    expect(searchMessages(db, 'nulled')).toEqual([])
    db.close()
  })

  test('search defaults to 20 hits and can filter by sessionId', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    seedSession(db, 's1')
    seedSession(db, 's2')
    for (let i = 0; i < 25; i++) {
      insertMessage(db, {
        id: `m${i}`,
        sessionId: 's1',
        createdAt: i,
        blocks: [{ type: 'text', text: `sharedtoken item${i}` }],
      })
    }
    insertMessage(db, {
      id: 'other',
      sessionId: 's2',
      createdAt: 100,
      blocks: [{ type: 'text', text: 'sharedtoken other session' }],
    })
    rebuildMessagesFts(db)

    expect(searchMessages(db, 'sharedtoken')).toHaveLength(20)
    expect(searchMessages(db, 'sharedtoken', { limit: 5 })).toHaveLength(5)
    const scoped = searchMessages(db, 'sharedtoken', { sessionId: 's2' })
    expect(scoped.map((h) => h.messageId)).toEqual(['other'])
    expect(searchMessages(db, '   ')).toEqual([])
    db.close()
  })

  test('compact inactive messages are not returned', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    seedSession(db)
    insertMessage(db, {
      id: 'old',
      createdAt: 1,
      blocks: [{ type: 'text', text: 'oldunique' }],
      active: 0,
    })
    insertMessage(db, {
      id: 'kept',
      createdAt: 2,
      blocks: [{ type: 'text', text: 'newunique' }],
      active: 1,
    })
    rebuildMessagesFts(db)
    expect(searchMessages(db, 'oldunique')).toEqual([])
    expect(searchMessages(db, 'newunique').map((h) => h.messageId)).toEqual(['kept'])
    db.close()
  })

  test('rebuildMessagesFts fail-open never throws', () => {
    const empty = new Database(':memory:')
    expect(() => rebuildMessagesFts(empty)).not.toThrow()
    empty.close()

    const db = new Database(':memory:')
    applyMigrations(db)
    db.exec('DROP TABLE messages_fts')
    expect(() => rebuildMessagesFts(db)).not.toThrow()
    db.exec('DROP TABLE IF EXISTS messages_fts')
    db.exec('CREATE TABLE messages_fts (x INTEGER)')
    seedSession(db)
    insertMessage(db, {
      id: 'u1',
      blocks: [{ type: 'text', text: 'stillworks' }],
    })
    expect(() => rebuildMessagesFts(db)).not.toThrow()
    db.close()
  })
})

describe('session read helpers', () => {
  test('skips tool rows and windows around a message', () => {
    const user = (id: string, text: string, createdAt: number) => ({
      id,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text }],
      createdAt,
    })
    const tool = {
      id: 't1',
      role: 'tool' as const,
      toolUseId: 'c1',
      ok: true,
      blocks: [{ type: 'text' as const, text: 'hidden' }],
      createdAt: 2,
    }
    const toolUseOnly = {
      id: 'a1',
      role: 'assistant' as const,
      blocks: [{ type: 'tool_use' as const, id: 'c1', name: 'Echo', input: {} }],
      createdAt: 2,
    }
    const msgs = [user('u1', 'a', 1), tool, toolUseOnly, user('u2', 'b', 3), user('u3', 'c', 4)]
    const visible = visibleSessionMessages(msgs)
    expect(visible.map((msg) => msg.id)).toEqual(['u1', 'u2', 'u3'])
    expect(windowAroundMessages(visible, 'u2', 1).map((msg) => msg.id)).toEqual(['u1', 'u2', 'u3'])
    expect(windowAroundMessages(visible, 'u', 1)).toEqual([])
    expect(headTailMessages(visible, 1).map((msg) => msg.id)).toEqual(['u1', 'u3'])
    expect(clipSearchBody('abcd', 3)).toBe('abc…')
  })
})
