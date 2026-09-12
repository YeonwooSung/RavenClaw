import type { SlackSocket, SlackSocketEnvelope } from './types'

const CONNECTIONS_OPEN = 'https://slack.com/api/apps.connections.open'

export async function connectSlackSocket(opts: {
  appToken: string
  fetch?: typeof fetch
  WebSocketImpl?: typeof WebSocket
  signal?: AbortSignal
}): Promise<SlackSocket> {
  const doFetch = opts.fetch ?? fetch
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket
  if (WS === undefined) throw new Error('WebSocket is not available')

  const res = await doFetch(CONNECTIONS_OPEN, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.appToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    signal: opts.signal,
  })
  const json: unknown = await res.json()
  const rec = asRecord(json)
  if (rec?.ok !== true || typeof rec.url !== 'string' || rec.url === '') {
    const err = typeof rec?.error === 'string' ? rec.error : 'apps.connections.open failed'
    throw new Error(err)
  }

  const ws = new WS(rec.url)
  const queue: Array<SlackSocketEnvelope | null> = []
  const waiters: Array<(value: IteratorResult<SlackSocketEnvelope>) => void> = []
  let closed = false

  const push = (item: SlackSocketEnvelope | null) => {
    const waiter = waiters.shift()
    if (waiter) {
      if (item === null) waiter({ value: undefined as never, done: true })
      else waiter({ value: item, done: false })
      return
    }
    queue.push(item)
  }

  const onAbort = () => {
    try {
      ws.close()
    } catch {
      // already closed
    }
  }
  opts.signal?.addEventListener('abort', onAbort)

  ws.addEventListener('message', (ev: MessageEvent<string>) => {
    const data = typeof ev.data === 'string' ? ev.data : String(ev.data)
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const env = asRecord(parsed)
    if (!env) return
    if (env.type === 'hello' || env.type === 'disconnect') return
    push(env as SlackSocketEnvelope)
  })
  ws.addEventListener('close', () => {
    if (closed) return
    closed = true
    opts.signal?.removeEventListener('abort', onAbort)
    push(null)
  })
  ws.addEventListener('error', () => {
    try {
      ws.close()
    } catch {
      // ignore
    }
  })

  await waitOpen(ws, opts.signal)

  return {
    async *events() {
      for (;;) {
        const queued = queue.shift()
        if (queued === null) return
        if (queued !== undefined) {
          yield queued
          continue
        }
        const next = await new Promise<IteratorResult<SlackSocketEnvelope>>((resolve) => {
          waiters.push(resolve)
        })
        if (next.done) return
        yield next.value
      }
    },
    async ack(envelopeId: string) {
      if (ws.readyState !== WS.OPEN) return
      ws.send(JSON.stringify({ envelope_id: envelopeId }))
    },
    async close() {
      opts.signal?.removeEventListener('abort', onAbort)
      if (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING) ws.close()
    },
  }
}

function waitOpen(ws: WebSocket, signal?: AbortSignal): Promise<void> {
  if (ws.readyState === ws.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('Slack Socket Mode websocket failed'))
    }
    const onAbort = () => {
      cleanup()
      reject(new Error('aborted'))
    }
    const cleanup = () => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
    signal?.addEventListener('abort', onAbort)
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
