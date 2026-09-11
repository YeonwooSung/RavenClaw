import { describe, expect, test } from 'bun:test'
import { SMOKE_PROMPT, evaluateSmoke, smokePasses } from './smoke'

describe('evaluateSmoke', () => {
  test('accepts a lone pong', () => {
    expect(smokePasses('pong')).toBe(true)
    expect(evaluateSmoke('Pong\n')).toEqual({ code: 0, detail: 'ok: model replied pong' })
  })

  test('rejects empty or unrelated text', () => {
    expect(evaluateSmoke('').code).toBe(1)
    expect(evaluateSmoke('hello world').code).toBe(1)
    expect(evaluateSmoke('hello world').detail).toContain('hello world')
  })

  test('prompt asks for pong', () => {
    expect(SMOKE_PROMPT.toLowerCase()).toContain('pong')
  })
})
