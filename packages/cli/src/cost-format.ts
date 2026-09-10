import { CostTracker } from '@ravenclaw/core'
import type { Funding, ModelProfile, TokenUsage } from '@ravenclaw/core'

export function formatCostNotice(opts: {
  usage: TokenUsage
  profile: ModelProfile
  funding: Funding
}): string {
  return new CostTracker(opts.profile, opts.funding, opts.usage).display()
}
