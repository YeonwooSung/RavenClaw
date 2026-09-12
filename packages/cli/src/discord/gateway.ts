import type { DiscordGateway } from './types'

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

export async function connectDiscordGateway(
  token: string,
  opts?: { signal?: AbortSignal; WebSocketImpl?: typeof WebSocket },
): Promise<DiscordGateway> {
  const WS = opts?.WebSocketImpl ?? globalThis.WebSocket
  if (WS === undefined) throw new Error('WebSocket is not available')

  const ws = new WS(GATEWAY_URL)
  const queue: Array<unknown | null> = []
  const waiters: Array<(value: IteratorResult<unknown>) => void> = []
  let closed = false
  let lastSeq: number | null = null
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const push = (item: unknown | null) => {
    const waiter = waiters.shift()
    if (waiter) {
      if (item === null) waiter({ value: undefined as never, done: true })
      else waiter({ value: item, done: false })
      return
    }
    queue.push(item)
  }

  const stopHeartbeat = () => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }
  }

  const identify = () => {
    if (ws.readyState !== WS.OPEN) return
    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token,
          intents: INTENTS,
          properties: {
            os: process.platform,
            browser: 'ravenclaw',
            device: 'ravenclaw',
          },
        },
      }),
    )
  }

  const onAbort = () => {
    try {
      ws.close()
    } catch {
      // already closed
    }
  }
  opts?.signal?.addEventListener('abort', onAbort)

  ws.addEventListener('message', (ev: MessageEvent<string>) => {
    const data = typeof ev.data === 'string' ? ev.data : String(ev.data)
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const rec = asRecord(parsed)
    if (!rec) return
    if (typeof rec.s === 'number') lastSeq = rec.s
    if (rec.op === 10) {
      const hello = asRecord(rec.d)
      const interval = typeof hello?.heartbeat_interval === 'number' ? hello.heartbeat_interval : 45_000
      stopHeartbeat()
      heartbeat = setInterval(() => {
        if (ws.readyState !== WS.OPEN) return
        ws.send(JSON.stringify({ op: 1, d: lastSeq }))
      }, interval)
      heartbeat.unref?.()
      identify()
      return
    }
    if (rec.op === 1) {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ op: 1, d: lastSeq }))
      return
    }
    if (rec.op === 7 || rec.op === 9) {
      try {
        ws.close()
      } catch {
        // ignore
      }
      return
    }
    if (rec.op === 0 && rec.t === 'MESSAGE_CREATE') {
      push(rec.d ?? rec)
    }
  })
  ws.addEventListener('close', () => {
    if (closed) return
    closed = true
    stopHeartbeat()
    opts?.signal?.removeEventListener('abort', onAbort)
    push(null)
  })
  ws.addEventListener('error', () => {
    try {
      ws.close()
    } catch {
      // ignore
    }
  })

  await waitOpen(ws, opts?.signal)

  return {
    async *events() {
      for (;;) {
        const queued = queue.shift()
        if (queued === null) return
        if (queued !== undefined) {
          yield queued
          continue
        }
        const next = await new Promise<IteratorResult<unknown>>((resolve) => {
          waiters.push(resolve)
        })
        if (next.done) return
        yield next.value
      }
    },
    async close() {
      opts?.signal?.removeEventListener('abort', onAbort)
      stopHeartbeat()
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
      reject(new Error('Discord Gateway websocket failed'))
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
