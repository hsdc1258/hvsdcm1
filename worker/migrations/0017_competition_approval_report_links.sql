-- Approval requests are immutable actions, while competition reports are immutable snapshots.
-- Link the same action to later snapshots without duplicating or rebinding the request, so an
-- owner decision survives a new discovery/verification report with the identical action hash.
CREATE TABLE competition_report_approval_requests (
  idempotency_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  contest_id TEXT NOT NULL,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  action_sha256 TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT,
  read_summary TEXT NOT NULL,
  approval_text TEXT NOT NULL,
  PRIMARY KEY(idempotency_key, request_id),
  UNIQUE(idempotency_key, contest_id, category),
  FOREIGN KEY(idempotency_key, contest_id, category)
    REFERENCES competition_candidates(idempotency_key, contest_id, category) ON DELETE RESTRICT,
  FOREIGN KEY(request_id, action_sha256)
    REFERENCES competition_approval_requests(request_id, action_sha256) ON DELETE RESTRICT
) WITHOUT ROWID;

INSERT INTO competition_report_approval_requests(
  idempotency_key, request_id, contest_id, category, kind, action_sha256,
  requested_at, expires_at, read_summary, approval_text
)
SELECT idempotency_key, request_id, contest_id, category, kind, action_sha256,
  requested_at, expires_at, read_summary, approval_text
FROM competition_approval_requests;

CREATE TRIGGER competition_report_approval_requests_match_action
BEFORE INSERT ON competition_report_approval_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM competition_approval_requests AS request
  JOIN competition_applications AS application
    ON application.idempotency_key = NEW.idempotency_key
   AND application.contest_id = NEW.contest_id
   AND application.category = NEW.category
  WHERE request.request_id = NEW.request_id
    AND request.contest_id = NEW.contest_id
    AND request.category = NEW.category
    AND request.kind = NEW.kind
    AND request.action_sha256 = NEW.action_sha256
    AND request.requested_at = NEW.requested_at
    AND request.expires_at IS NEW.expires_at
    AND request.read_summary = NEW.read_summary
    AND request.approval_text = NEW.approval_text
    AND (
      (request.kind = 'preparation' AND application.state = 'WAITING_RIGHTS_APPROVAL')
      OR (request.kind = 'legal_consent' AND application.state = 'WAITING_LEGAL_CONSENT')
      OR (request.kind = 'rights_acceptance' AND application.state = 'WAITING_RIGHTS_APPROVAL')
      OR (request.kind = 'payment' AND application.state = 'WAITING_FEE_APPROVAL')
      OR (request.kind = 'final_submission' AND application.state = 'WAITING_APPROVAL')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'competition approval report link does not match action or application');
END;

-- During migration rollout the old Worker still writes the origin approval request but does not
-- know about report links. Bridge that short compatibility window; the new Worker repeats this
-- insert with ON CONFLICT DO NOTHING after checking the exact immutable fields.
CREATE TRIGGER competition_approval_requests_link_origin_report
AFTER INSERT ON competition_approval_requests
BEGIN
  INSERT INTO competition_report_approval_requests(
    idempotency_key, request_id, contest_id, category, kind, action_sha256,
    requested_at, expires_at, read_summary, approval_text
  ) VALUES (
    NEW.idempotency_key, NEW.request_id, NEW.contest_id, NEW.category, NEW.kind,
    NEW.action_sha256, NEW.requested_at, NEW.expires_at, NEW.read_summary, NEW.approval_text
  );
END;

CREATE TRIGGER competition_report_approval_requests_no_update
BEFORE UPDATE ON competition_report_approval_requests
BEGIN SELECT RAISE(ABORT, 'competition approval report links are immutable'); END;

CREATE TRIGGER competition_report_approval_requests_no_delete
BEFORE DELETE ON competition_report_approval_requests
BEGIN SELECT RAISE(ABORT, 'competition approval report links are immutable'); END;

CREATE INDEX idx_competition_report_approval_requests_request
ON competition_report_approval_requests(request_id, idempotency_key);

-- The final statement in each new-Worker batch inserts one guard row. The expected previous report
-- closes the race where two reporters read the same latest snapshot, while the trigger can inspect
-- all normalized child rows and roll back the whole batch on a state regression.
CREATE TABLE competition_report_guards (
  idempotency_key TEXT PRIMARY KEY,
  prior_idempotency_key TEXT,
  enforce_continuity INTEGER NOT NULL CHECK(enforce_continuity IN (0, 1)),
  approval_count INTEGER NOT NULL CHECK(approval_count BETWEEN 0 AND 3),
  FOREIGN KEY(idempotency_key)
    REFERENCES competition_reports(idempotency_key) ON DELETE RESTRICT,
  FOREIGN KEY(prior_idempotency_key)
    REFERENCES competition_reports(idempotency_key) ON DELETE RESTRICT
) WITHOUT ROWID;

INSERT INTO competition_report_guards(
  idempotency_key, prior_idempotency_key, enforce_continuity, approval_count
)
SELECT report.idempotency_key, NULL, 0, COUNT(link.request_id)
FROM competition_reports AS report
LEFT JOIN competition_report_approval_requests AS link
  ON link.idempotency_key = report.idempotency_key
GROUP BY report.idempotency_key;

CREATE TRIGGER competition_report_guards_match_prior
BEFORE INSERT ON competition_report_guards
WHEN (
  SELECT report.idempotency_key
  FROM competition_reports AS report
  WHERE report.idempotency_key != NEW.idempotency_key
  ORDER BY COALESCE(report.finished_at, report.started_at) DESC,
    report.received_at DESC, report.idempotency_key DESC
  LIMIT 1
) IS NOT NEW.prior_idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'competition report prior changed');
END;

