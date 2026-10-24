import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  createFileHistory,
  createTaskRegistry,
  type Message,
  type SessionBranchNode,
  type SessionEngine,
  type SessionJob,
  type SessionRecord,
  type SessionStore,
} from '@ravenclaw/core'
import { formatBranchNotice } from '../branch-cmd'
import { CREW_LIST_NOTICE, formatCrewTurn, SLASH_HELP, type SlashResult } from '../commands'
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
    async maybeFinishRewindReset() {
      return { ran: false, ok: true }
    },
    async whenTreeStop() {
      return { descendantWork: false, thisSessionWork: false }
    },
    async clearKeepId() {
      return { ok: true as const, notice: 'session cleared' }
    },
    async *submitMessage() {
      return { reason: 'completed' as const }
    },
    async compactNow() {},
    async setModel(profile) {
      session.model = profile.id
    },
    async setPermissionMode() {},
    setInstructionFiles() {},
    reloadSystem() {
      reloads.n += 1
    },
    abort() {},
    async close() {},
    async setFollowup(text: string) {
      const trimmed = text.trim()
      if (trimmed === '') return { ok: false as const, notice: 'follow-up text required' }
      session.followup = trimmed
      return { ok: true as const }
    },
    async clearFollowup() {
      delete session.followup
    },
    getFollowup() {
      return session.followup ?? null
    },
    get reloads() {
      return reloads.n
    },
  }
  return engine as SessionEngine & { reloads: number }
}

