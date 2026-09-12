import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type IsolationMode = 'none' | 'worktree'

export interface ChildWorktree {
  cwd: string
  cleanup: () => void
}

const GIT_TIMEOUT_MS = 30_000

export function prepareChildWorktree(
  parentCwd: string,
  childSessionId: string,
  isolation: IsolationMode,
): ChildWorktree {
  const fallback: ChildWorktree = { cwd: parentCwd, cleanup: () => {} }
  if (isolation !== 'worktree') return fallback

  const toplevel = gitToplevel(parentCwd)
  if (!toplevel) return fallback

  const worktreePath = join(parentCwd, '.ravenclaw', 'worktrees', childSessionId)
  try {
    mkdirSync(join(parentCwd, '.ravenclaw', 'worktrees'), { recursive: true })
  } catch {
    return fallback
  }

  const added = runGit(toplevel, ['worktree', 'add', '--detach', worktreePath])
  if (!added.ok) return fallback

  return {
    cwd: worktreePath,
    cleanup: () => {
      if (isWorktreeDirty(worktreePath)) return
      const removed = runGit(toplevel, ['worktree', 'remove', worktreePath])
      if (!removed.ok && !isWorktreeDirty(worktreePath)) {
        runGit(toplevel, ['worktree', 'remove', '--force', worktreePath])
      }
    },
  }
}

export function isWorktreeDirty(cwd: string): boolean {
  const result = runGit(cwd, ['status', '--porcelain'])
  if (!result.ok) return true
  return result.stdout.length > 0
}

function gitToplevel(cwd: string): string | undefined {
  const result = runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) return undefined
  const line = result.stdout.trim()
  return line.length > 0 ? line : undefined
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    })
    return { ok: result.status === 0, stdout: result.stdout ?? '' }
  } catch {
    return { ok: false, stdout: '' }
  }
}
