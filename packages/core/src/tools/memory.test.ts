import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_FILE_CHAR_CAP } from '../prompt/memory'
import type { ToolContext, Turn } from '../types'
import { createMemoryTool, memoryFilePath, memoryTool } from './memory'
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
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-memory-tool-'))
  tempDirs.push(root)
  return root
}

function makeTurn(cwd: string, over: Partial<Turn> = {}): Turn {
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
    ...over,
  }
}

function makeCtx(cwd: string, over: Partial<Turn> = {}): ToolContext {
  const turn = makeTurn(cwd, over)
  return { turn, signal: turn.abort.signal, onProgress() {} }
}

function fakeDocker(
  runCommand: (req: TerminalRunRequest) => Promise<{
    stdout: string
    stderr: string
    exitCode: number
  }>,
) {
  return createDockerTerminalBackend({ image: 'bash:5', runCommand })
}

function scriptOf(req: TerminalRunRequest): string {
  return req.args.at(-1) ?? ''
}

function isStatScript(script: string): boolean {
  return script.includes('EXISTS') || script.includes('kind=dir') || script.includes('__RC_FS_MISSING__')
}

function isMkdirScript(script: string): boolean {
  return /\bmkdir\b/.test(script)
}

function isReadScript(script: string): boolean {
  return script.includes('base64')
}

function isWriteScript(script: string): boolean {
  return /\btee\b/.test(script)
}

