import type { Database } from 'bun:sqlite'

export const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000

export interface DeliveryLedger {
  seen(id: string): boolean
  gc(olderThan: number): number
}

export function deliveryKey(source: string, messageId: string): string {
  return `${source}:${messageId}`
}

function sourceOf(id: string): string {
  const i = id.indexOf(':')
  return i === -1 ? id : id.slice(0, i)
}

export function createMemoryDeliveries(opts?: { now?: () => number }): DeliveryLedger {
  const now = opts?.now ?? Date.now
  const rows = new Map<string, { source: string; seen_at: number }>()
  return {
    seen(id: string): boolean {
      if (rows.has(id)) return false
      rows.set(id, { source: sourceOf(id), seen_at: now() })
      return true
    },
    gc(olderThan: number): number {
      let deleted = 0
      for (const [id, row] of rows) {
        if (row.seen_at < olderThan) {
          rows.delete(id)
          deleted++
        }
      }
      return deleted
    },
  }
}

export function createSqliteDeliveries(db: Database, opts?: { now?: () => number }): DeliveryLedger {
  const now = opts?.now ?? Date.now
  const insert = db.query(
    'INSERT OR IGNORE INTO deliveries (id, source, seen_at) VALUES (?, ?, ?)',
  )
  const remove = db.query('DELETE FROM deliveries WHERE seen_at < ?')
  return {
    seen(id: string): boolean {
      try {
        const changes = insert.run(id, sourceOf(id), now())
        return changes.changes === 1
      } catch {
        return false
      }
    },
    gc(olderThan: number): number {
      return remove.run(olderThan).changes
    },
  }
}
