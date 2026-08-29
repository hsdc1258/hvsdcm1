-- Group harness tasks under one user-visible project so Discord and /usage can render one snapshot.
ALTER TABLE harness_tasks ADD COLUMN project_key TEXT NOT NULL DEFAULT '';
ALTER TABLE harness_tasks ADD COLUMN project_title TEXT NOT NULL DEFAULT '';

UPDATE harness_tasks
SET project_key = COALESCE(NULLIF(json_extract(payload, '$.project_key'), ''), task_id),
    project_title = COALESCE(
      NULLIF(json_extract(payload, '$.project_title'), ''),
      NULLIF(json_extract(payload, '$.title'), ''),
      NULLIF(json_extract(payload, '$.name'), ''),
      task_id
    );

CREATE INDEX idx_harness_tasks_project_updated
ON harness_tasks(project_key, updated_at DESC);
