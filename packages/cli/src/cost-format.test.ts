import { describe, expect, test } from 'bun:test'
import type { ModelProfile, TokenUsage } from '@ravenclaw/core'
import { formatCostNotice, formatIncludedCap } from './cost-format'

function profile(): ModelProfile {
  return {
    id: 'dummy',
    contextWindow: 32_000,
    reserveOutputTokens: 100,
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
  }
}

const usage: TokenUsage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }

describe('formatIncludedCap', () => {
  test('rejects non-finite remaining', () => {
    expect(formatIncludedCap()).toBeUndefined()
    expect(formatIncludedCap(Number.NaN)).toBeUndefined()
    expect(formatIncludedCap(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(formatIncludedCap(3)).toBe('included 3 left')
    expect(formatIncludedCap(0)).toBe('included 0 left')
  })
})

describe('formatCostNotice', () => {
  test('byok uses the tracker display and optional compact generation', () => {
    const line = formatCostNotice({ usage, profile: profile(), funding: 'byok' })
    expect(line.length).toBeGreaterThan(0)
    expect(formatCostNotice({ usage, profile: profile(), funding: 'byok', compactGeneration: 2 })).toBe(
      `${line}  compact 2`,
    )
  })

  test('included remaining replaces a trailing included label', () => {
    const line = formatCostNotice({
      usage,
      profile: profile(),
      funding: 'included',
      remaining: 4,
    })
    expect(line).toContain('included 4 left')
    expect(line.endsWith('included')).toBe(false)
  })
})
