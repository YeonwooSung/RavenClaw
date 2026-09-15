import {
  checkBearer,
  loadSessionMap,
  parseTurnRequest,
  ravenclawHome,
  resolveSessionId,
  saveSessionMap,
  verifyWebhookSignature,
  safeWebhookToolNames,
} from '@ravenclaw/core'
import { bootCli, openNewSession, resumeRuntime, type CliRuntime } from './engine'
import { runExec } from './exec'
import type { ConfigFlags, UserSubmitInput } from '@ravenclaw/core'

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

async function consumeSubmit(gen: AsyncGenerator<unknown, unknown>): Promise<void> {
  while (true) {
    const next = await gen.next()
    if (next.done) return
  }
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

  const home = opts.flags.listen !== undefined ? ravenclawHome() : ravenclawHome()
  const map = loadSessionMap(home)
  const engines = new Map<string, CliRuntime>()
  const opening = new Map<string, Promise<CliRuntime>>()
  const turnFlights = new Map<string, Promise<unknown>>()
  const shared = await bootCli({
    flags: { ...opts.flags, dontAsk: true },
    createSession: false,
    surface: 'headless',
    lockHolder: 'serve',
  })

  const runtimeFor = async (sessionKey: string | undefined, webhook: boolean) => {
    const key = sessionKey ?? 'http:dm:local'
    const resolved = resolveSessionId(map, key, () => crypto.randomUUID())
    if (resolved.created) saveSessionMap(map, home)
    const existing = engines.get(resolved.id)
    if (existing) return existing
    const boot = webhook
      ? { ...shared, config: { ...shared.config, allowedTools: safeWebhookToolNames() } }
      : shared
    return singleFlight(opening, resolved.id, async () => {
      const cached = engines.get(resolved.id)
      if (cached) return cached
      const opened = resolved.created
        ? await openNewSession(boot, { sessionId: resolved.id })
        : await resumeRuntime(boot, resolved.id)
      engines.set(resolved.id, opened)
      return opened
    })
  }

  const server = Bun.serve({
    hostname: listen.host,
    port: listen.port,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ ok: true })
      }
      if (req.method === 'POST' && url.pathname === '/v1/turn') {
        if (!checkBearer(req.headers.get('authorization') ?? undefined, secret)) {
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        }
        let body: unknown
        try {
          body = await req.json()
        } catch {
          return Response.json({ error: 'invalid json' }, { status: 400 })
        }
        const parsed = parseTurnRequest(body)
        if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
        try {
          const runtime = await runtimeFor(parsed.sessionKey, false)
          const result = await singleFlight(turnFlights, runtime.engine.session.id, () =>
            runExec({
              prompt: { text: parsed.text, turnPolicy: 'queue' },
              engine: runtime.engine,
              closeEngine: false,
            }),
          )
          return Response.json({ text: result.text, end: result.end, sessionId: runtime.engine.session.id })
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          )
        }
      }
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
      return Response.json({ error: 'not found' }, { status: 404 })
    },
  })

  process.stdout.write(`raven serve ${server.hostname}:${server.port}\n`)
  process.stdout.write('POST /v1/turn  Authorization: Bearer <GATEWAY_SECRET>\n')
  process.stdout.write('POST /webhooks/<route>  X-Raven-Signature: t=<unix>,v1=<hmac>\n')
  const stopMailbox = startMailboxPoller(engines, turnFlights)
  const shutdown = async () => {
    stopMailbox()
    server.stop()
    await Promise.allSettled([...turnFlights.values()])
    for (const runtime of engines.values()) {
      await runtime.engine.close?.()
      await runtime.mcpCloser?.()
    }
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
