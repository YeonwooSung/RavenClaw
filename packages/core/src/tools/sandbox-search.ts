import type { TerminalBackend, TerminalExecResult } from './terminal-backend'

export const SEARCH_TIMEOUT_MS = 30_000

export interface SandboxSearchOpts {
  kind: 'grep' | 'glob'
  cwd: string
  searchRoot: string
  pattern: string
  fileFilter?: string
  ignoreDirNames: readonly string[]
  maxFiles: number
  maxDepth: number
  signal: AbortSignal
}

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildSandboxSearchScript(opts: SandboxSearchOpts): string {
  const cwd = shQuote(opts.cwd)
  const root = shQuote(opts.searchRoot)
  const prune = opts.ignoreDirNames.map((name) => `-name ${shQuote(name)}`).join(' -o ')
  const findPrint = `find ${root} -maxdepth ${opts.maxDepth} \\( ${prune} \\) -prune -o -type f -print`
  if (opts.kind === 'glob') {
    return `cd ${cwd} || exit 1\n${findPrint} 2>/dev/null | head -n ${opts.maxFiles}\n`
  }
  const pattern = shQuote(opts.pattern)
  const rgIgnore = opts.ignoreDirNames
    .flatMap((dir) => [`--glob ${shQuote(`!${dir}`)}`, `--glob ${shQuote(`!${dir}/**`)}`])
    .join(' ')
  const rgFilter = opts.fileFilter !== undefined ? `--glob ${shQuote(opts.fileFilter)}` : ''
  return `cd ${cwd} || exit 1
if command -v rg >/dev/null 2>&1; then
  rg --no-heading --line-number --color=never --no-config ${rgIgnore} ${rgFilter} -- ${pattern} ${root}
  exit $?
fi
${findPrint} 2>/dev/null | head -n ${opts.maxFiles} | while IFS= read -r f; do
  grep -n -H -E -I -- ${pattern} "$f" 2>/dev/null
done
`
}

export async function execSandboxSearch(
  backend: TerminalBackend,
  opts: SandboxSearchOpts,
): Promise<TerminalExecResult> {
  return backend.exec({
    command: buildSandboxSearchScript(opts),
    cwd: opts.cwd,
    timeoutMs: SEARCH_TIMEOUT_MS,
    signal: opts.signal,
  })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
