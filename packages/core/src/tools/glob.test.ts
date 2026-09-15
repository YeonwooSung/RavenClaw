import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { globTool } from './glob'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-glob-'))
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

function resultLines(out: string): string[] {
  return out.split('\n').filter((line) => line.length > 0 && !/truncat/i.test(line))
}

describe('Glob', () => {
  test('is a concurrency-safe read-only tool that allows by mode', async () => {
    expect(globTool.name).toBe('Glob')
    expect(globTool.isConcurrencySafe({ pattern: '**/*.ts' })).toBe(true)
    expect(globTool.isReadOnly({ pattern: '**/*.ts' })).toBe(true)
    const decision = await globTool.checkPermissions({ pattern: '**/*.ts' }, makeCtx('/tmp'))
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('matches **/*.ts style globs and ignores node_modules', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeFileSync(join(root, 'b.js'), 'x\n')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'c.ts'), 'x\n')
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'hidden.ts'), 'x\n')

    const out = await globTool.execute({ pattern: '**/*.ts' }, makeCtx(root))
    const lines = resultLines(out)
    expect(lines).toContain('a.ts')
    expect(lines).toContain('src/c.ts')
    expect(lines.some((line) => line.includes('node_modules'))).toBe(false)
    expect(lines).not.toContain('b.js')
  })

  test('walk bounds skip ignored dirs and depth beyond 20', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'top.ts'), 'x\n')
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'built.ts'), 'x\n')

    let deep = root
    for (let i = 0; i < 21; i++) {
      deep = join(deep, `d${i}`)
      mkdirSync(deep)
    }
    writeFileSync(join(deep, 'deep.ts'), 'x\n')

    const out = await globTool.execute({ pattern: '**/*.ts' }, makeCtx(root))
    const lines = resultLines(out)
    expect(lines).toContain('top.ts')
    expect(lines.some((line) => line.includes('dist'))).toBe(false)
    expect(lines.some((line) => line.includes('deep.ts'))).toBe(false)
  })

  test('refuses a path outside cwd', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    ctx.turn.terminalBackend = 'docker'
    const out = await globTool.execute({ pattern: '*', path: '/etc' }, ctx)
    expect(String(out).toLowerCase()).toMatch(/outside workspace|denied|protected/)
  })
})
