import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../session/memory-store'
import { createSqliteStore } from '../session/sqlite-store'
import type { SessionRecord, SessionStore } from '../types'
import {
  AGENT_MAIL_BODY_MAX,
  drainAgentMail,
  enqueueAgentMail,
  peekAgentMail,
  MAX_PARALLEL_CHILDREN,
} from './mailbox'

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

function session(id: string): SessionRecord {
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'dummy',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
  }
}

function openSqlite(path?: string): ClosableStore {
  const dir = path === undefined ? mkdtempSync(join(tmpdir(), 'ravenclaw-mail-')) : undefined
  if (dir) tempDirs.push(dir)
  const dbPath = path ?? join(dir!, 'state.db')
  const store = createSqliteStore(dbPath) as ClosableStore
  stores.push(store)
  return store
}

describe('agent mailbox', () => {
  test('enqueue then drain returns notices and clears the queue', async () => {
    const store = createMemoryStore()
    const id = `sess_mail_${crypto.randomUUID()}`
    await store.createSession(session(id))
    expect(await drainAgentMail(store, id)).toEqual([])
    await enqueueAgentMail(store, id, 'one')
    await enqueueAgentMail(store, id, 'two')
    expect(await drainAgentMail(store, id)).toEqual(['one', 'two'])
    expect(await drainAgentMail(store, id)).toEqual([])
  })

  test('peek does not consume the queue', async () => {
    const store = createMemoryStore()
    const id = `sess_peek_${crypto.randomUUID()}`
    await store.createSession(session(id))
    await enqueueAgentMail(store, id, 'keep')
    expect(await peekAgentMail(store, id)).toEqual(['keep'])
    expect(await peekAgentMail(store, id)).toEqual(['keep'])
    expect(await drainAgentMail(store, id)).toEqual(['keep'])
    expect(await peekAgentMail(store, id)).toEqual([])
  })

  test('sessions are isolated', async () => {
    const store = createMemoryStore()
    const a = `sess_a_${crypto.randomUUID()}`
    const b = `sess_b_${crypto.randomUUID()}`
    await store.createSession(session(a))
    await store.createSession(session(b))
    await enqueueAgentMail(store, a, 'a-mail')
    await enqueueAgentMail(store, b, 'b-mail')
    expect(await drainAgentMail(store, a)).toEqual(['a-mail'])
    expect(await drainAgentMail(store, b)).toEqual(['b-mail'])
  })

  test('caps body at 4000 chars', async () => {
    const store = createMemoryStore()
    const id = `sess_cap_${crypto.randomUUID()}`
    await store.createSession(session(id))
    await enqueueAgentMail(store, id, 'x'.repeat(AGENT_MAIL_BODY_MAX + 80))
    const notices = await drainAgentMail(store, id)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.length).toBe(AGENT_MAIL_BODY_MAX)
  })

  test('two sqlite handles: enqueue on A, drain on B', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-mail-xproc-'))
    tempDirs.push(dir)
    const path = join(dir, 'state.db')
    const a = openSqlite(path)
    const id = `sess_x_${crypto.randomUUID()}`
    await a.createSession(session(id))
    await enqueueAgentMail(a, id, 'across')
    const b = openSqlite(path)
    expect(await drainAgentMail(b, id)).toEqual(['across'])
    expect(await drainAgentMail(a, id)).toEqual([])
  })

  test('MAX_PARALLEL_CHILDREN is 6', () => {
    expect(MAX_PARALLEL_CHILDREN).toBe(6)
  })
})
