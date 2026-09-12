import { describe, expect, test } from 'bun:test'
import { sessionLockedMessage, type SessionLockHolderName } from '@ravenclaw/core'
import { SLACK_LOCK_HOLDER } from './run'

describe('slack session lock holder', () => {
  test("runtime boots with holder 'slack', not 'serve'", () => {
    const holder: SessionLockHolderName = SLACK_LOCK_HOLDER
    expect(holder).toBe('slack')
    expect(holder).not.toBe('serve')
    const expiresAt = Date.parse('2026-09-12T00:00:00.000Z')
    expect(sessionLockedMessage(holder, expiresAt)).toBe(
      'session locked by slack until 2026-09-12T00:00:00.000Z',
    )
  })
})
