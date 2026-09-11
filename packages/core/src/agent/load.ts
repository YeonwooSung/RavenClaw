import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from '../home'
import { parseSkillFrontmatter } from '../tools/skill'
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
  const body = raw.replace(/^---[\s\S]*?---\s*/, '').trim()
  const tools = fm.allowedTools && fm.allowedTools.length > 0 ? fm.allowedTools : DEFAULT_TOOLS
  return {
    id,
    displayName: id,
    toolNames: tools,
    spawnableAgents: [],
    inheritParentSystemPrompt: false,
    includeMessageHistory: false,
    maxRounds: 12,
    outputMode: 'last_message',
    ...(body.length > 0 ? { systemPrompt: body } : {}),
  }
}
