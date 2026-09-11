import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export interface ListDirInput {
  path?: string
}

const LIST_CAP = 500
const TRUNCATION_NOTE = '\n... [truncated]'

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', minLength: 1 },
  },
}

export const listDirTool: Tool<ListDirInput, string> = {
  name: 'ListDir',
  description:
    'List files and directories in one folder (no recursion). Optional path is resolved relative to the turn cwd and defaults to ".". Output is "dir" then "file" lines, sorted by localeCompare, capped at 500 entries.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<ListDirInput>(inputSchema, input)
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
  async execute(input: ListDirInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const resolved = resolve(ctx.turn.cwd, input.path ?? '.')
    let entries
    try {
      entries = readdirSync(resolved, { withFileTypes: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `ListDir failed: ${message}`
    }

    const dirs: string[] = []
    const files: string[] = []
    for (const ent of entries) {
      if (ent.isDirectory()) dirs.push(ent.name)
      else files.push(ent.name)
    }
    dirs.sort((a, b) => a.localeCompare(b))
    files.sort((a, b) => a.localeCompare(b))

    const lines = [
      ...dirs.map((name) => `dir   ${name}`),
      ...files.map((name) => `file  ${name}`),
    ]
    const body = lines.slice(0, LIST_CAP).join('\n')
    if (lines.length > LIST_CAP) return body + TRUNCATION_NOTE
    return body
  },
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
