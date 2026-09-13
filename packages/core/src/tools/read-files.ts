import { realpathSync, statSync } from 'node:fs'
import type { Turn } from '../types'

export function recordReadFile(turn: Turn, path: string, mtimeMs: number): void {
  turn.readFiles.add(path)
  if (!turn.readFileMtimes) turn.readFileMtimes = new Map()
  turn.readFileMtimes.set(path, mtimeMs)
}

export function markReadPath(turn: Turn, path: string): void {
  let mtimeMs = 0
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    mtimeMs = Date.now()
  }
  recordReadFile(turn, path, mtimeMs)
}

export function isStaleSinceRead(turn: Turn, resolved: string, candidate: string): boolean {
  const recorded = lookupReadMtime(turn, resolved, candidate)
  if (recorded === undefined) return false
  try {
    return statSync(resolved).mtimeMs !== recorded
  } catch {
    return false
  }
}

function lookupReadMtime(turn: Turn, resolved: string, candidate: string): number | undefined {
  const map = turn.readFileMtimes
  if (!map) return undefined
  const direct = map.get(resolved) ?? map.get(candidate)
  if (direct !== undefined) return direct
  for (const [seen, mtime] of map) {
    if (seen === resolved || seen === candidate) return mtime
    try {
      if (realpathSync(seen) === resolved) return mtime
    } catch {
      // entry may no longer exist
    }
  }
  return undefined
}
