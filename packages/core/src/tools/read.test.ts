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

  test('extracts text from a minimal docx and records readFiles', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.docx'), zipStore({
      'word/document.xml': '<w:document><w:body><w:p><w:t>Spec text</w:t></w:p></w:body></w:document>',
    }))
    const ctx = makeCtx(root)
    const out = await readTool.execute({ path: 'note.docx' }, ctx)
    expect(out).toBe('Spec text')
    expect(ctx.turn.readFiles.has(resolve(root, 'note.docx'))).toBe(true)
  })

  test('malformed office files fail closed and are not added to readFiles', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'bad.xlsx'), Buffer.from('PK\x03\x04not-a-real-sheet'))
    const ctx = makeCtx(root)
    const out = await readTool.execute({ path: 'bad.xlsx' }, ctx)
    expect(out).toBe('Read failed: cannot extract')
    expect(ctx.turn.readFiles.size).toBe(0)
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

  test('refuses a path outside cwd', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    ctx.turn.terminalBackend = 'docker'
    const out = await readTool.execute({ path: '/etc/passwd' }, ctx)
    expect(String(out).toLowerCase()).toMatch(/outside workspace|denied|protected/)
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

function zipStore(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body, 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const piece = Buffer.concat([local, nameBuf, data])
    locals.push(piece)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    offset += piece.length
  }
  const localAll = Buffer.concat(locals)
  const centralAll = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralAll.length, 12)
  eocd.writeUInt32LE(localAll.length, 16)
  return Buffer.concat([localAll, centralAll, eocd])
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
