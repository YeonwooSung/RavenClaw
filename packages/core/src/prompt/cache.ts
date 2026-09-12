import { createHash } from 'node:crypto'
import type { Message, SystemPart } from '../types'

/**
 * sha256 hex of each part as `tier\0text\0{1|0}` records joined by `\0`.
 * Breakpoint bit is `1` only when `cacheBreakpoint === true`.
 */
export function hashSystemParts(parts: SystemPart[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(part.tier)
    hash.update('\0')
    hash.update(part.text)
    hash.update('\0')
    hash.update(part.cacheBreakpoint === true ? '1' : '0')
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function injectMidTurn(messages: Message[], text: string): Message[] {
  if (text.length === 0) return messages.slice()
  return trySuffixLast(messages, 'tool', text)
    ?? trySuffixLast(messages, 'assistant', text)
    ?? messages.slice()
}

/**
 * Only writer of mid-turn hints. Prefers last tool text, then last assistant
 * text. Appends a user row only when neither exists.
 */
export function injectMidTurnHint(messages: Message[], text: string): Message[] {
  if (text.length === 0) return messages.slice()
  const suffix = text.startsWith('\n') ? text : `\n${text}`
  const suffixed = trySuffixLast(messages, 'tool', suffix)
    ?? trySuffixLast(messages, 'assistant', suffix)
  if (suffixed) return suffixed
  const user: Extract<Message, { role: 'user' }> = {
    id: crypto.randomUUID(),
    role: 'user',
    blocks: [{ type: 'text', text }],
    createdAt: Date.now(),
  }
  return [...messages, user]
}

function trySuffixLast(
  messages: Message[],
  role: 'tool' | 'assistant',
  text: string,
): Message[] | null {
  const idx = lastIndex(messages, (m) => m.role === role)
  if (idx < 0) return null
  const msg = messages[idx]
  if (!msg || !hasTextBlock(msg.blocks)) return null
  return suffixTextBlock(messages, idx, text)
}

function suffixTextBlock(messages: Message[], index: number, text: string): Message[] {
  const msg = messages[index]
  if (!msg) return messages.slice()
  const blocks = msg.blocks.slice()
  const textIdx = lastIndex(blocks, (b) => b.type === 'text')
  if (textIdx < 0) return messages.slice()
  const block = blocks[textIdx]
  if (!block || block.type !== 'text') return messages.slice()
  blocks[textIdx] = { type: 'text', text: block.text + text }
  const next = messages.slice()
  next[index] = { ...msg, blocks } as Message
  return next
}

function hasTextBlock(blocks: ReadonlyArray<{ type: string }>): boolean {
  return blocks.some((b) => b.type === 'text')
}

function lastIndex<T>(items: readonly T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item !== undefined && pred(item)) return i
  }
  return -1
}
