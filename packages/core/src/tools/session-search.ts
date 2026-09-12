import type { SessionStore, Tool, ToolContext } from '../types'
import { searchSessionStore } from '../session/sqlite-store'
import type { MessageSearchHit } from '../session/search'
import { parseWithSchema } from './parse'

export interface SessionSearchInput {
  query: string
  limit?: number
}

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1 },
  },
}

export function createSessionSearchTool(store: SessionStore): Tool<SessionSearchInput, string> {
  return {
    name: 'SessionSearch',
    description:
      'Search persisted session messages (FTS). query is required; optional limit defaults to 5 (max 20). Returns ranked sessionId messageId snippet lines, not full bodies.',
    inputSchema,
    parse(input: unknown) {
      return parseWithSchema<SessionSearchInput>(inputSchema, input)
    },
    isEnabled() {
      return storeCanSearch(store)
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
    async execute(input: SessionSearchInput, ctx: ToolContext) {
      if (ctx.signal.aborted) throw abortError()
      if (!storeCanSearch(store)) return 'SessionSearch failed: store does not support search'
      const limit = clampLimit(input.limit)
      const hits = runSearch(store, input.query, { limit: limit * 4 })
      const scoped = await scopeHits(store, hits, ctx)
      if (scoped.length === 0) return 'No matching session messages.'
      return scoped.slice(0, limit).map(formatHit).join('\n')
    },
  }
}

export function storeCanSearch(store: SessionStore): boolean {
  return typeof store.search === 'function'
}

function runSearch(
  store: SessionStore,
  query: string,
  opts?: { sessionId?: string; limit?: number },
): MessageSearchHit[] {
  if (typeof store.search === 'function') return store.search(query, opts)
  return searchSessionStore(store, query, opts)
}

async function scopeHits(
  store: SessionStore,
  hits: MessageSearchHit[],
  ctx: ToolContext,
): Promise<MessageSearchHit[]> {
  const liveMessages = new Set(ctx.turn.messages.map((msg) => msg.id))
  let out = hits.filter((hit) => !liveMessages.has(hit.messageId))
  const cwd = ctx.turn.projectCwd ?? ctx.turn.cwd
  try {
    const local = await store.listSessions({ cwd, limit: 200 })
    if (local.length > 0) {
      const ids = new Set(local.map((session) => session.id))
      out = out.filter((hit) => ids.has(hit.sessionId))
    }
  } catch {
    // whole store
  }
  return out
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

function formatHit(hit: MessageSearchHit): string {
  const snippet = hit.snippet.replace(/\s+/g, ' ').trim()
  return `${hit.sessionId.slice(0, 8)} ${hit.messageId.slice(0, 8)} ${snippet}`
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
