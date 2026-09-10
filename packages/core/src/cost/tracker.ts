import type { Funding, ModelProfile, TokenUsage } from '../types'

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function copyUsage(usage: TokenUsage): TokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  }
}

export function estimateUsd(usage: TokenUsage, profile: ModelProfile): number {
  return (
    (usage.input * profile.inputUsdPerMTok +
      usage.output * profile.outputUsdPerMTok +
      usage.cacheRead * profile.cacheReadUsdPerMTok +
      usage.cacheWrite * profile.cacheWriteUsdPerMTok) /
    1e6
  )
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`
}

export function formatCostLine(opts: {
  usage: TokenUsage
  profile: ModelProfile
  funding: Funding
}): string {
  if (opts.funding === 'included') return '$0.00 included'
  return formatUsd(estimateUsd(opts.usage, opts.profile))
}

export class CostTracker {
  readonly #profile: ModelProfile
  readonly #funding: Funding
  #usage: TokenUsage

  constructor(profile: ModelProfile, funding: Funding, initial?: TokenUsage) {
    this.#profile = profile
    this.#funding = funding
    this.#usage = initial ? copyUsage(initial) : copyUsage(ZERO_USAGE)
  }

  add(usage: TokenUsage): void {
    this.#usage = {
      input: this.#usage.input + usage.input,
      output: this.#usage.output + usage.output,
      cacheRead: this.#usage.cacheRead + usage.cacheRead,
      cacheWrite: this.#usage.cacheWrite + usage.cacheWrite,
    }
  }

  get usage(): TokenUsage {
    return copyUsage(this.#usage)
  }

  usd(): number {
    return estimateUsd(this.#usage, this.#profile)
  }

  display(): string {
    return formatCostLine({
      usage: this.#usage,
      profile: this.#profile,
      funding: this.#funding,
    })
  }
}
