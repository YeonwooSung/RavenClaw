import { describe, expect, test } from 'bun:test'
import { LEARN_PROMPT, SLASH_HELP, handleSlashCommand } from './commands'

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
    ['/review', { type: 'command', name: 'review' }],
    ['/title Fix login', { type: 'command', name: 'title', arg: 'Fix login' }],
    ['/help', { type: 'command', name: 'help' }],
    ['/?', { type: 'command', name: '?' }],
  ] as const)('%s', (line, expected) => {
    expect(handleSlashCommand(line)).toEqual(expected)
  })

  test('unknown slash stays a command so the app can reject it', () => {
    expect(handleSlashCommand('/nope')).toEqual({ type: 'command', name: 'nope' })
  })

  test('SLASH_HELP lists the in-session commands', () => {
    expect(SLASH_HELP).toContain('/resume')
    expect(SLASH_HELP).toContain('/search')
    expect(SLASH_HELP).toContain('/help')
    expect(SLASH_HELP).toContain('/review')
    expect(SLASH_HELP).toContain('/title')
    expect(SLASH_HELP).toContain('/quit')
  })

  test('learn prompt asks to write a skill, and is not a tool name', () => {
    expect(LEARN_PROMPT).toContain('SKILL.md')
    expect(LEARN_PROMPT.toLowerCase()).toContain('write a new skill')
    expect(handleSlashCommand('/learn')).toEqual({ type: 'command', name: 'learn' })
  })
})
