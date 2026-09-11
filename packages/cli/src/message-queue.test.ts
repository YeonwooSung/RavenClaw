import { describe, expect, test } from 'bun:test'
import {
  createMessageQueue,
  dequeue,
  enqueue,
  formatQueue,
  move,
  parseQueueArg,
  peekAll,
  removeAt,
} from './message-queue'

describe('message queue', () => {
  test('enqueue returns length and dequeue is FIFO', () => {
    const q = createMessageQueue()
    expect(q.items).toEqual([])
    expect(enqueue(q, 'a')).toBe(1)
    expect(enqueue(q, 'b')).toBe(2)
    expect(dequeue(q)).toBe('a')
    expect(dequeue(q)).toBe('b')
    expect(dequeue(q)).toBeUndefined()
  })

  test('peekAll is a copy', () => {
    const q = createMessageQueue()
    enqueue(q, 'keep')
    const all = peekAll(q)
    all.push('mutated')
    expect(peekAll(q)).toEqual(['keep'])
  })

  test('removeAt and move', () => {
    const q = createMessageQueue()
    enqueue(q, 'a')
    enqueue(q, 'b')
    enqueue(q, 'c')
    expect(removeAt(q, 1)).toBe('b')
    expect(peekAll(q)).toEqual(['a', 'c'])
    expect(removeAt(q, 9)).toBeUndefined()
    enqueue(q, 'd')
    move(q, 2, 0)
    expect(peekAll(q)).toEqual(['d', 'a', 'c'])
    move(q, 0, 2)
    expect(peekAll(q)).toEqual(['a', 'c', 'd'])
    move(q, -1, 0)
    move(q, 0, 99)
    expect(peekAll(q)).toEqual(['a', 'c', 'd'])
  })

  test('formatQueue', () => {
    const q = createMessageQueue()
    expect(formatQueue(q)).toBe('queue empty')
    enqueue(q, 'first')
    enqueue(q, 'second')
    expect(formatQueue(q)).toBe('1. first\n2. second')
  })
})

describe('parseQueueArg', () => {
  test('list, drop, clear, and errors', () => {
    expect(parseQueueArg()).toEqual({ action: 'list' })
    expect(parseQueueArg('')).toEqual({ action: 'list' })
    expect(parseQueueArg('   ')).toEqual({ action: 'list' })
    expect(parseQueueArg('list')).toEqual({ action: 'list' })
    expect(parseQueueArg('drop 2')).toEqual({ action: 'drop', index: 2 })
    expect(parseQueueArg('DROP 2')).toEqual({ action: 'drop', index: 2 })
    expect(parseQueueArg('clear')).toEqual({ action: 'clear' })
    expect(parseQueueArg('drop')).toEqual({
      action: 'error',
      message: 'usage: /queue [drop <n>|clear]',
    })
    expect(parseQueueArg('drop x')).toEqual({
      action: 'error',
      message: 'usage: /queue [drop <n>|clear]',
    })
    expect(parseQueueArg('bogus')).toEqual({
      action: 'error',
      message: 'usage: /queue [drop <n>|clear]',
    })
  })
})
