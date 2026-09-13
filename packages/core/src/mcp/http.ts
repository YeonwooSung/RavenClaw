import type { McpRequestHandler, McpTransport, McpTransportHealth } from './types'
import { MCP_AUTH_REQUIRED } from './oauth'

export interface HttpMcpTransportOpts {
  url: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
  mode?: 'http' | 'sse'
  oauth?: {
    getAccessToken(): Promise<string | undefined>
    refreshAccessToken(): Promise<string | undefined>
  }
}

const SSE_WAIT_MS = 15_000

type PendingWaiter = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type JsonRpcMessage = {
  id?: unknown
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

export function createHttpMcpTransport(opts: HttpMcpTransportOpts): McpTransport {
  const fetchImpl = opts.fetchImpl ?? fetch
  const sseMode = opts.mode === 'sse'
  let nextId = 1
  let sessionId: string | undefined
  let closed = false
  let health: McpTransportHealth = 'connecting'
  const pending = new Map<unknown, PendingWaiter>()
  const buffered = new Map<unknown, { result?: unknown; error?: Error }>()
  let onRequest: McpRequestHandler | undefined
  let sseAbort: AbortController | undefined
  let sseReady: Promise<void> | undefined

  function startSseGet(): Promise<void> {
    if (sseReady) return sseReady
    sseAbort = new AbortController()
    let resolveReady: () => void
    sseReady = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    void (async () => {
      try {
        const headers: Record<string, string> = {
          accept: 'text/event-stream',
          ...(await authHeaders()),
        }
        if (sessionId) headers['mcp-session-id'] = sessionId
        const res = await fetchImpl(opts.url, {
          method: 'GET',
          headers,
          signal: sseAbort.signal,
        })
        const returnedSession = res.headers.get('mcp-session-id')
        if (returnedSession) sessionId = returnedSession
        resolveReady()
        if (closed) return
        if (!res.ok) throw new Error(`MCP SSE GET ${res.status}`)
        await consumeSseStream(res, dispatchSseMessage, sseAbort.signal)
      } catch (error) {
        resolveReady()
        if (closed || isAbortError(error)) return
        const err = error instanceof Error ? error : new Error('MCP SSE GET failed')
        rejectAllPending(err)
      }
    })()
    return sseReady
  }

  function dispatchSseMessage(parsed: JsonRpcMessage): void {
    if (
      typeof parsed.method === 'string' &&
      parsed.id !== undefined &&
      parsed.result === undefined &&
      parsed.error === undefined
    ) {
      void answerServerRequest(parsed.method, parsed.params, parsed.id)
      return
    }
    if (parsed.id === undefined) return
    const error =
      parsed.error !== undefined
        ? new Error(parsed.error.message || 'MCP JSON-RPC error')
        : undefined
    const waiter = pending.get(parsed.id)
    if (waiter) {
      pending.delete(parsed.id)
      if (error) waiter.reject(error)
      else waiter.resolve(parsed.result)
      return
    }
    buffered.set(parsed.id, error ? { error } : { result: parsed.result })
  }

  function waitForSse(id: unknown, signal?: AbortSignal): Promise<unknown> {
    const ready = buffered.get(id)
    if (ready) {
      buffered.delete(id)
      if (ready.error) return Promise.reject(ready.error)
      return Promise.resolve(ready.result)
    }
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        pending.delete(id)
        reject(abortError())
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new Error('MCP SSE response timed out'))
      }, SSE_WAIT_MS)
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject(error) {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
    })
  }

  async function answerServerRequest(
    method: string,
    params: unknown,
    id: unknown,
  ): Promise<void> {
    const payload: Record<string, unknown> = { jsonrpc: '2.0', id }
    if (!onRequest) {
      payload.error = { code: -32601, message: 'Method not found' }
      await send(payload, false).catch(() => undefined)
      return
    }
    try {
      payload.result = await onRequest(method, params)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal error'
      payload.error = {
        code: /not found/i.test(message) ? -32601 : -32603,
        message,
      }
    }
    await send(payload, false).catch(() => undefined)
  }

  function rejectAllPending(error: Error): void {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }

  async function authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...opts.headers }
    if (opts.oauth) {
      const token = await opts.oauth.getAccessToken()
      if (token) headers.authorization = `Bearer ${token}`
    }
    return headers
  }

  async function send(
    body: Record<string, unknown>,
    expectResult: boolean,
    signal?: AbortSignal,
    retried = false,
  ): Promise<unknown> {
    if (closed) throw new Error('MCP transport is closed')
    if (signal?.aborted) throw abortError()
    if (sseMode) await startSseGet()
    if (closed) throw new Error('MCP transport is closed')
    if (signal?.aborted) throw abortError()
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(await authHeaders()),
    }
    if (sessionId) headers['mcp-session-id'] = sessionId
    const res = await fetchImpl(opts.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    })
    const returnedSession = res.headers.get('mcp-session-id')
    if (returnedSession) sessionId = returnedSession
    if (res.status === 401) {
      if (!retried && opts.oauth) {
        const next = await opts.oauth.refreshAccessToken()
        if (next) return send(body, expectResult, signal, true)
      }
      throw new Error(MCP_AUTH_REQUIRED)
    }
    if (!expectResult) return undefined
    if (sseMode && res.status === 202) {
      return waitForSse(body.id, signal)
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(errText || `MCP HTTP ${res.status}`)
    }
    const ctype = res.headers.get('content-type') ?? ''
    if (ctype.includes('text/event-stream')) {
      return readSseResult(res, body.id)
    }
    if (sseMode) {
      const text = await res.text()
      if (!text.trim()) return waitForSse(body.id, signal)
      const json = JSON.parse(text) as JsonRpcMessage
      if (json.error) throw new Error(json.error.message || 'MCP JSON-RPC error')
      return json.result
    }
    const json = (await res.json()) as JsonRpcMessage
    if (json.error) throw new Error(json.error.message || 'MCP JSON-RPC error')
    if (health === 'connecting') health = 'ready'
    return json.result
  }

  return {
    setRequestHandler(handler) {
      onRequest = handler
    },
    request(method, params, reqOpts) {
      const id = nextId++
      const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method }
      if (params !== undefined) payload.params = params
      return send(payload, true, reqOpts?.signal).then((value) => {
        if (health === 'connecting') health = 'ready'
        return value
      })
    },
    async notify(method, params) {
      const payload: Record<string, unknown> = { jsonrpc: '2.0', method }
      if (params !== undefined) payload.params = params
      await send(payload, false)
    },
    health() {
      return closed ? 'dead' : health
    },
    async close() {
      if (closed) return
      closed = true
      health = 'dead'
      sseAbort?.abort()
      rejectAllPending(new Error('MCP transport is closed'))
    },
  }
}

