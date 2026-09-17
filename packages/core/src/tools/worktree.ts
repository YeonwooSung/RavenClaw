import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionJob } from '../types'
import { shadowBranchName } from './session-worktree'

export type IsolationMode = 'none' | 'worktree'

export interface WorktreeCleanupReport {
  path: string
  dirty: boolean
  pruned: boolean
  /** Shadow branch left behind when a dirty worktree was kept. */
  leftoverBranch?: string
}

export interface ChildWorktree {
  cwd: string
  created: boolean
  cleanup: () => WorktreeCleanupReport
  job?: SessionJob
}

const GIT_TIMEOUT_MS = 30_000

export function prepareChildWorktree(
  parentCwd: string,
  childSessionId: string,
  isolation: IsolationMode,
  parentJob?: SessionJob,
): ChildWorktree {
  const fallback: ChildWorktree = {
    cwd: parentCwd,
    created: false,
    cleanup: () => ({ path: parentCwd, dirty: false, pruned: false }),
  }
  if (isolation !== 'worktree') return fallback

  const toplevel = gitToplevel(parentCwd)
  if (!toplevel) return fallback

  const worktreePath = join(parentCwd, '.ravenclaw', 'worktrees', childSessionId)
  try {
    mkdirSync(join(parentCwd, '.ravenclaw', 'worktrees'), { recursive: true })
  } catch {
    return fallback
  }

  let job: SessionJob | undefined
  let shadow: string | undefined
  let added: { ok: boolean; stdout: string }
  if (parentJob) {
    const baseSha = runGit(parentJob.worktreePath, ['rev-parse', 'HEAD']).stdout.trim()
    shadow = shadowBranchName(childSessionId)
    added = runGit(toplevel, ['worktree', 'add', '-b', shadow, worktreePath, baseSha])
    if (added.ok) {
      job = {
        baseBranch: parentJob.shadowBranch,
        shadowBranch: shadow,
        baseCommitSha: baseSha,
        worktreePath,
      }
    } else {
      shadow = undefined
    }
  } else {
    added = runGit(toplevel, ['worktree', 'add', '--detach', worktreePath])
  }
  if (!added.ok) return fallback

  return {
    cwd: worktreePath,
    created: true,
    ...(job !== undefined ? { job } : {}),
    cleanup: () => {
      if (isWorktreeDirty(worktreePath)) {
        return {
          path: worktreePath,
          dirty: true,
          pruned: false,
          ...(shadow !== undefined ? { leftoverBranch: shadow } : {}),
        }
      }
      const removed = runGit(toplevel, ['worktree', 'remove', worktreePath])
      if (!removed.ok && !isWorktreeDirty(worktreePath)) {
        runGit(toplevel, ['worktree', 'remove', '--force', worktreePath])
      }
      // Path gone after prune: status fails and must not look dirty.
      if (existsSync(worktreePath) && isWorktreeDirty(worktreePath)) {
        return {
          path: worktreePath,
          dirty: true,
          pruned: false,
          ...(shadow !== undefined ? { leftoverBranch: shadow } : {}),
        }
      }
      if (shadow !== undefined) {
        runGit(toplevel, ['branch', '-D', shadow])
      }
      return { path: worktreePath, dirty: false, pruned: true }
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
