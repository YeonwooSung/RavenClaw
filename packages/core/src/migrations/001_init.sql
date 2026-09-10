CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  cwd                TEXT NOT NULL,
  model              TEXT NOT NULL,
  permission_mode    TEXT NOT NULL,
  pre_plan_mode      TEXT,
  compact_generation INTEGER NOT NULL DEFAULT 0,
  usage_json         TEXT NOT NULL,
  title              TEXT,
  parent_session_id  TEXT REFERENCES sessions(id),
  funding            TEXT NOT NULL DEFAULT 'byok',
  active             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  created_at  INTEGER NOT NULL,
  role        TEXT NOT NULL,          -- user | assistant | tool
  blocks_json TEXT NOT NULL,
  tool_use_id TEXT,                   -- role=tool only
  ok          INTEGER,                -- role=tool only
  persist_path TEXT,
  usage_json  TEXT,
  active      INTEGER NOT NULL DEFAULT 1, -- 0 = pre-compact archive
  generation  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE compact_boundaries (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  generation  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  summary     TEXT NOT NULL,
  PRIMARY KEY (session_id, generation)
);

-- session scope only
CREATE TABLE permission_rules (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  tool       TEXT NOT NULL,
  spec_json  TEXT NOT NULL,
  behavior   TEXT NOT NULL            -- allow | deny | ask
);
