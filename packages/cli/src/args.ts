import type { ConfigFlags, ProviderKind } from '@ravenclaw/core'

const PROVIDERS = new Set<ProviderKind>(['anthropic', 'openai_compat'])

export type TuiKind = 'ink' | 'opentui'

export interface ParsedArgv {
  cmd: 'interactive' | 'exec'
  prompt?: string
  json?: boolean
  flags: ConfigFlags
  tui?: TuiKind
}

export function parseArgv(argv: string[]): ParsedArgv {
  let cmd: ParsedArgv['cmd'] = 'interactive'
  let json = false
  let tui: TuiKind | undefined
  const flags: ConfigFlags = {}
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue

    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--dont-ask') {
      flags.dontAsk = true
      continue
    }

    const eq = splitEq(arg)
    if (eq) {
      if (eq.key === 'tui') {
        tui = parseTui(eq.value)
        continue
      }
      applyFlag(flags, eq.key, eq.value)
      continue
    }
    if (arg === '--tui') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--tui requires a value')
      }
      tui = parseTui(value)
      i++
      continue
    }
    if (arg === '--provider' || arg === '--model') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${arg} requires a value`)
      }
      applyFlag(flags, arg.slice(2), value)
      i++
      continue
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown flag: ${arg}`)
    }
    if (arg === 'exec' && cmd === 'interactive' && positional.length === 0) {
      cmd = 'exec'
      continue
    }
    positional.push(arg)
  }

  if (cmd === 'exec') flags.dontAsk = true

  const out: ParsedArgv = { cmd, flags }
  if (json) out.json = true
  if (tui !== undefined) out.tui = tui
  if (positional.length > 0) out.prompt = positional.join(' ')
  return out
}

function parseTui(value: string): TuiKind {
  if (value === 'ink' || value === 'opentui') return value
  throw new Error(`unknown tui: ${value} (expected ink or opentui)`)
}

function splitEq(arg: string): { key: string; value: string } | undefined {
  if (!arg.startsWith('--')) return undefined
  const idx = arg.indexOf('=')
  if (idx <= 2) return undefined
  return { key: arg.slice(2, idx), value: arg.slice(idx + 1) }
}

function applyFlag(flags: ConfigFlags, key: string, value: string): void {
  if (key === 'provider') {
    if (!PROVIDERS.has(value as ProviderKind)) {
      throw new Error(`unknown provider: ${value} (expected anthropic or openai_compat)`)
    }
    flags.provider = value as ProviderKind
    return
  }
  if (key === 'model') {
    if (value === '') throw new Error('--model requires a value')
    flags.model = value
    return
  }
  throw new Error(`unknown flag: --${key}`)
}
