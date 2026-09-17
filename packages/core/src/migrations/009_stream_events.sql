CREATE TABLE IF NOT EXISTS stream_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ask_call_id TEXT,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS stream_events_ask ON stream_events(session_id, ask_call_id);
