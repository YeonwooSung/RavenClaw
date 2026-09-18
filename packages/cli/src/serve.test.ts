import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  createMemoryStore,
  PersistError,
  SessionLockError,
  type PendingAsk,
  type SessionJob,
  type StreamEvent,
  type UserSubmitInput,
} from '@ravenclaw/core'
import { IncludedResumeError } from './engine'
import {
  createServeAskHost,
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
        session: { id: opts.id, permissionMode: 'default' },
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
  applyCalls: Array<{ callId: string; answer: 'allow' | 'deny' | 'allow_always' }>
  submitted: UserSubmitInput[]
  submitEvents: StreamEvent[]
  replayEvents: StreamEvent[]
  submitHold?: Promise<void>
  submitEnd: { reason: string }
} {
  const store = createMemoryStore()
  const submitEvents: StreamEvent[] = []
  const replayEvents: StreamEvent[] = []
  const submitted: UserSubmitInput[] = []
  const applyCalls: Array<{ callId: string; answer: 'allow' | 'deny' | 'allow_always' }> = []
  const state: {
    abortCalls: number
    compactCalls: number
    liveTurnId: string | null
    submitHold?: Promise<void>
    submitEnd: { reason: string }
    writeLastEnd: boolean
  } = {
    abortCalls: 0,
    compactCalls: 0,
    liveTurnId: 'live-1',
    submitEnd: { reason: 'completed' },
    writeLastEnd: true,
  }
  const engine = {
    session: { id: 's1', permissionMode: 'default' as const } as {
      id: string
      permissionMode: 'default'
      followup?: string
      lastEnd?: { reason: string }
    },
    async applyAskAnswer(callId: string, answer: 'allow' | 'deny' | 'allow_always') {
      applyCalls.push({ callId, answer })
      const row = await store.getPendingAsk(callId)
      if (!row || row.sessionId !== engine.session.id) return 'unmatched' as const
      await store.deletePendingAsk(callId)
      return 'matched' as const
    },
    liveTurnId() {
      return state.liveTurnId
    },
    abort() {
      state.abortCalls += 1
    },
    async compactNow() {
      state.compactCalls += 1
    },
    async setFollowup(text: string) {
      if (text.trim() === '') return { ok: false as const, notice: 'follow-up text required' }
      engine.session.followup = text.trim()
      return { ok: true as const }
    },
    async clearFollowup() {
      delete engine.session.followup
    },
    getFollowup() {
      return engine.session.followup ?? null
    },
    async *submitMessage(input: UserSubmitInput) {
      submitted.push(input)
      if (state.liveTurnId === null) state.liveTurnId = 'live-1'
      for (const event of submitEvents) yield event
      if (state.submitHold) await state.submitHold
      state.liveTurnId = null
      if (state.writeLastEnd) {
        engine.session.lastEnd = state.submitEnd
      }
      return state.submitEnd
    },
    async *replayPendingAsks() {
      for (const event of replayEvents) yield event
    },
  }
  const hub = createSessionEventHub(store)
  const runtime = { engine: tapEngineEvents(engine, hub), store }
  const ctx = {
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
    applyCalls,
    submitted,
    submitEvents,
    replayEvents,
    set submitHold(value: Promise<void> | undefined) {
      state.submitHold = value
    },
    set submitEnd(value: { reason: string }) {
      state.submitEnd = value
    },
    set writeLastEnd(value: boolean) {
      state.writeLastEnd = value
    },
  }
  return ctx
}

function ndjsonReader(res: Response): {
  next: () => Promise<unknown>
  close: () => Promise<void>
} {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('missing body')
  const dec = new TextDecoder()
  let buf = ''
  return {
    async next() {
      while (true) {
        const nl = buf.indexOf('\n')
        if (nl !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line.trim() === '') continue
          return JSON.parse(line) as unknown
        }
        const chunk = await reader.read()
        if (chunk.done) throw new Error('stream ended before a line')
        buf += dec.decode(chunk.value, { stream: true })
      }
    },
    async close() {
      await reader.cancel()
    },
  }
}

