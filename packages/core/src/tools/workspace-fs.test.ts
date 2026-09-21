import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertInsideWorkspace, createWorkspaceFs } from './workspace-fs'
import {
  createDockerTerminalBackend,
  type TerminalRunRequest,
} from './terminal-backend'

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

function fakeDocker(runCommand: (req: TerminalRunRequest) => Promise<{
  stdout: string
  stderr: string
  exitCode: number
}>) {
  return createDockerTerminalBackend({ image: 'bash:5', runCommand })
}

describe('createWorkspaceFs', () => {
  test('rejects path outside cwd without exec', async () => {
    const cwd = fixtureRoot()
    const calls: unknown[] = []
    const fs = createWorkspaceFs({ cwd })
    await expect(fs.readFile('/etc/passwd')).rejects.toThrow(/outside workspace/)
    expect(calls).toHaveLength(0)
  })

  test('local workspace fs reads host file under cwd', async () => {
    const cwd = fixtureRoot()
    writeFileSync(join(cwd, 'a.txt'), 'hi')
    expect(await createWorkspaceFs({ cwd }).readFile(join(cwd, 'a.txt'))).toBe('hi')
  })

  test('writeFile outside cwd throws and does not create the file', async () => {
    const cwd = fixtureRoot()
    const fs = createWorkspaceFs({ cwd })
    await expect(fs.writeFile('/tmp/raven-outside.txt', 'x')).rejects.toThrow(/outside workspace/)
    expect(existsSync(OUTSIDE_FILE)).toBe(false)
  })

  test('writeFile and readFile operate on files under cwd', async () => {
    const cwd = fixtureRoot()
    const fs = createWorkspaceFs({ cwd })
    const path = join(cwd, 'b.txt')
    await fs.writeFile(path, 'ok')
    expect(await fs.readFile(path)).toBe('ok')
    expect(await fs.readFile('b.txt')).toBe('ok')
  })

  test('mkdir stat readdir unlink and realpath stay inside cwd', async () => {
    const cwd = fixtureRoot()
    const fs = createWorkspaceFs({ cwd })
    await fs.mkdir(join(cwd, 'sub'))
    await fs.writeFile(join(cwd, 'sub', 'c.txt'), 'c')
    const listed = await fs.readdir(join(cwd, 'sub'))
    expect(listed).toEqual([{ name: 'c.txt', isFile: true, isDir: false }])
    const st = await fs.stat(join(cwd, 'sub', 'c.txt'))
    expect(st.exists).toBe(true)
    expect(st.isFile).toBe(true)
    expect(st.isDir).toBe(false)
    expect(st.size).toBe(1)
    expect(st.mtimeMs).toBeGreaterThan(0)
    expect((await fs.stat(join(cwd, 'missing.txt'))).exists).toBe(false)
    expect(fs.realpath(join(cwd, 'sub'))).toBe(fs.realpath('sub'))
    await fs.unlink(join(cwd, 'sub', 'c.txt'))
    expect((await fs.stat(join(cwd, 'sub', 'c.txt'))).exists).toBe(false)
  })

  test('relative parent path is outside workspace', async () => {
    const cwd = fixtureRoot()
    const fs = createWorkspaceFs({ cwd })
    await expect(fs.readFile('../secret.txt')).rejects.toThrow(/outside workspace/)
    await expect(fs.writeFile(join(cwd, '..', 'escape.txt'), 'x')).rejects.toThrow(/outside workspace/)
    await expect(fs.mkdir(join(cwd, '..', 'escape-dir'))).rejects.toThrow(/outside workspace/)
    await expect(fs.stat('/etc')).rejects.toThrow(/outside workspace/)
    await expect(fs.readdir('/tmp')).rejects.toThrow(/outside workspace/)
    await expect(fs.unlink('/tmp/raven-outside.txt')).rejects.toThrow(/outside workspace/)
    expect(() => fs.realpath('/etc/passwd')).toThrow(/outside workspace/)
  })

  test('stat maps only ENOENT to exists:false and rethrows other errors', async () => {
    const cwd = fixtureRoot()
    const fs = createWorkspaceFs({ cwd })
    expect((await fs.stat(join(cwd, 'missing.txt'))).exists).toBe(false)
    const hidden = join(cwd, 'hidden')
    mkdirSync(hidden)
    writeFileSync(join(hidden, 'secret.txt'), 'x')
    chmodSync(hidden, 0)
    try {
      await expect(fs.stat(join(hidden, 'secret.txt'))).rejects.toThrow()
    } finally {
      chmodSync(hidden, 0o700)
    }
  })

  test('symlink that resolves outside cwd is rejected before I/O', async () => {
    const cwd = fixtureRoot()
    symlinkSync('/etc/passwd', join(cwd, 'link'))
    const fs = createWorkspaceFs({ cwd })
    await expect(fs.readFile(join(cwd, 'link'))).rejects.toThrow(/outside workspace/)
  })
})

