import type { Tool, ToolContext } from '../types'
import { addDirectory, normalizeDir } from '../permissions/directories'
import { parseWithSchema } from './parse'

export interface AddDirInput {
  path: string
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', minLength: 1 },
  },
}

export const addDirTool: Tool<AddDirInput, string> = {
  name: 'AddDir',
  description:
    'Add an existing directory as an extra working root for this turn. path is resolved relative to the turn cwd. Later path checks treat it like cwd.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<AddDirInput>(inputSchema, input)
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  interruptBehavior() {
    return 'block'
  },
  async checkPermissions(input: AddDirInput) {
    return { behavior: 'ask', message: `Add directory ${input.path}?`, saveAs: 'session' }
  },
  async execute(input: AddDirInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const result = addDirectory(ctx.turn.additionalDirectories ?? [], ctx.turn.cwd, input.path)
    if (!result.ok) return `AddDir failed: ${result.error}`
    if (ctx.turn.additionalDirectories === undefined) ctx.turn.additionalDirectories = []
    const resolved = normalizeDir(ctx.turn.cwd, input.path)
    if (!ctx.turn.additionalDirectories.includes(resolved)) {
      ctx.turn.additionalDirectories.push(resolved)
    }
    return `added directory ${resolved}`
  },
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
