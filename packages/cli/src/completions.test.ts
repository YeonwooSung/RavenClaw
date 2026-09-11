import { describe, expect, test } from 'bun:test'
import { COMPLETION_COMMANDS, completionsScript } from './completions'

describe('completionsScript', () => {
  test('bash script completes commands and providers', () => {
    const result = completionsScript('bash')
    expect(result).toHaveProperty('text')
    if (!('text' in result)) throw new Error('expected text')
    expect(result.text).toContain('complete -F _raven raven')
    expect(result.text).toContain('anthropic openai_compat')
    for (const cmd of COMPLETION_COMMANDS) {
      expect(result.text).toContain(cmd)
    }
  })

  test('zsh script is a #compdef', () => {
    const result = completionsScript('Zsh')
    expect(result).toHaveProperty('text')
    if (!('text' in result)) throw new Error('expected text')
    expect(result.text.startsWith('#compdef raven')).toBe(true)
    expect(result.text).toContain('ink opentui')
    expect(result.text).toContain('init')
  })

  test('unknown shell is usage', () => {
    expect(completionsScript('fish')).toEqual({
      error: 'usage: raven completions bash|zsh',
    })
    expect(completionsScript('')).toEqual({
      error: 'usage: raven completions bash|zsh',
    })
  })
})
