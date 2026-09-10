import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'

export const INIT_SQL = readFileSync(
  join(import.meta.dir, '../migrations/001_init.sql'),
  'utf8',
)

export const FTS5_SQL = readFileSync(
  join(import.meta.dir, '../migrations/002_fts5.sql'),
  'utf8',
)

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: INIT_SQL },
  { version: 2, sql: FTS5_SQL },
]

function currentSchemaVersion(db: Database): number {
  const exists = db
    .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get() as { ok: number } | null
  if (!exists) return 0
  const row = db
    .query("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | null
  if (!row) return 0
  const n = Number(row.value)
  return Number.isFinite(n) ? n : 0
}

export function applyMigrations(db: Database): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    let version = currentSchemaVersion(db)
    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue
      db.exec(migration.sql)
      db.query(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(migration.version))
      version = migration.version
    }
    if (version < 1) {
      db.query(
        `INSERT INTO meta (key, value) VALUES ('schema_version', '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run()
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
