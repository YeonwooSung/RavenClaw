import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NO_SERVER_MESSAGE,
  createLspClient,
  findServerForPath,
  loadLspConfig,
  lspConfigPath,
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
      spawn: async () => ({ ok: true }),
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
      spawn: async (command) => {
        spawned.push(command)
        return { ok: true }
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

  test('probes command --version through the injected spawn and skips protocol', async () => {
    const root = fixtureRoot()
    writeConfig(root, {
      servers: [{ command: 'fake-ls', args: ['--stdio'], extensions: ['.ts'] }],
    })
    const calls: Array<{ command: string; args: string[] }> = []
    const client = createLspClient({
      spawn: (command, args) => {
        calls.push({ command, args })
        return { ok: true, stdout: 'fake-ls 0.0.0' }
      },
    })
    const out = await client.query({ operation: 'references', path: 'lib.ts', line: 1 }, root)
    expect(calls).toEqual([{ command: 'fake-ls', args: ['--version'] }])
    expect(out).toBe('references lib.ts:1:0')
  })

  test('reports a missing language server when the version probe fails', async () => {
    const root = fixtureRoot()
    writeConfig(root, { servers: [{ command: 'missing-ls', extensions: ['.ts'] }] })
    const client = createLspClient({
      spawn: () => ({ ok: false, stderr: 'not found' }),
    })
    expect(await client.query({ operation: 'hover', path: 'a.ts', line: 0 }, root)).toBe(
      'LSP failed: language server not available',
    )
  })
})
