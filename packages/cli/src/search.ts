import { join } from 'node:path'
import {
  createSqliteStore,
  ravenclawHome,
  searchSessionStore,
  type MessageSearchHit,
  type SessionStore,
} from '@ravenclaw/core'

export const SEARCH_LIMIT = 8

export function formatSearchNotice(hits: MessageSearchHit[]): string {
  if (hits.length === 0) return 'no matches'
  return hits
    .slice(0, SEARCH_LIMIT)
    .map((hit) => `${hit.sessionId.slice(0, 8)}  ${singleLine(hit.snippet)}`)
    .join('\n')
}

export function searchNotice(opts: {
  store: SessionStore
  arg?: string
  sessionId: string
}): string {
  const parsed = parseSearchArg(opts.arg)
  if (parsed === undefined) return 'usage: /search <query>'
  const hits = searchSessionStore(opts.store, parsed.query, {
    ...(parsed.all ? {} : { sessionId: opts.sessionId }),
    limit: SEARCH_LIMIT,
  })
  return formatSearchNotice(hits)
}

function parseSearchArg(arg: string | undefined): { query: string; all: boolean } | undefined {
  if (arg === undefined || arg.trim() === '') return undefined
  if (arg.startsWith('--all ')) {
    const query = arg.slice('--all '.length)
    if (query.trim() === '') return undefined
    return { query, all: true }
  }
  return { query: arg, all: false }
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export async function searchCliSessions(opts: {
  query: string
  home?: string
  cwd?: string
  all?: boolean
}): Promise<string> {
  const query = opts.query.trim()
  if (query === '') return 'usage: raven search [--all] <query>'
  const home = opts.home ?? ravenclawHome()
  const store = createSqliteStore(join(home, 'state.db')) as ReturnType<
    typeof createSqliteStore
  > & { close(): void }
  try {
    const hits = searchSessionStore(store, query, { limit: SEARCH_LIMIT * 4 })
    if (opts.all) return formatSearchNotice(hits)
    const cwd = opts.cwd ?? process.cwd()
    const local = new Set(
      (await store.listSessions({ cwd, limit: 200 })).map((row) => row.id),
    )
    return formatSearchNotice(hits.filter((hit) => local.has(hit.sessionId)))
  } finally {
    store.close()
  }
}
