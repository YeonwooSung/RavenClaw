import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatGitDiff } from './diff-cmd'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempCwd(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  expect(result.status).toBe(0)
}

function initGitRepo(cwd: string): void {
  runGit(cwd, ['init'])
  runGit(cwd, ['config', 'user.email', 'test@example.com'])
  runGit(cwd, ['config', 'user.name', 'Test'])
  runGit(cwd, ['config', 'commit.gpgsign', 'false'])
}

describe('formatGitDiff', () => {
  test('reports a missing git work tree', () => {
    const cwd = tempCwd('raven-diff-nongit-')
    expect(formatGitDiff(cwd)).toBe('not a git repository')
  })

  test('returns empty text for a clean repo', () => {
    const cwd = tempCwd('raven-diff-clean-')
    initGitRepo(cwd)
    runGit(cwd, ['commit', '--allow-empty', '-m', 'init'])
    expect(formatGitDiff(cwd)).toBe('')
  })

  test('includes unstaged and staged diffs and caps the body', () => {
    const cwd = tempCwd('raven-diff-git-')
    initGitRepo(cwd)
    writeFileSync(join(cwd, 'tracked.txt'), 'alpha\n')
    runGit(cwd, ['add', 'tracked.txt'])
    runGit(cwd, ['commit', '-m', 'init'])

    writeFileSync(join(cwd, 'tracked.txt'), 'beta\n')
    writeFileSync(join(cwd, 'staged.txt'), 'gamma\n')
    runGit(cwd, ['add', 'staged.txt'])

    const text = formatGitDiff(cwd)
    expect(text).toContain('tracked.txt')
    expect(text).toContain('-alpha')
    expect(text).toContain('+beta')
    expect(text).toContain('staged.txt')
    expect(text).toContain('+gamma')

    writeFileSync(join(cwd, 'huge.txt'), `${'x'.repeat(25_000)}\n`)
    runGit(cwd, ['add', 'huge.txt'])
    expect(formatGitDiff(cwd).length).toBe(20_000)
  })
})
