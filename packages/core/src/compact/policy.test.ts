import { describe, expect, test } from 'bun:test'
import type { CompactPolicy, ModelProfile } from '../types'
import {
  compactThreshold,
  defaultCompactPolicy,
  hardLimit,
  shouldAutocompact,
} from './policy'

function model(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'test',
    contextWindow: 200_000,
    reserveOutputTokens: 20_000,
    inputUsdPerMTok: 0,
    outputUsdPerMTok: 0,
    cacheReadUsdPerMTok: 0,
    cacheWriteUsdPerMTok: 0,
    supportsThinking: false,
    ...over,
  }
}

function compact(over: Partial<CompactPolicy> = {}): CompactPolicy {
  return { ...defaultCompactPolicy(), ...over }
}

describe('defaultCompactPolicy', () => {
  test('buffers and restore caps match the spec defaults', () => {
    expect(defaultCompactPolicy()).toEqual({
      enabled: true,
      autoCompactBuffer: 13_000,
      blockingBufferWhenManual: 3_000,
      protectLastMessages: 20,
      keepRecentFiles: 5,
      maxCharsPerRestoredFile: 5_000,
      maxCharsRestoredFilesTotal: 50_000,
      maxCharsPerRestoredSkill: 5_000,
      maxCharsRestoredSkillsTotal: 25_000,
      maxConsecutiveFailures: 3,
      llmSummarize: false,
      cacheExpiryMs: 3_600_000,
      cacheExpiryMinTokens: 2000,
    })
  })
})

describe('compactThreshold / hardLimit', () => {
  test('200k window, 20k reserve, 13k buffer → threshold 167_000', () => {
    expect(compactThreshold(model(), compact())).toBe(167_000)
  })

  test('hard limit is window minus blockingBufferWhenManual', () => {
    expect(hardLimit(model(), compact())).toBe(197_000)
  })
})

describe('shouldAutocompact', () => {
  test('unanchored estimate does not autocompact', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        estimatedTokens: 180_000,
        model: model(),
        compact: compact(),
        consecutiveFailures: 0,
      }),
    ).toBe('skip')
  })

  test('anchored over threshold → compact', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        anchoredTokens: 167_000,
        estimatedTokens: 10,
        model: model(),
        compact: compact(),
        consecutiveFailures: 0,
      }),
    ).toBe('compact')
  })

  test('compact off + over hard limit → context_full', () => {
    expect(
      shouldAutocompact({
        enabled: false,
        estimatedTokens: 197_000,
        model: model(),
        compact: compact({ enabled: false }),
        consecutiveFailures: 0,
      }),
    ).toBe('context_full')
  })

  test('compact off + under hard limit → skip', () => {
    expect(
      shouldAutocompact({
        enabled: false,
        estimatedTokens: 196_999,
        model: model(),
        compact: compact({ enabled: false }),
        consecutiveFailures: 0,
      }),
    ).toBe('skip')
  })

  test('unanchored first request over hard limit → context_full', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        estimatedTokens: 197_000,
        model: model(),
        compact: compact(),
        consecutiveFailures: 0,
      }),
    ).toBe('context_full')
  })

  test('forceReactive compact even without an anchored sample', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        estimatedTokens: 10,
        model: model(),
        compact: compact(),
        consecutiveFailures: 0,
        forceReactive: true,
      }),
    ).toBe('compact')
  })

  test('circuit-breaker: 3 failures then skip', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        anchoredTokens: 180_000,
        estimatedTokens: 180_000,
        model: model(),
        compact: compact(),
        consecutiveFailures: 3,
      }),
    ).toBe('skip')
  })

  test('circuit-breaker over hard limit → context_full', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        anchoredTokens: 198_000,
        estimatedTokens: 198_000,
        model: model(),
        compact: compact(),
        consecutiveFailures: 3,
      }),
    ).toBe('context_full')
  })

  test('cache expiry + enough tokens → compact', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        estimatedTokens: 2000,
        model: model(),
        compact: compact(),
        consecutiveFailures: 0,
        lastRequestAt: 0,
        now: 3_600_000,
      }),
    ).toBe('compact')
  })

  test('cache expiry just under the idle window → skip', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        estimatedTokens: 2000,
        model: model(),
        compact: compact(),
        consecutiveFailures: 0,
        lastRequestAt: 0,
        now: 3_599_999,
      }),
    ).toBe('skip')
  })

  test('cache expiry under cacheExpiryMinTokens → skip', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        estimatedTokens: 1999,
        model: model(),
        compact: compact(),
        consecutiveFailures: 0,
        lastRequestAt: 0,
        now: 3_600_000,
      }),
    ).toBe('skip')
  })

  test('cache expiry without lastRequestAt does not compact', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        estimatedTokens: 2000,
        model: model(),
        compact: compact(),
        consecutiveFailures: 0,
        now: 3_600_000,
      }),
    ).toBe('skip')
  })

  test('cache expiry off when cacheExpiryMs is unset', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        estimatedTokens: 2000,
        model: model(),
        compact: compact({ cacheExpiryMs: undefined }),
        consecutiveFailures: 0,
        lastRequestAt: 0,
        now: 3_600_000,
      }),
    ).toBe('skip')
  })

  test('cache expiry does not override circuit-breaker', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        estimatedTokens: 2000,
        model: model(),
        compact: compact(),
        consecutiveFailures: 3,
        lastRequestAt: 0,
        now: 3_600_000,
      }),
    ).toBe('skip')
  })

  test('fresh cache still autocompacts when anchored over threshold', () => {
    expect(
      shouldAutocompact({
        enabled: true,
        anchoredTokens: 167_000,
        estimatedTokens: 10,
        model: model(),
        compact: compact(),
        consecutiveFailures: 0,
        lastRequestAt: 3_600_000,
        now: 3_600_000,
      }),
    ).toBe('compact')
  })
})
