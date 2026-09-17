ALTER TABLE sessions ADD COLUMN job_json TEXT;
ALTER TABLE sessions ADD COLUMN job_auto_commit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN checkpoint_json TEXT;
