import { describe, expect, test } from 'bun:test'
import {
  createMemoryStore,
  PersistError,
  SessionLockError,
  type PendingAsk,
  type StreamEvent,
} from '@ravenclaw/core'
import { IncludedResumeError } from './engine'
import {
  createServeRuntimeCaches,
  createSessionEventHub,
  gatewaySecret,
  handleServeRequest,
  MAILBOX_POLL_MS,
  parseListen,
  singleFlight,
  startMailboxPoller,
  tapEngineEvents,
  tickMailbox,
  type MailboxLiveEngine,
  type ServeEngine,
  type ServeRequestContext,
} from './serve'

describe('parseListen', () => {
  test('defaults to loopback 8787', () => {
    expect(parseListen()).toEqual({ host: '127.0.0.1', port: 8787 })
    expect(parseListen('127.0.0.1:9000')).toEqual({ host: '127.0.0.1', port: 9000 })
  })

  test('parses localhost and ::1 loopback hosts', () => {
    expect(parseListen('localhost:9001')).toEqual({ host: 'localhost', port: 9001 })
    expect(parseListen('::1:8787')).toEqual({ host: '::1', port: 8787 })
  })
})

describe('gatewaySecret', () => {
  test('prefers GATEWAY_SECRET', () => {
    expect(gatewaySecret({ GATEWAY_SECRET: 'a', RAVEN_SERVE_SECRET: 'b' })).toBe('a')
    expect(gatewaySecret({ RAVEN_SERVE_SECRET: 'b' })).toBe('b')
    expect(gatewaySecret({})).toBe('')
  })
})

describe('singleFlight', () => {
  test('serializes starts for the same key (second waits, then runs)', async () => {
    const flights = new Map<string, Promise<number>>()
    let runs = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const start = () =>
      new Promise<number>((resolve) => {
        runs += 1
        const n = runs
        if (n === 1) void held.then(() => resolve(n))
        else resolve(n)
      })
    const first = singleFlight(flights, 's1', start)
    const second = singleFlight(flights, 's1', start)
    expect(runs).toBe(1)
    expect(flights.size).toBe(1)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(1)
    expect(b).toBe(2)
    expect(runs).toBe(2)
    expect(flights.size).toBe(0)
  })
})

function liveEngine(opts: {
  id: string
  peek: () => Promise<string[]> | string[]
  onSubmit?: (text: string) => Promise<void>
}): { runtime: MailboxLiveEngine; submitted: string[] } {
  const submitted: string[] = []
  return {
    submitted,
    runtime: {
      engine: {
        session: { id: opts.id },
        async *submitMessage(input) {
          const text = typeof input === 'string' ? input : (input.text ?? '')
          submitted.push(text)
          await opts.onSubmit?.(text)
        },
      },
      store: {
        async peekAgentMail() {
          return await opts.peek()
        },
      },
    },
  }
}

describe('tickMailbox', () => {
  test('peek empty does not submit', async () => {
    const { runtime, submitted } = liveEngine({ id: 's1', peek: () => [] })
    const flights = new Map<string, Promise<unknown>>()
    await tickMailbox(new Map([['s1', runtime]]), flights)
    expect(submitted).toEqual([])
    expect(flights.size).toBe(0)
  })

  test('peek nonempty submits [mailbox] via singleFlight', async () => {
    const { runtime, submitted } = liveEngine({ id: 's1', peek: () => ['child done'] })
    const flights = new Map<string, Promise<unknown>>()
    await tickMailbox(new Map([['s1', runtime]]), flights)
    expect(submitted).toEqual(['[mailbox]'])
    expect(flights.size).toBe(0)
  })

  test('overlapping ticks do not double-submit', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let began!: () => void
    const submitBegan = new Promise<void>((resolve) => {
      began = resolve
    })
    let secondPeeked!: () => void
    const sawSecondPeek = new Promise<void>((resolve) => {
      secondPeeked = resolve
    })
    let peeks = 0
    let submits = 0
    const { runtime, submitted } = liveEngine({
      id: 's1',
      peek: () => {
        peeks += 1
        if (peeks === 2) secondPeeked()
        return ['still here']
      },
      onSubmit: async () => {
        submits += 1
        began()
        await held
      },
    })
    const engines = new Map([['s1', runtime]])
    const flights = new Map<string, Promise<unknown>>()
    const first = tickMailbox(engines, flights)
    await submitBegan
    expect(submits).toBe(1)
    expect(flights.size).toBe(1)
    const second = tickMailbox(engines, flights)
    await sawSecondPeek
    await Promise.resolve()
    expect(submits).toBe(1)
    expect(flights.size).toBe(1)
    release()
    await Promise.all([first, second])
    expect(submitted).toEqual(['[mailbox]'])
    expect(submits).toBe(1)
    expect(flights.size).toBe(0)
  })

  test('existing turnFlights entry for s1 waits and does not start a second submit', async () => {
    let release!: () => void
    let waited = false
    const held = new Promise<void>((resolve) => {
      release = resolve
    }).then(() => {
      waited = true
    })
    const { runtime, submitted } = liveEngine({ id: 's1', peek: () => ['child done'] })
    const turnFlights = new Map<string, Promise<unknown>>([['s1', held]])
    const tick = tickMailbox(new Map([['s1', runtime]]), turnFlights)
    await Promise.resolve()
    expect(submitted).toEqual([])
    expect(waited).toBe(false)
    release()
    await tick
    expect(waited).toBe(true)
    expect(submitted).toEqual([])
  })
})

