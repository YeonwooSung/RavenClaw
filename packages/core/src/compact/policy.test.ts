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
})
