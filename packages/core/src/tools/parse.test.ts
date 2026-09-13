import { describe, expect, test } from 'bun:test'
import { parseWithSchema, schemaCompileCount } from './parse'

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

  test('caches ajv.compile by schema object identity', () => {
    const cachedSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string', minLength: 1 } },
    }
    const before = schemaCompileCount()
    const first = parseWithSchema<{ name: string }>(cachedSchema, { name: 'a' })
    const afterFirst = schemaCompileCount()
    const second = parseWithSchema<{ name: string }>(cachedSchema, { name: 'b' })
    const afterSecond = schemaCompileCount()

    expect(first).toEqual({ ok: true, value: { name: 'a' } })
    expect(second).toEqual({ ok: true, value: { name: 'b' } })
    expect(afterFirst - before).toBe(1)
    expect(afterSecond - before).toBe(1)

    const otherSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', minLength: 1 } },
    }
    const other = parseWithSchema<{ id: string }>(otherSchema, { id: 'x' })
    expect(other).toEqual({ ok: true, value: { id: 'x' } })
    expect(schemaCompileCount() - before).toBe(2)
  })

  test('invalid compile returns failure without throwing', () => {
    const badSchema = { type: 'not-a-real-json-schema-type' }
    let threw = false
    let result: ReturnType<typeof parseWithSchema>
    try {
      result = parseWithSchema(badSchema, {})
    } catch {
      threw = true
      result = { ok: false, message: 'threw' }
    }
    expect(threw).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected parse failure')
    expect(result.message.length).toBeGreaterThan(0)
  })
})
