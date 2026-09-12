import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_SERVER_MESSAGE } from '../lsp/client'
import { decidePermission } from '../permissions/pipeline'
import type { ToolContext, Turn } from '../types'
import { createLspTool } from './lsp'

const tempDirs: string[] = []
const emptyRules = { session: [], user: [], project: [] }

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-lsp-tool-'))
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

function writeLspConfig(cwd: string, extensions = ['.ts']): void {
  mkdirSync(join(cwd, '.ravenclaw'), { recursive: true })
  writeFileSync(
    join(cwd, '.ravenclaw', 'lsp.json'),
    `${JSON.stringify({ servers: [{ command: 'fake-ls', extensions }] }, null, 2)}\n`,
    'utf8',
  )
}

describe('createLspTool', () => {
  test('is a concurrency-safe read-only leftover-allow like Read', async () => {
    const tool = createLspTool()
    const input = { operation: 'hover' as const, path: 'a.ts', line: 0 }
    expect(tool.name).toBe('LSP')
    expect(tool.isConcurrencySafe(input)).toBe(true)
    expect(tool.isReadOnly(input)).toBe(true)
    expect(tool.interruptBehavior?.()).toBe('block')
    expect(await tool.checkPermissions(input, makeCtx('/tmp'))).toEqual({
      behavior: 'allow',
      reason: 'mode',
    })

    const dontAsk = await decidePermission({
      name: 'LSP',
      input,
      tool,
      ctx: makeCtx('/tmp'),
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(dontAsk).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('parse requires operation, path, and line', () => {
    const tool = createLspTool()
    expect(tool.parse({ operation: 'hover', path: 'a.ts', line: 0 }).ok).toBe(true)
    expect(tool.parse({ operation: 'definition', path: 'a.ts', line: 1, character: 2 }).ok).toBe(
      true,
    )
    expect(tool.parse({ operation: 'references', path: 'a.ts', line: 0 }).ok).toBe(true)
    expect(tool.parse({ operation: 'rename', path: 'a.ts', line: 0 }).ok).toBe(false)
    expect(tool.parse({ operation: 'hover', path: 'a.ts' }).ok).toBe(false)
    expect(tool.parse({ operation: 'hover', line: 0 }).ok).toBe(false)
    expect(tool.parse({ path: 'a.ts', line: 0 }).ok).toBe(false)
    expect(tool.parse({ operation: 'hover', path: 'a.ts', line: -1 }).ok).toBe(false)
  })

  test('returns no-server when lsp.json is missing or the extension is unknown', async () => {
    const root = fixtureRoot()
    const tool = createLspTool({
      query: async () => 'should not run',
      start() {
        throw new Error('must not start')
      },
    })
    expect(await tool.execute({ operation: 'hover', path: 'a.ts', line: 0 }, makeCtx(root))).toBe(
      NO_SERVER_MESSAGE,
    )

    writeLspConfig(root, ['.ts'])
    expect(await tool.execute({ operation: 'hover', path: 'a.py', line: 0 }, makeCtx(root))).toBe(
      NO_SERVER_MESSAGE,
    )
  })

  test('uses a mock query when a server is configured', async () => {
    const root = fixtureRoot()
    writeLspConfig(root)
    const tool = createLspTool({
      query: async (req) => `ok ${req.operation} ${req.path}:${req.line}:${req.character ?? 0}`,
      start() {
        throw new Error('must not start a language server')
      },
    })
    const out = await tool.execute(
      { operation: 'hover', path: 'src/a.ts', line: 10, character: 3 },
      makeCtx(root),
    )
    expect(out).toBe('ok hover src/a.ts:10:3')
  })

  test('reads lsp.json from projectCwd and sends a real definition request', async () => {
    const project = fixtureRoot()
    const worktree = fixtureRoot()
    mkdirSync(join(project, 'src'), { recursive: true })
    writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n')
    writeLspConfig(project)
    const started: Array<{ command: string; cwd: string }> = []
    const tool = createLspTool({
      query: async (req) => `ok ${req.operation} ${req.path}:${req.line}`,
      start(command, _args, opts) {
        started.push({ command, cwd: opts.cwd })
        throw new Error('query mock should win')
      },
    })
    const out = await tool.execute(
      { operation: 'definition', path: 'src/a.ts', line: 2 },
      makeCtx(worktree, { projectCwd: project }),
    )
    expect(started).toEqual([])
    expect(out).toBe('ok definition src/a.ts:2')
  })

  test('isEnabled is false without lsp.json and true once configured', () => {
    const root = fixtureRoot()
    const tool = createLspTool()
    expect(tool.isEnabled?.(makeCtx(root))).toBe(false)
    writeLspConfig(root)
    expect(tool.isEnabled?.(makeCtx(root))).toBe(true)
  })

  test('isEnabled reads lsp.json from projectCwd', () => {
    const project = fixtureRoot()
    const worktree = fixtureRoot()
    writeLspConfig(project)
    const tool = createLspTool()
    expect(tool.isEnabled?.(makeCtx(worktree))).toBe(false)
    expect(tool.isEnabled?.(makeCtx(worktree, { projectCwd: project }))).toBe(true)
  })

  test('execute refuses when the signal is already aborted', async () => {
    const tool = createLspTool()
    const ac = new AbortController()
    ac.abort()
    const turn = makeTurn('/tmp')
    const ctx: ToolContext = { turn, signal: ac.signal, onProgress() {} }
    await expect(
      tool.execute({ operation: 'hover', path: 'a.ts', line: 0 }, ctx),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
