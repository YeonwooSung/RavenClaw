import { describe, expect, test } from 'bun:test'
import { STREAM_PROTOCOL_VERSION, parseVersionParam } from './serve-stream-protocol'

describe('parseVersionParam', () => {
  test('omit means speak 1', () => {
    expect(STREAM_PROTOCOL_VERSION).toBe(1)
    expect(parseVersionParam(null)).toEqual({ ok: true })
  })

  test('1 is accepted', () => {
    expect(parseVersionParam('1')).toEqual({ ok: true, version: 1 })
  })

  test('bad digits are invalid version', () => {
    for (const raw of ['', 'foo', '1.5', '-1']) {
      expect(parseVersionParam(raw)).toEqual({ ok: false, error: 'invalid version' })
    }
  })

  test('other integers are unsupported', () => {
    for (const raw of ['0', '2', '25']) {
      expect(parseVersionParam(raw)).toEqual({
        ok: false,
        error: 'unsupported stream version',
      })
    }
  })
})