describe('assertInsideWorkspace', () => {
  test('throws outside workspace and returns a jailed host path', () => {
    const cwd = fixtureRoot()
    writeFileSync(join(cwd, 'in.txt'), 'x')
    expect(assertInsideWorkspace(cwd, join(cwd, 'in.txt'))).toContain(cwd)
    expect(() => assertInsideWorkspace(cwd, '/etc/passwd')).toThrow(/outside workspace/)
  })
})

describe('createWorkspaceFs docker exec', () => {
  test('readFile argv contains cwd bind and does not host-read content', async () => {
    const cwd = fixtureRoot()
    writeFileSync(join(cwd, 'a.txt'), 'HOST_ONLY_TOKEN')
    const calls: TerminalRunRequest[] = []
    const exec = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: 'FROM_CONTAINER', stderr: '', exitCode: 0 }
    })
    const fs = createWorkspaceFs({
      cwd,
      exec,
      signal: new AbortController().signal,
    })
    const text = await fs.readFile(join(cwd, 'a.txt'))
    expect(text).toBe('FROM_CONTAINER')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('docker')
    expect(calls[0]?.args).toContain(`${cwd}:${cwd}`)
    expect(calls[0]?.args).toContain('-w')
    expect(calls[0]?.timeoutMs).toBe(30_000)
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM'])
  })

  test('writeFile sends bytes on stdin via tee and not in bash -c', async () => {
    const cwd = fixtureRoot()
    const payload = 'WRITE_PAYLOAD_' + 'x'.repeat(64)
    const calls: TerminalRunRequest[] = []
    const exec = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const fs = createWorkspaceFs({ cwd, exec, signal: new AbortController().signal })
    await fs.writeFile(join(cwd, 'out.txt'), payload)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.stdin).toBe(payload)
    expect(calls[0]?.args.at(-1)).toMatch(/tee/)
    expect(calls[0]?.args.at(-1)).not.toContain(payload)
  })

  test('exec fail does not read or write the host file', async () => {
    const cwd = fixtureRoot()
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'HOST_ONLY_TOKEN')
    const exec = fakeDocker(async () => {
      throw new Error('Cannot connect to the Docker daemon')
    })
    const fs = createWorkspaceFs({ cwd, exec, signal: new AbortController().signal })
    await expect(fs.readFile(path)).rejects.toThrow(/Docker daemon|Read failed|failed/)
    expect(readFileSync(path, 'utf8')).toBe('HOST_ONLY_TOKEN')
    await expect(fs.writeFile(path, 'NEW')).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('HOST_ONLY_TOKEN')
  })

  test('missing file stat is exists false via missing marker', async () => {
    const cwd = fixtureRoot()
    const exec = fakeDocker(async () => ({
      stdout: '__RC_FS_MISSING__\n',
      stderr: '',
      exitCode: 0,
    }))
    const fs = createWorkspaceFs({ cwd, exec, signal: new AbortController().signal })
    const st = await fs.stat(join(cwd, 'missing.txt'))
    expect(st).toEqual({ exists: false, isFile: false, isDir: false, mtimeMs: 0, size: 0 })
  })

  test('outside-cwd throws with no exec', async () => {
    const cwd = fixtureRoot()
    const calls: TerminalRunRequest[] = []
    const exec = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const fs = createWorkspaceFs({ cwd, exec, signal: new AbortController().signal })
    await expect(fs.readFile('/etc/passwd')).rejects.toThrow(/outside workspace/)
    expect(calls).toHaveLength(0)
  })

  test('aborted signal throws AbortError', async () => {
    const cwd = fixtureRoot()
    writeFileSync(join(cwd, 'a.txt'), 'x')
    const ac = new AbortController()
    ac.abort()
    const exec = fakeDocker(async () => ({ stdout: 'nope', stderr: '', exitCode: 0 }))
    const fs = createWorkspaceFs({ cwd, exec, signal: ac.signal })
    await expect(fs.readFile(join(cwd, 'a.txt'))).rejects.toMatchObject({ name: 'AbortError' })
  })
})
