import { Text } from 'ink'
import { formatCostLine } from '@ravenclaw/core'
import type { Funding, ModelProfile, TokenUsage } from '@ravenclaw/core'

export function formatCount(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const rounded = Math.round((n / 1000) * 10) / 10
  return Number.isInteger(rounded) ? `${rounded}k` : `${rounded.toFixed(1)}k`
}

export function shortModelName(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

export function shortSessionId(sessionId: string): string {
  const dash = sessionId.indexOf('-')
  if (dash > 0) return sessionId.slice(0, dash)
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId
}

export function formatStatusLine(opts: {
  model: string
  mode: string
  usage: TokenUsage
  sessionId: string
  usd?: string
  funding?: Funding
  profile?: ModelProfile
  compactSoon?: boolean
}): string {
  const cache = opts.usage.cacheRead + opts.usage.cacheWrite
  const parts = [
    shortModelName(opts.model),
    opts.mode,
    `${formatCount(opts.usage.input)}↑`,
    `${formatCount(opts.usage.output)}↓`,
    `${formatCount(cache)}c`,
  ]
  const usd = resolveUsd(opts)
  if (usd !== undefined) parts.push(usd)
  parts.push(`sess ${shortSessionId(opts.sessionId)}`)
  if (opts.compactSoon) parts.push('compact soon')
  return parts.join('  ')
}

function resolveUsd(opts: {
  usage: TokenUsage
  usd?: string
  funding?: Funding
  profile?: ModelProfile
}): string | undefined {
  if (opts.usd !== undefined) return opts.usd
  if (opts.profile !== undefined && opts.funding !== undefined) {
    return formatCostLine({
      usage: opts.usage,
      profile: opts.profile,
      funding: opts.funding,
    })
  }
  return undefined
}

export function StatusLine(props: {
  model: string
  mode: string
  usage: TokenUsage
  sessionId: string
  usd?: string
  funding?: Funding
  profile?: ModelProfile
  compactSoon?: boolean
}) {
  return <Text dimColor>{formatStatusLine(props)}</Text>
}
