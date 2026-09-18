export const STREAM_PROTOCOL_VERSION = 1 as const

export type ContinuationCursor = {
  version: typeof STREAM_PROTOCOL_VERSION
  sessionId: string
  lastSeq: number
}

export function parseVersionParam(
  raw: string | null,
): { ok: true; version?: number } | { ok: false; error: 'invalid version' | 'unsupported stream version' } {
  if (raw === null) return { ok: true }
  if (!/^\d+$/.test(raw)) return { ok: false, error: 'invalid version' }
  const version = Number(raw)
  if (!Number.isSafeInteger(version)) return { ok: false, error: 'invalid version' }
  if (version !== STREAM_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported stream version' }
  }
  return { ok: true, version }
}

export function encodeContinuationToken(cursor: { sessionId: string; lastSeq: number }): string {
  if (typeof cursor.sessionId !== 'string' || cursor.sessionId === '') {
    throw new Error('invalid sessionId')
  }
  if (!Number.isSafeInteger(cursor.lastSeq) || cursor.lastSeq < 0) {
    throw new Error('invalid lastSeq')
  }
  return Buffer.from(
    JSON.stringify({ v: STREAM_PROTOCOL_VERSION, s: cursor.sessionId, q: cursor.lastSeq }),
    'utf8',
  ).toString('base64url')
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/

export function decodeContinuationToken(
  raw: string,
):
  | { ok: true; cursor: ContinuationCursor }
  | { ok: false; error: 'invalid continuationToken' | 'unsupported stream version' } {
  if (typeof raw !== 'string' || raw === '' || !BASE64URL_RE.test(raw)) {
    return { ok: false, error: 'invalid continuationToken' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
  } catch {
    return { ok: false, error: 'invalid continuationToken' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'invalid continuationToken' }
  }
  const rec = parsed as Record<string, unknown>
  if (typeof rec.v !== 'number') {
    return { ok: false, error: 'invalid continuationToken' }
  }
  if (rec.v !== STREAM_PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported stream version' }
  }
  if (typeof rec.s !== 'string' || rec.s === '') {
    return { ok: false, error: 'invalid continuationToken' }
  }
  if (typeof rec.q !== 'number' || !Number.isSafeInteger(rec.q) || rec.q < 0) {
    return { ok: false, error: 'invalid continuationToken' }
  }
  return {
    ok: true,
    cursor: { version: STREAM_PROTOCOL_VERSION, sessionId: rec.s, lastSeq: rec.q },
  }
}
