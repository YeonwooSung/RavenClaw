import { unpairedToolUseIds } from '../loop/pairing'
import type { Message, SessionRecord, SessionStore } from '../types'

export async function resumeSession(
  store: SessionStore,
  sessionId: string,
): Promise<{ session: SessionRecord; messages: Message[] }> {
  const loaded = await store.loadSession(sessionId)
  const unpaired = unpairedToolUseIds(loaded.messages)
  if (unpaired.length > 0) {
    throw new Error(`resumeSession: unpaired tool_use: ${unpaired.join(', ')}`)
  }
  return loaded
}
