-- Keep approval requests immutable and bind every owner decision to the exact action and wording
-- that was displayed. These records contain public/redacted review text only; PII, signatures,
-- organizer-term acceptance, payment details and submission payloads remain outside D1.
CREATE TABLE competition_approval_requests (
  request_id TEXT PRIMARY KEY
    CHECK(length(request_id) BETWEEN 1 AND 160
      AND substr(request_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND request_id NOT GLOB '*[^A-Za-z0-9._-]*'),
  idempotency_key TEXT NOT NULL,
  contest_id TEXT NOT NULL,
  category TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'preparation', 'legal_consent', 'rights_acceptance', 'payment', 'final_submission'
  )),
  action_sha256 TEXT NOT NULL
    CHECK(length(action_sha256) = 64 AND action_sha256 NOT GLOB '*[^0-9a-f]*'),
  requested_at TEXT NOT NULL CHECK(length(requested_at) = 24
    AND substr(requested_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(requested_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', requested_at) IS NOT NULL
    AND requested_at = strftime('%Y-%m-%dT%H:%M:%fZ', requested_at)),
  expires_at TEXT CHECK(expires_at IS NULL
    OR (length(expires_at) = 24
      AND substr(expires_at, 1, 4) BETWEEN '2000' AND '2100'
      AND substr(expires_at, 12, 2) BETWEEN '00' AND '23'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL
      AND expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at))),
  read_summary TEXT NOT NULL CHECK(length(read_summary) BETWEEN 1 AND 2000),
  approval_text TEXT NOT NULL CHECK(length(approval_text) BETWEEN 1 AND 1000),
  FOREIGN KEY(idempotency_key, contest_id, category)
    REFERENCES competition_candidates(idempotency_key, contest_id, category) ON DELETE RESTRICT,
  UNIQUE(idempotency_key, contest_id, category),
  UNIQUE(request_id, action_sha256),
  CHECK(expires_at IS NULL OR expires_at > requested_at),
  CHECK(
    kind = 'preparation'
    OR (expires_at IS NOT NULL
      AND unixepoch(expires_at) - unixepoch(requested_at) BETWEEN 1 AND 900)
  )
);

CREATE TABLE competition_approval_decisions (
  request_id TEXT PRIMARY KEY,
  action_sha256 TEXT NOT NULL
    CHECK(length(action_sha256) = 64 AND action_sha256 NOT GLOB '*[^0-9a-f]*'),
  decision TEXT NOT NULL CHECK(decision IN ('approved', 'held')),
  decided_at TEXT NOT NULL CHECK(length(decided_at) = 24
    AND substr(decided_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(decided_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) IS NOT NULL
    AND decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', decided_at)),
  FOREIGN KEY(request_id, action_sha256)
    REFERENCES competition_approval_requests(request_id, action_sha256) ON DELETE RESTRICT
);

CREATE TRIGGER competition_approval_requests_require_matching_application
BEFORE INSERT ON competition_approval_requests
WHEN NOT EXISTS (
  SELECT 1 FROM competition_applications
  WHERE idempotency_key = NEW.idempotency_key
    AND contest_id = NEW.contest_id
    AND category = NEW.category
    AND (
      (NEW.kind = 'preparation' AND state = 'WAITING_RIGHTS_APPROVAL')
      OR (NEW.kind = 'legal_consent' AND state = 'WAITING_LEGAL_CONSENT')
      OR (NEW.kind = 'rights_acceptance' AND state = 'WAITING_RIGHTS_APPROVAL')
      OR (NEW.kind = 'payment' AND state = 'WAITING_FEE_APPROVAL')
      OR (NEW.kind = 'final_submission' AND state = 'WAITING_APPROVAL')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'competition approval request does not match application state');
END;

CREATE TRIGGER competition_approval_requests_evidence_ceiling
BEFORE INSERT ON competition_approval_requests
WHEN NEW.requested_at > (
  SELECT COALESCE(finished_at, started_at)
  FROM competition_reports
  WHERE idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'approval request evidence cannot follow report observation');
END;

CREATE TRIGGER competition_approval_requests_no_update
BEFORE UPDATE ON competition_approval_requests
BEGIN SELECT RAISE(ABORT, 'competition approval requests are immutable'); END;
CREATE TRIGGER competition_approval_requests_no_delete
BEFORE DELETE ON competition_approval_requests
BEGIN SELECT RAISE(ABORT, 'competition approval requests are immutable'); END;
CREATE TRIGGER competition_approval_decisions_no_update
BEFORE UPDATE ON competition_approval_decisions
BEGIN SELECT RAISE(ABORT, 'competition approval decisions are immutable'); END;
CREATE TRIGGER competition_approval_decisions_no_delete
BEFORE DELETE ON competition_approval_decisions
BEGIN SELECT RAISE(ABORT, 'competition approval decisions are immutable'); END;

CREATE INDEX idx_competition_approval_requests_report
ON competition_approval_requests(idempotency_key, requested_at DESC, request_id);
