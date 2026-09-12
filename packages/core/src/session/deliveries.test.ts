import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { applyMigrations } from './schema'
import { DELIVERY_TTL_MS, createMemoryDeliveries, createSqliteDeliveries, deliveryKey } from './deliveries'

describe('deliveryKey', () => {
  test('prefixes the source', () => {
    expect(deliveryKey('discord', 'm1')).toBe('discord:m1')
  })
})

describe('createMemoryDeliveries', () => {
  test('second seen is duplicate; gc drops old rows', () => {
    let now = 1_000
    const ledger = createMemoryDeliveries({ now: () => now })
    expect(ledger.seen('discord:m1')).toBe(true)
    expect(ledger.seen('discord:m1')).toBe(false)
    now = 1_000 + DELIVERY_TTL_MS + 1
    expect(ledger.gc(now - DELIVERY_TTL_MS)).toBe(1)
    expect(ledger.seen('discord:m1')).toBe(true)
  })
})

describe('createSqliteDeliveries', () => {
  test('persists across instances and migrates to schema 4', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const version = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(version.value).toBe('4')
    const first = createSqliteDeliveries(db)
    expect(first.seen('discord:abc')).toBe(true)
    expect(first.seen('discord:abc')).toBe(false)
    const again = createSqliteDeliveries(db)
    expect(again.seen('discord:abc')).toBe(false)
  })
})
