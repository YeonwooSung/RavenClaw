import { describe, expect, test } from 'bun:test'
import { parseWithSchema } from './parse'

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', minLength: 1 },
    offset: { type: 'integer', minimum: 1 },
  },
}

describe('parseWithSchema', () => {
  test('returns the value when input matches the schema', () => {
    const result = parseWithSchema<{ path: string }>(schema, { path: 'src/a.ts' })
    expect(result).toEqual({ ok: true, value: { path: 'src/a.ts' } })
  })

  test('returns a non-empty failure message when input is invalid', () => {
    const result = parseWithSchema(schema, { offset: 2 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected parse failure')
    expect(result.message.length).toBeGreaterThan(0)
    expect(result.message.toLowerCase()).toContain('path')
  })
})
