import Ajv from 'ajv'

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false })

export function parseWithSchema<T>(
  schema: unknown,
  input: unknown,
): { ok: true; value: T } | { ok: false; message: string } {
  if (!schema || typeof schema !== 'object') {
    return { ok: false, message: 'invalid schema' }
  }

  let validate
  try {
    validate = ajv.compile(schema)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid schema'
    return { ok: false, message }
  }

  if (validate(input)) {
    return { ok: true, value: input as T }
  }

  const message = ajv.errorsText(validate.errors, { separator: '; ' })
  return { ok: false, message: message || 'invalid input' }
}
