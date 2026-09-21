import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Tool, ToolContext } from '../types'
import {
  DEFAULT_IGNORE_DIR_NAMES,
  WALK_MAX_BYTES,
  WALK_MAX_DEPTH,
  WALK_MAX_FILES,
  capInMessage,
  matchGlob,
  posixRel,
  walkFiles,
} from './glob'
import { parseWithSchema } from './parse'
import { execSandboxSearch, isAbortError } from './sandbox-search'
import type { TerminalBackend } from './terminal-backend'
import { assertInsideWorkspace } from './workspace-fs'

export interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  include?: string
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pattern'],
  properties: {
    pattern: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
    glob: { type: 'string', minLength: 1 },
    include: { type: 'string', minLength: 1 },
  },
}

let ripgrepCached: boolean | undefined

export function isolatedSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  return env
}

export function createGrepTool(backend?: TerminalBackend): Tool<GrepInput, string> {
  return {
    name: 'Grep',
    description:
      'Search file contents for a regular expression. Optional path is a file or directory (defaults to the turn cwd). Optional glob or include filters file names. Uses ripgrep when available, otherwise a bounded walk (200 files, depth 20, 10 MB). Ignores node_modules, .git, dist, build, .next, coverage, vendor, and target. In-message output is capped at 20000 characters and is never disk-persisted.',
    inputSchema,
    parse(input: unknown) {
      return parseWithSchema<GrepInput>(inputSchema, input)
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
    async execute(input: GrepInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      const cwd = ctx.turn.cwd
      const searchRoot = resolve(cwd, input.path ?? '.')
      try {
        assertInsideWorkspace(cwd, searchRoot)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `Grep failed: ${message}`
      }
      const fileFilter = input.glob ?? input.include
      if (backend?.kind === 'docker') {
        return grepByDocker(backend, input, ctx, searchRoot, cwd, fileFilter)
      }
      const rg = tryRipgrep(input.pattern, searchRoot, cwd, fileFilter)
      if (rg !== undefined) return rg
      return grepByWalk(input.pattern, searchRoot, cwd, fileFilter)
    },
  }
}

export const grepTool: Tool<GrepInput, string> = createGrepTool()

async function grepByDocker(
  backend: TerminalBackend,
  input: GrepInput,
  ctx: ToolContext,
  searchRoot: string,
  cwd: string,
  fileFilter: string | undefined,
): Promise<string> {
  try {
    const result = await execSandboxSearch(backend, {
      kind: 'grep',
      cwd,
      searchRoot,
      pattern: input.pattern,
      fileFilter,
      ignoreDirNames: DEFAULT_IGNORE_DIR_NAMES,
      maxFiles: WALK_MAX_FILES,
      maxDepth: WALK_MAX_DEPTH,
      signal: ctx.signal,
    })
    if (ctx.signal.aborted) throw abortError()
    if (result.exitCode === 0 || result.exitCode === 1) {
      const stderr = (result.stderr ?? '').trim()
      if (result.exitCode === 1 && stderr && !(result.stdout ?? '').trim()) {
        return capInMessage(`Grep failed: ${stderr}`)
      }
      let text = formatHitLines(result.stdout ?? '', cwd)
      if (fileFilter !== undefined) {
        text = text
          .split('\n')
          .filter((line) => {
            if (!line) return false
            const file = hitFile(line)
            if (file === undefined) return false
            const abs = isAbsolute(file) ? file : resolve(cwd, file)
            return matchGlob(fileFilter, posixRel(searchRoot, abs))
          })
          .join('\n')
        return capInMessage(text)
      }
      return text
    }
    const err = (result.stderr || result.stdout || 'docker search failed').trim()
    return capInMessage(`Grep failed: ${err}`)
  } catch (error) {
    if (isAbortError(error) || ctx.signal.aborted) throw abortError()
    const message = error instanceof Error ? error.message : String(error)
    return `Grep failed: ${message}`
  }
}

function tryRipgrep(
  pattern: string,
  searchRoot: string,
  cwd: string,
  fileFilter: string | undefined,
): string | undefined {
  if (!hasRipgrep()) return undefined
  const args = [
    '--no-heading',
    '--line-number',
    '--color=never',
    '--no-config',
  ]
  for (const dir of DEFAULT_IGNORE_DIR_NAMES) {
    args.push('--glob', `!${dir}`)
    args.push('--glob', `!${dir}/**`)
  }
  if (fileFilter !== undefined) args.push('--glob', fileFilter)
  args.push('--', pattern, searchRoot)

  const result = spawnSync('rg', args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    cwd,
    env: isolatedSpawnEnv(),
  })
  if (result.error) return undefined
  if (result.status === 2) {
    const err = (result.stderr ?? '').trim()
    return capInMessage(err || 'Grep failed: ripgrep error')
  }
  return formatHitLines(result.stdout ?? '', cwd)
}

function grepByWalk(
  pattern: string,
  searchRoot: string,
  cwd: string,
  fileFilter: string | undefined,
): string {
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch {
    return `Grep failed: invalid regular expression: ${pattern}`
  }

  const hits: string[] = []
  let scanned = 0
  let filesWithHits = 0

  for (const file of walkFiles(searchRoot, cwd)) {
    if (filesWithHits >= WALK_MAX_FILES) break
    if (scanned >= WALK_MAX_BYTES) break
    if (fileFilter !== undefined && !matchGlob(fileFilter, file.relToRoot)) continue

    const remaining = WALK_MAX_BYTES - scanned
    if (remaining <= 0) break

    let text: string
    try {
      const buf = readFileSync(file.absPath)
      const slice = buf.byteLength > remaining ? buf.subarray(0, remaining) : buf
      scanned += slice.byteLength
      if (containsNul(slice.subarray(0, Math.min(8192, slice.byteLength)))) continue
      text = slice.toString('utf8')
    } catch {
      continue
    }

    const lines = text.split(/\r?\n/)
    let hitInFile = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === undefined) continue
      regex.lastIndex = 0
      if (!regex.test(line)) continue
      hits.push(`${file.relToCwd}:${i + 1}:${line}`)
      hitInFile = true
    }
    if (hitInFile) filesWithHits += 1
  }

  return capInMessage(hits.join('\n'))
}

function formatHitLines(stdout: string, cwd: string): string {
  const seenFiles = new Set<string>()
  const out: string[] = []
  for (const raw of stdout.split('\n')) {
    if (!raw) continue
    const formatted = relativizeHit(raw, cwd)
    const file = hitFile(formatted)
    if (file !== undefined && !seenFiles.has(file)) {
      if (seenFiles.size >= WALK_MAX_FILES) break
      seenFiles.add(file)
    }
    out.push(formatted)
  }
  return capInMessage(out.join('\n'))
}

function relativizeHit(line: string, cwd: string): string {
  const match = /^(.+?):(\d+):(.*)$/.exec(line)
  if (!match) return line
  const file = match[1]
  const lineNo = match[2]
  const text = match[3]
  if (file === undefined || lineNo === undefined || text === undefined) return line
  const rel = isAbsolute(file) ? posixRel(cwd, file) : file.replace(/\\/g, '/')
  return `${rel}:${lineNo}:${text}`
}

function hitFile(line: string): string | undefined {
  const idx = line.indexOf(':')
  if (idx <= 0) return undefined
  return line.slice(0, idx)
}

function hasRipgrep(): boolean {
  if (ripgrepCached !== undefined) return ripgrepCached
  try {
    const result = spawnSync('rg', ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      env: isolatedSpawnEnv(),
    })
    ripgrepCached = result.status === 0
  } catch {
    ripgrepCached = false
  }
  return ripgrepCached
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
