import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Tool, ToolContext } from '../types'
import { parseWithSchema } from './parse'
import { appendLintBlock, lintWrittenFile } from './lint'
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
    return { behavior: 'ask', message: 'Edit this file?', saveAs: 'session' }
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

    let raw: string
    try {
      raw = readFileSync(resolved, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Edit failed: ${message}`
    }

    const crlf = raw.includes('\r\n')
    const text = normalizeNewlines(raw)
    const oldString = normalizeNewlines(input.old_string)
    const newString = normalizeNewlines(input.new_string)

    const replacement = resolveReplacement(text, oldString, newString)
    if (replacement.ok === false) {
      if (replacement.matches === 0) {
        return `Edit failed: old_string not found in ${input.path}`
      }
      return `Edit failed: old_string matched ${replacement.matches} times; provide more context to make it unique`
    }

    try {
      ctx.fileHistory?.snapshot(resolved)
      const updated = text.replace(replacement.oldString, replacement.newString)
      writeFileSync(resolved, crlf ? restoreCrlf(updated) : updated, 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Edit failed: ${message}`
    }
    return appendLintBlock(`Updated ${input.path}`, [lintWrittenFile(resolved, ctx.turn.cwd)])
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

function resolveReplacement(
  text: string,
  oldString: string,
  newString: string,
):
  | { ok: true; oldString: string; newString: string }
  | { ok: false; matches: number } {
  const exact = countOccurrences(text, oldString)
  if (exact === 1) return { ok: true, oldString, newString }
  if (exact > 1) return { ok: false, matches: exact }

  const flexed = indentFlex(text, oldString, newString)
  if (flexed) {
    if (flexed.matches === 1) {
      return { ok: true, oldString: flexed.oldString, newString: flexed.newString }
    }
    if (flexed.matches > 1) return { ok: false, matches: flexed.matches }
  }

  const folded = foldFlex(text, oldString, newString)
  if (!folded) return { ok: false, matches: 0 }
  if (folded.matches === 1) {
    return { ok: true, oldString: folded.oldString, newString: folded.newString }
  }
  return { ok: false, matches: folded.matches }
}

function indentFlex(
  text: string,
  oldString: string,
  newString: string,
): { matches: number; oldString: string; newString: string } | undefined {
  const first = firstNonEmptyLine(oldString)
  if (first === undefined) return undefined

  const oldIndent = leadingWhitespace(first)
  const content = first.slice(oldIndent.length)
  const fileIndents = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.slice(leadingWhitespace(line).length) === content) {
      fileIndents.add(leadingWhitespace(line))
    }
  }
  if (fileIndents.size !== 1) return undefined

  const fileIndent = [...fileIndents][0] ?? ''
  const delta = indentDelta(oldIndent, fileIndent)
  if (!delta) return undefined

  const flexedOld = applyIndentDelta(oldString, delta)
  const flexedNew = applyIndentDelta(newString, delta)
  return {
    matches: countOccurrences(text, flexedOld),
    oldString: flexedOld,
    newString: flexedNew,
  }
}

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (line.slice(leadingWhitespace(line).length).length > 0) return line
  }
  return undefined
}

function leadingWhitespace(line: string): string {
  const match = /^[ \t]*/.exec(line)
  return match ? match[0] : ''
}

function indentDelta(oldIndent: string, fileIndent: string): IndentDelta | undefined {
  if (oldIndent === fileIndent) return undefined
  if (fileIndent.startsWith(oldIndent)) {
    return { type: 'add', ws: fileIndent.slice(oldIndent.length) }
  }
  if (oldIndent.startsWith(fileIndent)) {
    return { type: 'remove', ws: oldIndent.slice(fileIndent.length) }
  }
  return undefined
}

function applyIndentDelta(text: string, delta: IndentDelta): string {
  return text.split('\n').map((line) => applyLineDelta(line, delta)).join('\n')
}

function applyLineDelta(line: string, delta: IndentDelta): string {
  if (line.length === 0) return line
  if (delta.type === 'add') return `${delta.ws}${line}`
  if (line.startsWith(delta.ws)) return line.slice(delta.ws.length)
  return line
}

function foldFlex(
  text: string,
  oldString: string,
  newString: string,
): { matches: number; oldString: string; newString: string } | undefined {
  const foldedOld = foldSpecials(oldString)
  if (foldedOld.length === 0) return undefined

  const { folded: foldedText, map } = foldSpecialsWithMap(text)
  const starts: number[] = []
  let from = 0
  while (from <= foldedText.length - foldedOld.length) {
    const idx = foldedText.indexOf(foldedOld, from)
    if (idx === -1) break
    const end = idx + foldedOld.length
    if (isFoldAligned(map, idx, end)) starts.push(idx)
    from = idx + foldedOld.length
  }
  if (starts.length !== 1) {
    return { matches: starts.length, oldString, newString }
  }
  const start = starts[0] ?? 0
  const end = start + foldedOld.length
  return {
    matches: 1,
    oldString: text.slice(map[start] ?? 0, map[end] ?? text.length),
    newString: foldSpecials(newString),
  }
}

const FOLD_CHARS: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201A': "'",
  '\u201B': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u201E': '"',
  '\u201F': '"',
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2212': '-',
  '\u2026': '...',
  '\u00A0': ' ',
}

function foldSpecials(text: string): string {
  return foldSpecialsWithMap(text).folded
}

function foldSpecialsWithMap(text: string): { folded: string; map: number[] } {
  const chars: string[] = []
  const map: number[] = []
  let i = 0
  while (i < text.length) {
    const lineEnd = text.indexOf('\n', i)
    const end = lineEnd === -1 ? text.length : lineEnd
    let contentEnd = end
    while (contentEnd > i && isLineTrailingWs(text[contentEnd - 1] ?? '')) contentEnd -= 1
    for (let j = i; j < contentEnd; j += 1) {
      const mapped = FOLD_CHARS[text[j] ?? ''] ?? text[j] ?? ''
      for (const ch of mapped) {
        chars.push(ch)
        map.push(j)
      }
    }
    if (lineEnd !== -1) {
      chars.push('\n')
      map.push(lineEnd)
      i = lineEnd + 1
    } else {
      i = text.length
    }
  }
  map.push(text.length)
  return { folded: chars.join(''), map }
}

function isLineTrailingWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\u00A0'
}

function isFoldAligned(map: number[], start: number, end: number): boolean {
  if (start > 0 && map[start] === map[start - 1]) return false
  if (end > 0 && end < map.length - 1 && map[end] === map[end - 1]) return false
  return true
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
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

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function restoreCrlf(text: string): string {
  return text.replace(/\n/g, '\r\n')
}

type IndentDelta = { type: 'add'; ws: string } | { type: 'remove'; ws: string }

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
