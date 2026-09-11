import {
  createSqliteStore,
  ravenclawHome,
  type Message,
  type SessionRecord,
} from '@ravenclaw/core'
import { join } from 'node:path'

function openStore(home: string) {
  return createSqliteStore(join(home, 'state.db')) as ReturnType<typeof createSqliteStore> & {
    close(): void
  }
}

export function formatResumeSessionLine(session: SessionRecord): string {
  const label =
    session.title !== undefined && session.title !== '' ? session.title : session.model
  return `${session.id.slice(0, 8)}  ${label}  ${session.updatedAt}`
}

export async function listCliSessions(opts?: {
  home?: string
  cwd?: string
  limit?: number
}): Promise<SessionRecord[]> {
  const home = opts?.home ?? ravenclawHome()
  const store = openStore(home)
  try {
    return await store.listSessions({
      cwd: opts?.cwd ?? process.cwd(),
      parentSessionId: null,
      limit: opts?.limit ?? 20,
    })
  } finally {
    store.close()
  }
}

export function formatMessageLine(message: Message): string {
  if (message.role === 'user') return `user: ${textOf(message)}`
  if (message.role === 'assistant') {
    const tools = message.blocks.filter((b) => b.type === 'tool_use')
    const text = textOf(message)
    if (tools.length === 0) return `assistant: ${text}`
    const names = tools.map((b) => (b.type === 'tool_use' ? b.name : '')).join(', ')
    return text === '' ? `assistant: [${names}]` : `assistant: ${text} [${names}]`
  }
  const body = textOf(message)
  const clipped = body.length > 200 ? `${body.slice(0, 200)}…` : body
  return `tool(${message.ok ? 'ok' : 'err'}): ${clipped}`
}

export function formatSessionTranscript(
  session: SessionRecord,
  messages: Message[],
): string {
  const header = formatResumeSessionLine(session)
  const body = messages.map(formatMessageLine).join('\n')
  return body === '' ? header : `${header}\n${body}`
}

export async function showCliSession(
  prefix: string,
  opts?: { home?: string },
): Promise<{ text: string } | { error: string }> {
  const id = prefix.trim()
  if (id === '') return { error: 'usage: raven show <session-id>' }
  const home = opts?.home ?? ravenclawHome()
  const store = openStore(home)
  try {
    const resolved = await resolveSessionId(store, id)
    if (typeof resolved !== 'string') return resolved
    const loaded = await store.loadSession(resolved)
    return { text: formatSessionTranscript(loaded.session, loaded.messages) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    store.close()
  }
}

async function resolveSessionId(
  store: { loadSession: (id: string) => Promise<unknown>; listSessions: (f?: object) => Promise<SessionRecord[]> },
  prefix: string,
): Promise<string | { error: string }> {
  try {
    await store.loadSession(prefix)
    return prefix
  } catch {
    /* prefix search */
  }
  const rows = await store.listSessions({ limit: 200 })
  const hits = rows.filter((row) => row.id === prefix || row.id.startsWith(prefix))
  if (hits.length === 1 && hits[0]) return hits[0].id
  if (hits.length === 0) return { error: `session not found: ${prefix}` }
  return { error: `ambiguous session id: ${prefix}` }
}

function textOf(message: Message): string {
  return message.blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}
