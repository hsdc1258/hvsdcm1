# Moderator server read-state report

## Outcome

Implemented the server-owned moderator read state in the three assigned product paths. D1 now stores item version markers and command timestamp markers; owner list responses expose marker fields, unread booleans, SQL-filtered unread pages, and database-wide unread counts; an owner-only read route applies fully validated monotonic marker updates without changing moderator state or events.

No deployment or push was performed. The concurrently owned `usage/` implementation and snapshot files were not edited by this worker.

## Product changes

- `worker/migrations/0012_moderator_read_state.sql`
  - Adds `moderator_items.seen_version INTEGER NOT NULL DEFAULT 0`.
  - Adds nullable `moderator_commands.seen_at`.
  - Documents why item versions and command timestamps are different read keys.
- `worker/src/router.js`
  - Adds identical item action-required/unread predicates to serialization and SQL.
  - Adds `seen_version`, `seen_at`, and `unread` without removing existing fields.
  - Accepts only absent, `0`, or `1` for the single `unread` query value.
  - Filters unread items and commands in SQL before limits and preserves item cursor ordering.
  - Counts unread item kinds and records over the whole database.
  - Adds owner-only `POST /api/moderator/read`, with a 200-entry cap, full pre-validation, monotonic D1 batch updates, and actual changed-row counts.
  - Preserves the exact parseable command timestamp string returned to the client. Conflicting duplicate timestamp representations for one command ID fail before writes.
- `worker/test.mjs`
  - Applies migration `0012` in the SQLite harness and proves defaults for pre-existing rows.
  - Covers action-required items, closed/read/reactivated items and commands, exact ISO representations, stale marker rejection, SQL-before-limit filtering, cursor continuation, database-wide counts, owner boundaries, size limits, whole-body validation, and no version/event side effects.

## Review and repair

Round one found one current-gate major: timestamp normalization changed exact `updated_at` representations and could leave a just-marked command unread. The producer repaired it by validating without normalizing, rejecting ambiguous duplicate values, and adding omitted-fraction, offset, and stale-command regressions.

Round two independently accepted candidate `sha256:6c83025c221fc53cd10090f2c51b4dfc2e8059e54c4a76b1cb0f4c231ae1d6f1` with blocker 0 and current-gate major 0. Both external reviewer receipts were validated against the exact candidate fingerprints from an orchestrator-controlled temporary root outside the repository.

## Verification

- Focused moderator SQLite tests after repair: 5/5 passed.
- Entire Worker suite: 75/75 passed.
- `node --check worker/src/router.js`: passed.
- `node --check worker/test.mjs`: passed.
- `git diff --check`: passed.
- Pipeline execution metrics schema validation: passed.
- Earlier full candidate before the timestamp-only repair: `npm test` passed with 13,690 validation checks, three E2Es, and 207/207 Node tests.
- Current repository-wide `npm test`: blocked before Node tests by two cache-buster checks in concurrently committed `usage/index.html`. The committed HTML uses `20260830-unread-v1`, while `scripts/validate.mjs` still requires `20260830-moder4-v1`. This is finding OOS-001, gate `concurrent usage frontend cache-buster validation`, scope `out-of-scope`; the assigned worker must not edit either frontend integration path.

## Data and release boundaries

- Existing rows backfill automatically to unread through the migration defaults; no destructive backfill is needed.
- Migration `0012` must be applied before deploying Worker code that selects the new columns.
- No production D1 mutation, Wrangler deployment, Pages deployment, dependency change, push, or secret access occurred.
- A real `wrangler dev --local` D1 smoke test remains a release-level residual check; deployment was explicitly excluded from this task.

## Git state

- Base when the accepted candidate was reviewed: `979556bf2f511bbdd652fb7be36417c850d832b3`.
- Product commit: `efc176b` (`feat(moderator): persist server read state`).
- Intended stage set: only `worker/migrations/0012_moderator_read_state.sql`, `worker/src/router.js`, and `worker/test.mjs`.
- Final branch state: `main` is ahead of `origin/main` by three commits, including two pre-existing concurrent frontend commits and this product commit. Nothing was pushed.
