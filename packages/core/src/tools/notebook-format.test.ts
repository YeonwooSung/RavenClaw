import { describe, expect, test } from 'bun:test'
import {
  applyNotebookEdit,
  formatNotebookRead,
  parseNotebook,
  stringifyNotebook,
  toSourceArray,
} from './notebook-format'

const sample = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    { id: 'abc', cell_type: 'code', source: ['print(1)\n', 'print(2)'] },
    { id: 'def', cell_type: 'markdown', source: '# Hi' },
  ],
}

describe('parseNotebook', () => {
  test('parses cells with string or string[] source', () => {
    const parsed = parseNotebook(JSON.stringify(sample))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected parse success')
    expect(parsed.value.cells).toHaveLength(2)
    expect(parsed.value.cells[0]?.id).toBe('abc')
    expect(parsed.value.cells[1]?.cell_type).toBe('markdown')
  })

  test('returns an error for invalid JSON or a missing cells array', () => {
    expect(parseNotebook('{').ok).toBe(false)
    expect(parseNotebook('[]').ok).toBe(false)
    expect(parseNotebook('{"cells":"nope"}').ok).toBe(false)
    expect(parseNotebook('{"cells":[{"source":"x"}]}').ok).toBe(false)
  })
})

describe('formatNotebookRead', () => {
  test('renders headers and joined source', () => {
    const parsed = parseNotebook(JSON.stringify(sample))
    if (!parsed.ok) throw new Error('expected parse success')
    expect(formatNotebookRead(parsed.value)).toBe(
      ['## cell 0 (code) id=abc', 'print(1)\nprint(2)', '## cell 1 (markdown) id=def', '# Hi'].join(
        '\n',
      ),
    )
  })

  test('omits id= when a cell has no id', () => {
    const parsed = parseNotebook(JSON.stringify({ cells: [{ cell_type: 'code', source: 'x' }] }))
    if (!parsed.ok) throw new Error('expected parse success')
    expect(formatNotebookRead(parsed.value)).toBe('## cell 0 (code)\nx')
  })
})

describe('applyNotebookEdit', () => {
  test('replace finds a cell by id or the last cell and stores source as string[]', () => {
    const parsed = parseNotebook(JSON.stringify(sample))
    if (!parsed.ok) throw new Error('expected parse success')
    const byId = applyNotebookEdit(parsed.value, {
      cell_id: 'abc',
      new_source: 'print(3)',
      edit_mode: 'replace',
    })
    expect(byId.ok).toBe(true)
    expect(parsed.value.cells[0]?.source).toEqual(['print(3)'])

    const last = applyNotebookEdit(parsed.value, {
      new_source: '## last',
      cell_type: 'markdown',
      edit_mode: 'replace',
    })
    expect(last.ok).toBe(true)
    expect(parsed.value.cells[1]?.source).toEqual(['## last'])
    expect(parsed.value.cells[1]?.cell_type).toBe('markdown')
  })

  test('insert adds after cell_id or at the start with a c_ + 8hex id', () => {
    const parsed = parseNotebook(JSON.stringify({ cells: [{ id: 'abc', cell_type: 'code', source: 'x' }] }))
    if (!parsed.ok) throw new Error('expected parse success')
    const after = applyNotebookEdit(parsed.value, {
      cell_id: 'abc',
      new_source: 'y',
      edit_mode: 'insert',
    })
    expect(after.ok).toBe(true)
    if (!after.ok) throw new Error('expected insert')
    expect(after.cellId).toMatch(/^c_[0-9a-f]{8}$/)
    expect(parsed.value.cells).toHaveLength(2)
    expect(parsed.value.cells[1]?.id).toBe(after.cellId)
    expect(parsed.value.cells[1]?.source).toEqual(['y'])

    const atStart = applyNotebookEdit(parsed.value, {
      new_source: 'z',
      cell_type: 'markdown',
      edit_mode: 'insert',
    })
    expect(atStart.ok).toBe(true)
    expect(parsed.value.cells).toHaveLength(3)
    expect(parsed.value.cells[0]?.cell_type).toBe('markdown')
    expect(parsed.value.cells[0]?.source).toEqual(['z'])
  })

  test('delete removes by cell_id', () => {
    const parsed = parseNotebook(JSON.stringify(sample))
    if (!parsed.ok) throw new Error('expected parse success')
    const deleted = applyNotebookEdit(parsed.value, {
      cell_id: 'abc',
      new_source: '',
      edit_mode: 'delete',
    })
    expect(deleted.ok).toBe(true)
    expect(parsed.value.cells).toHaveLength(1)
    expect(parsed.value.cells[0]?.id).toBe('def')
  })

  test('returns an error when the target cell is missing', () => {
    const parsed = parseNotebook(JSON.stringify({ cells: [] }))
    if (!parsed.ok) throw new Error('expected parse success')
    expect(
      applyNotebookEdit(parsed.value, { new_source: 'x', edit_mode: 'replace' }).ok,
    ).toBe(false)
    expect(
      applyNotebookEdit(parsed.value, {
        cell_id: 'missing',
        new_source: 'x',
        edit_mode: 'insert',
      }).ok,
    ).toBe(false)
    expect(
      applyNotebookEdit(parsed.value, { cell_id: 'missing', new_source: '', edit_mode: 'delete' })
        .ok,
    ).toBe(false)
    expect(applyNotebookEdit(parsed.value, { new_source: '', edit_mode: 'delete' }).ok).toBe(false)
  })
})

describe('stringifyNotebook', () => {
  test('pretty-prints 1-space JSON by default and accepts 2-space', () => {
    const parsed = parseNotebook(JSON.stringify({ cells: [{ cell_type: 'code', source: 'x' }] }))
    if (!parsed.ok) throw new Error('expected parse success')
    const one = stringifyNotebook(parsed.value)
    expect(one.startsWith('{\n ')).toBe(true)
    expect(one.endsWith('\n')).toBe(true)
    expect(JSON.parse(one).cells[0].cell_type).toBe('code')
    const two = stringifyNotebook(parsed.value, 2)
    expect(two.startsWith('{\n  ')).toBe(true)
  })

  test('toSourceArray keeps newlines on every line except the last', () => {
    expect(toSourceArray('a\nb\n')).toEqual(['a\n', 'b\n', ''])
    expect(toSourceArray('a\nb')).toEqual(['a\n', 'b'])
    expect(toSourceArray('')).toEqual([])
  })
})
