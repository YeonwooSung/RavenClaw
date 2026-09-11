import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export interface SetOutputInput {
  data: unknown
}

const childOutputs = new Map<string, string>()

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['data'],
  properties: {
    data: {},
  },
}

export function setChildOutput(sessionId: string, text: string): void {
  childOutputs.set(sessionId, text)
}

export function takeChildOutput(sessionId: string): string | undefined {
  const value = childOutputs.get(sessionId)
  childOutputs.delete(sessionId)
  return value
}

export const setOutputTool: Tool<SetOutputInput, string> = {
  name: 'SetOutput',
  description:
    'Store a JSON value as this session\'s child output. data may be any JSON value. Returns "output set". Later hosts can take the stored text by session id.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<SetOutputInput>(inputSchema, input)
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
  async execute(input: SetOutputInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    let text: string
    try {
      text = JSON.stringify(input.data, null, 2)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `SetOutput failed: ${message}`
    }
    setChildOutput(ctx.turn.sessionId, text)
    return 'output set'
  },
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
