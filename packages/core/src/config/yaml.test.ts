import { describe, expect, test } from 'bun:test'
import { upsertYamlTopLevelScalar } from './yaml'

describe('upsertYamlTopLevelScalar', () => {
  test('empty text writes key and trailing newline', () => {
    expect(upsertYamlTopLevelScalar('', 'instructionFiles', 'claude')).toBe(
      'instructionFiles: claude\n',
    )
  })

  test('preserves comments and other keys', () => {
    const input = ['# house', 'model: x', 'provider: anthropic', ''].join('\n')
    const out = upsertYamlTopLevelScalar(input, 'instructionFiles', 'claude')
    expect(out.startsWith('# house\n')).toBe(true)
    expect(out).toContain('model: x\n')
    expect(out).toContain('provider: anthropic\n')
    expect(out).toContain('instructionFiles: claude\n')
    expect((out.match(/^instructionFiles:/m) ?? []).length).toBe(1)
  })

  test('replaces the first top-level scalar occurrence', () => {
    const out = upsertYamlTopLevelScalar(
      'instructionFiles: both\nmodel: x\n',
      'instructionFiles',
      'claude',
    )
    expect(out).toBe('instructionFiles: claude\nmodel: x\n')
  })

  test('throws when the key is a nested map', () => {
    expect(() =>
      upsertYamlTopLevelScalar('instructionFiles:\n  foo: 1\n', 'instructionFiles', 'both'),
    ).toThrow('instructionFiles is not a scalar')
  })
})
