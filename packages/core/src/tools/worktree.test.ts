import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareChildWorktree } from './worktree'

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
})
