import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Message, Turn } from '../types'
import { createWorkspaceFs } from './workspace-fs'

export function recordReadFile(turn: Turn, path: string, mtimeMs: number): void {
  turn.readFiles.add(path)
  if (!turn.readFileMtimes) turn.readFileMtimes = new Map()
  turn.readFileMtimes.set(path, mtimeMs)
}

export function stampReadMtime(
  turn: Turn,
  toolName: string,
  input: unknown,
  msg: Extract<Message, { role: 'tool' }>,
): void {
  if (toolName !== 'Read' || !msg.ok) return
  const path = (input as { path?: unknown } | undefined)?.path
  if (typeof path !== 'string' || path.length === 0) return
  const recorded = lookupReadMtime(turn, resolve(turn.cwd, path), path)
  if (recorded !== undefined) msg.readMtimeMs = recorded
}

export function markReadPath(turn: Turn, path: string): void {
  const fs = createWorkspaceFs({ cwd: turn.cwd, backend: turn.terminalBackend ?? 'local' })
  let mtimeMs = 0
  try {
    const st = fs.stat(path)
    mtimeMs = st.exists ? st.mtimeMs : Date.now()
  } catch {
    mtimeMs = Date.now()
  }
  recordReadFile(turn, path, mtimeMs)
}

export function wasRead(readFiles: Set<string>, resolved: string, candidate: string): boolean {
  if (readFiles.has(resolved) || readFiles.has(candidate)) return true
  for (const seen of readFiles) {
    if (seen === resolved || seen === candidate) return true
    try {
      if (realpathSync(seen) === resolved) return true
    } catch {
      // entry may no longer exist
    }
  }
  return false
}

export function isStaleSinceRead(turn: Turn, resolved: string, candidate: string): boolean {
  const recorded = lookupReadMtime(turn, resolved, candidate)
  if (recorded === undefined) return false
  try {
    const fs = createWorkspaceFs({ cwd: turn.cwd, backend: turn.terminalBackend ?? 'local' })
    const st = fs.stat(resolved)
    if (!st.exists) return false
    return st.mtimeMs !== recorded
  } catch {
    return false
  }
}

function textOf(msg: Message): string {
  return msg.blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

export function forgetReadsNotInTail(turn: Turn, messages: Message[]): void {
  const pending = new Map<string, string>()
  const evidenced = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const block of msg.blocks) {
        if (block.type !== 'tool_use' || block.name !== 'Read') continue
        const path = (block.input as { path?: unknown } | undefined)?.path
        if (typeof path === 'string' && path.length > 0) pending.set(block.id, path)
      }
    }
    if (msg.role === 'tool' && msg.ok) {
      const path = pending.get(msg.toolUseId)
      if (path === undefined) continue
      if (textOf(msg).startsWith('[cleared ')) continue
      evidenced.add(resolve(turn.cwd, path))
    }
  }

  const keep = (seen: string): boolean => evidenced.has(seen) || evidenced.has(resolve(turn.cwd, seen))
  for (const seen of [...turn.readFiles]) {
    if (!keep(seen)) turn.readFiles.delete(seen)
  }
  if (turn.readFileMtimes) {
    for (const seen of [...turn.readFileMtimes.keys()]) {
      if (!keep(seen)) turn.readFileMtimes.delete(seen)
    }
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
