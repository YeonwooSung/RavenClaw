CREATE TABLE agent_mail (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at         INTEGER NOT NULL,
  body               TEXT NOT NULL
);
CREATE INDEX agent_mail_parent_created
  ON agent_mail (parent_session_id, created_at, id);

CREATE TABLE session_locks (
  session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  holder_id    TEXT NOT NULL,
  holder_pid   INTEGER,
  holder_name  TEXT,
  acquired_at  INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
