import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ravenclawHome } from '../home'

export interface SessionWorktree {
  originalCwd: string
  worktreePath: string
  name: string
}

export type WorktreeExitAction = 'keep' | 'remove'

const GIT_TIMEOUT_MS = 30_000
const sessions = new Map<string, SessionWorktree>()

export function getSessionWorktree(sessionId: string): SessionWorktree | undefined {
  const live = sessions.get(sessionId)
  if (live) return live
  const loaded = loadSidecar(sessionId)
  if (loaded) sessions.set(sessionId, loaded)
  return loaded
}

export function enterSessionWorktree(
  sessionId: string,
  parentCwd: string,
  name?: string,
): { ok: boolean; cwd: string; error?: string } {
  const existing = getSessionWorktree(sessionId)
  if (existing) {
    return { ok: false, cwd: existing.worktreePath, error: 'session already has a worktree' }
  }

  const toplevel = gitToplevel(parentCwd)
  if (!toplevel) return { ok: false, cwd: parentCwd, error: 'not a git repository' }

  const slug = worktreeName(sessionId, name)
  const worktreePath = join(parentCwd, '.ravenclaw', 'worktrees', slug)
  try {
    mkdirSync(join(parentCwd, '.ravenclaw', 'worktrees'), { recursive: true })
  } catch (error) {
    return { ok: false, cwd: parentCwd, error: errorMessage(error) }
  }

  const added = runGit(toplevel, ['worktree', 'add', '--detach', worktreePath])
  if (!added.ok) {
    const detail = added.stderr.trim() || added.stdout.trim() || 'git worktree add failed'
    return { ok: false, cwd: parentCwd, error: detail }
  }

  const row: SessionWorktree = { originalCwd: parentCwd, worktreePath, name: slug }
  sessions.set(sessionId, row)
  saveSidecar(sessionId, row)
  return { ok: true, cwd: worktreePath }
}

export function exitSessionWorktree(
  sessionId: string,
  action: WorktreeExitAction,
  discard?: boolean,
): { ok: boolean; cwd: string; error?: string } {
  const existing = getSessionWorktree(sessionId)
  if (!existing) return { ok: false, cwd: '', error: 'no session worktree' }

  if (action === 'remove') {
    const dirty = isWorktreeDirty(existing.worktreePath)
    if (dirty && discard !== true) {
      return {
        ok: false,
        cwd: existing.worktreePath,
        error: 'worktree has uncommitted changes; pass discard to remove',
      }
    }
    const toplevel = gitToplevel(existing.originalCwd) ?? gitToplevel(existing.worktreePath)
    if (toplevel) {
      const args = dirty || discard === true
        ? ['worktree', 'remove', '--force', existing.worktreePath]
        : ['worktree', 'remove', existing.worktreePath]
      const removed = runGit(toplevel, args)
      if (!removed.ok) {
        const detail = removed.stderr.trim() || removed.stdout.trim() || 'git worktree remove failed'
        return { ok: false, cwd: existing.worktreePath, error: detail }
      }
    }
  }

  sessions.delete(sessionId)
  removeSidecar(sessionId)
  return { ok: true, cwd: existing.originalCwd }
}

function sidecarPath(sessionId: string): string {
  return join(ravenclawHome(), 'session-worktrees', `${sessionId}.json`)
}

function saveSidecar(sessionId: string, row: SessionWorktree): void {
  try {
    mkdirSync(join(ravenclawHome(), 'session-worktrees'), { recursive: true })
    writeFileSync(sidecarPath(sessionId), `${JSON.stringify(row)}\n`, 'utf8')
  } catch {
    // in-memory map still works for this process
  }
}

function loadSidecar(sessionId: string): SessionWorktree | undefined {
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath(sessionId), 'utf8')) as Partial<SessionWorktree>
    if (
      typeof parsed.originalCwd === 'string' &&
      typeof parsed.worktreePath === 'string' &&
      typeof parsed.name === 'string'
    ) {
      return {
        originalCwd: parsed.originalCwd,
        worktreePath: parsed.worktreePath,
        name: parsed.name,
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

function removeSidecar(sessionId: string): void {
  try {
    unlinkSync(sidecarPath(sessionId))
  } catch {
    // already gone
  }
}

export function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    })
    return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch {
    return { ok: false, stdout: '', stderr: '' }
  }
}

export function gitToplevel(cwd: string): string | undefined {
  const result = runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) return undefined
  const line = result.stdout.trim()
  return line.length > 0 ? line : undefined
}

function isWorktreeDirty(cwd: string): boolean {
  const result = runGit(cwd, ['status', '--porcelain'])
  if (!result.ok) return true
  return result.stdout.trim().length > 0
}

function worktreeName(sessionId: string, name?: string): string {
  if (name !== undefined && name.length > 0) {
    const base = name.replace(/\\/g, '/').split('/').pop() ?? name
    const safe = base.replace(/[^A-Za-z0-9._-]/g, '_')
    if (safe.length > 0) return safe
  }
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned.slice(0, 8) || 'worktree'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
