import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, SessionStore } from '../types'
import { createFileHistory } from './file-history'
import { dropLastUserTurn, formatRewindNotice, rewindLastTurn } from './rewind'

function user(id: string, text: string, createdAt: number): Message {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt }
}

function assistant(id: string, text: string, createdAt: number): Message {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], createdAt }
}

function tool(id: string, toolUseId: string, text: string, createdAt: number): Message {
  return { id, role: 'tool', toolUseId, ok: true, blocks: [{ type: 'text', text }], createdAt }
}

describe('dropLastUserTurn', () => {
  test('keeps earlier history and drops the last user plus assistant and tool after it', () => {
    const messages: Message[] = [
      user('u1', 'first', 1),
      assistant('a1', 'ok', 2),
      tool('t1', 'call-1', 'done', 3),
      user('u2', 'second', 4),
      assistant('a2', 'working', 5),
      tool('t2', 'call-2', 'patched', 6),
    ]
    const next = dropLastUserTurn(messages)
    expect(next.map((msg) => msg.id)).toEqual(['u1', 'a1', 't1'])
    expect(messages).toHaveLength(6)
  })

  test('drops a trailing user with no reply', () => {
    const messages: Message[] = [user('u1', 'first', 1), assistant('a1', 'ok', 2), user('u2', 'again', 3)]
    expect(dropLastUserTurn(messages).map((msg) => msg.id)).toEqual(['u1', 'a1'])
  })

  test('returns the same array when there is no user turn', () => {
    const messages: Message[] = [assistant('a1', 'orphan', 1)]
    expect(dropLastUserTurn(messages)).toBe(messages)
    expect(dropLastUserTurn([])).toEqual([])
  })
})

describe('formatRewindNotice', () => {
  test('describes blocked, empty, and combined file plus message rewinds', () => {
    expect(formatRewindNotice({ restored: [], removed: [], blocked: true }, 0)).toBe(
      'a turn is in progress',
    )
    expect(formatRewindNotice({ restored: [], removed: [] }, 0)).toBe('nothing to rewind')
    expect(formatRewindNotice({ restored: [], removed: [] }, 1)).toBe('dropped 1 message')
    expect(formatRewindNotice({ restored: ['a'], removed: ['b'] }, 3)).toBe(
      'undo: restored 1, removed 1; dropped 3 messages',
    )
  })
})

describe('rewindLastTurn', () => {
  test('undoes the last closed generation and drops that user turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-rewind-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-cwd-'))
    const existing = join(cwd, 'a.txt')
    const created = join(cwd, 'b.txt')
    writeFileSync(existing, 'old\n')
    const history = createFileHistory('sess_rewind', home)
    history.beginTurn()
    history.snapshot(existing)
    writeFileSync(existing, 'new\n')
    history.snapshot(created)
    writeFileSync(created, 'fresh\n')
    history.endTurn()

    const messages: Message[] = [
      user('u1', 'first', 1),
      assistant('a1', 'ok', 2),
      user('u2', 'edit files', 3),
      assistant('a2', 'patched', 4),
      tool('t2', 'edit-1', 'wrote', 5),
    ]
    const result = await rewindLastTurn({ fileHistory: history, messages })
    expect(result.ok).toBe(true)
    expect(result.messages.map((msg) => msg.id)).toEqual(['u1', 'a1'])
    expect(readFileSync(existing, 'utf8')).toBe('old\n')
    expect(result.notice).toContain('restored 1')
    expect(result.notice).toContain('removed 1')
    expect(result.notice).toContain('dropped 3 messages')
  })

  test('does not drop messages while a generation is open', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-rewind-open-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-open-cwd-'))
    const live = join(cwd, 'live.txt')
    writeFileSync(live, 'old\n')
    const history = createFileHistory('sess_open', home)
    history.beginTurn()
    history.snapshot(live)
    writeFileSync(live, 'new\n')

    const messages: Message[] = [user('u1', 'edit', 1), assistant('a1', 'working', 2)]
    const result = await rewindLastTurn({ fileHistory: history, messages })
    expect(result.ok).toBe(false)
    expect(result.notice).toBe('a turn is in progress')
    expect(result.messages).toBe(messages)
    expect(readFileSync(live, 'utf8')).toBe('new\n')
  })

  test('refuses while a later generation is open even if a prior turn can undo', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-rewind-prior-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-prior-cwd-'))
    const prior = join(cwd, 'prior.txt')
    const live = join(cwd, 'live.txt')
    writeFileSync(prior, 'old-prior\n')
    writeFileSync(live, 'old-live\n')
    const history = createFileHistory('sess_prior', home)
    history.beginTurn()
    history.snapshot(prior)
    writeFileSync(prior, 'new-prior\n')
    history.endTurn()
    history.beginTurn()
    history.snapshot(live)
    writeFileSync(live, 'new-live\n')

    const messages: Message[] = [
      user('u1', 'first', 1),
      assistant('a1', 'ok', 2),
      user('u2', 'second', 3),
    ]
    const result = await rewindLastTurn({ fileHistory: history, messages })
    expect(result.ok).toBe(false)
    expect(result.notice).toBe('a turn is in progress')
    expect(result.messages).toBe(messages)
    expect(readFileSync(prior, 'utf8')).toBe('new-prior\n')
    expect(readFileSync(live, 'utf8')).toBe('new-live\n')
  })

  test('inactivates dropped messages before undoing files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-rewind-store-'))
    const history = createFileHistory('sess_store', home)
    history.beginTurn()
    history.endTurn()
    const messages: Message[] = [user('u1', 'keep', 1), assistant('a1', 'ok', 2), user('u2', 'drop', 3)]
    const inactivated: string[] = []
    const store = {
      async recordCompact(_sessionId: string, _generation: number, _summary: string, ids: string[]) {
        inactivated.push(...ids)
      },
    } as SessionStore
    const result = await rewindLastTurn({
      fileHistory: history,
      messages,
      store,
      sessionId: 'sess_store',
      generation: 1,
    })
    expect(result.ok).toBe(true)
    expect(result.messages.map((msg) => msg.id)).toEqual(['u1', 'a1'])
    expect(inactivated).toEqual(['u2'])
  })

  test('does not undo files when persist fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'raven-rewind-fail-'))
    const cwd = mkdtempSync(join(tmpdir(), 'raven-rewind-fail-cwd-'))
    const path = join(cwd, 'keep.txt')
    writeFileSync(path, 'old\n')
    const history = createFileHistory('sess_fail', home)
    history.beginTurn()
    history.snapshot(path)
    writeFileSync(path, 'new\n')
    history.endTurn()
    const messages: Message[] = [user('u1', 'edit', 1), assistant('a1', 'ok', 2)]
    const store = {
      async recordCompact() {
        throw new Error('disk full')
      },
    } as unknown as SessionStore
    const result = await rewindLastTurn({
      fileHistory: history,
      messages,
      store,
      sessionId: 'sess_fail',
    })
    expect(result.ok).toBe(false)
    expect(result.notice).toBe('rewind persist failed')
    expect(readFileSync(path, 'utf8')).toBe('new\n')
  })
})
