import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceFs } from './workspace-fs'

const tempDirs: string[] = []
const OUTSIDE_FILE = '/tmp/raven-outside.txt'

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
  rmSync(OUTSIDE_FILE, { force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ws-'))
  tempDirs.push(root)
  return root
}

describe('createWorkspaceFs', () => {
  test('docker workspace fs rejects path outside cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ws-'))
    tempDirs.push(cwd)
    const fs = createWorkspaceFs({ cwd, backend: 'docker' })
    expect(() => fs.readFile('/etc/passwd')).toThrow(/outside workspace/)
  })

  test('local workspace fs reads host file under cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ws-'))
    tempDirs.push(cwd)
    writeFileSync(join(cwd, 'a.txt'), 'hi')
    expect(createWorkspaceFs({ cwd, backend: 'local' }).readFile(join(cwd, 'a.txt'))).toBe('hi')
  })

  test('writeFile outside cwd throws and does not create the file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ws-'))
    tempDirs.push(cwd)
    const fs = createWorkspaceFs({ cwd, backend: 'docker' })
    expect(() => fs.writeFile('/tmp/raven-outside.txt', 'x')).toThrow(/outside workspace/)
    expect(existsSync(OUTSIDE_FILE)).toBe(false)
  })

  test('writeFile and readFile operate on files under cwd', () => {
    const cwd = fixtureRoot()
    const fs = createWorkspaceFs({ cwd, backend: 'local' })
    const path = join(cwd, 'b.txt')
    fs.writeFile(path, 'ok')
    expect(fs.readFile(path)).toBe('ok')
    expect(fs.readFile('b.txt')).toBe('ok')
  })

  test('mkdir stat readdir unlink and realpath stay inside cwd', () => {
    const cwd = fixtureRoot()
    const fs = createWorkspaceFs({ cwd, backend: 'docker' })
    fs.mkdir(join(cwd, 'sub'))
    fs.writeFile(join(cwd, 'sub', 'c.txt'), 'c')
    const listed = fs.readdir(join(cwd, 'sub'))
    expect(listed).toEqual([{ name: 'c.txt', isFile: true, isDir: false }])
    const st = fs.stat(join(cwd, 'sub', 'c.txt'))
    expect(st.exists).toBe(true)
    expect(st.isFile).toBe(true)
    expect(st.isDir).toBe(false)
    expect(st.size).toBe(1)
    expect(st.mtimeMs).toBeGreaterThan(0)
    expect(fs.stat(join(cwd, 'missing.txt')).exists).toBe(false)
    expect(fs.realpath(join(cwd, 'sub'))).toBe(fs.realpath('sub'))
    fs.unlink(join(cwd, 'sub', 'c.txt'))
    expect(fs.stat(join(cwd, 'sub', 'c.txt')).exists).toBe(false)
  })

  test('relative parent path is outside workspace', () => {
    const cwd = fixtureRoot()
    const fs = createWorkspaceFs({ cwd, backend: 'local' })
    expect(() => fs.readFile('../secret.txt')).toThrow(/outside workspace/)
    expect(() => fs.writeFile(join(cwd, '..', 'escape.txt'), 'x')).toThrow(/outside workspace/)
    expect(() => fs.mkdir(join(cwd, '..', 'escape-dir'))).toThrow(/outside workspace/)
    expect(() => fs.stat('/etc')).toThrow(/outside workspace/)
    expect(() => fs.readdir('/tmp')).toThrow(/outside workspace/)
    expect(() => fs.unlink('/tmp/raven-outside.txt')).toThrow(/outside workspace/)
    expect(() => fs.realpath('/etc/passwd')).toThrow(/outside workspace/)
  })

  test('symlink that resolves outside cwd is rejected before I/O', () => {
    const cwd = fixtureRoot()
    symlinkSync('/etc/passwd', join(cwd, 'link'))
    const fs = createWorkspaceFs({ cwd, backend: 'docker' })
    expect(() => fs.readFile(join(cwd, 'link'))).toThrow(/outside workspace/)
  })
})
