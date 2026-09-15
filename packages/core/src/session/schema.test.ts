import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  AGENT_MAIL_SQL,
  applyMigrations,
  DELIVERIES_SQL,
  FTS5_SQL,
  INIT_SQL,
  PENDING_ASKS_SQL,
} from './schema'

describe('applyMigrations', () => {
  test('fresh db reaches schema_version 6 with mail and lock tables', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('6')
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((row) => row.name)
    expect(names).toContain('sessions')
    expect(names).toContain('agent_mail')
    expect(names).toContain('session_locks')
    db.close()
  })

  test('is idempotent when already at version 6', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('6')
    db.close()
  })

  test('fresh db reaches schema_version 6 with pending_asks', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('6')
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(names).toContain('pending_asks')
    expect(names).toContain('deliveries')
    db.close()
  })

  test('v4 database upgrades to v6 without dropping deliveries', () => {
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
    expect(version.value).toBe('6')
    const kept = db.query("SELECT id FROM deliveries WHERE id = 'discord:abc'").get() as {
      id: string
    } | null
    expect(kept?.id).toBe('discord:abc')
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_asks'").get(),
    ).toBeTruthy()
    db.close()
  })

  test('v5 database upgrades to v6 with read_mtime_ms', () => {
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
    expect(version.value).toBe('6')
    const cols = db.query('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    expect(cols.map((col) => col.name)).toContain('read_mtime_ms')
    db.close()
  })
})
