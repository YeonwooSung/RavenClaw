import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { createListDirTool, listDirTool } from './list-dir'
import {
  createDockerTerminalBackend,
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
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-listdir-'))
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

function makeCtx(cwd: string, signal?: AbortSignal): ToolContext {
  const turn = makeTurn(cwd)
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
  }
}

function fakeDocker(runCommand: (req: TerminalRunRequest) => Promise<{
  stdout: string
  stderr: string
  exitCode: number
}>) {
  return createDockerTerminalBackend({ image: 'bash:5', runCommand })
}

describe('ListDir', () => {
  test('is a concurrency-safe read-only tool that allows by mode', async () => {
    expect(listDirTool.name).toBe('ListDir')
    expect(listDirTool.isConcurrencySafe({})).toBe(true)
    expect(listDirTool.isReadOnly({})).toBe(true)
    expect(listDirTool.interruptBehavior?.()).toBe('cancel')
    const decision = await listDirTool.checkPermissions({}, makeCtx('/tmp'))
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('parse accepts an optional path', () => {
    expect(listDirTool.parse({}).ok).toBe(true)
    expect(listDirTool.parse({ path: 'src' }).ok).toBe(true)
    expect(listDirTool.parse({ path: '' }).ok).toBe(false)
  })

  test('lists dirs first then files, localeCompare, and does not recurse', async () => {
    const root = fixtureRoot()
    mkdirSync(join(root, 'zeta'))
    mkdirSync(join(root, 'alpha'))
    mkdirSync(join(root, 'alpha', 'nested'))
    writeFileSync(join(root, 'alpha', 'hidden.txt'), 'x\n')
    writeFileSync(join(root, 'b.txt'), 'x\n')
    writeFileSync(join(root, 'a.txt'), 'x\n')

    const out = await listDirTool.execute({}, makeCtx(root))
    expect(out).toBe(['dir   alpha', 'dir   zeta', 'file  a.txt', 'file  b.txt'].join('\n'))
    expect(out).not.toContain('nested')
    expect(out).not.toContain('hidden.txt')
  })

  test('resolves a relative path against the turn cwd', async () => {
    const root = fixtureRoot()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'main.ts'), 'x\n')
    const out = await listDirTool.execute({ path: 'src' }, makeCtx(root))
    expect(out).toBe('file  main.ts')
  })

  test('returns ListDir failed when the path is missing', async () => {
    const root = fixtureRoot()
    const out = await listDirTool.execute({ path: 'nope' }, makeCtx(root))
    expect(out.startsWith('ListDir failed:')).toBe(true)
  })

  test('caps at 500 entries then appends a truncation note', async () => {
    const root = fixtureRoot()
    for (let i = 0; i < 510; i++) {
      writeFileSync(join(root, `f${String(i).padStart(4, '0')}.txt`), 'x\n')
    }
    const out = await listDirTool.execute({}, makeCtx(root))
    const lines = out.split('\n')
    expect(lines[lines.length - 1]).toBe('... [truncated]')
    expect(lines.length).toBe(501)
  })

  test('execute refuses when the signal is already aborted', async () => {
    const root = fixtureRoot()
    const ac = new AbortController()
    ac.abort()
    await expect(listDirTool.execute({}, makeCtx(root, ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  test('lists a symlink as a file even when it is neither file nor dir', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'target.txt'), 'x\n')
    symlinkSync('target.txt', join(root, 'link'))
    mkdirSync(join(root, 'subdir'))
    symlinkSync('subdir', join(root, 'dirlink'))
    const out = await listDirTool.execute({}, makeCtx(root))
    expect(out).toBe(
      ['dir   subdir', 'file  dirlink', 'file  link', 'file  target.txt'].join('\n'),
    )
  })

  test('refuses a path outside cwd', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    ctx.turn.terminalBackend = 'docker'
    const out = await listDirTool.execute({ path: '/etc' }, ctx)
    expect(String(out).toLowerCase()).toMatch(/outside workspace|denied|protected/)
  })

  test('createListDirTool without backend still lists a unique file', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'hello factory\n')
    const tool = createListDirTool()
    expect(tool.name).toBe('ListDir')
    expect(tool).not.toBe(listDirTool)
    const out = await tool.execute({}, makeCtx(root))
    expect(out).toContain('note.txt')
  })
})

describe('ListDir docker backend', () => {
  test('docker readdir uses fake listing not host names', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'host-only.txt'), 'x')
    mkdirSync(join(root, 'host-dir'))
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: 'd from-container-dir\nf from-container.txt\n', stderr: '', exitCode: 0 }
    })
    const out = await createListDirTool(backend).execute({ path: '.' }, makeCtx(root))
    expect(out).toContain('dir   from-container-dir')
    expect(out).toContain('file  from-container.txt')
    expect(out).not.toContain('host-only.txt')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.timeoutMs).toBe(30_000)
  })

  test('exec fail is ListDir failed: ; abort throws AbortError', async () => {
    const root = fixtureRoot()
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
      exitCode: 1,
    }))
    const out = await createListDirTool(backend).execute({}, makeCtx(root))
    expect(out).toMatch(/^ListDir failed:/)
    const ac = new AbortController()
    ac.abort()
    await expect(
      createListDirTool(fakeDocker(async () => ({ stdout: '', stderr: '', exitCode: 0 }))).execute(
        {},
        makeCtx(root, ac.signal),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('outside-cwd does not exec', async () => {
    const root = fixtureRoot()
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: 'nope', stderr: '', exitCode: 0 }
    })
    const out = await createListDirTool(backend).execute({ path: '/etc' }, makeCtx(root))
    expect(calls).toHaveLength(0)
    expect(out).toMatch(/^ListDir failed:/)
  })

  test('garbage readdir stdout is ListDir failed:', async () => {
    const root = fixtureRoot()
    const backend = fakeDocker(async () => ({
      stdout: 'not-a-listing\ntruncated junk',
      stderr: '',
      exitCode: 0,
    }))
    const out = await createListDirTool(backend).execute({}, makeCtx(root))
    expect(out).toMatch(/^ListDir failed:/)
    expect(out).toMatch(/failed to parse readdir/)
  })

  test('empty readdir stdout with find stderr is ListDir failed:', async () => {
    const root = fixtureRoot()
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'find: Permission denied',
      exitCode: 0,
    }))
    const out = await createListDirTool(backend).execute({}, makeCtx(root))
    expect(out).toMatch(/^ListDir failed:/)
    expect(out).toMatch(/Permission denied/)
  })
})
