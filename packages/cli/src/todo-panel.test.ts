import { describe, expect, test } from 'bun:test'
import { formatTodoLine, formatTodoLines, TodoPanel } from './todo-panel'

describe('formatTodoLines', () => {
  test('empty → []', () => {
    expect(formatTodoLines([])).toEqual([])
  })

  test('items → id status text lines', () => {
    expect(
      formatTodoLines([
        { id: 't1', text: 'ship', status: 'pending' },
        { id: 't2', text: 'test', status: 'in_progress' },
        { id: 't3', text: 'done work', status: 'done' },
      ]),
    ).toEqual(['t1 pending ship', 't2 in_progress test', 't3 done done work'])
  })

  test('missing id uses a dash placeholder', () => {
    expect(formatTodoLine({ text: 'untagged', status: 'pending' })).toBe('- pending untagged')
    expect(formatTodoLines([{ text: 'untagged', status: 'pending' }])).toEqual([
      '- pending untagged',
    ])
  })
})

describe('TodoPanel', () => {
  test('is a function that hides when formatTodoLines is empty', () => {
    expect(typeof TodoPanel).toBe('function')
    expect(formatTodoLines([])).toEqual([])
    expect(TodoPanel({ items: [] })).toBeNull()
  })
})
