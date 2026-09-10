import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MEMORY_FILE_CHAR_CAP,
  MEMORY_TOTAL_CHAR_CAP,
  loadMemorySnapshot,
} from './memory'

const ENV_KEY = 'RAVENCLAW_HOME'
const VENDOR_BRANDS = ['Claude Code', 'Anthropic', 'Hermes', 'Freebuff'] as const

let savedHome: string | undefined
const tempDirs: string[] = []

beforeEach(() => {
  savedHome = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (savedHome === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedHome
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('loadMemorySnapshot', () => {
  test('missing files return an empty string', () => {
    const home = tempDir('ravenclaw-memory-home-')
    const cwd = tempDir('ravenclaw-memory-cwd-')
    expect(loadMemorySnapshot(cwd, home)).toBe('')
  })

  test('omits empty section headers when only one kind exists', () => {
    const home = tempDir('ravenclaw-memory-home-')
    const cwd = tempDir('ravenclaw-memory-cwd-')
    writeFileSync(join(home, 'USER.md'), 'only-user')
    const userOnly = loadMemorySnapshot(cwd, home)
    expect(userOnly).toContain('User memory:')
    expect(userOnly).toContain('only-user')
    expect(userOnly).not.toContain('Agent memory:')

    writeFileSync(join(home, 'USER.md'), '')
    writeFileSync(join(cwd, 'MEMORY.md'), 'only-agent')
    const agentOnly = loadMemorySnapshot(cwd, home)
    expect(agentOnly).toContain('Agent memory:')
    expect(agentOnly).toContain('only-agent')
    expect(agentOnly).not.toContain('User memory:')
  })

  test('USER.md and MEMORY.md appear with labels', () => {
    const home = tempDir('ravenclaw-memory-home-')
    const cwd = tempDir('ravenclaw-memory-cwd-')
    writeFileSync(join(home, 'USER.md'), 'home-user-body')
    writeFileSync(join(home, 'MEMORY.md'), 'home-agent-body')
    const snapshot = loadMemorySnapshot(cwd, home)
    expect(snapshot).toContain('User memory:')
    expect(snapshot).toContain('home-user-body')
    expect(snapshot).toContain('Agent memory:')
    expect(snapshot).toContain('home-agent-body')
    expect(snapshot.indexOf('User memory:')).toBeLessThan(snapshot.indexOf('home-user-body'))
    expect(snapshot.indexOf('home-user-body')).toBeLessThan(snapshot.indexOf('Agent memory:'))
    expect(snapshot.indexOf('Agent memory:')).toBeLessThan(snapshot.indexOf('home-agent-body'))
  })

  test('caps each file at 8_000 chars with a one-line truncation note', () => {
    const home = tempDir('ravenclaw-memory-home-')
    const cwd = tempDir('ravenclaw-memory-cwd-')
    const body = `${'Q'.repeat(MEMORY_FILE_CHAR_CAP)}UNIQUE_TAIL`
    writeFileSync(join(home, 'USER.md'), body)
    const snapshot = loadMemorySnapshot(cwd, home)
    expect((snapshot.match(/Q/g) ?? []).length).toBe(MEMORY_FILE_CHAR_CAP)
    expect(snapshot).not.toContain('UNIQUE_TAIL')
    expect(snapshot).toMatch(/truncated/i)
    expect(snapshot.trimEnd().split('\n').at(-1)).toMatch(/truncated/i)
  })

  test('caps concatenated file bodies at 16_000 chars with a one-line note', () => {
    const home = tempDir('ravenclaw-memory-home-')
    const cwd = tempDir('ravenclaw-memory-cwd-')
    const first = 7_000
    writeFileSync(join(home, 'USER.md'), 'Q'.repeat(first))
    writeFileSync(join(cwd, 'USER.md'), 'W'.repeat(first))
    writeFileSync(join(cwd, 'MEMORY.md'), `${'Z'.repeat(first)}TAIL_SHOULD_DROP`)
    const snapshot = loadMemorySnapshot(cwd, home)
    expect((snapshot.match(/Q/g) ?? []).length).toBe(first)
    expect((snapshot.match(/W/g) ?? []).length).toBe(first)
    expect(snapshot).not.toContain('TAIL_SHOULD_DROP')
    const zCount = (snapshot.match(/Z/g) ?? []).length
    expect(zCount).toBe(MEMORY_TOTAL_CHAR_CAP - first - first)
    expect(zCount).toBeLessThan(first)
    expect(snapshot).toMatch(/truncated/i)
  })

  test('project files add after user-global and both are shown', () => {
    const home = tempDir('ravenclaw-memory-home-')
    const cwd = tempDir('ravenclaw-memory-cwd-')
    mkdirSync(join(cwd, '.ravenclaw'))
    writeFileSync(join(home, 'USER.md'), 'HOME_USER')
    writeFileSync(join(home, 'MEMORY.md'), 'HOME_AGENT')
    writeFileSync(join(cwd, 'USER.md'), 'CWD_USER')
    writeFileSync(join(cwd, 'MEMORY.md'), 'CWD_AGENT')
    writeFileSync(join(cwd, '.ravenclaw', 'USER.md'), 'DOT_USER')
    writeFileSync(join(cwd, '.ravenclaw', 'MEMORY.md'), 'DOT_AGENT')

    const snapshot = loadMemorySnapshot(cwd, home)
    expect(snapshot).toContain('HOME_USER')
    expect(snapshot).toContain('CWD_USER')
    expect(snapshot).toContain('DOT_USER')
    expect(snapshot).toContain('HOME_AGENT')
    expect(snapshot).toContain('CWD_AGENT')
    expect(snapshot).toContain('DOT_AGENT')
    expect(snapshot.indexOf('HOME_USER')).toBeLessThan(snapshot.indexOf('CWD_USER'))
    expect(snapshot.indexOf('CWD_USER')).toBeLessThan(snapshot.indexOf('DOT_USER'))
    expect(snapshot.indexOf('HOME_AGENT')).toBeLessThan(snapshot.indexOf('CWD_AGENT'))
    expect(snapshot.indexOf('CWD_AGENT')).toBeLessThan(snapshot.indexOf('DOT_AGENT'))
    expect(snapshot.indexOf('DOT_USER')).toBeLessThan(snapshot.indexOf('Agent memory:'))
  })

  test('does not walk parent directories for project files', () => {
    const home = tempDir('ravenclaw-memory-home-')
    const parent = tempDir('ravenclaw-memory-parent-')
    const cwd = join(parent, 'nested')
    mkdirSync(cwd)
    writeFileSync(join(parent, 'USER.md'), 'PARENT_USER')
    writeFileSync(join(parent, 'MEMORY.md'), 'PARENT_AGENT')
    writeFileSync(join(cwd, 'USER.md'), 'NESTED_USER')
    const snapshot = loadMemorySnapshot(cwd, home)
    expect(snapshot).toContain('NESTED_USER')
    expect(snapshot).not.toContain('PARENT_USER')
    expect(snapshot).not.toContain('PARENT_AGENT')
  })

  test('RAVENCLAW_HOME override is used when home is omitted', () => {
    const envHome = tempDir('ravenclaw-memory-env-home-')
    const otherHome = tempDir('ravenclaw-memory-other-home-')
    const cwd = tempDir('ravenclaw-memory-cwd-')
    writeFileSync(join(envHome, 'USER.md'), 'ENV_HOME_USER')
    writeFileSync(join(otherHome, 'USER.md'), 'OTHER_HOME_USER')
    process.env[ENV_KEY] = envHome
    expect(loadMemorySnapshot(cwd)).toContain('ENV_HOME_USER')
    expect(loadMemorySnapshot(cwd)).not.toContain('OTHER_HOME_USER')
    expect(loadMemorySnapshot(cwd, otherHome)).toContain('OTHER_HOME_USER')
    expect(loadMemorySnapshot(cwd, otherHome)).not.toContain('ENV_HOME_USER')
  })

  test('skips binary files that contain NUL', () => {
    const home = tempDir('ravenclaw-memory-home-')
    const cwd = tempDir('ravenclaw-memory-cwd-')
    writeFileSync(join(home, 'USER.md'), Buffer.from('user\0secret'))
    writeFileSync(join(cwd, 'MEMORY.md'), 'safe-agent')
    const snapshot = loadMemorySnapshot(cwd, home)
    expect(snapshot).not.toContain('secret')
    expect(snapshot).not.toContain('User memory:')
    expect(snapshot).toContain('Agent memory:')
    expect(snapshot).toContain('safe-agent')
  })

  test('omits vendor brand strings', () => {
    const home = tempDir('ravenclaw-memory-home-')
    const cwd = tempDir('ravenclaw-memory-cwd-')
    writeFileSync(join(home, 'USER.md'), 'prefers short diffs')
    writeFileSync(join(cwd, 'MEMORY.md'), 'use bun test')
    const snapshot = loadMemorySnapshot(cwd, home)
    for (const brand of VENDOR_BRANDS) {
      expect(snapshot).not.toContain(brand)
    }
  })
})
