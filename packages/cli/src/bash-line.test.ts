import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBangLine, runBangCommand } from './bash-line'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raven-bash-line-'))
  tempDirs.push(dir)
  return dir
}

describe('parseBangLine', () => {
  test('bang prefix and /bash become bash', () => {
    expect(parseBangLine('!ls')).toEqual({ kind: 'bash', command: 'ls' })
    expect(parseBangLine('! ls -la')).toEqual({ kind: 'bash', command: 'ls -la' })
    expect(parseBangLine('!!')).toEqual({ kind: 'bash', command: '!' })
    expect(parseBangLine('/bash cmd')).toEqual({ kind: 'bash', command: 'cmd' })
    expect(parseBangLine('/bash   ls -la')).toEqual({ kind: 'bash', command: 'ls -la' })
  })

  test('plain text is other', () => {
    expect(parseBangLine('hello')).toEqual({ kind: 'other', text: 'hello' })
    expect(parseBangLine('/bashcmd')).toEqual({ kind: 'other', text: '/bashcmd' })
  })
})

describe('runBangCommand', () => {
  test('echo hi in a tmp cwd', () => {
    const cwd = tempCwd()
    const result = runBangCommand('echo hi', cwd)
    expect(result.code).toBe(0)
    expect(result.text).toBe('hi\n')
  })

  test('uses cwd and combines stdout with stderr', () => {
    const cwd = tempCwd()
    writeFileSync(join(cwd, 'note.txt'), 'from-cwd')
    const result = runBangCommand('cat note.txt; echo err >&2', cwd)
    expect(result.code).toBe(0)
    expect(result.text).toContain('from-cwd')
    expect(result.text).toContain('err')
  })

  test('refuses an empty command', () => {
    const cwd = tempCwd()
    expect(runBangCommand('', cwd)).toEqual({ text: 'empty command', code: 1 })
    expect(runBangCommand('   ', cwd)).toEqual({ text: 'empty command', code: 1 })
  })
})
