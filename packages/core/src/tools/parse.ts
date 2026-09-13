import Ajv, { type ValidateFunction } from 'ajv'

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false })
const compiledSchemas = new WeakMap<object, ValidateFunction>()

let compileCount = 0

/** Test hook: number of times `ajv.compile` has actually run. */
export function schemaCompileCount(): number {
  return compileCount
}

export function parseWithSchema<T>(
  schema: unknown,
  input: unknown,
): { ok: true; value: T } | { ok: false; message: string } {
  if (!schema || typeof schema !== 'object') {
    return { ok: false, message: 'invalid schema' }
  }

  let validate = compiledSchemas.get(schema)
  if (!validate) {
    try {
      compileCount += 1
      validate = ajv.compile(schema)
      compiledSchemas.set(schema, validate)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid schema'
      return { ok: false, message }
    }
  }

  if (validate(input)) {
    return { ok: true, value: input as T }
  }

  const message = ajv.errorsText(validate.errors, { separator: '; ' })
  return { ok: false, message: message || 'invalid input' }
}
