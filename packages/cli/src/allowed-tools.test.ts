import { describe, expect, test } from 'bun:test'
import { filterToolsByAllowList, parseAllowedTools } from './allowed-tools'
import { headlessAllowedTools, parseHeadlessToolsPreset } from './headless-permissions'

const pool = [
  { name: 'Read' },
  { name: 'Grep' },
  { name: 'Edit' },
  { name: 'EnterPlanMode' },
  { name: 'ExitPlanMode' },
]

describe('parseAllowedTools', () => {
  test('splits on commas, trims, and drops empty parts', () => {
    expect(parseAllowedTools('Read, Grep')).toEqual(['Read', 'Grep'])
    expect(parseAllowedTools('Read,,Grep,')).toEqual(['Read', 'Grep'])
    expect(parseAllowedTools('  Read  ,  ')).toEqual(['Read'])
    expect(parseAllowedTools('')).toEqual([])
    expect(parseAllowedTools('   ,  ,')).toEqual([])
  })
})

describe('filterToolsByAllowList', () => {
  test('returns the same tools when the allow list is missing or empty', () => {
    expect(filterToolsByAllowList(pool)).toBe(pool)
    expect(filterToolsByAllowList(pool, [])).toBe(pool)
  })

  test('keeps listed names and always keeps plan tools when present', () => {
    expect(filterToolsByAllowList(pool, ['Read']).map((tool) => tool.name)).toEqual([
      'Read',
      'EnterPlanMode',
      'ExitPlanMode',
    ])
    expect(filterToolsByAllowList(pool, ['Grep', 'Edit']).map((tool) => tool.name)).toEqual([
      'Grep',
      'Edit',
      'EnterPlanMode',
      'ExitPlanMode',
    ])
  })

  test('does not invent plan tools or mutate the input', () => {
    const noPlan = [{ name: 'Read' }, { name: 'Edit' }]
    expect(filterToolsByAllowList(noPlan, ['Read']).map((tool) => tool.name)).toEqual(['Read'])
    const before = pool.map((tool) => tool.name)
    filterToolsByAllowList(pool, ['Read'])
    expect(pool.map((tool) => tool.name)).toEqual(before)
  })
})

describe('headlessAllowedTools', () => {
  test('read, write, and ci are nested and never invent a bypass pool', () => {
    const read = headlessAllowedTools('read')
    const write = headlessAllowedTools('write')
    const ci = headlessAllowedTools('ci')
    expect(read).toEqual(['Read', 'Grep', 'Glob', 'ListDir', 'ReadSubtree', 'Skill'])
    expect(write).toEqual([...read, 'Edit', 'Write', 'ApplyPatch', 'NotebookEdit'])
    expect(ci).toEqual([...write, 'Bash'])
    expect(ci).not.toContain('bypass')
  })

  test('parseHeadlessToolsPreset accepts the three names', () => {
    expect(parseHeadlessToolsPreset('read')).toBe('read')
    expect(parseHeadlessToolsPreset('write')).toBe('write')
    expect(parseHeadlessToolsPreset('ci')).toBe('ci')
    expect(() => parseHeadlessToolsPreset('yolo')).toThrow(/tools preset/)
  })
})
