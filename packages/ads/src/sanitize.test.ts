import { describe, expect, test } from 'bun:test'
import { sanitizeAdText, sanitizeAdUrl } from './sanitize'

describe('sanitizeAdUrl', () => {
  test('accepts https destinations', () => {
    expect(sanitizeAdUrl('https://ads.example.com/offer')).toBe('https://ads.example.com/offer')
  })

  test('rejects http:// and javascript:', () => {
    expect(sanitizeAdUrl('http://ads.example.com/offer')).toBeNull()
    expect(sanitizeAdUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeAdUrl('JAVASCRIPT:alert(1)')).toBeNull()
    expect(sanitizeAdUrl('data:text/html,hi')).toBeNull()
  })
})

describe('sanitizeAdText', () => {
  test('strips ANSI and bidi overrides', () => {
    const ansi = 'Buy\u001b[31m now\u001b[0m'
    const bidi = 'Safe\u202Etxt\u202C'
    expect(sanitizeAdText(ansi)).toBe('Buy now')
    expect(sanitizeAdText(bidi)).toBe('Safetxt')
    expect(sanitizeAdText('\u001b]0;title\u0007plain')).toBe('plain')
    expect(sanitizeAdText('ok\u2066hidden\u2069')).toBe('okhidden')
  })
})
