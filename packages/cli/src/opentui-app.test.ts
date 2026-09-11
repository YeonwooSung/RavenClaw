import { describe, expect, test } from 'bun:test'
import type {
  Message,
  PermissionRule,
  RoundEnd,
  SessionEngine,
  SessionListFilter,
  SessionRecord,
  SessionStore,
  StreamEvent,
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
    store: extras.store,
    cwd: extras.cwd ?? '/proj',
    config: {
      ads: { feedUrl: '' },
      profile: { id: 'dummy' },
      home: '/tmp/ravenclaw-home',
      model: 'dummy',
      mcp: { servers: [] },
    },
    hasPaidCapacityPlan: extras.hasPaidCapacityPlan,
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
    submitMessage: submit,
    async compactNow() {},
    async setPermissionMode() {},
    abort() {},
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
    expect(out).toContain('skills reload on next turn')
    expect(out).toContain('no background tasks')
    expect(out).toContain('no extra rules')
    expect(out).toContain('compact 2  messages 2')
    expect(out).toContain('compact 2')
    expect(out).toContain('no mcp servers')
    expect(out).not.toContain('unknown command')
  })
})

async function* emptyTurn(): AsyncGenerator<StreamEvent, RoundEnd> {
  return { reason: 'completed' }
}
