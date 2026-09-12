import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { ravenclawHome } from '../home'
import { parseWithSchema } from './parse'
import { appendLintBlock, lintWrittenFile } from './lint'

export interface WriteInput {
  path: string
  content: string
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'content'],
  properties: {
    path: { type: 'string', minLength: 1 },
    content: { type: 'string' },
  },
}

export const writeTool: Tool<WriteInput, string> = {
  name: 'Write',
  description:
    'Create or overwrite a utf-8 file (destructive). path is resolved relative to the turn cwd. Parent directories are created as needed. Overwriting an existing file is allowed and destructive. Refuses protected paths such as ~/.ssh/id_*, state.db, and /etc/shadow. .env writes are not hard-denied.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<WriteInput>(inputSchema, input)
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
    return { behavior: 'ask', message: 'Write this file?', saveAs: 'session' }
  },
  async execute(input: WriteInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const resolved = resolveWritePath(ctx.turn.cwd, input.path)
    if (isHardDeniedWritePath(resolved)) {
      return `Write failed: write denied to protected path: ${input.path}`
    }

    try {
      mkdirSync(dirname(resolved), { recursive: true })
      ctx.fileHistory?.snapshot(resolved)
      writeFileSync(resolved, input.content, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Write failed: ${message}`
    }
    return appendLintBlock(`Wrote ${input.path}`, [lintWrittenFile(resolved, ctx.turn.cwd)])
  },
}

export function resolveWritePath(cwd: string, inputPath: string): string {
  const candidate = resolve(cwd, inputPath)
  try {
    return realpathSync(candidate)
  } catch {
    const parent = dirname(candidate)
    try {
      return join(realpathSync(parent), basename(candidate))
    } catch {
      return candidate
    }
  }
}

export function isHardDeniedWritePath(absPath: string): boolean {
  const resolved = tryRealpath(absPath)
  if (isShadowPath(absPath) || isShadowPath(resolved)) return true
  if (isSshIdPath(absPath) || isSshIdPath(resolved)) return true
  const deniedDbs = [join(ravenclawHome(), 'state.db'), join(homedir(), '.ravenclaw', 'state.db')]
  for (const db of deniedDbs) {
    if (samePath(resolved, db) || samePath(absPath, db)) return true
  }
  return false
}

function isShadowPath(path: string): boolean {
  const n = path.replace(/\\/g, '/')
  return n === '/etc/shadow' || n === '/private/etc/shadow'
}

function isSshIdPath(path: string): boolean {
  if (!basename(path).startsWith('id_')) return false
  const sshDir = tryRealpath(join(homedir(), '.ssh'))
  return tryRealpath(dirname(path)) === sshDir
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true
  return tryRealpath(a) === tryRealpath(b)
}

function tryRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
