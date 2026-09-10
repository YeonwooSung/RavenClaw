import { describe, expect, test } from 'bun:test'
import { formatStatusLine } from './status-line'

describe('formatStatusLine', () => {
  test('shows model, mode, tokens, and a short session id', () => {
    const line = formatStatusLine({
      model: 'anthropic/claude-sonnet-4',
      mode: 'default',
      usage: { input: 12_400, output: 1_100, cacheRead: 200, cacheWrite: 50 },
      sessionId: 'abcdef12-9999-0000',
    })
    expect(line).toContain('claude-sonnet-4')
    expect(line).toContain('default')
    expect(line).toContain('12.4k↑')
    expect(line).toContain('1.1k↓')
    expect(line).toContain('250c')
    expect(line).toContain('sess abcdef12')
    expect(line).not.toMatch(/\$/)
    expect(line.toLowerCase()).not.toContain('usd')
  })

  test('keeps small token counts as integers', () => {
    const line = formatStatusLine({
      model: 'dummy',
      mode: 'plan',
      usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0 },
      sessionId: 's1',
    })
    expect(line).toContain('12↑')
    expect(line).toContain('4↓')
    expect(line).toContain('0c')
    expect(line).toContain('sess s1')
    expect(line).toContain('plan')
  })
})
