import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, SessionJob, SessionRecord } from '../types'
import { enterSessionWorktree, exitSessionWorktree } from '../tools/session-worktree'
import {
  annotateDraftPr,
  clearSessionJobError,
  maybeCommitJob,
  openDraftPr,
  setJobAutoCommit,
  setSessionJobError,
  stampCheckpoint,
} from './job'

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

function assistantMessage(): Extract<Message, { role: 'assistant' }> {
  return {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'ok' }],
    createdAt: 1,
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

  test('maybeCommitJob commits in job.worktreePath even if cwd differs', () => {
    const cwd = tempDir('ravenclaw-job-path-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    const entered = enterSessionWorktree(sessionId, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    writeFileSync(join(job.worktreePath, 'note.txt'), 'hello\n')
    const result = maybeCommitJob({ job, turnId: 'turnpath01', cwd: '/tmp' })
    expect(result.committed).toBe(true)
    expect(result.sha).toBe(git(job.worktreePath, ['rev-parse', 'HEAD']))
    expect(git(job.worktreePath, ['log', '-1', '--pretty=%s'])).toBe('raven: turn turnpath')
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

describe('session jobError helpers', () => {
  test('setSessionJobError writes and clearSessionJobError deletes', () => {
    const session = { id: 's', jobError: undefined } as SessionRecord
    setSessionJobError(session, 'gh missing')
    expect(session.jobError).toBe('gh missing')
    clearSessionJobError(session)
    expect(session.jobError).toBeUndefined()
  })

  test('caller clears jobError after a successful openDraftPr', () => {
    const cwd = tempDir('ravenclaw-job-pr-clear-err-')
    initGitRepo(cwd)
    const session = sessionRecord({ jobError: 'gh missing' })
    const out = openDraftPr({
      job: dummyJob(cwd),
      cwd,
      gh: () => ({ ok: true, stdout: 'https://github.com/o/r/pull/4\n', stderr: '' }),
    })
    expect(out.ok).toBe(true)
    if (out.ok) clearSessionJobError(session)
    else setSessionJobError(session, out.notice)
    expect(session.jobError).toBeUndefined()
  })
})

describe('stampCheckpoint', () => {
  test('records HEAD, dirty bit, and a copied todo snapshot', () => {
    const cwd = tempDir('ravenclaw-stamp-dirty-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    const entered = enterSessionWorktree(sessionId, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    writeFileSync(join(job.worktreePath, 'dirty.txt'), 'x\n')
    const message: Extract<Message, { role: 'assistant' }> = {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok' }],
      createdAt: 1,
    }
    const todos = [{ text: 'a', status: 'pending' as const }]
    stampCheckpoint(message, job, todos, job.worktreePath)
    expect(message.checkpoint?.commitSha).toBe(git(job.worktreePath, ['rev-parse', 'HEAD']))
    expect(message.checkpoint?.dirty).toBe(true)
    expect(message.checkpoint?.todoSnapshot).toEqual([{ text: 'a', status: 'pending' }])
    expect(message.checkpoint?.todoSnapshot).not.toBe(todos)
    todos.push({ text: 'b', status: 'pending' })
    expect(message.checkpoint?.todoSnapshot).toEqual([{ text: 'a', status: 'pending' }])
  })

  test('records dirty false on a clean worktree', () => {
    const cwd = tempDir('ravenclaw-stamp-clean-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    const entered = enterSessionWorktree(sessionId, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    const message: Extract<Message, { role: 'assistant' }> = {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok' }],
      createdAt: 1,
    }
    stampCheckpoint(message, job, undefined, job.worktreePath)
    expect(message.checkpoint?.commitSha).toBe(git(job.worktreePath, ['rev-parse', 'HEAD']))
    expect(message.checkpoint?.dirty).toBe(false)
    expect(message.checkpoint?.todoSnapshot).toEqual([])
  })

  test('stampCheckpoint reads HEAD from job.worktreePath even if cwd differs', () => {
    const cwd = tempDir('ravenclaw-stamp-path-')
    initGitRepo(cwd)
    const sessionId = nextSession()
    const entered = enterSessionWorktree(sessionId, cwd)
    expect(entered.ok).toBe(true)
    const job = entered.job!
    const message: Extract<Message, { role: 'assistant' }> = {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'ok' }],
      createdAt: 1,
    }
    stampCheckpoint(message, job, undefined, '/tmp')
    expect(message.checkpoint?.commitSha).toBe(git(job.worktreePath, ['rev-parse', 'HEAD']))
    expect(message.checkpoint?.dirty).toBe(false)
  })
})

