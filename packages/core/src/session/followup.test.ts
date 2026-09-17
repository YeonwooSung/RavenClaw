import { describe, expect, test } from 'bun:test'
import type { SessionRecord } from '../types'
import { followupNotice, writeFollowup } from './followup'

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
