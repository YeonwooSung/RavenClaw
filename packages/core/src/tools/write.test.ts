import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileHistory } from '../session/file-history'
import type { ToolContext, Turn } from '../types'
import { decidePermission } from '../permissions/pipeline'
import { recordReadFile } from './read-files'
import {
  createDockerTerminalBackend,
  type TerminalRunRequest,
} from './terminal-backend'
import { createWriteTool, writeTool } from './write'

const emptyRules = { session: [], user: [], project: [] }

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ravenclaw-write-'))
  tempDirs.push(root)
  return root
}

function makeTurn(cwd: string): Turn {
  return {
    id: 'turn_1',
    sessionId: 'sess_1',
    messages: [],
    round: 1,
    maxRounds: 80,
    graceUsed: false,
    abort: new AbortController(),
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compactGeneration: 0,
    funding: 'byok',
    cwd,
    model: 'dummy',
    readFiles: new Set(),
  }
}

function makeCtx(cwd: string, signal?: AbortSignal, history?: FileHistory): ToolContext {
  const turn = makeTurn(cwd)
  return {
    turn,
    signal: signal ?? turn.abort.signal,
    onProgress() {},
    fileHistory: history,
  }
}

function fakeDocker(runCommand: (req: TerminalRunRequest) => Promise<{
  stdout: string
  stderr: string
  exitCode: number
}>) {
  return createDockerTerminalBackend({ image: 'bash:5', runCommand })
}

function mockHistory(): FileHistory & { snaps: string[] } {
  const snaps: string[] = []
  return {
    snaps,
    beginTurn() {},
    endTurn() {},
    snapshot(path: string) {
      snaps.push(path)
    },
    undo() {
      return { restored: [], removed: [] }
    },
    pendingCount() {
      return snaps.length
    },
    turnWriteCount() {
      return snaps.length
    },
    reset() {},
  }
}

describe('Write', () => {
  test('is an unsafe mutating tool that leftover-asks and blocks interrupt', async () => {
    expect(writeTool.name).toBe('Write')
    expect(writeTool.isConcurrencySafe({ path: 'a.txt', content: 'x' })).toBe(false)
    expect(writeTool.isReadOnly({ path: 'a.txt', content: 'x' })).toBe(false)
    expect(writeTool.interruptBehavior?.()).toBe('block')
    const decision = await writeTool.checkPermissions(
      { path: 'a.txt', content: 'x' },
      makeCtx('/tmp'),
    )
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }
  })

  test('default mode leftover ask stays ask', async () => {
    const decision = await decidePermission({
      name: 'Write',
      input: { path: 'a.txt', content: 'x' },
      tool: writeTool,
      ctx: makeCtx('/tmp'),
      mode: 'default',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message.length).toBeGreaterThan(0)
      expect(decision.saveAs).toBe('session')
    }
  })

  test('dontAsk allows in-tree leftover Write', async () => {
    const decision = await decidePermission({
      name: 'Write',
      input: { path: 'a.txt', content: 'x' },
      tool: writeTool,
      ctx: makeCtx('/tmp'),
      mode: 'dontAsk',
      rules: emptyRules,
    })
    expect(decision.behavior).toBe('allow')
  })

  test('creates a new file including parent directories', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    const out = await writeTool.execute({ path: 'src/new.txt', content: 'created\n' }, ctx)
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(readFileSync(join(root, 'src', 'new.txt'), 'utf8')).toBe('created\n')
  })

  test('overwrites an existing file', async () => {
    const root = fixtureRoot()
    const path = join(root, 'a.txt')
    writeFileSync(path, 'old\n')
    const ctx = makeCtx(root)
    recordReadFile(ctx.turn, path, statSync(path).mtimeMs)
    const out = await writeTool.execute({ path: 'a.txt', content: 'new\n' }, ctx)
    expect(typeof out).toBe('string')
    expect(out.toLowerCase()).not.toMatch(/fail|error|deny/)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new\n')
    expect(ctx.turn.readFiles.has(path)).toBe(true)
  })

  test('Write existing file without Read fails', async () => {
    const cwd = fixtureRoot()
    writeFileSync(join(cwd, 'a.txt'), 'old')
    const ctx = makeCtx(cwd)
    const out = await writeTool.execute({ path: 'a.txt', content: 'new' }, ctx)
    expect(out).toContain('path must be Read first')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('old')
  })

  test('Write new file does not require Read', async () => {
    const cwd = fixtureRoot()
    const ctx = makeCtx(cwd)
    const out = await writeTool.execute({ path: 'b.txt', content: 'new' }, ctx)
    expect(out).toContain('Wrote')
    expect(readFileSync(join(cwd, 'b.txt'), 'utf8')).toBe('new')
  })

  test('Write after Read then external mtime change is stale', async () => {
    const cwd = fixtureRoot()
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'old')
    const ctx = makeCtx(cwd)
    recordReadFile(ctx.turn, path, statSync(path).mtimeMs - 1)
    const out = await writeTool.execute({ path: 'a.txt', content: 'new' }, ctx)
    expect(out).toContain('changed since last Read')
    expect(readFileSync(path, 'utf8')).toBe('old')
  })

  test('hard-denies /etc/shadow without writing', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    const out = await writeTool.execute({ path: '/etc/shadow', content: 'nope\n' }, ctx)
    expect(out.toLowerCase()).toMatch(/deny|denied|protected|refused|not allowed|shadow/)
    expect(existsSync(join(root, 'shadow'))).toBe(false)
  })

  test('execute refuses when the signal is already aborted', async () => {
    const root = fixtureRoot()
    const ac = new AbortController()
    ac.abort()
    const ctx = makeCtx(root, ac.signal)
    await expect(
      writeTool.execute({ path: 'a.txt', content: 'x\n' }, ctx),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
  })

  test('appends a lint block after a successful json write without rolling back', async () => {
    const root = fixtureRoot()
    const ctx = makeCtx(root)
    const out = await writeTool.execute({ path: 'bad.json', content: '{' }, ctx)
    expect(out.startsWith('Wrote bad.json')).toBe(true)
    expect(out).toContain('<lint>')
    expect(out.toLowerCase()).toContain('error')
    expect(readFileSync(join(root, 'bad.json'), 'utf8')).toBe('{')
  })

  test('Write with terminalBackend docker refuses a path outside cwd', async () => {
    const cwd = fixtureRoot()
    const ctx = makeCtx(cwd)
    ctx.turn.terminalBackend = 'docker'
    const out = await writeTool.execute({ path: '/etc/passwd', content: 'x' }, ctx)
    expect(String(out).toLowerCase()).toMatch(/outside workspace|denied|protected/)
  })

  test('createWriteTool without backend still writes a unique file', async () => {
    const root = fixtureRoot()
    const tool = createWriteTool()
    expect(tool.name).toBe('Write')
    expect(tool).not.toBe(writeTool)
    const out = await tool.execute({ path: 'note.txt', content: 'hello factory\n' }, makeCtx(root))
    expect(out).toContain('Wrote')
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('hello factory\n')
  })
})

