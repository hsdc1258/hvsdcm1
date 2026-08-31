-- Queue only the exact final action that the owner approved. Jobs retain public/redacted
-- identifiers and receipt references only; submission payloads, PII, answers, consent text,
-- cookies and raw organizer receipts stay outside D1.
ALTER TABLE competition_approval_requests
ADD COLUMN submission_url TEXT CHECK(submission_url IS NULL OR (
  length(submission_url) BETWEEN 9 AND 2048
  AND lower(substr(submission_url, 1, 8)) = 'https://'
));

ALTER TABLE competition_approval_requests
ADD COLUMN action_manifest_json TEXT CHECK(action_manifest_json IS NULL OR (
  length(action_manifest_json) BETWEEN 2 AND 8192
  AND json_valid(action_manifest_json)
));

CREATE TRIGGER competition_approval_requests_submission_destination
BEFORE INSERT ON competition_approval_requests
WHEN (NEW.kind = 'final_submission'
    AND (NEW.submission_url IS NULL OR NEW.action_manifest_json IS NULL))
  OR (NEW.kind <> 'final_submission'
    AND (NEW.submission_url IS NOT NULL OR NEW.action_manifest_json IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'competition final approval requires one submission destination');
END;

CREATE TABLE competition_submission_jobs (
  job_id TEXT PRIMARY KEY
    CHECK(length(job_id) BETWEEN 1 AND 160
      AND substr(job_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND job_id NOT GLOB '*[^A-Za-z0-9._-]*'),
  request_id TEXT NOT NULL UNIQUE,
  action_sha256 TEXT NOT NULL
    CHECK(length(action_sha256) = 64 AND action_sha256 NOT GLOB '*[^0-9a-f]*'),
  idempotency_key TEXT NOT NULL,
  contest_id TEXT NOT NULL,
  category TEXT NOT NULL,
  official_url TEXT NOT NULL CHECK(length(official_url) BETWEEN 9 AND 2048),
  submission_url TEXT NOT NULL CHECK(length(submission_url) BETWEEN 9 AND 2048
    AND lower(substr(submission_url, 1, 8)) = 'https://'),
  action_manifest_json TEXT NOT NULL CHECK(length(action_manifest_json) BETWEEN 2 AND 8192
    AND json_valid(action_manifest_json)),
  approval_expires_at TEXT NOT NULL CHECK(length(approval_expires_at) = 24
    AND substr(approval_expires_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(approval_expires_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', approval_expires_at) IS NOT NULL
    AND approval_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', approval_expires_at)),
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'claimed', 'running', 'succeeded', 'blocked', 'submission_unknown'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count IN (0, 1)),
  lease_id TEXT CHECK(lease_id IS NULL OR (
    length(lease_id) BETWEEN 1 AND 160
    AND substr(lease_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND lease_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  )),
  lease_until TEXT CHECK(lease_until IS NULL OR (length(lease_until) = 24
    AND substr(lease_until, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(lease_until, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', lease_until) IS NOT NULL
    AND lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', lease_until))),
  queued_at TEXT NOT NULL CHECK(length(queued_at) = 24
    AND substr(queued_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(queued_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', queued_at) IS NOT NULL
    AND queued_at = strftime('%Y-%m-%dT%H:%M:%fZ', queued_at)),
  claimed_at TEXT CHECK(claimed_at IS NULL OR (length(claimed_at) = 24
    AND substr(claimed_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(claimed_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at) IS NOT NULL
    AND claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at))),
  started_at TEXT CHECK(started_at IS NULL OR (length(started_at) = 24
    AND substr(started_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(started_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS NOT NULL
    AND started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at))),
  completed_at TEXT CHECK(completed_at IS NULL OR (length(completed_at) = 24
    AND substr(completed_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(completed_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS NOT NULL
    AND completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at))),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 24
    AND substr(updated_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(updated_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
    AND updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  result_code TEXT CHECK(result_code IS NULL OR result_code IN (
    'submitted',
    'approval_expired', 'unsupported_organizer_flow', 'private_config_missing', 'destination_mismatch',
    'captcha_required', 'account_required', 'payment_required', 'terms_changed',
    'eligibility_unknown', 'manual_action_required', 'destination_unavailable',
    'timeout_after_send', 'connection_lost_after_send', 'ambiguous_response', 'lease_expired'
  )),
  receipt_reference TEXT CHECK(receipt_reference IS NULL OR (
    length(receipt_reference) BETWEEN 1 AND 96
    AND substr(receipt_reference, 1, 1) GLOB '[A-Za-z0-9]'
    AND receipt_reference NOT GLOB '*[^A-Za-z0-9._:-]*'
  )),
  FOREIGN KEY(request_id, action_sha256)
    REFERENCES competition_approval_requests(request_id, action_sha256) ON DELETE RESTRICT,
  FOREIGN KEY(idempotency_key, contest_id, category)
    REFERENCES competition_candidates(idempotency_key, contest_id, category) ON DELETE RESTRICT,
  UNIQUE(request_id, action_sha256),
  CHECK(updated_at >= queued_at),
  CHECK(claimed_at IS NULL OR claimed_at >= queued_at),
  CHECK(started_at IS NULL OR (claimed_at IS NOT NULL AND started_at >= claimed_at)),
  CHECK(completed_at IS NULL
    OR (claimed_at IS NOT NULL AND completed_at >= claimed_at)
    OR (status = 'blocked' AND result_code = 'approval_expired'
      AND claimed_at IS NULL AND completed_at >= queued_at)),
  CHECK(
    (status = 'queued' AND attempt_count = 0 AND lease_id IS NULL AND lease_until IS NULL
      AND claimed_at IS NULL AND started_at IS NULL AND completed_at IS NULL
      AND result_code IS NULL AND receipt_reference IS NULL)
    OR (status = 'claimed' AND attempt_count = 1 AND lease_id IS NOT NULL
      AND lease_until IS NOT NULL AND claimed_at IS NOT NULL AND started_at IS NULL
      AND completed_at IS NULL AND result_code IS NULL AND receipt_reference IS NULL)
    OR (status = 'running' AND attempt_count = 1 AND lease_id IS NOT NULL
      AND lease_until IS NOT NULL AND claimed_at IS NOT NULL AND started_at IS NOT NULL
      AND completed_at IS NULL AND result_code IS NULL AND receipt_reference IS NULL)
    OR (status = 'blocked' AND attempt_count = 0 AND lease_id IS NULL
      AND lease_until IS NULL AND claimed_at IS NULL AND started_at IS NULL
      AND completed_at IS NOT NULL AND result_code = 'approval_expired'
      AND receipt_reference IS NULL)
    OR (status IN ('succeeded', 'blocked', 'submission_unknown') AND attempt_count = 1
      AND lease_id IS NOT NULL AND lease_until IS NULL AND claimed_at IS NOT NULL
      AND completed_at IS NOT NULL AND result_code IS NOT NULL)
  ),
  CHECK(
    result_code IS NULL
    OR (status = 'succeeded' AND result_code = 'submitted')
    OR (status = 'blocked' AND result_code IN (
      'approval_expired', 'unsupported_organizer_flow', 'private_config_missing', 'destination_mismatch',
      'captcha_required', 'account_required', 'payment_required', 'terms_changed',
      'eligibility_unknown', 'manual_action_required', 'destination_unavailable'
    ))
    OR (status = 'submission_unknown' AND result_code IN (
      'timeout_after_send', 'connection_lost_after_send', 'ambiguous_response', 'lease_expired'
    ))
  ),
  CHECK(receipt_reference IS NULL OR status IN ('succeeded', 'submission_unknown'))
);

CREATE TRIGGER competition_submission_jobs_require_final_approval
BEFORE INSERT ON competition_submission_jobs
WHEN NOT EXISTS (
  SELECT 1
  FROM competition_approval_requests AS request
  JOIN competition_approval_decisions AS decision
    ON decision.request_id = request.request_id
   AND decision.action_sha256 = request.action_sha256
  JOIN competition_candidates AS candidate
    ON candidate.idempotency_key = request.idempotency_key
   AND candidate.contest_id = request.contest_id
   AND candidate.category = request.category
  WHERE request.request_id = NEW.request_id
    AND request.action_sha256 = NEW.action_sha256
    AND request.idempotency_key = NEW.idempotency_key
    AND request.contest_id = NEW.contest_id
    AND request.category = NEW.category
    AND request.kind = 'final_submission'
    AND decision.decision = 'approved'
    AND request.expires_at > decision.decided_at
    AND NEW.job_id = request.request_id
    AND NEW.official_url = candidate.official_url
    AND NEW.submission_url = request.submission_url
    AND NEW.action_manifest_json = request.action_manifest_json
    AND NEW.approval_expires_at = request.expires_at
    AND NEW.status = 'queued'
    AND NEW.attempt_count = 0
    AND NEW.queued_at = decision.decided_at
    AND NEW.updated_at = decision.decided_at
    AND request.idempotency_key = (
      SELECT idempotency_key
      FROM competition_reports
      ORDER BY COALESCE(finished_at, started_at) DESC,
        received_at DESC, idempotency_key DESC
      LIMIT 1
    )
)
BEGIN
  SELECT RAISE(ABORT, 'competition submission job requires latest final approval');
END;

CREATE TRIGGER competition_submission_jobs_structural_immutability
BEFORE UPDATE ON competition_submission_jobs
WHEN OLD.job_id IS NOT NEW.job_id
  OR OLD.request_id IS NOT NEW.request_id
  OR OLD.action_sha256 IS NOT NEW.action_sha256
  OR OLD.idempotency_key IS NOT NEW.idempotency_key
  OR OLD.contest_id IS NOT NEW.contest_id
  OR OLD.category IS NOT NEW.category
  OR OLD.official_url IS NOT NEW.official_url
  OR OLD.submission_url IS NOT NEW.submission_url
  OR OLD.action_manifest_json IS NOT NEW.action_manifest_json
  OR OLD.approval_expires_at IS NOT NEW.approval_expires_at
  OR OLD.queued_at IS NOT NEW.queued_at
  OR (OLD.claimed_at IS NOT NULL AND OLD.claimed_at IS NOT NEW.claimed_at)
  OR (OLD.started_at IS NOT NULL AND OLD.started_at IS NOT NEW.started_at)
  OR (OLD.completed_at IS NOT NULL AND OLD.completed_at IS NOT NEW.completed_at)
  OR (OLD.lease_id IS NOT NULL AND OLD.lease_id IS NOT NEW.lease_id)
  OR NEW.attempt_count < OLD.attempt_count
BEGIN
  SELECT RAISE(ABORT, 'competition submission job identity is immutable');
END;

CREATE TRIGGER competition_submission_jobs_forward_only
BEFORE UPDATE ON competition_submission_jobs
WHEN NOT (
  (OLD.status = 'queued' AND NEW.status = 'claimed')
  OR (OLD.status = 'queued' AND NEW.status = 'blocked' AND NEW.result_code = 'approval_expired')
  OR (OLD.status = 'claimed' AND NEW.status IN ('running', 'blocked', 'submission_unknown'))
  OR (OLD.status = 'running' AND NEW.status IN ('running', 'succeeded', 'blocked', 'submission_unknown'))
)
BEGIN
  SELECT RAISE(ABORT, 'competition submission job state must move forward');
END;

CREATE TRIGGER competition_submission_jobs_no_delete
BEFORE DELETE ON competition_submission_jobs
BEGIN SELECT RAISE(ABORT, 'competition submission jobs are durable'); END;

CREATE INDEX idx_competition_submission_jobs_queue
ON competition_submission_jobs(status, queued_at, job_id);
CREATE INDEX idx_competition_submission_jobs_application
ON competition_submission_jobs(idempotency_key, contest_id, category);
