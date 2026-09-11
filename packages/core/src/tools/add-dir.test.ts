import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeDir } from '../permissions/directories'
import { decidePermission } from '../permissions/pipeline'
import type { ToolContext, Turn } from '../types'
import { addDirTool } from './add-dir'

const emptyRules = { session: [], user: [], project: [] }
const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-add-dir-'))
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

describe('AddDir', () => {
  test('is an unsafe mutating tool that leftover-asks and blocks interrupt', async () => {
    expect(addDirTool.name).toBe('AddDir')
    expect(addDirTool.isConcurrencySafe({ path: '/tmp' })).toBe(false)
    expect(addDirTool.isReadOnly({ path: '/tmp' })).toBe(false)
    expect(addDirTool.interruptBehavior?.()).toBe('block')
    const decision = await addDirTool.checkPermissions({ path: '/tmp' }, makeCtx('/tmp'))
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }
  })

  test('default mode leftover ask stays ask', async () => {
    const decision = await decidePermission({
      name: 'AddDir',
      input: { path: '/tmp' },
      tool: addDirTool,
      ctx: makeCtx('/tmp'),
      mode: 'default',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('ask')
  })

  test('parse requires a path string', () => {
    expect(addDirTool.parse({ path: 'src' }).ok).toBe(true)
    expect(addDirTool.parse({}).ok).toBe(false)
    expect(addDirTool.parse({ path: '' }).ok).toBe(false)
  })

  test('creates additionalDirectories and pushes the resolved dir', async () => {
    const cwd = fixtureRoot()
    const extra = fixtureRoot()
    mkdirSync(join(extra, 'lib'))
    const extraReal = normalizeDir(cwd, extra)
    const ctx = makeCtx(cwd)
    expect(ctx.turn.additionalDirectories).toBeUndefined()

    const out = await addDirTool.execute({ path: extra }, ctx)
    expect(out).toBe(`added directory ${extraReal}`)
    expect(ctx.turn.additionalDirectories).toEqual([extraReal])

    const again = await addDirTool.execute({ path: extra }, ctx)
    expect(again).toBe(`added directory ${extraReal}`)
    expect(ctx.turn.additionalDirectories).toEqual([extraReal])
  })

  test('resolves a relative path against the turn cwd', async () => {
    const cwd = fixtureRoot()
    mkdirSync(join(cwd, 'vendor'))
    const vendor = normalizeDir(cwd, 'vendor')
    const ctx = makeCtx(cwd)
    const out = await addDirTool.execute({ path: 'vendor' }, ctx)
    expect(out).toBe(`added directory ${vendor}`)
    expect(ctx.turn.additionalDirectories).toEqual([vendor])
  })

  test('returns AddDir failed when the path is not a directory', async () => {
    const cwd = fixtureRoot()
    writeFileSync(join(cwd, 'note.txt'), 'x\n')
    const ctx = makeCtx(cwd)
    const file = await addDirTool.execute({ path: 'note.txt' }, ctx)
    expect(file.startsWith('AddDir failed:')).toBe(true)
    expect(ctx.turn.additionalDirectories).toBeUndefined()

    const missing = await addDirTool.execute({ path: 'nope' }, ctx)
    expect(missing.startsWith('AddDir failed:')).toBe(true)
    expect(ctx.turn.additionalDirectories).toBeUndefined()
  })

  test('execute refuses when the signal is already aborted', async () => {
    const cwd = fixtureRoot()
    const ac = new AbortController()
    ac.abort()
    await expect(addDirTool.execute({ path: cwd }, makeCtx(cwd, ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
