import type { Message } from '@ravenclaw/core'

export type BranchArg =
  | { action: 'list' }
  | { action: 'select'; n: number }
  | { action: 'error' }

export function parseBranchArg(raw: string | undefined): BranchArg {
  const arg = (raw ?? '').trim()
  if (arg === '') return { action: 'list' }
  if (/^\d+$/.test(arg)) {
    const n = Number(arg)
    if (n >= 1) return { action: 'select', n }
  }
  return { action: 'error' }
}

function preview(message: Message): string {
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'text') parts.push(block.text)
  }
  const text = parts
    .join(' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/ +/g, ' ')
    .trim()
  if (text === '') return '(no text)'
  if (text.length > 60) return `${text.slice(0, 59)}…`
  return text
}

function formatLine(n: number, message: Message, starred: boolean): string {
  const mark = starred ? '* ' : '  '
  return `${mark}${n} ${message.role}  ${preview(message)}`
}

export function formatBranchList(messages: Message[]): string {
  return messages
    .map((message, index) => formatLine(index + 1, message, index === messages.length - 1))
    .join('\n')
}

export function formatBranchNotice(path: Message[], others: Message[]): string {
  const lines = path.map((message, index) =>
    formatLine(index + 1, message, index === path.length - 1),
  )
  if (others.length > 0 && path.length > 0) lines.push('', 'other')
  let n = path.length
  for (const message of others) {
    n += 1
    lines.push(formatLine(n, message, false))
  }
  return lines.join('\n')
}
