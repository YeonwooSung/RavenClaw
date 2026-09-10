import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { grepTool } from './grep'

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
})
