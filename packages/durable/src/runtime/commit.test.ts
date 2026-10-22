import { describe, expect, test } from 'bun:test'
import { DurableClosed, DurableFault } from '../errors.ts'
import { openMemoryStorage } from '../storage/memory.ts'
import type { DurableStorage, JsonValue } from '../storage/types.ts'
import { createCommitLine } from './commit.ts'

describe('mutation line', () => {
  test('a thrown callback writes nothing and a later run still works', async () => {
    const storage = openMemoryStorage()
    const line = createCommitLine(storage)
    await expect(
      line.run((tx) => {
        tx.stage({ documents: [{ key: 'agent', value: { modelId: 'm' } }] })
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
    expect(storage.readDocument('agent')).toBeUndefined()
    await line.run((tx) => {
      tx.stage({ documents: [{ key: 'agent', value: { modelId: 'm' } }] })
    })
    expect(storage.readDocument('agent')).toEqual({ modelId: 'm' })
  })

  test('strict JSON failure leaves the line open', async () => {
    const storage = openMemoryStorage()
    const line = createCommitLine(storage)
    await expect(
      line.run((tx) => {
        tx.stage({ documents: [{ key: 'agent', value: Number.NaN as unknown as JsonValue }] })
      }),
    ).rejects.toBeInstanceOf(DurableFault)
    await line.run((tx) => {
      tx.stage({ documents: [{ key: 'agent', value: { modelId: 'm' } }] })
    })
    expect(storage.readDocument('agent')).toEqual({ modelId: 'm' })
  })

  test('a storage failure closes the line', async () => {
    const inner = openMemoryStorage()
    let fail = false
    const storage: DurableStorage = {
      mintId: () => inner.mintId(),
      commit(batch) {
        if (fail) throw new Error('disk dead')
        inner.commit(batch)
      },
      readConversation: (id) => inner.readConversation(id),
      readEntries: (id) => inner.readEntries(id),
      readTask: (id) => inner.readTask(id),
      readTasks: () => inner.readTasks(),
      readSubmission: (id) => inner.readSubmission(id),
      readSubmissionByRequest: (conversationId, requestId) =>
        inner.readSubmissionByRequest(conversationId, requestId),
      readDocument: (key) => inner.readDocument(key),
      close: () => inner.close(),
    }
    const line = createCommitLine(storage)
    fail = true
    await expect(
      line.run((tx) => {
        tx.stage({ documents: [{ key: 'agent', value: { modelId: 'm' } }] })
      }),
    ).rejects.toBeInstanceOf(DurableClosed)
    await expect(line.run(() => 1)).rejects.toBeInstanceOf(DurableClosed)
    expect(inner.readDocument('agent')).toBeUndefined()
  })

  test('overlapping runs see the earlier commit', async () => {
    const storage = openMemoryStorage()
    const line = createCommitLine(storage)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = line.run(async (tx) => {
      await gate
      tx.stage({ documents: [{ key: 'agent', value: { modelId: 'a' } }] })
    })
    const second = line.run((tx) => tx.readDocument('agent'))
    release()
    await first
    expect(await second).toEqual({ modelId: 'a' })
  })
})
