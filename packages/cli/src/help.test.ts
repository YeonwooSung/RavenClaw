import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    expect(HELP_TEXT).toContain('raven play')
    expect(HELP_TEXT).toContain('raven durable')
    expect(HELP_TEXT).toContain('raven config')
    expect(HELP_TEXT).toContain('raven init')
    expect(HELP_TEXT).toContain('raven completions')
    expect(HELP_TEXT).toContain('raven mcp')
    expect(HELP_TEXT).toContain('raven skills')
    expect(HELP_TEXT).toContain('raven cron')
    expect(HELP_TEXT).toContain('raven serve')
    expect(HELP_TEXT).toContain('raven slack')
    expect(HELP_TEXT).toContain('raven discord')
    expect(HELP_TEXT).toContain('raven pairing')
    expect(HELP_TEXT).toContain('raven eval')
    expect(HELP_TEXT).toContain('--tui')
    expect(HELP_TEXT).toContain('--tools-preset')
    expect(HELP_TEXT).toContain('--allowed-tools')
    expect(HELP_TEXT).toContain('--help')
    expect(HELP_TEXT).toContain('--version')
    expect(HELP_TEXT).toContain('--verify-on-stop')
    expect(HELP_TEXT).toContain('Repository contents are not sent to the ad feed')
    expect(HELP_TEXT).toContain('BYOK sessions do not contact the ad feed')
    expect(HELP_TEXT).toContain('An empty ad feed URL never opens a socket')
  })

  test('formatVersion is a single line', () => {
    expect(formatVersion()).toBe(`raven ${CLI_VERSION}`)
    expect(formatVersion()).not.toContain('\n')
  })

  test('durable help and architecture name ordinary bash', () => {
    expect(HELP_TEXT).toContain(
      'durable       Resume a sqlite session file; forces --dont-ask and runs ordinary Bash',
    )
    const root = join(import.meta.dir, '../../..')
    const english = readFileSync(join(root, 'ARCHITECTURE.md'), 'utf8')
    const korean = readFileSync(join(root, 'ARCHITECTURE.ko.md'), 'utf8')
    expect(english).toContain("this host's `dontAsk` runs ordinary leftover Bash")
    expect(korean).toContain('이 호스트의 `dontAsk`는 일반 leftover Bash를 실행한다')
    expect(english).toContain('No `bypass` / yolo / auto-allow-all-Bash')
    expect(english).toContain('deny unless allow rule or `isReadOnlyBashCommand`')
    expect(korean).toContain('헤드리스에서 Bash를 돌리려면 `.ravenclaw/permissions.json`에 allow rule을 심는다')
  })
})