describe('Memory', () => {
  test('parse requires action, target, and text', () => {
    expect(
      memoryTool.parse({ action: 'add', target: 'agent', text: 'note' }).ok,
    ).toBe(true)
    expect(
      memoryTool.parse({ action: 'replace', target: 'user', text: 'b', match: 'a' }).ok,
    ).toBe(true)
    expect(memoryTool.parse({ action: 'add', target: 'agent' }).ok).toBe(false)
    expect(memoryTool.parse({ action: 'nope', target: 'agent', text: 'x' }).ok).toBe(false)
    expect(memoryTool.parse({ action: 'add', target: 'both', text: 'x' }).ok).toBe(false)
    expect(memoryTool.parse({}).ok).toBe(false)
  })

  test('is leftover-ask and not read-only', async () => {
    expect(memoryTool.name).toBe('Memory')
    expect(memoryTool.isReadOnly({ action: 'add', target: 'agent', text: 'x' })).toBe(false)
    expect(memoryTool.isConcurrencySafe({ action: 'add', target: 'agent', text: 'x' })).toBe(false)
    const decision = await memoryTool.checkPermissions(
      { action: 'add', target: 'agent', text: 'x' },
      makeCtx('/tmp'),
    )
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message).toContain('MEMORY.md')
      expect(decision.saveAs).toBe('session')
    }
  })

  test('add appends a paragraph to MEMORY.md and USER.md', async () => {
    const root = fixtureRoot()
    const agentOut = await memoryTool.execute(
      { action: 'add', target: 'agent', text: 'Prefer bun test.' },
      makeCtx(root),
    )
    expect(agentOut).toContain('MEMORY.md')
    const agentPath = memoryFilePath(root, 'agent')
    expect(readFileSync(agentPath, 'utf8')).toBe('Prefer bun test.\n')

    await memoryTool.execute(
      { action: 'add', target: 'agent', text: 'No silent truncate.' },
      makeCtx(root),
    )
    expect(readFileSync(agentPath, 'utf8')).toBe('Prefer bun test.\n\nNo silent truncate.\n')

    await memoryTool.execute(
      { action: 'add', target: 'user', text: 'User prefers terse diffs.' },
      makeCtx(root),
    )
    expect(readFileSync(memoryFilePath(root, 'user'), 'utf8')).toBe('User prefers terse diffs.\n')
  })

  test('replace and remove use the first exact match', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'alpha\nkeep beta\nalpha\n', 'utf8')

    const replaced = await memoryTool.execute(
      { action: 'replace', target: 'agent', text: 'gamma', match: 'alpha' },
      makeCtx(root),
    )
    expect(replaced).toContain('MEMORY.md')
    expect(readFileSync(path, 'utf8')).toBe('gamma\nkeep beta\nalpha\n')

    const removed = await memoryTool.execute(
      { action: 'remove', target: 'agent', text: '', match: 'keep beta\n' },
      makeCtx(root),
    )
    expect(removed).toContain('MEMORY.md')
    expect(readFileSync(path, 'utf8')).toBe('gamma\nalpha\n')
  })

  test('missing match errors and leaves the file unchanged', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')

    const missing = await memoryTool.execute(
      { action: 'replace', target: 'agent', text: 'x', match: 'nope' },
      makeCtx(root),
    )
    expect(missing).toBe('Memory failed: match not found')
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')

    const noMatch = await memoryTool.execute(
      { action: 'remove', target: 'agent', text: 'x' },
      makeCtx(root),
    )
    expect(noMatch).toBe('Memory failed: match is required for remove')
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
    expect(existsSync(memoryFilePath(root, 'user'))).toBe(false)
  })

  test('cap leaves the file unchanged', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    const original = `${'A'.repeat(100)}\n`
    writeFileSync(path, original, 'utf8')

    const out = await memoryTool.execute(
      { action: 'add', target: 'agent', text: 'B'.repeat(MEMORY_FILE_CHAR_CAP) },
      makeCtx(root),
    )
    expect(out).toContain('8000')
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  test('createMemoryTool without backend still adds MEMORY.md', async () => {
    const root = fixtureRoot()
    const tool = createMemoryTool()
    expect(tool.name).toBe('Memory')
    expect(tool.isConcurrencySafe({ action: 'add', target: 'agent', text: 'x' })).toBe(false)
    expect(tool.isReadOnly({ action: 'add', target: 'agent', text: 'x' })).toBe(false)
    expect(tool.interruptBehavior?.()).toBe('block')
    const out = await tool.execute(
      { action: 'add', target: 'agent', text: 'Prefer bun test.' },
      makeCtx(root),
    )
    expect(out).toContain('MEMORY.md')
    expect(readFileSync(memoryFilePath(root, 'agent'), 'utf8')).toBe('Prefer bun test.\n')
  })

  test('local backend still writes projectCwd when that path is outside cwd', async () => {
    const project = fixtureRoot()
    const worktree = fixtureRoot()
    const out = await memoryTool.execute(
      { action: 'add', target: 'agent', text: 'Prefer bun test.' },
      makeCtx(worktree, { projectCwd: project }),
    )
    expect(out).toContain('MEMORY.md')
    expect(readFileSync(memoryFilePath(project, 'agent'), 'utf8')).toBe('Prefer bun test.\n')
    expect(existsSync(memoryFilePath(worktree, 'agent'))).toBe(false)
  })

  test('does not infer docker from turn.terminalBackend; singleton still host-writes', async () => {
    const root = fixtureRoot()
    const out = await memoryTool.execute(
      { action: 'add', target: 'agent', text: 'host path' },
      makeCtx(root, { terminalBackend: 'docker' }),
    )
    expect(out).toContain('MEMORY.md')
    expect(readFileSync(memoryFilePath(root, 'agent'), 'utf8')).toBe('host path\n')
  })
})

