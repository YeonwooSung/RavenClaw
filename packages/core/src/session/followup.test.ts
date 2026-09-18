import { describe, expect, test } from 'bun:test'
import type { SessionRecord, UserSubmitInput } from '../types'
import {
  followupNotice,
  lastEndWrittenThisTurn,
  listOwnedPendingAsks,
  maybeRunFollowup,
  runFollowupAfterSubmit,
  writeFollowup,
} from './followup'

describe('writeFollowup', () => {
  test('setFollowup overwrites; empty is an error; clear removes', async () => {
    const session = { id: 's1', updatedAt: 0 } as SessionRecord
    const store = {
      upsertSession: async (s: SessionRecord) => {
        Object.assign(session, s)
      },
    }
    expect(await writeFollowup(session, store, '  ')).toEqual({
      ok: false,
      notice: 'follow-up text required',
    })
    expect(session.followup).toBeUndefined()
    expect(await writeFollowup(session, store, 'first')).toEqual({ ok: true })
    expect(session.followup).toBe('first')
    expect(await writeFollowup(session, store, 'second')).toEqual({ ok: true })
    expect(session.followup).toBe('second')
    expect(await writeFollowup(session, store, null)).toEqual({ ok: true })
    expect(session.followup).toBeUndefined()
  })

  test('trims text and bumps updatedAt on write', async () => {
    const session = { id: 's1', updatedAt: 0 } as SessionRecord
    const store = {
      upsertSession: async (s: SessionRecord) => {
        Object.assign(session, s)
      },
    }
    const before = Date.now()
    expect(await writeFollowup(session, store, '  run tests  ')).toEqual({ ok: true })
    expect(session.followup).toBe('run tests')
    expect(session.updatedAt).toBeGreaterThanOrEqual(before)
  })
})

describe('followupNotice', () => {
  test('null or empty is no follow-up; otherwise returns text', () => {
    expect(followupNotice(null)).toBe('no follow-up')
    expect(followupNotice('')).toBe('no follow-up')
    expect(followupNotice('run tests')).toBe('run tests')
  })
})

describe('maybeRunFollowup', () => {
  test('maybeRunFollowup persist-clears then submits on completed; cancel clears; pending skips', async () => {
    const submitted: string[] = []
    const session = { followup: 'next please' } as SessionRecord
    const engine = {
      getFollowup: () => session.followup ?? null,
      clearFollowup: async () => {
        delete session.followup
      },
      liveTurnId: () => null,
      async *submitMessage(input: UserSubmitInput) {
        submitted.push(typeof input === 'string' ? input : (input.text ?? ''))
      },
    }
    const ran = await maybeRunFollowup({
      engine,
      listPendingAsks: async () => [],
      lastEnd: { reason: 'completed' },
    })
    expect(ran).toBe('ran')
    expect(session.followup).toBeUndefined()
    expect(submitted).toEqual(['next please'])

    session.followup = 'nope'
    const cleared = await maybeRunFollowup({
      engine,
      listPendingAsks: async () => [],
      lastEnd: { reason: 'cancelled' },
    })
    expect(cleared).toBe('cleared')
    expect(submitted).toEqual(['next please'])
    expect(session.followup).toBeUndefined()

    session.followup = 'wait'
    const skipped = await maybeRunFollowup({
      engine,
      listPendingAsks: async () => [{ callId: 'x' }],
      lastEnd: { reason: 'completed' },
    })
    expect(skipped).toBe('skipped')
    expect(session.followup).toBe('wait')
  })

  test('maybeRunFollowup does not submit when clearFollowup throws', async () => {
    const submitted: string[] = []
    const engine = {
      getFollowup: () => 'keep',
      clearFollowup: async () => {
        throw new Error('disk')
      },
      liveTurnId: () => null,
      async *submitMessage(input: UserSubmitInput) {
        submitted.push(typeof input === 'string' ? input : (input.text ?? ''))
      },
    }
    const result = await maybeRunFollowup({
      engine,
      listPendingAsks: async () => [],
      lastEnd: { reason: 'completed' },
    })
    expect(result).toBe('skipped')
    expect(submitted).toEqual([])
  })
})

describe('lastEndWrittenThisTurn', () => {
  test('returns the new lastEnd only when this submit persisted one', () => {
    const previous = { reason: 'cancelled' as const }
    const written = { reason: 'completed' as const }
    expect(lastEndWrittenThisTurn(previous, previous)).toBeUndefined()
    expect(lastEndWrittenThisTurn(undefined, undefined)).toBeUndefined()
    expect(lastEndWrittenThisTurn(previous, undefined)).toBeUndefined()
    expect(lastEndWrittenThisTurn(previous, written)).toBe(written)
    expect(lastEndWrittenThisTurn(undefined, written)).toBe(written)
  })
})

describe('listOwnedPendingAsks', () => {
  test('includes leftover-asks on child sessions', async () => {
    const store = {
      async listPendingAsks(sessionId: string) {
        if (sessionId === 'parent') return []
        if (sessionId === 'child') return [{ callId: 'call_child' }]
        return []
      },
      async listSessions(filter: { parentSessionId: string }) {
        if (filter.parentSessionId === 'parent') return [{ id: 'child' }]
        return []
      },
    }
    expect(await listOwnedPendingAsks(store, 'parent')).toEqual([{ callId: 'call_child' }])
    expect(await listOwnedPendingAsks(undefined, 'parent')).toEqual([])
  })
})

describe('runFollowupAfterSubmit', () => {
  test('skips when lastEnd was not persisted; runs only a newly written lastEnd', async () => {
    const submitted: string[] = []
    const session = {
      followup: 'next please',
      lastEnd: { reason: 'cancelled' as const },
    }
    const engine = {
      session,
      getFollowup: () => session.followup ?? null,
      clearFollowup: async () => {
        delete session.followup
      },
      liveTurnId: () => null,
      async *submitMessage(input: UserSubmitInput) {
        submitted.push(typeof input === 'string' ? input : (input.text ?? ''))
      },
    }
    const skipped = await runFollowupAfterSubmit({
      engine,
      sessionId: 'parent',
      beforeLastEnd: session.lastEnd,
    })
    expect(skipped).toBe('skipped')
    expect(session.followup).toBe('next please')
    expect(submitted).toEqual([])

    session.lastEnd = { reason: 'completed' }
    const ran = await runFollowupAfterSubmit({
      engine,
      sessionId: 'parent',
      beforeLastEnd: { reason: 'cancelled' },
    })
    expect(ran).toBe('ran')
    expect(session.followup).toBeUndefined()
    expect(submitted).toEqual(['next please'])
  })

  test('skips and keeps the slot when a child leftover-ask is parked', async () => {
    const submitted: string[] = []
    const session = {
      followup: 'next please',
      lastEnd: { reason: 'completed' as const },
    }
    const engine = {
      session,
      getFollowup: () => session.followup ?? null,
      clearFollowup: async () => {
        delete session.followup
      },
      liveTurnId: () => null,
      async *submitMessage(input: UserSubmitInput) {
        submitted.push(typeof input === 'string' ? input : (input.text ?? ''))
      },
    }
    const flag = await runFollowupAfterSubmit({
      engine,
      store: {
        async listPendingAsks(sessionId: string) {
          if (sessionId === 'child') return [{ callId: 'call_child' }]
          return []
        },
        async listSessions() {
          return [{ id: 'child' }]
        },
      },
      sessionId: 'parent',
      beforeLastEnd: undefined,
    })
    expect(flag).toBe('skipped')
    expect(session.followup).toBe('next please')
    expect(submitted).toEqual([])
  })
})
