import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalTerminalBackend } from './terminal-backend'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-term-'))
  tempDirs.push(root)
  return realpathSync(root)
}

describe('createLocalTerminalBackend', () => {
  test('strips the cwd marker from stdout and reports the ending cwd', async () => {
    const root = fixtureRoot()
    const backend = createLocalTerminalBackend()
    const result = await backend.exec({
      command: 'echo hello',
      cwd: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.stdout).toContain('hello')
    expect(result.stdout).not.toMatch(/RAVENCLAW_CWD|__CWD_/)
    expect(result.cwd).toBe(root)
    expect(result.exitCode).toBe(0)
  })

  test('captures cwd after cd via the in-band marker', async () => {
    const root = fixtureRoot()
    const nested = join(root, 'nested')
    const backend = createLocalTerminalBackend()
    const result = await backend.exec({
      command: 'mkdir nested && cd nested && pwd',
      cwd: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.cwd).toBe(nested)
    expect(result.stdout).toContain('nested')
    expect(result.stdout).not.toMatch(/RAVENCLAW_CWD|__CWD_/)
  })

  test('refuses to start when the signal is already aborted', async () => {
    const root = fixtureRoot()
    const ac = new AbortController()
    ac.abort()
    const backend = createLocalTerminalBackend()
    await expect(
      backend.exec({
        command: 'echo hi',
        cwd: root,
        timeoutMs: 5_000,
        signal: ac.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
