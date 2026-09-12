import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { safeWebhookToolNames, verifyWebhookSignature } from './webhook'

function sign(secret: string, timestamp: number, rawBody: string): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  return `t=${timestamp},v1=${v1}`
}

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test'
  const body = '{"text":"hi"}'
  const now = 1_700_000_000_000
  const nowSec = Math.floor(now / 1000)

  test('accepts a matching t,v1 HMAC within 300s', () => {
    expect(verifyWebhookSignature(body, sign(secret, nowSec, body), secret, now)).toBe(true)
    expect(verifyWebhookSignature(body, sign(secret, nowSec - 300, body), secret, now)).toBe(true)
    expect(verifyWebhookSignature(body, sign(secret, nowSec + 300, body), secret, now)).toBe(true)
  })

  test('rejects missing header, empty secret, or tampered body', () => {
    expect(verifyWebhookSignature(body, undefined, secret, now)).toBe(false)
    expect(verifyWebhookSignature(body, '', secret, now)).toBe(false)
    expect(verifyWebhookSignature(body, sign(secret, nowSec, body), '', now)).toBe(false)
    expect(verifyWebhookSignature('{"text":"no"}', sign(secret, nowSec, body), secret, now)).toBe(false)
    expect(verifyWebhookSignature(body, `t=${nowSec},v1=${'ab'.repeat(32)}`, secret, now)).toBe(false)
  })

  test('rejects |now-t| > 300s and malformed headers', () => {
    expect(verifyWebhookSignature(body, sign(secret, nowSec - 301, body), secret, now)).toBe(false)
    expect(verifyWebhookSignature(body, sign(secret, nowSec + 301, body), secret, now)).toBe(false)
    expect(verifyWebhookSignature(body, 'v1=deadbeef', secret, now)).toBe(false)
    expect(verifyWebhookSignature(body, `t=notanumber,v1=${'ab'.repeat(32)}`, secret, now)).toBe(false)
  })

  test('accepts spaced header parts and hex case fold', () => {
    const v1 = createHmac('sha256', secret).update(`${nowSec}.${body}`).digest('hex')
    expect(verifyWebhookSignature(body, `t=${nowSec}, v1=${v1.toUpperCase()}`, secret, now)).toBe(true)
  })
})

describe('safeWebhookToolNames', () => {
  test('returns the G1 restricted toolset', () => {
    expect(safeWebhookToolNames()).toEqual(['Read', 'Grep', 'Glob', 'Fetch', 'WebSearch'])
  })
})
