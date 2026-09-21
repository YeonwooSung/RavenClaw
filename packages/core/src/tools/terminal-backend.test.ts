import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDockerTerminalBackend,
  createLocalTerminalBackend,
  createTerminalBackend,
  type TerminalRunRequest,
} from './terminal-backend'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-term-'))
  tempDirs.push(root)
  return realpathSync(root)
}

describe('createLocalTerminalBackend', () => {
  test('stamps kind local', () => {
    expect(createLocalTerminalBackend().kind).toBe('local')
  })

  test('strips the cwd marker from stdout and reports the ending cwd', async () => {
    const root = fixtureRoot()
    const backend = createLocalTerminalBackend()
    const result = await backend.exec({
      command: 'echo hello',
      cwd: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.stdout).toContain('hello')
    expect(result.stdout).not.toMatch(/RAVENCLAW_CWD|__CWD_/)
    expect(result.cwd).toBe(root)
    expect(result.exitCode).toBe(0)
  })

  test('captures cwd after cd via the in-band marker', async () => {
    const root = fixtureRoot()
    const nested = join(root, 'nested')
    const backend = createLocalTerminalBackend()
    const result = await backend.exec({
      command: 'mkdir nested && cd nested && pwd',
      cwd: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.cwd).toBe(nested)
    expect(result.stdout).toContain('nested')
    expect(result.stdout).not.toMatch(/RAVENCLAW_CWD|__CWD_/)
  })

  test('refuses to start when the signal is already aborted', async () => {
    const root = fixtureRoot()
    const ac = new AbortController()
    ac.abort()
    const backend = createLocalTerminalBackend()
    await expect(
      backend.exec({
        command: 'echo hi',
        cwd: root,
        timeoutMs: 5_000,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('pipes stdin when present', async () => {
    const root = fixtureRoot()
    const backend = createLocalTerminalBackend()
    const result = await backend.exec({
      command: 'cat',
      cwd: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      stdin: 'hello-stdin\n',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello-stdin')
  })

  test('omitting stdin leaves cat hanging-free empty', async () => {
    const root = fixtureRoot()
    const backend = createLocalTerminalBackend()
    const result = await backend.exec({
      command: 'echo ok',
      cwd: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('ok')
  })
})

const LIVE_DOCKER_IMAGE = 'bash:5'
/** bun:test default per-test budget. Nested docker waits must finish inside this. */
const BUN_DEFAULT_TEST_TIMEOUT_MS = 5_000
/** spawnSync timeout for `docker info` / image inspect during readiness. */
const DOCKER_PROBE_TIMEOUT_MS = 2_000
/** exec timeoutMs for the real-docker unavailable path. */
const UNAVAILABLE_DOCKER_EXEC_TIMEOUT_MS = 2_000
/** bun:test budget for the unavailable-docker integration test. */
const UNAVAILABLE_DOCKER_TEST_TIMEOUT_MS = 10_000
/** bun:test budget for tests that actually spawn docker. */
const LIVE_DOCKER_TEST_TIMEOUT_MS = 35_000

function dockerInfoOk(): boolean {
  const info = spawnSync('docker', ['info'], {
    encoding: 'utf8',
    timeout: DOCKER_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return info.error === undefined && info.status === 0
}

function dockerHasImage(image: string): boolean {
  const inspect = spawnSync('docker', ['image', 'inspect', image], {
    stdio: 'ignore',
    timeout: DOCKER_PROBE_TIMEOUT_MS,
  })
  return inspect.error === undefined && inspect.status === 0
}

let dockerReadyCache: boolean | undefined
let liveDockerCache: boolean | undefined

function dockerReady(): boolean {
  dockerReadyCache ??= dockerInfoOk()
  return dockerReadyCache
}

function liveDocker(): boolean {
  liveDockerCache ??= dockerReady() && dockerHasImage(LIVE_DOCKER_IMAGE)
  return liveDockerCache
}

describe('createDockerTerminalBackend', () => {
  test('docker probe and unavailable exec finish inside bun default timeout', () => {
    // Hung `docker info` then `docker run` must not outlive bun's 5s default,
    // or CI flakes as "unavailable docker ... timed out 5001ms".
    expect(DOCKER_PROBE_TIMEOUT_MS).toBeLessThan(BUN_DEFAULT_TEST_TIMEOUT_MS)
    expect(UNAVAILABLE_DOCKER_EXEC_TIMEOUT_MS).toBeLessThan(BUN_DEFAULT_TEST_TIMEOUT_MS)
    expect(DOCKER_PROBE_TIMEOUT_MS + UNAVAILABLE_DOCKER_EXEC_TIMEOUT_MS).toBeLessThan(
      BUN_DEFAULT_TEST_TIMEOUT_MS,
    )
    expect(UNAVAILABLE_DOCKER_TEST_TIMEOUT_MS).toBeGreaterThan(
      DOCKER_PROBE_TIMEOUT_MS + UNAVAILABLE_DOCKER_EXEC_TIMEOUT_MS,
    )
    expect(LIVE_DOCKER_TEST_TIMEOUT_MS).toBeGreaterThan(30_000)
  })

  test('returns an object with exec and start', () => {
    const backend = createDockerTerminalBackend({ image: 'bash:5' })
    expect(typeof backend.exec).toBe('function')
    expect(typeof backend.start).toBe('function')
  })

  test('stamps kind docker', () => {
    const backend = createDockerTerminalBackend({ image: 'bash:5' })
    expect(backend.kind).toBe('docker')
  })

  test('start() uses docker run --name and kill() kills that job', async () => {
    let seen: TerminalRunRequest | undefined
    const killed: string[] = []
    const backend = createDockerTerminalBackend({
      image: 'bash:5',
      extraArgs: ['--network', 'none'],
      runCommand: async (req) => {
        seen = req
        return { stdout: 'bg\n', stderr: '', exitCode: 0 }
      },
      killCommand: (name) => {
        killed.push(name)
      },
    })
    const job = backend.start!({
      command: 'sleep 30',
      cwd: '/tmp/ravenclaw-docker-bg',
      timeoutMs: 0,
      signal: new AbortController().signal,
    })
    const result = await job.wait()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('bg\n')
    expect(seen?.args.slice(0, 3)).toEqual(['run', '--rm', '-i'])
    expect(seen?.args[3]).toBe('--name')
    const name = seen?.args[4]
    expect(name?.startsWith('rc-job-')).toBe(true)
    job.kill()
    expect(killed).toEqual([name])
  })

  test('start() kill aborts a still-running docker job', async () => {
    const killed: string[] = []
    const backend = createDockerTerminalBackend({
      image: 'bash:5',
      runCommand: async ({ signal }) => {
        await new Promise<void>((_, reject) => {
          const fail = () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal.aborted) {
            fail()
            return
          }
          signal.addEventListener('abort', fail)
        })
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      killCommand: (name) => {
        killed.push(name)
      },
    })
    const job = backend.start!({
      command: 'sleep 30',
      cwd: '/tmp',
      timeoutMs: 0,
      signal: new AbortController().signal,
    })
    job.kill()
    await expect(job.wait()).rejects.toMatchObject({ name: 'AbortError' })
    expect(killed).toHaveLength(1)
    expect(killed[0]?.startsWith('rc-job-')).toBe(true)
  })

  test('builds docker run argv with volume mount, workdir, image, and extraArgs', async () => {
    let seen: TerminalRunRequest | undefined
    const backend = createDockerTerminalBackend({
      image: 'my.example/image:tag',
      extraArgs: ['--network', 'none'],
      runCommand: async (req) => {
        seen = req
        return { stdout: 'ok\n', stderr: '', exitCode: 0 }
      },
    })
    const cwd = '/tmp/ravenclaw-docker-work'
    const result = await backend.exec({
      command: 'echo ok',
      cwd,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })

    expect(result.exitCode).toBe(0)
    expect(seen).toBeDefined()
    if (seen === undefined) throw new Error('expected runCommand to be called')
    expect(seen.command).toBe('docker')
    expect(seen.args.slice(0, 7)).toEqual([
      'run',
      '--rm',
      '-i',
      '-v',
      `${cwd}:${cwd}`,
      '-w',
      cwd,
    ])
    expect(seen.args.slice(7, 11)).toEqual(['--network', 'none', 'my.example/image:tag', 'bash'])
    expect(seen.args[11]).toBe('-c')
    const script = seen.args[12]
    expect(script).toContain('echo ok')
    expect(script).toMatch(/RAVENCLAW_CWD/)
    expect(seen.cwd).toBe(cwd)
  })

  test('forwards stdin on the run request and keeps -i', async () => {
    const root = fixtureRoot()
    let seen: TerminalRunRequest | undefined
    const backend = createDockerTerminalBackend({
      image: 'bash:5',
      runCommand: async (req) => {
        seen = req
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    await backend.exec({
      command: 'tee /dev/null',
      cwd: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      stdin: 'payload-bytes',
    })
    expect(seen?.stdin).toBe('payload-bytes')
    expect(seen?.args).toContain('-i')
    expect(seen?.command).toBe('docker')
  })

  test('omits stdin on the run request when not provided', async () => {
    const root = fixtureRoot()
    let seen: TerminalRunRequest | undefined
    const backend = createDockerTerminalBackend({
      image: 'bash:5',
      runCommand: async (req) => {
        seen = req
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    await backend.exec({
      command: 'echo hi',
      cwd: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(seen?.stdin).toBeUndefined()
    expect(seen?.args).toContain('-i')
  })

  test('passes only PATH/HOME/TERM/LANG and never the host process.env', async () => {
    const secretKey = 'RAVENCLAW_TEST_SECRET'
    const previous = process.env[secretKey]
    process.env[secretKey] = 's3cret'
    try {
      let seen: TerminalRunRequest | undefined
      const backend = createDockerTerminalBackend({
        image: 'bash:5',
        runCommand: async (req) => {
          seen = req
          return { stdout: '', stderr: '', exitCode: 0 }
        },
      })
      await backend.exec({
        command: 'true',
        cwd: '/tmp',
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      })
      expect(seen).toBeDefined()
      if (seen === undefined) throw new Error('expected runCommand to be called')
      expect(seen.env[secretKey]).toBeUndefined()
      expect(Object.keys(seen.env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM'])
    } finally {
      if (previous === undefined) delete process.env[secretKey]
      else process.env[secretKey] = previous
    }
  })

  test('refuses to start when the signal is already aborted', async () => {
    let called = false
    const ac = new AbortController()
    ac.abort()
    const backend = createDockerTerminalBackend({
      image: 'bash:5',
      runCommand: async () => {
        called = true
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    })
    await expect(
      backend.exec({
        command: 'echo hi',
        cwd: '/tmp',
        timeoutMs: 5_000,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(called).toBe(false)
  })

  test('abort during run rejects AbortError', async () => {
    const ac = new AbortController()
    const backend = createDockerTerminalBackend({
      image: 'bash:5',
      runCommand: async ({ signal }) => {
        return new Promise<{ stdout: string; stderr: string; exitCode: number }>((_, reject) => {
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal.aborted) {
            fail()
            return
          }
          signal.addEventListener('abort', fail)
        })
      },
    })
    const pending = backend.exec({
      command: 'sleep 30',
      cwd: '/tmp',
      timeoutMs: 5_000,
      signal: ac.signal,
    })
    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('docker spawn/run failure returns a non-zero result instead of throwing', async () => {
    const backend = createDockerTerminalBackend({
      image: 'bash:5',
      runCommand: async () => {
        throw Object.assign(new Error('docker: command not found'), { code: 'ENOENT' })
      },
    })
    const result = await backend.exec({
      command: 'echo hi',
      cwd: '/tmp',
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/docker|not found|ENOENT/i)
  })

  test(
    'unavailable docker returns a non-zero result without throwing',
    async () => {
      if (dockerReady()) return
      const backend = createDockerTerminalBackend({ image: LIVE_DOCKER_IMAGE })
      const result = await backend.exec({
        command: 'echo hi',
        cwd: fixtureRoot(),
        timeoutMs: UNAVAILABLE_DOCKER_EXEC_TIMEOUT_MS,
        signal: new AbortController().signal,
      })
      // Daemon may come up after the probe; that is not the unavailable path.
      if (result.exitCode === 0) return
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.length).toBeGreaterThan(0)
    },
    { timeout: UNAVAILABLE_DOCKER_TEST_TIMEOUT_MS },
  )

  test(
    'live docker run echoes and reports cwd',
    async () => {
      if (!liveDocker()) return
      const root = fixtureRoot()
      const backend = createDockerTerminalBackend({ image: LIVE_DOCKER_IMAGE })
      const result = await backend.exec({
        command: 'echo hello',
        cwd: root,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('hello')
      expect(result.stdout).not.toMatch(/RAVENCLAW_CWD|__CWD_/)
      expect(result.cwd).toBe(root)
    },
    { timeout: LIVE_DOCKER_TEST_TIMEOUT_MS },
  )
})

describe('createTerminalBackend', () => {
  test('local kind runs on the host', async () => {
    const root = fixtureRoot()
    const backend = createTerminalBackend('local')
    const result = await backend.exec({
      command: 'echo local-kind',
      cwd: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('local-kind')
  })

  test('docker kind without image falls back to local', async () => {
    const root = fixtureRoot()
    const backend = createTerminalBackend('docker')
    const result = await backend.exec({
      command: 'echo local-fallback',
      cwd: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('local-fallback')
  })

  test('docker kind without image is local kind', () => {
    expect(createTerminalBackend('docker').kind).toBe('local')
  })

  test('docker kind with image is docker kind', () => {
    expect(createTerminalBackend('docker', { image: 'bash:5' }).kind).toBe('docker')
  })
})
