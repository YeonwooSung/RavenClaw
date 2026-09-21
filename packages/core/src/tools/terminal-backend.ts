import { spawn, spawnSync } from 'node:child_process'

export interface TerminalExecOpts {
  command: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  onOutput?: (text: string) => void
  stdin?: string | Uint8Array
}

export interface TerminalExecResult {
  stdout: string
  stderr: string
  exitCode: number
  cwd: string
}

export interface TerminalJob {
  kill(): void
  wait(): Promise<TerminalExecResult>
}

export interface TerminalBackend {
  readonly kind?: TerminalBackendKind
  exec(opts: TerminalExecOpts): Promise<TerminalExecResult>
  start?(opts: TerminalExecOpts): TerminalJob
}

export interface TerminalRunRequest {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal: AbortSignal
  onOutput?: (text: string) => void
  stdin?: string | Uint8Array
}

export type TerminalRunCommand = (
  req: TerminalRunRequest,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

export interface DockerTerminalBackendOpts {
  image: string
  extraArgs?: string[]
  runCommand?: TerminalRunCommand
  killCommand?: (name: string) => void
}

export type TerminalBackendKind = 'local' | 'docker'

const DEFAULT_TIMEOUT_MS = 120_000
const KILL_GRACE_MS = 200
const DOCKER_ENV_KEYS = ['PATH', 'HOME', 'TERM', 'LANG'] as const
const DOCKER_ENV_FALLBACKS: Record<(typeof DOCKER_ENV_KEYS)[number], string> = {
  PATH: '/usr/bin:/bin',
  HOME: '/tmp',
  TERM: 'xterm',
  LANG: 'C.UTF-8',
}

export function createLocalTerminalBackend(): TerminalBackend {
  return {
    kind: 'local',
    exec(opts: TerminalExecOpts) {
      return execLocal(opts)
    },
    start(opts: TerminalExecOpts) {
      return startLocal(opts)
    },
  }
}

export function createDockerTerminalBackend(opts: DockerTerminalBackendOpts): TerminalBackend {
  return {
    kind: 'docker',
    exec(execOpts: TerminalExecOpts) {
      return execDocker(execOpts, opts)
    },
    start(execOpts: TerminalExecOpts) {
      return startDocker(execOpts, opts)
    },
  }
}

export function createTerminalBackend(
  kind: TerminalBackendKind,
  opts?: { image?: string; extraArgs?: string[] },
): TerminalBackend {
  if (kind === 'docker' && opts?.image) {
    return createDockerTerminalBackend({ image: opts.image, extraArgs: opts.extraArgs })
  }
  return createLocalTerminalBackend()
}

function execLocal(opts: TerminalExecOpts): Promise<TerminalExecResult> {
  if (opts.signal.aborted) return Promise.reject(abortError())

  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const marker = cwdMarker()
  const script = wrapCwdMarkerScript(opts.command, marker)

  return runSpawned(
    {
      command: 'bash',
      args: ['-c', script],
      cwd: opts.cwd,
      env: process.env,
      timeoutMs,
      signal: opts.signal,
      onOutput: opts.onOutput,
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    },
    { spawnError: 'reject', marker, fallbackCwd: opts.cwd },
  )
}

function startLocal(opts: TerminalExecOpts): TerminalJob {
  const marker = cwdMarker()
  const script = wrapCwdMarkerScript(opts.command, marker)
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 0
  const controller = new AbortController()
  const wait = runSpawned(
    {
      command: 'bash',
      args: ['-c', script],
      cwd: opts.cwd,
      env: process.env,
      timeoutMs,
      signal: controller.signal,
      onOutput: opts.onOutput,
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    },
    { spawnError: 'result', marker, fallbackCwd: opts.cwd },
  )
  return {
    kill() {
      controller.abort()
    },
    wait() {
      return wait
    },
  }
}

function dockerRunRequest(
  opts: TerminalExecOpts,
  docker: DockerTerminalBackendOpts,
  timeoutMs: number,
  marker: string,
  name?: string,
): TerminalRunRequest {
  const script = wrapCwdMarkerScript(opts.command, marker)
  const extraArgs = docker.extraArgs ?? []
  const args = ['run', '--rm', '-i']
  if (name !== undefined) args.push('--name', name)
  args.push('-v', `${opts.cwd}:${opts.cwd}`, '-w', opts.cwd, ...extraArgs, docker.image, 'bash', '-c', script)
  return {
    command: 'docker',
    args,
    cwd: opts.cwd,
    env: dockerAllowlistEnv(),
    timeoutMs,
    signal: opts.signal,
    onOutput: opts.onOutput,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  }
}

async function execDocker(
  opts: TerminalExecOpts,
  docker: DockerTerminalBackendOpts,
): Promise<TerminalExecResult> {
  if (opts.signal.aborted) return Promise.reject(abortError())

  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const marker = cwdMarker()
  const req = dockerRunRequest(opts, docker, timeoutMs, marker)

  try {
    if (docker.runCommand) {
      const ran = await docker.runCommand(req)
      if (opts.signal.aborted) return Promise.reject(abortError())
      const parsed = splitCwdMarker(ran.stdout, marker, opts.cwd)
      return {
        stdout: parsed.stdout,
        stderr: ran.stderr,
        exitCode: ran.exitCode,
        cwd: parsed.cwd,
      }
    }
    return await runSpawned(req, { spawnError: 'result', marker, fallbackCwd: opts.cwd })
  } catch (error) {
    if (opts.signal.aborted || isAbortError(error)) return Promise.reject(abortError())
    return {
      stdout: '',
      stderr: errorMessage(error),
      exitCode: 1,
      cwd: opts.cwd,
    }
  }
}

function startDocker(opts: TerminalExecOpts, docker: DockerTerminalBackendOpts): TerminalJob {
  const marker = cwdMarker()
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 0
  const controller = new AbortController()
  const name = `rc-job-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const req = dockerRunRequest(
    { ...opts, signal: controller.signal },
    docker,
    timeoutMs,
    marker,
    name,
  )
  const sweep = () => {
    if (docker.killCommand) return
    try {
      const child = spawn('docker', ['rm', '-f', name], { stdio: 'ignore', detached: true })
      child.unref()
    } catch {
      // already gone
    }
  }
  const wait = runDockerJob(req, docker, marker, opts.cwd, controller.signal, sweep)
  return {
    kill() {
      try {
        if (docker.killCommand) docker.killCommand(name)
        else sweep()
      } catch {
        // already gone
      }
      controller.abort()
    },
    wait() {
      return wait
    },
  }
}

async function runDockerJob(
  req: TerminalRunRequest,
  docker: DockerTerminalBackendOpts,
  marker: string,
  fallbackCwd: string,
  signal: AbortSignal,
  sweep: () => void,
): Promise<TerminalExecResult> {
  try {
    if (docker.runCommand) {
      const ran = await docker.runCommand(req)
      if (signal.aborted) throw abortError()
      const parsed = splitCwdMarker(ran.stdout, marker, fallbackCwd)
      return {
        stdout: parsed.stdout,
        stderr: ran.stderr,
        exitCode: ran.exitCode,
        cwd: parsed.cwd,
      }
    }
    return await runSpawned(req, { spawnError: 'result', marker, fallbackCwd })
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError()
    return {
      stdout: '',
      stderr: errorMessage(error),
      exitCode: 1,
      cwd: fallbackCwd,
    }
  } finally {
    if (signal.aborted) sweep()
  }
}

function runSpawned(
  req: TerminalRunRequest,
  opts: {
    spawnError: 'reject' | 'result'
    marker: string
    fallbackCwd: string
  },
): Promise<TerminalExecResult> {
  return new Promise((resolvePromise, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: req.env,
      stdio: [req.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    if (req.stdin !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(typeof req.stdin === 'string' ? req.stdin : Buffer.from(req.stdin))
    }

    const timeoutTimer =
      req.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            requestKill()
          }, req.timeoutMs)
        : undefined

    const cleanup = () => {
      req.signal.removeEventListener('abort', onAbort)
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
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

    req.signal.addEventListener('abort', onAbort)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      stdout += text
      req.onOutput?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      stderr += text
      req.onOutput?.(text)
    })

    child.on('error', (error) => {
      finish(() => {
        if (req.signal.aborted) {
          reject(abortError())
          return
        }
        if (opts.spawnError === 'result') {
          resolvePromise({
            stdout: '',
            stderr: errorMessage(error),
            exitCode: 127,
            cwd: opts.fallbackCwd,
          })
          return
        }
        reject(error)
      })
    })

    child.on('exit', (code, signal) => {
      finish(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        if (req.signal.aborted) {
          reject(abortError())
          return
        }
        const parsed = splitCwdMarker(stdout, opts.marker, opts.fallbackCwd)
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

function cwdMarker(): string {
  return `__RAVENCLAW_CWD_${crypto.randomUUID()}__`
}

function wrapCwdMarkerScript(command: string, marker: string): string {
  // EXIT trap prints a unique marker + pwd so we can report the ending cwd after `cd`.
  return `trap 'printf "%s\\n" "${marker}"; pwd' EXIT\n${command}`
}

function dockerAllowlistEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of DOCKER_ENV_KEYS) {
    const value = process.env[key]
    env[key] = value && value !== '' ? value : DOCKER_ENV_FALLBACKS[key]
  }
  return env
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
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
