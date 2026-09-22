import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDockerTerminalBackend,
  createTerminalBackend,
  type TerminalRunRequest,
} from '../tools/terminal-backend'
import { createFileHistory, formatUndoNotice } from './file-history'

function fakeDocker(
  runCommand: (req: TerminalRunRequest) => Promise<{
    stdout: string
    stderr: string
    exitCode: number
  }>,
) {
  return createDockerTerminalBackend({ image: 'bash:5', runCommand })
}

describe('createFileHistory', () => {
  test('undo returns a Promise and still restores the last turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-async-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-async-cwd-'))
    const existing = join(cwd, 'a.txt')
    writeFileSync(existing, 'old\n')
    const history = createFileHistory('sess_async', home)
    history.beginTurn()
    history.snapshot(existing)
    writeFileSync(existing, 'new\n')
    history.endTurn()
    const pending = history.undo()
    expect(pending).toBeInstanceOf(Promise)
    const first = await pending
    expect(first.restored).toEqual([existing])
    expect(readFileSync(existing, 'utf8')).toBe('old\n')
  })

  test('undo restores the last turn and can remove a created file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-cwd-'))
    const existing = join(cwd, 'a.txt')
    writeFileSync(existing, 'old\n')
    const created = join(cwd, 'b.txt')
    const history = createFileHistory('sess_1', home)
    history.beginTurn()
    history.snapshot(existing)
    writeFileSync(existing, 'new\n')
    history.snapshot(created)
    writeFileSync(created, 'fresh\n')
    history.endTurn()

    const first = await history.undo()
    expect(first.restored).toEqual([existing])
    expect(first.removed).toEqual([created])
    expect(readFileSync(existing, 'utf8')).toBe('old\n')
    expect(formatUndoNotice(first)).toContain('restored 1')
    expect(formatUndoNotice(first)).toContain('removed 1')
    expect(formatUndoNotice({ restored: [], removed: [] })).toBe('nothing to undo')
    expect(formatUndoNotice({ restored: [], removed: [], blocked: true })).toBe(
      'undo after the turn finishes',
    )
  })

  test('undo during an open turn does not pop the live generation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-open-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-open-cwd-'))
    const prior = join(cwd, 'prior.txt')
    const live = join(cwd, 'live.txt')
    writeFileSync(prior, 'old-prior\n')
    writeFileSync(live, 'old-live\n')
    const history = createFileHistory('sess_open', home)

    history.beginTurn()
    history.snapshot(prior)
    writeFileSync(prior, 'new-prior\n')
    history.endTurn()

    history.beginTurn()
    history.snapshot(live)
    writeFileSync(live, 'new-live\n')

    const mid = await history.undo()
    expect(mid.blocked).toBeUndefined()
    expect(mid.restored).toEqual([prior])
    expect(readFileSync(prior, 'utf8')).toBe('old-prior\n')
    expect(readFileSync(live, 'utf8')).toBe('new-live\n')

    const blocked = await history.undo()
    expect(blocked.blocked).toBe(true)
    expect(blocked.restored).toEqual([])
    expect(readFileSync(live, 'utf8')).toBe('new-live\n')

    history.endTurn()
    const after = await history.undo()
    expect(after.restored).toEqual([live])
    expect(readFileSync(live, 'utf8')).toBe('old-live\n')
  })

  test('peekLast reports whether the latest generation is open', () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-peek-'))
    const history = createFileHistory('sess_peek', home)
    expect(history.peekLast()).toBeUndefined()
    expect(history.turnWriteCount()).toBe(0)
    history.beginTurn()
    expect(history.peekLast()).toEqual({ open: true })
    expect(history.turnWriteCount()).toBe(0)
    history.endTurn()
    expect(history.peekLast()).toEqual({ open: false })
  })

  test('failed restore keeps the generation for retry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-fail-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-fail-cwd-'))
    const path = join(cwd, 'keep.txt')
    writeFileSync(path, 'old\n')
    const history = createFileHistory('sess_fail', home)
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')
    history.endTurn()
    const backup = join(home, 'file-history', 'sess_fail', '0001')
    unlinkSync(backup)
    const failed = await history.undo()
    expect(failed.restored).toEqual([])
    expect(history.pendingCount()).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('new\n')
    writeFileSync(backup, 'old\n')
    const retried = await history.undo()
    expect(retried.restored).toEqual([path])
    expect(readFileSync(path, 'utf8')).toBe('old\n')
  })

  test('reset drops generations without touching files or backups', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-reset-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-reset-cwd-'))
    const path = join(cwd, 'keep.txt')
    writeFileSync(path, 'old\n')
    const history = createFileHistory('sess_reset', home)
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')
    history.endTurn()
    const backup = join(home, 'file-history', 'sess_reset', '0001')
    expect(existsSync(backup)).toBe(true)

    history.reset()
    expect(history.peekLast()).toBeUndefined()
    expect(history.pendingCount()).toBe(0)
    const undone = await history.undo()
    expect(undone).toEqual({ restored: [], removed: [] })
    expect(undone.blocked).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe('new\n')
    expect(existsSync(backup)).toBe(true)
  })

  test('reset drops an open generation and undo is not blocked', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-reset-open-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-reset-open-cwd-'))
    const path = join(cwd, 'live.txt')
    writeFileSync(path, 'old\n')
    const history = createFileHistory('sess_reset_open', home)
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')

    history.reset()
    expect(history.peekLast()).toBeUndefined()
    expect(history.pendingCount()).toBe(0)
    expect(await history.undo()).toEqual({ restored: [], removed: [] })
    expect(readFileSync(path, 'utf8')).toBe('new\n')
  })
})

