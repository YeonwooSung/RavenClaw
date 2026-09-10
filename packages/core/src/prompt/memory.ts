import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from '../home'

export const MEMORY_FILE_CHAR_CAP = 8_000
export const MEMORY_TOTAL_CHAR_CAP = 16_000

const TRUNCATION_NOTE = '\n... [truncated]'

type MemoryKind = 'user' | 'agent'

export function loadMemorySnapshot(cwd: string, home = ravenclawHome()): string {
  const userBodies: string[] = []
  const agentBodies: string[] = []
  let used = 0

  for (const source of memorySources(cwd, home)) {
    if (used >= MEMORY_TOTAL_CHAR_CAP) break
    const raw = readTextFile(source.path)
    if (raw === null || raw.trim().length === 0) continue
    const room = MEMORY_TOTAL_CHAR_CAP - used
    const keep = Math.min(raw.length, MEMORY_FILE_CHAR_CAP, room)
    if (keep <= 0) continue
    let body = raw.slice(0, keep)
    if (keep < raw.length) body += TRUNCATION_NOTE
    used += keep
    if (source.kind === 'user') userBodies.push(body)
    else agentBodies.push(body)
  }

  const sections: string[] = []
  if (userBodies.length > 0) {
    sections.push(`User memory:\n${userBodies.join('\n\n')}`)
  }
  if (agentBodies.length > 0) {
    sections.push(`Agent memory:\n${agentBodies.join('\n\n')}`)
  }
  return sections.join('\n\n')
}

function memorySources(cwd: string, home: string): Array<{ kind: MemoryKind; path: string }> {
  return [
    { kind: 'user', path: join(home, 'USER.md') },
    { kind: 'agent', path: join(home, 'MEMORY.md') },
    { kind: 'user', path: join(cwd, 'USER.md') },
    { kind: 'agent', path: join(cwd, 'MEMORY.md') },
    { kind: 'user', path: join(cwd, '.ravenclaw', 'USER.md') },
    { kind: 'agent', path: join(cwd, '.ravenclaw', 'MEMORY.md') },
  ]
}

function readTextFile(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null
    const text = readFileSync(path, 'utf8')
    if (text.includes('\0')) return null
    return text
  } catch {
    return null
  }
}
