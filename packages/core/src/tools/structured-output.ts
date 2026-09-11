import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'
import { setChildOutput } from './set-output'

export function validateAgainstSchema(schema: unknown, value: unknown): boolean {
  if (!isPlainObject(schema) || !isPlainObject(value)) return false
  const required = (schema as { required?: unknown }).required
  if (!Array.isArray(required)) return true
  for (const key of required) {
    if (typeof key !== 'string' || !(key in value)) return false
  }
  return true
}

export function createStructuredOutputTool(schema: unknown): Tool {
  return {
    name: 'StructuredOutput',
    description:
      'Store a JSON object that matches the provided schema as this session\'s child output. Returns "output set". Later hosts can take the stored text by session id.',
    inputSchema: schema,
    parse(input: unknown) {
      if (!isJsonSchemaLike(schema)) {
        return { ok: false, message: 'invalid schema' }
      }
      return parseWithSchema(schema, input)
    },
    isConcurrencySafe() {
      return false
    },
    isReadOnly() {
      return true
    },
    interruptBehavior() {
      return 'block'
    },
    async checkPermissions() {
      return { behavior: 'allow', reason: 'mode' }
    },
    async execute(input: unknown, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      let text: string
      try {
        text = JSON.stringify(input, null, 2)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `StructuredOutput failed: ${message}`
      }
      setChildOutput(ctx.turn.sessionId, text)
      return 'output set'
    },
  }
}

function isJsonSchemaLike(schema: unknown): schema is object {
  if (!isPlainObject(schema)) return false
  const type = (schema as { type?: unknown }).type
  return type === 'object'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
