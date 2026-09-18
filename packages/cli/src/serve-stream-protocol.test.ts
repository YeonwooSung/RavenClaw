import { describe, expect, test } from 'bun:test'
import {
  STREAM_PROTOCOL_VERSION,
  decodeContinuationToken,
  encodeContinuationToken,
  parseVersionParam,
} from './serve-stream-protocol'

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

describe('continuationToken', () => {
  test('round-trips sessionId and lastSeq', () => {
    const token = encodeContinuationToken({ sessionId: 's1', lastSeq: 3 })
    expect(token.includes('=')).toBe(false)
    expect(decodeContinuationToken(token)).toEqual({
      ok: true,
      cursor: { version: 1, sessionId: 's1', lastSeq: 3 },
    })
  })

  test('encodes lastSeq 0', () => {
    const token = encodeContinuationToken({ sessionId: 's1', lastSeq: 0 })
    expect(decodeContinuationToken(token)).toEqual({
      ok: true,
      cursor: { version: 1, sessionId: 's1', lastSeq: 0 },
    })
  })

  test('refuses garbage lastSeq or empty sessionId', () => {
    expect(() => encodeContinuationToken({ sessionId: '', lastSeq: 0 })).toThrow()
    expect(() => encodeContinuationToken({ sessionId: 's1', lastSeq: -1 })).toThrow()
    expect(() => encodeContinuationToken({ sessionId: 's1', lastSeq: 1.5 })).toThrow()
  })

  test('accepts padded base64url', () => {
    const raw = encodeContinuationToken({ sessionId: 's1', lastSeq: 2 })
    const pad = (4 - (raw.length % 4)) % 4
    const padded = raw + '='.repeat(pad)
    expect(decodeContinuationToken(padded)).toEqual({
      ok: true,
      cursor: { version: 1, sessionId: 's1', lastSeq: 2 },
    })
  })

  test('ignores extra JSON keys under v 1', () => {
    const token = Buffer.from(JSON.stringify({ v: 1, s: 's1', q: 4, extra: true }), 'utf8').toString(
      'base64url',
    )
    expect(decodeContinuationToken(token)).toEqual({
      ok: true,
      cursor: { version: 1, sessionId: 's1', lastSeq: 4 },
    })
  })

  test('bad base64, array, and incomplete objects are invalid', () => {
    const invalid = [
      '',
      '%%%',
      'not-base64',
      Buffer.from('[]', 'utf8').toString('base64url'),
      Buffer.from('null', 'utf8').toString('base64url'),
      Buffer.from('"x"', 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1 }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, s: 's1' }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, q: 3 }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, s: '', q: 3 }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, s: 's1', q: '3' }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: '1', s: 's1', q: 3 }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ s: 's1', q: 3 }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, s: 's1', q: -1 }), 'utf8').toString('base64url'),
    ]
    for (const raw of invalid) {
      expect(decodeContinuationToken(raw)).toEqual({
        ok: false,
        error: 'invalid continuationToken',
      })
    }
  })

  test('numeric v other than 1 is unsupported', () => {
    const token = Buffer.from(JSON.stringify({ v: 2, s: 's1', q: 3 }), 'utf8').toString('base64url')
    expect(decodeContinuationToken(token)).toEqual({
      ok: false,
      error: 'unsupported stream version',
    })
  })
})
