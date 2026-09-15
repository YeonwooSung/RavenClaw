import { existsSync, readFileSync } from 'node:fs'
import { buildPostCompactMessages, selectProtectedTail } from '../loop/repair'
import { planFilePath } from '../tools/plan-file'
import type { CompactPolicy, Message, ModelProfile, Provider, SessionStore } from '../types'
import { compactSummary, mechanicalSummary } from './summarize'

const DEFAULT_TOOL_RESULT_CAP = 100_000
const MICROCOMPACT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Agent'])

function textOf(msg: Message): string {
  return msg.blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function toolNameOf(messages: Message[], toolUseId: string): string | undefined {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.blocks) {
      if (block.type === 'tool_use' && block.id === toolUseId) return block.name
    }
  }
  return undefined
}

function headTailPreview(text: string, head = 400, tail = 400): string {
  if (text.length <= head + tail) return text
  return `${text.slice(0, head)}\n... [truncated ${text.length} characters] ...\n${text.slice(-tail)}`
}

function microcompactStub(name: string): string {
  return `[cleared ${name} output]`
}

export function truncateRestoredText(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

export function applyRestoreCaps(
  texts: string[],
  maxCharsPerItem: number,
  maxCharsTotal: number,
): string[] {
  const out: string[] = []
  let used = 0
  for (const text of texts) {
    if (used >= maxCharsTotal) break
    const clipped = truncateRestoredText(text, maxCharsPerItem)
    const next = truncateRestoredText(clipped, maxCharsTotal - used)
    if (next.length === 0) continue
    out.push(next)
    used += next.length
  }
  return out
}

export function applyToolResultBudget(
  messages: Message[],
  cap = DEFAULT_TOOL_RESULT_CAP,
): Message[] {
  return messages.map((msg) => {
    if (msg.role !== 'tool' || msg.persistPath) return msg
    const text = textOf(msg)
    if (text.length <= cap) return msg
    return { ...msg, blocks: [{ type: 'text', text: headTailPreview(text) }] }
  })
}

export function microcompact(messages: Message[], protectN: number): Message[] {
  const tail = selectProtectedTail(messages, protectN)
  const cut = messages.length - tail.length
  return messages.map((msg, index) => {
    if (index >= cut || msg.role !== 'tool') return msg
    const name = toolNameOf(messages, msg.toolUseId)
    if (!name || !MICROCOMPACT_TOOLS.has(name)) return msg
    return { ...msg, blocks: [{ type: 'text', text: microcompactStub(name) }] }
  })
}

function collectRestoredNotes(
  messages: Message[],
  tailIds: Set<string>,
  compact: CompactPolicy,
  cwd?: string,
): string[] {
  const tailPaths = new Set<string>()
  const tailSkills = new Set<string>()
  for (const msg of messages) {
    if (!tailIds.has(msg.id) || msg.role !== 'assistant') continue
    for (const block of msg.blocks) {
      if (block.type !== 'tool_use') continue
      if (block.name === 'Read') {
        const path = stringField(block.input, 'path')
        if (path) tailPaths.add(path)
      }
      if (block.name === 'Skill') {
        const name = stringField(block.input, 'name')
        if (name) tailSkills.add(name)
      }
    }
  }

  const files: string[] = []
  const seenFiles = new Set<string>()
  const skills: string[] = []
  const seenSkills = new Set<string>()

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== 'assistant') continue
    for (const block of msg.blocks) {
      if (block.type !== 'tool_use') continue
      if (block.name === 'Read') {
        const path = stringField(block.input, 'path')
        if (!path || seenFiles.has(path) || tailPaths.has(path)) continue
        const result = messages.find(
          (row) => row.role === 'tool' && row.toolUseId === block.id,
        )
        if (!result) continue
        const body = textOf(result)
        if (!body || body.startsWith('[cleared ')) continue
        seenFiles.add(path)
        files.push(`File ${path}:\n${body}`)
      } else if (block.name === 'Skill') {
        const name = stringField(block.input, 'name') ?? 'skill'
        if (seenSkills.has(name) || tailSkills.has(name)) continue
        const body = stringField(block.input, 'body')
        const result = messages.find(
          (row) => row.role === 'tool' && row.toolUseId === block.id,
        )
        const text = body ?? (result ? textOf(result) : '')
        if (!text || text.startsWith('[cleared ')) continue
        seenSkills.add(name)
        skills.push(`Skill ${name}:\n${text}`)
      }
    }
  }

  const restoredFiles = applyRestoreCaps(
    files.slice(0, compact.keepRecentFiles),
    compact.maxCharsPerRestoredFile,
    compact.maxCharsRestoredFilesTotal,
  )
  const restoredSkills = applyRestoreCaps(
    skills,
    compact.maxCharsPerRestoredSkill,
    compact.maxCharsRestoredSkillsTotal,
  )
  return [...restoredFiles, ...restoredSkills, ...collectPlanNote(cwd, compact, seenFiles, tailPaths)]
}

