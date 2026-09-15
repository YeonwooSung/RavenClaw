import type { CompactPolicy, ModelProfile } from '../types'

export function defaultCompactPolicy(): CompactPolicy {
  return {
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
  }
}

export const COMPACTION_PROMPT_TOKENS = 1024

export function compactThreshold(model: ModelProfile, compact: CompactPolicy): number {
  return model.contextWindow - model.reserveOutputTokens - compact.autoCompactBuffer
}

export function hardLimit(model: ModelProfile, compact: CompactPolicy): number {
  return model.contextWindow - compact.blockingBufferWhenManual
}

export function shouldAutocompact(opts: {
  enabled: boolean
  anchoredTokens?: number
  estimatedTokens: number
  model: ModelProfile
  compact: CompactPolicy
  consecutiveFailures: number
  forceReactive?: boolean
  lastRequestAt?: number
  now?: number
}): 'skip' | 'compact' | 'context_full' {
  const limit = hardLimit(opts.model, opts.compact)
  const broken =
    !opts.enabled || opts.consecutiveFailures >= opts.compact.maxConsecutiveFailures

  if (broken) {
    return opts.estimatedTokens >= limit ? 'context_full' : 'skip'
  }

  if (opts.forceReactive) return 'compact'

  const expiryMs = opts.compact.cacheExpiryMs
  const minTokens = opts.compact.cacheExpiryMinTokens ?? 0
  if (
    expiryMs !== undefined &&
    opts.lastRequestAt !== undefined &&
    (opts.now ?? Date.now()) - opts.lastRequestAt >= expiryMs &&
    opts.estimatedTokens >= minTokens
  ) {
    return 'compact'
  }

  if (opts.anchoredTokens === undefined) {
    return opts.estimatedTokens >= limit ? 'context_full' : 'skip'
  }

  const threshold = compactThreshold(opts.model, opts.compact)
  if (
    opts.estimatedTokens + COMPACTION_PROMPT_TOKENS >= threshold ||
    opts.anchoredTokens + COMPACTION_PROMPT_TOKENS >= threshold
  ) {
    return 'compact'
  }
  return 'skip'
}

const NEAR_COMPACT_TOKENS = 2000
const NEAR_COMPACT_USAGE_RATIO = 0.8

export function nearCompact(opts: {
  estimatedTokens: number
  model: ModelProfile
  compact: CompactPolicy
  usage?: { input: number }
}): boolean {
  if (
    opts.compact.enabled &&
    opts.estimatedTokens >= compactThreshold(opts.model, opts.compact) - NEAR_COMPACT_TOKENS
  ) {
    return true
  }
  if (opts.usage !== undefined) {
    const usable = opts.model.contextWindow - opts.model.reserveOutputTokens
    if (opts.usage.input >= NEAR_COMPACT_USAGE_RATIO * usable) return true
  }
  return false
}
