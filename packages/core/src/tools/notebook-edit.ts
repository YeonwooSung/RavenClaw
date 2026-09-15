import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Tool, ToolContext } from '../types'
import {
  applyNotebookEdit,
  parseNotebook,
  stringifyNotebook,
  type NotebookEditMode,
} from './notebook-format'
import { parseWithSchema } from './parse'
import { isHardDeniedWritePath, resolveWritePath } from './write'
import { wasRead } from './read-files'

export interface NotebookEditInput {
  path: string
  new_source: string
  cell_id?: string
  cell_type?: 'code' | 'markdown'
  edit_mode?: NotebookEditMode
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'new_source'],
  properties: {
    path: { type: 'string', minLength: 1 },
    new_source: { type: 'string' },
    cell_id: { type: 'string', minLength: 1 },
    cell_type: { type: 'string', enum: ['code', 'markdown'] },
    edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
  },
}

export const notebookEditTool: Tool<NotebookEditInput, string> = {
  name: 'NotebookEdit',
  description:
    'Edit a Jupyter .ipynb notebook. path is resolved relative to the turn cwd. Requires a prior successful Read of that path. edit_mode is replace (default), insert, or delete. replace updates the cell with cell_id or the last cell. insert adds a cell after cell_id or at the start. delete removes cell_id. Refuses protected paths.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<NotebookEditInput>(inputSchema, input)
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
  async checkPermissions() {
    return { behavior: 'ask', message: 'Edit this notebook?', saveAs: 'session' }
  },
  async execute(input: NotebookEditInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const resolved = resolveWritePath(ctx.turn.cwd, input.path)
    if (isHardDeniedWritePath(resolved)) {
      return `NotebookEdit failed: write denied to protected path: ${input.path}`
    }
    if (!wasRead(ctx.turn.readFiles, resolved, resolve(ctx.turn.cwd, input.path))) {
      return `NotebookEdit failed: path must be Read first: ${input.path}`
    }

    let text: string
    try {
      text = readFileSync(resolved, 'utf8')
    } catch (error) {
      return `NotebookEdit failed: ${errorMessage(error)}`
    }

    const parsed = parseNotebook(text)
    if (!parsed.ok) return `NotebookEdit failed: ${parsed.message}`

    const mode = input.edit_mode ?? 'replace'
    const edited = applyNotebookEdit(parsed.value, {
      cell_id: input.cell_id,
      new_source: input.new_source,
      cell_type: input.cell_type,
      edit_mode: mode,
    })
    if (!edited.ok) return `NotebookEdit failed: ${edited.message}`

    try {
      ctx.fileHistory?.snapshot(resolved)
      writeFileSync(resolved, stringifyNotebook(parsed.value), 'utf8')
    } catch (error) {
      return `NotebookEdit failed: ${errorMessage(error)}`
    }
    return statusLine(mode, input.path)
  },
}

function statusLine(mode: NotebookEditMode, path: string): string {
  if (mode === 'insert') return `Inserted cell in ${path}`
  if (mode === 'delete') return `Deleted cell in ${path}`
  return `Replaced cell in ${path}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
