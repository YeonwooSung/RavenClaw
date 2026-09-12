import type { Message, SessionRecord, SessionStore, Tool, ToolContext } from '../types'
import { PersistError } from '../types'
import { searchSessionStore } from '../session/sqlite-store'
import {
  formatSessionLine,
  headTailMessages,
  visibleSessionMessages,
  windowAroundMessages,
  type MessageSearchHit,
} from '../session/search'
import { parseWithSchema } from './parse'

export interface SessionSearchInput {
  query?: string
  sessionId?: string
  aroundMessageId?: string
  limit?: number
}

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1 },
    sessionId: { type: 'string', minLength: 1 },
    aroundMessageId: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1 },
  },
}

export function createSessionSearchTool(store: SessionStore): Tool<SessionSearchInput, string> {
  return {
    name: 'SessionSearch',
    description:
      'Search or open persisted sessions. query runs FTS. sessionId reads head/tail lines. sessionId + aroundMessageId scrolls a window. No args lists recent workspace sessions. Optional limit defaults to 5 (max 20). Bodies capped. Read-only.',
    inputSchema,
    parse(input: unknown) {
      return parseWithSchema<SessionSearchInput>(inputSchema, input)
    },
    isEnabled() {
      return true
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
      const limit = clampLimit(input.limit)
      if (input.aroundMessageId !== undefined && input.sessionId === undefined) {
        return 'SessionSearch failed: sessionId is required when aroundMessageId is set'
      }
      if (input.sessionId !== undefined && input.query === undefined) {
        return readOrScroll(store, input.sessionId, input.aroundMessageId, limit, ctx)
      }
      if (input.query !== undefined) {
        return searchQuery(store, input.query, input.sessionId, limit, ctx)
      }
      return browseSessions(store, limit, ctx)
    },
  }
}

export function storeCanSearch(store: SessionStore): boolean {
  return typeof store.search === 'function'
}

async function searchQuery(
  store: SessionStore,
  query: string,
  sessionId: string | undefined,
  limit: number,
  ctx: ToolContext,
): Promise<string> {
  if (!storeCanSearch(store)) return 'SessionSearch failed: store does not support search'
  const resolved = sessionId !== undefined ? await resolveScopedSession(store, sessionId, ctx) : undefined
  if (sessionId !== undefined && typeof resolved === 'string') return resolved
  const hits = runSearch(store, query, {
    limit: limit * 4,
    sessionId: resolved && typeof resolved !== 'string' ? resolved.session.id : undefined,
  })
  const scoped = await scopeHits(store, hits, ctx)
  if (scoped.length === 0) return 'No matching session messages.'
  return scoped.slice(0, limit).map(formatHit).join('\n')
}

async function readOrScroll(
  store: SessionStore,
  sessionId: string,
  aroundMessageId: string | undefined,
  limit: number,
  ctx: ToolContext,
): Promise<string> {
  const resolved = await resolveScopedSession(store, sessionId, ctx)
  if (typeof resolved === 'string') return resolved
  const visible = visibleSessionMessages(resolved.messages)
  const picked =
    aroundMessageId !== undefined
      ? windowAroundMessages(visible, aroundMessageId, limit)
      : headTailMessages(visible, limit)
  if (aroundMessageId !== undefined && picked.length === 0) {
    return 'No matching message in that session.'
  }
  if (picked.length === 0) return 'No visible messages in that session.'
  return picked.map((msg) => formatSessionLine(resolved.session.id, msg)).join('\n')
}

async function browseSessions(
  store: SessionStore,
  limit: number,
  ctx: ToolContext,
): Promise<string> {
  const cwd = workspaceCwd(ctx)
  let parents: SessionRecord[] = []
  try {
    parents = await store.listSessions({ cwd, parentSessionId: null, limit })
  } catch {
    return 'No sessions in this workspace.'
  }
  if (parents.length === 0) return 'No sessions in this workspace.'
  return parents
    .map((session) => {
      const label = session.title?.trim() || session.model
      return `${session.id.slice(0, 8)} ${label}`
    })
    .join('\n')
}

async function resolveScopedSession(
  store: SessionStore,
  sessionId: string,
  ctx: ToolContext,
): Promise<{ session: SessionRecord; messages: Message[] } | string> {
  const cwd = workspaceCwd(ctx)
  const exact = await loadIfWorkspace(store, sessionId, cwd)
  if (exact !== undefined) return exact
  const local = await listWorkspaceSessions(store, ctx)
  const match = uniquePrefix(local, sessionId)
  if (!match) return 'Session not found in this workspace.'
  return (await loadIfWorkspace(store, match.id, cwd)) ?? 'Session not found in this workspace.'
}

async function loadIfWorkspace(
  store: SessionStore,
  sessionId: string,
  cwd: string,
): Promise<{ session: SessionRecord; messages: Message[] } | string | undefined> {
  try {
    const loaded = await store.loadSession(sessionId)
    if (loaded.session.cwd !== cwd) return 'Session not found in this workspace.'
    return loaded
  } catch (error) {
    if (error instanceof PersistError && error.code === 'unknown') return undefined
    throw error
  }
}

function uniquePrefix(sessions: SessionRecord[], prefix: string): SessionRecord | undefined {
  const hits = sessions.filter(
    (session) => session.id.startsWith(prefix) || session.id.slice(0, 8) === prefix,
  )
  return hits.length === 1 ? hits[0] : undefined
}

function workspaceCwd(ctx: ToolContext): string {
  return ctx.turn.projectCwd ?? ctx.turn.cwd
}

async function listWorkspaceSessions(
  store: SessionStore,
  ctx: ToolContext,
  limit?: number,
): Promise<SessionRecord[]> {
  const cwd = workspaceCwd(ctx)
  try {
    return await store.listSessions(limit === undefined ? { cwd } : { cwd, limit })
  } catch {
    return []
  }
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
  const local = await listWorkspaceSessions(store, ctx, 200)
  if (local.length > 0) {
    const ids = new Set(local.map((session) => session.id))
    out = out.filter((hit) => ids.has(hit.sessionId))
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
