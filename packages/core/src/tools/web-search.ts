import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export interface WebSearchInput {
  query: string
  depth?: 'standard' | 'deep'
}

export type WebSearchFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface WebSearchEnv {
  BRAVE_API_KEY?: string
  SERPER_API_KEY?: string
  WEBSEARCH_API_KEY?: string
}

export interface WebSearchOptions {
  fetchImpl?: WebSearchFetch
  env?: WebSearchEnv
}

const SEARCH_TIMEOUT_MS = 10_000
const RESULT_CHAR_CAP = 20_000
const TRUNCATION_NOTE = '\n... [truncated]'
const BRAVE_HOST = 'api.search.brave.com'
const SERPER_HOST = 'google.serper.dev'
const ALLOWED_HOSTS = new Set([BRAVE_HOST, SERPER_HOST])

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1 },
    depth: { type: 'string', enum: ['standard', 'deep'] },
  },
}

export function createWebSearchTool(opts: WebSearchOptions = {}): Tool<WebSearchInput, string> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const env = opts.env

  return {
    name: 'WebSearch',
    description:
      'Search the public web via Brave or Serper. Requires BRAVE_API_KEY or SERPER_API_KEY (WEBSEARCH_API_KEY is treated as Brave). depth "deep" returns 10 results, otherwise 5. HTTPS to those two hosts only.',
    inputSchema,
    parse(input: unknown) {
      return parseWithSchema<WebSearchInput>(inputSchema, input)
    },
    isEnabled() {
      return false
    },
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return true
    },
    interruptBehavior() {
      return 'cancel'
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute(input: WebSearchInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const keys = resolveKeys(env)
      if (keys === undefined) {
        return 'WebSearch failed: set BRAVE_API_KEY or SERPER_API_KEY'
      }
      const count = input.depth === 'deep' ? 10 : 5
      const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS)
      const signal = combineSignals(ctx.signal, timeout)
      try {
        const blocks =
          keys.provider === 'serper'
            ? await searchSerper(fetchImpl, keys.key, input.query, count, signal)
            : await searchBrave(fetchImpl, keys.key, input.query, count, signal)
        if (typeof blocks !== 'string') return blocks.message
        if (blocks.length > RESULT_CHAR_CAP) {
          return blocks.slice(0, RESULT_CHAR_CAP) + TRUNCATION_NOTE
        }
        return blocks
      } catch (error) {
        if (isAbort(error) || ctx.signal.aborted) {
          if (ctx.signal.aborted) throw abortError()
          return 'WebSearch failed: timed out'
        }
        const message = error instanceof Error ? error.message : String(error)
        return `WebSearch failed: ${message}`
      }
    },
  }
}

export const webSearchTool = createWebSearchTool()

function resolveKeys(env: WebSearchEnv | undefined): { provider: 'brave' | 'serper'; key: string } | undefined {
  const source = env ?? process.env
  const brave = nonempty(source.BRAVE_API_KEY)
  if (brave !== undefined) return { provider: 'brave', key: brave }
  const serper = nonempty(source.SERPER_API_KEY)
  if (serper !== undefined) return { provider: 'serper', key: serper }
  const fallback = nonempty(source.WEBSEARCH_API_KEY)
  if (fallback !== undefined) return { provider: 'brave', key: fallback }
  return undefined
}

function nonempty(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  return value
}

async function searchBrave(
  fetchImpl: WebSearchFetch,
  key: string,
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<string | { message: string }> {
  const url = `https://${BRAVE_HOST}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`
  const blocked = blockedSearchUrl(url)
  if (blocked !== undefined) return { message: `WebSearch failed: ${blocked}` }
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    signal,
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  })
  if (!response.ok) return { message: `WebSearch failed: HTTP ${response.status}` }
  const body = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
  }
  const results = body.web?.results ?? []
  return formatBlocks(
    results.map((row) => ({
      title: row.title ?? '',
      url: row.url ?? '',
      snippet: row.description ?? '',
    })),
  )
}

async function searchSerper(
  fetchImpl: WebSearchFetch,
  key: string,
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<string | { message: string }> {
  const url = `https://${SERPER_HOST}/search`
  const blocked = blockedSearchUrl(url)
  if (blocked !== undefined) return { message: `WebSearch failed: ${blocked}` }
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: count }),
  })
  if (!response.ok) return { message: `WebSearch failed: HTTP ${response.status}` }
  const body = (await response.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>
  }
  const results = body.organic ?? []
  return formatBlocks(
    results.map((row) => ({
      title: row.title ?? '',
      url: row.link ?? '',
      snippet: row.snippet ?? '',
    })),
  )
}

function formatBlocks(rows: Array<{ title: string; url: string; snippet: string }>): string {
  return rows.map((row) => `${row.title}\n${row.url}\n${row.snippet}\n`).join('\n')
}

function blockedSearchUrl(raw: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return 'invalid URL'
  }
  if (parsed.protocol !== 'https:') return 'only https URLs are allowed'
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return 'host is not allowlisted'
  return undefined
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof any === 'function') return any([a, b])
  if (a.aborted) return a
  if (b.aborted) return b
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return controller.signal
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'TimeoutError')
  )
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
