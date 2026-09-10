import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'
import { isHardDeniedWritePath, resolveWritePath } from './write'

export interface EditInput {
  path: string
  old_string: string
  new_string: string
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'old_string', 'new_string'],
  properties: {
    path: { type: 'string', minLength: 1 },
    old_string: { type: 'string' },
    new_string: { type: 'string' },
  },
}

export const editTool: Tool<EditInput, string> = {
  name: 'Edit',
  description:
    'Replace exactly one unique occurrence of old_string with new_string in a utf-8 file. path is resolved relative to the turn cwd. Requires a prior successful Read of that path on this turn. Fails if old_string is missing or not unique. Refuses protected paths.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<EditInput>(inputSchema, input)
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
    return { behavior: 'allow', reason: 'mode' }
  },
  async execute(input: EditInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const resolved = resolveWritePath(ctx.turn.cwd, input.path)
    if (isHardDeniedWritePath(resolved)) {
      return `Edit failed: write denied to protected path: ${input.path}`
    }
    if (!wasRead(ctx.turn.readFiles, resolved, resolve(ctx.turn.cwd, input.path))) {
      return `Edit failed: path must be Read first: ${input.path}`
    }
    if (input.old_string.length === 0) {
      return 'Edit failed: old_string is empty; provide more context to make it unique'
    }

    let text: string
    try {
      text = readFileSync(resolved, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Edit failed: ${message}`
    }

    const matches = countOccurrences(text, input.old_string)
    if (matches === 0) {
      return `Edit failed: old_string not found in ${input.path}`
    }
    if (matches > 1) {
      return `Edit failed: old_string matched ${matches} times; provide more context to make it unique`
    }

    try {
      writeFileSync(resolved, text.replace(input.old_string, input.new_string), 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Edit failed: ${message}`
    }
    return `Updated ${input.path}`
  },
}

function wasRead(readFiles: Set<string>, resolved: string, candidate: string): boolean {
  if (readFiles.has(resolved) || readFiles.has(candidate)) return true
  for (const seen of readFiles) {
    if (seen === resolved || seen === candidate) return true
    try {
      if (realpathSync(seen) === resolved) return true
    } catch {
      // entry may no longer exist
    }
  }
  return false
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) break
    count += 1
    from = idx + needle.length
  }
  return count
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