describe('createFileHistory docker undo', () => {
  test('restore/remove go through exec and do not host-write workspace bytes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-dock-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-dock-cwd-'))
    const existing = join(cwd, 'a.txt')
    const created = join(cwd, 'b.txt')
    writeFileSync(existing, 'old\n')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const history = createFileHistory('sess_dock', home, { backend, cwd })
    history.beginTurn()
    history.snapshot(existing)
    writeFileSync(existing, 'new\n')
    history.snapshot(created)
    writeFileSync(created, 'fresh\n')
    history.endTurn()

    const first = await history.undo()
    expect(first.restored).toEqual([existing])
    expect(first.removed).toEqual([created])
    expect(readFileSync(existing, 'utf8')).toBe('new\n')
    expect(existsSync(created)).toBe(true)
    expect(calls.length).toBe(2)
    const tee = calls.find((req) => String(req.args.at(-1) ?? '').includes('tee'))
    const rm = calls.find((req) => String(req.args.at(-1) ?? '').includes('rm'))
    expect(tee).toBeDefined()
    expect(rm).toBeDefined()
    expect(String(tee?.stdin ?? '')).toBe('old\n')
    expect(String(tee?.args.at(-1) ?? '')).not.toContain('old\n')
    expect(tee?.timeoutMs).toBe(30_000)
    expect(rm?.timeoutMs).toBe(30_000)
    expect(calls.every((req) => req.command === 'docker')).toBe(true)
  })

  test('snapshot stays host copyFileSync with zero exec', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-snap-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-snap-cwd-'))
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'old\n')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const history = createFileHistory('sess_snap', home, { backend, cwd })
    history.beginTurn()
    history.snapshot(path)
    expect(existsSync(join(home, 'file-history', 'sess_snap', '0001'))).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('outside-cwd leftover with zero exec and no host write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-out-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-out-cwd-'))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'raven-fh-out-else-'))
    const outside = join(outsideRoot, 'secret.txt')
    writeFileSync(outside, 'old\n')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const history = createFileHistory('sess_out', home, { backend, cwd })
    history.beginTurn()
    history.snapshot(outside)
    writeFileSync(outside, 'new\n')
    history.endTurn()
    const first = await history.undo()
    expect(first.restored).toEqual([])
    expect(first.removed).toEqual([])
    expect(history.pendingCount()).toBe(1)
    expect(calls).toHaveLength(0)
    expect(readFileSync(outside, 'utf8')).toBe('new\n')
  })

  test('exec fail leftovers the row and does not host-write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-fail-dock-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-fail-dock-cwd-'))
    const path = join(cwd, 'keep.txt')
    writeFileSync(path, 'old\n')
    const backend = fakeDocker(async () => {
      throw new Error('Cannot connect to the Docker daemon')
    })
    const history = createFileHistory('sess_fail_dock', home, { backend, cwd })
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')
    history.endTurn()
    const failed = await history.undo()
    expect(failed.restored).toEqual([])
    expect(history.pendingCount()).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('new\n')
  })

  test('AbortError leftovers the row and does not host-write', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-abort-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-abort-cwd-'))
    const path = join(cwd, 'keep.txt')
    writeFileSync(path, 'old\n')
    const backend = fakeDocker(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
    const history = createFileHistory('sess_abort', home, { backend, cwd })
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')
    history.endTurn()
    const failed = await history.undo()
    expect(failed.restored).toEqual([])
    expect(history.pendingCount()).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('new\n')
  })

  test('missing cwd on docker uses host undo', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-nocwd-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-nocwd-cwd-'))
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'old\n')
    const calls: TerminalRunRequest[] = []
    const backend = fakeDocker(async (req) => {
      calls.push(req)
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const history = createFileHistory('sess_nocwd', home, { backend })
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')
    history.endTurn()
    const first = await history.undo()
    expect(first.restored).toEqual([path])
    expect(readFileSync(path, 'utf8')).toBe('old\n')
    expect(calls).toHaveLength(0)
  })

  test('image-less docker constructor stays host undo', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-localish-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-fh-localish-cwd-'))
    const path = join(cwd, 'a.txt')
    writeFileSync(path, 'old\n')
    const backend = createTerminalBackend('docker')
    expect(backend.kind).toBe('local')
    const history = createFileHistory('sess_localish', home, { backend, cwd })
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')
    history.endTurn()
    const first = await history.undo()
    expect(first.restored).toEqual([path])
    expect(readFileSync(path, 'utf8')).toBe('old\n')
  })
})
