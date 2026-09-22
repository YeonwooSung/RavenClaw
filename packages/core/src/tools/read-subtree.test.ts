import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, Turn } from '../types'
import { createReadSubtreeTool, extractSymbols, readSubtreeTool } from './read-subtree'
import {
  createDockerTerminalBackend,
  type TerminalRunRequest,
} from './terminal-backend'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-subtree-'))
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

function fakeDocker(runCommand: (req: TerminalRunRequest) => Promise<{
  stdout: string
  stderr: string
  exitCode: number
}>) {
  return createDockerTerminalBackend({ image: 'bash:5', runCommand })
}

describe('ReadSubtree', () => {
  test('is a concurrency-safe read-only tool that allows by mode', async () => {
    expect(readSubtreeTool.name).toBe('ReadSubtree')
    expect(readSubtreeTool.isConcurrencySafe({})).toBe(true)
    expect(readSubtreeTool.isReadOnly({})).toBe(true)
    expect(readSubtreeTool.interruptBehavior?.()).toBe('cancel')
    const decision = await readSubtreeTool.checkPermissions({}, makeCtx('/tmp'))
    expect(decision).toEqual({ behavior: 'allow', reason: 'mode' })
  })

  test('parse accepts optional path and maxFiles', () => {
    expect(readSubtreeTool.parse({}).ok).toBe(true)
    expect(readSubtreeTool.parse({ path: 'src', maxFiles: 10 }).ok).toBe(true)
    expect(readSubtreeTool.parse({ maxFiles: 0 }).ok).toBe(false)
  })

  test('lists relative files with size and extracted symbols', async () => {
    const root = fixtureRoot()
    mkdirSync(join(root, 'src'))
    const src = [
      'export function foo() {}',
      'export class Bar {}',
      'const hidden = 1',
      'export type Baz = string',
    ].join('\n')
    writeFileSync(join(root, 'src', 'main.ts'), `${src}\n`)
    writeFileSync(join(root, 'readme.md'), 'hello\n')

    const out = await readSubtreeTool.execute({}, makeCtx(root))
    expect(out).toContain('readme.md  ')
    expect(out).toMatch(/readme\.md {2}\d+b/)
    expect(out).toContain('src/main.ts  ')
    expect(out).toContain('    function foo')
    expect(out).toContain('    class Bar')
    expect(out).toContain('    const hidden')
    expect(out).toContain('    type Baz')
  })

  test('skips default ignore dirs such as node_modules and .git', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'keep.ts'), 'export function keep() {}\n')
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'hidden.ts'), 'export function hidden() {}\n')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), 'x\n')
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'out.js'), 'export function built() {}\n')

    const out = await readSubtreeTool.execute({}, makeCtx(root))
    expect(out).toContain('keep.ts')
    expect(out).toContain('    function keep')
    expect(out).not.toContain('node_modules')
    expect(out).not.toContain('hidden')
    expect(out).not.toContain('dist')
    expect(out).not.toContain('.git')
  })

  test('binary and huge files show size only', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 9]))
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(200_001))

    const out = await readSubtreeTool.execute({}, makeCtx(root))
    expect(out).toMatch(/big\.txt {2}200001b/)
    expect(out).toMatch(/blob\.bin {2}6b/)
    expect(out).not.toContain('    function')
  })

  test('maxFiles is honored and capped at 80', async () => {
    const root = fixtureRoot()
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(root, `f${i}.ts`), `export const n${i} = ${i}\n`)
    }
    const limited = await readSubtreeTool.execute({ maxFiles: 3 }, makeCtx(root))
    const headers = limited.split('\n').filter((line) => /^\S/.test(line))
    expect(headers).toHaveLength(3)

    for (let i = 10; i < 90; i++) {
      writeFileSync(join(root, `f${i}.ts`), `export const n${i} = ${i}\n`)
    }
    const capped = await readSubtreeTool.execute({ maxFiles: 200 }, makeCtx(root))
    const cappedHeaders = capped.split('\n').filter((line) => /^\S/.test(line))
    expect(cappedHeaders.length).toBe(80)
  })

  test('refuses a path outside cwd', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    ctx.turn.terminalBackend = 'docker'
    const out = await readSubtreeTool.execute({ path: '/etc' }, ctx)
    expect(String(out).toLowerCase()).toMatch(/outside workspace|denied|protected/)
  })

  test('returns ReadSubtree failed when the path is missing', async () => {
    const root = fixtureRoot()
    const out = await readSubtreeTool.execute({ path: 'missing' }, makeCtx(root))
    expect(out.startsWith('ReadSubtree failed:')).toBe(true)
  })

  test('execute refuses when the signal is already aborted', async () => {
    const root = fixtureRoot()
    const ac = new AbortController()
    ac.abort()
    await expect(readSubtreeTool.execute({}, makeCtx(root, ac.signal))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  test('createReadSubtreeTool without backend still lists a unique file', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'note.txt'), 'hello factory\n')
    const tool = createReadSubtreeTool()
    expect(tool.name).toBe('ReadSubtree')
    expect(tool).not.toBe(readSubtreeTool)
    const out = await tool.execute({}, makeCtx(root))
    expect(out).toContain('note.txt')
  })
})

