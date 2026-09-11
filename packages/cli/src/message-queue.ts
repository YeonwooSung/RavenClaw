export type MessageQueue = { items: string[] }

export type QueueArg =
  | { action: 'list' }
  | { action: 'drop'; index: number }
  | { action: 'clear' }
  | { action: 'error'; message: string }

const USAGE = 'usage: /queue [drop <n>|clear]'

export function createMessageQueue(): MessageQueue {
  return { items: [] }
}

export function enqueue(q: MessageQueue, text: string): number {
  q.items.push(text)
  return q.items.length
}

export function dequeue(q: MessageQueue): string | undefined {
  return q.items.shift()
}

export function peekAll(q: MessageQueue): string[] {
  return q.items.slice()
}

export function removeAt(q: MessageQueue, index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= q.items.length) return undefined
  const [removed] = q.items.splice(index, 1)
  return removed
}

export function move(q: MessageQueue, from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return
  if (from < 0 || from >= q.items.length) return
  if (to < 0 || to >= q.items.length) return
  if (from === to) return
  const [item] = q.items.splice(from, 1)
  if (item === undefined) return
  q.items.splice(to, 0, item)
}

export function formatQueue(q: MessageQueue): string {
  if (q.items.length === 0) return 'queue empty'
  return q.items.map((item, i) => `${i + 1}. ${item}`).join('\n')
}

export function parseQueueArg(arg?: string): QueueArg {
  if (arg === undefined || arg.trim() === '') return { action: 'list' }
  const trimmed = arg.trim()
  const verb = trimmed.split(/\s+/, 1)[0]?.toLowerCase()
  const rest = trimmed.slice(verb?.length ?? 0).trim()
  if (verb === 'list') {
    if (rest !== '') return { action: 'error', message: USAGE }
    return { action: 'list' }
  }
  if (verb === 'clear') {
    if (rest !== '') return { action: 'error', message: USAGE }
    return { action: 'clear' }
  }
  if (verb === 'drop') {
    if (!/^\d+$/.test(rest)) return { action: 'error', message: USAGE }
    return { action: 'drop', index: Number(rest) }
  }
  return { action: 'error', message: USAGE }
}
