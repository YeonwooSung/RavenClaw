import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { InstructionFilesMode } from '../config'

export const SUBDIR_AGENTS_CHAR_CAP = 32_000

const SUBDIR_AGENT_NAMES = ['AGENTS.md', 'RAVEN.md', 'CLAUDE.md'] as const

function namesFor(mode: InstructionFilesMode): readonly string[] {
  if (mode === 'claude') return ['CLAUDE.md', 'RAVEN.md']
  if (mode === 'agents-fallback') return ['CLAUDE.md', 'AGENTS.md', 'RAVEN.md']
  return SUBDIR_AGENT_NAMES
}

/** First AGENTS.md / RAVEN.md / CLAUDE.md below `cwd`, walking from the file toward the project root. */
export function loadNearestSubdirAgents(
  cwd: string,
  filePath: string,
  seen: Set<string>,
  mode: InstructionFilesMode = 'both',
): string | undefined {
  const root = resolve(cwd)
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath)
  if (!isInsideRoot(abs, root)) return undefined

  let dir = isDirectory(abs) ? abs : dirname(abs)
  while (isStrictlyInside(dir, root)) {
    for (const name of namesFor(mode)) {
      const candidate = resolve(dir, name)
      if (!isFile(candidate)) continue
      const key = fileKey(candidate)
      if (key === null) continue
      if (seen.has(key)) return undefined
      seen.add(key)
      const raw = readTextFile(candidate)
      if (raw === null || raw.length === 0) return undefined
      const content = raw.length > SUBDIR_AGENTS_CHAR_CAP ? raw.slice(0, SUBDIR_AGENTS_CHAR_CAP) : raw
      return `[AGENTS.md: ${posixRel(root, dir)}]\n${content}`
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readTextFile(path: string): string | null {
  try {
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

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isStrictlyInside(path: string, root: string): boolean {
  if (pathsEqual(path, root)) return false
  return isInsideRoot(path, root)
}

function pathsEqual(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

function posixRel(from: string, to: string): string {
  const rel = relative(from, to)
  if (rel === '') return '.'
  return rel.split(sep).join('/')
}
