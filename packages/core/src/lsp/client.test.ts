import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

  test('initialize sends processId, workspaceFolders, and client capabilities', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'lib.ts'), 'export const n = 1\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({ hover: { contents: 'ok' } })
    const client = createLspClient({
      start(command, args, opts) {
        fake.starts.push({ command, args: [...args], cwd: opts.cwd })
        return fake.child
      },
    })
    await client.query({ operation: 'hover', path: 'lib.ts', line: 0 }, root)
    const init = fake.params[0] as {
      processId?: unknown
      rootUri?: string
      workspaceFolders?: unknown
      initializationOptions?: unknown
      capabilities?: {
        workspace?: { workspaceFolders?: { supported?: boolean } }
        textDocument?: Record<string, unknown>
      }
    }
    expect(init.processId).toBe(process.pid)
    expect(init.rootUri).toBe(pathToFileURL(root).href)
    expect(init.workspaceFolders).toEqual([{ uri: pathToFileURL(root).href, name: basename(root) }])
    expect(init.initializationOptions).toBeUndefined()
    expect(init.capabilities?.workspace?.workspaceFolders?.supported).toBe(true)
    const td = init.capabilities?.textDocument ?? {}
    for (const key of [
      'hover',
      'definition',
      'references',
      'implementation',
      'typeDefinition',
      'publishDiagnostics',
      'diagnostic',
    ]) {
      expect(td).toHaveProperty(key)
    }
  })

  test('hoverProvider false refuses without sending textDocument/hover', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({
      initialize: { capabilities: { hoverProvider: false } },
      hover: { contents: 'should not run' },
    })
    const client = createLspClient({ start: () => fake.child })
    expect(await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)).toBe(
      'LSP failed: server does not support hover',
    )
    expect(fake.methods).toContain('initialize')
    expect(fake.methods).toContain('textDocument/didOpen')
    expect(fake.methods).not.toContain('textDocument/hover')
  })

  test('absent provider still tries the method', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({
      initialize: { capabilities: {} },
      hover: { contents: 'tried' },
    })
    const client = createLspClient({ start: () => fake.child })
    const out = await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)
    expect(fake.methods).toContain('textDocument/hover')
    expect(out).toContain('tried')
  })

  test('answers reverse-RPC and refuses applyEdit without writing files', async () => {
    const root = fixtureRoot()
    const path = join(root, 'lib.ts')
    writeFileSync(path, 'export const n = 1\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({ hover: { contents: 'ok' } })
    const client = createLspClient({ start: () => fake.child })
    await client.query({ operation: 'hover', path: 'lib.ts', line: 0 }, root)
    const before = readFileSync(path, 'utf8')
    const folders = [{ uri: pathToFileURL(root).href, name: basename(root) }]
    fake.emitRequest('workspace/workspaceFolders', 71, null)
    fake.emitRequest('workspace/configuration', 72, { items: [{ section: 'a' }, { section: 'b' }] })
    fake.emitRequest('window/workDoneProgress/create', 73, { token: 't' })
    fake.emitRequest('workspace/applyEdit', 74, {
      edit: {
        changes: {
          [pathToFileURL(path).href]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              newText: 'HACKED',
            },
          ],
        },
      },
    })
    await Promise.resolve()
    expect(fake.replies).toContainEqual({ id: 71, result: folders })
    expect(fake.replies).toContainEqual({ id: 72, result: [{}, {}] })
    expect(fake.replies).toContainEqual({ id: 73, result: null })
    expect(fake.replies).toContainEqual({ id: 74, result: { applied: false } })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  test('query timeout copy is not missing-binary copy', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({ hover: { contents: 'late' } }, { silent: new Set(['textDocument/hover']) })
    const client = createLspClient({ start: () => fake.child, queryTimeoutMs: 40 })
    expect(await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)).toBe(
      'LSP failed: timed out',
    )
  })

  test('initialize timeout copy is not missing-binary copy', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({}, { silent: new Set(['initialize']) })
    const client = createLspClient({ start: () => fake.child, initializeTimeoutMs: 40 })
    expect(await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)).toBe(
      'LSP failed: timed out',
    )
  })

  test('drop writes shutdown then exit before kill', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({ hover: { contents: 'one' } })
    const client = createLspClient({ start: () => fake.child })
    await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)
    fake.exit()
    expect(fake.methods).toContain('shutdown')
    expect(fake.methods).toContain('exit')
    expect(fake.methods.indexOf('shutdown')).toBeLessThan(fake.methods.indexOf('exit'))
    expect(fake.killed).toBe(true)
  })

  test('LSP drops frames over 256 KiB without JSON.parse', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({ hover: { contents: 'ok' } })
    const client = createLspClient({ start: () => fake.child })
    await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)
    const huge = Buffer.alloc(256 * 1024 + 32, 0x78)
    fake.pushRaw(Buffer.concat([Buffer.from(`Content-Length: ${huge.length}\r\n\r\n`), huge]))
    const out = await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)
    expect(out).toContain('ok')
  })

  test('MCP consumeJsonRpcFrames still parses a frame larger than 256 KiB', () => {
    const payload = { jsonrpc: '2.0', id: 1, result: { pad: 'x'.repeat(256 * 1024) } }
    const frame = Buffer.from(encodeJsonRpcFrame(payload), 'utf8')
    expect(frame.length).toBeGreaterThan(256 * 1024)
    const parsed = consumeJsonRpcFrames(frame)
    expect(parsed.messages).toHaveLength(1)
    expect((parsed.messages[0] as { result: { pad: string } }).result.pad.length).toBe(256 * 1024)
  })

  test('query uses configCwd for lsp.json and workspaceCwd for spawn and jail', async () => {
    const project = fixtureRoot()
    const worktree = fixtureRoot()
    writeFileSync(join(worktree, 'lib.ts'), 'export const n = 1\n')
    writeConfig(project, { servers: [{ command: 'fake-ls', args: ['--stdio'], extensions: ['.ts'] }] })
    const fake = fakeLspChild({ hover: { contents: 'wt' } })
    const client = createLspClient({
      start(command, args, opts) {
        fake.starts.push({ command, args: [...args], cwd: opts.cwd })
        return fake.child
      },
    })
    const out = await client.query(
      { operation: 'hover', path: 'lib.ts', line: 0 },
      { workspaceCwd: worktree, configCwd: project },
    )
    expect(out).toContain('wt')
    expect(fake.starts).toEqual([{ command: 'fake-ls', args: ['--stdio'], cwd: worktree }])
    const init = fake.params[0] as { rootUri?: string; workspaceFolders?: Array<{ uri: string }> }
    expect(init.rootUri).toBe(pathToFileURL(worktree).href)
    expect(init.workspaceFolders?.[0]?.uri).toBe(pathToFileURL(worktree).href)
  })

  test('passes initializationOptions object through and ignores unknown server keys', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    mkdirSync(join(root, '.ravenclaw'), { recursive: true })
    writeFileSync(
      lspConfigPath(root),
      `${JSON.stringify({
        servers: [
          {
            command: 'fake-ls',
            extensions: ['.ts'],
            env: { SECRET: 'nope' },
            extra: true,
            initializationOptions: { plugins: ['p'] },
          },
        ],
      })}\n`,
      'utf8',
    )
    expect(loadLspConfig(root)).toEqual({
      servers: [
        {
          command: 'fake-ls',
          extensions: ['.ts'],
          initializationOptions: { plugins: ['p'] },
        },
      ],
    })
    const fake = fakeLspChild({ hover: { contents: 'ok' } })
    const client = createLspClient({ start: () => fake.child })
    await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)
    const init = fake.params[0] as { initializationOptions?: unknown }
    expect(init.initializationOptions).toEqual({ plugins: ['p'] })
  })

  test('implementation and typeDefinition send the real methods', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({
      implementation: [{ uri: 'file:///a.ts', range: { start: { line: 1, character: 0 } } }],
      typeDefinition: [{ uri: 'file:///a.ts', range: { start: { line: 2, character: 0 } } }],
    })
    const client = createLspClient({ start: () => fake.child })
    const impl = await client.query({ operation: 'implementation', path: 'a.ts', line: 0 }, root)
    const typed = await client.query({ operation: 'typeDefinition', path: 'a.ts', line: 0, character: 1 }, root)
    expect(fake.methods).toContain('textDocument/implementation')
    expect(fake.methods).toContain('textDocument/typeDefinition')
    expect(JSON.parse(impl)).toEqual([
      { uri: 'file:///a.ts', range: { start: { line: 1, character: 0 } } },
    ])
    expect(JSON.parse(typed)).toEqual([
      { uri: 'file:///a.ts', range: { start: { line: 2, character: 0 } } },
    ])
  })

  test('implementationProvider false refuses without sending the method', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({
      initialize: { capabilities: { implementationProvider: false } },
      implementation: [{ uri: 'file:///nope' }],
    })
    const client = createLspClient({ start: () => fake.child })
    expect(await client.query({ operation: 'implementation', path: 'a.ts', line: 0 }, root)).toBe(
      'LSP failed: server does not support implementation',
    )
    expect(fake.methods).not.toContain('textDocument/implementation')
  })

  test('diagnostic drains publishDiagnostics into compact errors', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild(
      {},
      {
        publishOnOpen: [
          {
            range: { start: { line: 3, character: 1 }, end: { line: 3, character: 2 } },
            severity: 2,
            code: 'W1',
            message: 'careful',
          },
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
            severity: 1,
            code: 'E1',
            message: 'boom',
          },
        ],
      },
    )
    const client = createLspClient({ start: () => fake.child, diagnosticDrainMs: 80 })
    const out = await client.query({ operation: 'diagnostic', path: 'a.ts', line: 0 }, root)
    expect(fake.methods).not.toContain('textDocument/diagnostic')
    expect(out).toBe('a.ts:1:0 error E1 boom\na.ts:3:1 warning W1 careful')
  })

  test('diagnostic pulls textDocument/diagnostic when diagnosticProvider is advertised', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const fake = fakeLspChild({
      initialize: {
        capabilities: { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } },
      },
      diagnostic: {
        kind: 'full',
        items: [
          {
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 5 } },
            severity: 1,
            code: { value: 'TS2322' },
            message: 'nope',
          },
        ],
      },
    })
    const client = createLspClient({ start: () => fake.child, diagnosticDrainMs: 200 })
    const started = Date.now()
    const out = await client.query({ operation: 'diagnostic', path: 'a.ts', line: 99, character: 7 }, root)
    expect(Date.now() - started).toBeLessThan(150)
    expect(fake.methods).toContain('textDocument/diagnostic')
    expect(out).toBe('a.ts:2:4 error TS2322 nope')
  })

  test('diagnostic caps at 20 items errors-first and clips at 8k', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'a.ts'), 'x\n')
    writeConfig(root, { servers: [{ command: 'fake-ls', extensions: ['.ts'] }] })
    const items = Array.from({ length: 25 }, (_, i) => ({
      range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
      severity: i < 5 ? 1 : 2,
      message: i === 0 ? 'x'.repeat(LSP_RESULT_CAP + 50) : `m${i}`,
    }))
    const fake = fakeLspChild({
      initialize: { capabilities: { diagnosticProvider: true } },
      diagnostic: { kind: 'full', items },
    })
    const client = createLspClient({ start: () => fake.child })
    const out = await client.query({ operation: 'diagnostic', path: 'a.ts', line: 0 }, root)
    const lines = out.split('\n').filter((line) => line !== '... [truncated]')
    expect(lines.length).toBeLessThanOrEqual(20)
    expect(out).toContain('error')
    expect(out).toContain('... [truncated]')
    expect(out.length).toBeGreaterThan(LSP_RESULT_CAP)
  })
})

