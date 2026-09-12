import { lookup } from 'node:dns/promises'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export interface FetchInput {
  url: string
}

const FETCH_TIMEOUT_MS = 10_000
const FETCH_CHAR_CAP = 100_000
const TRUNCATION_NOTE = '\n... [truncated: output exceeds 100000 characters]'

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', minLength: 1 },
  },
}

export const fetchTool: Tool<FetchInput, string> = {
  name: 'Fetch',
  description:
    'Fetch a public https URL and return text (capped at 100000 characters). http, file, localhost, loopback, private, and link-local addresses are rejected. Timeout is 10 seconds.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<FetchInput>(inputSchema, input)
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
  async checkPermissions(input: FetchInput) {
    return { behavior: 'ask', message: `Fetch ${input.url}` }
  },
  async execute(input: FetchInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const blocked = isBlockedFetchUrl(input.url)
    if (blocked !== undefined) return `Fetch failed: ${blocked}`

    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const signal = combineSignals(ctx.signal, timeout)
    try {
      const response = await fetchValidated(input.url, signal)
      if (response === undefined) return 'Fetch failed: redirected to a blocked URL'
      const text = await response.text()
      if (text.length > FETCH_CHAR_CAP) return text.slice(0, FETCH_CHAR_CAP) + TRUNCATION_NOTE
      return text
    } catch (error) {
      if (isAbort(error) || ctx.signal.aborted) {
        if (ctx.signal.aborted) throw abortError()
        return 'Fetch failed: timed out'
      }
      const message = error instanceof Error ? error.message : String(error)
      return `Fetch failed: ${message}`
    }
  },
}

export function isBlockedFetchUrl(raw: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return 'invalid URL'
  }
  if (parsed.protocol !== 'https:') return 'only https URLs are allowed'
  if (parsed.hostname === '') return 'missing hostname'
  if (parsed.username !== '' || parsed.password !== '') return 'userinfo is not allowed'
  if (isBlockedHost(parsed.hostname)) return 'localhost, loopback, private, and link-local hosts are blocked'
  return undefined
}

async function fetchValidated(url: string, signal: AbortSignal): Promise<Response | undefined> {
  let current = url
  for (let hop = 0; hop < 5; hop++) {
    const blocked = isBlockedFetchUrl(current)
    if (blocked !== undefined) return undefined
    if (await hostResolvesPrivate(new URL(current).hostname)) return undefined
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { Accept: 'text/*, application/json;q=0.9, */*;q=0.1' },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location === null || location === '') return undefined
      current = new URL(location, current).href
      continue
    }
    return response
  }
  return undefined
}

async function hostResolvesPrivate(hostname: string): Promise<boolean> {
  if (isBlockedHost(hostname)) return true
  try {
    const rows = await lookup(hostname, { all: true })
    return rows.some((row) => isBlockedHost(row.address))
  } catch {
    return false
  }
}

function isBlockedHost(host: string): boolean {
  const h = stripBrackets(host).toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0') return true
  if (h === '::' || h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '0:0:0:0:0:0:0:0') return true
  if (h.startsWith('fe80:')) return true
  if (isUniqueLocalIPv6(h)) return true
  const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(h)
  if (mappedV4?.[1] !== undefined) {
    const ipv4 = parseIPv4(mappedV4[1])
    return ipv4 !== undefined && isPrivateOrLinkLocalIPv4(ipv4)
  }
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h)
  if (mappedHex?.[1] !== undefined && mappedHex[2] !== undefined) {
    const hi = Number.parseInt(mappedHex[1], 16)
    const lo = Number.parseInt(mappedHex[2], 16)
    if (Number.isInteger(hi) && Number.isInteger(lo)) {
      return isPrivateOrLinkLocalIPv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff])
    }
  }
  const ipv4 = parseIPv4(h)
  if (ipv4 !== undefined) return isPrivateOrLinkLocalIPv4(ipv4)
  return false
}

function isUniqueLocalIPv6(host: string): boolean {
  if (!host.includes(':')) return false
  const first = host.split(':')[0] ?? ''
  if (!/^[0-9a-f]{1,4}$/i.test(first)) return false
  const n = Number.parseInt(first, 16)
  return (n & 0xfe00) === 0xfc00
}

function parseIPv4(host: string): [number, number, number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return undefined
  const parts = [match[1], match[2], match[3], match[4]].map((part) => Number(part))
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
  return parts as [number, number, number, number]
}

function isPrivateOrLinkLocalIPv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
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
