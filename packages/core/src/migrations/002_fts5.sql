CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  session_id UNINDEXED,
  message_id UNINDEXED,
  body
);

INSERT INTO messages_fts (session_id, message_id, body)
SELECT m.session_id, m.id, m.blocks_json
FROM messages m
WHERE NOT EXISTS (
  SELECT 1 FROM messages_fts AS f WHERE f.message_id = m.id
);
