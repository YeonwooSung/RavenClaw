import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { saveSessionMap } from '@ravenclaw/core'
import { createChatSessionHost } from './session-host'
import { createAskBridge, type CliRuntime } from '../engine'

function fakeRuntime(id: string, mode: 'default' | 'dontAsk' = 'default'): CliRuntime {
  const session = { id, permissionMode: mode }
  return {
    engine: {
      session,
      async setPermissionMode(next: 'default' | 'dontAsk') {
        session.permissionMode = next
      },
      async *submitMessage() {
        return { reason: 'completed' }
      },
      async close() {},
    },
    mcpCloser: async () => {},
    config: { permissionMode: mode },
    ask: {
      bind() {},
    },
  } as unknown as CliRuntime
}

describe('createChatSessionHost', () => {
  test('first key creates a session; the same key reuses the cached runtime', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-chat-host-'))
    const created: string[] = []
    const resumed: string[] = []
    const host = createChatSessionHost({
      home,
      shared: fakeRuntime('shared'),
      newId: () => 'sess_new',
      openNewSession: async (_boot, opts) => {
        created.push(opts?.sessionId ?? 'missing')
        return fakeRuntime(opts?.sessionId ?? 'missing')
      },
      resumeRuntime: async (_boot, sessionId) => {
        resumed.push(sessionId)
        return fakeRuntime(sessionId)
      },
    })
    const first = await host.openSession({
      sessionKey: 'slack:t:c:u',
      permissionMode: 'dontAsk',
      askUser: async () => 'deny',
    })
    const second = await host.openSession({
      sessionKey: 'slack:t:c:u',
      permissionMode: 'dontAsk',
      askUser: async () => 'deny',
    })
    expect(first.sessionId).toBe('sess_new')
    expect(second.sessionId).toBe('sess_new')
    expect(created).toEqual(['sess_new'])
    expect(resumed).toEqual([])
  })

  test('sets permissionMode when the opened session disagrees', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-chat-host-'))
    const host = createChatSessionHost({
      home,
      shared: fakeRuntime('shared'),
      newId: () => 'sess_mode',
      openNewSession: async () => fakeRuntime('sess_mode', 'default'),
      resumeRuntime: async (_boot, id) => fakeRuntime(id),
    })
    const bound = await host.openSession({
      sessionKey: 'k',
      permissionMode: 'dontAsk',
      askUser: async () => 'deny',
    })
    expect(bound.sessionId).toBe('sess_mode')
    const cached = host.engines.get('sess_mode')
    expect(cached?.engine.session.permissionMode).toBe('dontAsk')
  })

  test('session host replays pending asks after resumeRuntime', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-chat-host-replay-'))
    const existingSessionId = 'sess_existing'
    saveSessionMap({ 'resume-key': existingSessionId }, home)
    let replayed = 0
    const host = createChatSessionHost({
      home,
      shared: fakeRuntime('shared'),
      resumeRuntime: async () => {
        const runtime = fakeRuntime(existingSessionId)
        runtime.engine.replayPendingAsks = async function* () {
          replayed += 1
        }
        return runtime
      },
    })
    await host.openSession({
      sessionKey: 'resume-key',
      permissionMode: 'default',
      askUser: async () => 'deny',
    })
    expect(replayed).toBe(1)
  })

  test('replay abort can re-ask on the next openSession', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-chat-host-replay-abort-'))
    const existingSessionId = 'sess_replay_abort'
    saveSessionMap({ 'resume-key': existingSessionId }, home)
    let replayed = 0
    const host = createChatSessionHost({
      home,
      shared: fakeRuntime('shared'),
      resumeRuntime: async () => {
        const runtime = fakeRuntime(existingSessionId)
        runtime.engine.replayPendingAsks = async function* () {
          replayed += 1
          if (replayed === 1) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' })
          }
        }
        return runtime
      },
    })
    await expect(
      host.openSession({
        sessionKey: 'resume-key',
        permissionMode: 'default',
        askUser: async () => 'deny',
      }),
    ).rejects.toThrow('aborted')
    await host.openSession({
      sessionKey: 'resume-key',
      permissionMode: 'default',
      askUser: async () => 'deny',
    })
    expect(replayed).toBe(2)
  })

  test('ask bind forwards childSessionId to the session askUser', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-chat-host-child-ask-'))
    const ask = createAskBridge()
    const shared = fakeRuntime('shared')
    shared.ask = ask
    const seen: Array<string | undefined> = []
    const host = createChatSessionHost({
      home,
      shared,
      newId: () => 'sess_parent',
      openNewSession: async () => {
        const runtime = fakeRuntime('sess_parent')
        runtime.ask = ask
        runtime.engine.submitMessage = async function* () {
          await ask.ask(
            {
              type: 'permission_ask',
              id: 'call_1',
              tool: 'Bash',
              input: { command: 'ls' },
              message: 'child bash?',
              childSessionId: 'sess_child',
            },
            new AbortController().signal,
          )
          return { reason: 'completed' }
        }
        return runtime
      },
    })
    const bound = await host.openSession({
      sessionKey: 'k',
      permissionMode: 'default',
      askUser: async (event) => {
        seen.push(event.childSessionId)
        return 'deny'
      },
    })
    const gen = bound.submitMessage('go')
    while (!(await gen.next()).done) {
      // drain
    }
    expect(seen).toEqual(['sess_child'])
  })
})
