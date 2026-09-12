import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLintBlock, lintWrittenFile } from './lint'

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'ravenclaw-lint-'))
}

describe('lintWrittenFile', () => {
  test('json parse errors become a lint error; valid json is ok', () => {
    const root = fixture()
    const bad = join(root, 'bad.json')
    const good = join(root, 'good.json')
    writeFileSync(bad, '{')
    writeFileSync(good, '{"ok":true}')
    const failed = lintWrittenFile(bad, root)
    const passed = lintWrittenFile(good, root)
    expect(failed?.status).toBe('error')
    expect(passed).toEqual({ path: good, status: 'ok', detail: 'ok' })
  })

  test('skips typescript and unknown extensions; never runs tsc', () => {
    const root = fixture()
    const ts = join(root, 'a.ts')
    const txt = join(root, 'a.txt')
    writeFileSync(ts, 'const x: number = 1')
    writeFileSync(txt, 'hello')
    expect(lintWrittenFile(ts, root)).toBeUndefined()
    expect(lintWrittenFile(txt, root)).toBeUndefined()
  })

  test('python check does not write __pycache__', () => {
    const root = fixture()
    const file = join(root, 'a.py')
    writeFileSync(file, 'x = 1\n')
    lintWrittenFile(file, root)
    expect(existsSync(join(root, '__pycache__'))).toBe(false)
  })

  test('skips files outside the cwd tree', () => {
    const root = fixture()
    const outside = join(tmpdir(), `ravenclaw-lint-out-${Date.now()}.json`)
    writeFileSync(outside, '{')
    expect(lintWrittenFile(outside, root)).toBeUndefined()
  })

  test('appendLintBlock caps output and omits empty reports', () => {
    expect(appendLintBlock('Wrote a.txt', [undefined])).toBe('Wrote a.txt')
    const out = appendLintBlock('Wrote a.json', [
      { path: '/tmp/a.json', status: 'error', detail: 'x'.repeat(2_000) },
    ])
    expect(out.startsWith('Wrote a.json\n\n<lint>\n')).toBe(true)
    expect(out.endsWith('\n</lint>')).toBe(true)
    expect(out.length).toBeLessThan(1_200)
  })
})
