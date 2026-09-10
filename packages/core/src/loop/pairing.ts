import type { Message } from '../types'

export const INCOMPLETE_TEXT =
  'incomplete: the process ended before this tool result was saved. The tool was not re-run.'

export const TOOLS_OMITTED_TEXT =
  'tools_omitted: tools were disabled on the final round; the call was not executed.'

export const ABORTED_TEXT =
  'aborted: the turn was interrupted before this tool finished.'

export const PERSIST_FAILED_TEXT =
  'persist_failed: the tool call could not be saved; it was not executed.'

export type PairReason = 'incomplete' | 'tools_omitted' | 'aborted' | 'persist_failed'

export function pairText(reason: PairReason): string {
  switch (reason) {
    case 'incomplete':
      return INCOMPLETE_TEXT
    case 'tools_omitted':
      return TOOLS_OMITTED_TEXT
    case 'aborted':
      return ABORTED_TEXT
    case 'persist_failed':
      return PERSIST_FAILED_TEXT
  }
}

export function makeToolMessage(
  toolUseId: string,
  ok: boolean,
  text: string,
): Extract<Message, { role: 'tool' }> {
  return {
    id: crypto.randomUUID(),
    role: 'tool',
    toolUseId,
    ok,
    blocks: [{ type: 'text', text }],
    createdAt: Date.now(),
  }
}

export function pairMissing(
  ids: string[],
  reason: PairReason,
): Array<Extract<Message, { role: 'tool' }>> {
  return ids.map((id) => makeToolMessage(id, false, pairText(reason)))
}

export function unknownToolText(name: string): string {
  return `unknown_tool: no tool named '${name}' is registered.`
}

export function parseFailedText(message: string): string {
  return `parse_failed: ${message}`
}

export function executeFailedText(message: string): string {
  return `execute_failed: ${message}`
}

export function denyText(message: string): string {
  return `permission_denied: ${message}`
}

export function unpairedToolUseIds(messages: Message[]): string[] {
  const paired = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'tool') paired.add(msg.toolUseId)
  }
  const unpaired: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.blocks) {
      if (block.type === 'tool_use' && !paired.has(block.id)) unpaired.push(block.id)
    }
  }
  return unpaired
}

export function toolUseIdsOf(
  message: Extract<Message, { role: 'assistant' }>,
): string[] {
  const ids: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'tool_use') ids.push(block.id)
  }
  return ids
}
