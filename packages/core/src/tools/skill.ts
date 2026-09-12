import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ravenclawHome } from '../home'
import { isSkillDisabled } from '../skills/disable'
import { loadSkillUsage, recordSkillUse } from '../skills/usage'
import type { Tool, ToolContext, Turn } from '../types'
import { parseWithSchema } from './parse'

export interface SkillInput {
  name: string
  path?: string
}

export type SkillSource = 'builtin' | 'user' | 'project'

export interface DiscoveredSkill {
  name: string
  description: string
  dir: string
  source: SkillSource
  disabled?: boolean
  stale?: boolean
  createdBy?: string
}

const BINARY_SCAN = 8192
const BODY_CAP = 20_000
const TRUNCATION_NOTE = '\n... [truncated: output exceeds 20000 characters]'

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
    path: { type: 'string', minLength: 1 },
  },
}

export const skillTool: Tool<SkillInput, string> = {
  name: 'Skill',
  description:
    'Load a named skill. Omit path to return the SKILL.md body. Pass path for a file under that skill directory (realpath-confined). Skills load from bundled builtins, ~/.ravenclaw/skills, and <project>/.ravenclaw/skills (project wins). Frontmatter allowed-tools sets a turn-scoped allow list.',
  inputSchema,
  parse(input: unknown) {
    return parseWithSchema<SkillInput>(inputSchema, input)
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
  async execute(input: SkillInput, ctx: ToolContext) {
    if (ctx.signal.aborted) throw abortError()
    const found = discoverSkills(ctx.turn.projectCwd ?? ctx.turn.cwd).find(
      (skill) => skill.name === input.name && !skill.disabled,
    )
    if (!found) return `Skill failed: unknown skill: ${input.name}`
    recordSkillUse(found.name)
    applySkillAllowedTools(found.dir, ctx.turn)
    if (input.path !== undefined) return readSkillFile(found.dir, input.path)
    return readSkillBody(found.dir)
  },
}

const TURN_ALWAYS_TOOLS = new Set([
  'Skill',
  'EnterPlanMode',
  'ExitPlanMode',
  'Agent',
  'ToolCall',
  'ToolSearch',
])

export function isTurnAlwaysTool(name: string): boolean {
  return TURN_ALWAYS_TOOLS.has(name)
}

export function filterToolsForTurn(tools: Tool[], turn: Turn): Tool[] {
  let out = tools
  if (turn.skillAllowedTools !== undefined) {
    const allow = new Set(turn.skillAllowedTools)
    out = out.filter((tool) => allow.has(tool.name) || TURN_ALWAYS_TOOLS.has(tool.name))
  }
  if (!out.some((tool) => tool.isEnabled)) return out
  const ctx = toolContextFromTurn(turn)
  return out.filter((tool) => (tool.isEnabled ? tool.isEnabled(ctx) : true))
}

function toolContextFromTurn(turn: Turn): ToolContext {
  const signal = turn.abort?.signal ?? new AbortController().signal
  return { turn, signal, onProgress: () => {} }
}

export function builtinSkillsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'builtin')
}

