import { describe, expect, test } from 'bun:test'
import { isUserAllowed } from './authz'

describe('isUserAllowed', () => {
  test('empty allowlist and allowAll !== true is fail-closed', () => {
    expect(isUserAllowed('U1', {})).toBe(false)
    expect(isUserAllowed('U1', { allowedUsers: [] })).toBe(false)
    expect(isUserAllowed('U1', { allowedUsers: [], allowAll: false })).toBe(false)
    expect(isUserAllowed('U1', { allowAll: false })).toBe(false)
  })

  test('allowAll true admits any user', () => {
    expect(isUserAllowed('U1', { allowAll: true })).toBe(true)
    expect(isUserAllowed('U1', { allowedUsers: [], allowAll: true })).toBe(true)
    expect(isUserAllowed('U9', { allowedUsers: ['U1'], allowAll: true })).toBe(true)
  })

  test('allowlist match or * admits', () => {
    expect(isUserAllowed('U1', { allowedUsers: ['U1', 'U2'] })).toBe(true)
    expect(isUserAllowed('U3', { allowedUsers: ['U1', 'U2'] })).toBe(false)
    expect(isUserAllowed('anyone', { allowedUsers: ['*'] })).toBe(true)
    expect(isUserAllowed('U1', { allowedUsers: ['U2', '*'] })).toBe(true)
  })
})
