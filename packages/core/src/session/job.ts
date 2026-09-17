import { spawnSync } from 'node:child_process'
import { runGit } from '../tools/session-worktree'
import type { Message, SessionJob, SessionRecord, TodoItem } from '../types'

export type DraftPrSnapshot = {
  title: string
  body: string
  url?: string
  sha: string
  files: number
  plus: number
  minus: number
}

export type GhRunner = (
  args: string[],
  cwd: string,
) => { ok: boolean; stdout: string; stderr: string }

export function openDraftPr(opts: {
  job: SessionJob
  cwd: string
  title?: string
  body?: string
  gh?: GhRunner
  message?: Extract<Message, { role: 'assistant' }>
}): {
  ok: boolean
  notice: string
  snapshot?: DraftPrSnapshot
  job?: SessionJob
} {
  const job = opts.job
  if (job == null) return { ok: false, notice: 'no job record' }

  const cwd = opts.cwd
  const status = runGit(cwd, ['status', '--porcelain'])
  if (!status.ok || status.stdout.trim() !== '') {
    return { ok: false, notice: 'worktree is dirty' }
  }

  const suppliedTitle = opts.title !== undefined ? opts.title.trim() : undefined
  const suppliedBody = opts.body
  const title = suppliedTitle || `raven: ${job.shadowBranch}`
  const body = suppliedBody ?? ''
  const gh = opts.gh ?? defaultGh
  const args =
    job.prNumber !== undefined
      ? [
          'pr',
          'edit',
          String(job.prNumber),
          ...(suppliedTitle !== undefined && suppliedTitle !== '' ? ['--title', suppliedTitle] : []),
          ...(suppliedBody !== undefined ? ['--body', suppliedBody] : []),
        ]
      : [
          'pr',
          'create',
          '--draft',
          '--base',
          job.baseBranch,
          '--head',
          job.shadowBranch,
          '--title',
          title,
          '--body',
          body,
        ]

  let result: { ok: boolean; stdout: string; stderr: string }
  try {
    result = gh(args, cwd)
  } catch {
    return { ok: false, notice: 'gh missing' }
  }
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || 'gh missing'
    return { ok: false, notice: isGhMissing(detail) ? 'gh missing' : detail }
  }

  const parsed = parsePrRef(`${result.stdout}\n${result.stderr}`)
  const url = parsed.url ?? job.prUrl
  const prNumber = parsed.number ?? job.prNumber
  if (url !== undefined) job.prUrl = url
  if (prNumber !== undefined) job.prNumber = prNumber

  const sha = runGit(cwd, ['rev-parse', 'HEAD']).stdout.trim()
  const stat = diffStat(cwd, job.baseCommitSha)
  const snapshot: DraftPrSnapshot = {
    title,
    body,
    sha,
    files: stat.files,
    plus: stat.plus,
    minus: stat.minus,
  }
  if (url !== undefined) snapshot.url = url
  if (opts.message) annotateDraftPr(opts.message, snapshot)

  return {
    ok: true,
    notice: url !== undefined ? `draft PR ${url}` : 'draft PR opened',
    snapshot,
    job,
  }
}

export function annotateDraftPr(
  message: Extract<Message, { role: 'assistant' }>,
  snapshot: DraftPrSnapshot,
): void {
  const line = snapshot.url !== undefined ? `Draft PR: ${snapshot.url}` : `Draft PR: ${snapshot.title}`
  message.blocks.push({ type: 'text', text: line })
}

export function lastAssistantForPr(
  messages: Message[],
): Extract<Message, { role: 'assistant' }> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'assistant') return message
  }
  return undefined
}

export async function applySessionDraftPr(opts: {
  job: SessionJob
  cwd: string
  title?: string
  body?: string
  gh?: GhRunner
  sessionId: string
  loadMessages?: () => Promise<Message[]>
  persistAssistant?: (
    sessionId: string,
    message: Extract<Message, { role: 'assistant' }>,
  ) => Promise<void>
  persistToolCalls?: (
    sessionId: string,
    message: Extract<Message, { role: 'assistant' }>,
  ) => Promise<void>
}): Promise<ReturnType<typeof openDraftPr>> {
  let message: Extract<Message, { role: 'assistant' }> | undefined
  try {
    message = lastAssistantForPr((await opts.loadMessages?.()) ?? [])
  } catch {
    message = undefined
  }
  const out = openDraftPr({
    job: opts.job,
    cwd: opts.cwd,
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.gh ? { gh: opts.gh } : {}),
    ...(message ? { message } : {}),
  })
  if (out.ok && message) {
    try {
      if (message.blocks.some((block) => block.type === 'tool_use')) {
        await opts.persistToolCalls?.(opts.sessionId, message)
      } else {
        await opts.persistAssistant?.(opts.sessionId, message)
      }
    } catch {
      // annotation persist must not fail /pr
    }
  }
  return out
}

function defaultGh(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 30_000 })
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { ok: false, stdout: '', stderr: 'gh missing' }
      return { ok: false, stdout: result.stdout ?? '', stderr: result.error.message }
    }
    return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch {
    return { ok: false, stdout: '', stderr: 'gh missing' }
  }
}

function isGhMissing(detail: string): boolean {
  return detail === 'gh missing' || detail.includes('ENOENT') || /not found/i.test(detail)
}

function parsePrRef(text: string): { url?: string; number?: number } {
  const match = /https?:\/\/\S+\/pull\/(\d+)/.exec(text)
  if (!match || match[1] === undefined) return {}
  return { url: match[0].replace(/[)\].,]+$/, ''), number: Number(match[1]) }
}

function diffStat(cwd: string, fromSha: string): { files: number; plus: number; minus: number } {
  const result = runGit(cwd, ['diff', '--numstat', fromSha, 'HEAD'])
  if (!result.ok) return { files: 0, plus: 0, minus: 0 }
  let files = 0
  let plus = 0
  let minus = 0
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue
    const [added, removed] = line.split('\t')
    files += 1
    if (added !== undefined && added !== '-') plus += Number(added) || 0
    if (removed !== undefined && removed !== '-') minus += Number(removed) || 0
  }
  return { files, plus, minus }
}

export function stampCheckpoint(
  message: Extract<Message, { role: 'assistant' }>,
  job: SessionJob,
  todos: TodoItem[] | undefined,
  cwd?: string,
): void {
  const gitCwd = job.worktreePath || cwd
  if (!gitCwd) return
  const head = runGit(gitCwd, ['rev-parse', 'HEAD'])
  const commitSha = head.stdout.trim()
  if (!head.ok || commitSha === '') return
  const status = runGit(gitCwd, ['status', '--porcelain'])
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
  cwd?: string
}): { committed: boolean; sha?: string; notice?: string } {
  const cwd = opts.job.worktreePath || opts.cwd
  if (!cwd) return { committed: false, notice: 'job commit failed: no worktree' }
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
