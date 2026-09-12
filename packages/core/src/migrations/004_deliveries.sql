CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_seen_at ON deliveries(seen_at);