describe('Write docker backend', () => {
  test('docker write sends stdin and does not host-write on exec fail', async () => {
    const root = fixtureRoot()
    const path = join(root, 'out.txt')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      const script = String(req.args.at(-1))
      if (script.includes('EXISTS') || script.includes('kind=dir')) {
        return { stdout: '__RC_FS_MISSING__\n', stderr: '', exitCode: 0 }
      }
      if (script.includes('mkdir')) return { stdout: '', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 }
    })
    const out = await createWriteTool(backend).execute(
      { path: 'out.txt', content: 'NEW_PAYLOAD' },
      makeCtx(root),
    )
    expect(out).toMatch(/^Write failed:/)
    expect(existsSync(path)).toBe(false)
    expect(calls.some((req) => req.stdin === 'NEW_PAYLOAD' || String(req.args.at(-1)).includes('tee'))).toBe(true)
  })

  test('hard-denied path does not exec', async () => {
    const root = fixtureRoot()
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const out = await createWriteTool(backend).execute(
      { path: '/etc/shadow', content: 'x' },
      makeCtx(root),
    )
    expect(calls).toHaveLength(0)
    expect(out).toMatch(/^Write failed:/)
    expect(out).toMatch(/protected path/)
  })

  test('outside-cwd does not exec', async () => {
    const root = fixtureRoot()
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const out = await createWriteTool(backend).execute(
      { path: '/tmp/raven-outside.txt', content: 'x' },
      makeCtx(root),
    )
    expect(calls).toHaveLength(0)
    expect(out).toMatch(/outside workspace|Write failed:/)
  })

  test('overwrite still requires Read; new file does not', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'old.txt'), 'old')
    const backend = fakeDocker(async (req) => {
      const script = String(req.args.at(-1))
      if (script.includes('EXISTS') || script.includes('kind=dir')) {
        return { stdout: 'EXISTS file 3 1\n', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const denied = await createWriteTool(backend).execute(
      { path: 'old.txt', content: 'new' },
      makeCtx(root),
    )
    expect(denied).toMatch(/must be Read first/)

    const missing = fakeDocker(async (req) => {
      const script = String(req.args.at(-1))
      if (script.includes('EXISTS') || script.includes('kind=dir')) {
        return { stdout: '__RC_FS_MISSING__\n', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const created = await createWriteTool(missing).execute(
      { path: 'fresh.txt', content: 'new' },
      makeCtx(root),
    )
    expect(created).toMatch(/^Wrote /)
    expect(created).not.toMatch(/must be Read first/)
    expect(existsSync(join(root, 'fresh.txt'))).toBe(false)
  })

  test('snapshot runs before the write exec', async () => {
    const root = fixtureRoot()
    const order: string[] = []
    const history = mockHistory()
    const orig = history.snapshot.bind(history)
    history.snapshot = (path: string) => {
      order.push('snapshot')
      orig(path)
    }
    const backend = fakeDocker(async (req) => {
      const script = String(req.args.at(-1))
      if (script.includes('EXISTS') || script.includes('kind=dir')) {
        return { stdout: '__RC_FS_MISSING__\n', stderr: '', exitCode: 0 }
      }
      if (script.includes('mkdir')) return { stdout: '', stderr: '', exitCode: 0 }
      if (script.includes('tee') || req.stdin !== undefined) {
        order.push('write')
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const out = await createWriteTool(backend).execute(
      { path: 'out.txt', content: 'SNAP_PAYLOAD' },
      makeCtx(root, undefined, history),
    )
    expect(out).toMatch(/^Wrote /)
    expect(order).toEqual(['snapshot', 'write'])
    expect(history.snaps.length).toBe(1)
  })
})
