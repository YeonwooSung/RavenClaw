import type { SessionStore } from '../types'

export const MAX_PARALLEL_CHILDREN = 6
export const AGENT_MAIL_BODY_MAX = 4000

export function clipAgentMailBody(text: string): string {
  return text.length <= AGENT_MAIL_BODY_MAX ? text : text.slice(0, AGENT_MAIL_BODY_MAX)
}

export async function enqueueAgentMail(
  store: SessionStore,
  parentSessionId: string,
  text: string,
): Promise<void> {
  await store.enqueueAgentMail(parentSessionId, text)
}

export async function peekAgentMail(
  store: SessionStore,
  parentSessionId: string,
): Promise<string[]> {
  return store.peekAgentMail(parentSessionId)
}

export async function drainAgentMail(
  store: SessionStore,
  parentSessionId: string,
): Promise<string[]> {
  return store.drainAgentMail(parentSessionId)
}
