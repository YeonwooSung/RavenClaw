import { describe, expect, test } from 'bun:test'
import { mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('./index.ts', import.meta.url))

async function raven(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    cwd: opts?.cwd ?? process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

describe('no-key CLI (CI smoke)', () => {
  test('--version and --help exit 0', async () => {
    const version = await raven(['--version'])
    expect(version.code).toBe(0)
    expect(version.stdout).toMatch(/^raven \d+\.\d+\.\d+\n$/)
    const help = await raven(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('raven exec')
    expect(help.stdout).toContain('raven doctor')
  })

  test('completions zsh is a #compdef', async () => {
    const result = await raven(['completions', 'zsh'])
    expect(result.code).toBe(0)
    expect(result.stdout.startsWith('#compdef raven')).toBe(true)
  })

  test('sessions with empty home prints no sessions', async () => {
    const result = await raven(['sessions'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('no sessions')
  })

  test('config prints redacted defaults', async () => {
    const result = await raven(['config'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('provider:')
    expect(result.stdout).not.toMatch(/sk-ant-|sk-/)
  })

  test('init writes AGENTS.md in an empty directory', async () => {
    const cwd = join(tmpdir(), `raven-ci-init-${Date.now()}`)
    mkdirSync(cwd, { recursive: true })
    const result = await raven(['init'], { cwd })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('wrote')
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(true)
  })

  test('doctor without setup exits 1 and does not print a key', async () => {
    const result = await raven(['doctor'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('fail')
    expect(result.stdout + result.stderr).not.toMatch(/sk-ant-|sk-live/)
  })
})
