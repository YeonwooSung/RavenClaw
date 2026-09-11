import { describe, expect, test } from 'bun:test'
import { CLI_VERSION, HELP_TEXT, formatVersion } from './help'

describe('help text', () => {
  test('mentions commands and flags a first-time user needs', () => {
    expect(HELP_TEXT).toContain(CLI_VERSION)
    expect(HELP_TEXT).toContain('raven exec')
    expect(HELP_TEXT).toContain('raven acp')
    expect(HELP_TEXT).toContain('raven setup')
    expect(HELP_TEXT).toContain('raven smoke')
    expect(HELP_TEXT).toContain('raven sessions')
    expect(HELP_TEXT).toContain('raven show')
    expect(HELP_TEXT).toContain('raven rm')
    expect(HELP_TEXT).toContain('raven resume')
    expect(HELP_TEXT).toContain('raven search')
    expect(HELP_TEXT).toContain('raven export')
    expect(HELP_TEXT).toContain('raven title')
    expect(HELP_TEXT).toContain('raven doctor')
    expect(HELP_TEXT).toContain('raven config')
    expect(HELP_TEXT).toContain('raven init')
    expect(HELP_TEXT).toContain('raven completions')
    expect(HELP_TEXT).toContain('--tui')
    expect(HELP_TEXT).toContain('--help')
    expect(HELP_TEXT).toContain('--version')
  })

  test('formatVersion is a single line', () => {
    expect(formatVersion()).toBe(`raven ${CLI_VERSION}`)
    expect(formatVersion()).not.toContain('\n')
  })
})
