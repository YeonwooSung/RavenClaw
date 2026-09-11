import { describe, expect, test } from 'bun:test'
import { applySecretKey } from './secret-input'

describe('applySecretKey', () => {
  test('printable characters append and echo a star, never the key', () => {
    const first = applySecretKey('', 's')
    expect(first.buf).toBe('s')
    expect(first.result).toEqual({ kind: 'char', echo: '*' })
    const second = applySecretKey(first.buf, 'k')
    expect(second.buf).toBe('sk')
    expect(JSON.stringify(second)).not.toContain('sk-ant')
  })

  test('enter submits and ctrl-c cancels', () => {
    expect(applySecretKey('abc', '\n').result.kind).toBe('submit')
    expect(applySecretKey('abc', '\r').result.kind).toBe('submit')
    expect(applySecretKey('abc', '\u0003')).toEqual({ buf: '', result: { kind: 'cancel' } })
  })

  test('backspace erases one star', () => {
    expect(applySecretKey('', '\u007f').result.kind).toBe('ignore')
    expect(applySecretKey('ab', '\b')).toEqual({
      buf: 'a',
      result: { kind: 'backspace', echo: '\b \b' },
    })
  })

  test('ignores escape and other controls', () => {
    expect(applySecretKey('a', '\u001b').result.kind).toBe('ignore')
    expect(applySecretKey('a', '\t').result.kind).toBe('ignore')
  })
})
