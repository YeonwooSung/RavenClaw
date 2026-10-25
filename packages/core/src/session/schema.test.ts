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
  PENDING_RESET_SHA_SQL,
  SESSION_HOST_STATE_SQL,
  SESSION_JOB_SQL,
  SESSION_TODOS_SQL,
  STREAM_EVENTS_SQL,
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

function expectStreamEvents(db: Database): void {
  expect(
    db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stream_events'").get(),
  ).toBeTruthy()
}

function expectHostStateColumns(db: Database): void {
  expect(sessionColumns(db)).toContain('last_end_json')
  expect(sessionColumns(db)).toContain('job_error')
  expect(sessionColumns(db)).toContain('followup_text')
}

function expectPendingResetColumn(db: Database): void {
  expect(sessionColumns(db)).toContain('pending_reset_sha')
}

describe('applyMigrations', () => {
  test('fresh db reaches schema_version 12 with mail and lock tables', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('12')
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((row) => row.name)
    expect(names).toContain('sessions')
    expect(names).toContain('agent_mail')
    expect(names).toContain('session_locks')
    expect(names).toContain('stream_events')
    expectJobColumns(db)
    expectStreamEvents(db)
    expectHostStateColumns(db)
    expectPendingResetColumn(db)
    db.close()
  })

  test('is idempotent when already at version 12', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('12')
    expectJobColumns(db)
    expectStreamEvents(db)
    expectHostStateColumns(db)
    expectPendingResetColumn(db)
    db.close()
  })

  test('fresh db reaches schema_version 12 with pending_asks', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('12')
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name)
    expect(names).toContain('pending_asks')
    expect(names).toContain('deliveries')
    expect(names).toContain('stream_events')
    expectJobColumns(db)
    expectHostStateColumns(db)
    expectPendingResetColumn(db)
    db.close()
  })

  test('v4 database upgrades to v11 without dropping deliveries', () => {
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
    expect(version.value).toBe('12')
    const kept = db.query("SELECT id FROM deliveries WHERE id = 'discord:abc'").get() as {
      id: string
    } | null
    expect(kept?.id).toBe('discord:abc')
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_asks'").get(),
    ).toBeTruthy()
    expectJobColumns(db)
    expectStreamEvents(db)
    expectHostStateColumns(db)
    expectPendingResetColumn(db)
    db.close()
  })

  test('v5 database upgrades to v11 with read_mtime_ms', () => {
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
    expect(version.value).toBe('12')
    expect(messageColumns(db)).toContain('read_mtime_ms')
    expectJobColumns(db)
    expectStreamEvents(db)
    expectHostStateColumns(db)
    expectPendingResetColumn(db)
    db.close()
  })

  test('v6 database upgrades to v11 with todos_json', () => {
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
    expect(version.value).toBe('12')
    expectJobColumns(db)
    expectStreamEvents(db)
    expectHostStateColumns(db)
    expectPendingResetColumn(db)
    db.close()
  })

  test('v7 database upgrades to v11 with job_json', () => {
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
    expect(version.value).toBe('12')
    expectJobColumns(db)
    expectStreamEvents(db)
    expectHostStateColumns(db)
    expectPendingResetColumn(db)
    db.close()
  })

  test('v8 database upgrades to v11 with stream_events', () => {
    const db = new Database(':memory:')
    db.exec(INIT_SQL)
    db.exec(FTS5_SQL)
    db.exec(AGENT_MAIL_SQL)
    db.exec(DELIVERIES_SQL)
    db.exec(PENDING_ASKS_SQL)
    db.exec(READ_MTIME_SQL)
    db.exec(SESSION_TODOS_SQL)
    db.exec(SESSION_JOB_SQL)
    db.query(
      "INSERT INTO meta (key, value) VALUES ('schema_version', '8') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run()
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('12')
    expectStreamEvents(db)
    expectJobColumns(db)
    expectHostStateColumns(db)
    expectPendingResetColumn(db)
    db.close()
  })

  test('v9 database upgrades to v11 with last_end_json', () => {
    const db = new Database(':memory:')
    db.exec(INIT_SQL)
    db.exec(FTS5_SQL)
    db.exec(AGENT_MAIL_SQL)
    db.exec(DELIVERIES_SQL)
    db.exec(PENDING_ASKS_SQL)
    db.exec(READ_MTIME_SQL)
    db.exec(SESSION_TODOS_SQL)
    db.exec(SESSION_JOB_SQL)
    db.exec(STREAM_EVENTS_SQL)
    db.query(
      "INSERT INTO meta (key, value) VALUES ('schema_version', '9') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run()
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('12')
    expect(sessionColumns(db)).toContain('last_end_json')
    expect(sessionColumns(db)).toContain('job_error')
    expect(sessionColumns(db)).toContain('followup_text')
    expectPendingResetColumn(db)
    db.close()
  })

  test('fresh db reaches schema_version 12 with pending_reset_sha', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('12')
    expectPendingResetColumn(db)
    expectHostStateColumns(db)
    db.close()
  })

  test('v10 database upgrades to v11 and copies job_json pendingResetSha into the column', () => {
    const db = new Database(':memory:')
    db.exec(INIT_SQL)
    db.exec(FTS5_SQL)
    db.exec(AGENT_MAIL_SQL)
    db.exec(DELIVERIES_SQL)
    db.exec(PENDING_ASKS_SQL)
    db.exec(READ_MTIME_SQL)
    db.exec(SESSION_TODOS_SQL)
    db.exec(SESSION_JOB_SQL)
    db.exec(STREAM_EVENTS_SQL)
    db.exec(SESSION_HOST_STATE_SQL)
    db.query(
      "INSERT INTO meta (key, value) VALUES ('schema_version', '10') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run()
    db.query(
      `INSERT INTO sessions (
         id, created_at, updated_at, cwd, model, permission_mode, compact_generation,
         usage_json, funding, job_json, job_auto_commit
       ) VALUES (?, 1, 1, '/', 'dummy', 'default', 0, '{}', 'byok', ?, 0)`,
    ).run(
      's1',
      JSON.stringify({
        baseBranch: 'main',
        shadowBranch: 'raven/s',
        baseCommitSha: 'abc123',
        worktreePath: '/tmp/wt',
        pendingResetSha: 'def456',
      }),
    )
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('12')
    const row = db.query('SELECT pending_reset_sha FROM sessions WHERE id = ?').get('s1') as {
      pending_reset_sha: string | null
    }
    expect(row.pending_reset_sha).toBe('def456')
    expectHostStateColumns(db)
    db.close()
  })

  test('v11 database links active messages and sets the leaf', () => {
    const db = new Database(':memory:')
    db.exec(INIT_SQL)
    db.exec(FTS5_SQL)
    db.exec(AGENT_MAIL_SQL)
    db.exec(DELIVERIES_SQL)
    db.exec(PENDING_ASKS_SQL)
    db.exec(READ_MTIME_SQL)
    db.exec(SESSION_TODOS_SQL)
    db.exec(SESSION_JOB_SQL)
    db.exec(STREAM_EVENTS_SQL)
    db.exec(SESSION_HOST_STATE_SQL)
    db.exec(PENDING_RESET_SHA_SQL)
    db.query(
      "INSERT INTO meta (key, value) VALUES ('schema_version', '11') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run()
    db.query(
      `INSERT INTO sessions (
         id, created_at, updated_at, cwd, model, permission_mode, compact_generation,
         usage_json, funding
       ) VALUES ('s1', 1, 1, '/', 'dummy', 'default', 0, '{}', 'byok')`,
    ).run()
    const insert = db.query(
      `INSERT INTO messages (id, session_id, created_at, role, blocks_json, active, generation)
       VALUES (?, 's1', ?, 'user', '[]', ?, 0)`,
    )
    insert.run('a', 1, 1)
    insert.run('b', 2, 1)
    insert.run('c', 3, 1)
    insert.run('x', 4, 0)
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('12')
    expect(messageColumns(db)).toContain('parent_id')
    expect(sessionColumns(db)).toContain('leaf_id')
    const rows = db
      .query('SELECT id, parent_id FROM messages ORDER BY rowid')
      .all() as Array<{ id: string; parent_id: string | null }>
    expect(rows).toEqual([
      { id: 'a', parent_id: null },
      { id: 'b', parent_id: 'a' },
      { id: 'c', parent_id: 'b' },
      { id: 'x', parent_id: null },
    ])
    const leaf = db.query('SELECT leaf_id FROM sessions WHERE id = ?').get('s1') as {
      leaf_id: string | null
    }
    expect(leaf.leaf_id).toBe('c')
    db.close()
  })
})
