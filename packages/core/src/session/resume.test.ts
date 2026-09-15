import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, SessionRecord, SessionStore } from '../types'
import { INCOMPLETE_TEXT } from '../loop/pairing'
import { resumeSession } from './resume'
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

function openStore(): ClosableStore {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-resume-'))
  tempDirs.push(dir)
  const store = createSqliteStore(join(dir, 'state.db')) as ClosableStore
  stores.push(store)
  return store
}

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

describe('resumeSession', () => {
  test('execute succeeds, result INSERT fails, resume does not run Bash again', async () => {
    const store = openStore()
    await store.createSession(session())
    await store.persistUser('s1', {
      id: 'u1',
      role: 'user',
      blocks: [{ type: 'text', text: 'run it' }],
      createdAt: 1,
    })
    await store.persistToolCalls('s1', {
      id: 'a1',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          id: 'bash-1',
          name: 'Bash',
          input: { command: 'echo hi' },
        },
      ],
      createdAt: 2,
    })

    const execute = mock(async () => {
      throw new Error('Bash must not run on resume')
    })

    const loaded = await resumeSession(store, 's1')
    const tool = loaded.messages.find(
      (m): m is Extract<Message, { role: 'tool' }> =>
        m.role === 'tool' && m.toolUseId === 'bash-1',
    )
    expect(tool).toBeDefined()
    expect(tool?.ok).toBe(false)
    expect(tool?.blocks[0]?.text).toBe(INCOMPLETE_TEXT)
    expect(execute).not.toHaveBeenCalled()

    const again = await resumeSession(store, 's1')
    expect(again.messages.filter((m) => m.role === 'tool')).toHaveLength(1)
    expect(execute).not.toHaveBeenCalled()
  })

  test('asserts pairing after loadSession', async () => {
    const store = {
      async loadSession() {
        return {
          session: session(),
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              blocks: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }],
              createdAt: 1,
            },
          ] satisfies Message[],
        }
      },
    } as SessionStore
    await expect(resumeSession(store, 's1')).rejects.toBeInstanceOf(Error)
  })

  test('resumeSession allows unpaired tool_use that is a pending ask', async () => {
    const store = {
      async loadSession() {
        return {
          session: session(),
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              blocks: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }],
              createdAt: 1,
            },
          ] satisfies Message[],
        }
      },
      async listPendingAsks() {
        return [
          {
            callId: 'c1',
            sessionId: 's1',
            kind: 'leftover' as const,
            tool: 'Bash',
            message: 'Bash?',
            input: {},
            createdAt: 1,
          },
        ]
      },
    } as SessionStore
    await expect(resumeSession(store, 's1')).resolves.toBeTruthy()
  })

  test('resumeSession allows unpaired Agent when a child session has a pending ask', async () => {
    const store = {
      async loadSession() {
        return {
          session: session(),
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              blocks: [{ type: 'tool_use', id: 'agent_1', name: 'Agent', input: { prompt: 'x' } }],
              createdAt: 1,
            },
          ] satisfies Message[],
        }
      },
      async listPendingAsks(sessionId: string) {
        if (sessionId !== 'child') return []
        return [
          {
            callId: 'child_call',
            sessionId: 'child',
            kind: 'leftover' as const,
            tool: 'Bash',
            message: 'Bash?',
            input: {},
            createdAt: 1,
          },
        ]
      },
      async listSessions() {
        return [session({ id: 'child', parentSessionId: 's1' })]
      },
    } as unknown as SessionStore
    await expect(resumeSession(store, 's1')).resolves.toBeTruthy()
  })
})
