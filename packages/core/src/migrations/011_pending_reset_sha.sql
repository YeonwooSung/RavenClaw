ALTER TABLE sessions ADD COLUMN pending_reset_sha TEXT;
UPDATE sessions
SET pending_reset_sha = json_extract(job_json, '$.pendingResetSha')
WHERE json_extract(job_json, '$.pendingResetSha') IS NOT NULL
  AND json_extract(job_json, '$.pendingResetSha') != '';
