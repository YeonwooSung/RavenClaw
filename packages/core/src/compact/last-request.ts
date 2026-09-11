const lastRequestAtBySession = new Map<string, number>()

export function getLastRequestAt(sessionId: string): number | undefined {
  return lastRequestAtBySession.get(sessionId)
}

export function markLastRequestAt(sessionId: string, at: number = Date.now()): void {
  lastRequestAtBySession.set(sessionId, at)
}

export function clearLastRequestAt(sessionId?: string): void {
  if (sessionId === undefined) lastRequestAtBySession.clear()
  else lastRequestAtBySession.delete(sessionId)
}
