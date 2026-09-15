CREATE TABLE IF NOT EXISTS pending_asks (
  call_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT NOT NULL,
  message TEXT NOT NULL,
  input_json TEXT,
  save_as TEXT,
  withheld_assistant_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_asks_session ON pending_asks(session_id);
