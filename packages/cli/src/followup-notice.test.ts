import { describe, expect, test } from 'bun:test'
import { formatFollowupNotice, pickFollowup } from './followup-notice'

describe('formatFollowupNotice', () => {
  test('prefixes followups: and numbers each line', () => {
    expect(formatFollowupNotice(['run tests', 'commit'])).toBe(
      'followups:\n1. run tests\n2. commit',
    )
    expect(formatFollowupNotice([])).toBe('followups:\n')
  })
})

describe('pickFollowup', () => {
  test('uses a 1-based index', () => {
    const lines = ['one', 'two']
    expect(pickFollowup(lines, 1)).toBe('one')
    expect(pickFollowup(lines, 2)).toBe('two')
    expect(pickFollowup(lines, 0)).toBeUndefined()
    expect(pickFollowup(lines, 3)).toBeUndefined()
    expect(pickFollowup(lines, 1.5)).toBeUndefined()
  })
})
