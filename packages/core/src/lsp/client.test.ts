import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { consumeJsonRpcFrames, encodeJsonRpcFrame } from '../mcp/client'
import {
  LSP_RESULT_CAP,
  NO_SERVER_MESSAGE,
  createLspClient,
  findServerForPath,
  loadLspConfig,
  lspConfigPath,
  type LspChild,
  type LspConfig,
} from './client'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-lsp-client-'))
  tempDirs.push(root)
  return root
}

function writeConfig(cwd: string, config: LspConfig): void {
  const path = lspConfigPath(cwd)
  mkdirSync(join(cwd, '.ravenclaw'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

describe('lsp client', () => {
  test('loadLspConfig reads servers from .ravenclaw/lsp.json', () => {
    const root = fixtureRoot()
    expect(loadLspConfig(root)).toBeUndefined()
    writeConfig(root, {
      servers: [{ command: 'fake-ls', args: ['--stdio'], extensions: ['.ts'] }],
    })
    expect(loadLspConfig(root)).toEqual({
      servers: [{ command: 'fake-ls', args: ['--stdio'], extensions: ['.ts'] }],
    })
  })

  test('findServerForPath matches file extensions', () => {
    const config: LspConfig = {
      servers: [
        { command: 'tsgo', extensions: ['.ts', '.tsx'] },
        { command: 'pygo', extensions: ['.py'] },
      ],
    }
    expect(findServerForPath(config, 'src/a.ts')?.command).toBe('tsgo')
    expect(findServerForPath(config, 'src/A.TSX')?.command).toBe('tsgo')
    expect(findServerForPath(config, 'main.py')?.command).toBe('pygo')
    expect(findServerForPath(config, 'README.md')).toBeUndefined()
  })

  test('query fails when no server is configured for the file', async () => {
    const root = fixtureRoot()
    const client = createLspClient({
      query: async () => 'should not run',
      start() {
        throw new Error('must not start')
      },
    })
    expect(
      await client.query({ operation: 'hover', path: 'src/a.ts', line: 0 }, root),
    ).toBe(NO_SERVER_MESSAGE)

    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    expect(
      await client.query({ operation: 'hover', path: 'src/a.py', line: 0 }, root),
    ).toBe(NO_SERVER_MESSAGE)
  })

  test('uses a mock query and never spawns when one is provided', async () => {
    const root = fixtureRoot()
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const spawned: string[] = []
    const client = createLspClient({
      start(command) {
        spawned.push(command)
        throw new Error('must not start a language server')
      },
      query: async (req) => `mock ${req.operation} ${req.path}:${req.line}:${req.character ?? 0}`,
    })
    const out = await client.query(
      { operation: 'definition', path: 'src/a.ts', line: 4, character: 2 },
      root,
    )
    expect(out).toBe('mock definition src/a.ts:4:2')
    expect(spawned).toEqual([])
  })

  test('speaks initialize, didOpen, and the real method then returns the payload', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'lib.ts'), 'export const n = 1\n')
    writeConfig(root, {
      servers: [{ command: 'fake-ls', args: ['--stdio'], extensions: ['.ts'] }],
    })
    const fake = fakeLspChild({
      hover: { contents: { kind: 'markdown', value: 'const n: number' } },
    })
    const client = createLspClient({
      start(command, args, opts) {
        fake.starts.push({ command, args: [...args], cwd: opts.cwd })
        return fake.child
      },
    })
    const out = await client.query({ operation: 'hover', path: 'lib.ts', line: 0, character: 13 }, root)
    expect(fake.starts).toEqual([{ command: 'fake-ls', args: ['--stdio'], cwd: root }])
    expect(fake.methods).toEqual(['initialize', 'initialized', 'textDocument/didOpen', 'textDocument/hover'])
    expect(out).toContain('const n: number')
    expect(JSON.parse(out)).toEqual({ contents: { kind: 'markdown', value: 'const n: number' } })
  })

  test('reuses one process and bumps didChange version when the file changes', async () => {
    const root = fixtureRoot()
    const path = join(root, 'lib.ts')
    writeFileSync(path, 'const a = 1\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({
      definition: [{ uri: 'file:///lib.ts', range: { start: { line: 0, character: 6 } } }],
    })
    const client = createLspClient({ start: () => fake.child })
    await client.query({ operation: 'definition', path: 'lib.ts', line: 0, character: 6 }, root)
    writeFileSync(path, 'const a = 2\n')
    await client.query({ operation: 'definition', path: 'lib.ts', line: 0, character: 6 }, root)
    expect(fake.methods.filter((method) => method === 'initialize')).toHaveLength(1)
    expect(fake.methods.filter((method) => method === 'textDocument/didOpen')).toHaveLength(1)
    expect(fake.methods.filter((method) => method === 'textDocument/didChange')).toHaveLength(1)
    const change = fake.params.find(
      (item): item is { textDocument?: { version?: number }; contentChanges?: Array<{ text?: string }> } =>
        Boolean(item && typeof item === 'object' && 'contentChanges' in item),
    )
    expect(change?.textDocument?.version).toBe(2)
    expect(change?.contentChanges?.[0]?.text).toBe('const a = 2\n')
  })

  test('concurrent first queries share one language server', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({ hover: { contents: 'shared' } })
    let starts = 0
    const client = createLspClient({
      start() {
        starts += 1
        return fake.child
      },
    })
    const [a, b] = await Promise.all([
      client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root),
      client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root),
    ])
    expect(starts).toBe(1)
    expect(a).toContain('shared')
    expect(b).toContain('shared')
    expect(fake.methods.filter((method) => method === 'initialize')).toHaveLength(1)
  })

  test('restarts after the language server exits', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const first = fakeLspChild({ hover: { contents: 'one' } })
    const second = fakeLspChild({ hover: { contents: 'two' } })
    const kids = [first, second]
    const client = createLspClient({
      start() {
        const next = kids.shift()
        if (!next) throw new Error('no more servers')
        return next.child
      },
    })
    expect(await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)).toContain('one')
    first.exit()
    expect(first.killed).toBe(true)
    expect(await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)).toContain('two')
    expect(second.methods).toContain('initialize')
  })

  test('reports a missing language server when start fails', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'missing-ls', extensions: ['.ts'] }] })
    const client = createLspClient({
      start() {
        throw new Error('ENOENT')
      },
    })
    expect(await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)).toBe(
      'LSP failed: language server not available',
    )
  })

  test('clips a large server payload', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({ hover: { contents: 'x'.repeat(LSP_RESULT_CAP + 50) } })
    const client = createLspClient({ start: () => fake.child })
    const out = await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)
    expect(out.length).toBeGreaterThan(LSP_RESULT_CAP)
    expect(out).toContain('... [truncated]')
    expect(out).not.toContain('x'.repeat(LSP_RESULT_CAP + 1))
  })
})

