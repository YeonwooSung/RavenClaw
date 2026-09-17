import {
  checkBearer,
  loadConfig,
  loadSessionMap,
  parseCancelBody,
  parseResolveBody,
  parseTurnRequest,
  PersistError,
  ravenclawHome,
  resolveSessionId,
  saveSessionMap,
  SessionLockError,
  verifyWebhookSignature,
  safeWebhookToolNames,
  type PendingAskAnswer,
  type PermissionMode,
  type SequencedStreamEvent,
  applySessionDraftPr,
  clearSessionJobError,
  setSessionJobError,
  maybeRunFollowup,
  type Message,
  type RoundEnd,
  type SessionEngine,
  type SessionJob,
  type SessionRecord,
  type SessionStore,
  type StreamEvent,
  type ConfigFlags,
  type UserSubmitInput,
} from '@ravenclaw/core'
import { bootCli, openNewSession, resumeRuntime, type CliRuntime } from './engine'
import { runExec } from './exec'

const DEFAULT_LISTEN = '127.0.0.1:8787'

export const MAILBOX_POLL_MS = 15_000

export type MailboxLiveEngine = {
  engine: {
    session: { id: string }
    submitMessage: (input: UserSubmitInput) => AsyncGenerator<unknown, unknown>
  }
  store: {
    peekAgentMail: (parentSessionId: string) => Promise<string[]>
  }
}

export function singleFlight<T>(
  flights: Map<string, Promise<T>> | Map<string, Promise<unknown>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  const map = flights as Map<string, Promise<unknown>>
  const existing = map.get(key)
  const task = (async () => {
    if (existing) {
      try {
        await existing
      } catch {
        // prior flight owns its error
      }
    }
    return await start()
  })()
  map.set(key, task)
  void task.finally(() => {
    if (map.get(key) === task) map.delete(key)
  })
  return task
}

async function consumeSubmit(gen: AsyncGenerator<unknown, unknown>): Promise<unknown> {
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
  }
}

function isRoundEnd(value: unknown): value is RoundEnd {
  return (
    !!value &&
    typeof value === 'object' &&
    'reason' in value &&
    typeof (value as { reason: unknown }).reason === 'string'
  )
}

export async function tickMailbox(
  engines: Iterable<[string, MailboxLiveEngine]>,
  flights: Map<string, Promise<unknown>>,
): Promise<void> {
  const pending: Promise<unknown>[] = []
  for (const [, runtime] of engines) {
    try {
      const sessionId = runtime.engine.session.id
      const mail = await runtime.store.peekAgentMail(sessionId)
      if (mail.length === 0) continue
      const existing = flights.get(sessionId)
      if (existing) {
        pending.push(existing.catch(() => undefined))
        continue
      }
      pending.push(
        singleFlight(flights, sessionId, async () => {
          try {
            await consumeSubmit(runtime.engine.submitMessage('[mailbox]'))
          } catch {
            // mailbox wake is best-effort; next tick can retry
          }
        }),
      )
    } catch {
      // poller must not take down serve
    }
  }
  await Promise.all(pending)
}

export function startMailboxPoller(
  engines: Iterable<[string, MailboxLiveEngine]>,
  flights: Map<string, Promise<unknown>>,
  opts?: {
    intervalMs?: number
    setIntervalFn?: (fn: () => void, ms: number) => { unref?: () => void }
    clearIntervalFn?: (id: unknown) => void
  },
): () => void {
  const schedule = opts?.setIntervalFn ?? setInterval
  const clear = opts?.clearIntervalFn ?? clearInterval
  const timer = schedule(() => {
    void tickMailbox(engines, flights)
  }, opts?.intervalMs ?? MAILBOX_POLL_MS)
  timer.unref?.()
  return () => clear(timer)
}

export function parseListen(raw?: string): { host: string; port: number } {
  const value = raw === undefined || raw.trim() === '' ? DEFAULT_LISTEN : raw.trim()
  const colon = value.lastIndexOf(':')
  if (colon === -1) return { host: '127.0.0.1', port: Number(value) || 8787 }
  const host = value.slice(0, colon) || '127.0.0.1'
  const port = Number(value.slice(colon + 1))
  return { host, port: Number.isInteger(port) && port > 0 ? port : 8787 }
}

