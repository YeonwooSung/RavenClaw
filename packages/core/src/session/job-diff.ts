import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runGit } from '../tools/session-worktree'
import type { SessionJob } from '../types'

export type JobDiffOp = 'create' | 'update' | 'delete' | 'rename'
export type JobDiffFile = { path: string; op: JobDiffOp; plus: number; minus: number; from?: string }
export type JobDiff = {
  ok: true
  baseCommitSha: string
  shadowBranch: string
  head: string
  dirty: boolean
  files: JobDiffFile[]
}

export function jobDiff(job: SessionJob): JobDiff | { ok: false; notice: string } {
  const cwd = job.worktreePath

  const headResult = runGit(cwd, ['rev-parse', 'HEAD'])
  if (!headResult.ok) return fail(headResult)

  const statusResult = runGit(cwd, ['status', '--porcelain'])
  if (!statusResult.ok) return fail(statusResult)

  const committedName = runGit(cwd, [
    'diff',
    '--name-status',
    '--find-renames',
    job.baseCommitSha,
    'HEAD',
  ])
  if (!committedName.ok) return fail(committedName)

  const committedNum = runGit(cwd, [
    'diff',
    '--numstat',
    '--find-renames',
    job.baseCommitSha,
    'HEAD',
  ])
  if (!committedNum.ok) return fail(committedNum)

  // Worktree vs HEAD already includes staged + unstaged; do not also add --cached.
  const dirtyName = runGit(cwd, ['diff', '--name-status', 'HEAD'])
  if (!dirtyName.ok) return fail(dirtyName)

  const dirtyNum = runGit(cwd, ['diff', '--numstat', 'HEAD'])
  if (!dirtyNum.ok) return fail(dirtyNum)

  const untracked = runGit(cwd, ['ls-files', '--others', '--exclude-standard'])
  if (!untracked.ok) return fail(untracked)

  const stats = new Map<string, { plus: number; minus: number }>()
  mergeNumstat(stats, committedNum.stdout)
  mergeNumstat(stats, dirtyNum.stdout)

  const byPath = new Map<string, JobDiffFile>()

  for (const row of parseNameStatus(committedName.stdout)) {
    byPath.set(row.path, fileRow(row, statFor(stats, row)))
    if (row.from !== undefined) byPath.delete(row.from)
  }

  for (const row of parseNameStatus(dirtyName.stdout)) {
    const existing = byPath.get(row.path)
    const stat = statFor(stats, row)
    if (existing) {
      existing.plus = stat.plus
      existing.minus = stat.minus
      if (row.op === 'rename') {
        existing.op = 'rename'
        if (row.from !== undefined) existing.from = row.from
      }
      if (row.from !== undefined) byPath.delete(row.from)
      continue
    }
    // Only dirty: prefer name-status op (incl. rename/delete); untracked handled below.
    byPath.set(row.path, fileRow(row, stat))
    if (row.from !== undefined) byPath.delete(row.from)
  }

  for (const line of untracked.stdout.split('\n')) {
    const path = line.trim()
    if (path === '' || byPath.has(path)) continue
    const stat = stats.get(path) ?? countFileLines(cwd, path)
    byPath.set(path, { path, op: 'create', plus: stat.plus, minus: stat.minus })
  }

  return {
    ok: true,
    baseCommitSha: job.baseCommitSha,
    shadowBranch: job.shadowBranch,
    head: headResult.stdout.trim(),
    dirty: statusResult.stdout.trim() !== '',
    files: [...byPath.values()],
  }
}

function statFor(
  stats: Map<string, { plus: number; minus: number }>,
  row: { path: string; from?: string },
): { plus: number; minus: number } {
  const dest = stats.get(row.path)
  if (dest !== undefined && dest.plus + dest.minus > 0) return dest
  if (row.from !== undefined) {
    const from = stats.get(row.from)
    if (from !== undefined) return from
  }
  return dest ?? { plus: 0, minus: 0 }
}

function fileRow(
  row: { op: JobDiffOp; path: string; from?: string },
  stat: { plus: number; minus: number },
): JobDiffFile {
  const out: JobDiffFile = { path: row.path, op: row.op, plus: stat.plus, minus: stat.minus }
  if (row.from !== undefined) out.from = row.from
  return out
}

function fail(result: { stderr: string; stdout: string }): { ok: false; notice: string } {
  const notice = result.stderr.trim() || result.stdout.trim() || 'git failed'
  return { ok: false, notice }
}

function parseNameStatus(stdout: string): Array<{ op: JobDiffOp; path: string; from?: string }> {
  const rows: Array<{ op: JobDiffOp; path: string; from?: string }> = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const parts = line.split('\t')
    const code = parts[0]?.[0]
    if (code === 'A') rows.push({ op: 'create', path: parts[1] ?? '' })
    else if (code === 'D') rows.push({ op: 'delete', path: parts[1] ?? '' })
    else if (code === 'R') rows.push({ op: 'rename', from: parts[1], path: parts[2] ?? '' })
    else rows.push({ op: 'update', path: parts[1] ?? '' })
  }
  return rows
}

function mergeNumstat(map: Map<string, { plus: number; minus: number }>, stdout: string): void {
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const plusRaw = parts[0] ?? '0'
    const minusRaw = parts[1] ?? '0'
    const rawPath = parts.length >= 4 ? (parts[3] ?? '') : (parts[2] ?? '')
    const arrow = rawPath.indexOf(' => ')
    const path = arrow >= 0 ? rawPath.slice(arrow + 4) : rawPath
    if (path === '') continue
    const plus = plusRaw === '-' ? 0 : Number(plusRaw) || 0
    const minus = minusRaw === '-' ? 0 : Number(minusRaw) || 0
    const prev = map.get(path)
    if (prev) {
      prev.plus += plus
      prev.minus += minus
    } else {
      map.set(path, { plus, minus })
    }
  }
}

function countFileLines(cwd: string, rel: string): { plus: number; minus: number } {
  try {
    const text = readFileSync(join(cwd, rel), 'utf8')
    if (text === '') return { plus: 0, minus: 0 }
    const n = text.endsWith('\n') ? text.slice(0, -1).split('\n').length : text.split('\n').length
    return { plus: n, minus: 0 }
  } catch {
    return { plus: 0, minus: 0 }
  }
}
