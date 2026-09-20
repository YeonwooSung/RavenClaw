import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionJob } from '../types'
import { jobDiff } from './job-diff'

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

function gitSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}

function initRepo(): string {
  const dir = tempDir('ravenclaw-job-diff-')
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: gitSpawnEnv() })
    expect(result.status).toBe(0)
  }
  run(['init'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])
  run(['commit', '--allow-empty', '-m', 'init'])
  return dir
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitSpawnEnv() })
  expect(result.status).toBe(0)
  return result.stdout.trim()
}

function revParse(repo: string): string {
  return git(repo, ['rev-parse', 'HEAD'])
}

function write(repo: string, rel: string, content: string): void {
  writeFileSync(join(repo, rel), content)
}

describe('jobDiff', () => {
  test('jobDiff lists committed create plus dirty update; rename has from', () => {
    const repo = initRepo()
    const base = revParse(repo)
    write(repo, 'added.txt', 'one\n')
    git(repo, ['add', 'added.txt'])
    git(repo, ['commit', '-m', 'add'])
    write(repo, 'added.txt', 'one\ntwo\n')
    const job: SessionJob = {
      baseBranch: 'main',
      shadowBranch: 'raven/t',
      baseCommitSha: base,
      worktreePath: repo,
    }
    const diff = jobDiff(job)
    expect(diff.ok).toBe(true)
    if (!diff.ok) return
    expect(diff.dirty).toBe(true)
    expect(diff.files.some((f) => f.path === 'added.txt' && f.op === 'create' && f.plus >= 1)).toBe(true)

    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'two'])
    git(repo, ['mv', 'added.txt', 'renamed.txt'])
    const renamed = jobDiff(job)
    expect(renamed.ok).toBe(true)
    if (!renamed.ok) return
    const row = renamed.files.find((f) => f.path === 'renamed.txt')
    expect(row?.op).toBe('rename')
    expect(row?.from).toBe('added.txt')
    expect(row?.plus).toBe(2)
    expect(row?.minus).toBe(0)
    expect(renamed.files.some((f) => f.path === 'added.txt')).toBe(false)
  })

  test('jobDiff on a missing worktree is ok: false', () => {
    const diff = jobDiff({
      baseBranch: 'main',
      shadowBranch: 'raven/t',
      baseCommitSha: 'abc',
      worktreePath: '/no/such/worktree',
    })
    expect(diff.ok).toBe(false)
  })

  test('jobDiff does not double-count staged dirty lines', () => {
    const repo = initRepo()
    const base = revParse(repo)
    write(repo, 'note.txt', 'one\n')
    git(repo, ['add', 'note.txt'])
    git(repo, ['commit', '-m', 'add one'])
    write(repo, 'note.txt', 'one\ntwo\n')
    git(repo, ['add', 'note.txt'])
    const job: SessionJob = {
      baseBranch: 'main',
      shadowBranch: 'raven/t',
      baseCommitSha: base,
      worktreePath: repo,
    }
    const diff = jobDiff(job)
    expect(diff.ok).toBe(true)
    if (!diff.ok) return
    expect(diff.dirty).toBe(true)
    const row = diff.files.find((f) => f.path === 'note.txt')
    expect(row).toBeDefined()
    // committed create +1, staged +1 → plus === 2 (double-count of staged would yield 3)
    expect(row?.plus).toBe(2)
    expect(row?.minus).toBe(0)
  })

  test('jobDiff ignores foreign GIT_DIR', () => {
    const repo = initRepo()
    const base = revParse(repo)
    write(repo, 'new.ts', 'hello\n')
    git(repo, ['add', 'new.ts'])
    git(repo, ['commit', '-m', 'add'])
    write(repo, 'dirty.txt', 'x\n')

    const foreign = join(tempDir('ravenclaw-job-diff-foreign-'), 'not-a-git')
    const prevDir = process.env.GIT_DIR
    const prevWorkTree = process.env.GIT_WORK_TREE
    const prevIndex = process.env.GIT_INDEX_FILE
    process.env.GIT_DIR = foreign
    process.env.GIT_WORK_TREE = tempDir('ravenclaw-job-diff-wt-')
    process.env.GIT_INDEX_FILE = join(tempDir('ravenclaw-job-diff-index-'), 'index')
    try {
      const diff = jobDiff({
        baseBranch: 'main',
        shadowBranch: 'raven/t',
        baseCommitSha: base,
        worktreePath: repo,
      })
      expect(diff.ok).toBe(true)
      if (!diff.ok) return
      expect(diff.dirty).toBe(true)
      expect(diff.files.some((f) => f.path === 'new.ts' && f.op === 'create')).toBe(true)
      expect(diff.files.some((f) => f.path === 'dirty.txt' && f.op === 'create')).toBe(true)
    } finally {
      if (prevDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = prevDir
      if (prevWorkTree === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = prevWorkTree
      if (prevIndex === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = prevIndex
    }
  })
})
