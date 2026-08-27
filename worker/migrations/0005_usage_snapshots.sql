-- Collectors own payload shape; the API keeps only the latest snapshot per source.
CREATE TABLE usage_snapshots (
  source TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
