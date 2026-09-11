import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FILE_TREE_CHAR_CAP,
  FILE_TREE_MAX_DEPTH,
  FILE_TREE_MAX_ENTRIES,
  loadProjectFileTree,
} from './file-tree'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-file-tree-'))
  tempDirs.push(dir)
  return dir
}

function write(dir: string, rel: string, body = 'x\n'): void {
  const abs = join(dir, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
}

describe('loadProjectFileTree', () => {
  test('empty or missing cwd returns an empty string', () => {
    const dir = tempDir()
    expect(loadProjectFileTree('')).toBe('')
    expect(loadProjectFileTree(join(dir, 'missing'))).toBe('')
    expect(loadProjectFileTree(dir)).toBe('')
  })

  test('lists posix-relative paths sorted by name', () => {
    const dir = tempDir()
    write(dir, 'z.ts')
    write(dir, 'src/foo.ts')
    write(dir, 'README.md')
    expect(loadProjectFileTree(dir)).toBe(['README.md', 'src/foo.ts', 'z.ts'].join('\n'))
  })

  test('skips ignored directories', () => {
    const dir = tempDir()
    write(dir, 'src/app.ts')
    for (const ignored of ['node_modules', '.git', 'dist', 'build', '.next', 'coverage']) {
      write(dir, `${ignored}/hidden.ts`)
    }
    const tree = loadProjectFileTree(dir)
    expect(tree).toBe('src/app.ts')
    expect(tree).not.toContain('node_modules')
    expect(tree).not.toContain('.git')
    expect(tree).not.toContain('dist')
    expect(tree).not.toContain('build')
    expect(tree).not.toContain('.next')
    expect(tree).not.toContain('coverage')
  })

  test('stops at max depth 4', () => {
    const dir = tempDir()
    write(dir, 'a/b/c/d/kept.ts')
    write(dir, 'a/b/c/d/e/dropped.ts')
    const tree = loadProjectFileTree(dir)
    expect(tree).toContain('a/b/c/d/kept.ts')
    expect(tree).not.toContain('dropped.ts')
    expect(FILE_TREE_MAX_DEPTH).toBe(4)
  })

  test('defaults to 80 entries and honors maxEntries', () => {
    const dir = tempDir()
    for (let i = 0; i < FILE_TREE_MAX_ENTRIES + 10; i++) {
      write(dir, `f${String(i).padStart(3, '0')}.ts`)
    }
    const defaultTree = loadProjectFileTree(dir)
    expect(defaultTree.split('\n')).toHaveLength(FILE_TREE_MAX_ENTRIES)

    const capped = loadProjectFileTree(dir, { maxEntries: 3 })
    expect(capped.split('\n')).toHaveLength(3)
    expect(capped).toBe(['f000.ts', 'f001.ts', 'f002.ts'].join('\n'))
    expect(loadProjectFileTree(dir, { maxEntries: 0 })).toBe('')
  })

  test('caps joined output near 4000 characters on whole lines', () => {
    const dir = tempDir()
    for (let i = 0; i < FILE_TREE_MAX_ENTRIES; i++) {
      write(dir, `${String(i).padStart(2, '0')}-${'n'.repeat(60)}.txt`)
    }
    const tree = loadProjectFileTree(dir)
    expect(tree.length).toBeGreaterThan(0)
    expect(tree.length).toBeLessThanOrEqual(FILE_TREE_CHAR_CAP)
    const lines = tree.split('\n')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => line.endsWith('.txt'))).toBe(true)
    expect(tree).not.toContain('Claude Code')
    expect(tree).not.toContain('Anthropic')
    expect(tree).not.toContain('Hermes')
    expect(tree).not.toContain('Freebuff')
  })
})
