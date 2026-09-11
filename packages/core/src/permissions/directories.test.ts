import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionDecision, Tool, ToolContext, Turn } from '../types'
import { addDirectory, isPathInAnyRoot, normalizeDir } from './directories'
import { isInTreePath } from './modes'
import { decidePermission } from './pipeline'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(root)
  return root
}

describe('normalizeDir', () => {
  test('resolves a relative path against cwd', () => {
    const cwd = fixtureRoot('ravenclaw-norm-cwd-')
    mkdirSync(join(cwd, 'src'))
    expect(normalizeDir(cwd, 'src')).toBe(realpathSync(join(cwd, 'src')))
  })

  test('follows a symlink to the real directory', () => {
    const cwd = fixtureRoot('ravenclaw-norm-cwd-')
    const target = fixtureRoot('ravenclaw-norm-tgt-')
    mkdirSync(join(target, 'inner'))
    symlinkSync(target, join(cwd, 'link'))
    expect(normalizeDir(cwd, 'link/inner')).toBe(realpathSync(join(target, 'inner')))
  })
})

describe('addDirectory', () => {
  test('appends a real directory and refuses files or missing paths', () => {
    const cwd = fixtureRoot('ravenclaw-adddir-')
    const extra = fixtureRoot('ravenclaw-adddir-extra-')
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'note.txt'), 'x\n')
    const extraReal = normalizeDir(cwd, extra)
    const srcReal = normalizeDir(cwd, 'src')

    const added = addDirectory([], cwd, extra)
    expect(added.ok).toBe(true)
    if (added.ok) expect(added.list).toEqual([extraReal])

    const relative = addDirectory(added.ok ? added.list : [], cwd, 'src')
    expect(relative.ok).toBe(true)
    if (relative.ok) expect(relative.list).toEqual([extraReal, srcReal])

    const file = addDirectory([], cwd, 'note.txt')
    expect(file.ok).toBe(false)
    if (!file.ok) {
      expect(file.error).toBe('not a directory')
      expect(file.list).toEqual([])
    }

    const missing = addDirectory(['keep'], cwd, 'nope')
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.error).toBe('not a directory')
      expect(missing.list).toEqual(['keep'])
    }
  })

  test('does not duplicate an already-listed directory', () => {
    const extra = fixtureRoot('ravenclaw-adddir-dup-')
    const extraReal = normalizeDir(extra, extra)
    const first = addDirectory([], extra, extra)
    expect(first.ok).toBe(true)
    const second = addDirectory(first.ok ? first.list : [], extra, extra)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.list).toEqual([extraReal])
  })
})

describe('isPathInAnyRoot', () => {
  test('is true for cwd or any extra root, false outside', () => {
    const cwd = fixtureRoot('ravenclaw-root-cwd-')
    const extra = fixtureRoot('ravenclaw-root-extra-')
    const outside = fixtureRoot('ravenclaw-root-out-')
    mkdirSync(join(cwd, 'src'))
    mkdirSync(join(extra, 'lib'))
    writeFileSync(join(outside, 'secret.txt'), 'x\n')

    expect(isPathInAnyRoot(cwd, join(cwd, 'src'), [])).toBe(true)
    expect(isPathInAnyRoot(cwd, join(cwd, 'src'), [extra])).toBe(true)
    expect(isPathInAnyRoot(cwd, join(extra, 'lib'), [extra])).toBe(true)
    expect(isPathInAnyRoot(cwd, extra, [extra])).toBe(true)
    expect(isPathInAnyRoot(cwd, join(outside, 'secret.txt'), [extra])).toBe(false)
    expect(isInTreePath(cwd, join(extra, 'lib'), [extra])).toBe(true)
    expect(isInTreePath(cwd, join(outside, 'secret.txt'), [extra])).toBe(false)
  })

  test('acceptEdits promotes Edit under additionalDirectories', async () => {
    const cwd = fixtureRoot('ravenclaw-root-promote-cwd-')
    const extra = fixtureRoot('ravenclaw-root-promote-extra-')
    const extraReal = normalizeDir(cwd, extra)
    const turn: Turn = {
      id: 'turn_1',
      sessionId: 'sess_1',
      messages: [],
      round: 1,
      maxRounds: 80,
      graceUsed: false,
      abort: new AbortController(),
      permissionMode: 'acceptEdits',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactGeneration: 0,
      funding: 'byok',
      cwd,
      additionalDirectories: [extraReal],
      model: 'dummy',
      readFiles: new Set(),
    }
    const ctx: ToolContext = { turn, signal: turn.abort.signal, onProgress() {} }
    const tool: Tool = {
      name: 'Edit',
      description: 'mock',
      inputSchema: { type: 'object' },
      parse(input: unknown) {
        return { ok: true as const, value: input }
      },
      isConcurrencySafe() {
        return false
      },
      isReadOnly() {
        return false
      },
      async checkPermissions() {
        return { behavior: 'ask', message: 'edit?' }
      },
      async execute() {
        return 'ok'
      },
    }
    const decision: PermissionDecision = await decidePermission({
      name: 'Edit',
      input: { path: join(extra, 'a.ts'), old_string: 'a', new_string: 'b' },
      tool,
      ctx,
      mode: 'acceptEdits',
      rules: { session: [], user: [], project: [] },
    })
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })
})
