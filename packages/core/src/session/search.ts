import type { Database } from 'bun:sqlite'
import type { Message } from '../types'

export type MessageSearchHit = {
  sessionId: string
  messageId: string
  snippet: string
  rank: number
}

const CREATE_FTS_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  session_id UNINDEXED,
  message_id UNINDEXED,
  body
)`

function isIndexableText(value: string): boolean {
  return value.length > 0 && !value.includes('\0')
}

function stringifyInput(input: unknown): string | null {
  if (input == null) return null
  if (typeof input === 'string') return isIndexableText(input) ? input : null
  if (typeof input === 'number' || typeof input === 'boolean') return String(input)
  if (typeof input === 'object') {
    try {
      const text = JSON.stringify(input)
      return isIndexableText(text) ? text : null
    } catch {
      return null
    }
  }
  return null
}

export function extractSearchText(blocksJson: string): string {
  let blocks: unknown
  try {
    blocks = JSON.parse(blocksJson)
  } catch {
    return ''
  }
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const type = (block as { type?: unknown }).type
    if (type === 'text' || type === 'thinking') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && isIndexableText(text)) parts.push(text)
      continue
    }
    if (type === 'tool_use') {
      const name = (block as { name?: unknown }).name
      if (typeof name === 'string' && isIndexableText(name)) parts.push(name)
      const inputText = stringifyInput((block as { input?: unknown }).input)
      if (inputText) parts.push(inputText)
    }
  }
  return parts.join(' ')
}

function toMatchQuery(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return ''
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ')
}

export function rebuildMessagesFts(db: Database): void {
  try {
    db.exec(CREATE_FTS_SQL)
    const rows = db
      .query(`SELECT id, session_id, blocks_json FROM messages WHERE active = 1`)
      .all() as Array<{ id: string; session_id: string; blocks_json: string }>
    const rebuild = db.transaction((items: typeof rows) => {
      db.exec('DELETE FROM messages_fts')
      const insert = db.query(
        `INSERT INTO messages_fts (session_id, message_id, body)
         VALUES ($session_id, $message_id, $body)`,
      )
      for (const row of items) {
        const body = extractSearchText(row.blocks_json)
        if (!body) continue
        insert.run({
          $session_id: row.session_id,
          $message_id: row.id,
          $body: body,
        })
      }
    })
    rebuild(rows)
  } catch {
    // FTS is advisory; persist/load must not fail because search is broken.
  }
}

export function indexMessageFts(db: Database, sessionId: string, message: Message): void {
  try {
    const body = extractSearchText(JSON.stringify(message.blocks))
    db.query('DELETE FROM messages_fts WHERE message_id = ?').run(message.id)
    if (!body) return
    db.query(
      `INSERT INTO messages_fts (session_id, message_id, body)
       VALUES (?, ?, ?)`,
    ).run(sessionId, message.id, body)
  } catch {
    // fail-open
  }
}

export function unindexMessagesFts(db: Database, messageIds: string[]): void {
  try {
    const del = db.query('DELETE FROM messages_fts WHERE message_id = ?')
    for (const id of messageIds) del.run(id)
  } catch {
    // fail-open
  }
}

export function searchMessages(
  db: Database,
  query: string,
  opts?: { sessionId?: string; limit?: number },
): MessageSearchHit[] {
  const limit = opts?.limit ?? 20
  const match = toMatchQuery(query)
  if (!match || limit <= 0) return []

  const params: Array<string | number> = [match]
  let sql = `
    SELECT
      f.session_id AS sessionId,
      f.message_id AS messageId,
      snippet(messages_fts, 2, '', '', '…', 32) AS snippet,
      rank AS rank
    FROM messages_fts AS f
    INNER JOIN messages AS m ON m.id = f.message_id
    WHERE messages_fts MATCH ?
      AND m.active = 1
  `
  if (opts?.sessionId !== undefined) {
    sql += ' AND f.session_id = ?'
    params.push(opts.sessionId)
  }
  sql += ' ORDER BY rank LIMIT ?'
  params.push(limit)

  const rows = db.query(sql).all(...params) as Array<{
    sessionId: string
    messageId: string
    snippet: string | null
    rank: number | null
  }>
  return rows.map((row) => ({
    sessionId: row.sessionId,
    messageId: row.messageId,
    snippet: row.snippet ?? '',
    rank: row.rank ?? 0,
  }))
}
