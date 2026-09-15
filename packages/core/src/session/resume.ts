import { unpairedToolUseIds } from '../loop/pairing'
import type { Message, SessionRecord, SessionStore } from '../types'

export async function resumeSession(
  store: SessionStore,
  sessionId: string,
): Promise<{ session: SessionRecord; messages: Message[] }> {
  const loaded = await store.loadSession(sessionId)
  const pending = (await store.listPendingAsks?.(sessionId)) ?? []
  const pendingIds = new Set(pending.map((row) => row.callId))
  const children = (await store.listSessions?.({ parentSessionId: sessionId })) ?? []
  let childHasPending = false
  for (const child of children) {
    const childPending = (await store.listPendingAsks?.(child.id)) ?? []
    if (childPending.length > 0) childHasPending = true
    for (const row of childPending) pendingIds.add(row.callId)
  }
  const unpaired = unpairedToolUseIds(loaded.messages).filter((id) => !pendingIds.has(id))
  const leftover = childHasPending
    ? unpaired.filter((id) => !isAgentToolUse(loaded.messages, id))
    : unpaired
  if (leftover.length > 0) {
    throw new Error(`resumeSession: unpaired tool_use: ${leftover.join(', ')}`)
  }
  return loaded
}

function isAgentToolUse(messages: Message[], id: string): boolean {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.blocks) {
      if (block.type === 'tool_use' && block.id === id && block.name === 'Agent') return true
    }
  }
  return false
}
