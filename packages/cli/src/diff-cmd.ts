import { spawnSync } from 'node:child_process'
import { jobDiff, type JobDiff, type SessionJob } from '@ravenclaw/core'

const CAP = 20_000
const GIT_TIMEOUT_MS = 30_000
const NOT_A_REPO = 'not a git repository'
const DEFAULT_HUNK_LINES = 40

export type GitDiffFile = {
  path: string
  staged: boolean
  unstaged: boolean
  patch: string
}

export type GitDiffView =
  | { kind: 'not-repo' }
  | { kind: 'clean' }
  | { kind: 'files'; files: GitDiffFile[] }

export type SessionDiffPanel =
  | { kind: 'cwd'; view: GitDiffView }
  | { kind: 'job'; lines: string[] }

export type DiffArg =
  | { action: 'toggle' }
  | { action: 'close' }
  | { action: 'select'; index: number }
  | { action: 'error'; message: string }

export function parseDiffArg(raw: string | undefined): DiffArg {
  if (raw === undefined || raw.trim() === '') return { action: 'toggle' }
  const arg = raw.trim().toLowerCase()
  if (arg === 'close') return { action: 'close' }
  if (/^\d+$/.test(arg)) {
    const n = Number(arg)
    if (n < 1) return { action: 'error', message: 'usage: /diff [n|close]' }
    return { action: 'select', index: n - 1 }
  }
  return { action: 'error', message: 'usage: /diff [n|close]' }
}

export function loadGitDiff(cwd: string): GitDiffView {
  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') return { kind: 'not-repo' }

  const unstaged = parseUnifiedDiff(
    runGit(cwd, ['diff', '--no-color', '--no-ext-diff']).stdout,
    'unstaged',
  )
  const staged = parseUnifiedDiff(
    runGit(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff']).stdout,
    'staged',
  )
  const files = mergeDiffFiles(unstaged, staged)
  return files.length === 0 ? { kind: 'clean' } : { kind: 'files', files }
}

/** Job sessions → jobDiff panel lines; otherwise cwd uncommitted+staged. */
export function loadSessionDiff(
  session: { job?: SessionJob },
  cwd: string,
): SessionDiffPanel {
  if (session.job) {
    return { kind: 'job', lines: formatJobDiffPanel(jobDiff(session.job)) }
  }
  return { kind: 'cwd', view: loadGitDiff(cwd) }
}

export function formatJobDiffPanel(
  diff: JobDiff | { ok: false; notice: string },
): string[] {
  if (!diff.ok) return [diff.notice]
  const dirty = diff.dirty ? ' dirty' : ''
  const noun = diff.files.length === 1 ? 'file' : 'files'
  const lines = [`job diff  ${diff.shadowBranch}  ${diff.files.length} ${noun}${dirty}`]
  if (diff.files.length === 0) {
    lines.push('  no changes')
    return lines
  }
  for (const file of diff.files) {
    const from = file.from !== undefined ? `  from ${file.from}` : ''
    lines.push(`  ${file.path}  ${file.op}  +${file.plus} -${file.minus}${from}`)
  }
  return lines
}

export function formatGitDiff(cwd: string): string {
  const view = loadGitDiff(cwd)
  if (view.kind === 'not-repo') return NOT_A_REPO
  if (view.kind === 'clean') return ''
  const text = view.files.map((file) => file.patch).join('')
  return text.length > CAP ? text.slice(0, CAP) : text
}

export function formatDiffPanel(
  view: GitDiffView,
  selected = 0,
  maxHunkLines = DEFAULT_HUNK_LINES,
): string[] {
  if (view.kind === 'not-repo') return [NOT_A_REPO]
  if (view.kind === 'clean') return ['no uncommitted changes']
  const idx = clamp(selected, 0, view.files.length - 1)
  const noun = view.files.length === 1 ? 'file' : 'files'
  const lines = [`diff  ${view.files.length} ${noun}`]
  for (let i = 0; i < view.files.length; i++) {
    const file = view.files[i]
    if (!file) continue
    const mark = i === idx ? '>' : ' '
    lines.push(`${mark} ${file.path}  ${fileLabel(file)}`)
  }
  const file = view.files[idx]
  if (!file) return lines
  const hunks = file.patch.replace(/\n$/, '').split('\n')
  const body =
    hunks.length > maxHunkLines
      ? [...hunks.slice(0, maxHunkLines), `… ${hunks.length - maxHunkLines} more`]
      : hunks
  lines.push(...body)
  return lines
}

export function parseUnifiedDiff(text: string, side: 'staged' | 'unstaged'): GitDiffFile[] {
  if (text.trim() === '') return []
  const chunks = text.split(/(?=^diff --git )/m)
  const files: GitDiffFile[] = []
  for (const chunk of chunks) {
    if (!chunk.startsWith('diff --git ')) continue
    const path = pathFromGitDiffHeader(chunk)
    if (path === undefined) continue
    files.push({
      path,
      staged: side === 'staged',
      unstaged: side === 'unstaged',
      patch: chunk.endsWith('\n') ? chunk : `${chunk}\n`,
    })
  }
  return files
}

export function mergeDiffFiles(unstaged: GitDiffFile[], staged: GitDiffFile[]): GitDiffFile[] {
  const byPath = new Map<string, GitDiffFile>()
  for (const file of unstaged) {
    byPath.set(file.path, { ...file })
  }
  for (const file of staged) {
    const existing = byPath.get(file.path)
    if (!existing) {
      byPath.set(file.path, { ...file })
      continue
    }
    existing.staged = true
    existing.patch = `${existing.patch}${file.patch}`
  }
  return [...byPath.values()]
}

function pathFromGitDiffHeader(chunk: string): string | undefined {
  const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk)
  if (plus?.[1]) return plus[1]
  const minus = /^--- a\/(.+)$/m.exec(chunk)
  if (minus?.[1]) return minus[1]
  const header = /^diff --git a\/(.+) b\/(.+)$/m.exec(chunk)
  if (header?.[2] && header[2] !== '/dev/null') return header[2]
  return header?.[1]
}

function fileLabel(file: GitDiffFile): string {
  if (file.staged && file.unstaged) return 'staged+unstaged'
  if (file.staged) return 'staged'
  return 'unstaged'
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { ok: result.status === 0, stdout: result.stdout ?? '' }
  } catch {
    return { ok: false, stdout: '' }
  }
}