export function gatewaySecret(env = process.env): string {
  return env.GATEWAY_SECRET ?? env.RAVEN_SERVE_SECRET ?? ''
}

export type ServeEngine = {
  session: {
    id: string
    permissionMode: PermissionMode
    job?: SessionJob
    followup?: string
    title?: string
    jobAutoCommit?: boolean
    lastEnd?: SessionRecord['lastEnd']
    jobError?: string
  }
  submitMessage: (input: UserSubmitInput) => AsyncGenerator<StreamEvent, unknown>
  applyAskAnswer: (
    callId: string,
    answer: PendingAskAnswer,
  ) => Promise<'matched' | 'unmatched'>
  replayPendingAsks: () => AsyncGenerator<StreamEvent, void>
  abort: (kind?: 'cancel' | 'interrupt') => void
  liveTurnId?: () => string | null
  compactNow: () => Promise<void>
  setFollowup?: (text: string) => Promise<{ ok: true } | { ok: false; notice: string }>
  clearFollowup?: () => Promise<void>
  getFollowup?: () => string | null
  rewindLast?: () => Promise<{ ok: boolean; notice: string; droppedText?: string }>
  close?: SessionEngine['close']
}

export type ServeRuntime = {
  engine: ServeEngine
  store?: {
    listPendingAsks: (sessionId: string) => Promise<
      Array<{
        callId: string
        sessionId: string
        tool: string
        message: string
        input: unknown
        saveAs?: string
      }>
    >
    listSessions?: (filter?: { parentSessionId?: string | null }) => Promise<Array<{ id: string }>>
    listStreamEventsAfter?: (
      sessionId: string,
      afterSeq: number,
    ) => Promise<SequencedStreamEvent[]>
    lastStreamSeq?: (sessionId: string) => Promise<number>
    upsertSession?: (session: SessionRecord) => Promise<void>
    loadSession?: (sessionId: string) => Promise<{ session: SessionRecord; messages: Message[] }>
    persistAssistant?: (
      sessionId: string,
      message: Extract<Message, { role: 'assistant' }>,
    ) => Promise<void>
    persistToolCalls?: (
      sessionId: string,
      message: Extract<Message, { role: 'assistant' }>,
    ) => Promise<void>
  }
}

export type SessionEventSink = (event: SequencedStreamEvent) => void

export type SessionEventHub = {
  subscribe: (sessionId: string, sink: SessionEventSink) => () => void
  publish: (sessionId: string, event: StreamEvent) => Promise<number>
}

export type ServeAskHost = {
  askUser: (
    event: Extract<StreamEvent, { type: 'permission_ask' }>,
    signal: AbortSignal,
  ) => Promise<PendingAskAnswer>
  settle: (callId: string, answer: PendingAskAnswer) => boolean
}

export function createServeAskHost(): ServeAskHost {
  const waiters = new Map<string, (answer: PendingAskAnswer) => void>()
  return {
    askUser(event, signal) {
      return new Promise((resolve, reject) => {
        const finish = (answer: PendingAskAnswer) => {
          if (waiters.get(event.id) !== finish) return
          waiters.delete(event.id)
          signal.removeEventListener('abort', onAbort)
          resolve(answer)
        }
        const onAbort = () => {
          if (waiters.get(event.id) !== finish) return
          waiters.delete(event.id)
          signal.removeEventListener('abort', onAbort)
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }
        waiters.set(event.id, finish)
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort)
      })
    },
    settle(callId, answer) {
      const finish = waiters.get(callId)
      if (!finish) return false
      finish(answer)
      return true
    },
  }
}

export type ServeRequestContext = {
  secret: string
  turnFlights: Map<string, Promise<unknown>>
  hub: SessionEventHub
  runtimeForTurn: (sessionKey: string | undefined, webhook: boolean) => Promise<ServeRuntime>
  runtimeForSession: (sessionId: string) => Promise<ServeRuntime | undefined>
  createSession?: (sessionId: string) => Promise<ServeRuntime>
  settleAsk?: (callId: string, answer: PendingAskAnswer) => boolean
  gh?: (args: string[], cwd: string) => { ok: boolean; stdout: string; stderr: string }
}

