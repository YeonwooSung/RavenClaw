import { describe, expect, test } from 'bun:test'
import {
  createFileHistory,
  createTaskRegistry,
  type Message,
  type PermissionRule,
  type RoundEnd,
  type SessionEngine,
  type SessionListFilter,
  type SessionRecord,
  type SessionStore,
  type StreamEvent,
  type UserSubmitInput,
} from '@ravenclaw/core'
import { createAskBridge, type AskBridge, type CliRuntime } from './engine'
import { runOpenTuiApp } from './opentui-app'

function makeSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_opentui',
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

function asyncLines(...lines: string[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield line
    },
  }
}

function fakeRuntime(
  engine: SessionEngine,
  extras: {
    ask?: AskBridge
    store?: SessionStore
    cwd?: string
    funding?: 'byok' | 'included'
    hasPaidCapacityPlan?: boolean
  } = {},
): CliRuntime {
  if (extras.funding !== undefined) engine.session.funding = extras.funding
  return {
    engine,
    ask: extras.ask ?? createAskBridge(),
    store: extras.store ?? fakeStore(),
    cwd: extras.cwd ?? '/proj',
    config: {
      ads: { feedUrl: '' },
      profile: { id: 'dummy' },
      home: '/tmp/ravenclaw-home',
      model: 'dummy',
      mcp: { servers: [] },
    },
    hasPaidCapacityPlan: extras.hasPaidCapacityPlan,
    lockHolderId: 'holder-opentui',
    lockHolderName: 'tui',
  } as CliRuntime
}

