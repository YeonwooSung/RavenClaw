import { describe, expect, test } from 'bun:test'
import { LEARN_PROMPT, handleSlashCommand } from './commands'

describe('handleSlashCommand', () => {
  test('plain text is a prompt', () => {
    expect(handleSlashCommand('list the files')).toEqual({
      type: 'prompt',
      text: 'list the files',
    })
  })

  test('trims surrounding whitespace on prompts', () => {
    expect(handleSlashCommand('  hello  ')).toEqual({
      type: 'prompt',
      text: 'hello',
    })
  })

  test.each([
    ['/resume', { type: 'command', name: 'resume' }],
    ['/resume abc123', { type: 'command', name: 'resume', arg: 'abc123' }],
    ['/compact', { type: 'command', name: 'compact' }],
    ['/mode plan', { type: 'command', name: 'mode', arg: 'plan' }],
    ['/cost', { type: 'command', name: 'cost' }],
    ['/search', { type: 'command', name: 'search' }],
    ['/search foo', { type: 'command', name: 'search', arg: 'foo' }],
    ['/search --all bar', { type: 'command', name: 'search', arg: '--all bar' }],
    ['/quit', { type: 'command', name: 'quit' }],
    ['/learn', { type: 'command', name: 'learn' }],
  ] as const)('%s', (line, expected) => {
    expect(handleSlashCommand(line)).toEqual(expected)
  })

  test('unknown slash stays a command so the app can reject it', () => {
    expect(handleSlashCommand('/nope')).toEqual({ type: 'command', name: 'nope' })
  })

  test('learn prompt asks to write a skill, and is not a tool name', () => {
    expect(LEARN_PROMPT).toContain('SKILL.md')
    expect(LEARN_PROMPT.toLowerCase()).toContain('write a new skill')
    expect(handleSlashCommand('/learn')).toEqual({ type: 'command', name: 'learn' })
  })
})