describe('startMailboxPoller', () => {
  test('polls every 15s and stop clears the interval', () => {
    expect(MAILBOX_POLL_MS).toBe(15_000)
    const scheduled: number[] = []
    let cleared = 0
    const handle = { id: 7 }
    const stop = startMailboxPoller(new Map(), new Map(), {
      setIntervalFn: (fn, ms) => {
        scheduled.push(ms)
        expect(typeof fn).toBe('function')
        return handle
      },
      clearIntervalFn: (id) => {
        expect(id).toBe(handle)
        cleared += 1
      },
    })
    expect(scheduled).toEqual([15_000])
    stop()
    expect(cleared).toBe(1)
  })
})

function makeServeCtx(secret = ''): ServeRequestContext & {
  store: ReturnType<typeof createMemoryStore>
  abortCalls: number
  compactCalls: number
  submitEvents: StreamEvent[]
  replayEvents: StreamEvent[]
} {
  const store = createMemoryStore()
  const submitEvents: StreamEvent[] = []
  const replayEvents: StreamEvent[] = []
  const state = { abortCalls: 0, compactCalls: 0 }
  const engine = {
    session: { id: 's1' },
    async applyAskAnswer(callId: string, _answer: 'allow' | 'deny' | 'allow_always') {
      const row = await store.getPendingAsk(callId)
      if (!row || row.sessionId !== engine.session.id) return 'unmatched' as const
      await store.deletePendingAsk(callId)
      return 'matched' as const
    },
    abort() {
      state.abortCalls += 1
    },
    async compactNow() {
      state.compactCalls += 1
    },
    async *submitMessage() {
      for (const event of submitEvents) yield event
    },
    async *replayPendingAsks() {
      for (const event of replayEvents) yield event
    },
  }
  const hub = createSessionEventHub()
  const runtime = { engine: tapEngineEvents(engine, hub), store }
  return {
    secret,
    store,
    turnFlights: new Map(),
    hub,
    runtimeForTurn: async () => runtime,
    runtimeForSession: async (sessionId) => (sessionId === engine.session.id ? runtime : undefined),
    get abortCalls() {
      return state.abortCalls
    },
    get compactCalls() {
      return state.compactCalls
    },
    submitEvents,
    replayEvents,
  }
}

async function readFirstJsonLine(res: Response): Promise<unknown> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('missing body')
  const dec = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) throw new Error('stream ended before a line')
      buf += dec.decode(next.value, { stream: true })
      const nl = buf.indexOf('\n')
      if (nl !== -1) return JSON.parse(buf.slice(0, nl)) as unknown
    }
  } finally {
    await reader.cancel()
  }
}