function collectPlanNote(
  cwd: string | undefined,
  compact: CompactPolicy,
  seenFiles: Set<string>,
  tailPaths: Set<string>,
): string[] {
  if (!cwd) return []
  const relative = '.ravenclaw/plan.md'
  const path = planFilePath(cwd)
  if (seenFiles.has(relative) || seenFiles.has(path) || tailPaths.has(relative) || tailPaths.has(path)) {
    return []
  }
  try {
    if (!existsSync(path)) return []
    const body = readFileSync(path, 'utf8')
    if (!body) return []
    return applyRestoreCaps(
      [`File ${relative}:\n${body}`],
      compact.maxCharsPerRestoredFile,
      compact.maxCharsRestoredFilesTotal,
    )
  } catch {
    return []
  }
}

function appendUserNotes(messages: Message[], notes: string[]): Message[] {
  if (notes.length === 0) return messages
  const text = notes.join('\n\n')
  const last = messages[messages.length - 1]
  if (last?.role === 'user') {
    return [
      ...messages.slice(0, -1),
      {
        ...last,
        blocks: [{ type: 'text', text: `${textOf(last)}\n\n${text}` }],
      },
    ]
  }
  return [
    ...messages,
    {
      id: crypto.randomUUID(),
      role: 'user',
      blocks: [{ type: 'text', text }],
      createdAt: Date.now(),
    },
  ]
}

export async function runAutocompact(opts: {
  messages: Message[]
  compact: CompactPolicy
  model: ModelProfile
  store: SessionStore
  sessionId: string
  generation: number
  summary?: string
  provider?: Provider
  signal?: AbortSignal
  cwd?: string
}): Promise<{ messages: Message[]; generation: number; inactivatedIds: string[] }> {
  const tail = selectProtectedTail(opts.messages, opts.compact.protectLastMessages)
  const cut = opts.messages.length - tail.length
  const middle = opts.messages.slice(0, cut)
  const inactivatedIds = middle.map((msg) => msg.id)
  const tailIds = new Set(tail.map((msg) => msg.id))
  const summary = await resolveCompactSummary(opts, middle)
  const restored = collectRestoredNotes(opts.messages, tailIds, opts.compact, opts.cwd)
  const messages = appendUserNotes(buildPostCompactMessages(summary, tail), restored)
  const generation = opts.generation + 1
  await opts.store.recordCompact(opts.sessionId, generation, summary, inactivatedIds)
  return { messages, generation, inactivatedIds }
}

async function resolveCompactSummary(
  opts: {
    summary?: string
    compact: CompactPolicy
    model: ModelProfile
    provider?: Provider
    signal?: AbortSignal
  },
  middle: Message[],
): Promise<string> {
  if (opts.summary !== undefined) return opts.summary
  if (opts.provider) {
    return compactSummary(
      middle,
      opts.compact,
      opts.provider,
      opts.model,
      opts.signal ?? new AbortController().signal,
    )
  }
  return mechanicalSummary(middle)
}
