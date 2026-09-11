import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export interface ThinkDeeplyInput {
  thought: string
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['thought'],
  properties: {
    thought: { type: 'string', minLength: 1 },
  },
}

export const thinkDeeplyTool: Tool<ThinkDeeplyInput, string> = {
  name: 'ThinkDeeply',
  description:
    'Log an internal reasoning step without writing files or calling other tools. thought is the text to record. Returns "thought logged".',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<ThinkDeeplyInput>(inputSchema, input)
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  interruptBehavior() {
    return 'cancel'
  },
  async checkPermissions() {
    return { behavior: 'allow', reason: 'mode' }
  },
  async execute(_input: ThinkDeeplyInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    return 'thought logged'
  },
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
