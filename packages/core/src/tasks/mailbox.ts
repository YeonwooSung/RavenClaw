export const MAX_PARALLEL_CHILDREN = 6

const mailboxes = new Map<string, string[]>()

export function enqueueAgentMail(parentSessionId: string, text: string): void {
  const queue = mailboxes.get(parentSessionId)
  if (queue) queue.push(text)
  else mailboxes.set(parentSessionId, [text])
}

export function drainAgentMail(parentSessionId: string): string[] {
  const notices = mailboxes.get(parentSessionId)
  if (!notices) return []
  mailboxes.delete(parentSessionId)
  return notices
}
