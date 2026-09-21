import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { createGrepTool, grepTool, isolatedSpawnEnv } from './grep'
import {
  createDockerTerminalBackend,
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
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-grep-'))
  tempDirs.push(root)
  return root
}

function makeTurn(cwd: string): Turn {
  return {
    id: 'turn_1',
    sessionId: 'sess_1',
    messages: [],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd,
    model: 'dummy',
    readFiles: new Set(),
  }
}

function makeCtx(cwd: string): ToolContext {
  const turn = makeTurn(cwd)
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

function fakeDocker(runCommand: (req: TerminalRunRequest) => Promise<{
  stdout: string
  stderr: string
  exitCode: number
}>) {
  return createDockerTerminalBackend({ image: 'bash:5', runCommand })
}

describe('Grep', () => {
  test('is a concurrency-safe read-only tool that allows by mode', async () => {
    expect(grepTool.name).toBe('Grep')
    expect(grepTool.isConcurrencySafe({ pattern: 'x' })).toBe(true)
    expect(grepTool.isReadOnly({ pattern: 'x' })).toBe(true)
    const decision = await grepTool.checkPermissions({ pattern: 'x' }, makeCtx('/tmp'))
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('finds a unique string and skips ignored directories', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'hit.ts'), 'const UNIQUE_RAVEN_TOKEN = 1\n')
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'hidden.ts'), 'const UNIQUE_RAVEN_TOKEN = 2\n')

    const out = await grepTool.execute({ pattern: 'UNIQUE_RAVEN_TOKEN' }, makeCtx(root))
    expect(out).toContain('hit.ts')
    expect(out).toMatch(/UNIQUE_RAVEN_TOKEN/)
    expect(out).not.toContain('node_modules')
  })

  test('caps in-message output at 20k characters', async () => {
    const root = fixtureRoot()
    const line = 'MATCH_TOKEN padding-padding-padding-padding-padding\n'
    writeFileSync(join(root, 'many.txt'), line.repeat(800))

    const out = await grepTool.execute({ pattern: 'MATCH_TOKEN' }, makeCtx(root))
    expect(out.length).toBeLessThanOrEqual(20_000)
    expect(out.toLowerCase()).toContain('truncat')
  })

  test('refuses a path outside cwd', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    ctx.turn.terminalBackend = 'docker'
    const out = await grepTool.execute({ pattern: 'root', path: '/etc' }, ctx)
    expect(String(out).toLowerCase()).toMatch(/outside workspace|denied|protected/)
  })

  test('isolatedSpawnEnv drops foreign git vars and keeps PATH', () => {
    const prevDir = process.env.GIT_DIR
    const prevWorkTree = process.env.GIT_WORK_TREE
    const prevIndex = process.env.GIT_INDEX_FILE
    const prevPrompt = process.env.GIT_TERMINAL_PROMPT
    process.env.GIT_DIR = '/foreign-git-dir'
    process.env.GIT_WORK_TREE = '/foreign-work-tree'
    process.env.GIT_INDEX_FILE = '/foreign-index'
    delete process.env.GIT_TERMINAL_PROMPT
    try {
      const env = isolatedSpawnEnv()
      expect(env.GIT_DIR).toBeUndefined()
      expect(env.GIT_WORK_TREE).toBeUndefined()
      expect(env.GIT_INDEX_FILE).toBeUndefined()
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.PATH).toBe(process.env.PATH)
    } finally {
      if (prevDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = prevDir
      if (prevWorkTree === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = prevWorkTree
      if (prevIndex === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = prevIndex
      if (prevPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT
      else process.env.GIT_TERMINAL_PROMPT = prevPrompt
    }
  })

  test('createGrepTool without backend still finds a unique string', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'hit.ts'), 'const UNIQUE_RAVEN_FACTORY = 1\n')
    const tool = createGrepTool()
    expect(tool.name).toBe('Grep')
    expect(tool.isConcurrencySafe({ pattern: 'x' })).toBe(true)
    expect(tool.isReadOnly({ pattern: 'x' })).toBe(true)
    const out = await tool.execute({ pattern: 'UNIQUE_RAVEN_FACTORY' }, makeCtx(root))
    expect(out).toContain('hit.ts')
    expect(out).toMatch(/UNIQUE_RAVEN_FACTORY/)
  })

  test('local grep still finds a unique string under foreign GIT_DIR', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'hit.ts'), 'const UNIQUE_RAVEN_GITENV = 1\n')
    const prevDir = process.env.GIT_DIR
    const prevWorkTree = process.env.GIT_WORK_TREE
    const prevIndex = process.env.GIT_INDEX_FILE
    process.env.GIT_DIR = join(root, 'not-a-git')
    process.env.GIT_WORK_TREE = join(root, 'not-a-worktree')
    process.env.GIT_INDEX_FILE = join(root, 'not-an-index')
    try {
      const out = await grepTool.execute({ pattern: 'UNIQUE_RAVEN_GITENV' }, makeCtx(root))
      expect(out).toContain('hit.ts')
      expect(out).toMatch(/UNIQUE_RAVEN_GITENV/)
    } finally {
      if (prevDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = prevDir
      if (prevWorkTree === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = prevWorkTree
      if (prevIndex === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = prevIndex
    }
  })
})

