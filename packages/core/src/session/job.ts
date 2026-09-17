import { runGit } from '../tools/session-worktree'
import type { Message, SessionJob, SessionRecord, TodoItem } from '../types'

export function stampCheckpoint(
  message: Extract<Message, { role: 'assistant' }>,
  _job: SessionJob,
  todos: TodoItem[] | undefined,
  cwd: string,
): void {
  const head = runGit(cwd, ['rev-parse', 'HEAD'])
  const commitSha = head.stdout.trim()
  if (!head.ok || commitSha === '') return
  const status = runGit(cwd, ['status', '--porcelain'])
  message.checkpoint = {
    commitSha,
    todoSnapshot: (todos ?? []).map((item) => ({ ...item })),
    dirty: !status.ok || status.stdout.trim() !== '',
  }
}

export function setJobAutoCommit(session: SessionRecord, on: boolean): void {
  session.jobAutoCommit = on
}

export function maybeCommitJob(opts: {
  job: SessionJob
  turnId: string
  cwd: string
}): { committed: boolean; sha?: string; notice?: string } {
  const cwd = opts.cwd
  const status = runGit(cwd, ['status', '--porcelain'])
  if (!status.ok) return fail(status, 'git status failed')
  if (status.stdout.trim() === '') return { committed: false }

  const add = runGit(cwd, ['add', '-A'])
  if (!add.ok) return fail(add, 'git add failed')

  const commit = runGit(cwd, ['commit', '-m', `raven: turn ${opts.turnId.slice(0, 8)}`])
  if (!commit.ok) return fail(commit, 'git commit failed')

  const head = runGit(cwd, ['rev-parse', 'HEAD'])
  const sha = head.stdout.trim()
  if (!head.ok || sha === '') return fail(head, 'rev-parse HEAD failed')
  return { committed: true, sha }
}

function fail(
  result: { stdout: string; stderr: string },
  fallback: string,
): { committed: false; notice: string } {
  const detail = result.stderr.trim() || result.stdout.trim() || fallback
  return { committed: false, notice: `job commit failed: ${detail}` }
}