async function readFirstJsonLine(res: Response): Promise<unknown> {
  const reader = ndjsonReader(res)
  try {
    return await reader.next()
  } finally {
    await reader.close()
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
    expect(await firstLine).toEqual({ seq: 1, type: 'text_delta', text: 'hi' })
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
      seq: 1,
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
      seq: 1,
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

  test('POST cancel with stale turnId is a no-op', async () => {
    const ctx = makeServeCtx('t')
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/cancel', {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify({ turnId: 'stale' }),
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'no_active_turn' })
    expect(ctx.abortCalls).toBe(0)
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

  test('POST /v1/session/:id/submit without Bearer is 401', async () => {
    const ctx = makeServeCtx()
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/submit', {
        method: 'POST',
        body: JSON.stringify({ text: 'hi' }),
      }),
      ctx,
    )
    expect(res.status).toBe(401)
    expect(ctx.submitted).toEqual([])
  })

  test('POST /v1/session/:id/submit rejects empty text', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/submit', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify({ text: '   ' }),
      }),
      ctx,
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'text is required' })
    expect(ctx.submitted).toEqual([])
  })

  test('POST /v1/session/:id/submit missing session is 404', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/missing/submit', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify({ text: 'hi' }),
      }),
      ctx,
    )
    expect(res.status).toBe(404)
    expect(ctx.submitted).toEqual([])
  })

  test('POST /v1/session/:id/submit creates a missing session when createSession is set', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const created: string[] = []
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/new1/submit', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify({ text: 'hi' }),
      }),
      {
        ...ctx,
        runtimeForSession: async () => undefined,
        createSession: async (id) => {
          created.push(id)
          const runtime = await ctx.runtimeForSession('s1')
          if (!runtime) throw new Error('expected fixture runtime')
          return runtime
        },
      },
    )
    expect(res.status).toBe(202)
    expect(created).toEqual(['new1'])
    expect(ctx.submitted).toEqual([{ text: 'hi', turnPolicy: 'queue' }])
  })

  test('POST /v1/session/:id/submit accepts and submits with turnPolicy queue', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/submit', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify({ text: '  write a.txt  ' }),
      }),
      ctx,
    )
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ accepted: true, sessionId: 's1' })
    expect(ctx.submitted).toEqual([{ text: 'write a.txt', turnPolicy: 'queue' }])
  })

  test('POST /v1/session/:id/submit mints leftover-ask onto the live stream', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    let release!: () => void
    ctx.submitHold = new Promise<void>((resolve) => {
      release = resolve
    })
    ctx.submitEvents.push({
      type: 'permission_ask',
      id: 'c1',
      tool: 'Write',
      input: { path: 'a.txt', contents: 'x' },
      message: 'Write a.txt?',
    })
    const streamRes = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/stream', {
        headers: { authorization: 'Bearer secret' },
      }),
      ctx,
    )
    expect(streamRes.status).toBe(200)
    const firstLine = readFirstJsonLine(streamRes)
    const submitRes = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/submit', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify({ text: 'write a.txt' }),
      }),
      ctx,
    )
    expect(submitRes.status).toBe(202)
    expect(await firstLine).toEqual({
      seq: 1,
      type: 'permission_ask',
      id: 'c1',
      tool: 'Write',
      input: { path: 'a.txt', contents: 'x' },
      message: 'Write a.txt?',
    })
    expect(ctx.turnFlights.size).toBe(1)
    release()
    await Promise.all([...ctx.turnFlights.values()])
  })

  test('second stream with after= concatenates without gaps or dupes', async () => {
    const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
    const ctx = makeServeCtx(secret)
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
    const auth = { authorization: 'Bearer secret' }
    const firstRes = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/stream', { headers: auth }),
      ctx,
    )
    expect(firstRes.status).toBe(200)
    const first = ndjsonReader(firstRes)
    const early: StreamEvent[] = [
      { type: 'round_start', round: 1, turnId: 't1' },
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
    ]
    const later: StreamEvent[] = [
      { type: 'text_delta', text: 'c' },
      { type: 'round_end', end: { reason: 'cancelled' } },
    ]
    const firstPending = Promise.all([first.next(), first.next(), first.next()])
    for (const event of early) await ctx.hub.publish('s1', event)
    const firstEvents = await firstPending
    expect(firstEvents).toEqual([
      { seq: 1, type: 'round_start', round: 1, turnId: 't1' },
      { seq: 2, type: 'text_delta', text: 'a' },
      { seq: 3, type: 'text_delta', text: 'b' },
    ])
    for (const event of later) await ctx.hub.publish('s1', event)
    expect([await first.next(), await first.next()]).toEqual([
      { seq: 4, type: 'text_delta', text: 'c' },
      { seq: 5, type: 'round_end', end: { reason: 'cancelled' } },
    ])
    const secondRes = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/stream?after=3', { headers: auth }),
      ctx,
    )
    expect(secondRes.status).toBe(200)
    const second = ndjsonReader(secondRes)
    const replayed = [await second.next(), await second.next()]
    expect(replayed).toEqual([
      { seq: 4, type: 'text_delta', text: 'c' },
      { seq: 5, type: 'round_end', end: { reason: 'cancelled' } },
    ])
    const concat = [...firstEvents, ...replayed]
    expect(concat.map((event) => (event as { seq: number }).seq)).toEqual([1, 2, 3, 4, 5])
    expect(new Set(concat.map((event) => (event as { seq: number }).seq)).size).toBe(5)
    await ctx.hub.publish('s1', { type: 'text_delta', text: 'd' })
    expect(await second.next()).toEqual({ seq: 6, type: 'text_delta', text: 'd' })
    await first.close()
    await second.close()
  })

  test('stream after omitted is live tail only; after=0 replays', async () => {
    const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
    const ctx = makeServeCtx(secret)
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
    const auth = { authorization: 'Bearer secret' }
    await ctx.hub.publish('s1', { type: 'text_delta', text: 'old' })
    const liveRes = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/stream', { headers: auth }),
      ctx,
    )
    expect(liveRes.status).toBe(200)
    const live = ndjsonReader(liveRes)
    const liveNext = live.next()
    const replayRes = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/stream?after=0', { headers: auth }),
      ctx,
    )
    expect(replayRes.status).toBe(200)
    const replay = ndjsonReader(replayRes)
    expect(await replay.next()).toEqual({ seq: 1, type: 'text_delta', text: 'old' })
    const replayNext = replay.next()
    await ctx.hub.publish('s1', { type: 'text_delta', text: 'new' })
    expect(await liveNext).toEqual({ seq: 2, type: 'text_delta', text: 'new' })
    expect(await replayNext).toEqual({ seq: 2, type: 'text_delta', text: 'new' })
    await live.close()
    await replay.close()
  })

  test('stream after= does not drop events published during replay', async () => {
    const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
    const ctx = makeServeCtx(secret)
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
    const auth = { authorization: 'Bearer secret' }
    let releaseReplay!: () => void
    const holdReplay = new Promise<void>((resolve) => {
      releaseReplay = resolve
    })
    let replayStarted!: () => void
    const started = new Promise<void>((resolve) => {
      replayStarted = resolve
    })
    const orig = ctx.store.listStreamEventsAfter.bind(ctx.store)
    ctx.store.listStreamEventsAfter = async (sessionId, afterSeq) => {
      const snapshot = await orig(sessionId, afterSeq)
      replayStarted()
      await holdReplay
      return snapshot
    }
    await ctx.hub.publish('s1', { type: 'text_delta', text: 'old' })
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/stream?after=0', { headers: auth }),
      ctx,
    )
    expect(res.status).toBe(200)
    const reader = ndjsonReader(res)
    const first = reader.next()
    await started
    await ctx.hub.publish('s1', { type: 'text_delta', text: 'new' })
    releaseReplay()
    expect(await first).toEqual({ seq: 1, type: 'text_delta', text: 'old' })
    expect(await reader.next()).toEqual({ seq: 2, type: 'text_delta', text: 'new' })
    await reader.close()
  })

  test('stream after must be a non-negative integer', async () => {
    const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
    const ctx = makeServeCtx(secret)
    const auth = { authorization: 'Bearer secret' }
    for (const after of ['-1', 'foo', '1.5', '']) {
      const res = await handleServeRequest(
        new Request(`http://127.0.0.1/v1/session/s1/stream?after=${after}`, { headers: auth }),
        ctx,
      )
      expect(res.status).toBe(400)
    }
  })

  test('POST /v1/turn ignores ?after=', async () => {
    const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
    const ctx = makeServeCtx(secret)
    ctx.submitEvents.push({ type: 'text_delta', text: 'hi' })
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/turn?after=0', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify({ text: 'hi' }),
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as { text: string; sessionId: string }
    expect(body.sessionId).toBe('s1')
    expect(typeof body.text).toBe('string')
  })

  test('POST resolve settles a live leftover-ask without applyAskAnswer', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const host = createServeAskHost()
    const pending = host.askUser(
      { type: 'permission_ask', id: 'c1', tool: 'Write', input: {}, message: 'Write?' },
      new AbortController().signal,
    )
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/resolve', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify({ callId: 'c1', allow: true }),
      }),
      { ...ctx, settleAsk: (callId, answer) => host.settle(callId, answer) },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'matched' })
    await expect(pending).resolves.toBe('allow')
    expect(ctx.applyCalls).toEqual([])
  })

  test('GET /v1/session/:id returns job and parked callIds', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const runtime = await ctx.runtimeForSession('s1')
    if (!runtime) throw new Error('expected runtime')
    runtime.engine.session = {
      id: 's1',
      permissionMode: 'default',
      job: {
        baseBranch: 'main',
        shadowBranch: 'raven/s1',
        baseCommitSha: 'abc',
        worktreePath: '/tmp/wt',
      },
    }
    await ctx.store.upsertPendingAsk({
      callId: 'parked_snap',
      sessionId: 's1',
      kind: 'leftover',
      tool: 'Bash',
      message: 'Bash?',
      input: { command: 'ls' },
      createdAt: 1,
    } satisfies PendingAsk)
    await ctx.store.appendStreamEvent('s1', { type: 'text_delta', text: 'x' })
    await ctx.store.appendStreamEvent('s1', { type: 'text_delta', text: 'y' })
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1', {
        headers: { authorization: 'Bearer secret' },
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      job?: { shadowBranch: string }
      pendingAsks: Array<{ callId: string; tool: string; message: string }>
      lastSeq: number
      permissionMode: string
      live: boolean
      queued: string | null
      jobAutoCommit: boolean
    }
    expect(body.id).toBe('s1')
    expect(body.job?.shadowBranch).toBe('raven/s1')
    expect(body.pendingAsks[0]?.callId).toBe('parked_snap')
    expect(body.pendingAsks[0]?.tool).toBe('Bash')
    expect(body.pendingAsks[0]?.message).toBe('Bash?')
    expect(body.lastSeq).toBe(2)
    expect(body.permissionMode).toBe('default')
    expect(body.live).toBe(true)
    expect(body.queued).toBeNull()
    expect(body.jobAutoCommit).toBe(false)
  })

  test('GET /v1/session/:id includes title, jobAutoCommit, lastEnd, jobError, queued', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const runtime = await ctx.runtimeForSession('s1')
    if (!runtime) throw new Error('expected runtime')
    runtime.engine.session = {
      id: 's1',
      title: 'fix login',
      permissionMode: 'default',
      jobAutoCommit: true,
      lastEnd: { reason: 'cancelled' },
      jobError: 'gh missing',
      followup: 'run tests',
      job: {
        baseBranch: 'main',
        shadowBranch: 'raven/s1',
        baseCommitSha: 'abc',
        worktreePath: '/tmp/wt',
      },
    }
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1', {
        headers: { authorization: 'Bearer secret' },
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.title).toBe('fix login')
    expect(body.jobAutoCommit).toBe(true)
    expect(body.lastEnd).toEqual({ reason: 'cancelled' })
    expect(body.jobError).toBe('gh missing')
    expect(body.queued).toBe('run tests')
    expect(body.live).toBe(true)
  })

  test('GET /v1/session/:id queued is null when followup is unset', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1', {
        headers: { authorization: 'Bearer secret' },
      }),
      ctx,
    )
    const body = (await res.json()) as { queued: string | null; jobAutoCommit: boolean }
    expect(body.queued).toBeNull()
    expect(body.jobAutoCommit).toBe(false)
  })

  test('POST submit runs follow-up after completed; cancelled clears without submit', async () => {
    const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
    const ctx = makeServeCtx(secret)
    const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }

    const setRes = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/followup', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ text: 'next please' }),
      }),
      ctx,
    )
    expect(setRes.status).toBe(200)

    const submitRes = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/submit', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ text: 'go' }),
      }),
      ctx,
    )
    expect(submitRes.status).toBe(202)
    await Promise.all([...ctx.turnFlights.values()])
    expect(ctx.submitted).toEqual([
      { text: 'go', turnPolicy: 'queue' },
      { text: 'next please', turnPolicy: 'queue' },
    ])
    const runtime = await ctx.runtimeForSession('s1')
    expect(runtime?.engine.session.followup).toBeUndefined()

    const ctx2 = makeServeCtx(secret)
    ctx2.submitEnd = { reason: 'cancelled' }
    await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/followup', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ text: 'nope' }),
      }),
      ctx2,
    )
    await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/submit', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ text: 'go' }),
      }),
      ctx2,
    )
    await Promise.all([...ctx2.turnFlights.values()])
    expect(ctx2.submitted).toEqual([{ text: 'go', turnPolicy: 'queue' }])
    const runtime2 = await ctx2.runtimeForSession('s1')
    expect(runtime2?.engine.session.followup).toBeUndefined()
  })

  test('POST submit does not run follow-up when lastEnd was not persisted', async () => {
    const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
    const ctx = makeServeCtx(secret)
    ctx.writeLastEnd = false
    const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/followup', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ text: 'next please' }),
      }),
      ctx,
    )
    await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/submit', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ text: 'go' }),
      }),
      ctx,
    )
    await Promise.all([...ctx.turnFlights.values()])
    expect(ctx.submitted).toEqual([{ text: 'go', turnPolicy: 'queue' }])
    const runtime = await ctx.runtimeForSession('s1')
    expect(runtime?.engine.session.followup).toBe('next please')
  })

  test('POST submit leaves follow-up when a child leftover-ask is parked', async () => {
    const secret = gatewaySecret({ GATEWAY_SECRET: 'secret' })
    const ctx = makeServeCtx(secret)
    const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    await ctx.store.upsertSession({
      id: 'child',
      createdAt: 1,
      updatedAt: 1,
      cwd: '/tmp',
      model: 'dummy',
      permissionMode: 'default',
      compactGeneration: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      funding: 'byok',
      parentSessionId: 's1',
    })
    await ctx.store.upsertPendingAsk({
      callId: 'call_child',
      sessionId: 'child',
      kind: 'leftover',
      tool: 'Bash',
      message: 'Allow Bash?',
      input: { command: 'ls' },
      createdAt: 1,
    })
    await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/followup', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ text: 'next please' }),
      }),
      ctx,
    )
    await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/submit', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ text: 'go' }),
      }),
      ctx,
    )
    await Promise.all([...ctx.turnFlights.values()])
    expect(ctx.submitted).toEqual([{ text: 'go', turnPolicy: 'queue' }])
    const runtime = await ctx.runtimeForSession('s1')
    expect(runtime?.engine.session.followup).toBe('next please')
  })

  test('POST /v1/session/:id/followup overwrites; DELETE clears; empty is 400', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const runtime = await ctx.runtimeForSession('s1')
    if (!runtime) throw new Error('expected runtime')

    const bad = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/followup', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ text: '' }),
      }),
      ctx,
    )
    expect(bad.status).toBe(400)

    const first = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/followup', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'first' }),
      }),
      ctx,
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, queued: 'first' })

    await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/followup', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'second' }),
      }),
      ctx,
    )
    expect(runtime.engine.session.followup).toBe('second')

    const del = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/followup', {
        method: 'DELETE',
        headers: { authorization: 'Bearer secret' },
      }),
      ctx,
    )
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true, queued: null })
  })

  test('GET /v1/session/:id does not create', async () => {
    let createCalls = 0
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/unknown', {
        headers: { authorization: 'Bearer secret' },
      }),
      {
        ...ctx,
        createSession: async () => {
          createCalls += 1
          throw new Error('should not create')
        },
      },
    )
    expect(res.status).toBe(404)
    expect(createCalls).toBe(0)
  })

  test('GET /v1/session/:id without Bearer is 401', async () => {
    const ctx = makeServeCtx()
    const res = await handleServeRequest(new Request('http://127.0.0.1/v1/session/s1'), ctx)
    expect(res.status).toBe(401)
  })

  test('POST /v1/session/:id/pr without Bearer is 401', async () => {
    const ctx = makeServeCtx()
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/pr', { method: 'POST' }),
      ctx,
    )
    expect(res.status).toBe(401)
  })

  test('POST /v1/session/:id/pr without a job record notices and does not submit', async () => {
    const ghCalls: string[][] = []
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/pr', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify({ title: 't', body: 'b' }),
      }),
      {
        ...ctx,
        gh(args) {
          ghCalls.push(args)
          return { ok: true, stdout: 'https://github.com/o/r/pull/4\n', stderr: '' }
        },
      },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, notice: 'no job record' })
    expect(ghCalls).toEqual([])
    expect(ctx.submitted).toEqual([])
  })

  test('POST /v1/session/:id/pr on a dirty worktree notices and does not submit', async () => {
    const cwd = tempGitRepo(true)
    const ghCalls: string[][] = []
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const runtime = await ctx.runtimeForSession('s1')
    if (!runtime) throw new Error('expected runtime')
    runtime.engine.session = { id: 's1', permissionMode: 'default', job: jobAt(cwd) }
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/pr', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      }),
      {
        ...ctx,
        gh(args) {
          ghCalls.push(args)
          return { ok: true, stdout: 'https://github.com/o/r/pull/4\n', stderr: '' }
        },
      },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, notice: 'worktree is dirty' })
    expect(ghCalls).toEqual([])
    expect(ctx.submitted).toEqual([])
  })

  test('POST /v1/session/:id/pr on a clean shadow records a url', async () => {
    const cwd = tempGitRepo(false)
    const ghCalls: string[][] = []
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const runtime = await ctx.runtimeForSession('s1')
    if (!runtime) throw new Error('expected runtime')
    runtime.engine.session = { id: 's1', permissionMode: 'default', job: jobAt(cwd) }
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/pr', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify({ title: 'draft', body: 'from serve' }),
      }),
      {
        ...ctx,
        gh(args) {
          ghCalls.push(args)
          return { ok: true, stdout: 'https://github.com/o/r/pull/4\n', stderr: '' }
        },
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      notice: string
      snapshot?: { url?: string }
    }
    expect(body.ok).toBe(true)
    expect(body.snapshot?.url).toContain('/pull/4')
    expect(runtime.engine.session.job?.prNumber).toBe(4)
    expect(ghCalls[0]?.[0]).toBe('pr')
    expect(ghCalls[0]?.[1]).toBe('create')
    expect(ctx.submitted).toEqual([])
  })

  test('POST /v1/session/:id/edit rewinds then submits; empty is 400; pending refuses', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const runtime = await ctx.runtimeForSession('s1')
    if (!runtime) throw new Error('expected runtime')
    let rewindCalls = 0
    runtime.engine.rewindLast = async () => {
      rewindCalls += 1
      return { ok: true, notice: 'dropped 2 messages', droppedText: 'old prompt' }
    }

    const empty = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/edit', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ text: '' }),
      }),
      ctx,
    )
    expect(empty.status).toBe(400)
    expect(rewindCalls).toBe(0)

    const ok = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/edit', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'new prompt' }),
      }),
      ctx,
    )
    expect(ok.status).toBe(202)
    expect(await ok.json()).toEqual({
      accepted: true,
      sessionId: 's1',
      droppedText: 'old prompt',
    })
    expect(rewindCalls).toBe(1)
    await Promise.all([...ctx.turnFlights.values()])
    expect(ctx.submitted).toEqual([{ text: 'new prompt', turnPolicy: 'queue' }])

    runtime.engine.rewindLast = async () => ({ ok: false, notice: 'pending permission ask' })
    const refused = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/edit', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x' }),
      }),
      ctx,
    )
    expect(refused.status).toBe(200)
    expect(await refused.json()).toEqual({ ok: false, notice: 'pending permission ask' })
    expect(ctx.submitted).toHaveLength(1)
  })

  test('GET /v1/session/:id/diff without a job is a notice', async () => {
    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/diff', {
        headers: { authorization: 'Bearer secret' },
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, notice: 'no job record' })
  })

  test('GET /v1/session/:id/diff with a job returns jobDiff', async () => {
    const cwd = tempGitRepo(false)
    const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim()
    writeFileSync(join(cwd, 'new.ts'), 'hello\n')
    spawnSync('git', ['add', 'new.ts'], { cwd, encoding: 'utf8' })
    spawnSync('git', ['commit', '-m', 'add new'], { cwd, encoding: 'utf8' })
    writeFileSync(join(cwd, 'dirty.txt'), 'x\n')

    const ctx = makeServeCtx(gatewaySecret({ GATEWAY_SECRET: 'secret' }))
    const runtime = await ctx.runtimeForSession('s1')
    if (!runtime) throw new Error('expected runtime')
    runtime.engine.session = {
      id: 's1',
      permissionMode: 'default',
      job: {
        baseBranch: 'main',
        shadowBranch: 'raven/s',
        baseCommitSha: base,
        worktreePath: cwd,
      },
    }

    const res = await handleServeRequest(
      new Request('http://127.0.0.1/v1/session/s1/diff', {
        headers: { authorization: 'Bearer secret' },
      }),
      ctx,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      baseCommitSha?: string
      shadowBranch?: string
      dirty?: boolean
      files?: Array<{ path: string; op: string }>
      notice?: string
    }
    expect(body.ok).toBe(true)
    expect(body.baseCommitSha).toBe(base)
    expect(body.shadowBranch).toBe('raven/s')
    expect(body.dirty).toBe(true)
    expect(body.files?.some((f) => f.path === 'new.ts' && f.op === 'create')).toBe(true)
    expect(body.files?.some((f) => f.path === 'dirty.txt' && f.op === 'create')).toBe(true)
  })
})

const serveTempDirs: string[] = []

afterEach(() => {
  while (serveTempDirs.length > 0) {
    const dir = serveTempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempGitRepo(dirty = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-serve-pr-'))
  serveTempDirs.push(dir)
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

describe('createServeAskHost', () => {
  test('parks askUser until settle and ignores unknown callIds', async () => {
    const host = createServeAskHost()
    const signal = new AbortController().signal
    const pending = host.askUser(
      { type: 'permission_ask', id: 'c1', tool: 'Bash', input: { command: 'ls' }, message: 'Bash?' },
      signal,
    )
    expect(host.settle('missing', 'allow')).toBe(false)
    expect(host.settle('c1', 'deny')).toBe(true)
    expect(host.settle('c1', 'allow')).toBe(false)
    await expect(pending).resolves.toBe('deny')
  })
})

function stubRuntime(tag: string): { engine: ServeEngine; tag: string } {
  const engine: ServeEngine = {
    session: { id: 's1', permissionMode: 'default' },
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
