import type { ConfigFlags, ProviderKind } from '@ravenclaw/core'
import {
  headlessAllowedTools,
  parseHeadlessToolsPreset,
  type HeadlessToolsPreset,
} from './headless-permissions'

const PROVIDERS = new Set<ProviderKind>(['anthropic', 'openai_compat', 'ollama', 'vllm'])

export type TuiKind = 'ink' | 'opentui'

export interface ParsedArgv {
  cmd:
    | 'interactive'
    | 'exec'
    | 'acp'
    | 'help'
    | 'version'
    | 'setup'
    | 'smoke'
    | 'sessions'
    | 'show'
    | 'rm'
    | 'resume'
    | 'search'
    | 'export'
    | 'title'
    | 'doctor'
    | 'config'
    | 'init'
    | 'completions'
    | 'mcp'
    | 'skills'
    | 'cron'
    | 'serve'
    | 'slack'
    | 'discord'
    | 'pairing'
    | 'eval'
  prompt?: string
  json?: boolean
  all?: boolean
  project?: boolean
  flags: ConfigFlags
  tui?: TuiKind
}

export function parseArgv(argv: string[]): ParsedArgv {
  let cmd: ParsedArgv['cmd'] = 'interactive'
  let json = false
  let all = false
  let project = false
  let tui: TuiKind | undefined
  let toolsPreset: HeadlessToolsPreset | undefined
  const flags: ConfigFlags = {}
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue

    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      cmd = 'help'
      continue
    }
    if (arg === '--version' || arg === '-V') {
      cmd = 'version'
      continue
    }
    if (arg === '--dont-ask') {
      flags.dontAsk = true
      continue
    }
    if (arg === '--all') {
      all = true
      continue
    }
    if (arg === '--project') {
      project = true
      continue
    }
    if (arg === '--bare') {
      flags.bare = true
      continue
    }
    if (arg === '--verify-on-stop') {
      flags.verifyOnStop = true
      continue
    }

    const eq = splitEq(arg)
    if (eq) {
      if (eq.key === 'tui') {
        tui = parseTui(eq.value)
        continue
      }
      if (eq.key === 'tools-preset') {
        toolsPreset = parseHeadlessToolsPreset(eq.value)
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
    if (arg === '--worktree' || arg === '-w') {
      const value = argv[i + 1]
      if (value !== undefined && !value.startsWith('-')) {
        flags.worktree = value
        i++
      } else {
        flags.worktree = true
      }
      continue
    }
    if (arg === '--tools-preset') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error('--tools-preset requires a value')
      }
      toolsPreset = parseHeadlessToolsPreset(value)
      i++
      continue
    }
    if (
      arg === '--allowed-tools' ||
      arg === '--fallback-model' ||
      arg === '--json-schema' ||
      arg === '--agent' ||
      arg === '--add-dir' ||
      arg === '--cwd' ||
      arg === '--effort' ||
      arg === '--listen'
    ) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${arg} requires a value`)
      }
      applyFlag(flags, arg.slice(2), value)
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
    if (
      (arg === 'exec' ||
        arg === 'acp' ||
        arg === 'help' ||
        arg === 'version' ||
        arg === 'setup' ||
        arg === 'smoke' ||
        arg === 'sessions' ||
        arg === 'show' ||
        arg === 'rm' ||
        arg === 'resume' ||
        arg === 'search' ||
        arg === 'export' ||
        arg === 'title' ||
        arg === 'doctor' ||
        arg === 'config' ||
        arg === 'init' ||
        arg === 'completions' ||
        arg === 'mcp' ||
        arg === 'skills' ||
        arg === 'cron' ||
        arg === 'serve' ||
        arg === 'slack' ||
        arg === 'discord' ||
        arg === 'pairing' ||
        arg === 'eval') &&
      cmd === 'interactive' &&
      positional.length === 0
    ) {
      cmd = arg
      continue
    }
    positional.push(arg)
  }

  if (cmd === 'exec' || cmd === 'smoke' || cmd === 'serve') flags.dontAsk = true
  if (flags.allowedTools === undefined && toolsPreset !== undefined) {
    flags.allowedTools = headlessAllowedTools(toolsPreset)
  }

  const out: ParsedArgv = { cmd, flags }
  if (json) out.json = true
  if (all) out.all = true
  if (project) out.project = true
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
      throw new Error(
        `unknown provider: ${value} (expected anthropic, openai_compat, ollama, or vllm)`,
      )
    }
    flags.provider = value as ProviderKind
    return
  }
  if (key === 'model') {
    if (value === '') throw new Error('--model requires a value')
    flags.model = value
    return
  }
  if (key === 'fallback-model') {
    if (value === '') throw new Error('--fallback-model requires a value')
    flags.fallbackModel = value
    return
  }
  if (key === 'allowed-tools') {
    flags.allowedTools = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    return
  }
  if (key === 'worktree') {
    flags.worktree = value === '' ? true : value
    return
  }
  if (key === 'json-schema') {
    flags.jsonSchema = value
    return
  }
  if (key === 'agent') {
    flags.agent = value
    return
  }
  if (key === 'add-dir') {
    flags.addDir = [...(flags.addDir ?? []), value]
    return
  }
  if (key === 'cwd') {
    flags.cwd = value
    return
  }
  if (key === 'effort') {
    flags.effort = value
    return
  }
  if (key === 'listen') {
    flags.listen = value
    return
  }
  throw new Error(`unknown flag: --${key}`)
}
