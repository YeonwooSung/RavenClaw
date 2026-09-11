import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { readTool } from './read'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-read-'))
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

describe('Read', () => {
  test('is a concurrency-safe read-only tool that allows by mode', async () => {
    expect(readTool.name).toBe('Read')
    expect(readTool.isConcurrencySafe({ path: 'a.txt' })).toBe(true)
    expect(readTool.isReadOnly({ path: 'a.txt' })).toBe(true)
    expect(readTool.interruptBehavior?.()).toBe('block')
    const decision = await readTool.checkPermissions({ path: 'a.txt' }, makeCtx('/tmp'))
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('reads a utf-8 file and records the resolved path on turn.readFiles', async () => {
    const root = fixtureRoot()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'note.txt'), 'hello raven\n')
    const ctx = makeCtx(root)

    const out = await readTool.execute({ path: 'src/note.txt' }, ctx)
    expect(out).toContain('hello raven')
    expect(ctx.turn.readFiles.has(resolve(root, 'src/note.txt'))).toBe(true)
  })

  test('offset/limit slice lines using a 1-based offset', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'lines.txt'), 'alpha\nbeta\ngamma\ndelta\n')
    const ctx = makeCtx(root)

    const out = await readTool.execute({ path: 'lines.txt', offset: 2, limit: 2 }, ctx)
    expect(out).toContain('beta')
    expect(out).toContain('gamma')
    expect(out).not.toContain('alpha')
    expect(out).not.toContain('delta')
  })

  test('small png returns IMAGE::image/png::<base64> and records readFiles', async () => {
    const root = fixtureRoot()
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    writeFileSync(join(root, 'dot.png'), png)
    const ctx = makeCtx(root)

    const out = await readTool.execute({ path: 'dot.png' }, ctx)
    expect(out).toBe(`IMAGE::image/png::${png.toString('base64')}`)
    expect(ctx.turn.readFiles.has(resolve(root, 'dot.png'))).toBe(true)
  })

  test('binary files return an error string and are not added to readFiles', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    const ctx = makeCtx(root)

    const out = await readTool.execute({ path: 'blob.bin' }, ctx)
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).toContain('binary')
    expect(ctx.turn.readFiles.size).toBe(0)
  })

  test('execute refuses when the signal is already aborted', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.txt'), 'ok\n')
    const ac = new AbortController()
    ac.abort()
    const ctx = makeCtx(root, ac.signal)
    await expect(readTool.execute({ path: 'a.txt' }, ctx)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(ctx.turn.readFiles.size).toBe(0)
  })
})
