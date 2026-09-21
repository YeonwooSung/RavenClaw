import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'
import { formatNotebookRead, parseNotebook } from './notebook-format'
import { extractOfficeText, type OfficeExt } from './read-extract'
import { markReadPath } from './read-files'
import { READ_CHAR_CAP, TRUNCATION_NOTE, sliceUtf8Lines, streamUtf8LineWindow } from './read-lines'
import { workspaceFsFor } from './workspace-fs'

export interface ReadInput {
  path: string
  offset?: number
  limit?: number
}

const BINARY_SCAN = 8192
const STREAM_AFTER = 256_000
const IMAGE_BYTE_CAP = 512_000
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
    const fs = workspaceFsFor(ctx.turn)

    let stat
    try {
      stat = await fs.stat(resolved)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      const message = error instanceof Error ? error.message : String(error)
      return `Read failed: ${message}`
    }
    if (!stat.exists) {
      return `Read failed: file not found: ${input.path}`
    }
    if (stat.isDir) {
      return `Read failed: path is a directory: ${input.path}`
    }

    const mediaEarly = imageMediaType(resolved)
    const officeEarly = officeExtOf(resolved)
    if (
      !mediaEarly &&
      !officeEarly &&
      extname(resolved).toLowerCase() !== '.ipynb' &&
      stat.size > STREAM_AFTER
    ) {
      let jailed: string
      try {
        jailed = fs.realpath(resolved)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        const message = error instanceof Error ? error.message : String(error)
        return `Read failed: ${message}`
      }
      if (peekHasNul(jailed)) {
        return 'Read failed: binary file (NUL in first 8 KiB)'
      }
      markReadPath(ctx.turn, resolved)
      return streamUtf8LineWindow(jailed, input.offset, input.limit)
    }

    if (mediaEarly || officeEarly) {
      let buf: Buffer
      try {
        buf = readFileSync(fs.realpath(resolved))
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        const message = error instanceof Error ? error.message : String(error)
        return `Read failed: ${message}`
      }
      if (mediaEarly) {
        if (buf.length > IMAGE_BYTE_CAP) {
          return `Read failed: image too large (${buf.length} bytes)`
        }
        markReadPath(ctx.turn, resolved)
        return `IMAGE::${mediaEarly}::${buf.toString('base64')}`
      }
      const extracted = extractOfficeText(buf, officeEarly as OfficeExt)
      if (!extracted.ok) return 'Read failed: cannot extract'
      markReadPath(ctx.turn, resolved)
      return extracted.text.length > READ_CHAR_CAP
        ? extracted.text.slice(0, READ_CHAR_CAP) + TRUNCATION_NOTE
        : extracted.text
    }

    let text: string
    try {
      text = await fs.readFile(resolved)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      const message = error instanceof Error ? error.message : String(error)
      return `Read failed: ${message}`
    }

    if (text.slice(0, BINARY_SCAN).includes('\0')) {
      return 'Read failed: binary file (NUL in first 8 KiB)'
    }

    if (extname(resolved).toLowerCase() === '.ipynb') {
      const parsed = parseNotebook(text)
      if (parsed.ok) {
        markReadPath(ctx.turn, resolved)
        const formatted = formatNotebookRead(parsed.value)
        return formatted.length > READ_CHAR_CAP
          ? formatted.slice(0, READ_CHAR_CAP) + TRUNCATION_NOTE
          : formatted
      }
    }

    markReadPath(ctx.turn, resolved)
    return sliceUtf8Lines(text, input.offset, input.limit)
  },
}

function peekHasNul(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(BINARY_SCAN)
    const n = readSync(fd, buf, 0, BINARY_SCAN, 0)
    return containsNul(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
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
