-- Owner-only AI harness state mirrored from the same local reporting events sent to Discord.
CREATE TABLE harness_tasks (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'complete')),
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX idx_harness_tasks_status_updated
ON harness_tasks(status, updated_at DESC);
