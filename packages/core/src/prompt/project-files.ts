import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const PROJECT_FILE_CHAR_CAP = 40_000
export const PROJECT_FILES_TOTAL_CAP = 60_000

const PROJECT_FILE_NAMES = ['AGENTS.md', 'RAVEN.md', 'CLAUDE.md'] as const
const DOT_RAVEN_FILE = join('.ravenclaw', 'RAVEN.md')
const AT_INCLUDE_SOURCE = '^[ \\t]*@(\\S+)[ \\t]*$'

export function loadProjectFiles(cwd: string): string {
  const acc = { used: 0, seen: new Set<string>() }
  const chunks: string[] = []

  for (const file of collectProjectFiles(cwd)) {
    if (acc.used >= PROJECT_FILES_TOTAL_CAP) break
    const key = fileKey(file)
    if (key !== null && acc.seen.has(key)) continue
    if (key !== null) acc.seen.add(key)
    const raw = readTextFile(file)
    if (raw === null) continue
    const capped = raw.length > PROJECT_FILE_CHAR_CAP ? raw.slice(0, PROJECT_FILE_CHAR_CAP) : raw
    const expanded = expandAtIncludes(capped, dirname(file), acc)
    if (expanded.length > 0) chunks.push(expanded)
  }

  return chunks.join('')
}

export function expandAtIncludes(
  text: string,
  fromDir: string,
  acc: { used: number; seen: Set<string> },
): string {
  let out = ''
  let last = 0
  // Fresh regex per call so recursive expansion cannot share lastIndex.
  const atInclude = new RegExp(AT_INCLUDE_SOURCE, 'gm')
  for (const match of text.matchAll(atInclude)) {
    const index = match.index ?? 0
    out += takeBudget(text.slice(last, index), acc)
    if (acc.used >= PROJECT_FILES_TOTAL_CAP) return out

    const spec = match[1]
    const included = spec === undefined ? null : readInclude(spec, fromDir, acc)
    if (included === null) {
      out += takeBudget(match[0], acc)
    } else {
      out += included
    }
    last = index + match[0].length
    if (acc.used >= PROJECT_FILES_TOTAL_CAP) return out
  }
  out += takeBudget(text.slice(last), acc)
  return out
}

function collectProjectFiles(cwd: string): string[] {
  const found: string[] = []
  let dir = resolve(cwd)
  while (true) {
    for (const name of PROJECT_FILE_NAMES) {
      pushIfFile(found, join(dir, name))
    }
    pushIfFile(found, join(dir, DOT_RAVEN_FILE))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return found
}

function pushIfFile(out: string[], path: string): void {
  if (!existsSync(path)) return
  try {
    if (statSync(path).isFile()) out.push(path)
  } catch {
    // unreadable path
  }
}

function readInclude(
  spec: string,
  fromDir: string,
  acc: { used: number; seen: Set<string> },
): string | null {
  const resolved = isAbsolute(spec) ? spec : resolve(fromDir, spec)
  const key = fileKey(resolved)
  if (key === null) return null
  if (acc.seen.has(key)) return ''
  acc.seen.add(key)
  const raw = readTextFile(resolved)
  if (raw === null) return null
  const capped = raw.length > PROJECT_FILE_CHAR_CAP ? raw.slice(0, PROJECT_FILE_CHAR_CAP) : raw
  return expandAtIncludes(capped, dirname(resolved), acc)
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

function fileKey(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return existsSync(path) ? resolve(path) : null
  }
}

function takeBudget(text: string, acc: { used: number; seen: Set<string> }): string {
  const room = PROJECT_FILES_TOTAL_CAP - acc.used
  if (room <= 0 || text.length === 0) return ''
  const chunk = text.length > room ? text.slice(0, room) : text
  acc.used += chunk.length
  return chunk
}
