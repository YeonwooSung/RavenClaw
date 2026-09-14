import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createChatSessionHost } from './session-host'
import type { CliRuntime } from '../engine'

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
})
