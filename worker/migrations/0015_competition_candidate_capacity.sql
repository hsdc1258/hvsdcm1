-- Raise the strict report capacity to the API's 500-candidate contract while preserving
-- existing immutable snapshots and all relational safeguards.
CREATE TABLE competition_reports_v2 (
  idempotency_key TEXT PRIMARY KEY
    CHECK(length(idempotency_key) BETWEEN 1 AND 160
      AND substr(idempotency_key, 1, 1) GLOB '[A-Za-z0-9]'
      AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
  payload_hash TEXT NOT NULL
    CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  received_at TEXT NOT NULL CHECK(length(received_at) = 24
    AND substr(received_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(received_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', received_at) IS NOT NULL
    AND received_at = strftime('%Y-%m-%dT%H:%M:%fZ', received_at)),
  run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 160
    AND substr(run_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND run_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  run_date TEXT NOT NULL CHECK(length(run_date) = 10
    AND substr(run_date, 1, 4) BETWEEN '2000' AND '2100'
    AND date(run_date) IS NOT NULL AND date(run_date) = run_date),
  run_status TEXT NOT NULL CHECK(run_status IN ('running', 'complete', 'partial', 'failed')),
  started_at TEXT NOT NULL CHECK(length(started_at) = 24
    AND substr(started_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(started_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS NOT NULL
    AND started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  finished_at TEXT CHECK(finished_at IS NULL
    OR (length(finished_at) = 24
      AND substr(finished_at, 1, 4) BETWEEN '2000' AND '2100'
      AND substr(finished_at, 12, 2) BETWEEN '00' AND '23'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', finished_at) IS NOT NULL
      AND finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', finished_at))),
  coverage_expected INTEGER NOT NULL CHECK(coverage_expected BETWEEN 1 AND 32),
  coverage_checked INTEGER NOT NULL CHECK(coverage_checked BETWEEN 0 AND coverage_expected),
  coverage_succeeded INTEGER NOT NULL CHECK(coverage_succeeded BETWEEN 0 AND coverage_checked),
  source_count INTEGER NOT NULL CHECK(source_count = coverage_expected),
  candidate_count INTEGER NOT NULL CHECK(candidate_count BETWEEN 0 AND 500),
  application_count INTEGER NOT NULL CHECK(application_count BETWEEN 0 AND 3),
  CHECK(
    (run_status = 'running' AND finished_at IS NULL)
    OR (run_status != 'running' AND finished_at IS NOT NULL)
  ),
  CHECK(finished_at IS NULL OR finished_at >= started_at),
  CHECK(date(started_at, '+9 hours') IS NOT NULL
    AND date(started_at, '+9 hours') = run_date)
);

CREATE TABLE competition_sources_v2 (
  idempotency_key TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK(kind IN ('listing', 'official', 'search')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 240),
  reference_url TEXT NOT NULL CHECK(reference_url LIKE 'https://%'),
  checked_at TEXT NOT NULL CHECK(length(checked_at) = 24
    AND substr(checked_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(checked_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', checked_at) IS NOT NULL
    AND checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', checked_at)),
  status TEXT NOT NULL CHECK(status IN ('pending', 'ok', 'no_results', 'partial', 'failed')),
  failure_code TEXT NOT NULL CHECK(failure_code IN (
    'none', 'timeout', 'http_403', 'http_404', 'rate_limited', 'network',
    'invalid_response', 'parse_error', 'unknown'
  )),
  manual_check INTEGER NOT NULL CHECK(manual_check IN (0, 1)),
  candidate_count INTEGER NOT NULL CHECK(candidate_count BETWEEN 0 AND 500),
  PRIMARY KEY(idempotency_key, source_id),
  FOREIGN KEY(idempotency_key) REFERENCES competition_reports_v2(idempotency_key) ON DELETE RESTRICT,
  CHECK((status IN ('failed', 'partial')) = (failure_code != 'none')),
  CHECK(failure_code NOT IN ('timeout', 'http_403') OR manual_check = 1),
  CHECK(status NOT IN ('pending', 'no_results', 'failed') OR candidate_count = 0)
);

CREATE TABLE competition_candidates_v2 (
  idempotency_key TEXT NOT NULL,
  contest_id TEXT NOT NULL CHECK(length(contest_id) BETWEEN 1 AND 160),
  category TEXT NOT NULL CHECK(length(category) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
  organizer TEXT NOT NULL CHECK(length(organizer) BETWEEN 1 AND 160),
  source_id TEXT NOT NULL,
  discovery_url TEXT NOT NULL CHECK(discovery_url LIKE 'https://%'),
  discovered_at TEXT NOT NULL CHECK(length(discovered_at) = 24
    AND substr(discovered_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(discovered_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', discovered_at) IS NOT NULL
    AND discovered_at = strftime('%Y-%m-%dT%H:%M:%fZ', discovered_at)),
  recency TEXT NOT NULL CHECK(recency IN ('new', 'recent', 'stale')),
  official_url TEXT CHECK(official_url IS NULL OR official_url LIKE 'https://%'),
  official_verification TEXT NOT NULL
    CHECK(official_verification IN ('verified', 'unverified', 'not_found', 'failed')),
  official_verified_at TEXT CHECK(official_verified_at IS NULL
    OR (length(official_verified_at) = 24
      AND substr(official_verified_at, 1, 4) BETWEEN '2000' AND '2100'
      AND substr(official_verified_at, 12, 2) BETWEEN '00' AND '23'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', official_verified_at) IS NOT NULL
      AND official_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', official_verified_at))),
  acceptance TEXT NOT NULL CHECK(acceptance IN ('open', 'closed', 'unknown')),
  deadline_at TEXT CHECK(deadline_at IS NULL
    OR (length(deadline_at) = 24
      AND substr(deadline_at, 1, 4) BETWEEN '2000' AND '2100'
      AND substr(deadline_at, 12, 2) BETWEEN '00' AND '23'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', deadline_at) IS NOT NULL
      AND deadline_at = strftime('%Y-%m-%dT%H:%M:%fZ', deadline_at))),
  eligibility TEXT NOT NULL CHECK(eligibility IN ('eligible', 'ineligible', 'unknown')),
  rights_risk TEXT NOT NULL CHECK(rights_risk IN ('unknown', 'low', 'medium', 'high', 'blocked')),
  submission_risk TEXT NOT NULL
    CHECK(submission_risk IN ('unknown', 'low', 'medium', 'high', 'blocked')),
  status TEXT NOT NULL
    CHECK(status IN ('discovered', 'verifying', 'active', 'deferred', 'rejected', 'archived')),
  fit_score INTEGER NOT NULL CHECK(fit_score BETWEEN 0 AND 100),
  effort_score INTEGER NOT NULL CHECK(effort_score BETWEEN 0 AND 100),
  PRIMARY KEY(idempotency_key, contest_id, category),
  FOREIGN KEY(idempotency_key, source_id)
    REFERENCES competition_sources_v2(idempotency_key, source_id) ON DELETE RESTRICT,
  CHECK(
    (official_verification = 'verified'
      AND official_url IS NOT NULL AND official_verified_at IS NOT NULL)
    OR (official_verification != 'verified' AND official_verified_at IS NULL)
  ),
  CHECK(
    status != 'active'
    OR (official_verification = 'verified' AND eligibility = 'eligible'
      AND acceptance = 'open' AND deadline_at IS NOT NULL
      AND rights_risk != 'blocked' AND submission_risk != 'blocked')
  ),
  CHECK(official_verified_at IS NULL OR official_verified_at >= discovered_at)
);

CREATE TABLE competition_applications_v2 (
  idempotency_key TEXT NOT NULL,
  contest_id TEXT NOT NULL,
  category TEXT NOT NULL,
  profile_id TEXT NOT NULL
    CHECK(length(profile_id) = 76
      AND substr(profile_id, 1, 12) = 'hmac-sha256:'
      AND substr(profile_id, 13) NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN (
    'DISCOVERED', 'SOURCE_VERIFIED', 'ELIGIBLE', 'PREPARED', 'VALIDATED',
    'WAITING_DEADLINE_CLARIFICATION', 'WAITING_IDENTITY', 'WAITING_ELIGIBILITY',
    'WAITING_CLARIFICATION', 'WAITING_ARTIFACTS', 'WAITING_LEGAL_CONSENT',
    'WAITING_RIGHTS_APPROVAL', 'WAITING_FEE_APPROVAL', 'WAITING_APPROVAL',
    'AUTHORIZED', 'SUBMITTING', 'SUBMISSION_UNKNOWN'
  )),
  blocker TEXT NOT NULL CHECK(blocker IN (
    'none', 'official_verification', 'eligibility', 'deadline', 'rights', 'submission',
    'artifacts', 'account', 'consent', 'payment', 'user_approval', 'other'
  )),
  next_action TEXT NOT NULL CHECK(next_action IN (
    'none', 'verify_official_source', 'verify_eligibility', 'review_rights',
    'review_submission', 'prepare_artifacts', 'draft_application', 'stage_form',
    'request_approval', 'manual_check', 'hold'
  )),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 24
    AND substr(updated_at, 1, 4) BETWEEN '2000' AND '2100'
    AND substr(updated_at, 12, 2) BETWEEN '00' AND '23'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
    AND updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  PRIMARY KEY(idempotency_key, contest_id, category, profile_id),
  FOREIGN KEY(idempotency_key, contest_id, category)
    REFERENCES competition_candidates_v2(idempotency_key, contest_id, category) ON DELETE RESTRICT
);

INSERT INTO competition_reports_v2(
  idempotency_key, payload_hash, schema_version, received_at, run_id, run_date, run_status,
  started_at, finished_at, coverage_expected, coverage_checked, coverage_succeeded,
  source_count, candidate_count, application_count
)
SELECT
  idempotency_key, payload_hash, schema_version, received_at, run_id, run_date, run_status,
  started_at, finished_at, coverage_expected, coverage_checked, coverage_succeeded,
  source_count, candidate_count, application_count
FROM competition_reports;

INSERT INTO competition_sources_v2(
  idempotency_key, source_id, kind, name, reference_url, checked_at, status,
  failure_code, manual_check, candidate_count
)
SELECT
  idempotency_key, source_id, kind, name, reference_url, checked_at, status,
  failure_code, manual_check, candidate_count
FROM competition_sources;

INSERT INTO competition_candidates_v2(
  idempotency_key, contest_id, category, title, organizer, source_id, discovery_url,
  discovered_at, recency, official_url, official_verification, official_verified_at,
  acceptance, deadline_at, eligibility, rights_risk, submission_risk, status,
  fit_score, effort_score
)
SELECT
  idempotency_key, contest_id, category, title, organizer, source_id, discovery_url,
  discovered_at, recency, official_url, official_verification, official_verified_at,
  acceptance, deadline_at, eligibility, rights_risk, submission_risk, status,
  fit_score, effort_score
FROM competition_candidates;

INSERT INTO competition_applications_v2(
  idempotency_key, contest_id, category, profile_id, state, blocker, next_action, updated_at
)
SELECT
  idempotency_key, contest_id, category, profile_id, state, blocker, next_action, updated_at
FROM competition_applications;

DROP TABLE competition_applications;
DROP TABLE competition_candidates;
DROP TABLE competition_sources;
DROP TABLE competition_reports;

ALTER TABLE competition_reports_v2 RENAME TO competition_reports;
ALTER TABLE competition_sources_v2 RENAME TO competition_sources;
ALTER TABLE competition_candidates_v2 RENAME TO competition_candidates;
ALTER TABLE competition_applications_v2 RENAME TO competition_applications;

-- The active queue can contain only candidates whose official source, acceptance and eligibility
-- were all positively verified. Unknown is never promoted to an active application.
CREATE TRIGGER competition_applications_require_verified_candidate
BEFORE INSERT ON competition_applications
WHEN NOT EXISTS (
  SELECT 1
  FROM competition_candidates
  WHERE idempotency_key = NEW.idempotency_key
    AND contest_id = NEW.contest_id
    AND category = NEW.category
    AND official_verification = 'verified'
    AND eligibility = 'eligible'
    AND acceptance = 'open'
    AND deadline_at IS NOT NULL
    AND rights_risk != 'blocked'
    AND submission_risk != 'blocked'
    AND status = 'active'
    AND NEW.updated_at >= discovered_at
)
BEGIN
  SELECT RAISE(ABORT, 'competition application requires a verified eligible open candidate');
END;

CREATE TRIGGER competition_candidates_require_future_active_deadline
BEFORE INSERT ON competition_candidates
WHEN NEW.status = 'active' AND NEW.deadline_at <= (
  SELECT COALESCE(finished_at, started_at)
  FROM competition_reports
  WHERE idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'active competition deadline must follow scan observation');
END;

CREATE TRIGGER competition_candidates_forbid_unverified_closure
BEFORE INSERT ON competition_candidates
WHEN NEW.acceptance = 'closed' AND EXISTS (
  SELECT 1
  FROM competition_sources
  WHERE idempotency_key = NEW.idempotency_key
    AND source_id = NEW.source_id
    AND failure_code IN ('timeout', 'http_403')
)
BEGIN
  SELECT RAISE(ABORT, 'timeout or 403 cannot prove competition closure');
END;

CREATE TRIGGER competition_candidates_require_candidate_bearing_source
BEFORE INSERT ON competition_candidates
WHEN EXISTS (
  SELECT 1
  FROM competition_sources
  WHERE idempotency_key = NEW.idempotency_key
    AND source_id = NEW.source_id
    AND status IN ('pending', 'no_results', 'failed')
)
BEGIN
  SELECT RAISE(ABORT, 'source status cannot produce competition candidates');
END;

CREATE TRIGGER competition_sources_evidence_ceiling
BEFORE INSERT ON competition_sources
WHEN NEW.checked_at > (
  SELECT COALESCE(finished_at, started_at)
  FROM competition_reports
  WHERE idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'source evidence cannot follow report observation');
END;

CREATE TRIGGER competition_candidates_evidence_ceiling
BEFORE INSERT ON competition_candidates
WHEN NEW.discovered_at > (
  SELECT COALESCE(finished_at, started_at)
  FROM competition_reports
  WHERE idempotency_key = NEW.idempotency_key
) OR (
  NEW.official_verified_at IS NOT NULL
  AND NEW.official_verified_at > (
    SELECT COALESCE(finished_at, started_at)
    FROM competition_reports
    WHERE idempotency_key = NEW.idempotency_key
  )
)
BEGIN
  SELECT RAISE(ABORT, 'candidate evidence cannot follow report observation');
END;

CREATE TRIGGER competition_applications_evidence_ceiling
BEFORE INSERT ON competition_applications
WHEN NEW.updated_at > (
  SELECT COALESCE(finished_at, started_at)
  FROM competition_reports
  WHERE idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'application evidence cannot follow report observation');
END;

CREATE TRIGGER competition_applications_limit_three
BEFORE INSERT ON competition_applications
WHEN (
  SELECT COUNT(*) FROM competition_applications
  WHERE idempotency_key = NEW.idempotency_key
) >= 3
BEGIN
  SELECT RAISE(ABORT, 'competition application limit exceeded');
END;

-- Reports and their normalized children are append-only evidence. Corrections use a new report and
-- idempotency key instead of rewriting history.
CREATE TRIGGER competition_reports_no_update
BEFORE UPDATE ON competition_reports BEGIN SELECT RAISE(ABORT, 'competition reports are immutable'); END;
CREATE TRIGGER competition_sources_no_update
BEFORE UPDATE ON competition_sources BEGIN SELECT RAISE(ABORT, 'competition sources are immutable'); END;
CREATE TRIGGER competition_candidates_no_update
BEFORE UPDATE ON competition_candidates BEGIN SELECT RAISE(ABORT, 'competition candidates are immutable'); END;
CREATE TRIGGER competition_applications_no_update
BEFORE UPDATE ON competition_applications BEGIN SELECT RAISE(ABORT, 'competition applications are immutable'); END;
CREATE TRIGGER competition_reports_no_delete
BEFORE DELETE ON competition_reports BEGIN SELECT RAISE(ABORT, 'competition reports are immutable'); END;
CREATE TRIGGER competition_sources_no_delete
BEFORE DELETE ON competition_sources BEGIN SELECT RAISE(ABORT, 'competition sources are immutable'); END;
CREATE TRIGGER competition_candidates_no_delete
BEFORE DELETE ON competition_candidates BEGIN SELECT RAISE(ABORT, 'competition candidates are immutable'); END;
CREATE TRIGGER competition_applications_no_delete
BEFORE DELETE ON competition_applications BEGIN SELECT RAISE(ABORT, 'competition applications are immutable'); END;

CREATE INDEX idx_competition_reports_date_received
ON competition_reports(run_date DESC, received_at DESC, idempotency_key DESC);

CREATE INDEX idx_competition_reports_observation_received
ON competition_reports(COALESCE(finished_at, started_at) DESC, received_at DESC, idempotency_key DESC);

CREATE INDEX idx_competition_sources_report_status
ON competition_sources(idempotency_key, status, source_id);

CREATE INDEX idx_competition_candidates_status_deadline
ON competition_candidates(idempotency_key, status, deadline_at, contest_id, category);

CREATE INDEX idx_competition_candidates_verification
ON competition_candidates(official_verification, eligibility, acceptance, deadline_at);

CREATE INDEX idx_competition_applications_state
ON competition_applications(idempotency_key, state, updated_at, contest_id, category);

-- The UI join key is contest + category, so one daily snapshot cannot expose two ambiguous active
-- rows for different redacted profiles.
CREATE UNIQUE INDEX idx_competition_applications_candidate
ON competition_applications(idempotency_key, contest_id, category);

