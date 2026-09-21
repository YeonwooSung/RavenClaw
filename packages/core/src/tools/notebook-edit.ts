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
import { isInTreePath } from '../permissions/modes'
import { isHardDeniedWritePath, resolveWritePath } from './write'
import { wasRead } from './read-files'
import type { TerminalBackend } from './terminal-backend'

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

export function createNotebookEditTool(
  backend?: TerminalBackend,
): Tool<NotebookEditInput, string> {
  return {
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
      if (!isInTreePath(ctx.turn.cwd, resolved)) {
        return 'NotebookEdit failed: outside workspace'
      }
      if (!wasRead(ctx.turn.readFiles, resolved, resolve(ctx.turn.cwd, input.path))) {
        return `NotebookEdit failed: path must be Read first: ${input.path}`
      }

      const read = await readNotebookText(resolved, ctx, backend)
      if (!read.ok) return `NotebookEdit failed: ${read.message}`

      const parsed = parseNotebook(read.text)
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
        const written = await writeNotebookText(
          resolved,
          stringifyNotebook(parsed.value),
          ctx,
          backend,
        )
        if (!written.ok) return `NotebookEdit failed: ${written.message}`
      } catch (error) {
        if (isAbortError(error) || ctx.signal.aborted) throw abortError()
        return `NotebookEdit failed: ${errorMessage(error)}`
      }
      return statusLine(mode, input.path)
    },
  }
}

export const notebookEditTool: Tool<NotebookEditInput, string> = createNotebookEditTool()

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

const NOTEBOOK_TIMEOUT_MS = 30_000

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function isDockerNotebook(backend?: TerminalBackend): boolean {
  return backend?.kind === 'docker'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function readNotebookText(
  resolved: string,
  ctx: ToolContext,
  backend?: TerminalBackend,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  if (!isDockerNotebook(backend) || backend === undefined) {
    try {
      return { ok: true, text: readFileSync(resolved, 'utf8') }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }
  try {
    const result = await backend.exec({
      command: `cat ${shQuote(resolved)}`,
      cwd: ctx.turn.cwd,
      timeoutMs: NOTEBOOK_TIMEOUT_MS,
      signal: ctx.signal,
    })
    if (ctx.signal.aborted) throw abortError()
    if (result.exitCode !== 0) {
      const err = (result.stderr || result.stdout || 'docker cat failed').trim()
      return { ok: false, message: err }
    }
    return { ok: true, text: result.stdout }
  } catch (error) {
    if (isAbortError(error) || ctx.signal.aborted) throw abortError()
    return { ok: false, message: errorMessage(error) }
  }
}

async function writeNotebookText(
  resolved: string,
  text: string,
  ctx: ToolContext,
  backend?: TerminalBackend,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isDockerNotebook(backend) || backend === undefined) {
    try {
      writeFileSync(resolved, text, 'utf8')
      return { ok: true }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }
  try {
    const result = await backend.exec({
      command: `tee ${shQuote(resolved)}`,
      cwd: ctx.turn.cwd,
      timeoutMs: NOTEBOOK_TIMEOUT_MS,
      signal: ctx.signal,
      stdin: text,
    })
    if (ctx.signal.aborted) throw abortError()
    if (result.exitCode !== 0) {
      const err = (result.stderr || result.stdout || 'docker tee failed').trim()
      return { ok: false, message: err }
    }
    return { ok: true }
  } catch (error) {
    if (isAbortError(error) || ctx.signal.aborted) throw abortError()
    return { ok: false, message: errorMessage(error) }
  }
}