describe('openDraftPr', () => {
  test('openDraftPr on a clean shadow records a url', () => {
    const cwd = tempDir('ravenclaw-job-pr-clean-')
    initGitRepo(cwd)
    const job = dummyJob(cwd)
    const calls: string[][] = []
    const gh = (args: string[]) => {
      calls.push(args)
      return { ok: true, stdout: 'https://github.com/o/r/pull/4\n', stderr: '' }
    }
    const out = openDraftPr({ job, cwd, gh })
    expect(out.ok).toBe(true)
    expect(out.snapshot?.url).toContain('/pull/4')
    expect(out.job?.prNumber).toBe(4)
    expect(job.prNumber).toBe(4)
    expect(job.prUrl).toContain('/pull/4')
    expect(calls[0]?.[0]).toBe('pr')
    expect(calls[0]?.[1]).toBe('create')
    expect(calls[0]).toContain('--draft')
    expect(calls[0]).toContain('--base')
    expect(calls[0]).toContain('main')
    expect(calls[0]).toContain('--head')
    expect(calls[0]).toContain('raven/x')
  })

  test('openDraftPr without a job record notices and does nothing', () => {
    const calls: string[][] = []
    const out = openDraftPr({
      job: undefined as never,
      cwd: '/tmp',
      gh: (args) => {
        calls.push(args)
        return { ok: true, stdout: '', stderr: '' }
      },
    })
    expect(out.ok).toBe(false)
    expect(out.notice).toBe('no job record')
    expect(calls).toEqual([])
  })

  test('openDraftPr on a dirty worktree notices and does nothing', () => {
    const cwd = tempDir('ravenclaw-job-pr-dirty-')
    initGitRepo(cwd)
    writeFileSync(join(cwd, 'dirty.txt'), 'x\n')
    const calls: string[][] = []
    const out = openDraftPr({
      job: dummyJob(cwd),
      cwd,
      gh: (args) => {
        calls.push(args)
        return { ok: true, stdout: 'https://github.com/o/r/pull/4\n', stderr: '' }
      },
    })
    expect(out.ok).toBe(false)
    expect(out.notice).toBe('worktree is dirty')
    expect(calls).toEqual([])
  })

  test('openDraftPr edits when the job already has a prNumber', () => {
    const cwd = tempDir('ravenclaw-job-pr-edit-')
    initGitRepo(cwd)
    const job = dummyJob(cwd)
    job.prNumber = 4
    job.prUrl = 'https://github.com/o/r/pull/4'
    const calls: string[][] = []
    const out = openDraftPr({
      job,
      cwd,
      title: 'updated',
      body: 'body',
      gh: (args) => {
        calls.push(args)
        return { ok: true, stdout: 'https://github.com/o/r/pull/4\n', stderr: '' }
      },
    })
    expect(out.ok).toBe(true)
    expect(out.job?.prNumber).toBe(4)
    expect(calls[0]?.slice(0, 3)).toEqual(['pr', 'edit', '4'])
    expect(calls[0]).toContain('--title')
    expect(calls[0]).toContain('updated')
  })

  test('openDraftPr edit without title/body does not send empty --body', () => {
    const cwd = tempDir('ravenclaw-job-pr-edit-keep-')
    initGitRepo(cwd)
    const job = dummyJob(cwd)
    const calls: string[][] = []
    const gh = (args: string[]) => {
      calls.push(args)
      return { ok: true, stdout: 'https://github.com/o/r/pull/4\n', stderr: '' }
    }
    const first = openDraftPr({ job, cwd, title: 'first', body: 'keep me', gh })
    expect(first.ok).toBe(true)
    expect(job.prNumber).toBe(4)
    const second = openDraftPr({ job, cwd, gh })
    expect(second.ok).toBe(true)
    expect(calls[1]?.slice(0, 3)).toEqual(['pr', 'edit', '4'])
    expect(calls[1]).not.toContain('--body')
    expect(calls[1]).not.toContain('--title')
  })

  test('openDraftPr with a stub gh puts a draft_pr block matching the snapshot', () => {
    const cwd = tempDir('ravenclaw-job-pr-snapshot-')
    initGitRepo(cwd)
    const job = dummyJob(cwd)
    job.baseCommitSha = git(cwd, ['rev-parse', 'HEAD'])
    writeFileSync(join(cwd, 'note.txt'), 'hello\n')
    git(cwd, ['add', 'note.txt'])
    git(cwd, ['commit', '-m', 'note'])
    const message = assistantMessage()
    const out = openDraftPr({
      job,
      cwd,
      title: 'feat: note',
      body: 'adds note',
      gh: () => ({ ok: true, stdout: 'https://github.com/o/r/pull/4\n', stderr: '' }),
      message,
    })
    expect(out.ok).toBe(true)
    const prs = message.blocks.filter((block) => block.type === 'draft_pr')
    expect(prs).toHaveLength(1)
    expect(prs[0]).toEqual({
      type: 'draft_pr',
      title: 'feat: note',
      body: 'adds note',
      url: 'https://github.com/o/r/pull/4',
      sha: out.snapshot?.sha,
      files: out.snapshot?.files,
      plus: out.snapshot?.plus,
      minus: out.snapshot?.minus,
    })
    expect(out.snapshot).toMatchObject({
      title: 'feat: note',
      body: 'adds note',
      url: 'https://github.com/o/r/pull/4',
      files: 1,
      plus: 1,
      minus: 0,
    })
    expect(out.snapshot?.sha).toBe(git(cwd, ['rev-parse', 'HEAD']))
    expect(
      message.blocks.some(
        (block) => block.type === 'text' && block.text === 'Draft PR: https://github.com/o/r/pull/4',
      ),
    ).toBe(true)
  })
})