export function createSessionEventHub(
  store?: Pick<SessionStore, 'appendStreamEvent'>,
): SessionEventHub {
  const listeners = new Map<string, Set<SessionEventSink>>()
  let localSeq = 0
  return {
    subscribe(sessionId, sink) {
      let set = listeners.get(sessionId)
      if (!set) {
        set = new Set()
        listeners.set(sessionId, set)
      }
      set.add(sink)
      return () => {
        set.delete(sink)
        if (set.size === 0) listeners.delete(sessionId)
      }
    },
    async publish(sessionId, event) {
      const seq = store ? await store.appendStreamEvent(sessionId, event) : ++localSeq
      const sequenced: SequencedStreamEvent = { ...event, seq }
      const set = listeners.get(sessionId)
      if (set) {
        for (const sink of set) sink(sequenced)
      }
      return seq
    },
  }
}

async function* tapAsyncGen<T, R>(
  gen: AsyncGenerator<T, R>,
  onValue: (value: T) => void | Promise<void>,
): AsyncGenerator<T, R> {
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
    await onValue(next.value)
    yield next.value
  }
}

export function tapEngineEvents<E extends ServeEngine>(engine: E, hub: SessionEventHub): E {
  const sessionId = engine.session.id
  return {
    ...engine,
    submitMessage(input: UserSubmitInput) {
      return tapAsyncGen(engine.submitMessage(input), (event) => hub.publish(sessionId, event))
    },
    replayPendingAsks() {
      return tapAsyncGen(engine.replayPendingAsks(), (event) => hub.publish(sessionId, event))
    },
  }
}

export type ServeRuntimeCaches = {
  turnEngines: Map<string, CliRuntime>
  sessionEngines: Map<string, CliRuntime>
  runtimeForTurnId: (sessionId: string, open: () => Promise<CliRuntime>) => Promise<CliRuntime>
  runtimeForSessionId: (sessionId: string, open: () => Promise<CliRuntime>) => Promise<CliRuntime>
  liveEngines: () => Iterable<[string, CliRuntime]>
  closeAll: () => Promise<void>
}

export function createServeRuntimeCaches(hub: SessionEventHub): ServeRuntimeCaches {
  const turnEngines = new Map<string, CliRuntime>()
  const sessionEngines = new Map<string, CliRuntime>()
  const opening = new Map<string, Promise<CliRuntime>>()

  const liveOf = (sessionId: string) => sessionEngines.get(sessionId) ?? turnEngines.get(sessionId)

  const openInto = (
    engines: Map<string, CliRuntime>,
    sessionId: string,
    open: () => Promise<CliRuntime>,
  ) => {
    const existing = liveOf(sessionId)
    if (existing) return Promise.resolve(existing)
    return singleFlight(opening, sessionId, async () => {
      const hit = liveOf(sessionId)
      if (hit) return hit
      const opened = await open()
      const live = { ...opened, engine: tapEngineEvents(opened.engine, hub) }
      engines.set(sessionId, live)
      return live
    })
  }

  return {
    turnEngines,
    sessionEngines,
    runtimeForTurnId: (sessionId, open) => openInto(turnEngines, sessionId, open),
    runtimeForSessionId: (sessionId, open) => openInto(sessionEngines, sessionId, open),
    liveEngines() {
      return {
        *[Symbol.iterator]() {
          yield* turnEngines
          yield* sessionEngines
        },
      }
    },
    async closeAll() {
      for (const runtime of [...turnEngines.values(), ...sessionEngines.values()]) {
        await runtime.engine.close?.()
        await runtime.mcpCloser?.()
      }
    },
  }
}

export function sessionOpenErrorResponse(error: unknown): Response {
  if (isMissingSession(error)) {
    return Response.json({ error: 'not found' }, { status: 404 })
  }
  if (error instanceof SessionLockError) {
    return Response.json({ error: error.message }, { status: 409 })
  }
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  )
}

function isMissingSession(error: unknown): boolean {
  if (error instanceof PersistError && error.message.startsWith('session not found')) return true
  return error instanceof Error && error.message.startsWith('session not found')
}

