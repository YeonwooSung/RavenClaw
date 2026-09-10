import { spawn, spawnSync } from 'node:child_process'

export interface TerminalExecOpts {
  command: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  onOutput?: (text: string) => void
}

export interface TerminalExecResult {
  stdout: string
  stderr: string
  exitCode: number
  cwd: string
}

export interface TerminalBackend {
  exec(opts: TerminalExecOpts): Promise<TerminalExecResult>
}

const DEFAULT_TIMEOUT_MS = 120_000
const KILL_GRACE_MS = 200

export function createLocalTerminalBackend(): TerminalBackend {
  return {
    exec(opts: TerminalExecOpts) {
      return execLocal(opts)
    },
  }
}

function execLocal(opts: TerminalExecOpts): Promise<TerminalExecResult> {
  if (opts.signal.aborted) return Promise.reject(abortError())

  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const marker = `__RAVENCLAW_CWD_${crypto.randomUUID()}__`
  // EXIT trap prints a unique marker + pwd so we can report the ending cwd after `cd`.
  const script = `trap 'printf "%s\\n" "${marker}"; pwd' EXIT\n${opts.command}`

  return new Promise((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const child = spawn('bash', ['-c', script], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      requestKill()
    }, timeoutMs)

    const cleanup = () => {
      opts.signal.removeEventListener('abort', onAbort)
      clearTimeout(timeoutTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
    }

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    const requestKill = () => {
      killTree(child, 'SIGTERM')
      if (killTimer === undefined) {
        killTimer = setTimeout(() => {
          killTree(child, 'SIGKILL')
        }, KILL_GRACE_MS)
      }
    }

    const onAbort = () => {
      requestKill()
    }

    opts.signal.addEventListener('abort', onAbort)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      stdout += text
      opts.onOutput?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      stderr += text
      opts.onOutput?.(text)
    })

    child.on('error', (error) => {
      finish(() => reject(error))
    })

    child.on('exit', (code, signal) => {
      finish(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        if (opts.signal.aborted) {
          reject(abortError())
          return
        }
        const parsed = splitCwdMarker(stdout, marker, opts.cwd)
        const exitCode = timedOut ? 124 : (code ?? (signal ? 128 : 1))
        resolvePromise({
          stdout: parsed.stdout,
          stderr,
          exitCode,
          cwd: parsed.cwd,
        })
      })
    })
  })
}

function splitCwdMarker(
  stdout: string,
  marker: string,
  fallbackCwd: string,
): { stdout: string; cwd: string } {
  const idx = stdout.lastIndexOf(marker)
  if (idx === -1) return { stdout, cwd: fallbackCwd }

  let before = stdout.slice(0, idx)
  if (before.endsWith('\r\n')) before = before.slice(0, -2)
  else if (before.endsWith('\n')) before = before.slice(0, -1)

  const after = stdout.slice(idx + marker.length).replace(/^\r?\n/, '')
  const line = after.split(/\r?\n/)[0]
  const cwd = line !== undefined && line.trim().length > 0 ? line.trim() : fallbackCwd
  return { stdout: before, cwd }
}

function killTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
  signal: NodeJS.Signals,
): void {
  const pid = child.pid
  if (pid !== undefined) {
    const name = signal.startsWith('SIG') ? signal.slice(3) : signal
    spawnSync('pkill', [`-${name}`, '-P', String(pid)], { stdio: 'ignore' })
  }
  try {
    child.kill(signal)
  } catch {
    // already gone
  }
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