function fakeLspChild(
  results: Partial<Record<string, unknown>> = {},
  opts?: { silent?: ReadonlySet<string>; publishOnOpen?: unknown[] },
): {
  child: LspChild
  methods: string[]
  params: unknown[]
  replies: Array<{ id: unknown; result: unknown }>
  starts: Array<{ command: string; args: string[]; cwd: string }>
  killed: boolean
  exit: () => void
  emitRequest: (method: string, id: number, params: unknown) => void
  pushRaw: (chunk: Buffer) => void
} {
  const stdout = new EventEmitter()
  const methods: string[] = []
  const params: unknown[] = []
  const replies: Array<{ id: unknown; result: unknown }> = []
  const state = { killed: false }
  let buffer = Buffer.alloc(0)
  const silent = opts?.silent ?? new Set<string>()
  const child: LspChild = {
    stdin: {
      write(chunk: string | Uint8Array) {
        const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
        buffer = Buffer.concat([buffer, incoming])
        const parsed = consumeJsonRpcFrames(buffer)
        buffer = parsed.rest
        for (const message of parsed.messages) {
          if (!message || typeof message !== 'object') continue
          const rec = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown }
          if (typeof rec.method !== 'string') {
            if (rec.id !== undefined) replies.push({ id: rec.id, result: rec.result })
            continue
          }
          methods.push(rec.method)
          params.push(rec.params)
          if (rec.method === 'textDocument/didOpen' && opts?.publishOnOpen) {
            const uri = (rec.params as { textDocument?: { uri?: string } } | undefined)?.textDocument
              ?.uri
            if (uri) {
              queueMicrotask(() => {
                stdout.emit(
                  'data',
                  encodeJsonRpcFrame({
                    jsonrpc: '2.0',
                    method: 'textDocument/publishDiagnostics',
                    params: { uri, diagnostics: opts.publishOnOpen },
                  }),
                )
              })
            }
          }
          if (rec.id === undefined) continue
          if (silent.has(rec.method)) continue
          const short = rec.method.split('/').at(-1) ?? rec.method
          const result =
            rec.method === 'initialize'
              ? (results.initialize ?? {
                  capabilities: {
                    hoverProvider: true,
                    definitionProvider: true,
                    referencesProvider: true,
                  },
                })
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
    replies,
    starts: [],
    get killed() {
      return state.killed
    },
    exit() {
      stdout.emit('exit', 1)
    },
    emitRequest(method, id, params) {
      stdout.emit('data', encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }))
    },
    pushRaw(chunk) {
      stdout.emit('data', chunk)
    },
  }
}