describe('annotateDraftPr', () => {
  test('stores a draft_pr block whose fields match the snapshot', () => {
    const message = assistantMessage()
    const snapshot = {
      title: 'feat: note',
      body: 'adds note',
      url: 'https://github.com/o/r/pull/4',
      sha: 'deadbeef',
      files: 2,
      plus: 10,
      minus: 3,
    }
    annotateDraftPr(message, snapshot)
    const prs = message.blocks.filter((block) => block.type === 'draft_pr')
    expect(prs).toHaveLength(1)
    expect(prs[0]).toEqual({ type: 'draft_pr', ...snapshot })
    expect(message.blocks).toContainEqual({
      type: 'text',
      text: 'Draft PR: https://github.com/o/r/pull/4',
    })
  })

  test('second annotate on the same message updates the same draft_pr block', () => {
    const message = assistantMessage()
    annotateDraftPr(message, {
      title: 'first',
      body: 'keep?',
      url: 'https://github.com/o/r/pull/4',
      sha: 'aaa',
      files: 1,
      plus: 2,
      minus: 0,
    })
    annotateDraftPr(message, {
      title: 'second',
      body: 'updated',
      url: 'https://github.com/o/r/pull/9',
      sha: 'bbb',
      files: 3,
      plus: 8,
      minus: 1,
    })
    const prs = message.blocks.filter((block) => block.type === 'draft_pr')
    expect(prs).toHaveLength(1)
    expect(prs[0]).toEqual({
      type: 'draft_pr',
      title: 'second',
      body: 'updated',
      url: 'https://github.com/o/r/pull/9',
      sha: 'bbb',
      files: 3,
      plus: 8,
      minus: 1,
    })
    expect(
      message.blocks.filter((block) => block.type === 'text' && block.text.startsWith('Draft PR:')),
    ).toHaveLength(1)
    expect(message.blocks).toContainEqual({
      type: 'text',
      text: 'Draft PR: https://github.com/o/r/pull/9',
    })
  })
})
