import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from '../home'
import { parseAllowedTools, parseFrontmatterFields, parseSkillFrontmatter } from '../tools/skill'
import type { AgentDefinition } from '../types'

const DEFAULT_TOOLS = ['Read', 'Grep', 'Glob']

export function loadDiskAgents(cwd: string, home = ravenclawHome()): AgentDefinition[] {
  const byId = new Map<string, AgentDefinition>()
  loadDir(join(home, 'agents'), byId)
  loadDir(join(cwd, '.ravenclaw', 'agents'), byId)
  return [...byId.values()]
}

function loadDir(dir: string, byId: Map<string, AgentDefinition>): void {
  if (!existsSync(dir)) return
  try {
    if (!statSync(dir).isDirectory()) return
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue
      const parsed = parseAgentFile(join(dir, name))
      if (parsed) byId.set(parsed.id, parsed)
    }
  } catch {
    // unreadable agents dir
  }
}

function parseAgentFile(path: string): AgentDefinition | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const fm = parseSkillFrontmatter(raw)
  const id = fm.name?.trim()
  if (!id) return undefined
  const extra = parseFrontmatterFields(raw)
  const model = typeof extra.model === 'string' && extra.model.trim() !== '' ? extra.model.trim() : undefined
  const rounds =
    typeof extra.maxRounds === 'string' && /^[0-9]+$/.test(extra.maxRounds.trim())
      ? Number(extra.maxRounds.trim())
      : 0
  const maxRounds = Number.isSafeInteger(rounds) && rounds > 0 ? rounds : 12
  const body = raw.replace(/^---[\s\S]*?---\s*/, '').trim()
  const tools = fm.allowedTools && fm.allowedTools.length > 0 ? fm.allowedTools : DEFAULT_TOOLS
  const edges = parseAllowedTools(extra['spawnable-agents']) ?? []
  // Edges imply the Agent tool; depth and edge checks live in the Agent tool.
  const toolNames = edges.length > 0 && !tools.includes('Agent') ? [...tools, 'Agent'] : tools
  return {
    id,
    displayName: id,
    toolNames,
    spawnableAgents: edges,
    inheritParentSystemPrompt: false,
    includeMessageHistory: false,
    maxRounds,
    outputMode: 'last_message',
    ...(model !== undefined ? { model } : {}),
    ...(body.length > 0 ? { systemPrompt: body } : {}),
  }
}
