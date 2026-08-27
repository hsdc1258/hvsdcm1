-- Append-only history used to derive per-phase duration and per-task AI limit consumption.
CREATE TABLE harness_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('report', 'phase-change')),
  actor_id TEXT,
  phase TEXT,
  percent REAL,
  model TEXT,
  reasoning TEXT,
  status TEXT,
  usage_codex REAL,
  usage_claude REAL,
  payload TEXT
);

CREATE INDEX idx_harness_events_task_id_id
ON harness_events(task_id, id);
