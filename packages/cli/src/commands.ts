export const SLASH_HELP = `/resume [id]   list or restore a session
/compact       compact the conversation
/cost          token and USD estimate
/search <q>    search this session (or /search --all q)
/mode <mode>   default | acceptEdits | plan | dontAsk
/learn         write a skill from this session
/cancel        abort the current turn (OpenTUI)
/help          this list
/quit          exit`

export const LEARN_PROMPT =
  'Write a new skill that captures the reusable procedure we just figured out. Create a SKILL.md with a name, a short description, and a step-by-step body under this project\'s .ravenclaw/skills directory or the user skills directory. Do not add a new built-in tool — just write the skill files.'

export type SlashResult =
  | { type: 'command'; name: string; arg?: string }
  | { type: 'prompt'; text: string }

export function handleSlashCommand(line: string): SlashResult {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return { type: 'prompt', text: trimmed }

  const match = /^\/(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed)
  if (!match || !match[1]) return { type: 'prompt', text: trimmed }

  const result: SlashResult = { type: 'command', name: match[1].toLowerCase() }
  if (match[2] !== undefined && match[2] !== '') result.arg = match[2]
  return result
}
