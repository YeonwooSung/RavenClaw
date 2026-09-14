import { describe, expect, test } from 'bun:test'
import {
  createFileHistory,
  createTaskRegistry,
  type SessionEngine,
  type SessionRecord,
} from '@ravenclaw/core'
import { SLASH_HELP, type SlashResult } from '../commands'
import { type CliRuntime } from '../engine'
import { dispatchSharedSlash, type SlashHost } from './dispatch'

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_dispatch',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/proj',
    model: 'dummy',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

function fakeEngine(session: SessionRecord): SessionEngine & { reloads: number } {
  const reloads = { n: 0 }
  const engine = {
    get session() {
      return session
    },
    tasks: createTaskRegistry(),
    fileHistory: createFileHistory(session.id),
    enqueueSteer() {},
    drainSteering() {
      return []
    },
    bindDrainQueued() {},
    async rewindLast() {
      return { ok: false, notice: 'nothing to rewind' }
    },
    async *submitMessage() {
      return { reason: 'completed' as const }
    },
    async compactNow() {},
    async setModel(profile) {
      session.model = profile.id
    },
    async setPermissionMode() {},
    reloadSystem() {
      reloads.n += 1
    },
    abort() {},
    async close() {},
    get reloads() {
      return reloads.n
    },
  }
  return engine as SessionEngine & { reloads: number }
}

function fakeRuntime(engine: SessionEngine): CliRuntime {
  return {
    engine,
    store: {
      async listSessions() {
        return []
      },
      async upsertSession() {},
      async loadSession(sessionId: string) {
        return { session: makeSession({ id: sessionId }), messages: [] }
      },
      async listPermissionRules() {
        return []
      },
      async enqueueAgentMail() {},
      async peekAgentMail() {
        return []
      },
      async drainAgentMail() {
        return []
      },
      async acquireSessionLock() {},
      async renewSessionLock() {},
      async releaseSessionLock() {},
    },
    cwd: '/proj',
    config: {
      ads: { feedUrl: '' },
      profile: { id: 'dummy' },
      home: '/tmp/ravenclaw-home-dispatch',
      model: 'dummy',
      mcp: { servers: [] },
    },
    lockHolderId: 'holder-dispatch',
    lockHolderName: 'tui',
  } as CliRuntime
}

function cmd(name: string, arg?: string): Extract<SlashResult, { type: 'command' }> {
  const parsed: Extract<SlashResult, { type: 'command' }> = { type: 'command', name }
  if (arg !== undefined) parsed.arg = arg
  return parsed
}

function fakeHost(runtime: CliRuntime): SlashHost & { notices: string[]; turns: string[] } {
  const notices: string[] = []
  const turns: string[] = []
  return {
    notices,
    turns,
    runtime: () => runtime,
    notice(text) {
      notices.push(text)
    },
    runTurn(prompt) {
      turns.push(prompt)
    },
  }
}

describe('dispatchSharedSlash', () => {
  test('help is handled and prints the shared list', async () => {
    const host = fakeHost(fakeRuntime(fakeEngine(makeSession())))
    const result = await dispatchSharedSlash(cmd('help'), host)
    expect(result).toBe('handled')
    expect(host.notices[0]).toBe(SLASH_HELP)
  })

  test('model with an id reloads config.profile for the next turn', async () => {
    const runtime = fakeRuntime(fakeEngine(makeSession({ model: 'dummy' })))
    const host = fakeHost(runtime)
    expect(await dispatchSharedSlash(cmd('model', 'claude-sonnet-5'), host)).toBe('handled')
    expect(runtime.engine.session.model).toBe('claude-sonnet-5')
    expect(runtime.config.model).toBe('claude-sonnet-5')
    expect(runtime.config.profile.id).toBe('claude-sonnet-5')
    expect(runtime.config.profile.contextWindow).toBe(1_000_000)
    expect(runtime.config.profile.supportsThinking).toBe(true)
    expect(host.notices).toEqual(['model claude-sonnet-5'])
  })

  test('quit is left to the host', async () => {
    const host = fakeHost(fakeRuntime(fakeEngine(makeSession())))
    expect(await dispatchSharedSlash(cmd('quit'), host)).toBe('host')
    expect(host.notices).toEqual([])
  })

  test('add-dir empty and with a path use the Ink notice strings', async () => {
    const host = fakeHost(fakeRuntime(fakeEngine(makeSession())))
    expect(await dispatchSharedSlash(cmd('add-dir'), host)).toBe('handled')
    expect(await dispatchSharedSlash(cmd('add-dir', '../pkg'), host)).toBe('handled')
    expect(host.notices).toEqual([
      'usage: /add-dir <path> — this slash does not add a root; use the AddDir tool or --add-dir',
      'this slash does not add a root; use the AddDir tool or --add-dir: ../pkg',
    ])
  })

  test('effort empty and high use the hint-only strings', async () => {
    const host = fakeHost(fakeRuntime(fakeEngine(makeSession())))
    expect(await dispatchSharedSlash(cmd('effort'), host)).toBe('handled')
    expect(await dispatchSharedSlash(cmd('effort', 'high'), host)).toBe('handled')
    expect(host.notices).toEqual([
      'usage: /effort low|medium|high|max — hint only; does not persist (use --effort)',
      'effort high (hint only; does not persist — use --effort)',
    ])
  })

  test('agents and hooks are handled', async () => {
    const host = fakeHost(fakeRuntime(fakeEngine(makeSession())))
    expect(await dispatchSharedSlash(cmd('agents'), host)).toBe('handled')
    expect(await dispatchSharedSlash(cmd('hooks'), host)).toBe('handled')
    expect(host.notices[0]).toContain('general')
    expect(host.notices[1]).toContain('PreToolUse')
  })

  test('skills disable reloads the system', async () => {
    const engine = fakeEngine(makeSession())
    const host = fakeHost(fakeRuntime(engine))
    const result = await dispatchSharedSlash(cmd('skills', 'disable missing-skill'), host)
    expect(result).toBe('handled')
    expect(engine.reloads).toBe(1)
    expect(host.notices[0]).toBe('disabled missing-skill')
  })

  test('unknown command is handled with a notice', async () => {
    const host = fakeHost(fakeRuntime(fakeEngine(makeSession())))
    expect(await dispatchSharedSlash(cmd('foo'), host)).toBe('handled')
    expect(host.notices).toEqual(['unknown command: /foo'])
  })
})
