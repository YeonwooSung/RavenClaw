import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_FILE_CHAR_CAP } from '../prompt/memory'
import type { ToolContext, Turn } from '../types'
import { memoryFilePath, memoryTool } from './memory'

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
})
