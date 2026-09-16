import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  AGENT_MAIL_SQL,
  applyMigrations,
  DELIVERIES_SQL,
  FTS5_SQL,
  INIT_SQL,
  PENDING_ASKS_SQL,
  READ_MTIME_SQL,
  SESSION_TODOS_SQL,
} from './schema'

function sessionColumns(db: Database): string[] {
  return (db.query('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
    (col) => col.name,
  )
}

function messageColumns(db: Database): string[] {
  return (db.query('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
    (col) => col.name,
  )
}

function expectJobColumns(db: Database): void {
  expect(sessionColumns(db)).toContain('todos_json')
  expect(sessionColumns(db)).toContain('job_json')
  expect(sessionColumns(db)).toContain('job_auto_commit')
  expect(messageColumns(db)).toContain('checkpoint_json')
}

describe('applyMigrations', () => {
  test('fresh db reaches schema_version 8 with mail and lock tables', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('8')
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((row) => row.name)
    expect(names).toContain('sessions')
    expect(names).toContain('agent_mail')
    expect(names).toContain('session_locks')
    expectJobColumns(db)
    db.close()
  })

  test('is idempotent when already at version 8', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('8')
    expectJobColumns(db)
    db.close()
  })

  test('fresh db reaches schema_version 8 with pending_asks', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('8')
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(names).toContain('pending_asks')
    expect(names).toContain('deliveries')
    expectJobColumns(db)
    db.close()
  })

  test('v4 database upgrades to v8 without dropping deliveries', () => {
    const db = new Database(':memory:')
    db.exec(INIT_SQL)
    db.exec(FTS5_SQL)
    db.exec(AGENT_MAIL_SQL)
    db.exec(DELIVERIES_SQL)
    db.query(
      "INSERT INTO meta (key, value) VALUES ('schema_version', '4') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run()
    db.query("INSERT INTO deliveries (id, source, seen_at) VALUES ('discord:abc', 'discord', 1)").run()
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('8')
    const kept = db.query("SELECT id FROM deliveries WHERE id = 'discord:abc'").get() as {
      id: string
    } | null
    expect(kept?.id).toBe('discord:abc')
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_asks'").get(),
    ).toBeTruthy()
    expectJobColumns(db)
    db.close()
  })

  test('v5 database upgrades to v8 with read_mtime_ms', () => {
    const db = new Database(':memory:')
    db.exec(INIT_SQL)
    db.exec(FTS5_SQL)
    db.exec(AGENT_MAIL_SQL)
    db.exec(DELIVERIES_SQL)
    db.exec(PENDING_ASKS_SQL)
    db.query(
      "INSERT INTO meta (key, value) VALUES ('schema_version', '5') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run()
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('8')
    expect(messageColumns(db)).toContain('read_mtime_ms')
    expectJobColumns(db)
    db.close()
  })

  test('v6 database upgrades to v8 with todos_json', () => {
    const db = new Database(':memory:')
    db.exec(INIT_SQL)
    db.exec(FTS5_SQL)
    db.exec(AGENT_MAIL_SQL)
    db.exec(DELIVERIES_SQL)
    db.exec(PENDING_ASKS_SQL)
    db.exec(READ_MTIME_SQL)
    db.query(
      "INSERT INTO meta (key, value) VALUES ('schema_version', '6') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run()
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('8')
    expectJobColumns(db)
    db.close()
  })

  test('v7 database upgrades to v8 with job_json', () => {
    const db = new Database(':memory:')
    db.exec(INIT_SQL)
    db.exec(FTS5_SQL)
    db.exec(AGENT_MAIL_SQL)
    db.exec(DELIVERIES_SQL)
    db.exec(PENDING_ASKS_SQL)
    db.exec(READ_MTIME_SQL)
    db.exec(SESSION_TODOS_SQL)
    db.query(
      "INSERT INTO meta (key, value) VALUES ('schema_version', '7') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run()
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('8')
    expectJobColumns(db)
    db.close()
  })
})
