import type { Database } from 'bun:sqlite'
import type { SequencedStreamEvent, StreamEvent } from '../types'

export function streamEventAskCallId(event: StreamEvent): string | undefined {
  return event.type === 'permission_ask' ? event.id : undefined
}

export function toSequencedStreamEvent(event: StreamEvent, seq: number): SequencedStreamEvent {
  return { ...event, seq }
}

type StreamEventRow = {
  seq: number
  payload_json: string
}

export function appendStreamEventRow(db: Database, sessionId: string, event: StreamEvent): number {
  const askCallId = streamEventAskCallId(event)
  if (askCallId !== undefined) {
    const existing = db
      .query(`SELECT seq FROM stream_events WHERE session_id = ? AND ask_call_id = ?`)
      .get(sessionId, askCallId) as { seq: number } | null
    if (existing) return existing.seq
  }
  const max = db
    .query(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM stream_events WHERE session_id = ?`)
    .get(sessionId) as { max_seq: number }
  const seq = max.max_seq + 1
  db.query(
    `INSERT INTO stream_events (session_id, seq, payload_json, created_at, ask_call_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, seq, JSON.stringify(event), Date.now(), askCallId ?? null)
  return seq
}

export function listStreamEventRowsAfter(
  db: Database,
  sessionId: string,
  afterSeq: number,
): SequencedStreamEvent[] {
  const rows = db
    .query(
      `SELECT seq, payload_json FROM stream_events
       WHERE session_id = ? AND seq > ? ORDER BY seq`,
    )
    .all(sessionId, afterSeq) as StreamEventRow[]
  return rows.map((row) =>
    toSequencedStreamEvent(JSON.parse(row.payload_json) as StreamEvent, row.seq),
  )
}

export function lastStreamSeqRow(db: Database, sessionId: string): number {
  const row = db
    .query(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM stream_events WHERE session_id = ?`)
    .get(sessionId) as { max_seq: number }
  return row.max_seq
}

export function deleteStreamEventsBySession(db: Database, sessionId: string): void {
  db.query(`DELETE FROM stream_events WHERE session_id = ?`).run(sessionId)
}
