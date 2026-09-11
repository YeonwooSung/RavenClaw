import { readPackageVersion } from '@ravenclaw/core'

export const CLI_VERSION = readPackageVersion(import.meta.url)

export const HELP_TEXT = `RavenClaw ${CLI_VERSION} — local coding agent (BYOK)

Usage:
  raven [options]
  raven exec [--json] [options] <prompt>
  raven acp [options]
  raven setup
  raven smoke
  raven sessions
  raven show <id>
  raven rm <id>
  raven resume [id]
  raven search [--all] <query>
  raven export <id>
  raven title <id> <name>
  raven doctor
  raven config
  raven init
  raven completions bash|zsh
  raven mcp [list|tools]
  raven skills [new <name>] [--project]
  raven --help
  raven --version

Commands:
  (default)     Interactive TUI (Ink)
  exec          One-shot prompt; forces --dont-ask
  acp           Agent Client Protocol on stdin/stdout; forces --dont-ask
  setup         Write ~/.ravenclaw/.env (provider + API key)
  smoke         One live turn (requires a key); expects the model to say pong
  sessions      List recent sessions for this directory (no API key)
  show <id>     Print a session transcript (prefix ok; no API key)
  rm <id>       Delete a session and its child agents (prefix ok; no API key)
  resume [id]   List sessions, or open one in the TUI (id needs a key)
  search <q>    Search session text (this directory; --all for every session)
  export <id>   Print a session as Markdown (full tool bodies; no API key)
  title <id>    Set a session title (no API key)
  doctor        Check home, .env, config.yaml, and Bun (no secrets printed)
  config        Print resolved settings with secrets redacted
  init          Write AGENTS.md in this directory if missing
  completions   Print bash or zsh completion script to stdout
  mcp           List configured MCP servers (list) or spawn and list tool names (tools)
  skills        List skills; skills new <name> writes a SKILL.md (--project = cwd)

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