describe('handleServeRequest', () => {
  test('POST /v1/session/:id/resolve without Bearer is 401', async () => {
    const ctx = makeServeCtx()
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/resolve', {
        method: 'POST',
        body: JSON.stringify({ callId: 'c1', allow: true }),
      }),
      ctx,
    )
    expect(res.status).toBe(401)
  })

  test('POST /v1/turn without Bearer is 401', async () => {
    const ctx = makeServeCtx()
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/turn', { method: 'POST', body: JSON.stringify({ text: 'hi' }) }),
      ctx,
    )
    expect(res.status).toBe(401)
  })

  test('resolve allow deletes the pending row', async () => {
    const ctx = makeServeCtx()
    const ctxWithSecret = { ...ctx, secret: gatewaySecret({ GATEWAY_SECRET: 'secret' }) }
    await ctx.store.upsertPendingAsk({
      callId: 'c1',
      sessionId: 's1',
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 1,
    } satisfies PendingAsk)
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/resolve', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify({ callId: 'c1', allow: false }),
      }),
      ctxWithSecret,
    )
    expect(res.status).toBe(200)
    expect(await ctx.store.listPendingAsks('s1')).toHaveLength(0)
  })

  test('resolve unmatched pending ask is 404', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/resolve', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify({ callId: 'missing', allow: true }),
      }),
      ctx,
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ status: 'unmatched' })
  })

  test('GET /v1/session/:id/stream without Bearer is 401', async () => {
    const ctx = makeServeCtx()
    const res = await handleServeRequest(new Request('http://127.0.0.1/v1/session/s1/stream'), ctx)
    expect(res.status).toBe(401)
  })

  test('GET /v1/session/:id/stream tails live submitMessage events as NDJSON', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    ctx.submitEvents.push({ type: 'text_delta', text: 'hi' })
    const streamRes = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/stream', {
        headers: { authorization: 'Bearer secret' },
      }),
      ctx,
    )
    expect(streamRes.status).toBe(200)
    const firstLine = readFirstJsonLine(streamRes)
    const turnRes = await handleServeRequest(
      new Request('http://127.0.0.1/v1/turn', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify({ text: 'hi' }),
      }),
      ctx,
    )
    expect(turnRes.status).toBe(200)
    expect(await firstLine).toEqual({ type: 'text_delta', text: 'hi' })
  })

  test('GET /v1/session/:id/stream emits parked permission_ask rows on subscribe', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    await ctx.store.createSession({
      id: 's1',
      createdAt: 1,
      updatedAt: 1,
      cwd: '/tmp',
      model: 'dummy',
      permissionMode: 'default',
      compactGeneration: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      funding: 'byok',
    })
    await ctx.store.upsertPendingAsk({
      callId: 'parked_1',
      sessionId: 's1',
      kind: 'leftover',
      tool: 'Echo',
      message: 'Echo?',
      input: { text: 'hi' },
      createdAt: 1,
    })
    const streamRes = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/stream', {
        headers: { authorization: 'Bearer secret' },
      }),
      ctx,
    )
    expect(streamRes.status).toBe(200)
    expect(await readFirstJsonLine(streamRes)).toEqual({
      type: 'permission_ask',
      id: 'parked_1',
      tool: 'Echo',
      input: { text: 'hi' },
      message: 'Echo?',
    })
  })

  test('GET /v1/session/:id/stream tails replayPendingAsks events as NDJSON', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    ctx.replayEvents.push({
      type: 'permission_ask',
      id: 'c1',
      tool: 'Echo',
      input: { text: 'hi' },
      message: 'Echo?',
    })
    const streamRes = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/stream', {
        headers: { authorization: 'Bearer secret' },
      }),
      ctx,
    )
    expect(streamRes.status).toBe(200)
    const firstLine = readFirstJsonLine(streamRes)
    const runtime = await ctx.runtimeForSession('s1')
    for await (const _event of runtime!.engine.replayPendingAsks()) {
      // drain so the hub publishes
    }
    expect(await firstLine).toEqual({
      type: 'permission_ask',
      id: 'c1',
      tool: 'Echo',
      input: { text: 'hi' },
      message: 'Echo?',
    })
  })

  test('POST /v1/session/:id/cancel and compact require Bearer and call the engine', async () => {
    const unauthorized = makeServeCtx()
    const cancel401 = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/cancel', { method: 'POST' }),
      unauthorized,
    )
    const compact401 = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/compact', { method: 'POST' }),
      unauthorized,
    )
    expect(cancel401.status).toBe(401)
    expect(compact401.status).toBe(401)

    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const cancel = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/cancel', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      }),
      ctx,
    )
    const compact = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/compact', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      }),
      ctx,
    )
    expect(cancel.status).toBe(200)
    expect(compact.status).toBe(200)
    expect(ctx.abortCalls).toBe(1)
    expect(ctx.compactCalls).toBe(1)
  })

  test('missing session is 404; lock is 409; other resume errors are 500', async () => {
    const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
    const req = (id: string) =>
      new Request(`http://127.0.0.1/v1/session/${id}/cancel`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      })

    const missing = await handleServeRequest(req('s1'), {
      ...makeServeCtx(secret),
      runtimeForSession: async () => {
        throw new PersistError('unknown', 'session not found: s1')
      },
    })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not found' })

    const locked = await handleServeRequest(req('s1'), {
      ...makeServeCtx(secret),
      runtimeForSession: async () => {
        throw new SessionLockError('session locked by serve until 2099-01-01T00:00:00.000Z', {
          holderName: 'serve',
          expiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
        })
      },
    })
    expect(locked.status).toBe(409)
    expect(await locked.json()).toEqual({
      error: 'session locked by serve until 2099-01-01T00:00:00.000Z',
    })

    const failed = await handleServeRequest(req('s1'), {
      ...makeServeCtx(secret),
      runtimeForSession: async () => {
        throw new IncludedResumeError()
      },
    })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: new IncludedResumeError().message })
  })
})

