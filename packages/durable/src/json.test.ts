import { describe, expect, test } from 'bun:test'
import { DurableFault } from './errors.ts'
import { assertStrictJson } from './json.ts'

describe('strict JSON', () => {
  test('accepts plain JSON', () => {
    expect(assertStrictJson({ a: 1, b: [true, null, 'x'] })).toEqual({ a: 1, b: [true, null, 'x'] })
  })

  test('rejects non-finite numbers, functions, undefined values, and cycles', () => {
    expect(() => assertStrictJson(Number.NaN)).toThrow(DurableFault)
    expect(() => assertStrictJson(() => 1)).toThrow(DurableFault)
    expect(() => assertStrictJson({ a: undefined })).toThrow(DurableFault)
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(() => assertStrictJson(cycle)).toThrow(DurableFault)
  })
})