function fakeLspChild(results: Partial<Record<string, unknown>>): {
  child: LspChild
  methods: string[]
  params: unknown[]
  starts: Array<{ command: string; args: string[]; cwd: string }>
  killed: boolean
  exit: () => void
} {
  const stdout = new EventEmitter()
  const methods: string[] = []
  const params: unknown[] = []
  const state = { killed: false }
  let buffer = Buffer.alloc(0)
  const child: LspChild = {
    stdin: {
      write(chunk: string | Uint8Array) {
        const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
        buffer = Buffer.concat([buffer, incoming])
        const parsed = consumeJsonRpcFrames(buffer)
        buffer = parsed.rest
        for (const message of parsed.messages) {
          if (!message || typeof message !== 'object') continue
          const rec = message as { id?: unknown; method?: unknown; params?: unknown }
          if (typeof rec.method !== 'string') continue
          methods.push(rec.method)
          params.push(rec.params)
          if (rec.id === undefined) continue
          const short = rec.method.split('/').at(-1) ?? rec.method
          const result =
            rec.method === 'initialize'
              ? { capabilities: { hoverProvider: true, definitionProvider: true, referencesProvider: true } }
              : (results[short] ?? results[rec.method] ?? null)
          queueMicrotask(() => {
            stdout.emit('data', encodeJsonRpcFrame({ jsonrpc: '2.0', id: rec.id, result }))
          })
        }
        return true
      },
      end() {},
    },
    stdout,
    kill() {
      state.killed = true
      return true
    },
    on(event, listener) {
      stdout.on(event, listener)
      return this
    },
    off(event, listener) {
      stdout.off(event, listener)
      return this
    },
  }
  return {
    child,
    methods,
    params,
    starts: [],
    get killed() {
      return state.killed
    },
    exit() {
      stdout.emit('exit', 1)
    },
  }
}
