import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandAtIncludes, loadProjectFiles } from './project-files'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-project-files-'))
  tempDirs.push(dir)
  return dir
}

describe('loadProjectFiles', () => {
  test('closer AGENTS.md wins over farther parent when budget is tight', () => {
    const parent = tempDir()
    const child = join(parent, 'nested')
    mkdirSync(child)
    writeFileSync(join(parent, 'AGENTS.md'), `FAR_PARENT_AGENTS\n${'P'.repeat(70_000)}`)
    writeFileSync(join(child, 'AGENTS.md'), 'CHILD_UNIQUE_MARKER\n')

    const loaded = loadProjectFiles(child)
    expect(loaded).toContain('CHILD_UNIQUE_MARKER')
    expect(loaded.length).toBeLessThanOrEqual(60_000)
    expect(loaded).not.toContain('FAR_PARENT_AGENTS\n' + 'P'.repeat(70_000))
    const parentChars = (loaded.match(/P/g) ?? []).length
    expect(parentChars).toBeLessThanOrEqual(40_000)
  })

  test('loads .ravenclaw/rules/*.md and RAVEN.local.md', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.ravenclaw', 'rules'), { recursive: true })
    writeFileSync(join(dir, 'RAVEN.local.md'), 'LOCAL_OVERLAY_MARKER\n')
    writeFileSync(join(dir, '.ravenclaw', 'rules', 'style.md'), 'RULE_STYLE_MARKER\n')
    const loaded = loadProjectFiles(dir)
    expect(loaded).toContain('LOCAL_OVERLAY_MARKER')
    expect(loaded).toContain('RULE_STYLE_MARKER')
  })

  test('caps each file at 40_000 chars', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'AGENTS.md'), 'Q'.repeat(45_000))
    const loaded = loadProjectFiles(dir)
    const count = (loaded.match(/Q/g) ?? []).length
    expect(count).toBe(40_000)
    expect(loaded.length).toBeLessThanOrEqual(60_000)
  })

  test('caps concatenated output at 60_000 chars including @path includes', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'AGENTS.md'), `${'A'.repeat(25_000)}\n@extra.md\n`)
    writeFileSync(join(dir, 'extra.md'), 'B'.repeat(45_000))

    const loaded = loadProjectFiles(dir)
    expect(loaded.length).toBeLessThanOrEqual(60_000)
    expect(loaded).toContain('A')
    expect(loaded).toContain('B')
    expect((loaded.match(/A/g) ?? []).length).toBe(25_000)
    expect((loaded.match(/B/g) ?? []).length).toBeGreaterThan(0)
    expect((loaded.match(/A/g) ?? []).length + (loaded.match(/B/g) ?? []).length).toBeLessThanOrEqual(
      60_000,
    )
  })

  test('@path cycle does not infinite-loop', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'AGENTS.md'), 'ROOT\n@a.md\n')
    writeFileSync(join(dir, 'a.md'), 'AAA\n@b.md\n')
    writeFileSync(join(dir, 'b.md'), 'BBB\n@a.md\n')

    const loaded = loadProjectFiles(dir)
    expect(loaded).toContain('ROOT')
    expect(loaded).toContain('AAA')
    expect(loaded).toContain('BBB')
    expect((loaded.match(/AAA/g) ?? []).length).toBe(1)
    expect((loaded.match(/BBB/g) ?? []).length).toBe(1)
  })
})

describe('expandAtIncludes', () => {
  test('ignores missing includes and does not execute files', () => {
    const dir = tempDir()
    const acc = { used: 0, seen: new Set<string>() }
    const text = 'before\n@missing.md\nafter\n'
    const expanded = expandAtIncludes(text, dir, acc)
    expect(expanded).toContain('before')
    expect(expanded).toContain('after')
    expect(expanded).not.toContain('undefined')
  })

  test('cycle-safe expansion via seen set', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'loop.md'), 'LOOP\n@loop.md\n')
    const acc = { used: 0, seen: new Set<string>() }
    const expanded = expandAtIncludes('START\n@loop.md\nEND\n', dir, acc)
    expect(expanded).toContain('START')
    expect(expanded).toContain('LOOP')
    expect(expanded).toContain('END')
    expect((expanded.match(/LOOP/g) ?? []).length).toBe(1)
  })
})
