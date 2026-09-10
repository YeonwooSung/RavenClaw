import type { ContentBlock, Message } from '../types'
import { INCOMPLETE_TEXT, makeToolMessage } from './pairing'

export const ASSISTANT_STUB_TEXT = '(conversation summary follows)'

function textOf(msg: Message): string {
  return msg.blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function hasToolUse(msg: Message): boolean {
  return msg.role === 'assistant' && msg.blocks.some((block) => block.type === 'tool_use')
}

function joinUsers(
  a: Extract<Message, { role: 'user' }>,
  b: Extract<Message, { role: 'user' }>,
): Extract<Message, { role: 'user' }> {
  return {
    id: a.id,
    role: 'user',
    blocks: [{ type: 'text', text: `${textOf(a)}\n\n${textOf(b)}` }],
    createdAt: a.createdAt,
  }
}

function joinAssistants(
  a: Extract<Message, { role: 'assistant' }>,
  b: Extract<Message, { role: 'assistant' }>,
): Extract<Message, { role: 'assistant' }> {
  const bText = textOf(b)
  const bHasThinking = b.blocks.some((block) => block.type === 'thinking')
  const bHasTools = b.blocks.some((block) => block.type === 'tool_use')
  if (!bText && !bHasThinking && !bHasTools) return a

  const thinking = a.blocks.filter(
    (block): block is Extract<ContentBlock, { type: 'thinking' }> =>
      block.type === 'thinking',
  )
  const text = [textOf(a), bText].filter((part) => part.length > 0).join('\n\n')
  const blocks: ContentBlock[] = [...thinking]
  if (text) blocks.push({ type: 'text', text })
  const out: Extract<Message, { role: 'assistant' }> = {
    id: a.id,
    role: 'assistant',
    blocks,
    createdAt: a.createdAt,
  }
  if (a.usage) out.usage = a.usage
  return out
}

function flushUnpaired(out: Message[]): void {
  let i = out.length - 1
  while (i >= 0 && out[i]?.role === 'tool') i -= 1
  const asst = i >= 0 ? out[i] : undefined
  if (!asst || asst.role !== 'assistant') return
  const existing = new Set<string>()
  for (let j = i + 1; j < out.length; j++) {
    const msg = out[j]
    if (msg?.role === 'tool') existing.add(msg.toolUseId)
  }
  for (const block of asst.blocks) {
    if (block.type === 'tool_use' && !existing.has(block.id)) {
      out.push(makeToolMessage(block.id, false, INCOMPLETE_TEXT))
    }
  }
}

export function repairRoleAlternation(messages: Message[]): Message[] {
  let start = 0
  while (start < messages.length && messages[start]?.role === 'tool') start += 1
  const out: Message[] = []

  for (let idx = start; idx < messages.length; idx++) {
    const msg = messages[idx]
    if (!msg) continue

    if (msg.role === 'tool') {
      let i = out.length - 1
      while (i >= 0 && out[i]?.role === 'tool') i -= 1
      const asst = i >= 0 ? out[i] : undefined
      if (!asst || asst.role !== 'assistant') continue
      const uses = new Set(
        asst.blocks
          .filter(
            (block): block is Extract<ContentBlock, { type: 'tool_use' }> =>
              block.type === 'tool_use',
          )
          .map((block) => block.id),
      )
      if (!uses.has(msg.toolUseId)) continue
      const already = out
        .slice(i + 1)
        .some((row) => row.role === 'tool' && row.toolUseId === msg.toolUseId)
      if (already) continue
      out.push(msg)
      continue
    }

    if (msg.role === 'user') {
      flushUnpaired(out)
      const last = out[out.length - 1]
      if (last?.role === 'user') {
        out[out.length - 1] = joinUsers(last, msg)
      } else {
        out.push(msg)
      }
      continue
    }

    flushUnpaired(out)
    const last = out[out.length - 1]
    if (last?.role === 'assistant' && !hasToolUse(last) && !hasToolUse(msg)) {
      out[out.length - 1] = joinAssistants(last, msg)
    } else {
      out.push(msg)
    }
  }

  flushUnpaired(out)
  return out
}

function ownerIndex(messages: Message[], toolUseId: string): number {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant') continue
    if (msg.blocks.some((block) => block.type === 'tool_use' && block.id === toolUseId)) {
      return i
    }
  }
  return -1
}

export function selectProtectedTail(messages: Message[], n: number): Message[] {
  if (n <= 0 || messages.length === 0) return []
  let start = Math.max(0, messages.length - n)

  let changed = true
  while (changed && start > 0) {
    changed = false
    const first = messages[start]
    if (first?.role === 'tool') {
      const owner = ownerIndex(messages, first.toolUseId)
      if (owner >= 0 && owner < start) {
        start = owner
      } else {
        start -= 1
      }
      changed = true
      continue
    }
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i]
      if (msg?.role !== 'tool') continue
      const owner = ownerIndex(messages, msg.toolUseId)
      if (owner >= 0 && owner < start) {
        start = owner
        changed = true
      }
    }
  }

  return messages.slice(start)
}

export function buildPostCompactMessages(summary: string, tail: Message[]): Message[] {
  const userSummary: Extract<Message, { role: 'user' }> = {
    id: crypto.randomUUID(),
    role: 'user',
    blocks: [{ type: 'text', text: summary }],
    createdAt: Date.now(),
  }
  if (tail.length === 0) return [userSummary]
  if (tail[0]?.role === 'user') {
    const stub: Extract<Message, { role: 'assistant' }> = {
      id: crypto.randomUUID(),
      role: 'assistant',
      blocks: [{ type: 'text', text: ASSISTANT_STUB_TEXT }],
      createdAt: Date.now(),
    }
    return [stub, userSummary, ...tail]
  }
  return [userSummary, ...tail]
}