CREATE TRIGGER competition_report_guards_require_complete_approvals
BEFORE INSERT ON competition_report_guards
WHEN (
  SELECT COUNT(*) FROM competition_report_approval_requests
  WHERE idempotency_key = NEW.idempotency_key
) != NEW.approval_count
BEGIN
  SELECT RAISE(ABORT, 'competition report approval links incomplete');
END;

CREATE TRIGGER competition_report_guards_preserve_latest_state
BEFORE INSERT ON competition_report_guards
WHEN NEW.enforce_continuity = 1 AND NEW.prior_idempotency_key IS NOT NULL AND (
  EXISTS (
    SELECT 1
    FROM competition_candidates AS old
    WHERE old.idempotency_key = NEW.prior_idempotency_key
      AND old.official_verification = 'verified'
      AND NOT EXISTS (
        SELECT 1
        FROM competition_candidates AS fresh
        WHERE fresh.idempotency_key = NEW.idempotency_key
          AND fresh.contest_id = old.contest_id
          AND fresh.category = old.category
          AND fresh.official_verification = 'verified'
          AND fresh.official_verified_at >= old.official_verified_at
          AND (
            fresh.official_verified_at > old.official_verified_at
            OR (
              fresh.organizer IS old.organizer
              AND fresh.official_url IS old.official_url
              AND fresh.acceptance IS old.acceptance
              AND fresh.deadline_at IS old.deadline_at
              AND fresh.eligibility IS old.eligibility
              AND fresh.rights_risk IS old.rights_risk
              AND fresh.submission_risk IS old.submission_risk
              AND fresh.status IS old.status
            )
          )
      )
  )
  OR EXISTS (
    SELECT 1
    FROM competition_applications AS old
    WHERE old.idempotency_key = NEW.prior_idempotency_key
      AND NOT EXISTS (
        SELECT 1
        FROM competition_applications AS fresh
        WHERE fresh.idempotency_key = NEW.idempotency_key
          AND fresh.contest_id = old.contest_id
          AND fresh.category = old.category
          AND fresh.profile_id = old.profile_id
          AND fresh.updated_at >= old.updated_at
          AND (
            fresh.updated_at > old.updated_at
            OR (
              fresh.state IS old.state
              AND fresh.blocker IS old.blocker
              AND fresh.next_action IS old.next_action
            )
          )
      )
  )
  OR EXISTS (
    SELECT 1
    FROM competition_report_approval_requests AS old
    WHERE old.idempotency_key = NEW.prior_idempotency_key
      AND NOT (
        EXISTS (
          -- An identical request carries its decision; a changed action must use a new request ID
          -- and therefore returns to a visible pending decision instead of reusing the old one.
          SELECT 1
          FROM competition_report_approval_requests AS fresh
          WHERE fresh.idempotency_key = NEW.idempotency_key
            AND fresh.contest_id = old.contest_id
            AND fresh.category = old.category
        )
        OR EXISTS (
          -- Dropping the gate entirely is allowed only after the exact old action was approved and
          -- the redacted application advanced, with a later evidence time, to a kind-specific state.
          SELECT 1
          FROM competition_approval_decisions AS decision
          JOIN competition_applications AS old_application
            ON old_application.idempotency_key = old.idempotency_key
           AND old_application.contest_id = old.contest_id
           AND old_application.category = old.category
          JOIN competition_applications AS fresh_application
            ON fresh_application.idempotency_key = NEW.idempotency_key
           AND fresh_application.contest_id = old.contest_id
           AND fresh_application.category = old.category
           AND fresh_application.profile_id = old_application.profile_id
          WHERE decision.request_id = old.request_id
            AND decision.action_sha256 = old.action_sha256
            AND decision.decision = 'approved'
            AND fresh_application.updated_at > old_application.updated_at
            AND fresh_application.updated_at >= decision.decided_at
            AND (
              (old.kind = 'preparation' AND fresh_application.state IN (
                'PREPARED', 'VALIDATED', 'WAITING_LEGAL_CONSENT', 'WAITING_RIGHTS_APPROVAL',
                'WAITING_FEE_APPROVAL', 'WAITING_APPROVAL'
              ))
              OR (old.kind = 'rights_acceptance' AND fresh_application.state IN (
                'VALIDATED', 'WAITING_LEGAL_CONSENT', 'WAITING_FEE_APPROVAL',
                'WAITING_APPROVAL'
              ))
              OR (old.kind = 'legal_consent' AND fresh_application.state IN (
                'WAITING_RIGHTS_APPROVAL', 'WAITING_FEE_APPROVAL', 'WAITING_APPROVAL'
              ))
              OR (old.kind = 'payment' AND fresh_application.state IN (
                'WAITING_APPROVAL'
              ))
              OR (old.kind = 'final_submission' AND fresh_application.state IN (
                'AUTHORIZED', 'SUBMITTING', 'SUBMISSION_UNKNOWN'
              ))
            )
        )
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'competition report state regression');
END;

CREATE TRIGGER competition_report_guards_no_update
BEFORE UPDATE ON competition_report_guards
BEGIN SELECT RAISE(ABORT, 'competition report guards are immutable'); END;

CREATE TRIGGER competition_report_guards_no_delete
BEFORE DELETE ON competition_report_guards
BEGIN SELECT RAISE(ABORT, 'competition report guards are immutable'); END;
