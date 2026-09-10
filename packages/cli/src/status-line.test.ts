import { describe, expect, test } from 'bun:test'
import { getModelProfile } from '@ravenclaw/core'
import { formatStatusLine } from './status-line'

const sonnet = getModelProfile('anthropic/claude-sonnet-4')
const sampleUsage = { input: 12_400, output: 1_100, cacheRead: 200, cacheWrite: 50 }

describe('formatStatusLine', () => {
  test('shows model, mode, tokens, USD, and a short session id', () => {
    const line = formatStatusLine({
      model: 'anthropic/claude-sonnet-4',
      mode: 'default',
      usage: sampleUsage,
      sessionId: 'abcdef12-9999-0000',
      profile: sonnet,
      funding: 'byok',
    })
    expect(line).toContain('claude-sonnet-4')
    expect(line).toContain('default')
    expect(line).toContain('12.4k↑')
    expect(line).toContain('1.1k↓')
    expect(line).toContain('250c')
    expect(line).toContain('sess abcdef12')
    expect(line).toMatch(/\$0\.\d{2}/)
    expect(line.toLowerCase()).not.toContain('usd')
  })

  test('byok shows estimated dollars', () => {
    const line = formatStatusLine({
      model: 'anthropic/claude-sonnet-4',
      mode: 'default',
      usage: { input: 50_000, output: 4_000, cacheRead: 0, cacheWrite: 0 },
      sessionId: 's1',
      profile: sonnet,
      funding: 'byok',
    })
    expect(line).toContain('$0.21')
    expect(line).not.toContain('included')
  })

  test('included shows $0.00 included', () => {
    const line = formatStatusLine({
      model: 'anthropic/claude-sonnet-4',
      mode: 'default',
      usage: { input: 50_000, output: 4_000, cacheRead: 0, cacheWrite: 0 },
      sessionId: 's1',
      profile: sonnet,
      funding: 'included',
    })
    expect(line).toContain('$0.00 included')
  })

  test('accepts a preformatted usd string', () => {
    const line = formatStatusLine({
      model: 'dummy',
      mode: 'default',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      sessionId: 's1',
      usd: '$1.23',
    })
    expect(line).toContain('$1.23')
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
