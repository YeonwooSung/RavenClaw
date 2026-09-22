import type { TerminalBackend, TerminalExecResult } from './terminal-backend'

export const FS_TIMEOUT_MS = 30_000
export const FS_MISSING = '__RC_FS_MISSING__'

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildReadFileBufferScript(path: string): string {
  return `base64 ${shQuote(path)}`
}

export function buildWriteFileScript(path: string): string {
  return `tee -- ${shQuote(path)} >/dev/null`
}

export function buildMkdirScript(path: string): string {
  return `mkdir -p -- ${shQuote(path)}`
}

export function buildUnlinkScript(path: string): string {
  return `rm -f -- ${shQuote(path)}`
}

export function buildStatScript(path: string): string {
  const p = shQuote(path)
  return `if [ ! -e ${p} ]; then
  printf '%s\\n' '${FS_MISSING}'
  exit 0
fi
if [ -d ${p} ]; then kind=dir
elif [ -f ${p} ]; then kind=file
else kind=other
fi
size=0
if [ -f ${p} ]; then size=$(wc -c < ${p} | tr -d ' ')
fi
mtime=0
if mtime=$(date -r ${p} +%s 2>/dev/null); then :; fi
printf 'EXISTS %s %s %s\\n' "$kind" "$size" "$mtime"
`
}

export function buildReaddirScript(path: string): string {
  const p = shQuote(path)
  return `if [ ! -d ${p} ]; then exit 1; fi
find ${p} -maxdepth 1 -mindepth 1 | while IFS= read -r ent; do
  name=$(basename "$ent")
  if [ -d "$ent" ]; then printf 'd %s\\n' "$name"
  elif [ -f "$ent" ]; then printf 'f %s\\n' "$name"
  fi
done
`
}

export async function execSandboxFs(
  backend: TerminalBackend,
  opts: {
    command: string
    cwd: string
    signal: AbortSignal
    stdin?: string | Uint8Array
  },
): Promise<TerminalExecResult> {
  return backend.exec({
    command: opts.command,
    cwd: opts.cwd,
    timeoutMs: FS_TIMEOUT_MS,
    signal: opts.signal,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
