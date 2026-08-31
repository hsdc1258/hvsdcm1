-- Persist the owner's hard contest preferences in the immutable evidence row. Existing snapshots
-- remain readable but fail closed as unknown until a later official verification refreshes them.
ALTER TABLE competition_candidates ADD COLUMN fee_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK(fee_status IN ('free', 'paid', 'unknown'));
ALTER TABLE competition_candidates ADD COLUMN participation_mode TEXT NOT NULL DEFAULT 'unknown'
  CHECK(participation_mode IN ('none', 'online_only', 'offline_required', 'unknown'));

-- Keep the legacy <=3 columns readable for old Workers while the new Worker dual-writes the
-- actual portfolio size here. Existing rows fall back to their legacy counts.
ALTER TABLE competition_reports ADD COLUMN application_count_v2 INTEGER
  CHECK(application_count_v2 BETWEEN 0 AND 10);
ALTER TABLE competition_report_guards ADD COLUMN approval_count_v2 INTEGER
  CHECK(approval_count_v2 BETWEEN 0 AND 10);

CREATE TRIGGER competition_candidates_require_preference_match
BEFORE INSERT ON competition_candidates
WHEN NEW.status = 'active' AND (
  NEW.fee_status != 'free'
  OR NEW.participation_mode NOT IN ('none', 'online_only')
)
BEGIN
  SELECT RAISE(ABORT, 'active competition requires free remote-compatible participation');
END;

DROP TRIGGER competition_applications_require_verified_candidate;
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
    AND fee_status = 'free'
    AND participation_mode IN ('none', 'online_only')
    AND rights_risk != 'blocked'
    AND submission_risk != 'blocked'
    AND status = 'active'
    AND NEW.updated_at >= discovered_at
)
BEGIN
  SELECT RAISE(ABORT, 'competition application requires verified free remote-compatible candidate');
END;

DROP TRIGGER competition_applications_limit_three;
CREATE TRIGGER competition_applications_limit_ten
BEFORE INSERT ON competition_applications
WHEN (
  SELECT COUNT(*) FROM competition_applications
  WHERE idempotency_key = NEW.idempotency_key
) >= 10
BEGIN
  SELECT RAISE(ABORT, 'competition application limit exceeded');
END;

DROP TRIGGER competition_report_guards_require_complete_approvals;
CREATE TRIGGER competition_report_guards_require_complete_approvals
BEFORE INSERT ON competition_report_guards
WHEN (
  SELECT COUNT(*) FROM competition_report_approval_requests
  WHERE idempotency_key = NEW.idempotency_key
) != COALESCE(NEW.approval_count_v2, NEW.approval_count)
BEGIN
  SELECT RAISE(ABORT, 'competition report approval links incomplete');
END;

-- The 0017 continuity trigger predates the preference columns. Preserve its full comparison and add
-- a focused same-evidence-time guard so fee or participation facts cannot be rewritten silently.
CREATE TRIGGER competition_report_guards_preserve_preference_state
BEFORE INSERT ON competition_report_guards
WHEN NEW.enforce_continuity = 1 AND NEW.prior_idempotency_key IS NOT NULL AND EXISTS (
  SELECT 1
  FROM competition_candidates AS old
  JOIN competition_candidates AS fresh
    ON fresh.idempotency_key = NEW.idempotency_key
   AND fresh.contest_id = old.contest_id
   AND fresh.category = old.category
  WHERE old.idempotency_key = NEW.prior_idempotency_key
    AND old.official_verification = 'verified'
    AND fresh.official_verification = 'verified'
    AND fresh.official_verified_at = old.official_verified_at
    AND (
      fresh.fee_status IS NOT old.fee_status
      OR fresh.participation_mode IS NOT old.participation_mode
    )
)
BEGIN
  SELECT RAISE(ABORT, 'competition report preference state regression');
END;
