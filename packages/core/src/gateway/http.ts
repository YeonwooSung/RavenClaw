import { timingSafeEqual } from 'node:crypto'
import { isPendingAskAnswer, type PendingAskAnswer } from '../session/pending-asks'
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

export function parseCancelBody(
  body: unknown,
): { ok: true; turnId?: string } | { ok: false; error: string } {
  if (body === undefined || body === null) return { ok: true }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' }
  }
  const rec = body as Record<string, unknown>
  if (rec.turnId === undefined) return { ok: true }
  if (typeof rec.turnId !== 'string') {
    return { ok: false, error: 'turnId must be a string' }
  }
  const turnId = rec.turnId.trim()
  if (turnId === '') return { ok: true }
  return { ok: true, turnId }
}

export function parseResolveBody(
  body: unknown,
): { ok: true; callId: string; answer: PendingAskAnswer } | { ok: false; error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' }
  }
  const rec = body as Record<string, unknown>
  if (typeof rec.callId !== 'string') {
    return { ok: false, error: 'callId is required' }
  }
  const callId = rec.callId.trim()
  if (callId === '') return { ok: false, error: 'callId is required' }
  const hasAllow = rec.allow !== undefined
  const hasAnswer = rec.answer !== undefined
  if (hasAllow && typeof rec.allow !== 'boolean') {
    return { ok: false, error: 'allow must be a boolean' }
  }
  if (hasAnswer && !isPendingAskAnswer(rec.answer)) {
    return { ok: false, error: 'answer must be allow, deny, allow_always, or ignored' }
  }
  if (!hasAllow && !hasAnswer) {
    return { ok: false, error: 'allow or answer is required' }
  }
  const fromAllow: PendingAskAnswer | undefined = hasAllow
    ? rec.allow
      ? 'allow'
      : 'deny'
    : undefined
  const fromAnswer = hasAnswer ? rec.answer : undefined
  if (fromAllow !== undefined && fromAnswer !== undefined && fromAllow !== fromAnswer) {
    return { ok: false, error: 'allow and answer disagree' }
  }
  return { ok: true, callId, answer: fromAnswer ?? fromAllow! }
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
