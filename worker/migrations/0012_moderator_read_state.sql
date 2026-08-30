-- Items already have a monotonic version that advances on every change, so seen_version
-- is the exact read key. Commands have no version and therefore use their updated_at value.
ALTER TABLE moderator_items ADD COLUMN seen_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE moderator_commands ADD COLUMN seen_at TEXT;
