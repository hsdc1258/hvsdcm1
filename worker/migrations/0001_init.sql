PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE progress (
  user_id INTEGER NOT NULL,
  app TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, app),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE shared_answers (
  app TEXT NOT NULL,
  question_id TEXT NOT NULL,
  normalized_answer TEXT NOT NULL,
  display_answer TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(app, question_id, normalized_answer),
  FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  event TEXT NOT NULL,
  app TEXT,
  created_at INTEGER NOT NULL,
  detail TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX activity_user_time ON activity(user_id, created_at DESC);
CREATE INDEX sessions_expiry ON sessions(expires_at);

