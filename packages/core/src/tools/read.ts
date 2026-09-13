import { readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'
import { formatNotebookRead, parseNotebook } from './notebook-format'
import { extractOfficeText, type OfficeExt } from './read-extract'
import { markReadPath } from './read-files'

export interface ReadInput {
  path: string
  offset?: number
  limit?: number
}

const BINARY_SCAN = 8192
const READ_CHAR_CAP = 100_000
const IMAGE_BYTE_CAP = 512_000
const TRUNCATION_NOTE = '\n... [truncated: output exceeds 100000 characters]'
const IMAGE_MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', minLength: 1 },
    offset: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 0 },
  },
}

export const readTool: Tool<ReadInput, string> = {
  name: 'Read',
  description:
    'Read a utf-8 text file or a small image (png/jpeg/gif/webp, ≤ 512000 bytes). path is resolved relative to the turn cwd. offset is a 1-based line number; limit is the maximum number of lines to return. Binary files (NUL in the first 8 KiB) are rejected. Output is capped around 100000 characters. Exempt from disk persist.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<ReadInput>(inputSchema, input)
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
  async execute(input: ReadInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const resolved = resolve(ctx.turn.cwd, input.path)

    let stat
    try {
      stat = statSync(resolved)
    } catch {
      return `Read failed: file not found: ${input.path}`
    }
    if (stat.isDirectory()) {
      return `Read failed: path is a directory: ${input.path}`
    }

    let buf: Buffer
    try {
      buf = readFileSync(resolved)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Read failed: ${message}`
    }

    const mediaType = imageMediaType(resolved)
    if (mediaType) {
      if (buf.length > IMAGE_BYTE_CAP) {
        return `Read failed: image too large (${buf.length} bytes)`
      }
      markReadPath(ctx.turn, resolved)
      return `IMAGE::${mediaType}::${buf.toString('base64')}`
    }

    const officeExt = officeExtOf(resolved)
    if (officeExt) {
      const extracted = extractOfficeText(buf, officeExt)
      if (!extracted.ok) return 'Read failed: cannot extract'
      markReadPath(ctx.turn, resolved)
      return extracted.text.length > READ_CHAR_CAP
        ? extracted.text.slice(0, READ_CHAR_CAP) + TRUNCATION_NOTE
        : extracted.text
    }

    if (containsNul(buf.subarray(0, Math.min(buf.length, BINARY_SCAN)))) {
      return 'Read failed: binary file (NUL in first 8 KiB)'
    }

    if (extname(resolved).toLowerCase() === '.ipynb') {
      const parsed = parseNotebook(buf.toString('utf8'))
      if (parsed.ok) {
        markReadPath(ctx.turn, resolved)
        const formatted = formatNotebookRead(parsed.value)
        return formatted.length > READ_CHAR_CAP
          ? formatted.slice(0, READ_CHAR_CAP) + TRUNCATION_NOTE
          : formatted
      }
    }

    const lines = buf.toString('utf8').split(/\r?\n/)
    const start = Math.max(0, (input.offset ?? 1) - 1)
    const sliced =
      input.limit === undefined ? lines.slice(start) : lines.slice(start, start + input.limit)
    let text = sliced.join('\n')
    if (text.length > READ_CHAR_CAP) {
      text = text.slice(0, READ_CHAR_CAP) + TRUNCATION_NOTE
    }

    markReadPath(ctx.turn, resolved)
    return text
  },
}

function imageMediaType(path: string): string | undefined {
  return IMAGE_MEDIA[extname(path).toLowerCase()]
}

function officeExtOf(path: string): OfficeExt | undefined {
  const ext = extname(path).toLowerCase()
  if (ext === '.docx' || ext === '.xlsx') return ext
  return undefined
}

function containsNul(buf: Uint8Array): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
