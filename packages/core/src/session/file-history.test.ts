import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileHistory, formatUndoNotice } from './file-history'

describe('createFileHistory', () => {
  test('undo restores the last turn and can remove a created file', () => {
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

    const first = history.undo()
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

  test('undo during an open turn does not pop the live generation', () => {
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

    const mid = history.undo()
    expect(mid.blocked).toBeUndefined()
    expect(mid.restored).toEqual([prior])
    expect(readFileSync(prior, 'utf8')).toBe('old-prior\n')
    expect(readFileSync(live, 'utf8')).toBe('new-live\n')

    const blocked = history.undo()
    expect(blocked.blocked).toBe(true)
    expect(blocked.restored).toEqual([])
    expect(readFileSync(live, 'utf8')).toBe('new-live\n')

    history.endTurn()
    const after = history.undo()
    expect(after.restored).toEqual([live])
    expect(readFileSync(live, 'utf8')).toBe('old-live\n')
  })

  test('peekLast reports whether the latest generation is open', () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-fh-peek-'))
    const history = createFileHistory('sess_peek', home)
    expect(history.peekLast()).toBeUndefined()
    history.beginTurn()
    expect(history.peekLast()).toEqual({ open: true })
    history.endTurn()
    expect(history.peekLast()).toEqual({ open: false })
  })

  test('failed restore keeps the generation for retry', () => {
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
    const failed = history.undo()
    expect(failed.restored).toEqual([])
    expect(history.pendingCount()).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('new\n')
    writeFileSync(backup, 'old\n')
    const retried = history.undo()
    expect(retried.restored).toEqual([path])
    expect(readFileSync(path, 'utf8')).toBe('old\n')
  })
})
