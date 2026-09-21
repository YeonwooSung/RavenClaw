import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadNearestSubdirAgents, SUBDIR_AGENTS_CHAR_CAP } from './subdir-agents'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-subdir-agents-'))
  tempDirs.push(dir)
  return dir
}

describe('loadNearestSubdirAgents', () => {
  test('injects the nearest subdirectory AGENTS.md and skips the project root file', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'pkg', 'foo'), { recursive: true })
    writeFileSync(join(cwd, 'AGENTS.md'), 'ROOT_FILE\n')
    writeFileSync(join(cwd, 'pkg', 'foo', 'AGENTS.md'), 'NESTED_FOO\n')
    writeFileSync(join(cwd, 'pkg', 'foo', 'a.ts'), 'export {}\n')

    const seen = new Set<string>()
    const first = loadNearestSubdirAgents(cwd, join(cwd, 'pkg', 'foo', 'a.ts'), seen)
    expect(first).toContain('[AGENTS.md: pkg/foo]')
    expect(first).toContain('NESTED_FOO')
    expect(first).not.toContain('ROOT_FILE')

    const again = loadNearestSubdirAgents(cwd, join(cwd, 'pkg', 'foo', 'b.ts'), seen)
    expect(again).toBeUndefined()
  })

  test('prefers AGENTS.md over RAVEN.md in the same directory', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'lib'), { recursive: true })
    writeFileSync(join(cwd, 'lib', 'AGENTS.md'), 'AGENTS_WINS\n')
    writeFileSync(join(cwd, 'lib', 'RAVEN.md'), 'RAVEN_LOSES\n')
    const hit = loadNearestSubdirAgents(cwd, join(cwd, 'lib', 'x.ts'), new Set())
    expect(hit).toContain('AGENTS_WINS')
    expect(hit).not.toContain('RAVEN_LOSES')
  })

  test('walks up to a parent subdirectory and caps at 32k', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'pkg', 'deep'), { recursive: true })
    writeFileSync(join(cwd, 'pkg', 'AGENTS.md'), `${'Z'.repeat(40_000)}`)
    const hit = loadNearestSubdirAgents(cwd, join(cwd, 'pkg', 'deep', 'x.ts'), new Set())
    expect(hit).toContain('[AGENTS.md: pkg]')
    const body = hit?.split('\n').slice(1).join('\n') ?? ''
    expect(body.length).toBe(SUBDIR_AGENTS_CHAR_CAP)
  })

  test('returns undefined when only the project-root file exists', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'AGENTS.md'), 'ROOT_ONLY\n')
    expect(loadNearestSubdirAgents(cwd, join(cwd, 'src', 'a.ts'), new Set())).toBeUndefined()
  })

  test('falls back to CLAUDE.md when AGENTS.md is missing', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'lib'), { recursive: true })
    writeFileSync(join(cwd, 'lib', 'CLAUDE.md'), 'CLAUDE_ONLY\n')
    const hit = loadNearestSubdirAgents(cwd, join(cwd, 'lib', 'x.ts'), new Set())
    expect(hit).toContain('CLAUDE_ONLY')
  })

  test('skips empty and NUL files', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'pkg'), { recursive: true })
    writeFileSync(join(cwd, 'pkg', 'AGENTS.md'), '')
    expect(loadNearestSubdirAgents(cwd, join(cwd, 'pkg', 'a.ts'), new Set())).toBeUndefined()
    writeFileSync(join(cwd, 'pkg', 'AGENTS.md'), 'ok\0bad')
    expect(loadNearestSubdirAgents(cwd, join(cwd, 'pkg', 'a.ts'), new Set())).toBeUndefined()
  })

  test('accepts a directory path as the touch target', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'pkg'), { recursive: true })
    writeFileSync(join(cwd, 'pkg', 'AGENTS.md'), 'DIR_TOUCH\n')
    const hit = loadNearestSubdirAgents(cwd, join(cwd, 'pkg'), new Set())
    expect(hit).toContain('DIR_TOUCH')
  })

  test('claude mode skips AGENTS.md and injects CLAUDE.md', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'pkg'), { recursive: true })
    writeFileSync(join(cwd, 'pkg', 'AGENTS.md'), 'AGENTS_ONLY\n')
    expect(loadNearestSubdirAgents(cwd, join(cwd, 'pkg', 'a.ts'), new Set(), 'claude')).toBeUndefined()
    writeFileSync(join(cwd, 'pkg', 'CLAUDE.md'), 'CLAUDE_ONLY\n')
    const hit = loadNearestSubdirAgents(cwd, join(cwd, 'pkg', 'a.ts'), new Set(), 'claude')
    expect(hit).toContain('[AGENTS.md: pkg]')
    expect(hit).toContain('CLAUDE_ONLY')
    expect(hit).not.toContain('AGENTS_ONLY')
  })

  test('agents-fallback prefers CLAUDE.md over AGENTS.md in that directory', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'lib'), { recursive: true })
    writeFileSync(join(cwd, 'lib', 'AGENTS.md'), 'AGENTS_WINS\n')
    writeFileSync(join(cwd, 'lib', 'CLAUDE.md'), 'CLAUDE_ONLY\n')
    const hit = loadNearestSubdirAgents(cwd, join(cwd, 'lib', 'x.ts'), new Set(), 'agents-fallback')
    expect(hit).toContain('CLAUDE_ONLY')
    expect(hit).not.toContain('AGENTS_WINS')
  })

  test('ignores paths outside cwd', () => {
    const cwd = tempDir()
    const other = tempDir()
    mkdirSync(join(other, 'pkg'), { recursive: true })
    writeFileSync(join(other, 'pkg', 'AGENTS.md'), 'OUTSIDE\n')
    expect(loadNearestSubdirAgents(cwd, join(other, 'pkg', 'a.ts'), new Set())).toBeUndefined()
  })
})
