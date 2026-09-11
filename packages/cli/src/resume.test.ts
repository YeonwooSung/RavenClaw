import { describe, expect, test } from 'bun:test'
import type { SessionRecord } from '@ravenclaw/core'
import { formatResumeSessionLine } from './resume'

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'abcdefghijklmnop',
    createdAt: 1,
    updatedAt: 99,
    cwd: '/tmp',
    model: 'dummy-model',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

describe('formatResumeSessionLine', () => {
  test('uses title when present', () => {
    expect(formatResumeSessionLine(session({ title: 'Fix login' }))).toBe(
      'abcdefgh  Fix login  99',
    )
  })

  test('falls back to model when title is missing or empty', () => {
    expect(formatResumeSessionLine(session())).toBe('abcdefgh  dummy-model  99')
    expect(formatResumeSessionLine(session({ title: '' }))).toBe('abcdefgh  dummy-model  99')
  })
})
