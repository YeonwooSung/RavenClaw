import { describe, expect, test } from 'bun:test'
import { PersistError, type Message, type SessionRecord } from '../types'
import { createMemoryStore } from './memory-store'

const INCOMPLETE_TEXT =
  'incomplete: the process ended before this tool result was saved. The tool was not re-run.'

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

describe('createMemoryStore', () => {
  test('lastEnd, jobError, and followup round-trip through upsertSession', async () => {
    const store = createMemoryStore()
    await store.createSession(
      session({
        lastEnd: { reason: 'cancelled' },
        jobError: 'git commit failed',
        followup: 'run tests',
      }),
    )
    const loaded = await store.loadSession('s1')
    expect(loaded.session.lastEnd).toEqual({ reason: 'cancelled' })
    expect(loaded.session.jobError).toBe('git commit failed')
    expect(loaded.session.followup).toBe('run tests')
    delete loaded.session.jobError
    delete loaded.session.followup
    loaded.session.lastEnd = { reason: 'completed' }
    await store.upsertSession(loaded.session)
    const again = await store.loadSession('s1')
    expect(again.session.lastEnd).toEqual({ reason: 'completed' })
    expect(again.session.jobError).toBeUndefined()
    expect(again.session.followup).toBeUndefined()
  })

  test('persistAssistant rejects tool_use; persistToolCalls rejects text-only', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    const withTools: Extract<Message, { role: 'assistant' }> = {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'c1', name: 'Echo', input: {} }],
      createdAt: 1,
    }
    const textOnly: Extract<Message, { role: 'assistant' }> = {
      id: 'a2',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hi' }],
      createdAt: 2,
    }
    await expect(store.persistAssistant('s1', withTools)).rejects.toBeInstanceOf(
      Error,
    )
    await expect(store.persistToolCalls('s1', textOnly)).rejects.toBeInstanceOf(
      Error,
    )
  })

  test('same assistant id cannot be written by both persist methods', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    const textOnly: Extract<Message, { role: 'assistant' }> = {
      id: 'same',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hi' }],
      createdAt: 1,
    }
    const withTools: Extract<Message, { role: 'assistant' }> = {
      id: 'same',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'c1', name: 'Echo', input: {} }],
      createdAt: 1,
    }
    await store.persistAssistant('s1', textOnly)
    await expect(store.persistToolCalls('s1', withTools)).rejects.toBeInstanceOf(
      Error,
    )
  })

  test('loadSession repairs unpaired tool_use and persists incomplete', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    await store.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }],
      createdAt: 1,
    })
    await store.persistToolCalls('s1', {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'c1', name: 'Echo', input: {} }],
      createdAt: 2,
    })
    const loaded = await store.loadSession('s1')
    const tool = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool',
    )
    expect(tool?.toolUseId).toBe('c1')
    expect(tool?.ok).toBe(false)
    expect(tool?.blocks[0]?.text).toBe(INCOMPLETE_TEXT)

    const again = await store.loadSession('s1')
    const tools = again.messages.filter((m) => m.role === 'tool')
    expect(tools).toHaveLength(1)
  })

  test('loadMessages does not persist incomplete for unpaired tool_use', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    await store.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }],
      createdAt: 1,
    })
    await store.persistToolCalls('s1', {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'tool_use', id: 'c1', name: 'Echo', input: {} }],
      createdAt: 2,
    })
    const messages = await store.loadMessages!('s1')
    expect(messages.some((m) => m.role === 'tool')).toBe(false)

    const again = await store.loadMessages!('s1')
    expect(again.filter((m) => m.role === 'tool')).toHaveLength(0)
  })

  test('recordCompact inactivates ids; loadSession returns only active', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    await store.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'old' }],
      createdAt: 1,
    })
    await store.persistUser('s1', {
      id: 'u2',
      role: 'user',
      blocks: [{ type: 'text', text: 'new' }],
      createdAt: 2,
    })
    await store.recordCompact('s1', 3, 'sum', ['u1'])
    const loaded = await store.loadSession('s1')
    expect(loaded.session.compactGeneration).toBe(3)
    expect(loaded.messages.map((m) => m.id)).toEqual(['u2'])
  })

  test('listSessions honors cwd, parentSessionId, and limit', async () => {
    const store = createMemoryStore()
    await store.createSession(session({ id: 'a', cwd: '/a', updatedAt: 3 }))
    await store.createSession(
      session({ id: 'b', cwd: '/b', updatedAt: 2, parentSessionId: 'a' }),
    )
    await store.createSession(session({ id: 'c', cwd: '/a', updatedAt: 1 }))

    const inA = await store.listSessions({ cwd: '/a' })
    expect(inA.map((s) => s.id)).toEqual(['a', 'c'])

    const children = await store.listSessions({ parentSessionId: 'a' })
    expect(children.map((s) => s.id)).toEqual(['b'])

    const roots = await store.listSessions({ parentSessionId: null })
    expect(roots.map((s) => s.id).sort()).toEqual(['a', 'c'])

    const limited = await store.listSessions({ cwd: '/a', limit: 1 })
    expect(limited.map((s) => s.id)).toEqual(['a'])
  })

  test('withWrite serializes writers and retries busy/locked once', async () => {
    const store = createMemoryStore()
    let busyCalls = 0
    const value = await store.withWrite(async () => {
      busyCalls += 1
      if (busyCalls === 1) throw new PersistError('busy', 'busy')
      return 7
    })
    expect(value).toBe(7)
    expect(busyCalls).toBe(2)

    await expect(
      store.withWrite(async () => {
        throw new PersistError('corrupt', 'nope')
      }),
    ).rejects.toMatchObject({ code: 'corrupt' })

    const order: number[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = store.withWrite(async () => {
      order.push(1)
      await gate
      order.push(2)
    })
    const second = store.withWrite(async () => {
      order.push(3)
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual([1])
    release()
    await Promise.all([first, second])
    expect(order).toEqual([1, 2, 3])
  })

  test('setPermissionRules / listPermissionRules are session-scoped', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    await store.setPermissionRules('s1', [
      { id: 'r1', sessionId: 's1', tool: 'Bash', spec: {}, behavior: 'ask' },
    ])
    const rules = await store.listPermissionRules('s1')
    expect(rules).toHaveLength(1)
    expect(rules[0]?.tool).toBe('Bash')
  })

  test('deleteSession removes the session and its children', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    await store.createSession(session({ id: 'child', parentSessionId: 's1' }))
    await store.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hi' }],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_keep',
      sessionId: 's1',
      kind: 'leftover',
      tool: 'Bash',
      message: 'Bash?',
      input: {},
      createdAt: 1,
    })
    await store.deleteSession('s1')
    await expect(store.loadSession('s1')).rejects.toBeInstanceOf(PersistError)
    await expect(store.loadSession('child')).rejects.toBeInstanceOf(PersistError)
    expect(await store.listSessions()).toEqual([])
    expect(await store.listPendingAsks('s1')).toEqual([])
    expect(await store.getPendingAsk('call_keep')).toBeUndefined()
  })

  test('mailbox is FIFO and session-isolated', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    await store.createSession(session({ id: 's2' }))
    await store.enqueueAgentMail('s1', 'one')
    await store.enqueueAgentMail('s1', 'two')
    await store.enqueueAgentMail('s2', 'other')
    expect(await store.peekAgentMail('s1')).toEqual(['one', 'two'])
    expect(await store.drainAgentMail('s1')).toEqual(['one', 'two'])
    expect(await store.drainAgentMail('s1')).toEqual([])
    expect(await store.drainAgentMail('s2')).toEqual(['other'])
  })

  test('session lock is exclusive until release or expiry', async () => {
    const store = createMemoryStore()
    await store.createSession(session())
    await store.acquireSessionLock('s1', { holderId: 'a', holderName: 'tui' })
    await expect(
      store.acquireSessionLock('s1', { holderId: 'b', holderName: 'serve' }),
    ).rejects.toMatchObject({ name: 'SessionLockError' })
    await store.releaseSessionLock('s1', 'a')
    await store.acquireSessionLock('s1', { holderId: 'b', holderName: 'serve' })
    await store.renewSessionLock('s1', 'b', 50)
    await store.releaseSessionLock('s1', 'b')
  })
})
