import { dirname, resolve } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'
import { appendLintBlock, lintWrittenFile } from './lint'
import { isHardDeniedWritePath, resolveWritePath } from './write'
import { isStaleSinceRead, markReadPath, wasRead } from './read-files'
import { workspaceFsFor, type WorkspaceFs } from './workspace-fs'

export type ApplyPatchOp =
  | { type: 'create_file'; path: string; diff: string }
  | { type: 'update_file'; path: string; diff: string }
  | { type: 'delete_file'; path: string }

export interface ApplyPatchInput {
  operations: ApplyPatchOp[]
}

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['operations'],
  properties: {
    operations: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'path'],
        properties: {
          type: { type: 'string', enum: ['create_file', 'update_file', 'delete_file'] },
          path: { type: 'string', minLength: 1 },
          diff: { type: 'string' },
        },
      },
    },
  },
}

export const applyPatchTool: Tool<ApplyPatchInput, string> = {
  name: 'ApplyPatch',
  description:
    'Apply one or more file operations: create_file (diff +lines become content), update_file (unified diff with @@ hunks), or delete_file. update_file and delete_file require a prior Read of that path. Refuses protected paths. Snapshots each path before mutating.',
  inputSchema,
  parse(input: unknown) {
    const parsed = parseWithSchema<ApplyPatchInput>(inputSchema, input)
    if (!parsed.ok) return parsed
    for (const op of parsed.value.operations) {
      if (op.type !== 'delete_file' && typeof op.diff !== 'string') {
        return { ok: false, message: `data/operations must have required property 'diff' for ${op.type}` }
      }
    }
    return parsed
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
    return { behavior: 'ask', message: 'Apply this patch?', saveAs: 'session' }
  },
  async execute(input: ApplyPatchInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const actions: string[] = []
    const lintPaths: string[] = []
    for (const op of input.operations) {
      const result = applyOne(op, ctx)
      if (result.ok === false) return `ApplyPatch failed: ${result.message}`
      actions.push(result.action)
      if (op.type !== 'delete_file') {
        lintPaths.push(resolveWritePath(ctx.turn.cwd, op.path))
      }
    }
    return appendLintBlock(
      actions.join('\n'),
      lintPaths.map((path) => lintWrittenFile(path, ctx.turn.cwd)),
    )
  },
}

function applyOne(
  op: ApplyPatchOp,
  ctx: ToolContext,
): { ok: true; action: string } | { ok: false; message: string } {
  const resolved = resolveWritePath(ctx.turn.cwd, op.path)
  if (isHardDeniedWritePath(resolved)) {
    return { ok: false, message: `write denied to protected path: ${op.path}` }
  }
  const fs = workspaceFsFor(ctx.turn)

  if (op.type === 'create_file') {
    return createFile(op.path, resolved, op.diff, ctx, fs)
  }
  if (op.type === 'update_file') {
    return updateFile(op.path, resolved, op.diff, ctx, fs)
  }
  return deleteFile(op.path, resolved, ctx, fs)
}

