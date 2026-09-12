import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLockError, type SessionRecord, type SessionStore } from '../types'
import { createMemoryStore } from './memory-store'
import { createSqliteStore } from './sqlite-store'

type ClosableStore = SessionStore & { close(): void }

const tempDirs: string[] = []
const stores: ClosableStore[] = []

afterEach(() => {
  while (stores.length > 0) {
    const store = stores.pop()
    try {
      store?.close()
    } catch {
      // already closed
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'dummy',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

function openSqlite(path?: string): ClosableStore {
  const dir = path === undefined ? mkdtempSync(join(tmpdir(), 'ravenclaw-lock-')) : undefined
  if (dir) tempDirs.push(dir)
  const dbPath = path ?? join(dir!, 'state.db')
  const store = createSqliteStore(dbPath) as ClosableStore
  stores.push(store)
  return store
}

function storesUnderTest(): Array<{ name: string; store: SessionStore }> {
  return [
    { name: 'memory', store: createMemoryStore() },
    { name: 'sqlite', store: openSqlite() },
  ]
}

describe('session lock', () => {
  test('second acquire fails while the lease is live', async () => {
    for (const { name, store } of storesUnderTest()) {
      await store.createSession(session({ id: `${name}-live` }))
      await store.acquireSessionLock(`${name}-live`, { holderId: 'a', holderName: 'tui' })
      await expect(
        store.acquireSessionLock(`${name}-live`, { holderId: 'b', holderName: 'serve' }),
      ).rejects.toBeInstanceOf(SessionLockError)
      try {
        await store.acquireSessionLock(`${name}-live`, { holderId: 'b', holderName: 'serve' })
      } catch (error) {
        expect(error).toBeInstanceOf(SessionLockError)
        expect((error as Error).message).toMatch(/session locked by tui until /)
      }
    }
  })

  test('same holder can re-acquire', async () => {
    for (const { name, store } of storesUnderTest()) {
      await store.createSession(session({ id: `${name}-same` }))
      await store.acquireSessionLock(`${name}-same`, { holderId: 'a', holderName: 'exec' })
      await store.acquireSessionLock(`${name}-same`, { holderId: 'a', holderName: 'exec' })
    }
  })

  test('stale lease can be taken', async () => {
    for (const { name, store } of storesUnderTest()) {
      await store.createSession(session({ id: `${name}-stale` }))
      await store.acquireSessionLock(`${name}-stale`, {
        holderId: 'a',
        holderName: 'tui',
        ttlMs: 1,
      })
      await Bun.sleep(5)
      await store.acquireSessionLock(`${name}-stale`, { holderId: 'b', holderName: 'serve' })
    }
  })

  test('renew extends a live lease', async () => {
    for (const { name, store } of storesUnderTest()) {
      await store.createSession(session({ id: `${name}-renew` }))
      await store.acquireSessionLock(`${name}-renew`, {
        holderId: 'a',
        holderName: 'tui',
        ttlMs: 30,
      })
      await store.renewSessionLock(`${name}-renew`, 'a', 5_000)
      await Bun.sleep(40)
      await expect(
        store.acquireSessionLock(`${name}-renew`, { holderId: 'b', holderName: 'serve' }),
      ).rejects.toBeInstanceOf(SessionLockError)
    }
  })

  test('release lets another holder acquire', async () => {
    for (const { name, store } of storesUnderTest()) {
      await store.createSession(session({ id: `${name}-rel` }))
      await store.acquireSessionLock(`${name}-rel`, { holderId: 'a', holderName: 'tui' })
      await store.releaseSessionLock(`${name}-rel`, 'a')
      await store.acquireSessionLock(`${name}-rel`, { holderId: 'b', holderName: 'serve' })
    }
  })

  test('renew by a non-holder fails', async () => {
    for (const { name, store } of storesUnderTest()) {
      await store.createSession(session({ id: `${name}-steal` }))
      await store.acquireSessionLock(`${name}-steal`, { holderId: 'a', holderName: 'tui' })
      await expect(store.renewSessionLock(`${name}-steal`, 'b')).rejects.toBeInstanceOf(
        SessionLockError,
      )
    }
  })

  test('two sqlite handles see the same lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-lock-xproc-'))
    tempDirs.push(dir)
    const path = join(dir, 'state.db')
    const a = openSqlite(path)
    await a.createSession(session())
    await a.acquireSessionLock('s1', { holderId: 'a', holderName: 'tui' })
    const b = openSqlite(path)
    await expect(
      b.acquireSessionLock('s1', { holderId: 'b', holderName: 'serve' }),
    ).rejects.toBeInstanceOf(SessionLockError)
  })
})
