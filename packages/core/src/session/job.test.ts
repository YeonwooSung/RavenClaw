import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionJob, SessionRecord } from '../types'
import { enterSessionWorktree, exitSessionWorktree } from '../tools/session-worktree'
import { maybeCommitJob, setJobAutoCommit } from './job'

const tempDirs: string[] = []
const sessionIds: string[] = []
let seq = 0

afterEach(() => {
  while (sessionIds.length > 0) {
    const id = sessionIds.pop()
    if (id) exitSessionWorktree(id, 'remove', true)
  }
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

function nextSession(): string {
  const id = `sess_job_${Date.now()}_${seq++}`
  sessionIds.push(id)
  return id
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

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  expect(result.status).toBe(0)
  return result.stdout.trim()
}

function dummyJob(cwd: string): SessionJob {
  return {
    baseBranch: 'main',
    shadowBranch: 'raven/x',
    baseCommitSha: 'abc',
    worktreePath: cwd,
  }
}

function sessionRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_job_flag',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/tmp',
    model: 'dummy',
    permissionMode: 'default',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
    ...over,
  }
}

describe('maybeCommitJob', () => {
  test('maybeCommitJob creates one commit on a dirty shadow branch', () => {
    const cwd = tempDir('ravenclaw-job-commit-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    const entered = enterSessionWorktree(sessionId, cwd)
    expect(entered.ok).toBe(true)
    expect(entered.job).toBeDefined()
    const job = entered.job!
    writeFileSync(join(job.worktreePath, 'note.txt'), 'hello\n')
    const turnId = 'turnabcd1234'
    const result = maybeCommitJob({ job, turnId, cwd: job.worktreePath })
    expect(result.committed).toBe(true)
    expect(result.sha).toBeDefined()
    const head = git(job.worktreePath, ['rev-parse', 'HEAD'])
    expect(head).toBe(result.sha)
    expect(head).not.toBe(job.baseCommitSha)
    expect(git(job.worktreePath, ['log', '-1', '--pretty=%s'])).toBe('raven: turn turnabcd')
    expect(git(job.worktreePath, ['log', '-1', '--pretty=%an'])).toBe('Test')
    expect(git(job.worktreePath, ['log', '-1', '--pretty=%ae'])).toBe('test@example.com')
    expect(git(job.worktreePath, ['status', '--porcelain'])).toBe('')
  })

  test('maybeCommitJob does not commit a clean worktree', () => {
    const cwd = tempDir('ravenclaw-job-clean-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    const entered = enterSessionWorktree(sessionId, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    const before = git(job.worktreePath, ['rev-parse', 'HEAD'])
    const result = maybeCommitJob({ job, turnId: 'turnclean1', cwd: job.worktreePath })
    expect(result).toEqual({ committed: false })
    expect(git(job.worktreePath, ['rev-parse', 'HEAD'])).toBe(before)
  })

  test('maybeCommitJob reports a notice when git fails', () => {
    const cwd = tempDir('ravenclaw-job-fail-')
    const result = maybeCommitJob({
      job: dummyJob(cwd),
      turnId: 'turnfail01',
      cwd,
    })
    expect(result.committed).toBe(false)
    expect(result.notice?.startsWith('job commit failed:')).toBe(true)
  })
})

describe('setJobAutoCommit', () => {
  test('flips the session flag', () => {
    const session = sessionRecord()
    setJobAutoCommit(session, true)
    expect(session.jobAutoCommit).toBe(true)
    setJobAutoCommit(session, false)
    expect(session.jobAutoCommit).toBe(false)
  })
})