describe('Grep docker backend', () => {
  test('one exec on an in-tree path; host rg/walk is not used', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'hit.ts'), 'const HOST_ONLY_GREP_TOKEN = 1\n')
    const calls: TerminalRunRequest[] = []
    let started = false
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: 'FAKE_DOCKER_GREP:1:from-container\n', stderr: '', exitCode: 0 }
    })
    const start = backend.start
    backend.start = (opts) => {
      started = true
      return start!(opts)
    }
    const out = await createGrepTool(backend).execute(
      { pattern: 'HOST_ONLY_GREP_TOKEN' },
      makeCtx(root),
    )
    expect(calls).toHaveLength(1)
    expect(started).toBe(false)
    expect(calls[0]?.command).toBe('docker')
    expect(calls[0]?.args).toContain('-v')
    expect(calls[0]?.args).toContain(`${root}:${root}`)
    expect(calls[0]?.args).toContain('-w')
    expect(calls[0]?.args).toContain(root)
    expect(calls[0]?.timeoutMs).toBe(30_000)
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM'])
    expect(calls[0]?.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(out).toContain('FAKE_DOCKER_GREP')
    expect(out).not.toContain('HOST_ONLY_GREP_TOKEN')
  })

  test('outside-cwd fails at jail stat and does not exec', async () => {
    const root = fixtureRoot()
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: 'should-not-run\n', stderr: '', exitCode: 0 }
    })
    const ctx = makeCtx(root)
    ctx.turn.terminalBackend = 'docker'
    const out = await createGrepTool(backend).execute(
      { pattern: 'root', path: '/etc' },
      ctx,
    )
    expect(calls).toHaveLength(0)
    expect(String(out).toLowerCase()).toMatch(/outside workspace|denied|protected/)
    expect(String(out)).toMatch(/^Grep failed:/)
  })

  test('no daemon returns Grep failed: and does not host-walk', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'hit.ts'), 'const HOST_ONLY_GREP_TOKEN = 1\n')
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
      exitCode: 1,
    }))
    const out = await createGrepTool(backend).execute(
      { pattern: 'HOST_ONLY_GREP_TOKEN' },
      makeCtx(root),
    )
    expect(out).toMatch(/^Grep failed:/)
    expect(out).toContain('Cannot connect to the Docker daemon')
    expect(out).not.toContain('HOST_ONLY_GREP_TOKEN')
  })

  test('missing find returns Grep failed: and does not host-walk', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'hit.ts'), 'const HOST_ONLY_GREP_TOKEN = 1\n')
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'find: not found',
      exitCode: 127,
    }))
    const out = await createGrepTool(backend).execute(
      { pattern: 'HOST_ONLY_GREP_TOKEN' },
      makeCtx(root),
    )
    expect(out).toMatch(/^Grep failed:/)
    expect(out).not.toContain('HOST_ONLY_GREP_TOKEN')
  })

  test('30s timeout returns Grep failed: and does not host-walk', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'hit.ts'), 'const HOST_ONLY_GREP_TOKEN = 1\n')
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'timed out',
      exitCode: 124,
    }))
    const out = await createGrepTool(backend).execute(
      { pattern: 'HOST_ONLY_GREP_TOKEN' },
      makeCtx(root),
    )
    expect(out).toMatch(/^Grep failed:/)
    expect(out).not.toContain('HOST_ONLY_GREP_TOKEN')
  })

  test('turn abort throws AbortError and does not stringify Grep failed:', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'hit.ts'), 'x\n')
    const ac = new AbortController()
    const backend = fakeDocker(async ({ signal }) => {
      return new Promise((_, reject) => {
        const fail = () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal.aborted) {
          fail()
          return
        }
        signal.addEventListener('abort', fail, { once: true })
      })
    })
    const ctx = makeCtx(root)
    const pending = createGrepTool(backend).execute({ pattern: 'x' }, {
      ...ctx,
      signal: ac.signal,
    })
    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await pending.catch((error: unknown) => {
      expect(String(error)).not.toMatch(/Grep failed:/)
    })
  })

  test('createTerminalBackend docker without image stays on the host path', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'hit.ts'), 'const LOCAL_FALLBACK_GREP_TOKEN = 1\n')
    const backend = createTerminalBackend('docker')
    expect(backend.kind).toBe('local')
    const out = await createGrepTool(backend).execute(
      { pattern: 'LOCAL_FALLBACK_GREP_TOKEN' },
      makeCtx(root),
    )
    expect(out).toContain('hit.ts')
    expect(out).toMatch(/LOCAL_FALLBACK_GREP_TOKEN/)
  })

  test('live bash:5 grep finds an in-tree file when docker is ready', async () => {
    const probe = spawnSync('docker', ['image', 'inspect', 'bash:5'], {
      stdio: 'ignore',
      timeout: 2000,
    })
    if (probe.error !== undefined || probe.status !== 0) return
    const root = fixtureRoot()
    writeFileSync(join(root, 'live.ts'), 'const LIVE_DOCKER_GREP_TOKEN = 1\n')
    const backend = createDockerTerminalBackend({ image: 'bash:5' })
    const out = await createGrepTool(backend).execute(
      { pattern: 'LIVE_DOCKER_GREP_TOKEN' },
      makeCtx(root),
    )
    expect(out).toContain('live.ts')
    expect(out).toMatch(/LIVE_DOCKER_GREP_TOKEN/)
  })
})