function stubRuntime(tag: string): { engine: ServeEngine; tag: string } {
  const engine: ServeEngine = {
    session: { id: 's1' },
    async applyAskAnswer() {
      return 'unmatched'
    },
    abort() {},
    async compactNow() {},
    async *submitMessage() {},
    async *replayPendingAsks() {},
  }
  return { engine, tag }
}

describe('createServeRuntimeCaches', () => {
  test('session routes reuse a live turn engine for the same id', async () => {
    const hub = createSessionEventHub()
    const caches = createServeRuntimeCaches(hub)
    let turnOpens = 0
    let sessionOpens = 0
    const turn = stubRuntime('turn')
    const session = stubRuntime('session')

    const firstTurn = await caches.runtimeForTurnId('s1', async () => {
      turnOpens += 1
      return turn as never
    })
    const firstSession = await caches.runtimeForSessionId('s1', async () => {
      sessionOpens += 1
      return session as never
    })
    const againTurn = await caches.runtimeForTurnId('s1', async () => {
      turnOpens += 1
      return stubRuntime('turn-2') as never
    })
    const againSession = await caches.runtimeForSessionId('s1', async () => {
      sessionOpens += 1
      return stubRuntime('session-2') as never
    })

    expect(turnOpens).toBe(1)
    expect(sessionOpens).toBe(0)
    expect(caches.turnEngines.has('s1')).toBe(true)
    expect(caches.sessionEngines.has('s1')).toBe(false)
    expect(firstTurn).toBe(againTurn)
    expect(firstSession).toBe(firstTurn)
    expect(againSession).toBe(firstTurn)
  })

  test('turn routes reuse a live session engine for the same id', async () => {
    const hub = createSessionEventHub()
    const caches = createServeRuntimeCaches(hub)
    let turnOpens = 0
    let sessionOpens = 0
    const session = stubRuntime('session')

    const firstSession = await caches.runtimeForSessionId('s3', async () => {
      sessionOpens += 1
      return session as never
    })
    const firstTurn = await caches.runtimeForTurnId('s3', async () => {
      turnOpens += 1
      return stubRuntime('turn') as never
    })

    expect(sessionOpens).toBe(1)
    expect(turnOpens).toBe(0)
    expect(firstTurn).toBe(firstSession)
    expect(caches.sessionEngines.has('s3')).toBe(true)
    expect(caches.turnEngines.has('s3')).toBe(false)
  })

  test('session-only open still uses the session cache', async () => {
    const hub = createSessionEventHub()
    const caches = createServeRuntimeCaches(hub)
    const session = stubRuntime('session')
    const first = await caches.runtimeForSessionId('s2', async () => session as never)
    const again = await caches.runtimeForSessionId('s2', async () => stubRuntime('session-2') as never)
    expect(again).toBe(first)
    expect((first as { tag: string }).tag).toBe('session')
    expect(caches.turnEngines.has('s2')).toBe(false)
    expect(caches.sessionEngines.get('s2')).toBe(first)
  })

  test('concurrent turn and session open mint one engine', async () => {
    const hub = createSessionEventHub()
    const caches = createServeRuntimeCaches(hub)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let opens = 0
    const turnP = caches.runtimeForTurnId('s4', async () => {
      opens += 1
      await held
      return stubRuntime('turn') as never
    })
    const sessionP = caches.runtimeForSessionId('s4', async () => {
      opens += 1
      await held
      return stubRuntime('session') as never
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(opens).toBe(1)
    release()
    const [turn, session] = await Promise.all([turnP, sessionP])
    expect(session).toBe(turn)
    expect(opens).toBe(1)
    expect(caches.turnEngines.has('s4') !== caches.sessionEngines.has('s4')).toBe(true)
  })
})
