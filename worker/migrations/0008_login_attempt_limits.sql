-- Authentication throttling stores only a hash of route + IP + account, never raw login metadata.
CREATE TABLE login_attempt_limits (
  key_hash TEXT PRIMARY KEY,
  minute_started_at INTEGER NOT NULL,
  minute_attempts INTEGER NOT NULL DEFAULT 0 CHECK (minute_attempts >= 0),
  failure_window_started_at INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_login_attempt_limits_updated_at
ON login_attempt_limits(updated_at);
