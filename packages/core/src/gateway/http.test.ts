import { describe, expect, test } from 'bun:test'
import { checkBearer, parseResolveBody, parseTurnRequest, webhookSafeTools } from './http'

describe('parseTurnRequest', () => {
  test('requires a non-empty text string', () => {
    expect(parseTurnRequest(null)).toEqual({ ok: false, error: 'body must be an object' })
    expect(parseTurnRequest([])).toEqual({ ok: false, error: 'body must be an object' })
    expect(parseTurnRequest('hi')).toEqual({ ok: false, error: 'body must be an object' })
    expect(parseTurnRequest({})).toEqual({ ok: false, error: 'text is required' })
    expect(parseTurnRequest({ text: 1 })).toEqual({ ok: false, error: 'text is required' })
    expect(parseTurnRequest({ text: '   ' })).toEqual({ ok: false, error: 'text is required' })
  })

  test('returns trimmed text and optional sessionKey', () => {
    expect(parseTurnRequest({ text: '  hello  ' })).toEqual({ ok: true, text: 'hello' })
    expect(parseTurnRequest({ text: 'hello', sessionKey: ' slack:dm:D1 ' })).toEqual({
      ok: true,
      text: 'hello',
      sessionKey: 'slack:dm:D1',
    })
    expect(parseTurnRequest({ text: 'hello', sessionKey: '  ' })).toEqual({ ok: true, text: 'hello' })
    expect(parseTurnRequest({ text: 'hello', sessionKey: 3 })).toEqual({
      ok: false,
      error: 'sessionKey must be a string',
    })
  })
})

describe('checkBearer', () => {
  test('accepts Bearer token matching the secret', () => {
    expect(checkBearer('Bearer s3cret', 's3cret')).toBe(true)
    expect(checkBearer('bearer s3cret', 's3cret')).toBe(true)
    expect(checkBearer('  Bearer   s3cret  ', 's3cret')).toBe(true)
  })

  test('rejects missing, empty-secret, or mismatched tokens', () => {
    expect(checkBearer(undefined, 's3cret')).toBe(false)
    expect(checkBearer('Bearer s3cret', '')).toBe(false)
    expect(checkBearer('Bearer other', 's3cret')).toBe(false)
    expect(checkBearer('Basic s3cret', 's3cret')).toBe(false)
    expect(checkBearer('s3cret', 's3cret')).toBe(false)
  })
})

describe('parseResolveBody', () => {
  test('requires callId string and allow boolean', () => {
    expect(parseResolveBody(null)).toEqual({ ok: false, error: 'body must be an object' })
    expect(parseResolveBody([])).toEqual({ ok: false, error: 'body must be an object' })
    expect(parseResolveBody({})).toEqual({ ok: false, error: 'callId is required' })
    expect(parseResolveBody({ callId: '  ', allow: true })).toEqual({
      ok: false,
      error: 'callId is required',
    })
    expect(parseResolveBody({ callId: 'c1' })).toEqual({
      ok: false,
      error: 'allow must be a boolean',
    })
    expect(parseResolveBody({ callId: 'c1', allow: 'yes' })).toEqual({
      ok: false,
      error: 'allow must be a boolean',
    })
  })

  test('returns trimmed callId and allow', () => {
    expect(parseResolveBody({ callId: '  c1  ', allow: true })).toEqual({
      ok: true,
      callId: 'c1',
      allow: true,
    })
    expect(parseResolveBody({ callId: 'c1', allow: false })).toEqual({
      ok: true,
      callId: 'c1',
      allow: false,
    })
  })
})

describe('webhookSafeTools', () => {
  test('keeps only the webhook-safe names in input order', () => {
    const filtered = webhookSafeTools([
      { name: 'Bash' },
      { name: 'Read' },
      { name: 'Write' },
      { name: 'Grep' },
      { name: 'Agent' },
      { name: 'ThinkDeeply' },
    ])
    expect(filtered.map((tool) => tool.name)).toEqual(['Read', 'Grep'])
  })
})