async function publishParkedAsks(
  runtime: ServeRuntime,
  sessionId: string,
  hub: SessionEventHub,
): Promise<void> {
  const store = runtime.store
  if (!store?.listPendingAsks) return
  const rows = [...(await store.listPendingAsks(sessionId))]
  if (store.listSessions) {
    const children = await store.listSessions({ parentSessionId: sessionId })
    for (const child of children) {
      for (const row of await store.listPendingAsks(child.id)) {
        rows.push({ ...row, sessionId: child.id })
      }
    }
  }
  for (const row of rows) {
    const event: Extract<StreamEvent, { type: 'permission_ask' }> = {
      type: 'permission_ask',
      id: row.callId,
      tool: row.tool,
      input: row.input,
      message: row.message,
    }
    if (row.saveAs !== undefined) {
      event.saveAs = row.saveAs as Extract<StreamEvent, { type: 'permission_ask' }>['saveAs']
    }
    if (row.sessionId !== sessionId) event.childSessionId = row.sessionId
    await hub.publish(sessionId, event)
  }
}

function parseAfterParam(raw: string | null): { ok: true; after?: number } | { ok: false } {
  if (raw === null) return { ok: true }
  if (!/^\d+$/.test(raw)) return { ok: false }
  const after = Number(raw)
  if (!Number.isSafeInteger(after)) return { ok: false }
  return { ok: true, after }
}

function unauthorized(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 })
}

function requireBearer(req: Request, secret: string): boolean {
  return checkBearer(req.headers.get('authorization') ?? undefined, secret)
}

async function readJsonBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
  try {
    return { ok: true, body: await req.json() }
  } catch {
    return { ok: false, res: Response.json({ error: 'invalid json' }, { status: 400 }) }
  }
}

const SESSION_PATH = /^\/v1\/session\/([^/]+)\/(stream|cancel|compact|resolve|submit|pr|followup|edit)$/
const SESSION_ID_PATH = /^\/v1\/session\/([^/]+)$/

async function loadSessionRuntime(
  ctx: ServeRequestContext,
  sessionId: string,
): Promise<{ ok: true; runtime: ServeRuntime } | { ok: false; res: Response }> {
  try {
    const runtime = await ctx.runtimeForSession(sessionId)
    if (!runtime) return { ok: false, res: Response.json({ error: 'not found' }, { status: 404 }) }
    return { ok: true, runtime }
  } catch (error) {
    return { ok: false, res: sessionOpenErrorResponse(error) }
  }
}

async function collectSnapshotPendingAsks(
  runtime: ServeRuntime,
  sessionId: string,
): Promise<Array<{ callId: string; tool: string; message: string; childSessionId?: string }>> {
  const store = runtime.store
  if (!store?.listPendingAsks) return []
  const rows = [...(await store.listPendingAsks(sessionId))]
  if (store.listSessions) {
    const children = await store.listSessions({ parentSessionId: sessionId })
    for (const child of children) {
      for (const row of await store.listPendingAsks(child.id)) {
        rows.push({ ...row, sessionId: child.id })
      }
    }
  }
  return rows.map((row) => {
    const ask: { callId: string; tool: string; message: string; childSessionId?: string } = {
      callId: row.callId,
      tool: row.tool,
      message: row.message,
    }
    if (row.sessionId !== sessionId) ask.childSessionId = row.sessionId
    return ask
  })
}

