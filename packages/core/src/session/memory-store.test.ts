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

  test('clearConversation wipes this session and keeps job, child, and rules', async () => {
    const store = createMemoryStore()
    const job = {
      baseBranch: 'main',
      shadowBranch: 'raven/s',
      baseCommitSha: 'abc123',
      worktreePath: '/tmp/wt',
      pendingResetSha: 'def456',
    }
    await store.createSession(
      session({
        permissionMode: 'acceptEdits',
        title: 'old title',
        followup: 'run tests',
        lastEnd: { reason: 'completed' },
        jobError: 'stale',
        todos: [{ text: 'ship', status: 'pending' }],
        usage: { input: 10, output: 4, cacheRead: 1, cacheWrite: 2 },
        job,
      }),
    )
    await store.createSession(session({ id: 'child', parentSessionId: 's1' }))
    await store.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hi' }],
      createdAt: 1,
    })
    await store.persistUser('child', {
      id: 'cu1',
      role: 'user',
      blocks: [{ type: 'text', text: 'child' }],
      createdAt: 2,
    })
    await store.upsertPendingAsk({
      callId: 'call_parent',
      sessionId: 's1',
      kind: 'leftover',
      tool: 'Bash',
      message: 'Bash?',
      input: {},
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_child',
      sessionId: 'child',
      kind: 'leftover',
      tool: 'Bash',
      message: 'Child?',
      input: {},
      createdAt: 2,
    })
    await store.appendStreamEvent('s1', { type: 'text_delta', text: 'x' })
    await store.appendStreamEvent('child', { type: 'text_delta', text: 'y' })
    await store.enqueueAgentMail('s1', 'old-mail')
    await store.setPermissionRules('s1', [
      { id: 'r1', sessionId: 's1', tool: 'Bash', spec: {}, behavior: 'allow' },
    ])
    await store.acquireSessionLock('s1', { holderId: 'a', holderName: 'tui' })

    const next = session({
      permissionMode: 'acceptEdits',
      compactGeneration: 1,
      todos: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      job,
      updatedAt: 99,
    })
    await store.clearConversation({ session: next, inactivatedIds: ['u1'], generation: 1 })

    const loaded = await store.loadSession('s1')
    expect(loaded.session.id).toBe('s1')
    expect(loaded.messages).toEqual([])
    expect(loaded.session.job).toEqual(job)
    expect(loaded.session.permissionMode).toBe('acceptEdits')
    expect(loaded.session.todos).toEqual([])
    expect(loaded.session.title).toBeUndefined()
    expect(loaded.session.followup).toBeUndefined()
    expect(loaded.session.lastEnd).toBeUndefined()
    expect(loaded.session.jobError).toBeUndefined()
    expect(loaded.session.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(loaded.session.compactGeneration).toBe(1)
    expect(await store.listPendingAsks('s1')).toEqual([])
    expect(await store.lastStreamSeq('s1')).toBe(0)
    expect(await store.peekAgentMail('s1')).toEqual([])
    expect(await store.listPendingAsks('child')).toHaveLength(1)
    expect(await store.lastStreamSeq('child')).toBe(1)
    const child = await store.loadSession('child')
    expect(child.messages.map((msg) => msg.id)).toEqual(['cu1'])
    expect(await store.listPermissionRules('s1')).toHaveLength(1)
    await expect(store.createSession(session())).rejects.toBeInstanceOf(PersistError)
    await expect(
      store.acquireSessionLock('s1', { holderId: 'b', holderName: 'serve' }),
    ).rejects.toMatchObject({ name: 'SessionLockError' })
    await store.releaseSessionLock('s1', 'a')
  })

  test('clearConversation with no ids skips the generation bump', async () => {
    const store = createMemoryStore()
    await store.createSession(session({ compactGeneration: 4 }))
    await store.clearConversation({
      session: session({ compactGeneration: 4, todos: [], updatedAt: 2 }),
      inactivatedIds: [],
      generation: 4,
    })
    const loaded = await store.loadSession('s1')
    expect(loaded.session.compactGeneration).toBe(4)
    expect(loaded.messages).toEqual([])
  })

  test('clearConversation throw leaves transcript, asks, and stream', async () => {
    const store = createMemoryStore()
    await store.createSession(
      session({
        lastEnd: { reason: 'completed' },
        todos: [{ text: 'keep', status: 'pending' }],
      }),
    )
    await store.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'keep' }],
      createdAt: 1,
    })
    await store.upsertPendingAsk({
      callId: 'call_keep',
      sessionId: 's1',
      kind: 'leftover',
      tool: 'Bash',
      message: 'Bash?',
      input: {},
      createdAt: 2,
    })
    await store.appendStreamEvent('s1', { type: 'text_delta', text: 'x' })
    const orig = store.drainAgentMail.bind(store)
    store.drainAgentMail = async (parentSessionId) => {
      await orig(parentSessionId)
      throw new Error('disk')
    }

    await expect(
      store.clearConversation({
        session: session({
          compactGeneration: 1,
          todos: [],
          updatedAt: 99,
        }),
        inactivatedIds: ['u1'],
        generation: 1,
      }),
    ).rejects.toBeInstanceOf(Error)

    const loaded = await store.loadSession('s1')
    expect(loaded.messages.map((msg) => msg.id)).toEqual(['u1'])
    expect(loaded.session.lastEnd).toEqual({ reason: 'completed' })
    expect(loaded.session.todos).toEqual([{ text: 'keep', status: 'pending' }])
    expect(await store.listPendingAsks('s1')).toHaveLength(1)
    expect(await store.lastStreamSeq('s1')).toBe(1)
  })

  test('recordCompactAndUpsertSession inactivates ids and sets pendingResetSha', async () => {
    const store = createMemoryStore()
    const job = {
      baseBranch: 'main',
      shadowBranch: 'raven/s',
      baseCommitSha: 'abc123',
      worktreePath: '/tmp/wt',
      pendingResetSha: 'def456',
    }
    await store.createSession(session({ job: { ...job, pendingResetSha: undefined } }))
    await store.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'drop' }],
      createdAt: 1,
    })
    await store.recordCompactAndUpsertSession({
      session: session({ job, compactGeneration: 1 }),
      inactivatedIds: ['u1'],
      generation: 1,
      summary: 'rewind',
    })
    const loaded = await store.loadSession('s1')
    expect(loaded.messages.map((msg) => msg.id)).toEqual([])
    expect(loaded.session.job?.pendingResetSha).toBe('def456')
  })

  test('recordCompactAndUpsertSession throw restores messages and unflagged job', async () => {
    const store = createMemoryStore()
    await store.createSession(
      session({
        job: {
          baseBranch: 'main',
          shadowBranch: 'raven/s',
          baseCommitSha: 'abc123',
          worktreePath: '/tmp/wt',
        },
      }),
    )
    await store.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'keep' }],
      createdAt: 1,
    })
    const exploding = session({
      job: {
        baseBranch: 'main',
        shadowBranch: 'raven/s',
        baseCommitSha: 'abc123',
        worktreePath: '/tmp/wt',
        pendingResetSha: 'def456',
      },
    })
    Object.defineProperty(exploding, 'updatedAt', {
      enumerable: true,
      get() {
        throw new Error('boom')
      },
    })
    await expect(
      store.recordCompactAndUpsertSession({
        session: exploding,
        inactivatedIds: ['u1'],
        generation: 1,
        summary: 'rewind',
      }),
    ).rejects.toBeInstanceOf(Error)
    const loaded = await store.loadSession('s1')
    expect(loaded.messages.map((msg) => msg.id)).toEqual(['u1'])
    expect(loaded.session.job?.pendingResetSha).toBeUndefined()
  })
})
