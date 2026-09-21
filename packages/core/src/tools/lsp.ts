import {
  createLspClient,
  loadLspConfig,
  type LspClientOpts,
  type LspQueryRequest,
  type LspStartFn,
} from '../lsp/client'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export type LspInput = LspQueryRequest
export type { LspClientOpts, LspQueryRequest, LspStartFn }

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operation', 'path', 'line'],
  properties: {
    operation: {
      type: 'string',
      enum: ['hover', 'definition', 'references', 'implementation', 'typeDefinition', 'diagnostic'],
    },
    path: { type: 'string', minLength: 1 },
    line: { type: 'integer', minimum: 0 },
    character: { type: 'integer', minimum: 0 },
  },
}

export function createLspTool(opts?: LspClientOpts): Tool<LspInput, string> {
  const client = createLspClient(opts)
  return {
    name: 'LSP',
    description:
      'Query a local language server for hover, definition, references, implementation, typeDefinition, or diagnostic via JSON-RPC. path is a workspace file; line is 0-based; character defaults to 0. diagnostic ignores line and character. Requires .ravenclaw/lsp.json.',
    inputSchema,
    parse(input: unknown) {
      return parseWithSchema<LspInput>(inputSchema, input)
    },
    isEnabled(ctx: ToolContext) {
      return loadLspConfig(ctx.turn.projectCwd ?? ctx.turn.cwd) != null
    },
    isConcurrencySafe() {
      return true
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
    async execute(input: LspInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const root = ctx.turn.projectCwd ?? ctx.turn.cwd
      return client.query(input, root)
    },
  }
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