export async function handleServeRequest(req: Request, ctx: ServeRequestContext): Promise<Response> {
  const url = new URL(req.url)
  if (req.method === 'GET' && url.pathname === '/health') {
    return Response.json({ ok: true })
  }
  if (req.method === 'POST' && url.pathname === '/v1/turn') {
    if (!requireBearer(req, ctx.secret)) return unauthorized()
    const parsedBody = await readJsonBody(req)
    if (!parsedBody.ok) return parsedBody.res
    const parsed = parseTurnRequest(parsedBody.body)
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
    try {
      const runtime = await ctx.runtimeForTurn(parsed.sessionKey, false)
      const sessionId = runtime.engine.session.id
      const result = await singleFlight(ctx.turnFlights, sessionId, () =>
        runExec({
          prompt: { text: parsed.text, turnPolicy: 'queue' },
          engine: runtime.engine as SessionEngine,
          closeEngine: false,
          write: () => {},
        }),
      )
      return Response.json({ text: result.text, end: result.end, sessionId })
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      )
    }
  }

  const sessionRoute = SESSION_PATH.exec(url.pathname)
  if (sessionRoute) {
    if (!requireBearer(req, ctx.secret)) return unauthorized()
    const sessionId = sessionRoute[1] ?? ''
    const action = sessionRoute[2]
    if (req.method === 'GET' && action === 'stream') {
      const parsedAfter = parseAfterParam(url.searchParams.get('after'))
      if (!parsedAfter.ok) return Response.json({ error: 'invalid after' }, { status: 400 })
      const loaded = await loadSessionRuntime(ctx, sessionId)
      if (!loaded.ok) return loaded.res
      const after = parsedAfter.after
      const encoder = new TextEncoder()
      let unsub = () => {}
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const write = (event: SequencedStreamEvent) => {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
            } catch {
              unsub()
            }
          }
          let lastSeq = after ?? 0
          let replaying = after !== undefined
          const buffered: SequencedStreamEvent[] = []
          unsub = ctx.hub.subscribe(sessionId, (event) => {
            if (replaying) {
              buffered.push(event)
              return
            }
            if (after !== undefined && event.seq <= lastSeq) return
            write(event)
            lastSeq = event.seq
          })
          if (after !== undefined) {
            const replay = (await loaded.runtime.store?.listStreamEventsAfter?.(sessionId, after)) ?? []
            for (const event of replay) {
              write(event)
              lastSeq = event.seq
            }
            replaying = false
            for (const event of buffered) {
              if (event.seq <= lastSeq) continue
              write(event)
              lastSeq = event.seq
            }
          }
          void publishParkedAsks(loaded.runtime, sessionId, ctx.hub)
          const onAbort = () => {
            unsub()
            try {
              controller.close()
            } catch {
              // already closed
            }
          }
          req.signal.addEventListener('abort', onAbort)
        },
        cancel() {
          unsub()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-cache',
        },
      })
    }
    if (req.method === 'POST' && action === 'cancel') {
      const loaded = await loadSessionRuntime(ctx, sessionId)
      if (!loaded.ok) return loaded.res
      const raw = await req.text()
      let parsed: ReturnType<typeof parseCancelBody>
      if (raw.trim() === '') {
        parsed = parseCancelBody(undefined)
      } else {
        let body: unknown
        try {
          body = JSON.parse(raw)
        } catch {
          return Response.json({ error: 'invalid json' }, { status: 400 })
        }
        parsed = parseCancelBody(body)
      }
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
      const live = loaded.runtime.engine.liveTurnId?.() ?? null
      if (parsed.turnId !== undefined ? parsed.turnId !== live : live === null) {
        return Response.json({ ok: true, status: 'no_active_turn' })
      }
      loaded.runtime.engine.abort('cancel')
      return Response.json({ ok: true })
    }
    if (req.method === 'POST' && action === 'compact') {
      const loaded = await loadSessionRuntime(ctx, sessionId)
      if (!loaded.ok) return loaded.res
      try {
        await singleFlight(ctx.turnFlights, sessionId, () => loaded.runtime.engine.compactNow())
        return Response.json({ ok: true })
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        )
      }
    }
    if (req.method === 'POST' && action === 'resolve') {
      const parsedBody = await readJsonBody(req)
      if (!parsedBody.ok) return parsedBody.res
      const parsed = parseResolveBody(parsedBody.body)
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
      const answer = parsed.allow ? 'allow' : 'deny'
      if (ctx.settleAsk?.(parsed.callId, answer)) {
        return Response.json({ status: 'matched' })
      }
      const loaded = await loadSessionRuntime(ctx, sessionId)
      if (!loaded.ok) return loaded.res
      const status = await loaded.runtime.engine.applyAskAnswer(parsed.callId, answer)
      if (status === 'unmatched') return Response.json({ status }, { status: 404 })
      return Response.json({ status })
    }
    if (req.method === 'POST' && action === 'submit') {
      const parsedBody = await readJsonBody(req)
      if (!parsedBody.ok) return parsedBody.res
      const parsed = parseTurnRequest(parsedBody.body)
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
      let loaded = await loadSessionRuntime(ctx, sessionId)
      if (!loaded.ok && loaded.res.status === 404 && ctx.createSession) {
        try {
          loaded = { ok: true, runtime: await ctx.createSession(sessionId) }
        } catch (error) {
          return sessionOpenErrorResponse(error)
        }
      }
      if (!loaded.ok) return loaded.res
      const sid = loaded.runtime.engine.session.id
      void singleFlight(ctx.turnFlights, sid, async () => {
        try {
          const end = await consumeSubmit(
            loaded.runtime.engine.submitMessage({ text: parsed.text, turnPolicy: 'queue' }),
          )
          if (!isRoundEnd(end)) return
          const engine = loaded.runtime.engine
          if (
            typeof engine.getFollowup !== 'function' ||
            typeof engine.clearFollowup !== 'function' ||
            typeof engine.liveTurnId !== 'function'
          ) {
            return
          }
          await maybeRunFollowup({
            engine: {
              submitMessage: (input) => engine.submitMessage(input),
              getFollowup: () => engine.getFollowup?.() ?? null,
              clearFollowup: async () => {
                await engine.clearFollowup?.()
              },
              liveTurnId: () => engine.liveTurnId?.() ?? null,
            },
            listPendingAsks: async () =>
              (await loaded.runtime.store?.listPendingAsks(sid)) ?? [],
            lastEnd: end,
          })
        } catch {
          // session submit is fire-and-forget; the stream carries errors
        }
      })
      return Response.json({ accepted: true, sessionId: sid }, { status: 202 })
    }
    if (req.method === 'POST' && action === 'edit') {
      const parsedBody = await readJsonBody(req)
      if (!parsedBody.ok) return parsedBody.res
      const rec = parsedBody.body
      const text =
        rec !== null && typeof rec === 'object' && typeof (rec as { text?: unknown }).text === 'string'
          ? (rec as { text: string }).text
          : ''
      if (text.trim() === '') return Response.json({ error: 'text required' }, { status: 400 })
      const loaded = await loadSessionRuntime(ctx, sessionId)
      if (!loaded.ok) return loaded.res
      const rewindLast = loaded.runtime.engine.rewindLast
      if (!rewindLast) {
        return Response.json({ ok: false, notice: 'rewind unavailable' })
      }
      const rewound = await rewindLast()
      if (!rewound.ok) {
        return Response.json({
          ok: false,
          notice: rewound.notice,
          ...(rewound.droppedText !== undefined ? { droppedText: rewound.droppedText } : {}),
        })
      }
      const sid = loaded.runtime.engine.session.id
      void singleFlight(ctx.turnFlights, sid, async () => {
        try {
          const end = await consumeSubmit(
            loaded.runtime.engine.submitMessage({ text, turnPolicy: 'queue' }),
          )
          if (!isRoundEnd(end)) return
          const engine = loaded.runtime.engine
          if (
            typeof engine.getFollowup !== 'function' ||
            typeof engine.clearFollowup !== 'function' ||
            typeof engine.liveTurnId !== 'function'
          ) {
            return
          }
          await maybeRunFollowup({
            engine: {
              submitMessage: (input) => engine.submitMessage(input),
              getFollowup: () => engine.getFollowup?.() ?? null,
              clearFollowup: async () => {
                await engine.clearFollowup?.()
              },
              liveTurnId: () => engine.liveTurnId?.() ?? null,
            },
            listPendingAsks: async () =>
              (await loaded.runtime.store?.listPendingAsks(sid)) ?? [],
            lastEnd: end,
          })
        } catch {
          // session edit is fire-and-forget; the stream carries errors
        }
      })
      return Response.json(
        {
          accepted: true,
          sessionId: sid,
          ...(rewound.droppedText !== undefined ? { droppedText: rewound.droppedText } : {}),
        },
        { status: 202 },
      )
    }
    if (req.method === 'POST' && action === 'followup') {
      const loaded = await loadSessionRuntime(ctx, sessionId)
      if (!loaded.ok) return loaded.res
      const parsedBody = await readJsonBody(req)
      if (!parsedBody.ok) return parsedBody.res
      const rec =
        parsedBody.body !== null && typeof parsedBody.body === 'object'
          ? (parsedBody.body as Record<string, unknown>)
          : null
      const text = typeof rec?.text === 'string' ? rec.text : ''
      const setFollowup = loaded.runtime.engine.setFollowup
      if (!setFollowup) {
        return Response.json({ error: 'follow-up text required' }, { status: 400 })
      }
      const result = await setFollowup(text)
      if (!result.ok) {
        return Response.json({ error: result.notice }, { status: 400 })
      }
      const queued =
        loaded.runtime.engine.getFollowup?.() ?? loaded.runtime.engine.session.followup ?? text.trim()
      return Response.json({ ok: true, queued })
    }
    if (req.method === 'DELETE' && action === 'followup') {
      const loaded = await loadSessionRuntime(ctx, sessionId)
      if (!loaded.ok) return loaded.res
      await loaded.runtime.engine.clearFollowup?.()
      return Response.json({ ok: true, queued: null })
    }
    if (req.method === 'POST' && action === 'pr') {
      const loaded = await loadSessionRuntime(ctx, sessionId)
      if (!loaded.ok) return loaded.res
      let title: string | undefined
      let body: string | undefined
      const raw = await req.text()
      if (raw.trim() !== '') {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw) as unknown
        } catch {
          return Response.json({ error: 'invalid json' }, { status: 400 })
        }
        if (parsed !== null && typeof parsed === 'object') {
          const rec = parsed as Record<string, unknown>
          if (typeof rec.title === 'string') title = rec.title
          if (typeof rec.body === 'string') body = rec.body
        }
      }
      const session = loaded.runtime.engine.session
      if (!session.job) {
        return Response.json({ ok: false, notice: 'no job record' })
      }
      const store = loaded.runtime.store
      const out = await applySessionDraftPr({
        job: session.job,
        cwd: session.job.worktreePath,
        ...(title !== undefined ? { title } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(ctx.gh ? { gh: ctx.gh } : {}),
        sessionId: session.id,
        ...(store?.loadSession
          ? { loadMessages: async () => (await store.loadSession!(session.id)).messages }
          : {}),
        ...(store?.persistAssistant
          ? { persistAssistant: (id, message) => store.persistAssistant!(id, message) }
          : {}),
        ...(store?.persistToolCalls
          ? { persistToolCalls: (id, message) => store.persistToolCalls!(id, message) }
          : {}),
      })
      if (out.job) session.job = out.job
      if (out.ok) clearSessionJobError(session)
      else setSessionJobError(session, out.notice)
      await store?.upsertSession?.(session as SessionRecord)
      const json: { ok: boolean; notice: string; snapshot?: typeof out.snapshot } = {
        ok: out.ok,
        notice: out.notice,
      }
      if (out.snapshot) json.snapshot = out.snapshot
      return Response.json(json)
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  }

  const sessionIdRoute = SESSION_ID_PATH.exec(url.pathname)
  if (sessionIdRoute && req.method === 'GET') {
    if (!requireBearer(req, ctx.secret)) return unauthorized()
    const sessionId = sessionIdRoute[1] ?? ''
    const loaded = await loadSessionRuntime(ctx, sessionId)
    if (!loaded.ok) return loaded.res
    const { engine, store } = loaded.runtime
    const pendingAsks = await collectSnapshotPendingAsks(loaded.runtime, sessionId)
    const lastSeq = store?.lastStreamSeq ? await store.lastStreamSeq(sessionId) : 0
    const session = engine.session
    const body: {
      id: string
      jobAutoCommit: boolean
      pendingAsks: Array<{ callId: string; tool: string; message: string; childSessionId?: string }>
      lastSeq: number
      permissionMode: PermissionMode
      live: boolean
      queued: string | null
      title?: string
      job?: SessionJob
      lastEnd?: SessionRecord['lastEnd']
      jobError?: string
    } = {
      id: session.id,
      jobAutoCommit: session.jobAutoCommit === true,
      pendingAsks,
      lastSeq,
      permissionMode: session.permissionMode,
      live: (engine.liveTurnId?.() ?? null) !== null,
      queued: session.followup ?? null,
    }
    if (session.title !== undefined) body.title = session.title
    if (session.job !== undefined) body.job = session.job
    if (session.lastEnd !== undefined) body.lastEnd = session.lastEnd
    if (session.jobError !== undefined) body.jobError = session.jobError
    return Response.json(body)
  }

  return Response.json({ error: 'not found' }, { status: 404 })
}