async function consumeSseStream(
  res: Response,
  onMessage: (message: JsonRpcMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) {
    for (const message of parseSseBlocks(await res.text())) onMessage(message)
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop() ?? ''
      for (const block of parts) {
        const message = parseSseBlock(block)
        if (message) onMessage(message)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const message = parseSseBlock(buffer)
      if (message) onMessage(message)
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) return
    throw error
  } finally {
    try {
      await reader.cancel()
    } catch {
      // ignore
    }
  }
}

function parseSseBlocks(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const message = parseSseBlock(block)
    if (message) messages.push(message)
  }
  return messages
}

function parseSseBlock(block: string): JsonRpcMessage | undefined {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
  if (dataLines.length === 0) return undefined
  try {
    return JSON.parse(dataLines.join('\n')) as JsonRpcMessage
  } catch {
    return undefined
  }
}

async function readSseResult(res: Response, id: unknown): Promise<unknown> {
  const text = await res.text()
  for (const block of text.split(/\n\n/)) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
    if (dataLines.length === 0) continue
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as JsonRpcMessage
      if (parsed.id !== id && parsed.id !== undefined) continue
      if (parsed.error) throw new Error(parsed.error.message || 'MCP JSON-RPC error')
      return parsed.result
    } catch (error) {
      if (error instanceof Error && error.message !== 'MCP JSON-RPC error') continue
      throw error
    }
  }
  throw new Error('MCP SSE response missing result')
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError')
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
