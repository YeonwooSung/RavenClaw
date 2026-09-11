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
      runGit(toplevel, ['worktree', 'remove', '--force', worktreePath])
    },
  }
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
