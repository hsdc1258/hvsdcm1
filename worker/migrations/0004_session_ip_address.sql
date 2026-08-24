ALTER TABLE sessions ADD COLUMN ip_address TEXT;

CREATE INDEX sessions_user_last_seen ON sessions(user_id, last_seen_at DESC);
