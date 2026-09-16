import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { OnboardingScan } from '@ravenclaw/core'

export interface SlashCommandSpec {
  name: string
  aliases?: readonly string[]
  usage: string
  summary: string
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    name: 'resume',
    usage: '/resume [id]',
    summary: 'restore a session; next message is a new turn (tools are not re-run)',
  },
  { name: 'compact', usage: '/compact', summary: 'compact the conversation' },
  { name: 'cost', usage: '/cost', summary: 'token and USD estimate' },
  { name: 'search', usage: '/search <q>', summary: 'search this session (or /search --all q)' },
  { name: 'mode', usage: '/mode <mode>', summary: 'default | acceptEdits | plan | dontAsk' },
  { name: 'learn', usage: '/learn', summary: 'write a skill from this session' },
  { name: 'review', usage: '/review', summary: 'append a read-only review to .ravenclaw/MEMORY.md' },
  { name: 'title', usage: '/title <name>', summary: "set this session's title" },
  { name: 'stop', aliases: ['cancel'], usage: '/stop', summary: 'abort the current turn (alias /cancel)' },
  { name: 'clear', aliases: ['new'], usage: '/clear', summary: 'start a new session (alias /new)' },
  {
    name: 'model',
    usage: '/model [id]',
    summary: "show or set this session's model for the next turn (reloads profile)",
  },
  { name: 'permissions', usage: '/permissions', summary: 'list extra permission rule files' },
  { name: 'tasks', usage: '/tasks [kill <id>|steer <id> <text>]', summary: 'list, stop, or steer background tasks' },
  { name: 'undo', usage: '/undo', summary: 'restore files from the last edit checkpoint' },
  { name: 'rewind', usage: '/rewind', summary: 'undo last turn files and drop that conversation turn' },
  { name: 'diff', usage: '/diff [n|close]', summary: 'open working-tree git diff panel' },
  { name: 'job', usage: '/job [name]', summary: 'enter a named raven/* job worktree' },
  { name: 'steer', usage: '/steer <text>', summary: 'inject text into the live turn (next tool round)' },
  {
    name: 'add-dir',
    usage: '/add-dir <path>',
    summary: 'print how to add an extra root (AddDir tool or --add-dir; this slash does not add one)',
  },
  {
    name: 'effort',
    usage: '/effort [low|medium|high|max]',
    summary: 'print a thinking-effort hint (does not persist; use --effort)',
  },
  { name: 'agents', usage: '/agents', summary: 'list built-in and disk agents' },
  { name: 'hooks', usage: '/hooks', summary: 'list lifecycle hook events from hooks.json' },
  { name: 'reload', usage: '/reload', summary: 'reload skills on the next turn' },
  { name: 'mcp', usage: '/mcp', summary: 'show configured MCP servers' },
  { name: 'skills', usage: '/skills [show|disable|enable <name>|prune]', summary: 'list, show, disable, or prune skills' },
  { name: 'loop', usage: '/loop [stop|<n> <prompt>]', summary: 'repeat a prompt n times (max 20)' },
  { name: 'cron', usage: '/cron [add|rm|on|off]', summary: 'list or edit local scheduled jobs' },
  { name: 'queue', usage: '/queue [drop n|clear]', summary: 'list or edit queued prompts (mid-turn or next turn)' },
  { name: 'copy', usage: '/copy', summary: 'copy this conversation as markdown' },
  { name: 'interview', usage: '/interview', summary: 'ask clarifying questions before implementing' },
  {
    name: 'team-onboarding',
    aliases: ['onboard'],
    usage: '/team-onboarding',
    summary: 'walk a new teammate through this workspace',
  },
  { name: 'bash', usage: '/bash <cmd>', summary: 'run a local shell command (also !cmd)' },
  { name: 'skill', usage: '/skill:<name>', summary: 'invoke a skill by name' },
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

export const LEARN_PROMPT = [
  'Write a new skill that captures the reusable procedure we just figured out.',
  'Create SKILL.md under .ravenclaw/skills/<name>/ (this project) or ~/.ravenclaw/skills/<name>/ (user).',
  'Front matter must include a name and a description of at most 60 characters (the skill index clips at 60).',
  'The body is steps plus pointers. Put long scripts and templates in references/ next to SKILL.md.',
  'Do not retype a script that already exists in the repo; link it.',
  'Do not add a core tool — just write the skill files.',
].join(' ')

export const INTERVIEW_PROMPT =
  'Interview me before writing code. Use AskUser for multiple-choice questions (at least two options each). Ask only what you need to pin down the spec, then summarize the spec and wait.'

export const ONBOARDING_PROMPT = [
  'Walk this human through onboarding for this RavenClaw workspace.',
  'Use only the JSON facts in the following scan. Do not invent rules, skills, MCP servers, or git remotes.',
  'Structure the reply as: (1) usage context using the scan.usage.label, (2) setup checklist with done/missing from the scan, (3) team information quoted only from projectFiles — if those files were not read, say so and do not fabricate tips.',
  'Greet using scan.teamName.',
  'If askUserHost is true, use AskUser for at most one missing item at a time. If they decline, skip it.',
  'If askUserHost is false, print the guide and stop. Do not run install commands in dontAsk/headless.',
  'Do not write ONBOARDING.md unless the human explicitly asks.',
].join(' ')

export function formatOnboardingTurn(scan: OnboardingScan): string {
  return `${ONBOARDING_PROMPT}\n\nscan:\n\`\`\`json\n${JSON.stringify(scan)}\n\`\`\``
}

export const TASKS_NOTICE = 'no background tasks'
export const UNDO_NOTHING_NOTICE = 'nothing to undo'
export const RELOAD_NOTICE = 'skills reloaded'
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
  if (raw.startsWith('skill:')) {
    const skillName = raw.slice('skill:'.length)
    const rest = match[2] !== undefined && match[2] !== '' ? ` ${match[2]}` : ''
    const result: SlashResult = { type: 'command', name: 'skill' }
    if (skillName !== '' || rest !== '') result.arg = `${skillName}${rest}`.trim()
    return result
  }
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
