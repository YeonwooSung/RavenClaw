import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clearLastRequestAt, getLastRequestAt, markLastRequestAt } from './last-request'

beforeEach(() => {
  clearLastRequestAt()
})

afterEach(() => {
  clearLastRequestAt()
})

describe('last request clock', () => {
  test('marks and reads a session timestamp', () => {
    expect(getLastRequestAt('last-request-s1')).toBeUndefined()
    markLastRequestAt('last-request-s1', 42)
    expect(getLastRequestAt('last-request-s1')).toBe(42)
    expect(getLastRequestAt('last-request-s2')).toBeUndefined()
  })

  test('clearLastRequestAt deletes one session or all', () => {
    markLastRequestAt('a', 1)
    markLastRequestAt('b', 2)
    clearLastRequestAt('a')
    expect(getLastRequestAt('a')).toBeUndefined()
    expect(getLastRequestAt('b')).toBe(2)
    clearLastRequestAt()
    expect(getLastRequestAt('b')).toBeUndefined()
  })

  test('markLastRequestAt defaults to Date.now', () => {
    const before = Date.now()
    markLastRequestAt('now')
    const at = getLastRequestAt('now')
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })
})
