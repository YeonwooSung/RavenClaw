import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionRecord, SessionStore, StreamEvent } from '../types'
import { createMemoryStore } from './memory-store'
import { createSqliteStore } from './sqlite-store'

type ClosableStore = SessionStore & { close?: () => void }

const tempDirs: string[] = []
const stores: ClosableStore[] = []

afterEach(() => {
  while (stores.length > 0) {
    const store = stores.pop()
    try {
      store?.close?.()
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

function openMemory(): SessionStore {
  const store = createMemoryStore()
  stores.push(store)
  return store
}

function openSqlite(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-stream-'))
  tempDirs.push(dir)
  const store = createSqliteStore(join(dir, 'state.db')) as ClosableStore
  stores.push(store)
  return store
}

const ask: Extract<StreamEvent, { type: 'permission_ask' }> = {
  type: 'permission_ask',
  id: 'c1',
  tool: 'Bash',
  input: {},
  message: '?',
}

describe.each([
  ['memory', openMemory],
  ['sqlite', openSqlite],
] as const)('stream events (%s)', (_name, open) => {
  test('append reuses seq for the same permission_ask callId', async () => {
    const store = open()
    await store.createSession(session())
    const event = {
      type: 'permission_ask' as const,
      id: 'c1',
      tool: 'Bash',
      input: {},
      message: '?',
    }
    const a = await store.appendStreamEvent('s1', event)
    const b = await store.appendStreamEvent('s1', event)
    expect(a).toBe(b)
    expect(await store.listStreamEventsAfter('s1', 0)).toHaveLength(1)
  })

  test('different permission_ask callIds and other events get new seqs', async () => {
    const store = open()
    await store.createSession(session())
    const first = await store.appendStreamEvent('s1', ask)
    const delta = await store.appendStreamEvent('s1', { type: 'text_delta', text: 'hi' })
    const otherAsk = await store.appendStreamEvent('s1', { ...ask, id: 'c2' })
    const cancelled = await store.appendStreamEvent('s1', {
      type: 'round_end',
      end: { reason: 'cancelled' },
    })
    const started = await store.appendStreamEvent('s1', {
      type: 'round_start',
      round: 1,
      turnId: 'turn-1',
    })
    expect([first, delta, otherAsk, cancelled, started]).toEqual([1, 2, 3, 4, 5])
    expect(await store.lastStreamSeq('s1')).toBe(5)
    const afterTwo = await store.listStreamEventsAfter('s1', 2)
    expect(afterTwo.map((event) => event.seq)).toEqual([3, 4, 5])
    expect(afterTwo[1]).toEqual({ seq: 4, type: 'round_end', end: { reason: 'cancelled' } })
    expect(afterTwo[2]).toEqual({ seq: 5, type: 'round_start', round: 1, turnId: 'turn-1' })
  })

  test('deleteSession drops the session stream_events', async () => {
    const store = open()
    await store.createSession(session())
    await store.appendStreamEvent('s1', { type: 'text_delta', text: 'keep' })
    await store.deleteSession('s1')
    expect(await store.listStreamEventsAfter('s1', 0)).toEqual([])
    expect(await store.lastStreamSeq('s1')).toBe(0)
  })
})