export function discoverSkills(
  cwd: string,
  home?: string,
  opts?: { includeBuiltin?: boolean },
): DiscoveredSkill[] {
  const userHome = home ?? ravenclawHome()
  const byName = new Map<string, DiscoveredSkill>()
  if (opts?.includeBuiltin !== false) {
    loadSkillRoot(builtinSkillsRoot(), byName, 'builtin')
  }
  loadSkillRoot(join(userHome, 'skills'), byName, 'user')
  loadSkillRoot(join(cwd, '.ravenclaw', 'skills'), byName, 'project')
  const disabled = new Set(
    [...byName.keys()].filter((name) => isSkillDisabled(name, userHome)),
  )
  const usage = loadSkillUsage(userHome)
  return [...byName.values()]
    .map((skill) => {
      const next = { ...skill }
      if (disabled.has(skill.name)) next.disabled = true
      if (usage[skill.name]?.state === 'stale') next.stale = true
      return next
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export function createSkillTool(cwd: string, home?: string): Tool<SkillInput, string> {
  const names = discoverSkills(cwd, home)
    .filter((skill) => !skill.disabled)
    .map((skill) => skill.name)
  const listed = names.length > 0 ? names.join(', ') : 'none'
  return {
    ...skillTool,
    description: `${skillTool.description} Available: ${listed}.`,
  }
}

export function parseSkillFrontmatter(markdown: string): {
  name?: string
  description?: string
  version?: string
  allowedTools?: string[]
  createdBy?: string
} {
  const block = extractFrontmatter(markdown)
  if (block === undefined) return {}
  const fields = parseYamlish(block)
  const out: {
    name?: string
    description?: string
    version?: string
    allowedTools?: string[]
    createdBy?: string
  } = {}
  const name = asString(fields.name)
  if (name !== undefined) out.name = name
  const description = asString(fields.description)
  if (description !== undefined) out.description = description
  const version = asString(fields.version)
  if (version !== undefined) out.version = version
  const createdBy = asString(fields.created_by)
  if (createdBy !== undefined) out.createdBy = createdBy
  const allowedTools = parseAllowedTools(fields['allowed-tools'])
  if (allowedTools !== undefined) out.allowedTools = allowedTools
  return out
}

function applySkillAllowedTools(skillDir: string, turn: Turn): void {
  const markdown = readUtf8File(join(skillDir, 'SKILL.md'))
  if (markdown === undefined) return
  const allowed = parseSkillFrontmatter(markdown).allowedTools
  // Empty allowed-tools is a no-op. A later skill intersects and cannot widen.
  if (allowed === undefined || allowed.length === 0) return
  if (turn.skillAllowedTools === undefined) {
    turn.skillAllowedTools = allowed
    return
  }
  const next = new Set(allowed)
  turn.skillAllowedTools = turn.skillAllowedTools.filter((name) => next.has(name))
}

function loadSkillRoot(
  root: string,
  into: Map<string, DiscoveredSkill>,
  source: SkillSource,
): void {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    if (ent.name === '.' || ent.name === '..' || ent.name.startsWith('.')) continue
    const dir = join(root, ent.name)
    const markdown = readUtf8File(join(dir, 'SKILL.md'))
    if (markdown === undefined) continue
    const fm = parseSkillFrontmatter(markdown)
    const name = fm.name ?? ent.name
    const description = fm.description ?? ''
    const skill: DiscoveredSkill = { name, description, dir, source }
    if (fm.createdBy !== undefined) skill.createdBy = fm.createdBy
    into.set(name, skill)
  }
}

function readSkillBody(skillDir: string): string {
  const loaded = confinedRead(skillDir, 'SKILL.md')
  if (!loaded.ok) return loaded.message
  const markdown = loaded.buf.toString('utf8')
  const fm = parseSkillFrontmatter(markdown)
  const body = extractBody(markdown)
  const parts: string[] = []
  if (fm.allowedTools !== undefined && fm.allowedTools.length > 0) {
    parts.push(`This skill suggests: ${fm.allowedTools.join(', ')}.`)
  }
  if (body.length > 0) parts.push(body)
  return capBody(parts.join('\n\n'))
}

export function readConfinedSkillMd(skillDir: string): { ok: true; text: string } | { ok: false; message: string } {
  const loaded = confinedRead(skillDir, 'SKILL.md')
  if (!loaded.ok) return loaded
  return { ok: true, text: loaded.buf.toString('utf8') }
}

function readSkillFile(skillDir: string, userPath: string): string {
  const loaded = confinedRead(skillDir, userPath)
  if (!loaded.ok) return loaded.message
  return capBody(loaded.buf.toString('utf8'))
}

function confinedRead(
  skillDir: string,
  userPath: string,
): { ok: true; buf: Buffer } | { ok: false; message: string } {
  let root: string
  let target: string
  try {
    root = realpathSync(skillDir)
    target = realpathSync(join(skillDir, userPath))
  } catch {
    return { ok: false, message: 'Skill failed: path escape' }
  }
  const allow = target === root || target.startsWith(root + sep)
  if (!allow) return { ok: false, message: 'Skill failed: path escape' }

  let stat
  try {
    stat = statSync(target)
  } catch {
    return { ok: false, message: 'Skill failed: path escape' }
  }
  if (!stat.isFile()) return { ok: false, message: 'Skill failed: path escape' }

  let buf: Buffer
  try {
    buf = readFileSync(target)
  } catch {
    return { ok: false, message: 'Skill failed: path escape' }
  }
  if (containsNul(buf.subarray(0, Math.min(buf.length, BINARY_SCAN)))) {
    return { ok: false, message: 'Skill failed: binary file' }
  }
  return { ok: true, buf }
}

function extractFrontmatter(markdown: string): string | undefined {
  if (!markdown.startsWith('---')) return undefined
  const rest = markdown.slice(3)
  if (!rest.startsWith('\n') && !rest.startsWith('\r\n')) return undefined
  const afterOpen = rest.replace(/^\r?\n/, '')
  const close = afterOpen.search(/\r?\n---(?:\r?\n|$)/)
  if (close === -1) return undefined
  return afterOpen.slice(0, close)
}

function extractBody(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown)
  if (!match) return markdown
  return markdown.slice(match[0].length).replace(/^(?:\r?\n)+/, '')
}

function parseYamlish(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = block.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      i += 1
      continue
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) {
      i += 1
      continue
    }
    const key = kv[1] ?? ''
    const raw = (kv[2] ?? '').trim()
    if (raw === '') {
      const items: string[] = []
      i += 1
      while (i < lines.length) {
        const next = lines[i] ?? ''
        const item = /^\s+-\s+(.*)$/.exec(next)
        if (!item) break
        items.push(unquote(item[1] ?? ''))
        i += 1
      }
      result[key] = items
      continue
    }
    result[key] = parseScalar(raw)
    i += 1
  }
  return result
}

function parseScalar(raw: string): string | string[] {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((part) => unquote(part.trim()))
      .filter((part) => part.length > 0)
  }
  return unquote(raw)
}

function parseAllowedTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  const parts = Array.isArray(value)
    ? value.map((item) => String(item))
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : []
  const tools = parts.map((part) => part.trim()).filter((part) => part.length > 0)
  return tools.length > 0 ? tools : undefined
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length > 0 ? value : undefined
}

function unquote(value: string): string {
  const t = value.trim()
  if (t.length >= 2) {
    const start = t[0]
    const end = t[t.length - 1]
    if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
      return t.slice(1, -1)
    }
  }
  return t
}

function readUtf8File(path: string): string | undefined {
  try {
    const buf = readFileSync(path)
    if (containsNul(buf.subarray(0, Math.min(buf.length, BINARY_SCAN)))) return undefined
    return buf.toString('utf8')
  } catch {
    return undefined
  }
}

function capBody(text: string): string {
  if (text.length <= BODY_CAP) return text
  return text.slice(0, BODY_CAP) + TRUNCATION_NOTE
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
