import { spawnSync } from 'node:child_process'

const CAP = 20_000
const GIT_TIMEOUT_MS = 30_000
const NOT_A_REPO = 'not a git repository'

export function formatGitDiff(cwd: string): string {
  const inside = runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') return NOT_A_REPO

  const unstaged = runGit(cwd, ['diff', '--no-color', '--no-ext-diff'])
  const staged = runGit(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff'])
  const parts = [unstaged.stdout, staged.stdout].filter((part) => part.length > 0)
  const text = parts.join(parts.length === 2 && !unstaged.stdout.endsWith('\n') ? '\n' : '')
  return text.length > CAP ? text.slice(0, CAP) : text
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
