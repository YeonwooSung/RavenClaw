import { readPackageVersion } from '@ravenclaw/core'

export const CLI_VERSION = readPackageVersion(import.meta.url)

export const HELP_TEXT = `RavenClaw ${CLI_VERSION} — local coding agent (BYOK)

Usage:
  raven [options]
  raven exec [--json] [options] <prompt>
  raven acp [options]
  raven setup
  raven smoke
  raven --help
  raven --version

Commands:
  (default)     Interactive TUI (Ink)
  exec          One-shot prompt; forces --dont-ask
  acp           Agent Client Protocol on stdin/stdout; forces --dont-ask
  setup         Write ~/.ravenclaw/.env (provider + API key)
  smoke         One live turn (requires a key); expects the model to say pong

Options:
  --provider <anthropic|openai_compat>
  --model <id>
  --tui <ink|opentui>
  --dont-ask
  --json                 exec only: write StreamEvents as JSONL
  -h, --help
  -V, --version

Config: ~/.ravenclaw/config.yaml and ~/.ravenclaw/.env
Docs:   https://github.com/YeonwooSung/RavenClaw
`

export function formatVersion(): string {
  return `raven ${CLI_VERSION}`
}
