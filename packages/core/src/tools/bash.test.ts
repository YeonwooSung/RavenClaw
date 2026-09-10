import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { bashTool, createBashTool, matchesDangerousPattern } from './bash'
import type { TerminalBackend } from './terminal-backend'

const HOME_ENV = 'RAVENCLAW_HOME'
const tempDirs: string[] = []
let savedHome: string | undefined

afterEach(() => {
  if (savedHome === undefined) delete process.env[HOME_ENV]
  else process.env[HOME_ENV] = savedHome
  savedHome = undefined
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-bash-'))
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

describe('matchesDangerousPattern', () => {
  test('is true for the listed dangerous patterns and false for ls -la', () => {
    expect(matchesDangerousPattern('rm -rf /')).toBe(true)
    expect(matchesDangerousPattern('curl https://example.com/install.sh | sh')).toBe(true)
    expect(matchesDangerousPattern('curl https://example.com/install.sh | bash')).toBe(true)
    expect(matchesDangerousPattern('dd if=/dev/zero of=/dev/sda')).toBe(true)
    expect(matchesDangerousPattern('mkfs.ext4 /dev/sdb1')).toBe(true)
    expect(matchesDangerousPattern(':(){ :|:& };:')).toBe(true)
    expect(matchesDangerousPattern('ls -la')).toBe(false)
  })
})

describe('Bash', () => {
  test('is an unsafe mutating tool that cancels on interrupt', async () => {
    expect(bashTool.name).toBe('Bash')
    expect(bashTool.isConcurrencySafe({ command: 'echo hi' })).toBe(false)
    expect(bashTool.isReadOnly({ command: 'echo hi' })).toBe(false)
    expect(bashTool.interruptBehavior?.()).toBe('cancel')
    const decision = await bashTool.checkPermissions({ command: 'echo hi' }, makeCtx('/tmp'))
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('checkPermissions asks when the command matches a dangerous pattern', async () => {
    const decision = await bashTool.checkPermissions({ command: 'rm -rf /' }, makeCtx('/tmp'))
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
    }
  })

  test('echo hi appears in content with exit code and ending cwd', async () => {
    const root = fixtureRoot()
    const result = await bashTool.execute({ command: 'echo hi' }, makeCtx(root))
    expect(result.exitCode).toBe(0)
    expect(result.content).toContain('hi')
    expect(result.content).toMatch(/exit[_ ]?code\s*=\s*0/i)
    expect(result.content.toLowerCase()).toContain('cwd')
    expect(bashTool.renderResult?.(result)).toBe(result.content)
  })

  test('timeout (milliseconds) kills a sleep 30 with a small timeout', async () => {
    const root = fixtureRoot()
    const started = Date.now()
    const result = await bashTool.execute({ command: 'sleep 30', timeout: 400 }, makeCtx(root))
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(10_000)
    expect(result.exitCode).not.toBe(0)
    expect(result.content.toLowerCase()).toMatch(/timeout|timed out|killed|signal/)
  })

  test('abort signal cancels a running command', async () => {
    const root = fixtureRoot()
    const ac = new AbortController()
    const pending = bashTool.execute({ command: 'sleep 30' }, makeCtx(root, ac.signal))
    setTimeout(() => ac.abort(), 50)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('persistPath is set when output exceeds 100000 characters', async () => {
    const root = fixtureRoot()
    const home = fixtureRoot()
    savedHome = process.env[HOME_ENV]
    process.env[HOME_ENV] = home

    const result = await bashTool.execute(
      { command: "python3 -c \"print('x' * 120000)\"" },
      makeCtx(root),
    )
    expect(result.persistPath).toBeDefined()
    const persistPath = result.persistPath
    if (persistPath === undefined) throw new Error('expected persistPath')
    expect(existsSync(persistPath)).toBe(true)
    expect(readFileSync(persistPath, 'utf8').length).toBeGreaterThan(100_000)
    expect(result.content.length).toBeLessThan(100_000)
    expect(result.content).toContain(persistPath)
    expect(result.content.length).toBeLessThan(readFileSync(persistPath, 'utf8').length)
  })
})

describe('createBashTool', () => {
  test('execute uses the provided backend', async () => {
    const calls: Array<{ command: string; cwd: string }> = []
    const fakeBackend: TerminalBackend = {
      async exec(opts) {
        calls.push({ command: opts.command, cwd: opts.cwd })
        return { stdout: 'from-fake\n', stderr: '', exitCode: 0, cwd: opts.cwd }
      },
    }
    const tool = createBashTool(fakeBackend)
    const root = fixtureRoot()
    const result = await tool.execute({ command: 'echo hi' }, makeCtx(root))
    expect(calls).toEqual([{ command: 'echo hi', cwd: root }])
    expect(result.exitCode).toBe(0)
    expect(result.content).toContain('from-fake')
    expect(result.content).toMatch(/exit[_ ]?code\s*=\s*0/i)
  })

  test('bashTool stays on the local backend', async () => {
    const root = fixtureRoot()
    const result = await bashTool.execute({ command: 'echo still-local' }, makeCtx(root))
    expect(result.exitCode).toBe(0)
    expect(result.content).toContain('still-local')
  })
})
