import { createHash } from 'node:crypto'
import type { ContentBlock, Message, SystemPart } from '../types'

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

  const toolIdx = lastIndex(messages, (m) => m.role === 'tool')
  if (toolIdx >= 0) {
    return suffixTextBlock(messages, toolIdx, text)
  }

  const assistantIdx = lastIndex(messages, (m) => m.role === 'assistant')
  if (assistantIdx >= 0) {
    const msg = messages[assistantIdx]
    if (msg && msg.role === 'assistant' && hasTextBlock(msg.blocks)) {
      return suffixTextBlock(messages, assistantIdx, text)
    }
  }

  return messages.slice()
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

function hasTextBlock(blocks: ContentBlock[]): boolean {
  return blocks.some((b) => b.type === 'text')
}

function lastIndex<T>(items: readonly T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item !== undefined && pred(item)) return i
  }
  return -1
}
