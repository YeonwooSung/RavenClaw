import { statSync } from 'node:fs'
import { isInTreePath, resolveExisting } from './modes'

export function normalizeDir(cwd: string, path: string): string {
  return resolveExisting(cwd, path)
}

export function addDirectory(
  list: string[],
  cwd: string,
  path: string,
): { ok: true; list: string[] } | { ok: false; list: string[]; error: string } {
  const resolved = normalizeDir(cwd, path)
  if (!isExistingDirectory(resolved)) {
    return { ok: false, list, error: 'not a directory' }
  }
  if (list.includes(resolved)) return { ok: true, list }
  return { ok: true, list: [...list, resolved] }
}

export function isPathInAnyRoot(cwd: string, path: string, extra: string[] = []): boolean {
  return isInTreePath(cwd, path, extra)
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
