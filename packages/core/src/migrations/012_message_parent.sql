ALTER TABLE messages ADD COLUMN parent_id TEXT;
ALTER TABLE sessions ADD COLUMN leaf_id TEXT;

UPDATE messages
SET parent_id = (
  SELECT older.id
  FROM messages AS older
  WHERE older.session_id = messages.session_id
    AND older.active = 1
    AND (
      older.created_at < messages.created_at
      OR (older.created_at = messages.created_at AND older.rowid < messages.rowid)
    )
  ORDER BY older.created_at DESC, older.rowid DESC
  LIMIT 1
)
WHERE active = 1;

UPDATE sessions
SET leaf_id = (
  SELECT id
  FROM messages
  WHERE messages.session_id = sessions.id
    AND messages.active = 1
  ORDER BY created_at DESC, rowid DESC
  LIMIT 1
);
