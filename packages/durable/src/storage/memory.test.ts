import { describe, expect, test } from 'bun:test'
import { DurableFault } from '../errors.ts'
import type { JsonObject } from './types.ts'
import { openMemoryStorage } from './memory.ts'

describe('memory storage', () => {
  test('mints from 2 and commits a batch atomically', () => {
    const storage = openMemoryStorage()
    expect(storage.mintId()).toBe(2)
    expect(storage.mintId()).toBe(3)
    storage.commit({
      entries: [
        { id: 4, conversationId: 1, kind: 'user', message: { role: 'user', content: 'a' } },
        { id: 5, conversationId: 1, kind: 'user', message: { role: 'user', content: 'b' } },
      ],
    })
    expect(storage.readEntries(1).map((entry) => entry.id)).toEqual([4, 5])
  })

  test('a rejected batch leaves the previous rows', () => {
    const storage = openMemoryStorage()
    storage.commit({
      entries: [{ id: 4, conversationId: 1, kind: 'user', message: { role: 'user', content: 'a' } }],
    })
    expect(() =>
      storage.commit({
        entries: [{ id: 5, conversationId: 1, kind: 'user', message: { role: 'user', content: 'b' } }],
        documents: [{ key: 'agent', value: Number.NaN as unknown as JsonObject }],
      }),
    ).toThrow(DurableFault)
    expect(storage.readEntries(1).map((entry) => entry.id)).toEqual([4])
    expect(storage.readDocument('agent')).toBeUndefined()
  })

  test('reads return copies', () => {
    const storage = openMemoryStorage()
    storage.commit({ documents: [{ key: 'agent', value: { modelId: 'm' } }] })
    const doc = storage.readDocument('agent') as { modelId: string }
    doc.modelId = 'other'
    expect(storage.readDocument('agent')).toEqual({ modelId: 'm' })
    storage.close()
    expect(() => storage.mintId()).toThrow('storage closed')
  })
})
