import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableFault } from '../errors.ts'
import type { JsonObject } from './types.ts'
import { openSqliteStorage } from './sqlite.ts'

describe('sqlite storage', () => {
  test('reopens committed rows and rolls back a failed transaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-durable-'))
    const path = join(dir, 'session.sqlite')
    try {
      const storage = await openSqliteStorage(path)
      expect(storage.mintId()).toBe(2)
      const row = {
        id: 4,
        conversationId: 1,
        kind: 'user' as const,
        message: { role: 'user' as const, content: 'a' },
      }
      storage.commit({ entries: [row] })
      expect(() =>
        storage.commit({
          entries: [row, { ...row, id: 4, message: { role: 'user' as const, content: 'b' } }],
        }),
      ).toThrow()
      expect(storage.readEntries(1).map((entry) => entry.message)).toEqual([{ role: 'user', content: 'a' }])
      expect(() =>
        storage.commit({ documents: [{ key: 'agent', value: Number.NaN as unknown as JsonObject }] }),
      ).toThrow(DurableFault)
      expect(storage.readDocument('agent')).toBeUndefined()
      storage.close()

      const again = await openSqliteStorage(path)
      expect(again.readEntries(1)[0]?.message).toEqual({ role: 'user', content: 'a' })
      expect(again.mintId()).toBe(3)
      again.close()

      const db = new Database(path)
      db.run("UPDATE meta SET value = '2' WHERE key = 'version'")
      db.close()
      await expect(openSqliteStorage(path)).rejects.toThrow(/version/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
