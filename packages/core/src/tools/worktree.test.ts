import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function initGitRepo(dir: string): void {
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    expect(result.status).toBe(0)
  }
  run(['init'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['commit', '--allow-empty', '-m', 'init'])
}

describe('prepareChildWorktree', () => {
  test('isolation none keeps the parent cwd', () => {
    const cwd = tempDir('ravenclaw-wt-none-')
    const handle = prepareChildWorktree(cwd, 'child-1', 'none')
    expect(handle.cwd).toBe(cwd)
    handle.cleanup()
  })

  test('creates a detached worktree then removes it', () => {
    const cwd = tempDir('ravenclaw-wt-git-')
    initGitRepo(cwd)
    const handle = prepareChildWorktree(cwd, 'sess_child', 'worktree')
    expect(handle.cwd).toBe(join(cwd, '.ravenclaw', 'worktrees', 'sess_child'))
    expect(existsSync(handle.cwd)).toBe(true)
    expect(existsSync(join(handle.cwd, '.git'))).toBe(true)
    handle.cleanup()
    expect(existsSync(handle.cwd)).toBe(false)
  })

  test('falls back to the parent cwd when it is not a git repo', () => {
    const cwd = tempDir('ravenclaw-wt-nongit-')
    const handle = prepareChildWorktree(cwd, 'sess_child', 'worktree')
    expect(handle.cwd).toBe(cwd)
    handle.cleanup()
    expect(existsSync(join(cwd, '.ravenclaw', 'worktrees', 'sess_child'))).toBe(false)
  })

  test('cleanup keeps a dirty worktree', () => {
    const cwd = tempDir('ravenclaw-wt-dirty-')
    initGitRepo(cwd)
    const handle = prepareChildWorktree(cwd, 'sess_dirty', 'worktree')
    expect(handle.cwd).toBe(join(cwd, '.ravenclaw', 'worktrees', 'sess_dirty'))
    writeFileSync(join(handle.cwd, 'scratch.txt'), 'keep me\n')
    expect(isWorktreeDirty(handle.cwd)).toBe(true)
    handle.cleanup()
    expect(existsSync(handle.cwd)).toBe(true)
    expect(existsSync(join(handle.cwd, '.git'))).toBe(true)
    expect(readFileSync(join(handle.cwd, 'scratch.txt'), 'utf8')).toBe('keep me\n')
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
