-- A report cannot keep an application once its officially reverified candidate has closed or
-- expired. Permit that one terminal transition while preserving every open application and all
-- approval continuity checks from migration 0017.
DROP TRIGGER competition_report_guards_preserve_latest_state;

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
      AND NOT EXISTS (
        SELECT 1
        FROM competition_candidates AS old_candidate
        JOIN competition_candidates AS fresh_candidate
          ON fresh_candidate.idempotency_key = NEW.idempotency_key
         AND fresh_candidate.contest_id = old_candidate.contest_id
         AND fresh_candidate.category = old_candidate.category
        JOIN competition_reports AS fresh_report
          ON fresh_report.idempotency_key = NEW.idempotency_key
        WHERE old_candidate.idempotency_key = NEW.prior_idempotency_key
          AND old_candidate.contest_id = old.contest_id
          AND old_candidate.category = old.category
          AND old_candidate.official_verification = 'verified'
          AND fresh_candidate.official_verification = 'verified'
          AND fresh_candidate.official_verified_at > old_candidate.official_verified_at
          AND fresh_candidate.status = 'rejected'
          AND (
            fresh_candidate.acceptance = 'closed'
            OR (
              fresh_candidate.deadline_at IS NOT NULL
              AND fresh_candidate.deadline_at <= fresh_report.finished_at
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
          SELECT 1
          FROM competition_report_approval_requests AS fresh
          WHERE fresh.idempotency_key = NEW.idempotency_key
            AND fresh.contest_id = old.contest_id
            AND fresh.category = old.category
        )
        OR EXISTS (
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
        OR EXISTS (
          -- A newer official closure makes the old action impossible. Keep the immutable request
          -- and any decision in their origin rows, but do not force an obsolete link into the
          -- latest snapshot after its application has been terminally removed.
          SELECT 1
          FROM competition_candidates AS old_candidate
          JOIN competition_candidates AS fresh_candidate
            ON fresh_candidate.idempotency_key = NEW.idempotency_key
           AND fresh_candidate.contest_id = old_candidate.contest_id
           AND fresh_candidate.category = old_candidate.category
          JOIN competition_reports AS fresh_report
            ON fresh_report.idempotency_key = NEW.idempotency_key
          WHERE old_candidate.idempotency_key = NEW.prior_idempotency_key
            AND old_candidate.contest_id = old.contest_id
            AND old_candidate.category = old.category
            AND old_candidate.official_verification = 'verified'
            AND fresh_candidate.official_verification = 'verified'
            AND fresh_candidate.official_verified_at > old_candidate.official_verified_at
            AND fresh_candidate.status = 'rejected'
            AND (
              fresh_candidate.acceptance = 'closed'
              OR (
                fresh_candidate.deadline_at IS NOT NULL
                AND fresh_candidate.deadline_at <= fresh_report.finished_at
              )
            )
        )
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'competition report state regression');
END;
