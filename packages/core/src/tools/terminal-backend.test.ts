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
})

const LIVE_DOCKER_IMAGE = 'bash:5'

function dockerInfoOk(): boolean {
  const info = spawnSync('docker', ['info'], {
    encoding: 'utf8',
    timeout: 8_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return info.error === undefined && info.status === 0
}

function dockerHasImage(image: string): boolean {
  const inspect = spawnSync('docker', ['image', 'inspect', image], {
    stdio: 'ignore',
    timeout: 5_000,
  })
  return inspect.error === undefined && inspect.status === 0
}

const dockerReady = dockerInfoOk()
const liveDocker = dockerReady && dockerHasImage(LIVE_DOCKER_IMAGE)

describe('createDockerTerminalBackend', () => {
  test('returns an object with exec', () => {
    const backend = createDockerTerminalBackend({ image: 'bash:5' })
    expect(typeof backend.exec).toBe('function')
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

  test.skipIf(dockerReady)(
    'unavailable docker returns a non-zero result without throwing',
    async () => {
      const backend = createDockerTerminalBackend({ image: LIVE_DOCKER_IMAGE })
      const result = await backend.exec({
        command: 'echo hi',
        cwd: fixtureRoot(),
        timeoutMs: 8_000,
        signal: new AbortController().signal,
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.length).toBeGreaterThan(0)
    },
  )

  test.skipIf(!liveDocker)('live docker run echoes and reports cwd', async () => {
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
  })
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
})
