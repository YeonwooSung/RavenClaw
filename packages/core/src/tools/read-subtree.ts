import { basename, join, resolve } from 'node:path'
import type { Tool, ToolContext } from '../types'
import {
  isIgnoredDirName,
  posixRel,
  WALK_MAX_DEPTH,
  WALK_MAX_FILES,
  type WalkFile,
} from './glob'
import { parseWithSchema } from './parse'
import type { TerminalBackend } from './terminal-backend'
import { createWorkspaceFs, type WorkspaceFs } from './workspace-fs'

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

export function createReadSubtreeTool(backend?: TerminalBackend): Tool<ReadSubtreeInput, string> {
  return {
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
      const fs = createWorkspaceFs({
        cwd: ctx.turn.cwd,
        exec: backend,
        signal: ctx.signal,
      })
      const failClosed = backend?.kind === 'docker'
      try {
        const rootStat = await fs.stat(searchRoot)
        if (!rootStat.exists) return `ReadSubtree failed: file not found`

        const limit = Math.min(input.maxFiles ?? DEFAULT_MAX_FILES, MAX_FILES_CAP)
        const files = (await walkWorkspace(fs, searchRoot, cwd, failClosed))
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
          let text: string
          try {
            text = await fs.readFile(file.absPath)
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error
            if (failClosed) throw error
            blocks.push(header)
            continue
          }
          if (text.slice(0, BINARY_SCAN).includes('\0')) {
            blocks.push(header)
            continue
          }
          const symbols = extractSymbols(text)
          if (symbols.length === 0) {
            blocks.push(header)
            continue
          }
          blocks.push([header, ...symbols.map((sym) => `    ${sym}`)].join('\n'))
        }
        return blocks.join('\n')
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        const message = error instanceof Error ? error.message : String(error)
        return `ReadSubtree failed: ${message}`
      }
    },
  }
}

export const readSubtreeTool: Tool<ReadSubtreeInput, string> = createReadSubtreeTool()

async function walkWorkspace(
  fs: WorkspaceFs,
  searchRoot: string,
  cwd: string,
  failClosed: boolean,
): Promise<WalkFile[]> {
  const out: WalkFile[] = []
  const rootStat = await fs.stat(searchRoot)
  if (!rootStat.exists) return out

  if (rootStat.isFile) {
    return [
      {
        absPath: searchRoot,
        relToCwd: posixRel(cwd, searchRoot),
        relToRoot: basename(searchRoot),
        size: rootStat.size,
      },
    ]
  }

  if (!rootStat.isDir) return out

  async function visit(dir: string, depth: number): Promise<void> {
    if (out.length >= WALK_MAX_FILES) return
    if (depth > WALK_MAX_DEPTH) return
    let entries
    try {
      entries = await fs.readdir(dir)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      if (failClosed) throw error
      return
    }
    for (const ent of entries) {
      if (out.length >= WALK_MAX_FILES) return
      const abs = join(dir, ent.name)
      if (ent.isDir) {
        if (isIgnoredDirName(ent.name)) continue
        await visit(abs, depth + 1)
        continue
      }
      if (!ent.isFile) continue
      let size = 0
      try {
        const st = await fs.stat(abs)
        if (!st.exists || !st.isFile) continue
        size = st.size
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        if (failClosed) throw error
        continue
      }
      out.push({
        absPath: abs,
        relToCwd: posixRel(cwd, abs),
        relToRoot: posixRel(searchRoot, abs),
        size,
      })
    }
  }

  await visit(searchRoot, 0)
  return out
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

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
