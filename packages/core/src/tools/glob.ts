import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'

export const DEFAULT_IGNORE_DIR_NAMES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  'vendor',
  'target',
] as const

export const WALK_MAX_FILES = 200
export const WALK_MAX_DEPTH = 20
export const WALK_MAX_BYTES = 10 * 1024 * 1024
export const IN_MESSAGE_CAP = 20_000

const IGNORE_DIR_SET = new Set<string>(DEFAULT_IGNORE_DIR_NAMES)
const TRUNCATION_SUFFIX = '\n... [truncated: output exceeds 20000 characters]'

export interface GlobInput {
  pattern: string
  path?: string
}

export interface WalkFile {
  absPath: string
  relToCwd: string
  relToRoot: string
  size: number
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pattern'],
  properties: {
    pattern: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
  },
}

export function isIgnoredDirName(name: string): boolean {
  return IGNORE_DIR_SET.has(name)
}

export function posixRel(from: string, to: string): string {
  const rel = relative(from, to)
  if (rel === '') return '.'
  return rel.split(sep).join('/')
}

export function matchGlob(pattern: string, relPath: string): boolean {
  const path = relPath.replace(/\\/g, '/')
  const pat = pattern.replace(/\\/g, '/')
  return globToRegExp(pat).test(path)
}

export function capInMessage(text: string, cap = IN_MESSAGE_CAP): string {
  if (text.length <= cap) return text
  const keep = Math.max(0, cap - TRUNCATION_SUFFIX.length)
  return text.slice(0, keep) + TRUNCATION_SUFFIX
}

export function walkFiles(searchRoot: string, cwd: string): WalkFile[] {
  const out: WalkFile[] = []
  let rootStat
  try {
    rootStat = statSync(searchRoot)
  } catch {
    return out
  }

  if (rootStat.isFile()) {
    return [
      {
        absPath: searchRoot,
        relToCwd: posixRel(cwd, searchRoot),
        relToRoot: posixBase(searchRoot),
        size: rootStat.size,
      },
    ]
  }

  if (!rootStat.isDirectory()) return out

  function visit(dir: string, depth: number): void {
    if (out.length >= WALK_MAX_FILES) return
    if (depth > WALK_MAX_DEPTH) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (out.length >= WALK_MAX_FILES) return
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (isIgnoredDirName(ent.name)) continue
        visit(abs, depth + 1)
        continue
      }
      if (!ent.isFile()) continue
      let size = 0
      try {
        size = statSync(abs).size
      } catch {
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

  visit(searchRoot, 0)
  return out
}

export const globTool: Tool<GlobInput, string> = {
  name: 'Glob',
  description:
    'Find files matching a glob pattern. Supports *, **, and ?. Optional path is the search root (defaults to the turn cwd). Results are cwd-relative. Ignores node_modules, .git, dist, build, .next, coverage, vendor, and target. Bounded to 200 files, depth 20, and 20000 characters.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<GlobInput>(inputSchema, input)
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async checkPermissions() {
    return { behavior: 'allow', reason: 'mode' }
  },
  async execute(input: GlobInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const cwd = ctx.turn.cwd
    const searchRoot = resolve(cwd, input.path ?? '.')
    const matches: string[] = []
    for (const file of walkFiles(searchRoot, cwd)) {
      if (matchGlob(input.pattern, file.relToRoot)) matches.push(file.relToCwd)
    }
    matches.sort()
    return capInMessage(matches.join('\n'))
  },
}

function globToRegExp(pattern: string): RegExp {
  let out = '^'
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (ch !== undefined && '.[+^${}()|\\]'.includes(ch)) {
      out += `\\${ch}`
      i += 1
      continue
    }
    if (ch !== undefined) out += ch
    i += 1
  }
  out += '$'
  return new RegExp(out)
}

function posixBase(absPath: string): string {
  const parts = absPath.split(sep)
  return parts[parts.length - 1] ?? absPath
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
