import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { decidePermission } from '../permissions/pipeline'
import { writeTool } from './write'

const emptyRules = { session: [], user: [], project: [] }

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-write-'))
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

describe('Write', () => {
  test('is an unsafe mutating tool that leftover-asks and blocks interrupt', async () => {
    expect(writeTool.name).toBe('Write')
    expect(writeTool.isConcurrencySafe({ path: 'a.txt', content: 'x' })).toBe(false)
    expect(writeTool.isReadOnly({ path: 'a.txt', content: 'x' })).toBe(false)
    expect(writeTool.interruptBehavior?.()).toBe('block')
    const decision = await writeTool.checkPermissions(
      { path: 'a.txt', content: 'x' },
      makeCtx('/tmp'),
    )
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }
  })

  test('default mode leftover ask stays ask', async () => {
    const decision = await decidePermission({
      name: 'Write',
      input: { path: 'a.txt', content: 'x' },
      tool: writeTool,
      ctx: makeCtx('/tmp'),
      mode: 'default',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }
  })

  test('dontAsk allows in-tree leftover Write', async () => {
    const decision = await decidePermission({
      name: 'Write',
      input: { path: 'a.txt', content: 'x' },
      tool: writeTool,
      ctx: makeCtx('/tmp'),
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('allow')
  })

  test('creates a new file including parent directories', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    const out = await writeTool.execute({ path: 'src/new.txt', content: 'created\n' }, ctx)
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(readFileSync(join(root, 'src', 'new.txt'), 'utf8')).toBe('created\n')
  })

  test('overwrites an existing file', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.txt'), 'old\n')
    const ctx = makeCtx(root)
    const out = await writeTool.execute({ path: 'a.txt', content: 'new\n' }, ctx)
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new\n')
  })

  test('hard-denies /etc/shadow without writing', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    const out = await writeTool.execute({ path: '/etc/shadow', content: 'nope\n' }, ctx)
    expect(out.toLowerCase()).toMatch(/deny|denied|protected|refused|not allowed|shadow/)
    expect(existsSync(join(root, 'shadow'))).toBe(false)
  })

  test('execute refuses when the signal is already aborted', async () => {
    const root = fixtureRoot()
    const ac = new AbortController()
    ac.abort()
    const ctx = makeCtx(root, ac.signal)
    await expect(
      writeTool.execute({ path: 'a.txt', content: 'x\n' }, ctx),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
  })

  test('appends a lint block after a successful json write without rolling back', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    const out = await writeTool.execute({ path: 'bad.json', content: '{' }, ctx)
    expect(out.startsWith('Wrote bad.json')).toBe(true)
    expect(out).toContain('<lint>')
    expect(out.toLowerCase()).toContain('error')
    expect(readFileSync(join(root, 'bad.json'), 'utf8')).toBe('{')
  })
})
