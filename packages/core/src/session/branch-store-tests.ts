import { describe, expect, test } from 'bun:test'
import { PersistError, type Message, type SessionRecord, type SessionStore } from '../types'

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

function user(
  id: string,
  createdAtOrText: number | string,
  createdAt?: number,
): Extract<Message, { role: 'user' }> {
  if (typeof createdAtOrText === 'number') {
    return { id, role: 'user', blocks: [{ type: 'text', text: id }], createdAt: createdAtOrText }
  }
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: createdAtOrText }],
    createdAt: createdAt ?? 0,
  }
}

function assistant(id: string, text: string, createdAt: number): Extract<Message, { role: 'assistant' }> {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], createdAt }
}

function tool(id: string, createdAt: number): Extract<Message, { role: 'tool' }> {
  return {
    id,
    role: 'tool',
    toolUseId: `call-${id}`,
    ok: true,
    blocks: [{ type: 'text', text: id }],
    createdAt,
  }
}

async function ids(store: SessionStore, sessionId: string): Promise<string[]> {
  return (await store.loadMessages!(sessionId)).map((msg) => msg.id)
}

export function registerBranchStoreTests(open: () => SessionStore): void {
  describe('message parent and leaf', () => {
    test('appended messages form one path and branchAt keeps the other tip', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('a', 1))
      await store.persistUser('s1', user('b', 2))
      await store.persistUser('s1', user('c', 3))
      expect(await ids(store, 's1')).toEqual(['a', 'b', 'c'])
      expect(await store.branchAt('s1', 'b')).toMatchObject([{ id: 'a' }, { id: 'b' }])
      await store.branchAt('s1', 'a')
      await store.persistUser('s1', user('d', 4))
      expect(await ids(store, 's1')).toEqual(['a', 'd'])
      expect((await store.listActiveMessageIds('s1')).sort()).toEqual(['a', 'b', 'c', 'd'])
      expect(await store.branchAt('s1', 'c')).toMatchObject([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    })

    test('branchAt rejects an inactive message and leaves the leaf', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('a', 1))
      await store.persistUser('s1', user('b', 2))
      await store.recordCompact('s1', 1, 'rewind', ['b'])
      await expect(store.branchAt('s1', 'b')).rejects.toThrow('message is not on this session')
      expect(await ids(store, 's1')).toEqual(['a'])
    })

    test('branchAt rejects a message from another session', async () => {
      const store = open()
      await store.createSession(session())
      await store.createSession(session({ id: 's2' }))
      await store.persistUser('s1', user('a', 1))
      await store.persistUser('s2', user('z', 1))
      await expect(store.branchAt('s1', 'z')).rejects.toThrow('message is not on this session')
      expect(await ids(store, 's1')).toEqual(['a'])
    })

    test('upsertSession does not change the leaf path', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('a', 1))
      await store.persistUser('s1', user('b', 2))
      const loaded = await store.loadSession('s1')
      await store.upsertSession({ ...loaded.session, title: 'renamed', updatedAt: 9 })
      expect(await ids(store, 's1')).toEqual(['a', 'b'])
      const again = await store.loadSession('s1')
      expect(again.session.title).toBe('renamed')
    })

    test('tool results chain in argument order', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('u', 1))
      await store.persistToolResults('s1', [tool('t1', 2), tool('t2', 3)])
      expect(await store.branchAt('s1', 't1')).toMatchObject([{ id: 'u' }, { id: 't1' }])
      expect(await store.branchAt('s1', 't2')).toMatchObject([{ id: 'u' }, { id: 't1' }, { id: 't2' }])
    })

    test('rewriting an assistant row does not move the leaf', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('u', 1))
      await store.persistAssistant('s1', assistant('a', 'first', 2))
      await store.persistAssistant('s1', assistant('a', 'second', 2))
      await store.persistUser('s1', user('v', 3))
      const loaded = await store.loadMessages!('s1')
      expect(loaded.map((msg) => msg.id)).toEqual(['u', 'a', 'v'])
      expect(loaded[1]).toMatchObject({ role: 'assistant', blocks: [{ type: 'text', text: 'second' }] })
    })

    test('inactivating the tail moves the leaf to the active ancestor', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('a', 1))
      await store.persistUser('s1', user('b', 2))
      await store.recordCompact('s1', 1, 'rewind', ['b'])
      expect(await ids(store, 's1')).toEqual(['a'])
    })

    test('inactivating a shared prefix hides it from the other branch', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('a', 1))
      await store.persistUser('s1', user('b', 2))
      await store.persistUser('s1', user('c', 3))
      await store.branchAt('s1', 'a')
      await store.persistUser('s1', user('d', 4))
      await store.recordCompact('s1', 1, 'sum', ['a'])
      expect(await ids(store, 's1')).toEqual(['d'])
      expect((await store.branchAt('s1', 'c')).map((msg) => msg.id)).toEqual(['b', 'c'])
    })

    test('splice keeps a shared prefix on the other branch', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('a', 1))
      await store.persistUser('s1', user('b', 2))
      await store.persistUser('s1', user('c', 3))
      await store.branchAt('s1', 'a')
      await store.persistUser('s1', user('d', 4))
      const summaryId = 'summary'
      await store.spliceCompactPath('s1', {
        generation: 1,
        summaryText: 'sum',
        inserted: [user(summaryId, 'sum', 10)],
        boundaryId: null,
      })
      expect(await ids(store, 's1')).toEqual([summaryId])
      expect((await store.branchAt('s1', 'c')).map((msg) => msg.id)).toEqual(['a', 'b', 'c'])
      const active = await store.listActiveMessageIds('s1')
      expect(active).toContain('a')
      expect(active).toContain('d')
      const nodes = await store.listBranchNodes('s1')
      expect(nodes.find((node) => node.message.id === summaryId)?.parentId).toBeNull()
    })

    test('splice reparents only the first tail row', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('u0', 1))
      await store.persistAssistant('s1', assistant('a0', 'a0', 2))
      await store.persistUser('s1', user('u1', 3))
      await store.persistAssistant('s1', assistant('a1', 'a1', 4))
      const stubId = 'stub'
      const summaryId = 'summary'
      await store.spliceCompactPath('s1', {
        generation: 1,
        summaryText: 'sum',
        inserted: [
          assistant(stubId, '(conversation summary follows)', 10),
          user(summaryId, 'sum', 11),
        ],
        boundaryId: 'u1',
      })
      expect(await ids(store, 's1')).toEqual([stubId, summaryId, 'u1', 'a1'])
      const nodes = await store.listBranchNodes('s1')
      const parentOf = (id: string) => nodes.find((node) => node.message.id === id)?.parentId
      expect(parentOf(stubId)).toBeNull()
      expect(parentOf(summaryId)).toBe(stubId)
      expect(parentOf('u1')).toBe(summaryId)
      expect((await store.loadSession('s1')).session.leafId).toBe('a1')
      const active = await store.listActiveMessageIds('s1')
      expect(active).toContain('u0')
      expect(active).toContain('a0')
      expect(parentOf('a0')).toBe('u0')
    })

    test('splice refuses a boundary another branch walks through', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('a', 1))
      await store.persistUser('s1', user('b', 2))
      await store.persistUser('s1', user('c', 3))
      await store.branchAt('s1', 'b')
      await store.persistUser('s1', user('d', 4))
      await expect(
        store.spliceCompactPath('s1', {
          generation: 1,
          summaryText: 'sum',
          inserted: [user('summary', 'sum', 10)],
          boundaryId: 'b',
        }),
      ).rejects.toThrow('compact would move another branch')
      expect(await ids(store, 's1')).toEqual(['a', 'b', 'd'])
      expect((await store.loadSession('s1')).session.compactGeneration).toBe(0)
      const nodes = await store.listBranchNodes('s1')
      expect(nodes.find((node) => node.message.id === 'b')?.parentId).toBe('a')
    })

    test('splice rejects a boundary off the leaf path', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('a', 1))
      await store.persistUser('s1', user('b', 2))
      await expect(
        store.spliceCompactPath('s1', {
          generation: 1,
          summaryText: 'sum',
          inserted: [user('summary', 'sum', 10)],
          boundaryId: 'missing',
        }),
      ).rejects.toThrow('compact boundary is not on this path')
      expect(await ids(store, 's1')).toEqual(['a', 'b'])
    })

    test('second splice of the same generation rolls back', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('a', 1))
      const summaryId = 'summary-1'
      await store.spliceCompactPath('s1', {
        generation: 1,
        summaryText: 'sum',
        inserted: [user(summaryId, 'sum', 10)],
        boundaryId: null,
      })
      await expect(
        store.spliceCompactPath('s1', {
          generation: 1,
          summaryText: 'again',
          inserted: [user('summary-2', 'again', 11)],
          boundaryId: null,
        }),
      ).rejects.toThrow('compact generation already used')
      expect(await ids(store, 's1')).toEqual([summaryId])
      expect((await store.loadSession('s1')).session.compactGeneration).toBe(1)
      expect(await store.listActiveMessageIds('s1')).not.toContain('summary-2')
    })

    test('invalid compact splice', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('a', 1))
      await expect(
        store.spliceCompactPath('s1', {
          generation: 1,
          summaryText: 'sum',
          inserted: [],
          boundaryId: null,
        }),
      ).rejects.toThrow('invalid compact splice')
      expect(await ids(store, 's1')).toEqual(['a'])
      expect((await store.loadSession('s1')).session.leafId).toBe('a')
    })

    test('clearConversation of every active id clears both branches', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('a', 1))
      await store.persistUser('s1', user('b', 2))
      await store.branchAt('s1', 'a')
      await store.persistUser('s1', user('d', 3))
      const active = await store.listActiveMessageIds('s1')
      const loaded = await store.loadSession('s1')
      await store.clearConversation({
        session: { ...loaded.session, updatedAt: 9 },
        inactivatedIds: active,
        generation: 1,
      })
      expect(await ids(store, 's1')).toEqual([])
      expect(await store.listActiveMessageIds('s1')).toEqual([])
      expect((await store.loadSession('s1')).session.leafId).toBeUndefined()
    })

    test('lists active nodes with parents and skips inactive rows', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('a', 1))
      await store.persistUser('s1', user('b', 2))
      await store.persistUser('s1', user('c', 3))
      await store.branchAt('s1', 'a')
      await store.persistUser('s1', user('d', 4))
      await store.recordCompact('s1', 1, 'sum', ['c'])
      const nodes = await store.listBranchNodes('s1')
      expect(
        nodes.map((node) => ({
          id: node.message.id,
          parentId: node.parentId,
          role: node.message.role,
        })),
      ).toEqual([
        { id: 'a', parentId: null, role: 'user' },
        { id: 'b', parentId: 'a', role: 'user' },
        { id: 'd', parentId: 'a', role: 'user' },
      ])
      for (const node of nodes) {
        expect('parentId' in node.message).toBe(false)
      }
    })

    test('orders equal createdAt by id', async () => {
      const store = open()
      await store.createSession(session())
      await store.persistUser('s1', user('m', 5))
      await store.persistUser('s1', user('a', 5))
      const nodes = await store.listBranchNodes('s1')
      expect(nodes.map((node) => node.message.id)).toEqual(['a', 'm'])
    })

    test('missing session', async () => {
      const store = open()
      const error = await store.listBranchNodes('missing').catch((err: unknown) => err)
      expect(error).toBeInstanceOf(PersistError)
      expect(error).toMatchObject({ message: 'session not found: missing' })
    })
  })
}