describe('ReadSubtree docker backend', () => {
  test('docker ReadSubtree issues one readFile exec per file under the byte cap', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'export function alpha() {}\n')
    writeFileSync(join(root, 'b.ts'), 'export function beta() {}\n')
    let cats = 0
    const backend = fakeDocker(async (req) => {
      const script = String(req.args.at(-1))
      if (script.includes('find') || script.startsWith('if [ ! -d')) {
        return { stdout: 'f a.ts\nf b.ts\n', stderr: '', exitCode: 0 }
      }
      if (script.includes('EXISTS') || script.includes('kind=dir')) {
        if (script.includes('a.ts') || script.includes('b.ts')) {
          return { stdout: 'EXISTS file 24 1\n', stderr: '', exitCode: 0 }
        }
        return { stdout: 'EXISTS dir 0 1\n', stderr: '', exitCode: 0 }
      }
      cats += 1
      return { stdout: 'export function fromContainer() {}\n', stderr: '', exitCode: 0 }
    })
    const out = await createReadSubtreeTool(backend).execute({ path: '.' }, makeCtx(root))
    expect(cats).toBe(2)
    expect(out).toContain('fromContainer')
    expect(out).not.toContain('function alpha')
  })

  test('docker ReadSubtree skips readFile when fake size is at the byte cap', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'huge.ts'), 'export function huge() {}\n')
    writeFileSync(join(root, 'small.ts'), 'export function small() {}\n')
    let cats = 0
    const backend = fakeDocker(async (req) => {
      const script = String(req.args.at(-1))
      if (script.includes('find') || script.startsWith('if [ ! -d')) {
        return { stdout: 'f huge.ts\nf small.ts\n', stderr: '', exitCode: 0 }
      }
      if (script.includes('EXISTS') || script.includes('kind=dir')) {
        if (script.includes('huge.ts')) {
          return { stdout: 'EXISTS file 200000 1\n', stderr: '', exitCode: 0 }
        }
        if (script.includes('small.ts')) {
          return { stdout: 'EXISTS file 24 1\n', stderr: '', exitCode: 0 }
        }
        return { stdout: 'EXISTS dir 0 1\n', stderr: '', exitCode: 0 }
      }
      cats += 1
      return { stdout: 'export function fromContainer() {}\n', stderr: '', exitCode: 0 }
    })
    const out = await createReadSubtreeTool(backend).execute({ path: '.' }, makeCtx(root))
    expect(cats).toBe(1)
    expect(out).toMatch(/huge\.ts {2}200000b/)
    expect(out).toContain('fromContainer')
    expect(out).not.toContain('function huge')
    expect(out).not.toContain('function small')
  })

  test('exec fail is ReadSubtree failed: ; abort throws AbortError', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'export function alpha() {}\n')
    const backend = fakeDocker(async () => ({
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
      exitCode: 1,
    }))
    const out = await createReadSubtreeTool(backend).execute({}, makeCtx(root))
    expect(out).toMatch(/^ReadSubtree failed:/)
    const ac = new AbortController()
    ac.abort()
    await expect(
      createReadSubtreeTool(fakeDocker(async () => ({ stdout: '', stderr: '', exitCode: 0 }))).execute(
        {},
        makeCtx(root, ac.signal),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('outside-cwd does not exec', async () => {
    const root = fixtureRoot()
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: 'nope', stderr: '', exitCode: 0 }
    })
    const out = await createReadSubtreeTool(backend).execute({ path: '/etc' }, makeCtx(root))
    expect(calls).toHaveLength(0)
    expect(out).toMatch(/^ReadSubtree failed:/)
  })
})

describe('extractSymbols', () => {
  test('keeps at most 8 symbol-ish lines and strips export/async', () => {
    const lines = [
      'export async function one() {}',
      'export class Two {}',
      'const three = 1',
      'type Four = number',
      'interface Five {}',
      'enum Six { A }',
      'export function seven() {}',
      'export const eight = 2',
      'export function nine() {}',
      'not a symbol',
    ]
    expect(extractSymbols(lines.join('\n'))).toEqual([
      'function one',
      'class Two',
      'const three',
      'type Four',
      'interface Five',
      'enum Six',
      'function seven',
      'const eight',
    ])
  })
})
