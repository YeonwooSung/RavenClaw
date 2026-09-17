import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  createFileHistory,
  createTaskRegistry,
  type SessionEngine,
  type SessionJob,
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

function fakeHost(
  runtime: CliRuntime,
  over: Partial<SlashHost> = {},
): SlashHost & { notices: string[]; turns: string[]; ghCalls: string[][] } {
  const notices: string[] = []
  const turns: string[] = []
  const ghCalls: string[][] = []
  return {
    notices,
    turns,
    ghCalls,
    runtime: () => runtime,
    notice(text) {
      notices.push(text)
    },
    runTurn(prompt) {
      turns.push(prompt)
    },
    gh(args) {
      ghCalls.push(args)
      return { ok: true, stdout: 'https://github.com/o/r/pull/4\n', stderr: '' }
    },
    ...over,
  }
}

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempGitRepo(dirty = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-dispatch-pr-'))
  tempDirs.push(dir)
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    expect(result.status).toBe(0)
  }
  run(['init'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['commit', '--allow-empty', '-m', 'init'])
  if (dirty) writeFileSync(join(dir, 'dirty.txt'), 'x\n')
  return dir
}

function jobAt(cwd: string): SessionJob {
  return {
    baseBranch: 'main',
    shadowBranch: 'raven/x',
    baseCommitSha: 'abc',
    worktreePath: cwd,
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

  test('steer enqueues and aborts the live turn', async () => {
    const steered: string[] = []
    let abortCalls = 0
    const engine = fakeEngine(makeSession())
    engine.enqueueSteer = (text) => {
      steered.push(text)
    }
    engine.abort = () => {
      abortCalls += 1
    }
    const host = fakeHost(fakeRuntime(engine))
    expect(await dispatchSharedSlash(cmd('steer', 'keep going'), host)).toBe('handled')
    expect(steered).toEqual(['keep going'])
    expect(abortCalls).toBe(1)
    expect(host.notices).toEqual(['steered (next round)'])
  })

  test('unknown command is handled with a notice', async () => {
    const host = fakeHost(fakeRuntime(fakeEngine(makeSession())))
    expect(await dispatchSharedSlash(cmd('foo'), host)).toBe('handled')
    expect(host.notices).toEqual(['unknown command: /foo'])
  })

  test('/job commit on flips jobAutoCommit and upserts', async () => {
    const session = makeSession()
    const runtime = fakeRuntime(fakeEngine(session))
    const upserted: SessionRecord[] = []
    runtime.store.upsertSession = async (next) => {
      upserted.push(next)
    }
    const host = fakeHost(runtime)
    expect(await dispatchSharedSlash(cmd('job', 'commit on'), host)).toBe('handled')
    expect(session.jobAutoCommit).toBe(true)
    expect(upserted).toHaveLength(1)
    expect(upserted[0]?.jobAutoCommit).toBe(true)
    expect(host.notices).toEqual(['job commit on'])
  })

  test('/job commit off flips jobAutoCommit and upserts', async () => {
    const session = makeSession({ jobAutoCommit: true })
    const runtime = fakeRuntime(fakeEngine(session))
    const upserted: SessionRecord[] = []
    runtime.store.upsertSession = async (next) => {
      upserted.push(next)
    }
    const host = fakeHost(runtime)
    expect(await dispatchSharedSlash(cmd('job', 'commit off'), host)).toBe('handled')
    expect(session.jobAutoCommit).toBe(false)
    expect(upserted).toHaveLength(1)
    expect(upserted[0]?.jobAutoCommit).toBe(false)
    expect(host.notices).toEqual(['job commit off'])
  })

  test('/pr without a job record notices and does not invoke gh', async () => {
    const host = fakeHost(fakeRuntime(fakeEngine(makeSession())))
    expect(await dispatchSharedSlash(cmd('pr'), host)).toBe('handled')
    expect(host.notices).toEqual(['no job record'])
    expect(host.ghCalls).toEqual([])
    expect(host.turns).toEqual([])
  })

  test('/pr on a dirty worktree notices and does not invoke gh', async () => {
    const cwd = tempGitRepo(true)
    const session = makeSession({ cwd, job: jobAt(cwd) })
    const runtime = fakeRuntime(fakeEngine(session))
    runtime.cwd = cwd
    const host = fakeHost(runtime)
    expect(await dispatchSharedSlash(cmd('pr'), host)).toBe('handled')
    expect(host.notices).toEqual(['worktree is dirty'])
    expect(host.ghCalls).toEqual([])
    expect(host.turns).toEqual([])
  })
})

