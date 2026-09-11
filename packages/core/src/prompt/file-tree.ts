import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isIgnoredDirName, posixRel } from '../tools/glob'

export const FILE_TREE_MAX_ENTRIES = 80
export const FILE_TREE_MAX_DEPTH = 4
export const FILE_TREE_CHAR_CAP = 4000

export function loadProjectFileTree(
  cwd: string,
  opts?: { maxEntries?: number },
): string {
  if (cwd.length === 0) return ''

  let rootStat
  try {
    rootStat = statSync(cwd)
  } catch {
    return ''
  }
  if (!rootStat.isDirectory()) return ''

  const maxEntries = Math.max(0, opts?.maxEntries ?? FILE_TREE_MAX_ENTRIES)
  if (maxEntries === 0) return ''

  const files: string[] = []
  visit(cwd, cwd, 0, maxEntries, files)
  files.sort()
  return joinWithinCap(files, FILE_TREE_CHAR_CAP)
}

function visit(
  root: string,
  dir: string,
  depth: number,
  maxEntries: number,
  out: string[],
): void {
  if (out.length >= maxEntries) return
  if (depth > FILE_TREE_MAX_DEPTH) return

  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  for (const ent of entries) {
    if (out.length >= maxEntries) return
    const abs = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (isIgnoredDirName(ent.name)) continue
      visit(root, abs, depth + 1, maxEntries, out)
      continue
    }
    if (!ent.isFile()) continue
    out.push(posixRel(root, abs))
  }
}

function joinWithinCap(paths: string[], cap: number): string {
  let out = ''
  for (const path of paths) {
    const next = out.length === 0 ? path : `${out}\n${path}`
    if (next.length > cap) {
      if (out.length === 0) return path.slice(0, cap)
      return out
    }
    out = next
  }
  return out
}
