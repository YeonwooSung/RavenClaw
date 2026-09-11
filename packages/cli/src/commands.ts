import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface SlashCommandSpec {
  name: string
  aliases?: readonly string[]
  usage: string
  summary: string
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { name: 'resume', usage: '/resume [id]', summary: 'list or restore a session' },
  { name: 'compact', usage: '/compact', summary: 'compact the conversation' },
  { name: 'cost', usage: '/cost', summary: 'token and USD estimate' },
  { name: 'search', usage: '/search <q>', summary: 'search this session (or /search --all q)' },
  { name: 'mode', usage: '/mode <mode>', summary: 'default | acceptEdits | plan | dontAsk' },
  { name: 'learn', usage: '/learn', summary: 'write a skill from this session' },
  { name: 'review', usage: '/review', summary: 'append a read-only review to .ravenclaw/MEMORY.md' },
  { name: 'title', usage: '/title <name>', summary: "set this session's title" },
  { name: 'cancel', usage: '/cancel', summary: 'abort the current turn (OpenTUI)' },
  { name: 'clear', aliases: ['new'], usage: '/clear', summary: 'start a new session (alias /new)' },
  { name: 'model', usage: '/model [id]', summary: "show or set this session's model" },
  { name: 'permissions', usage: '/permissions', summary: 'list extra permission rule files' },
  { name: 'tasks', usage: '/tasks', summary: 'list background tasks' },
  { name: 'reload', usage: '/reload', summary: 'reload skills on the next turn' },
  { name: 'mcp', usage: '/mcp', summary: 'show configured MCP servers' },
  { name: 'skills', usage: '/skills', summary: 'list discovered skills' },
  { name: 'config', usage: '/config', summary: 'show resolved config' },
  { name: 'context', usage: '/context', summary: 'show compact generation and message count' },
  { name: 'help', aliases: ['?'], usage: '/help', summary: 'this list' },
  { name: 'quit', usage: '/quit', summary: 'exit' },
]

const CANONICAL_NAME = new Map<string, string>()
for (const command of SLASH_COMMANDS) {
  CANONICAL_NAME.set(command.name, command.name)
  for (const alias of command.aliases ?? []) {
    CANONICAL_NAME.set(alias, command.name)
  }
}

export const SLASH_HELP = formatSlashHelp(SLASH_COMMANDS)

export const REVIEW_PROMPT =
  'Summarize durable lessons from this session as short bullets. No tools. No secrets.'

export const LEARN_PROMPT =
  'Write a new skill that captures the reusable procedure we just figured out. Create a SKILL.md with a name, a short description, and a step-by-step body under this project\'s .ravenclaw/skills directory or the user skills directory. Do not add a new built-in tool — just write the skill files.'

export const TASKS_NOTICE = 'no background tasks'
export const RELOAD_NOTICE = 'skills reload on next turn'
export const NO_EXTRA_RULES_NOTICE = 'no extra rules'

export type SlashResult =
  | { type: 'command'; name: string; arg?: string }
  | { type: 'prompt'; text: string }

export function handleSlashCommand(line: string): SlashResult {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return { type: 'prompt', text: trimmed }

  const match = /^\/(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed)
  if (!match || !match[1]) return { type: 'prompt', text: trimmed }

  const raw = match[1].toLowerCase()
  const result: SlashResult = { type: 'command', name: CANONICAL_NAME.get(raw) ?? raw }
  if (match[2] !== undefined && match[2] !== '') result.arg = match[2]
  return result
}

export function formatContextNotice(compactGeneration: number, messageCount: number): string {
  return `compact ${compactGeneration}  messages ${messageCount}`
}

export function formatPermissionsNotice(opts: {
  home: string
  cwd: string
  sessionRuleCount: number
}): string {
  const lines: string[] = []
  const userPath = join(opts.home, 'permissions.json')
  const projectPath = join(opts.cwd, '.ravenclaw', 'permissions.json')
  if (existsSync(userPath)) lines.push(userPath)
  if (existsSync(projectPath)) lines.push(projectPath)
  if (opts.sessionRuleCount > 0) lines.push(`session  ${opts.sessionRuleCount} rules`)
  return lines.length === 0 ? NO_EXTRA_RULES_NOTICE : lines.join('\n')
}

function formatSlashHelp(commands: readonly SlashCommandSpec[]): string {
  const width = commands.reduce((max, command) => Math.max(max, command.usage.length), 0)
  return commands.map((command) => `${command.usage.padEnd(width)}  ${command.summary}`).join('\n')
}
