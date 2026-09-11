import { describe, expect, test } from 'bun:test'
import { CLI_VERSION, HELP_TEXT, formatVersion } from './help'

describe('help text', () => {
  test('mentions commands and flags a first-time user needs', () => {
    expect(HELP_TEXT).toContain(CLI_VERSION)
    expect(HELP_TEXT).toContain('raven exec')
    expect(HELP_TEXT).toContain('raven acp')
    expect(HELP_TEXT).toContain('--tui')
    expect(HELP_TEXT).toContain('--help')
    expect(HELP_TEXT).toContain('--version')
  })

  test('formatVersion is a single line', () => {
    expect(formatVersion()).toBe(`raven ${CLI_VERSION}`)
    expect(formatVersion()).not.toContain('\n')
  })
})
