import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export interface ToolSearchInput {
  query: string
  max_results?: number
}

export interface ToolSearchOpts {
  deferred: Tool[]
  unlock(names: string[]): void
}

const DEFAULT_MAX = 5
const DESC_CHARS = 80
const SELECT_PREFIX = 'select:'

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1 },
    max_results: { type: 'integer', minimum: 1 },
  },
}

export function createToolSearchTool(opts: ToolSearchOpts): Tool<ToolSearchInput, string> {
  const selected = new Set<string>()
  return {
    name: 'ToolSearch',
    description:
      'Search deferred tools by keyword (name + description) or list them with query "select:Name,Name2". Invoke a deferred tool with ToolCall; select does not add it to the prefix. Returns matching names and how many tools remain deferred.',
    inputSchema,
    parse(input: unknown) {
      return parseWithSchema<ToolSearchInput>(inputSchema, input)
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
    async execute(input: ToolSearchInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const leftover = remainingDeferred(opts.deferred, selected)
      const selecting = input.query.startsWith(SELECT_PREFIX)
      const matches = selecting
        ? selectTools(opts.deferred, input.query.slice(SELECT_PREFIX.length))
        : keywordTools(leftover, input.query, input.max_results ?? DEFAULT_MAX)
      if (selecting) {
        for (const tool of matches) selected.add(tool.name)
      }
      const lines = matches.map(formatMatch)
      lines.push(`total ${remainingDeferred(opts.deferred, selected).length} deferred`)
      return lines.join('\n')
    },
  }
}

function remainingDeferred(pool: Tool[], selected: Set<string>): Tool[] {
  return pool.filter((tool) => !selected.has(tool.name))
}

function selectTools(pool: Tool[], raw: string): Tool[] {
  const names = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const found: Tool[] = []
  for (const name of names) {
    const exact = pool.find((tool) => tool.name === name)
    if (exact) {
      found.push(exact)
      continue
    }
    const lower = name.toLowerCase()
    const loose = pool.find((tool) => tool.name.toLowerCase() === lower)
    if (loose) found.push(loose)
  }
  return found
}

function keywordTools(pool: Tool[], query: string, maxResults: number): Tool[] {
  const q = query.toLowerCase()
  const matches: Tool[] = []
  for (const tool of pool) {
    const hay = `${tool.name} ${tool.description}`.toLowerCase()
    if (!hay.includes(q)) continue
    matches.push(tool)
    if (matches.length >= maxResults) break
  }
  return matches
}

function formatMatch(tool: Tool): string {
  const desc = tool.description.slice(0, DESC_CHARS)
  return `${tool.name} — ${desc}`
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
