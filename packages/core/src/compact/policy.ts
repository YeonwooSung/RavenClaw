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
  }
}

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
}): 'skip' | 'compact' | 'context_full' {
  const limit = hardLimit(opts.model, opts.compact)
  const broken =
    !opts.enabled || opts.consecutiveFailures >= opts.compact.maxConsecutiveFailures

  if (broken) {
    return opts.estimatedTokens >= limit ? 'context_full' : 'skip'
  }

  if (opts.forceReactive) return 'compact'

  if (opts.anchoredTokens === undefined) {
    return opts.estimatedTokens >= limit ? 'context_full' : 'skip'
  }

  if (opts.anchoredTokens >= compactThreshold(opts.model, opts.compact)) {
    return 'compact'
  }
  return 'skip'
}
