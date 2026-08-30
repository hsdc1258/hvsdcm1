-- Turning the unread axis on leaves every existing row unread, because 0012 defaults
-- seen_version to 0. That means the first screen after the feature ships is the same
-- 24-row pile it was meant to clear: every one of those rows is already decided
-- (acknowledged, resolved, approved, rejected, done).
--
-- A row whose decision is already made is not news. Treat it as read once, here, so the
-- inbox starts where it belongs. Rows that still need a hand are deliberately excluded:
-- important/open and proposal/pending are unread regardless of seen_version, so this
-- statement cannot silence them, and the WHERE clause says so on purpose rather than
-- relying on that invariant holding forever.
UPDATE moderator_items
SET seen_version = version
WHERE NOT (
  (kind = 'important' AND status = 'open')
  OR (kind = 'proposal' AND status = 'pending')
);
