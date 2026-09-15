import { INCLUDED_PRIVACY } from '@ravenclaw/ads'
import { readPackageVersion } from '@ravenclaw/core'

export const CLI_VERSION = readPackageVersion(import.meta.url)

export const HELP_TEXT = `RavenClaw ${CLI_VERSION} — local coding agent (BYOK)

${INCLUDED_PRIVACY}

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
  raven skills [new|rm <name>|prune] [--project]
  raven cron [list|add|rm|on|off|tick|watch]
  raven serve [--listen host:port]
  raven slack
  raven discord
  raven pairing [list|approve <code>|revoke discord <userId>]
  raven --help
  raven --version

Commands:
  (default)     Interactive TUI (Ink)
  exec          One-shot prompt; forces --dont-ask
  acp           Agent Client Protocol on stdin/stdout (editor ask; --dont-ask optional)
  setup         Write ~/.ravenclaw/.env (provider + API key)
  smoke         One live text-only turn; expects the model to say pong
  sessions      List recent sessions for this directory (no API key)
  show <id>     Print a session transcript (prefix ok; no API key)
  rm <id>       Delete a session and its child agents (prefix ok; no API key)
  resume [id]   List sessions, or open one in the TUI (id needs a key)
  search <q>    Search session text (this directory; --all for every session)
  export <id>   Print a session as Markdown (full tool bodies; no API key)
  title <id>    Set a session title (no API key)
  doctor        Check home, .env, config.yaml, Bun, and local LLM reachability
  config        Print resolved settings with secrets redacted
  init          Write AGENTS.md in this directory if missing
  completions   Print bash or zsh completion script to stdout
  mcp           List configured MCP servers (list) or spawn and list tool names (tools)
  skills        List skills; new writes SKILL.md, rm deletes, prune archives unused
  cron          List/add/remove local jobs; tick/watch fire due ones
  serve         Local HTTP turn, session stream/resolve, HMAC webhook (loopback)
  slack         Slack Socket Mode bot (allowlist; no public URL)
  discord       Discord Gateway bot (allowlist + DM pairing)
  pairing       Approve or revoke Discord DM pairing (no API key)

Options:
  --provider <anthropic|openai_compat|ollama|vllm>
  --model <id>
  --tui <ink|opentui>
  --dont-ask
  --json                 exec only: write StreamEvents as JSONL
  --fallback-model <id>  retry a failed stream on this model
  --allowed-tools <a,b>  restrict the tool pool to these names
  --tools-preset <name>  read|write|ci; fills --allowed-tools if unset
  --worktree [name]      start the session in a git worktree
  --json-schema <json>   require StructuredOutput matching this schema
  --agent <id>           start with this catalog/disk agent
  --add-dir <path>       extra permission root (repeatable)
  --cwd <dir>            working directory
  --effort <level>       thinking effort hint
  --bare                 skip extra hooks/memory discovery
  --verify-on-stop       headless/cron opt-in; TUI already default on
  -h, --help
  -V, --version

Config: ~/.ravenclaw/config.yaml and ~/.ravenclaw/.env
Docs:   https://github.com/YeonwooSung/RavenClaw
`

export function formatVersion(): string {
  return `raven ${CLI_VERSION}`
}
