import { spawnSync } from 'node:child_process'
import { isAbsolute, relative, extname, resolve } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'

export const LINT_BODY_CAP = 1_000
const LINT_TIMEOUT_MS = 5_000

export type LintStatus = 'ok' | 'error' | 'skipped'

export type LintReport = {
  path: string
  status: LintStatus
  detail: string
}

type Checker = { command: string; args: string[] }

export function lintWrittenFile(absPath: string, cwd: string): LintReport | undefined {
  if (!isInTree(cwd, absPath)) return undefined
  const ext = extname(absPath).toLowerCase()
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return undefined
  if (ext === '.json') return lintJson(absPath)
  const checker = checkerFor(ext, absPath)
  if (!checker) return undefined
  return runChecker(absPath, checker)
}

export function appendLintBlock(result: string, reports: Array<LintReport | undefined>): string {
  const lines = reports.flatMap((report) => (report ? [formatLintLine(report)] : []))
  if (lines.length === 0) return result
  const body = clipLint(lines.join('\n'))
  return `${result}\n\n<lint>\n${body}\n</lint>`
}

function lintJson(absPath: string): LintReport {
  try {
    JSON.parse(readFileSync(absPath, 'utf8'))
    return { path: absPath, status: 'ok', detail: 'ok' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { path: absPath, status: 'error', detail: message }
  }
}

function checkerFor(ext: string, absPath: string): Checker | undefined {
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: 'node', args: ['--check', absPath] }
  }
  if (ext === '.py') return { command: 'python3', args: ['-m', 'py_compile', absPath] }
  if (ext === '.rb') return { command: 'ruby', args: ['-c', absPath] }
  if (ext === '.sh') return { command: 'bash', args: ['-n', absPath] }
  return undefined
}

function runChecker(absPath: string, checker: Checker): LintReport {
  const spawned = spawnSync(checker.command, checker.args, {
    encoding: 'utf8',
    timeout: LINT_TIMEOUT_MS,
  })
  if (spawned.error || spawned.status === null) {
    if (checker.command === 'python3') {
      return runChecker(absPath, { command: 'python', args: checker.args })
    }
    const reason = spawned.error instanceof Error ? spawned.error.message : 'checker failed'
    return { path: absPath, status: 'skipped', detail: reason }
  }
  if (spawned.status === 0) return { path: absPath, status: 'ok', detail: 'ok' }
  const output = [spawned.stderr, spawned.stdout].filter((part) => part && part.trim() !== '').join('\n')
  return { path: absPath, status: 'error', detail: output.trim() || `exit ${spawned.status}` }
}

function formatLintLine(report: LintReport): string {
  const name = report.path.split(/[\\/]/).pop() ?? report.path
  if (report.status === 'ok') return `${name}: ok`
  if (report.status === 'skipped') return `${name}: skipped: ${report.detail}`
  return `${name}: ${report.detail}`
}

function clipLint(text: string): string {
  if (text.length <= LINT_BODY_CAP) return text
  return `${text.slice(0, LINT_BODY_CAP)}…`
}

function isInTree(cwd: string, absPath: string): boolean {
  const rel = relative(tryRealpath(cwd), tryRealpath(absPath))
  if (rel === '' || rel === '.') return false
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function tryRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
