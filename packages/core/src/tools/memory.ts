import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MEMORY_FILE_CHAR_CAP } from '../prompt/memory'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'
import type { TerminalBackend } from './terminal-backend'

export type MemoryAction = 'add' | 'replace' | 'remove'
export type MemoryTarget = 'agent' | 'user'

export interface MemoryInput {
  action: MemoryAction
  target: MemoryTarget
  text: string
  match?: string
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'target', 'text'],
  properties: {
    action: { type: 'string', enum: ['add', 'replace', 'remove'] },
    target: { type: 'string', enum: ['agent', 'user'] },
    text: { type: 'string' },
    match: { type: 'string' },
  },
}

export function memoryFilePath(cwd: string, target: MemoryTarget): string {
  const file = target === 'agent' ? 'MEMORY.md' : 'USER.md'
  return join(cwd, '.ravenclaw', file)
}

export function createMemoryTool(
  backend?: TerminalBackend,
): Tool<MemoryInput, string> {
  return {
    name: 'Memory',
    description:
      'Add, replace, or remove a paragraph in project memory. target "agent" writes .ravenclaw/MEMORY.md; "user" writes .ravenclaw/USER.md. replace/remove require match (first exact occurrence). Refuses writes over 8000 characters.',
    inputSchema,
    parse(input: unknown) {
      return parseWithSchema<MemoryInput>(inputSchema, input)
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
    async checkPermissions(input: MemoryInput) {
      const file = input.target === 'agent' ? 'MEMORY.md' : 'USER.md'
      return { behavior: 'ask', message: `Update .ravenclaw/${file}?`, saveAs: 'session' }
    },
    async execute(input: MemoryInput, ctx: ToolContext) {
      void backend
      if (ctx.signal.aborted) throw abortError()
      const root = ctx.turn.projectCwd ?? ctx.turn.cwd
      const path = memoryFilePath(root, input.target)
      const existing = readExisting(path)
      const next = nextBody(existing, input)
      if (next.error !== undefined) return next.error
      if (next.body.length > MEMORY_FILE_CHAR_CAP) {
        return `Memory failed: file would exceed ${MEMORY_FILE_CHAR_CAP} characters; consolidate first`
      }
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, next.body, 'utf8')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `Memory failed: ${message}`
      }
      return `Updated .ravenclaw/${input.target === 'agent' ? 'MEMORY.md' : 'USER.md'}`
    },
  }
}

export const memoryTool: Tool<MemoryInput, string> = createMemoryTool()

function nextBody(
  existing: string,
  input: MemoryInput,
): { body: string; error?: undefined } | { error: string; body?: undefined } {
  if (input.action === 'add') return { body: appendParagraph(existing, input.text) }
  const match = input.match
  if (match === undefined || match === '') {
    return { error: `Memory failed: match is required for ${input.action}` }
  }
  const index = existing.indexOf(match)
  if (index < 0) return { error: 'Memory failed: match not found' }
  if (input.action === 'replace') {
    return { body: existing.slice(0, index) + input.text + existing.slice(index + match.length) }
  }
  return { body: existing.slice(0, index) + existing.slice(index + match.length) }
}

function appendParagraph(existing: string, text: string): string {
  const chunk = text.endsWith('\n') ? text : `${text}\n`
  if (existing === '') return chunk
  const prefix = existing.endsWith('\n') ? existing : `${existing}\n`
  const withBreak = prefix.endsWith('\n\n') ? prefix : `${prefix}\n`
  return `${withBreak}${chunk}`
}

function readExisting(path: string): string {
  try {
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
