import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionJob } from '../types'
import { shadowBranchName } from './session-worktree'
import { isWorktreeDirty, prepareChildWorktree } from './worktree'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return (result.stdout ?? '').trim()
}

function gitStatus(cwd: string, args: string[]): number | null {
  return spawnSync('git', args, { cwd, encoding: 'utf8' }).status
}

function initGitRepo(dir: string): void {
  expect(gitStatus(dir, ['init'])).toBe(0)
  expect(gitStatus(dir, ['config', 'user.email', 'test@example.com'])).toBe(0)
  expect(gitStatus(dir, ['config', 'user.name', 'Test'])).toBe(0)
  expect(gitStatus(dir, ['config', 'commit.gpgsign', 'false'])).toBe(0)
  expect(gitStatus(dir, ['commit', '--allow-empty', '-m', 'init'])).toBe(0)
}

describe('prepareChildWorktree', () => {
  test('isolation none keeps the parent cwd', () => {
    const cwd = tempDir('ravenclaw-wt-none-')
    const handle = prepareChildWorktree(cwd, 'child-1', 'none')
    expect(handle.cwd).toBe(cwd)
    expect(handle.created).toBe(false)
    expect(handle.cleanup()).toEqual({ path: cwd, dirty: false, pruned: false })
  })

  test('creates a detached worktree then removes it', () => {
    const cwd = tempDir('ravenclaw-wt-git-')
    initGitRepo(cwd)
    const handle = prepareChildWorktree(cwd, 'sess_child', 'worktree')
    const path = join(cwd, '.ravenclaw', 'worktrees', 'sess_child')
    expect(handle.cwd).toBe(path)
    expect(handle.created).toBe(true)
    expect(handle.cleanup()).toEqual({ path, dirty: false, pruned: true })
    expect(existsSync(path)).toBe(false)
  })

  test('falls back to the parent cwd when it is not a git repo', () => {
    const cwd = tempDir('ravenclaw-wt-nongit-')
    const handle = prepareChildWorktree(cwd, 'sess_child', 'worktree')
    expect(handle.cwd).toBe(cwd)
    expect(handle.created).toBe(false)
    expect(handle.cleanup()).toEqual({ path: cwd, dirty: false, pruned: false })
    expect(existsSync(join(cwd, '.ravenclaw', 'worktrees', 'sess_child'))).toBe(false)
  })

  test('child worktree merge-base is the parent shadow tip at spawn', () => {
    const cwd = tempDir('ravenclaw-wt-stack-')
    initGitRepo(cwd)
    const initSha = git(cwd, ['rev-parse', 'HEAD'])
    const parentPath = join(cwd, '.ravenclaw', 'worktrees', 'parent')
    mkdirSync(join(cwd, '.ravenclaw', 'worktrees'), { recursive: true })
    expect(gitStatus(cwd, ['worktree', 'add', '-b', 'raven/parent', parentPath, initSha])).toBe(0)
    writeFileSync(join(parentPath, 'parent.txt'), 'parent tip\n')
    expect(gitStatus(parentPath, ['add', 'parent.txt'])).toBe(0)
    expect(gitStatus(parentPath, ['commit', '-m', 'parent tip'])).toBe(0)
    const shaP = git(parentPath, ['rev-parse', 'HEAD'])
    expect(shaP).not.toBe(initSha)

    const parentJob: SessionJob = {
      baseBranch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD',
      shadowBranch: 'raven/parent',
      baseCommitSha: initSha,
      worktreePath: parentPath,
    }
    const handle = prepareChildWorktree(cwd, 'sess_child_stack', 'worktree', parentJob)
    expect(handle.created).toBe(true)
    expect(handle.job?.baseBranch).toBe(parentJob.shadowBranch)
    expect(handle.job?.shadowBranch).toBe(shadowBranchName('sess_child_stack'))
    expect(handle.job?.baseCommitSha).toBe(shaP)
    expect(handle.job?.worktreePath).toBe(handle.cwd)
    expect(git(handle.cwd, ['merge-base', 'HEAD', parentJob.shadowBranch])).toBe(shaP)
    expect(git(handle.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(handle.job?.shadowBranch)

    handle.cleanup()
  })

  test('cleanup keeps a dirty worktree', () => {
    const cwd = tempDir('ravenclaw-wt-dirty-')
    initGitRepo(cwd)
    const handle = prepareChildWorktree(cwd, 'sess_dirty', 'worktree')
    writeFileSync(join(handle.cwd, 'scratch.txt'), 'keep me\n')
    expect(handle.cleanup()).toEqual({
      path: handle.cwd,
      dirty: true,
      pruned: false,
    })
    expect(existsSync(handle.cwd)).toBe(true)
  })

  test('stacked child cleanup deletes raven/* branch when pruned', () => {
    const cwd = tempDir('ravenclaw-wt-gc-clean-')
    initGitRepo(cwd)
    const initSha = git(cwd, ['rev-parse', 'HEAD'])
    const parentPath = join(cwd, '.ravenclaw', 'worktrees', 'parent_gc')
    mkdirSync(join(cwd, '.ravenclaw', 'worktrees'), { recursive: true })
    expect(gitStatus(cwd, ['worktree', 'add', '-b', 'raven/parent_gc', parentPath, initSha])).toBe(0)
    const parentJob: SessionJob = {
      baseBranch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD',
      shadowBranch: 'raven/parent_gc',
      baseCommitSha: initSha,
      worktreePath: parentPath,
    }
    const childId = 'sess_child_gc_clean'
    const shadow = shadowBranchName(childId)
    const handle = prepareChildWorktree(cwd, childId, 'worktree', parentJob)
    expect(handle.created).toBe(true)
    expect(handle.job?.shadowBranch).toBe(shadow)
    expect(gitStatus(cwd, ['show-ref', '--verify', `refs/heads/${shadow}`])).toBe(0)

    const report = handle.cleanup()
    expect(report).toEqual({ path: handle.cwd, dirty: false, pruned: true })
    expect(existsSync(handle.cwd)).toBe(false)
    expect(git(cwd, ['branch', '--list', shadow])).toBe('')
    expect(gitStatus(cwd, ['show-ref', '--verify', `refs/heads/${shadow}`])).not.toBe(0)
  })

  test('stacked child dirty cleanup keeps path and leftoverBranch', () => {
    const cwd = tempDir('ravenclaw-wt-gc-dirty-')
    initGitRepo(cwd)
    const initSha = git(cwd, ['rev-parse', 'HEAD'])
    const parentPath = join(cwd, '.ravenclaw', 'worktrees', 'parent_gc_dirty')
    mkdirSync(join(cwd, '.ravenclaw', 'worktrees'), { recursive: true })
    expect(
      gitStatus(cwd, ['worktree', 'add', '-b', 'raven/parent_gc_dirty', parentPath, initSha]),
    ).toBe(0)
    const parentJob: SessionJob = {
      baseBranch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD',
      shadowBranch: 'raven/parent_gc_dirty',
      baseCommitSha: initSha,
      worktreePath: parentPath,
    }
    const childId = 'sess_child_gc_dirty'
    const shadow = shadowBranchName(childId)
    const handle = prepareChildWorktree(cwd, childId, 'worktree', parentJob)
    expect(handle.created).toBe(true)
    writeFileSync(join(handle.cwd, 'scratch.txt'), 'keep me\n')

    const report = handle.cleanup()
    expect(report).toEqual({
      path: handle.cwd,
      dirty: true,
      pruned: false,
      leftoverBranch: shadow,
    })
    expect(existsSync(handle.cwd)).toBe(true)
    expect(gitStatus(cwd, ['show-ref', '--verify', `refs/heads/${shadow}`])).toBe(0)
  })
})

describe('isWorktreeDirty', () => {
  test('is false for a clean git worktree and true when dirty or status fails', () => {
    const cwd = tempDir('ravenclaw-wt-status-')
    initGitRepo(cwd)
    const handle = prepareChildWorktree(cwd, 'sess_status', 'worktree')
    expect(isWorktreeDirty(handle.cwd)).toBe(false)

    writeFileSync(join(handle.cwd, 'scratch.txt'), 'x\n')
    expect(isWorktreeDirty(handle.cwd)).toBe(true)

    const nongit = tempDir('ravenclaw-wt-status-nongit-')
    expect(isWorktreeDirty(nongit)).toBe(true)

    handle.cleanup()
    expect(existsSync(handle.cwd)).toBe(true)
  })
})
