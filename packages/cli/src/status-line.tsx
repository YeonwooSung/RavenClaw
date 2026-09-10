import { Text } from 'ink'
import type { TokenUsage } from '@ravenclaw/core'

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
}): string {
  const cache = opts.usage.cacheRead + opts.usage.cacheWrite
  return [
    shortModelName(opts.model),
    opts.mode,
    `${formatCount(opts.usage.input)}↑`,
    `${formatCount(opts.usage.output)}↓`,
    `${formatCount(cache)}c`,
    `sess ${shortSessionId(opts.sessionId)}`,
  ].join('  ')
}

export function StatusLine(props: {
  model: string
  mode: string
  usage: TokenUsage
  sessionId: string
}) {
  return <Text dimColor>{formatStatusLine(props)}</Text>
}
