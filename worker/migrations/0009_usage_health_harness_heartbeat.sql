-- Source health is updated even when a collector has no snapshot, while snapshots remain monotonic.
CREATE TABLE usage_source_health (
  source TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_attempt_at TEXT NOT NULL,
  last_outcome TEXT NOT NULL
);

INSERT INTO usage_source_health(source, last_success_at, last_attempt_at, last_outcome)
SELECT source, captured_at, captured_at, 'legacy'
FROM usage_snapshots;

-- Keep queryable copies of the user-facing contract beside the canonical JSON payload.
ALTER TABLE harness_tasks ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE harness_tasks ADD COLUMN input TEXT NOT NULL DEFAULT '';
ALTER TABLE harness_tasks ADD COLUMN heartbeat_at TEXT;

UPDATE harness_tasks
SET title = COALESCE(json_extract(payload, '$.title'), json_extract(payload, '$.name'), ''),
    input = COALESCE(json_extract(payload, '$.input'), ''),
    heartbeat_at = COALESCE(json_extract(payload, '$.heartbeat_at'), updated_at);
