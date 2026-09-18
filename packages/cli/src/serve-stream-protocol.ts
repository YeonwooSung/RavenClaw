export const STREAM_PROTOCOL_VERSION = 1 as const

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
