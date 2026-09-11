import { CostTracker } from '@ravenclaw/core'
import type { Funding, ModelProfile, TokenUsage } from '@ravenclaw/core'

export function formatIncludedCap(remaining?: number): string | undefined {
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return undefined
  return `included ${remaining} left`
}

export function formatCostNotice(opts: {
  usage: TokenUsage
  profile: ModelProfile
  funding: Funding
  remaining?: number
  compactGeneration?: number
}): string {
  const base = new CostTracker(opts.profile, opts.funding, opts.usage).display()
  let line = base
  if (opts.funding === 'included') {
    const cap = formatIncludedCap(opts.remaining)
    if (cap !== undefined) {
      line = base.endsWith('included')
        ? `${base.slice(0, -'included'.length)}${cap}`
        : `${base} ${cap}`
    }
  }
  if (opts.compactGeneration === undefined) return line
  return `${line}  compact ${opts.compactGeneration}`
}
