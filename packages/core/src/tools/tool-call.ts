import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export interface ToolCallInput {
  name: string
  arguments: Record<string, unknown>
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'arguments'],
  properties: {
    name: { type: 'string', minLength: 1 },
    arguments: { type: 'object' },
  },
}

export const toolCallTool: Tool<ToolCallInput, string> = {
  name: 'ToolCall',
  description:
    'Invoke a deferred tool (MCP or plugin) by name. arguments is the JSON object passed to that tool. Deferred tools stay off the prefix; use ToolSearch to discover names.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<ToolCallInput>(inputSchema, input)
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  async checkPermissions() {
    return { behavior: 'ask', message: 'Use this tool?', saveAs: 'session' }
  },
  async execute(input: ToolCallInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    return `ToolCall is unwrapped by the loop; '${input.name}' was not invoked.`
  },
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
