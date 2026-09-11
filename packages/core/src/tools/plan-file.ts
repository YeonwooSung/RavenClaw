import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export function planFilePath(cwd: string): string {
  return join(cwd, '.ravenclaw', 'plan.md')
}

/** True only for cwd/.ravenclaw/plan.md. Symlink escapes and missing cwd are false. */
export function isPlanFilePath(cwd: string, candidate: string): boolean {
  if (!cwd || !candidate) return false
  let root: string
  try {
    if (!existsSync(cwd)) return false
    root = realpathSync(cwd)
  } catch {
    return false
  }
  const expected = join(root, '.ravenclaw', 'plan.md')
  return resolveToReal(cwd, candidate) === expected
}

function resolveToReal(cwd: string, inputPath: string): string {
  const candidate = resolve(cwd, inputPath)
  try {
    return realpathSync(candidate)
  } catch {
    const parts = [basename(candidate)]
    let parent = dirname(candidate)
    while (true) {
      try {
        return join(realpathSync(parent), ...parts)
      } catch {
        const next = dirname(parent)
        if (next === parent) return candidate
        parts.unshift(basename(parent))
        parent = next
      }
    }
  }
}
