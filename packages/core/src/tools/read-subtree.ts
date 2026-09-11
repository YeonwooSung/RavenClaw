import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { walkFiles } from './glob'
import { parseWithSchema } from './parse'

export interface ReadSubtreeInput {
  path?: string
  maxFiles?: number
}

const DEFAULT_MAX_FILES = 40
const MAX_FILES_CAP = 80
const TEXT_BYTE_CAP = 200_000
const BINARY_SCAN = 8192
const SYMBOLS_PER_FILE = 8
const SYMBOL_LINE = /^(export )?(async )?(function|class|const|type|interface|enum) /
const SYMBOL_NAME = /^(?:export )?(?:async )?(function|class|const|type|interface|enum)\s+([A-Za-z_$][\w$]*)/

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', minLength: 1 },
    maxFiles: { type: 'integer', minimum: 1 },
  },
}

export const readSubtreeTool: Tool<ReadSubtreeInput, string> = {
  name: 'ReadSubtree',
  description:
    'Walk a directory tree and list each file with size and up to 8 top-level symbol lines (function/class/const/type/interface/enum). Skips node_modules, .git, dist, build, .next, and other default ignore dirs. maxFiles defaults to 40 and is capped at 80. Binary and files ≥ 200000 bytes show size only.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<ReadSubtreeInput>(inputSchema, input)
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
  async execute(input: ReadSubtreeInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const cwd = ctx.turn.cwd
    const searchRoot = resolve(cwd, input.path ?? '.')
    try {
      statSync(searchRoot)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `ReadSubtree failed: ${message}`
    }

    const limit = Math.min(input.maxFiles ?? DEFAULT_MAX_FILES, MAX_FILES_CAP)
    const files = walkFiles(searchRoot, cwd)
      .slice()
      .sort((a, b) => a.relToCwd.localeCompare(b.relToCwd))
      .slice(0, limit)

    const blocks: string[] = []
    for (const file of files) {
      const rel = file.relToCwd
      const header = `${rel}  ${file.size}b`
      if (file.size >= TEXT_BYTE_CAP) {
        blocks.push(header)
        continue
      }
      let buf: Buffer
      try {
        buf = readFileSync(file.absPath)
      } catch {
        blocks.push(header)
        continue
      }
      if (containsNul(buf.subarray(0, Math.min(buf.length, BINARY_SCAN)))) {
        blocks.push(header)
        continue
      }
      const symbols = extractSymbols(buf.toString('utf8'))
      if (symbols.length === 0) {
        blocks.push(header)
        continue
      }
      blocks.push([header, ...symbols.map((sym) => `    ${sym}`)].join('\n'))
    }
    return blocks.join('\n')
  },
}

export function extractSymbols(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!SYMBOL_LINE.test(line)) continue
    const named = SYMBOL_NAME.exec(line)
    if (named?.[1] !== undefined && named[2] !== undefined) {
      out.push(`${named[1]} ${named[2]}`)
    } else {
      const kw = /^(?:export )?(?:async )?(function|class|const|type|interface|enum) /.exec(line)
      if (kw?.[1] !== undefined) out.push(kw[1])
    }
    if (out.length >= SYMBOLS_PER_FILE) break
  }
  return out
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
