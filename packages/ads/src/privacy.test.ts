import { describe, expect, test } from 'bun:test'
import { INCLUDED_PRIVACY } from './privacy'

describe('INCLUDED_PRIVACY', () => {
  test('states ads never touch BYOK and never send the repo', () => {
    expect(INCLUDED_PRIVACY).toContain('BYOK sessions do not contact the ad feed')
    expect(INCLUDED_PRIVACY).toContain('Repository contents are not sent')
    expect(INCLUDED_PRIVACY).toContain('empty ad feed URL never opens a socket')
  })
})
