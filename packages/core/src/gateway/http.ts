import { timingSafeEqual } from 'node:crypto'
import { safeWebhookToolNames } from './webhook'

export type TurnRequest =
  | { ok: true; text: string; sessionKey?: string }
  | { ok: false; error: string }

export function parseTurnRequest(body: unknown): TurnRequest {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' }
  }
  const rec = body as Record<string, unknown>
  if (typeof rec.text !== 'string') {
    return { ok: false, error: 'text is required' }
  }
  const text = rec.text.trim()
  if (text === '') return { ok: false, error: 'text is required' }
  if (rec.sessionKey === undefined) return { ok: true, text }
  if (typeof rec.sessionKey !== 'string') {
    return { ok: false, error: 'sessionKey must be a string' }
  }
  const key = rec.sessionKey.trim()
  if (key === '') return { ok: true, text }
  return { ok: true, text, sessionKey: key }
}

export function checkBearer(authHeader: string | undefined, secret: string): boolean {
  if (authHeader === undefined || secret === '') return false
  const trimmed = authHeader.trim()
  const space = trimmed.indexOf(' ')
  if (space === -1) return false
  const scheme = trimmed.slice(0, space)
  const token = trimmed.slice(space + 1).trim()
  if (scheme.toLowerCase() !== 'bearer' || token === '') return false
  return timingSafeStringEqual(token, secret)
}

export function webhookSafeTools<T extends { name: string }>(all: T[]): T[] {
  const allow = new Set(safeWebhookToolNames())
  return all.filter((tool) => allow.has(tool.name))
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}
