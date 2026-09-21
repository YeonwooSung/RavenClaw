import { resolve } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'
import type { TerminalBackend } from './terminal-backend'
import { createWorkspaceFs } from './workspace-fs'

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

export function createListDirTool(backend?: TerminalBackend): Tool<ListDirInput, string> {
  return {
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
      const fs = createWorkspaceFs({
        cwd: ctx.turn.cwd,
        exec: backend,
        signal: ctx.signal,
      })
      let entries
      try {
        entries = await fs.readdir(resolved)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        const message = error instanceof Error ? error.message : String(error)
        return `ListDir failed: ${message}`
      }

      const dirs: string[] = []
      const files: string[] = []
      for (const ent of entries) {
        if (ent.isDir) dirs.push(ent.name)
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
}

export const listDirTool: Tool<ListDirInput, string> = createListDirTool()

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