function createFile(
  inputPath: string,
  resolved: string,
  diff: string,
  ctx: ToolContext,
  fs: WorkspaceFs,
): { ok: true; action: string } | { ok: false; message: string } {
  try {
    fs.readFile(resolved)
    return { ok: false, message: `file already exists: ${inputPath}` }
  } catch {
    // create only when missing or unreadable
  }
  const content = contentFromCreateDiff(diff)
  try {
    fs.mkdir(dirname(resolved))
    ctx.fileHistory?.snapshot(resolved)
    fs.writeFile(resolved, content)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
  return { ok: true, action: `created ${inputPath}` }
}

function updateFile(
  inputPath: string,
  resolved: string,
  diff: string,
  ctx: ToolContext,
  fs: WorkspaceFs,
): { ok: true; action: string } | { ok: false; message: string } {
  const candidate = resolve(ctx.turn.cwd, inputPath)
  if (!wasRead(ctx.turn.readFiles, resolved, candidate)) {
    return { ok: false, message: `path must be Read first: ${inputPath}` }
  }
  if (isStaleSinceRead(ctx.turn, resolved, candidate)) {
    return { ok: false, message: 'file changed since last Read' }
  }
  let text: string
  try {
    text = fs.readFile(resolved)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
  const patched = applyUnifiedDiff(text, diff)
  if (patched.ok === false) return patched
  try {
    ctx.fileHistory?.snapshot(resolved)
    fs.writeFile(resolved, patched.text)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
  markReadPath(ctx.turn, resolved)
  return { ok: true, action: `updated ${inputPath}` }
}

function deleteFile(
  inputPath: string,
  resolved: string,
  ctx: ToolContext,
  fs: WorkspaceFs,
): { ok: true; action: string } | { ok: false; message: string } {
  if (!wasRead(ctx.turn.readFiles, resolved, resolve(ctx.turn.cwd, inputPath))) {
    return { ok: false, message: `path must be Read first: ${inputPath}` }
  }
  try {
    fs.readFile(resolved)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
  try {
    ctx.fileHistory?.snapshot(resolved)
    fs.unlink(resolved)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
  return { ok: true, action: `deleted ${inputPath}` }
}

export function contentFromCreateDiff(diff: string): string {
  const lines = normalizeNewlines(diff).split('\n')
  const plus = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  if (plus.length === 0) return diff
  return plus.map((line) => line.slice(1)).join('\n')
}

interface Hunk {
  oldStart: number
  oldCount: number
  oldLines: string[]
  newLines: string[]
}

export function applyUnifiedDiff(
  text: string,
  diff: string,
): { ok: true; text: string } | { ok: false; message: string } {
  const parsed = parseHunks(diff)
  if (parsed.ok === false) return parsed
  const { lines, trailingNl } = splitFile(text)
  let offset = 0
  for (const hunk of parsed.hunks) {
    const expected = hunkStart(hunk, offset)
    let start = expected
    if (hunk.oldLines.length > 0 && !linesMatch(lines, start, hunk.oldLines)) {
      const found = findBlock(lines, hunk.oldLines, Math.max(0, offset))
      if (found === -1) {
        return { ok: false, message: `context does not match at line ${hunk.oldStart}` }
      }
      start = found
    }
    if (hunk.oldLines.length > 0 && !linesMatch(lines, start, hunk.oldLines)) {
      return { ok: false, message: `context does not match at line ${hunk.oldStart}` }
    }
    if (start > lines.length) {
      return { ok: false, message: `context does not match at line ${hunk.oldStart}` }
    }
    lines.splice(start, hunk.oldLines.length, ...hunk.newLines)
    offset += hunk.newLines.length - hunk.oldLines.length
  }
  const out = lines.join('\n')
  if (trailingNl && (out.length === 0 || !out.endsWith('\n'))) return { ok: true, text: `${out}\n` }
  return { ok: true, text: out }
}

function parseHunks(diff: string): { ok: true; hunks: Hunk[] } | { ok: false; message: string } {
  const raw = normalizeNewlines(diff).split('\n')
  const hunks: Hunk[] = []
  let i = 0
  while (i < raw.length) {
    const header = raw[i] ?? ''
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)
    if (!match) {
      i += 1
      continue
    }
    const oldStart = Number(match[1])
    const oldCount = match[2] !== undefined ? Number(match[2]) : 1
    const newCount = match[4] !== undefined ? Number(match[4]) : 1
    i += 1
    const oldLines: string[] = []
    const newLines: string[] = []
    while (i < raw.length) {
      const line = raw[i] ?? ''
      if (line.startsWith('@@')) break
      if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
        i += 1
        continue
      }
      if (line.startsWith('\\')) {
        i += 1
        continue
      }
      const tag = line[0]
      const body = tag === ' ' || tag === '-' || tag === '+' ? line.slice(1) : line
      if (tag === '-') {
        oldLines.push(body)
      } else if (tag === '+') {
        newLines.push(body)
      } else if (tag === ' ' || line === '') {
        oldLines.push(body)
        newLines.push(body)
      } else {
        return { ok: false, message: `invalid diff line: ${line}` }
      }
      i += 1
      if (oldLines.length >= oldCount && newLines.length >= newCount) break
    }
    hunks.push({ oldStart, oldCount, oldLines, newLines })
  }
  if (hunks.length === 0) return { ok: false, message: 'no hunks in diff' }
  return { ok: true, hunks }
}

function hunkStart(hunk: Hunk, offset: number): number {
  if (hunk.oldLines.length === 0) return Math.max(0, hunk.oldStart + offset)
  return Math.max(0, hunk.oldStart - 1 + offset)
}

function splitFile(text: string): { lines: string[]; trailingNl: boolean } {
  if (text === '') return { lines: [], trailingNl: false }
  const trailingNl = text.endsWith('\n')
  const body = trailingNl ? text.slice(0, -1) : text
  return { lines: body.split('\n'), trailingNl }
}

function linesMatch(lines: string[], start: number, expected: string[]): boolean {
  if (start < 0 || start + expected.length > lines.length) return false
  for (let i = 0; i < expected.length; i++) {
    if (lines[start + i] !== expected[i]) return false
  }
  return true
}

function findBlock(lines: string[], expected: string[], from: number): number {
  if (expected.length === 0) return -1
  const last = lines.length - expected.length
  for (let i = from; i <= last; i++) {
    if (linesMatch(lines, i, expected)) return i
  }
  return -1
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
