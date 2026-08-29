-- Moderator control-plane state is server-owned. Keep commands separate from proposals so
-- approval and queue insertion can be enforced atomically without trusting the browser.
CREATE TABLE moderator_items (
  item_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('important', 'proposal', 'review')),
  status TEXT NOT NULL,
  issue_summary TEXT NOT NULL CHECK(length(issue_summary) BETWEEN 1 AND 240),
  action_summary TEXT NOT NULL CHECK(length(action_summary) BETWEEN 1 AND 240),
  proposed_command TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  brain_model TEXT,
  brain_reasoning TEXT,
  worker_model TEXT,
  worker_reasoning TEXT,
  source_task_id TEXT,
  lease_id TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK(
    (kind = 'important' AND status IN ('open', 'acknowledged', 'resolved'))
    OR (kind = 'proposal' AND status IN ('pending', 'rejected', 'approved'))
    OR (kind = 'review' AND status IN ('queued', 'running', 'done', 'failed', 'escalated'))
  ),
  CHECK(
    (kind = 'proposal' AND proposed_command IS NOT NULL AND length(trim(proposed_command)) > 0)
    OR (kind != 'proposal' AND proposed_command IS NULL)
  ),
  CHECK(
    (lease_id IS NULL AND lease_until IS NULL)
    OR (kind = 'review' AND lease_id IS NOT NULL AND lease_until IS NOT NULL)
  )
);

CREATE TABLE moderator_item_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  event TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  occurred_at TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(item_id) REFERENCES moderator_items(item_id) ON DELETE CASCADE
);

CREATE TABLE moderator_commands (
  command_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('direct', 'proposal', 'review')),
  source_item_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  command_text TEXT NOT NULL CHECK(length(trim(command_text)) > 0),
  status TEXT NOT NULL CHECK(status IN ('queued', 'claimed', 'running', 'succeeded', 'failed')),
  lease_id TEXT,
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  requested_model TEXT,
  requested_reasoning TEXT,
  actual_model TEXT,
  actual_reasoning TEXT,
  issue_summary TEXT CHECK(issue_summary IS NULL OR length(issue_summary) <= 240),
  action_summary TEXT CHECK(action_summary IS NULL OR length(action_summary) <= 240),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  claimed_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY(source_item_id) REFERENCES moderator_items(item_id) ON DELETE RESTRICT,
  CHECK(
    (source = 'direct' AND source_item_id IS NULL)
    OR (source IN ('proposal', 'review') AND source_item_id IS NOT NULL)
  )
);

CREATE INDEX idx_moderator_items_kind_status_updated
ON moderator_items(kind, status, updated_at DESC, item_id DESC);

-- Only one idle review can be queued or running, even when two daemons race.
CREATE UNIQUE INDEX idx_moderator_one_active_review
ON moderator_items(kind)
WHERE kind = 'review' AND status IN ('queued', 'running');

CREATE INDEX idx_moderator_events_item_version
ON moderator_item_events(item_id, version, id);

CREATE INDEX idx_moderator_commands_status_created
ON moderator_commands(status, created_at, command_id);