function fakeStore(
  sessions: SessionRecord[] = [],
  extras: {
    messages?: Record<string, Message[]>
    rules?: Record<string, PermissionRule[]>
  } = {},
): SessionStore & {
  filters: SessionListFilter[]
  upserts: SessionRecord[]
} {
  const filters: SessionListFilter[] = []
  const upserts: SessionRecord[] = []
  return {
    filters,
    upserts,
    async listSessions(filter?: SessionListFilter) {
      if (filter) filters.push(filter)
      let rows = [...sessions]
      if (filter?.cwd !== undefined) {
        rows = rows.filter((row) => row.cwd === filter.cwd)
      }
      if (filter?.limit !== undefined) rows = rows.slice(0, filter.limit)
      return rows
    },
    async upsertSession(session: SessionRecord) {
      upserts.push({ ...session })
    },
    async loadSession(sessionId: string) {
      const session = sessions.find((row) => row.id === sessionId) ?? makeSession({ id: sessionId })
      return { session, messages: extras.messages?.[sessionId] ?? [] }
    },
    async listPermissionRules(sessionId: string) {
      return extras.rules?.[sessionId] ?? []
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
  } as SessionStore & { filters: SessionListFilter[]; upserts: SessionRecord[] }
}

function fakeEngine(
  session: SessionRecord,
  submit: (text: string) => AsyncGenerator<StreamEvent, RoundEnd>,
): SessionEngine {
  return {
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
    submitMessage(input: UserSubmitInput) {
      const text = typeof input === 'string' ? input : (input.text ?? '')
      return submit(text)
    },
    async *replayPendingAsks() {},
    async applyAskAnswer() {
      return 'unmatched'
    },
    async compactNow() {},
    async setModel(profile) {
      session.model = profile.id
    },
    async setPermissionMode() {},
    reloadSystem() {},
    abort() {},
    async close() {},
  }
}

describe('runOpenTuiApp', () => {
  test('included funding writes house dock lines', async () => {
    const written: string[] = []
    const code = await runOpenTuiApp(
      fakeRuntime(fakeEngine(makeSession({ funding: 'included' }), emptyTurn), {
        funding: 'included',
        hasPaidCapacityPlan: true,
      }),
      {
        input: asyncLines('/quit'),
        write: (chunk) => {
          written.push(chunk)
        },
      },
    )
    expect(code).toBe(0)
    expect(written.join('')).toContain('RavenClaw stays local')
    expect(written.join('')).not.toContain('Need a higher session cap?')
  })

  test('user prompt streams text_delta into written lines and /quit exits 0', async () => {
    const submitted: string[] = []
    const engine = fakeEngine(makeSession(), async function* (text) {
      submitted.push(text)
      yield { type: 'text_delta', text: 'hello back' }
      return { reason: 'completed' }
    })
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(engine), {
      input: asyncLines('hi', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    expect(submitted).toEqual(['hi'])
    expect(written.join('')).toContain('hello back')
  })

  test('permission_ask then y allows via the ask bridge', async () => {
    const answers: Array<'allow' | 'deny' | 'allow_always'> = []
    const ask = createAskBridge()
    const event: Extract<StreamEvent, { type: 'permission_ask' }> = {
      type: 'permission_ask',
      id: 'p1',
      tool: 'Bash',
      input: { command: 'ls' },
      message: 'Allow Bash?',
    }
    const engine = fakeEngine(makeSession(), async function* (text) {
      expect(text).toBe('run ls')
      yield event
      const answer = await ask.ask(event, new AbortController().signal)
      answers.push(answer)
      yield { type: 'text_delta', text: `answer:${answer}` }
      return { reason: 'completed' }
    })
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(engine, { ask }), {
      input: asyncLines('run ls', 'y', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    expect(answers).toEqual(['allow'])
    expect(written.join('')).toContain('Allow Bash?')
    expect(written.join('')).toContain('answer:allow')
  })

  test('/resume with no sessions prints no sessions to resume', async () => {
    const store = fakeStore([])
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(fakeEngine(makeSession(), emptyTurn), { store }), {
      input: asyncLines('/resume', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    expect(store.filters).toEqual([{ cwd: '/proj', limit: 20 }])
    expect(written.join('')).toContain('no sessions to resume')
    expect(written.join('')).not.toContain('unknown command')
  })

  test('/resume lists id[:8], title-or-model, and updatedAt', async () => {
    const store = fakeStore([
      makeSession({
        id: 'session-alpha-xxxx',
        title: 'Fix login',
        model: 'ignored-model',
        updatedAt: 1_700_000_000_000,
        cwd: '/proj',
      }),
      makeSession({
        id: 'otherid123456',
        model: 'claude-sonnet',
        updatedAt: 1_700_000_001_000,
        cwd: '/proj',
      }),
    ])
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(fakeEngine(makeSession(), emptyTurn), { store }), {
      input: asyncLines('/resume', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    expect(store.filters).toEqual([{ cwd: '/proj', limit: 20 }])
    const out = written.join('')
    expect(out).toContain('session-  Fix login  2023-11-14T22:13:20.000Z')
    expect(out).toContain('otherid1  claude-sonnet  2023-11-14T22:13:21.000Z')
    expect(out).not.toContain('unknown command')
  })

  test('/resume <id> resumes and later turns use the new engine', async () => {
    const submitted: string[] = []
    const original = fakeEngine(makeSession(), async function* (text) {
      submitted.push(`original:${text}`)
      return { reason: 'completed' }
    })
    const resumed = fakeEngine(
      makeSession({ id: 'abcdef12-9999-0000' }),
      async function* (text) {
        submitted.push(`resumed:${text}`)
        yield { type: 'text_delta', text: 'from resumed' }
        return { reason: 'completed' }
      },
    )
    const written: string[] = []
    const ids: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(original, { store: fakeStore() }), {
      input: asyncLines('/resume abcdef12-9999-0000', 'hello', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
      resumeRuntime: async (runtime, id) => {
        ids.push(id)
        return { ...runtime, engine: resumed }
      },
    })
    expect(code).toBe(0)
    expect(ids).toEqual(['abcdef12-9999-0000'])
    expect(written.join('')).toContain('resumed abcdef12')
    expect(written.join('')).toContain('from resumed')
    expect(submitted).toEqual(['resumed:hello'])
  })

  test('resume with a pending row replays permission_ask without submitMessage', async () => {
    const submitted: string[] = []
    const answers: Array<'allow' | 'deny' | 'allow_always'> = []
    const ask = createAskBridge()
    const event: Extract<StreamEvent, { type: 'permission_ask' }> = {
      type: 'permission_ask',
      id: 'call_1',
      tool: 'Bash',
      input: { command: 'ls' },
      message: 'Run ls?',
    }
    const original = fakeEngine(makeSession(), async function* (text) {
      submitted.push(`original:${text}`)
      return { reason: 'completed' }
    })
    const resumed = fakeEngine(
      makeSession({ id: 'abcdef12-9999-0000' }),
      async function* (text) {
        submitted.push(`resumed:${text}`)
        return { reason: 'completed' }
      },
    )
    resumed.replayPendingAsks = async function* () {
      yield event
      answers.push(await ask.ask(event, new AbortController().signal))
    }
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(original, { ask, store: fakeStore() }), {
      input: asyncLines('/resume abcdef12-9999-0000', 'n', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
      resumeRuntime: async (runtime) => ({ ...runtime, engine: resumed }),
    })
    expect(code).toBe(0)
    expect(answers).toEqual(['deny'])
    expect(submitted).toEqual([])
    const out = written.join('')
    expect(out).toContain('resumed abcdef12')
    expect(out).toContain('permission_ask  Bash')
    expect(out).toContain('Allow Bash?')
    expect(out).toContain('Run ls?')
  })

  test('first-paint replay abort is caught and does not tear down the app', async () => {
    const submitted: string[] = []
    const event: Extract<StreamEvent, { type: 'permission_ask' }> = {
      type: 'permission_ask',
      id: 'call_1',
      tool: 'Bash',
      input: { command: 'ls' },
      message: 'Run ls?',
    }
    const engine = fakeEngine(makeSession(), async function* (text) {
      submitted.push(text)
      return { reason: 'completed' }
    })
    engine.replayPendingAsks = async function* () {
      yield event
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(engine), {
      input: asyncLines('/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    expect(submitted).toEqual([])
    const out = written.join('')
    expect(out).toContain('permission_ask  Bash')
    expect(out).toContain('aborted')
  })

  test('/resume replay abort is caught and does not tear down the app', async () => {
    const submitted: string[] = []
    const event: Extract<StreamEvent, { type: 'permission_ask' }> = {
      type: 'permission_ask',
      id: 'call_1',
      tool: 'Bash',
      input: { command: 'ls' },
      message: 'Run ls?',
    }
    const original = fakeEngine(makeSession(), async function* (text) {
      submitted.push(`original:${text}`)
      return { reason: 'completed' }
    })
    const resumed = fakeEngine(
      makeSession({ id: 'abcdef12-9999-0000' }),
      async function* (text) {
        submitted.push(`resumed:${text}`)
        return { reason: 'completed' }
      },
    )
    resumed.replayPendingAsks = async function* () {
      yield event
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(original, { store: fakeStore() }), {
      input: asyncLines('/resume abcdef12-9999-0000', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
      resumeRuntime: async (runtime) => ({ ...runtime, engine: resumed }),
    })
    expect(code).toBe(0)
    expect(submitted).toEqual([])
    const out = written.join('')
    expect(out).toContain('resumed abcdef12')
    expect(out).toContain('permission_ask  Bash')
    expect(out).toContain('aborted')
  })

  test('first paint replays permission_ask without submitMessage', async () => {
    const submitted: string[] = []
    const answers: Array<'allow' | 'deny' | 'allow_always'> = []
    const ask = createAskBridge()
    const event: Extract<StreamEvent, { type: 'permission_ask' }> = {
      type: 'permission_ask',
      id: 'call_1',
      tool: 'Bash',
      input: { command: 'ls' },
      message: 'Run ls?',
    }
    const engine = fakeEngine(makeSession(), async function* (text) {
      submitted.push(text)
      return { reason: 'completed' }
    })
    engine.replayPendingAsks = async function* () {
      yield event
      answers.push(await ask.ask(event, new AbortController().signal))
    }
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(engine, { ask }), {
      input: asyncLines('n', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    expect(answers).toEqual(['deny'])
    expect(submitted).toEqual([])
    const out = written.join('')
    expect(out).toContain('permission_ask  Bash')
    expect(out).toContain('Allow Bash?')
    expect(out).toContain('Run ls?')
  })

  test('/resume <id> prints the error when resume fails', async () => {
    const written: string[] = []
    const code = await runOpenTuiApp(
      fakeRuntime(fakeEngine(makeSession(), emptyTurn), { store: fakeStore() }),
      {
        input: asyncLines('/resume missing', '/quit'),
        write: (chunk) => {
          written.push(chunk)
        },
        resumeRuntime: async () => {
          throw new Error('session not found: missing')
        },
      },
    )
    expect(code).toBe(0)
    expect(written.join('')).toContain('session not found: missing')
    expect(written.join('')).not.toContain('resumed ')
  })

  test('/help lists slash commands', async () => {
    const written: string[] = []
    const code = await runOpenTuiApp(
      fakeRuntime(fakeEngine(makeSession(), emptyTurn), { store: fakeStore() }),
      {
        input: asyncLines('/help', '/quit'),
        write: (chunk) => {
          written.push(chunk)
        },
      },
    )
    expect(code).toBe(0)
    expect(written.join('')).toContain('/resume')
    expect(written.join('')).toContain('/quit')
    expect(written.join('')).toContain('/clear')
    expect(written.join('')).toContain('/model')
  })

  test('/team-onboarding starts a turn with the scan JSON', async () => {
    const prompts: string[] = []
    const engine = fakeEngine(makeSession(), async function* (text: string) {
      prompts.push(text)
      return { reason: 'completed' }
    })
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(engine, { store: fakeStore() }), {
      input: asyncLines('/team-onboarding', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    expect(prompts[0] ?? '').toContain('Walk this human')
    expect(prompts[0] ?? '').toContain('"teamName"')
    expect(written.join('')).not.toContain('unknown command')
  })

  test('/stop and /cancel abort the engine', async () => {
    let aborted = 0
    const engine = fakeEngine(makeSession(), emptyTurn)
    engine.abort = () => {
      aborted += 1
    }
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(engine, { store: fakeStore() }), {
      input: asyncLines('/stop', '/cancel', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    expect(aborted).toBe(2)
    expect(written.join('')).toContain('nothing to stop')
    expect(written.join('')).not.toContain('unknown command')
  })

  test('second /stop within 3s kills background tasks', async () => {
    const engine = fakeEngine(makeSession(), emptyTurn)
    let killed = 0
    engine.tasks.register({
      command: 'sleep 30',
      outputFile: '/tmp/raven-bg.log',
      kill: () => {
        killed += 1
      },
    })
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(engine, { store: fakeStore() }), {
      input: asyncLines('/stop', '/stop', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    expect(killed).toBe(1)
    expect(written.join('')).toContain('killed 1 background task')
    expect(engine.tasks.list().some((task) => task.status === 'killed')).toBe(true)
  })

  test('/diff opens a pinned file panel and /diff again closes it', async () => {
    const written: string[] = []
    const views: string[] = []
    const code = await runOpenTuiApp(
      fakeRuntime(fakeEngine(makeSession(), emptyTurn), { store: fakeStore() }),
      {
        input: asyncLines('/diff', 'hello stays a prompt', '/diff', '/quit'),
        write: (chunk) => {
          written.push(chunk)
        },
        loadGitDiff: () => {
          views.push('load')
          return {
            kind: 'files',
            files: [
              {
                path: 'a.ts',
                staged: false,
                unstaged: true,
                patch: 'diff --git a/a.ts b/a.ts\n+new\n',
              },
              {
                path: 'b.ts',
                staged: true,
                unstaged: false,
                patch: 'diff --git a/b.ts b/b.ts\n+other\n',
              },
            ],
          }
        },
      },
    )
    expect(code).toBe(0)
    const out = written.join('')
    expect(out).toContain('diff  2 files')
    expect(out).toContain('> a.ts  unstaged')
    expect(out).toContain('  b.ts  staged')
    expect(out).toContain('+new')
    expect(out).toContain('diff closed')
    expect(views.length).toBeGreaterThan(0)
    expect(out).not.toContain('unknown command')
  })

  test('/diff 2 selects the second file', async () => {
    const written: string[] = []
    const code = await runOpenTuiApp(
      fakeRuntime(fakeEngine(makeSession(), emptyTurn), { store: fakeStore() }),
      {
        input: asyncLines('/diff 2', '/quit'),
        write: (chunk) => {
          written.push(chunk)
        },
        loadGitDiff: () => ({
          kind: 'files',
          files: [
            {
              path: 'a.ts',
              staged: false,
              unstaged: true,
              patch: 'diff --git a/a.ts b/a.ts\n+new\n',
            },
            {
              path: 'b.ts',
              staged: true,
              unstaged: false,
              patch: 'diff --git a/b.ts b/b.ts\n+other\n',
            },
          ],
        }),
      },
    )
    expect(code).toBe(0)
    const out = written.join('')
    expect(out).toContain('> b.ts  staged')
    expect(out).toContain('+other')
    expect(out).not.toContain('+new')
  })

  test('/clear and /new replace the runtime and later turns use the new engine', async () => {
    const submitted: string[] = []
    const original = fakeEngine(makeSession(), async function* (text) {
      submitted.push(`original:${text}`)
      return { reason: 'completed' }
    })
    const fresh = fakeEngine(makeSession({ id: 'newsession-aaaa' }), async function* (text) {
      submitted.push(`fresh:${text}`)
      yield { type: 'text_delta', text: 'from fresh' }
      return { reason: 'completed' }
    })
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(original, { store: fakeStore() }), {
      input: asyncLines('/clear', 'hello', '/new', 'again', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
      openNewSession: async (runtime) => ({ ...runtime, engine: fresh }),
    })
    expect(code).toBe(0)
    expect(written.join('')).toContain('new session newsessi')
    expect(written.join('')).toContain('from fresh')
    expect(submitted).toEqual(['fresh:hello', 'fresh:again'])
  })

  test('/model prints or persists the session model', async () => {
    const session = makeSession({ model: 'dummy' })
    const store = fakeStore([session])
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(fakeEngine(session, emptyTurn), { store }), {
      input: asyncLines('/model', '/model anthropic/claude-sonnet-4', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    expect(written.join('')).toContain('model dummy')
    expect(written.join('')).toContain('model anthropic/claude-sonnet-4')
    expect(session.model).toBe('anthropic/claude-sonnet-4')
    expect(store.upserts.at(-1)?.model).toBe('anthropic/claude-sonnet-4')
  })

  test('/reload /tasks /permissions /context /cost /mcp print status', async () => {
    const session = makeSession({ compactGeneration: 2, model: 'dummy' })
    const store = fakeStore([session], {
      messages: {
        [session.id]: [
          { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hi' }], createdAt: 1 },
          { id: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'yo' }], createdAt: 2 },
        ],
      },
    })
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(fakeEngine(session, emptyTurn), { store }), {
      input: asyncLines(
        '/reload',
        '/tasks',
        '/permissions',
        '/context',
        '/cost',
        '/mcp',
        '/skills',
        '/config',
        '/quit',
      ),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    const out = written.join('')
    expect(out).toContain('skills reloaded')
    expect(out).toContain('no background tasks')
    expect(out).toContain('no extra rules')
    expect(out).toContain('compact 2  messages 2')
    expect(out).toContain('compact 2')
    expect(out).toContain('no mcp servers')
    expect(out).not.toContain('unknown command')
  })

  test('/add-dir /effort /agents /hooks are not unknown', async () => {
    const written: string[] = []
    const code = await runOpenTuiApp(fakeRuntime(fakeEngine(makeSession(), emptyTurn)), {
      input: asyncLines('/add-dir ../pkg', '/effort high', '/agents', '/hooks', '/quit'),
      write: (chunk) => {
        written.push(chunk)
      },
    })
    expect(code).toBe(0)
    const out = written.join('')
    expect(out).toContain('this slash does not add a root; use the AddDir tool or --add-dir: ../pkg')
    expect(out).toContain('effort high (hint only; does not persist — use --effort)')
    expect(out).toContain('general')
    expect(out).toContain('PreToolUse')
    expect(out).not.toContain('unknown command')
  })
})

async function* emptyTurn(): AsyncGenerator<StreamEvent, RoundEnd> {
  return { reason: 'completed' }
}