describe('Memory docker backend', () => {
  test('in-tree add/replace/remove go through exec; host writeFileSync is not the write path', async () => {
    const root = fixtureRoot()
    const resolved = memoryFilePath(root, 'agent')
    const original = 'alpha\nkeep beta\nalpha\n'
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(resolved, original, 'utf8')
    const calls: TerminalRunRequest[] = []
    let started = false
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: 'EXISTS file 24 1\n', stderr: '', exitCode: 0 }
      }
      if (isReadScript(script)) {
        return { stdout: Buffer.from(original, 'utf8').toString('base64'), stderr: '', exitCode: 0 }
      }
      if (isMkdirScript(script) || isWriteScript(script)) {
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'unexpected script', exitCode: 1 }
    })
    const start = backend.start
    backend.start = (opts) => {
      started = true
      return start!(opts)
    }
    const out = await createMemoryTool(backend).execute(
      { action: 'replace', target: 'agent', text: 'gamma', match: 'alpha' },
      makeCtx(root),
    )
    expect(out).toContain('MEMORY.md')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(started).toBe(false)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]?.command).toBe('docker')
    expect(calls[0]?.timeoutMs).toBe(30_000)
    expect(calls[0]?.args).toContain('-v')
    expect(calls[0]?.args).toContain(`${root}:${root}`)
    expect(calls[0]?.args).toContain('-w')
    expect(calls[0]?.args).toContain(root)
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM'])
    expect(calls[0]?.env?.ANTHROPIC_API_KEY).toBeUndefined()
    const write = calls.find((req) => isWriteScript(scriptOf(req)))
    expect(write).toBeDefined()
    expect(write?.stdin).toBe('gamma\nkeep beta\nalpha\n')
    expect(JSON.stringify(write?.args)).not.toContain('gamma')
    expect(readFileSync(resolved, 'utf8')).toBe(original)

    const removedCalls: TerminalRunRequest[] = []
    const removeBackend = fakeDocker(async (req) => {
      removedCalls.push(req)
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: 'EXISTS file 24 1\n', stderr: '', exitCode: 0 }
      }
      if (isReadScript(script)) {
        return {
          stdout: Buffer.from('gamma\nkeep beta\nalpha\n', 'utf8').toString('base64'),
          stderr: '',
          exitCode: 0,
        }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const removed = await createMemoryTool(removeBackend).execute(
      { action: 'remove', target: 'agent', text: '', match: 'keep beta\n' },
      makeCtx(root),
    )
    expect(removed).toContain('MEMORY.md')
    const removeWrite = removedCalls.find((req) => isWriteScript(scriptOf(req)))
    expect(removeWrite?.stdin).toBe('gamma\nalpha\n')
    expect(readFileSync(resolved, 'utf8')).toBe(original)
  })

  test('in-tree add of a missing file tees stdin and does not host-write', async () => {
    const root = fixtureRoot()
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: '__RC_FS_MISSING__\n', stderr: '', exitCode: 0 }
      }
      if (isMkdirScript(script) || isWriteScript(script)) {
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'unexpected script', exitCode: 1 }
    })
    const agent = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'Prefer bun test.' },
      makeCtx(root),
    )
    expect(agent).toContain('MEMORY.md')
    expect(existsSync(memoryFilePath(root, 'agent'))).toBe(false)
    const write = calls.find((req) => isWriteScript(scriptOf(req)))
    expect(write?.stdin).toBe('Prefer bun test.\n')

    const userCalls: TerminalRunRequest[] = []
    const userBackend = fakeDocker(async (req) => {
      userCalls.push(req)
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: '__RC_FS_MISSING__\n', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const user = await createMemoryTool(userBackend).execute(
      { action: 'add', target: 'user', text: 'User prefers terse diffs.' },
      makeCtx(root),
    )
    expect(user).toContain('USER.md')
    expect(existsSync(memoryFilePath(root, 'user'))).toBe(false)
    expect(userCalls.find((req) => isWriteScript(scriptOf(req)))?.stdin).toBe(
      'User prefers terse diffs.\n',
    )
  })

  test('outside-cwd on docker is Memory failed: outside workspace, zero exec, host unchanged', async () => {
    const worktree = fixtureRoot()
    const project = fixtureRoot()
    const path = memoryFilePath(project, 'agent')
    mkdirSync(join(project, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'hacked' },
      makeCtx(worktree, { projectCwd: project }),
    )
    expect(calls).toHaveLength(0)
    expect(out).toBe('Memory failed: outside workspace')
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
  })

  test('cap refuse issues no write exec and leaves the host file unchanged', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    const original = `${'A'.repeat(100)}\n`
    writeFileSync(path, original, 'utf8')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: 'EXISTS file 101 1\n', stderr: '', exitCode: 0 }
      }
      if (isReadScript(script)) {
        return { stdout: Buffer.from(original, 'utf8').toString('base64'), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'B'.repeat(MEMORY_FILE_CHAR_CAP) },
      makeCtx(root),
    )
    expect(out).toContain('8000')
    expect(calls.some((req) => isWriteScript(scriptOf(req)))).toBe(false)
    expect(calls.some((req) => req.stdin !== undefined)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  test('match not found issues no write exec and leaves the host file unchanged', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: 'EXISTS file 8 1\n', stderr: '', exitCode: 0 }
      }
      if (isReadScript(script)) {
        return { stdout: Buffer.from('keep me\n', 'utf8').toString('base64'), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const missing = await createMemoryTool(backend).execute(
      { action: 'replace', target: 'agent', text: 'x', match: 'nope' },
      makeCtx(root),
    )
    expect(missing).toBe('Memory failed: match not found')
    expect(calls.some((req) => isWriteScript(scriptOf(req)))).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
  })

  test('no daemon returns Memory failed: and does not host-write', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
      exitCode: 1,
    }))
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'hacked' },
      makeCtx(root),
    )
    expect(out).toMatch(/^Memory failed:/)
    expect(out).toContain('Cannot connect to the Docker daemon')
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
  })

  test('missing base64 returns Memory failed: and does not host-write', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')
    const backend = fakeDocker(async (req) => {
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: 'EXISTS file 8 1\n', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'base64: not found', exitCode: 127 }
    })
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'hacked' },
      makeCtx(root),
    )
    expect(out).toMatch(/^Memory failed:/)
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
  })

  test('tee fail after read leaves the host file unchanged', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')
    const backend = fakeDocker(async (req) => {
      const script = scriptOf(req)
      if (isStatScript(script)) {
        return { stdout: 'EXISTS file 8 1\n', stderr: '', exitCode: 0 }
      }
      if (isReadScript(script)) {
        return { stdout: Buffer.from('keep me\n', 'utf8').toString('base64'), stderr: '', exitCode: 0 }
      }
      if (isMkdirScript(script)) {
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'tee: not found', exitCode: 127 }
    })
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'hacked' },
      makeCtx(root),
    )
    expect(out).toMatch(/^Memory failed:/)
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
  })

  test('30s timeout returns Memory failed: and does not host-write', async () => {
    const root = fixtureRoot()
    const path = memoryFilePath(root, 'agent')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(path, 'keep me\n', 'utf8')
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'timed out',
      exitCode: 124,
    }))
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'hacked' },
      makeCtx(root),
    )
    expect(out).toMatch(/^Memory failed:/)
    expect(readFileSync(path, 'utf8')).toBe('keep me\n')
  })

  test('turn abort throws AbortError and does not stringify Memory failed:', async () => {
    const root = fixtureRoot()
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
    const turn = makeTurn(root)
    const ctx = { turn, signal: ac.signal, onProgress() {} }
    const pending = createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'x' },
      ctx,
    )
    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await pending.catch((error: unknown) => {
      expect(String(error)).not.toMatch(/Memory failed:/)
    })
  })

  test('createTerminalBackend docker without image stays on the host path', async () => {
    const root = fixtureRoot()
    const backend = createTerminalBackend('docker')
    expect(backend.kind).toBe('local')
    const out = await createMemoryTool(backend).execute(
      { action: 'add', target: 'agent', text: 'Prefer bun test.' },
      makeCtx(root),
    )
    expect(out).toContain('MEMORY.md')
    expect(readFileSync(memoryFilePath(root, 'agent'), 'utf8')).toBe('Prefer bun test.\n')
  })

  test('local-kind backend still host-writes after the path is computed', async () => {
    const root = fixtureRoot()
    const out = await createMemoryTool(createLocalTerminalBackend()).execute(
      { action: 'add', target: 'agent', text: 'Prefer bun test.' },
      makeCtx(root),
    )
    expect(out).toContain('MEMORY.md')
    expect(readFileSync(memoryFilePath(root, 'agent'), 'utf8')).toBe('Prefer bun test.\n')
  })
})
