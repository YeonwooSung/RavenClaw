import type { Database } from 'bun:sqlite'
import type { PermissionScope } from '../types'

export type PendingAskKind = 'leftover' | 'ask_user'

export type PendingAsk = {
  callId: string
  sessionId: string
  kind: PendingAskKind
  tool: string
  message: string
  input: unknown
  saveAs?: PermissionScope
  withheldAssistantId?: string
  createdAt: number
}

export type PendingAskAnswer = 'allow' | 'deny' | 'allow_always' | 'ignored'

const PENDING_ASK_ANSWERS: readonly PendingAskAnswer[] = [
  'allow',
  'deny',
  'allow_always',
  'ignored',
]

export function isPendingAskAnswer(value: unknown): value is PendingAskAnswer {
  return typeof value === 'string' && (PENDING_ASK_ANSWERS as readonly string[]).includes(value)
}

type PendingAskSqlRow = {
  call_id: string
  session_id: string
  kind: string
  tool: string
  message: string
  input_json: string | null
  save_as: string | null
  withheld_assistant_id: string | null
  created_at: number
}

function askFromRow(row: PendingAskSqlRow): PendingAsk {
  const ask: PendingAsk = {
    callId: row.call_id,
    sessionId: row.session_id,
    kind: row.kind as PendingAskKind,
    tool: row.tool,
    message: row.message,
    input: row.input_json == null ? null : JSON.parse(row.input_json),
    createdAt: row.created_at,
  }
  if (row.save_as != null) ask.saveAs = row.save_as as PermissionScope
  if (row.withheld_assistant_id != null) ask.withheldAssistantId = row.withheld_assistant_id
  return ask
}

export function upsertPendingAskRow(db: Database, row: PendingAsk): void {
  db.query(
    `INSERT INTO pending_asks (
       call_id, session_id, kind, tool, message, input_json, save_as,
       withheld_assistant_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(call_id) DO UPDATE SET
       session_id = excluded.session_id,
       kind = excluded.kind,
       tool = excluded.tool,
       message = excluded.message,
       input_json = excluded.input_json,
       save_as = excluded.save_as,
       withheld_assistant_id = excluded.withheld_assistant_id,
       created_at = excluded.created_at`,
  ).run(
    row.callId,
    row.sessionId,
    row.kind,
    row.tool,
    row.message,
    JSON.stringify(row.input) ?? null,
    row.saveAs ?? null,
    row.withheldAssistantId ?? null,
    row.createdAt,
  )
}

export function listPendingAskRows(db: Database, sessionId: string): PendingAsk[] {
  const rows = db
    .query(
      `SELECT call_id, session_id, kind, tool, message, input_json, save_as,
              withheld_assistant_id, created_at
       FROM pending_asks
       WHERE session_id = ?
       ORDER BY created_at, call_id`,
    )
    .all(sessionId) as PendingAskSqlRow[]
  return rows.map(askFromRow)
}

export function getPendingAskRow(db: Database, callId: string): PendingAsk | undefined {
  const row = db
    .query(
      `SELECT call_id, session_id, kind, tool, message, input_json, save_as,
              withheld_assistant_id, created_at
       FROM pending_asks
       WHERE call_id = ?`,
    )
    .get(callId) as PendingAskSqlRow | null
  return row ? askFromRow(row) : undefined
}

export function deletePendingAskRow(db: Database, callId: string): void {
  db.query(`DELETE FROM pending_asks WHERE call_id = ?`).run(callId)
}
