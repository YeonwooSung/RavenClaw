import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { applyMigrations } from './schema'

describe('applyMigrations', () => {
  test('fresh db reaches schema_version 3 with mail and lock tables', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('3')
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((row) => row.name)
    expect(names).toContain('sessions')
    expect(names).toContain('agent_mail')
    expect(names).toContain('session_locks')
    db.close()
  })

  test('is idempotent when already at version 3', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('3')
    db.close()
  })
})
