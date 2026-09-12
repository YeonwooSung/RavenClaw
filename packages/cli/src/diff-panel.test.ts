import { describe, expect, test } from 'bun:test'
import { formatDiffPanel } from './diff-cmd'
import { DiffPanel } from './diff-panel'

describe('DiffPanel', () => {
  test('is a function that renders formatDiffPanel lines', () => {
    expect(typeof DiffPanel).toBe('function')
    const view = { kind: 'clean' as const }
    expect(formatDiffPanel(view)).toEqual(['no uncommitted changes'])
    expect(DiffPanel({ view, selected: 0 })).not.toBeNull()
  })
})
