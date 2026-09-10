import { describe, expect, test } from 'bun:test'
import { getModelProfile } from './models'
import {
  CostTracker,
  estimateUsd,
  formatCostLine,
  formatUsd,
} from './tracker'
import type { ModelProfile, TokenUsage } from '../types'

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over }
}

function profile(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'test',
    contextWindow: 200_000,
    reserveOutputTokens: 20_000,
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    cacheReadUsdPerMTok: 0.3,
    cacheWriteUsdPerMTok: 3.75,
    supportsThinking: false,
    ...over,
  }
}

describe('estimateUsd', () => {
  test('applies per-million rates across all four buckets', () => {
    const usd = estimateUsd(
      usage({ input: 50_000, output: 4_000, cacheRead: 20_000, cacheWrite: 4_000 }),
      profile(),
    )
    expect(usd).toBeCloseTo(0.231, 10)
  })

  test('zero usage is zero dollars', () => {
    expect(estimateUsd(usage(), profile())).toBe(0)
  })

  test('uses ModelProfile price overrides from getModelProfile', () => {
    const overridden = getModelProfile('anthropic/claude-sonnet-4', {
      prices: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
    })
    const usd = estimateUsd(usage({ input: 100_000, output: 50_000, cacheRead: 10_000, cacheWrite: 5_000 }), overridden)
    expect(usd).toBeCloseTo(2.02, 10)
  })
})

describe('formatUsd', () => {
  test('formats two decimal dollars', () => {
    expect(formatUsd(0.21)).toBe('$0.21')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(1.5)).toBe('$1.50')
  })
})

describe('formatCostLine', () => {
  const sample = usage({ input: 50_000, output: 4_000 })

  test('byok shows the estimated USD', () => {
    expect(formatCostLine({ usage: sample, profile: profile(), funding: 'byok' })).toBe('$0.21')
  })

  test('included shows $0.00 included and still accepts token usage', () => {
    expect(
      formatCostLine({ usage: sample, profile: profile(), funding: 'included' }),
    ).toBe('$0.00 included')
    expect(estimateUsd(sample, profile())).toBeCloseTo(0.21, 10)
  })
})

describe('CostTracker', () => {
  test('add accumulates usage and usd', () => {
    const tracker = new CostTracker(profile(), 'byok')
    expect(tracker.usage).toEqual(usage())
    expect(tracker.usd()).toBe(0)
    expect(tracker.display()).toBe('$0.00')

    tracker.add(usage({ input: 25_000, output: 2_000 }))
    tracker.add(usage({ input: 25_000, output: 2_000 }))
    expect(tracker.usage).toEqual(usage({ input: 50_000, output: 4_000 }))
    expect(tracker.usd()).toBeCloseTo(0.21, 10)
    expect(tracker.display()).toBe('$0.21')
  })

  test('included display stays $0.00 included while tokens and usd still count', () => {
    const tracker = new CostTracker(profile(), 'included')
    tracker.add(usage({ input: 50_000, output: 4_000 }))
    expect(tracker.usage.input).toBe(50_000)
    expect(tracker.usd()).toBeCloseTo(0.21, 10)
    expect(tracker.display()).toBe('$0.00 included')
  })

  test('restores session.usage on resume', () => {
    const sessionUsage = usage({ input: 50_000, output: 4_000, cacheRead: 10, cacheWrite: 5 })
    const tracker = new CostTracker(profile(), 'byok', sessionUsage)
    expect(tracker.usage).toEqual(sessionUsage)
    expect(tracker.display()).toBe(formatUsd(estimateUsd(sessionUsage, profile())))
    tracker.add(usage({ input: 1_000 }))
    expect(tracker.usage.input).toBe(51_000)
    expect(tracker.usage).not.toBe(sessionUsage)
  })
})
