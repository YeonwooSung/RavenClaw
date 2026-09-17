import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_FILE_CHAR_CAP } from '../prompt/memory'
import type {
  CompactPolicy,
  ModelProfile,
  Provider,
  ProviderRequest,
  SessionRecord,
  SessionStore,
} from '../types'

export const MEMORY_REVIEW_REL = join('.ravenclaw', 'MEMORY.md')

export const BACKGROUND_REVIEW_TOOL_NAMES = ['Memory', 'Skill', 'Read', 'Grep'] as const
export const MEMORY_NUDGE_EVERY = 10
export const LEARN_NUDGE_ROUNDS = 10
export const MEMORY_NUDGE = 'consider Memory'
export const LEARN_NUDGE = 'consider /learn'
export const BACKGROUND_REVIEW_PROMPT =
  'If this session taught a durable lesson, write it with Memory. If a reusable procedure emerged, consider a Skill. Do not recap.'

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'Bash'])
const REVIEW_TOOL_SET = new Set<string>(BACKGROUND_REVIEW_TOOL_NAMES)

export function filterBackgroundReviewTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((tool) => REVIEW_TOOL_SET.has(tool.name))
}

export function shouldNudgeMemory(userTurns: number): boolean {
  return userTurns > 0 && userTurns % MEMORY_NUDGE_EVERY === 0
}

export function shouldNudgeLearn(toolRounds: number): boolean {
  return toolRounds >= LEARN_NUDGE_ROUNDS
}

export function shouldStartBackgroundReview(opts: {
  enabled?: boolean
  reason: string
  funding?: string
  permissionMode?: string
}): boolean {
  return (
    opts.enabled === true &&
    opts.reason === 'completed' &&
    opts.funding !== 'included' &&
    opts.permissionMode !== 'dontAsk'
  )
}

/** Persist-detached child: new id, dontAsk so in-tree Memory writes are not prompted. */
export function backgroundReviewSession(parent: SessionRecord): SessionRecord {
  const { todos: _todos, ...rest } = parent
  return { ...rest, id: crypto.randomUUID(), permissionMode: 'dontAsk' }
}

export interface ForkMemoryReviewOpts {
  provider: Provider
  store: SessionStore
  session: SessionRecord
  model: ModelProfile
  compact: CompactPolicy
  text: string
}

export async function forkMemoryReview(
  opts: ForkMemoryReviewOpts,
): Promise<{ ok: boolean; text: string; path?: string }> {
  try {
    const req: ProviderRequest = {
      model: opts.model.id,
      system: [
        {
          tier: 'stable',
          text: 'Read-only memory review. You cannot call Edit, Write, or Bash. Reply with durable bullets only.',
        },
      ],
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          blocks: [{ type: 'text', text: opts.text }],
          createdAt: Date.now(),
        },
      ],
      tools: [],
      maxTokens: opts.model.reserveOutputTokens,
    }
    let text = ''
    const abort = new AbortController()
    for await (const chunk of opts.provider.stream(req, abort.signal)) {
      if (chunk.type === 'text_delta') text += chunk.text
      if (chunk.type === 'tool_call' && MUTATING_TOOLS.has(chunk.name)) continue
    }
    const applied = applyReviewToMemory(opts.session.cwd, text)
    const out: { ok: boolean; text: string; path?: string } = { ok: true, text }
    if (applied.wrote) out.path = applied.path
    return out
  } catch (error) {
    return {
      ok: false,
      text: error instanceof Error ? error.message : 'review failed',
    }
  }
}

export function applyReviewToMemory(
  cwd: string,
  text: string,
): { path: string; wrote: boolean } {
  const path = join(cwd, MEMORY_REVIEW_REL)
  const trimmed = text.trim()
  if (trimmed === '') return { path, wrote: false }

  const body =
    trimmed.length > MEMORY_FILE_CHAR_CAP
      ? `${trimmed.slice(0, MEMORY_FILE_CHAR_CAP)}\n... [truncated]`
      : trimmed
  const day = new Date().toISOString().slice(0, 10)
  const section = `## ${day} review\n${body}\n`

  mkdirSync(join(cwd, '.ravenclaw'), { recursive: true })
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '# Memory\n'
  const prefix = existing.endsWith('\n') ? existing : `${existing}\n`
  let next = `${prefix}\n${section}`
  if (next.length > MEMORY_FILE_CHAR_CAP) {
    next = next.slice(next.length - MEMORY_FILE_CHAR_CAP)
    if (!next.startsWith('#')) next = `# Memory\n${next}`
  }
  writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`)
  return { path, wrote: true }
}
