import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_SKEW_MS = 300_000

const SAFE_WEBHOOK_TOOLS = ['Read', 'Grep', 'Glob', 'Fetch', 'WebSearch'] as const

export function safeWebhookToolNames(): string[] {
  return [...SAFE_WEBHOOK_TOOLS]
}

export function verifyWebhookSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowMs?: number,
): boolean {
  if (header === undefined || header === '' || secret === '') return false
  const parsed = parseSignatureHeader(header)
  if (!parsed) return false
  const now = nowMs ?? Date.now()
  if (Math.abs(now - parsed.timestampMs) > MAX_SKEW_MS) return false
  const expected = createHmac('sha256', secret).update(`${parsed.timestamp}.${rawBody}`).digest('hex')
  return timingSafeHexEqual(expected, parsed.v1)
}

function parseSignatureHeader(header: string): { timestamp: string; timestampMs: number; v1: string } | undefined {
  let timestamp: string | undefined
  let v1: string | undefined
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't' && timestamp === undefined) timestamp = value
    else if (key === 'v1' && v1 === undefined) v1 = value
  }
  if (timestamp === undefined || v1 === undefined || v1 === '') return undefined
  if (!/^\d+$/.test(timestamp)) return undefined
  return { timestamp, timestampMs: Number(timestamp) * 1000, v1 }
}

function timingSafeHexEqual(expectedHex: string, givenHex: string): boolean {
  const expected = expectedHex.toLowerCase()
  const given = givenHex.toLowerCase()
  if (expected.length !== given.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'))
  } catch {
    return false
  }
}