export async function runServe(opts: { flags: ConfigFlags }): Promise<number> {
  const secret = gatewaySecret()
  if (secret === '') {
    process.stderr.write('serve requires GATEWAY_SECRET or RAVEN_SERVE_SECRET\n')
    return 1
  }
  const listen = parseListen(opts.flags.listen)
  if (listen.host !== '127.0.0.1' && listen.host !== 'localhost' && listen.host !== '::1') {
    process.stderr.write('serve binds loopback only (127.0.0.1)\n')
    return 1
  }

  const home = ravenclawHome()
  const map = loadSessionMap(home)
  const turnFlights = new Map<string, Promise<unknown>>()
  const asks = createServeAskHost()
  const shared = await bootCli({
    flags: { ...opts.flags, dontAsk: true },
    createSession: false,
    surface: 'headless',
    lockHolder: 'serve',
  })
  const hub = createSessionEventHub(shared.store)
  const caches = createServeRuntimeCaches(hub)
  shared.ask.bind(asks.askUser)
  const sessionBoot = {
    ...shared,
    lockHolderId: shared.lockHolderId,
    config: loadConfig({ home: shared.config.home, flags: { ...opts.flags, dontAsk: false } }),
  }

  const runtimeForTurn = async (sessionKey: string | undefined, webhook: boolean) => {
    const key = sessionKey ?? 'http:dm:local'
    const resolved = resolveSessionId(map, key, () => crypto.randomUUID())
    if (resolved.created) saveSessionMap(map, home)
    const boot = webhook
      ? { ...shared, config: { ...shared.config, allowedTools: safeWebhookToolNames() } }
      : shared
    return caches.runtimeForTurnId(resolved.id, () =>
      resolved.created
        ? openNewSession(boot, { sessionId: resolved.id })
        : resumeRuntime(boot, resolved.id),
    )
  }

  const runtimeForSession = (sessionId: string) =>
    caches.runtimeForSessionId(sessionId, () => resumeRuntime(sessionBoot, sessionId))

  const createSession = (sessionId: string) =>
    caches.runtimeForSessionId(sessionId, () => openNewSession(sessionBoot, { sessionId }))

  const serveCtx: ServeRequestContext = {
    secret,
    turnFlights,
    hub,
    runtimeForTurn,
    runtimeForSession,
    createSession,
    settleAsk: (callId, answer) => asks.settle(callId, answer),
  }

  const server = Bun.serve({
    hostname: listen.host,
    port: listen.port,
    async fetch(req) {
      const url = new URL(req.url)
      const hook = /^\/webhooks\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'POST' && hook) {
        const raw = await req.text()
        if (!verifyWebhookSignature(raw, req.headers.get('x-raven-signature') ?? undefined, secret)) {
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        }
        let body: unknown
        try {
          body = JSON.parse(raw) as unknown
        } catch {
          return Response.json({ error: 'invalid json' }, { status: 400 })
        }
        const parsed = parseTurnRequest(body)
        if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
        void (async () => {
          let opened: CliRuntime | undefined
          try {
            opened = await openNewSession({
              ...shared,
              config: { ...shared.config, allowedTools: safeWebhookToolNames() },
            })
            await runExec({
              prompt: { text: parsed.text, turnPolicy: 'queue' },
              engine: opened.engine,
            })
          } catch {
            // fire-and-forget
          } finally {
            await opened?.engine.close?.()
            await opened?.mcpCloser?.()
          }
        })()
        return Response.json({ accepted: true }, { status: 202 })
      }
      return handleServeRequest(req, serveCtx)
    },
  })

  process.stdout.write(`raven serve ${server.hostname}:${server.port}\n`)
  process.stdout.write('POST /v1/turn  Authorization: Bearer <GATEWAY_SECRET>\n')
  process.stdout.write('GET  /v1/session/:id  snapshot JSON\n')
  process.stdout.write('GET  /v1/session/:id/stream[?after=seq]  NDJSON\n')
  process.stdout.write('POST /v1/session/:id/submit|/cancel|/compact|/resolve\n')
  process.stdout.write('POST /webhooks/<route>  X-Raven-Signature: t=<unix>,v1=<hmac>\n')
  const stopMailbox = startMailboxPoller(caches.liveEngines(), turnFlights)
  const shutdown = async () => {
    stopMailbox()
    server.stop()
    await Promise.allSettled([...turnFlights.values()])
    await caches.closeAll()
  }
  await new Promise<void>((resolve) => {
    const onStop = () => {
      void shutdown().finally(resolve)
    }
    process.once('SIGINT', onStop)
    process.once('SIGTERM', onStop)
  })
  return 0
}
