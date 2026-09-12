import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPlanFilePath, planFilePath } from './plan-file'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ravenclaw-plan-file-'))
  tempDirs.push(dir)
  return dir
}

describe('planFilePath', () => {
  test('joins cwd/.ravenclaw/plan.md', () => {
    expect(planFilePath('/tmp/proj')).toBe(join('/tmp/proj', '.ravenclaw', 'plan.md'))
  })
})

describe('isPlanFilePath', () => {
  test('true only for cwd/.ravenclaw/plan.md', () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, '.ravenclaw'), { recursive: true })
    writeFileSync(join(cwd, '.ravenclaw', 'plan.md'), '# plan\n')
    expect(isPlanFilePath(cwd, join(cwd, '.ravenclaw', 'plan.md'))).toBe(true)
    expect(isPlanFilePath(cwd, join('.ravenclaw', 'plan.md'))).toBe(true)
    expect(isPlanFilePath(cwd, join(cwd, 'other.md'))).toBe(false)
    expect(isPlanFilePath(cwd, join(cwd, '.ravenclaw', 'notes.md'))).toBe(false)
  })

  test('false for missing cwd, empty args, and symlink escapes', () => {
    expect(isPlanFilePath('', 'x')).toBe(false)
    expect(isPlanFilePath('/tmp', '')).toBe(false)
    expect(isPlanFilePath(join(tempDir(), 'missing'), 'plan.md')).toBe(false)

    const cwd = tempDir()
    const outside = tempDir()
    mkdirSync(join(cwd, '.ravenclaw'), { recursive: true })
    writeFileSync(join(outside, 'plan.md'), 'escape\n')
    try {
      symlinkSync(join(outside, 'plan.md'), join(cwd, '.ravenclaw', 'plan.md'))
    } catch {
      return
    }
    expect(isPlanFilePath(cwd, join(cwd, '.ravenclaw', 'plan.md'))).toBe(false)
  })
})
