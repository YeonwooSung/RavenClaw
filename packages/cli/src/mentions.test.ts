import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandMentions } from './mentions'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raven-mentions-'))
  tempDirs.push(dir)
  return dir
}

describe('expandMentions', () => {
  test('attaches existing path-ish files and keeps the @token', () => {
    const cwd = tempCwd()
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(cwd, 'notes.md'), 'hello\n')
    const result = expandMentions('see @src/a.ts and @notes.md', cwd)
    expect(result.files).toEqual(['src/a.ts', 'notes.md'])
    expect(result.agents).toEqual([])
    expect(result.text.startsWith('see @src/a.ts and @notes.md')).toBe(true)
    expect(result.text).toContain('<file path="src/a.ts">\nexport const a = 1\n\n</file>')
    expect(result.text).toContain('<file path="notes.md">\nhello\n\n</file>')
  })

  test('collects default and custom agent names', () => {
    const cwd = tempCwd()
    const defaults = expandMentions('ask @general or @file-finder or @reviewer', cwd)
    expect(defaults.agents).toEqual(['general', 'file-finder', 'reviewer'])
    expect(defaults.files).toEqual([])
    expect(defaults.text).toBe('ask @general or @file-finder or @reviewer')

    const custom = expandMentions('ping @planner', cwd, ['planner'])
    expect(custom.agents).toEqual(['planner'])
    expect(expandMentions('ping @planner', cwd, []).agents).toEqual([])
  })

  test('leaves unknown @words and emails as-is', () => {
    const cwd = tempCwd()
    const text = 'email a@b.c and @not-an-agent please'
    expect(expandMentions(text, cwd)).toEqual({ text, files: [], agents: [] })
  })

  test('skips missing files, directories, and paths outside cwd', () => {
    const cwd = tempCwd()
    mkdirSync(join(cwd, 'src'))
    const outside = join(cwd, '..', `outside-${Date.now()}.txt`)
    writeFileSync(outside, 'secret\n')
    tempDirs.push(outside)
    const text = 'x @missing.ts y @src z @../outside.txt'
    const result = expandMentions(text, cwd)
    expect(result.files).toEqual([])
    expect(result.text).toBe(text)
    expect(result.text).not.toContain('secret')
  })

  test('caps attached files at 3 and contents at 20000 chars', () => {
    const cwd = tempCwd()
    writeFileSync(join(cwd, 'a.ts'), 'A')
    writeFileSync(join(cwd, 'b.ts'), 'B')
    writeFileSync(join(cwd, 'c.ts'), 'C')
    writeFileSync(join(cwd, 'd.ts'), 'D')
    writeFileSync(join(cwd, 'big.ts'), 'x'.repeat(20_050))
    const many = expandMentions('@a.ts @b.ts @c.ts @d.ts', cwd)
    expect(many.files).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(many.text).not.toContain('path="d.ts"')

    const big = expandMentions('read @big.ts', cwd)
    expect(big.files).toEqual(['big.ts'])
    const open = big.text.indexOf('<file path="big.ts">\n')
    const close = big.text.indexOf('\n</file>', open)
    const body = big.text.slice(open + '<file path="big.ts">\n'.length, close)
    expect(body).toHaveLength(20_000)
  })

  test('does not inline image files; those go through collectUserImages', () => {
    const cwd = tempCwd()
    writeFileSync(join(cwd, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
    writeFileSync(join(cwd, 'notes.md'), 'hello\n')
    const result = expandMentions('see @shot.png and @notes.md', cwd)
    expect(result.files).toEqual(['notes.md'])
    expect(result.text).toContain('see @shot.png and @notes.md')
    expect(result.text).toContain('<file path="notes.md">')
    expect(result.text).not.toContain('path="shot.png"')
  })

  test('does not follow a symlink out of cwd', () => {
    const cwd = tempCwd()
    const outsideDir = mkdtempSync(join(tmpdir(), 'raven-mentions-out-'))
    tempDirs.push(outsideDir)
    writeFileSync(join(outsideDir, 'secret.txt'), 'nope\n')
    symlinkSync(join(outsideDir, 'secret.txt'), join(cwd, 'link.ts'))
    const result = expandMentions('see @link.ts', cwd)
    expect(result.files).toEqual([])
    expect(result.text).toBe('see @link.ts')
  })
})