function fakeRuntime(engine: SessionEngine, store: Partial<SessionStore> = {}): CliRuntime {
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
      ...store,
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

function textMessage(id: string, role: 'user' | 'assistant', text: string): Message {
  return { id, role, blocks: [{ type: 'text', text }], createdAt: 1 }
}

const branchU1 = textMessage('u1', 'user', 'one')
const branchA1 = textMessage('a1', 'assistant', 'two')
const branchU2 = textMessage('u2', 'user', 'three')
const branchOld = textMessage('old', 'user', 'tip')
const branchPath = [branchU1, branchA1, branchU2]

function pathNodes(path: Message[], extras: SessionBranchNode[] = []): SessionBranchNode[] {
  const nodes: SessionBranchNode[] = []
  for (let index = 0; index < path.length; index += 1) {
    const message = path[index]
    if (message === undefined) continue
    const prev = path[index - 1]
    nodes.push({ message, parentId: prev === undefined ? null : prev.id })
  }
  return nodes.concat(extras)
}

const branchNodes: SessionBranchNode[] = [
  { message: branchU1, parentId: null },
  { message: branchA1, parentId: 'u1' },
  { message: branchU2, parentId: 'inactive' },
  { message: branchOld, parentId: 'u1' },
]

function branchHarness(
  opts: {
    path?: Message[]
    nodes?: SessionBranchNode[]
    loadMessages?: (sessionId: string) => Promise<Message[]>
    listBranchNodes?: (sessionId: string) => Promise<SessionBranchNode[]>
    branchAt?: SessionEngine['branchAt']
  } = {},
) {
  const path = opts.path ?? branchPath
  const nodes = opts.nodes ?? (opts.path === undefined ? branchNodes : pathNodes(path))
  const ids: string[] = []
  const branched: Message[][] = []
  const counts = { loads: 0, lists: 0, sessionIds: [] as string[] }
  const engine = fakeEngine(makeSession())
  engine.branchAt = async (id: string) => {
    ids.push(id)
    if (opts.branchAt) return opts.branchAt(id)
    return { ok: true as const, messages: path }
  }
  const runtime = fakeRuntime(engine, {
    async loadMessages(sessionId: string) {
      counts.loads += 1
      counts.sessionIds.push(sessionId)
      if (opts.loadMessages) return opts.loadMessages(sessionId)
      return path
    },
    async listBranchNodes(sessionId: string) {
      counts.lists += 1
      if (opts.listBranchNodes) return opts.listBranchNodes(sessionId)
      return nodes
    },
  })
  const host = fakeHost(runtime, {
    onBranched(messages) {
      branched.push(messages)
    },
  })
  return { runtime, host, ids, branched, counts, engine }
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
  test('/undo awaits fileHistory.undo and prints the notice', async () => {
    const session = makeSession()
    const engine = fakeEngine(session)
    let resolved = false
    engine.fileHistory.undo = async () => {
      await Promise.resolve()
      resolved = true
      return { restored: ['a.txt'], removed: [] }
    }
    const host = fakeHost(fakeRuntime(engine))
    const result = await dispatchSharedSlash(cmd('undo'), host)
    expect(result).toBe('handled')
    expect(resolved).toBe(true)
    expect(host.notices[0]).toBe('undo: restored 1')
  })

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

  test('/follow with no arg prints no follow-up or the text', async () => {
    const session = makeSession()
    const engine = fakeEngine(session)
    const host = fakeHost(fakeRuntime(engine))
    expect(await dispatchSharedSlash(cmd('follow'), host)).toBe('handled')
    expect(host.notices).toEqual(['no follow-up'])

    session.followup = 'run tests'
    host.notices.length = 0
    expect(await dispatchSharedSlash(cmd('follow'), host)).toBe('handled')
    expect(host.notices).toEqual(['run tests'])
  })

  test('/follow clear clears the slot', async () => {
    const session = makeSession({ followup: 'run tests' })
    const engine = fakeEngine(session)
    const host = fakeHost(fakeRuntime(engine))
    expect(await dispatchSharedSlash(cmd('follow', 'clear'), host)).toBe('handled')
    expect(session.followup).toBeUndefined()
    expect(engine.getFollowup()).toBeNull()
    expect(host.notices).toEqual(['no follow-up'])
  })

  test('/follow text sets the slot', async () => {
    const session = makeSession()
    const engine = fakeEngine(session)
    const host = fakeHost(fakeRuntime(engine))
    expect(await dispatchSharedSlash(cmd('follow', 'run tests'), host)).toBe('handled')
    expect(session.followup).toBe('run tests')
    expect(engine.getFollowup()).toBe('run tests')
    expect(host.notices).toEqual(['run tests'])
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

  test('/pr failure sets jobError; success clears it', async () => {
    const dirty = tempGitRepo(true)
    const failSession = makeSession({ cwd: dirty, job: jobAt(dirty) })
    const failRuntime = fakeRuntime(fakeEngine(failSession))
    failRuntime.cwd = dirty
    const failUpserted: SessionRecord[] = []
    failRuntime.store.upsertSession = async (next) => {
      failUpserted.push({ ...next })
    }
    const failHost = fakeHost(failRuntime)
    expect(await dispatchSharedSlash(cmd('pr'), failHost)).toBe('handled')
    expect(failSession.jobError).toBe('worktree is dirty')
    expect(failUpserted[0]?.jobError).toBe('worktree is dirty')

    const clean = tempGitRepo(false)
    const okSession = makeSession({ cwd: clean, job: jobAt(clean), jobError: 'worktree is dirty' })
    const okRuntime = fakeRuntime(fakeEngine(okSession))
    okRuntime.cwd = clean
    const okUpserted: SessionRecord[] = []
    okRuntime.store.upsertSession = async (next) => {
      okUpserted.push({ ...next })
    }
    const okHost = fakeHost(okRuntime)
    expect(await dispatchSharedSlash(cmd('pr'), okHost)).toBe('handled')
    expect(okSession.jobError).toBeUndefined()
    expect(okUpserted.some((row) => row.jobError === undefined)).toBe(true)
    expect(okHost.ghCalls.length).toBeGreaterThan(0)
  })

  test('/config dump includes instructionFiles', async () => {
    const host = fakeHost(fakeRuntime(fakeEngine(makeSession())))
    expect(await dispatchSharedSlash(cmd('config'), host)).toBe('handled')
    expect(host.notices[0]).toContain('instructionFiles:')
  })

  test('/config instructions prints chooser and does not write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-cfg-chooser-'))
    tempDirs.push(home)
    const runtime = fakeRuntime(fakeEngine(makeSession()))
    runtime.config = { ...runtime.config, home, instructionFiles: 'both' }
    const host = fakeHost(runtime)
    expect(await dispatchSharedSlash(cmd('config', 'instructions'), host)).toBe('handled')
    expect(host.notices[0]).toBe(
      [
        'instructionFiles: both',
        '  claude           CLAUDE.md only',
        '  agents-fallback  CLAUDE.md, else AGENTS.md in that directory',
        '  both             CLAUDE.md and AGENTS.md',
      ].join('\n'),
    )
    expect(existsSync(join(home, 'config.yaml'))).toBe(false)
  })

  test('/config instructions claude persists, applies, and reloads', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-cfg-set-'))
    tempDirs.push(home)
    const engine = fakeEngine(makeSession())
    const runtime = fakeRuntime(engine)
    runtime.config = { ...runtime.config, home, instructionFiles: 'both' }
    const host = fakeHost(runtime)
    expect(await dispatchSharedSlash(cmd('config', 'instructions claude'), host)).toBe('handled')
    expect(host.notices).toEqual(['instructionFiles: claude'])
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('instructionFiles: claude\n')
    expect(runtime.config.instructionFiles).toBe('claude')
    expect(engine.reloads).toBe(1)
  })

  test('/config instructions maybe prints usage and does not write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ravenclaw-cfg-bad-'))
    tempDirs.push(home)
    const runtime = fakeRuntime(fakeEngine(makeSession()))
    runtime.config = { ...runtime.config, home, instructionFiles: 'both' }
    const host = fakeHost(runtime)
    expect(await dispatchSharedSlash(cmd('config', 'instructions maybe'), host)).toBe('handled')
    expect(host.notices).toEqual(['usage: /config instructions claude|agents-fallback|both'])
    expect(existsSync(join(home, 'config.yaml'))).toBe(false)
    expect(runtime.config.instructionFiles).toBe('both')
  })

  test('/config instructions claude without home notices no home directory', async () => {
    const runtime = fakeRuntime(fakeEngine(makeSession()))
    runtime.config = { ...runtime.config, instructionFiles: 'both' }
    delete (runtime.config as { home?: string }).home
    const host = fakeHost(runtime)
    expect(await dispatchSharedSlash(cmd('config', 'instructions claude'), host)).toBe('handled')
    expect(host.notices).toEqual(['no home directory'])
  })

  test('/crew with no arg notices the preset list and does not run a turn', async () => {
    const engine = fakeEngine(makeSession())
    let submitCalls = 0
    engine.submitMessage = async function* () {
      submitCalls += 1
      return { reason: 'completed' as const }
    }
    const host = fakeHost(fakeRuntime(engine))
    expect(await dispatchSharedSlash(cmd('crew'), host)).toBe('handled')
    expect(host.notices).toEqual([CREW_LIST_NOTICE])
    expect(host.turns).toHaveLength(0)
    expect(submitCalls).toBe(0)
  })

  test('/crew with whitespace notices the preset list and does not run a turn', async () => {
    const engine = fakeEngine(makeSession())
    let submitCalls = 0
    engine.submitMessage = async function* () {
      submitCalls += 1
      return { reason: 'completed' as const }
    }
    const host = fakeHost(fakeRuntime(engine))
    expect(await dispatchSharedSlash(cmd('crew', '   '), host)).toBe('handled')
    expect(host.notices).toEqual([CREW_LIST_NOTICE])
    expect(host.turns).toHaveLength(0)
    expect(submitCalls).toBe(0)
  })

  test('/crew implement with an empty goal notices usage and does not run a turn', async () => {
    const engine = fakeEngine(makeSession())
    let submitCalls = 0
    engine.submitMessage = async function* () {
      submitCalls += 1
      return { reason: 'completed' as const }
    }
    const host = fakeHost(fakeRuntime(engine))
    expect(await dispatchSharedSlash(cmd('crew', 'implement'), host)).toBe('handled')
    expect(host.notices).toEqual(['usage: /crew implement <goal>'])
    expect(host.turns).toHaveLength(0)
    expect(submitCalls).toBe(0)
  })

  test('/crew startup ship it notices an unknown preset and does not run a turn', async () => {
    const engine = fakeEngine(makeSession())
    let submitCalls = 0
    engine.submitMessage = async function* () {
      submitCalls += 1
      return { reason: 'completed' as const }
    }
    const host = fakeHost(fakeRuntime(engine))
    expect(await dispatchSharedSlash(cmd('crew', 'startup ship it'), host)).toBe('handled')
    expect(host.notices).toEqual(['unknown crew preset: startup'])
    expect(host.turns).toHaveLength(0)
    expect(submitCalls).toBe(0)
  })

  test('/crew nope is an unknown preset, not an unknown command', async () => {
    const engine = fakeEngine(makeSession())
    let submitCalls = 0
    engine.submitMessage = async function* () {
      submitCalls += 1
      return { reason: 'completed' as const }
    }
    const host = fakeHost(fakeRuntime(engine))
    expect(await dispatchSharedSlash(cmd('crew', 'nope'), host)).toBe('handled')
    expect(host.notices).toEqual(['unknown crew preset: nope'])
    expect(host.notices).not.toContain('unknown command: /crew')
    expect(host.notices).not.toContain('unknown command: /nope')
    expect(host.turns).toHaveLength(0)
    expect(submitCalls).toBe(0)
  })

  test('/crew review Keep  THIS runs one frozen turn and does not notice', async () => {
    const engine = fakeEngine(makeSession())
    let submitCalls = 0
    engine.submitMessage = async function* () {
      submitCalls += 1
      return { reason: 'completed' as const }
    }
    const host = fakeHost(fakeRuntime(engine))
    expect(await dispatchSharedSlash(cmd('crew', 'review Keep  THIS'), host)).toBe('handled')
    expect(host.notices).toHaveLength(0)
    expect(host.turns).toEqual([formatCrewTurn('review', 'Keep  THIS')])
    expect(submitCalls).toBe(0)
  })

  test('/crew research and implement each run one frozen turn', async () => {
    const engine = fakeEngine(makeSession())
    let submitCalls = 0
    engine.submitMessage = async function* () {
      submitCalls += 1
      return { reason: 'completed' as const }
    }
    const host = fakeHost(fakeRuntime(engine))
    expect(await dispatchSharedSlash(cmd('crew', 'research Keep  THIS'), host)).toBe('handled')
    expect(await dispatchSharedSlash(cmd('crew', 'implement Keep  THIS'), host)).toBe('handled')
    expect(host.notices).toEqual([])
    expect(host.turns).toEqual([
      formatCrewTurn('research', 'Keep  THIS'),
      formatCrewTurn('implement', 'Keep  THIS'),
    ])
    expect(submitCalls).toBe(0)
  })

  test('/play serves the session cwd, reuses the port, and stop closes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-dispatch-play-'))
    tempDirs.push(dir)
    writeFileSync(join(dir, 'index.html'), 'HOME')
    const host = fakeHost(fakeRuntime(fakeEngine(makeSession({ id: 'sess_play', cwd: dir }))), {
      openPlay: () => ({ ok: true }),
    })
    try {
      expect(await dispatchSharedSlash(cmd('play'), host)).toBe('handled')
      const url = host.notices[0] ?? ''
      expect(url.startsWith('http://127.0.0.1:')).toBe(true)
      expect(url).not.toContain('unknown command')
      expect(await (await fetch(url)).text()).toBe('HOME')
      expect(await dispatchSharedSlash(cmd('play'), host)).toBe('handled')
      expect(host.notices[1]).toBe(url)
      expect(await dispatchSharedSlash(cmd('play', 'stop'), host)).toBe('handled')
      expect(host.notices[2]).toBe(`stopped ${url}`)
      let closed = false
      try {
        await fetch(url)
      } catch {
        closed = true
      }
      expect(closed).toBe(true)
      expect(host.turns).toEqual([])
    } finally {
      await dispatchSharedSlash(cmd('play', 'stop'), host)
    }
  })

  test('/branch with no number lists the path and stays handled', async () => {
    const { host, ids, branched, counts } = branchHarness()
    const notice = formatBranchNotice(branchPath, [branchOld])
    for (const arg of [undefined, '', '   '] as const) {
      const result = await dispatchSharedSlash(cmd('branch', arg), host)
      expect(result).toBe('handled')
      expect(result).not.toBe('host')
    }
    expect(host.notices).toEqual([notice, notice, notice])
    expect(ids).toEqual([])
    expect(branched).toEqual([])
    expect(host.turns).toEqual([])
    expect(counts.loads).toBe(3)
    expect(counts.lists).toBe(3)
    expect(counts.sessionIds).toEqual(['sess_dispatch', 'sess_dispatch', 'sess_dispatch'])
  })

  test('/branch 3 moves the leaf to the previous assistant and does not run a turn', async () => {
    const returned = [branchU1, branchA1]
    const { host, ids, branched } = branchHarness({
      branchAt: async () => ({ ok: true, messages: returned }),
    })
    expect(await dispatchSharedSlash(cmd('branch', '3'), host)).toBe('handled')
    expect(ids).toEqual(['a1'])
    expect(host.notices).toEqual(['branched at 2 assistant'])
    expect(branched).toHaveLength(1)
    expect(branched[0]).toBe(returned)
    expect(host.turns).toEqual([])
  })

  test('/branch 1 on a user row is already at the start', async () => {
    const { host, ids, branched } = branchHarness()
    expect(await dispatchSharedSlash(cmd('branch', '1'), host)).toBe('handled')
    expect(host.notices).toEqual(['already at the start'])
    expect(ids).toEqual([])
    expect(branched).toEqual([])
  })

  test('/branch 2 on an assistant leaf is already at this point', async () => {
    const path = [branchU1, branchA1]
    const { host, ids, branched } = branchHarness({ path, nodes: pathNodes(path) })
    expect(await dispatchSharedSlash(cmd('branch', '2'), host)).toBe('handled')
    expect(host.notices).toEqual(['already at this point'])
    expect(ids).toEqual([])
    expect(branched).toEqual([])
  })

  test('/branch 1 on an assistant row branches at that id', async () => {
    const assistantFirst = textMessage('aLead', 'assistant', 'lead')
    const later = textMessage('uLater', 'user', 'later')
    const path = [assistantFirst, later]
    const { host, ids, branched } = branchHarness({ path, nodes: pathNodes(path) })
    expect(await dispatchSharedSlash(cmd('branch', '1'), host)).toBe('handled')
    expect(ids).toEqual(['aLead'])
    expect(host.notices).toEqual(['branched at 2 user'])
    expect(host.notices).not.toContain('already at the start')
    expect(branched).toEqual([path])
  })

  test('/branch 4 branches at the other tip, not its parent', async () => {
    const { host, ids } = branchHarness()
    expect(await dispatchSharedSlash(cmd('branch', '4'), host)).toBe('handled')
    expect(ids).toEqual(['old'])
    expect(ids).not.toContain('u1')
  })

  test('/branch rejects a missing number and a non-integer without branching', async () => {
    const { host, ids, counts } = branchHarness()
    expect(await dispatchSharedSlash(cmd('branch', '9'), host)).toBe('handled')
    expect(await dispatchSharedSlash(cmd('branch', 'foo'), host)).toBe('handled')
    expect(host.notices).toEqual(['no message 9', 'usage: /branch [n]'])
    expect(ids).toEqual([])
    expect(counts.loads).toBe(1)
    expect(counts.lists).toBe(1)
  })

  test('/branch with an empty path and no other tips notices nothing to branch', async () => {
    const { host, ids, branched } = branchHarness({ path: [], nodes: [] })
    expect(await dispatchSharedSlash(cmd('branch'), host)).toBe('handled')
    expect(host.notices).toEqual(['nothing to branch'])
    expect(ids).toEqual([])
    expect(branched).toEqual([])
  })

  test('/branch passes engine notices through and skips onBranched', async () => {
    const refusals = [
      { ok: false as const, notice: 'pending permission ask' },
      { ok: false as const, notice: 'a turn is in progress' },
      { ok: true as const, notice: 'nothing to rewind' },
    ]
    for (const result of refusals) {
      const { host, ids, branched } = branchHarness({
        branchAt: async () => result,
      })
      expect(await dispatchSharedSlash(cmd('branch', '3'), host)).toBe('handled')
      expect(ids).toEqual(['a1'])
      expect(host.notices).toEqual([result.notice])
      expect(branched).toEqual([])
    }
  })

  test('/branch notices a loadMessages failure and does not list or branch', async () => {
    const { host, ids, counts } = branchHarness({
      loadMessages: async () => {
        throw new Error('leaf not found: x')
      },
    })
    expect(await dispatchSharedSlash(cmd('branch'), host)).toBe('handled')
    expect(host.notices).toEqual(['leaf not found: x'])
    expect(counts.loads).toBe(1)
    expect(counts.lists).toBe(0)
    expect(ids).toEqual([])
  })

  test('/branch notices when the store cannot list a path', async () => {
    const engine = fakeEngine(makeSession())
    const ids: string[] = []
    engine.branchAt = async (id: string) => {
      ids.push(id)
      return { ok: true, messages: [] }
    }
    const host = fakeHost(fakeRuntime(engine))
    expect(typeof host.runtime().store.loadMessages).not.toBe('function')
    expect(typeof host.runtime().store.listBranchNodes).not.toBe('function')
    expect(await dispatchSharedSlash(cmd('branch'), host)).toBe('handled')
    expect(host.notices).toEqual(['branch unavailable'])
    expect(ids).toEqual([])
  })

  test('/branch notices a listBranchNodes failure and does not branch', async () => {
    const { host, ids, counts } = branchHarness({
      listBranchNodes: async () => {
        throw new Error('session not found: s1')
      },
    })
    expect(await dispatchSharedSlash(cmd('branch', '3'), host)).toBe('handled')
    expect(host.notices).toEqual(['session not found: s1'])
    expect(counts.loads).toBe(1)
    expect(counts.lists).toBe(1)
    expect(ids).toEqual([])
  })
})

