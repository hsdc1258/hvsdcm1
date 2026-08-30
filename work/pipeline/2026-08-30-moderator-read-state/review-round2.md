# Independent review round 2: moderator read state

## Reviewed candidate and evidence

- Active gate: moderator-read-state implementation.
- Base: 979556bf2f511bbdd652fb7be36417c850d832b3, which was also the current HEAD and merge base during this review.
- Candidate: current working-tree contents of only:
  - worker/migrations/0012_moderator_read_state.sql
  - worker/src/router.js
  - worker/test.mjs
- Candidate fingerprint: sha256:6c83025c221fc53cd10090f2c51b4dfc2e8059e54c4a76b1cb0f4c231ae1d6f1, independently reproduced by hashing the ordered newline-separated path=sha256 records:
  - worker/migrations/0012_moderator_read_state.sql=431098f82442218c1a616e7adec1a10a8108b5ab5499880e28e6703a52dd98ea
  - worker/src/router.js=cdafdc2b89ec7ae0b7ae08a40985b838ec2897f2293921a2ada064caf59c1277
  - worker/test.mjs=0ea8ed08b85216582d71d49619b35739d5b54ced12df8a04233c38dd27c7bf60
- Contract evidence inspected: repository AGENTS.md, README.md, docs/ARCHITECTURE.md, plan.md, route.json, the producer brief j1-worker.md, the round-one review and MRR-001, and the pipeline independent-review rubric.
- Independent checks in this reviewer context:
  - The five focused SQLite tests passed: migration/defaults, item and command read/reactivation, exact command timestamps and monotonicity, SQL unread pagination/global counts, and read-endpoint authorization/validation.
  - node --check worker/src/router.js and node --check worker/test.mjs passed.
  - Candidate-only whitespace checking passed for router.js and test.mjs against the base and independently for the untracked migration.
  - The supplied file hashes and aggregate candidate fingerprint matched current bytes exactly.
  - Source inspection confirms all item and command entries are validated before statements are created or env.DB.batch is called.
- Repository-wide gate evidence supplied by the orchestrator: npm test currently stops on two cache-buster validation failures in concurrently edited usage/index.html after another session advanced HEAD. Those excluded frontend files were not inspected or treated as part of this candidate.

## Verdict

accept

MRR-001 is fully repaired and every original moderator read-state criterion remains covered; the only red repository-wide evidence belongs to a concurrent, explicitly excluded frontend gate.

## Findings

### OOS-001

- id: OOS-001
- severity: major
- gate: concurrent usage frontend cache-buster validation
- scope: out-of-scope
- artifact_ref: orchestrator-supplied npm test result for excluded usage/index.html
- impact: The repository-wide npm test cannot currently finish green because two cache-buster validations fail in a file owned by another concurrent session. This is material to that frontend gate, but the file is outside the exact three-file candidate and the current moderator-focused checks are green, so it does not block the active moderator-read-state gate.
- correction: The owner of the concurrent usage frontend work should reconcile its cache-buster references and rerun the repository-wide gate when that frontend candidate is stable.

There are no blocker or major findings with scope current for the active moderator-read-state gate.

## Completion-criteria coverage

| Criterion | Evidence and test sensitivity | Result |
| --- | --- | --- |
| Append-only migration and legacy defaults | Migration 0012 only adds seen_version with DEFAULT 0 and nullable seen_at, with the required rationale comment. The pre-migration legacy fixtures assert both defaults and that both existing rows serialize unread; omitting either column/default or unread behavior would fail. | Pass |
| Item and command serialization | router.js adds seen_version/unread and seen_at/unread without removing existing fields. Focused list assertions cover values and booleans for read and unread states. | Pass |
| Action-required semantics | The read-marker test marks open important and pending proposal rows at their current versions and still requires unread true, while queued review is false. The unread-only response asserts exactly the two action-required IDs. | Pass |
| Closed-item and command reactivation | A resolved item and succeeded command become read, then later version/updated_at writes make both unread again. The assertions would fail if either reactivation rule were absent. | Pass |
| unread query validation | unread is accepted only as 0 or 1; invalid and duplicate values return invalid_pagination, and unread=0 preserves the all-row behavior. | Pass |
| SQL filtering before limit and cursor ordering | The newest read item is excluded before LIMIT 1, the first page starts at resolved-050, and its cursor continues to resolved-049 using the established updated_at DESC, item_id DESC order. Command filtering leaves 50 unread rows after excluding the newest read command. | Pass |
| Database-wide unread counts | Fifty-two item and command fixtures with a one-item page produce counts of 51 for both categories, and the counts stay constant across the cursor page. Computing from returned arrays would fail these assertions. | Pass |
| Owner-only read route | POST /api/moderator/read is registered beside the existing moderator routes and reuses moderatorOwner. Anonymous and signed-in non-owner requests assert 401 and hidden 404 responses. | Pass |
| Whole-body validation and 200-entry cap | Empty payloads fail, 201 entries return request_too_large with 413, malformed IDs/versions/timestamps and non-array collections fail, and a valid item paired with an invalid command leaves both markers unchanged. | Pass |
| Atomic writes and accurate changed-row counts | All entries are normalized before any statement is created or batched. The happy path asserts four changed items and one changed command, while stale item and command writes each assert zero. Result slicing follows statement order. | Pass |
| Item marker monotonicity | A stale item version returns zero and leaves seen_version at the higher value. The SQL predicate updates only when seen_version is lower. | Pass |
| Exact command timestamp preservation | moderatorReadTimestamp checks parseability but returns the original string. Actual rows using a no-fraction Z form and a +09:00 offset are echoed through the route; tests assert byte-exact seen_at, unread false, zero record count, and exclusion from unread=1. This directly repairs the round-one normalization bug. | Pass |
| Command marker monotonicity | After storing 2026-08-30T03:00:00Z, the test submits 2026-08-30T02:59:59Z and asserts marked.commands is zero and seen_at remains unchanged. Removing the SQL monotonic predicate would fail. | Pass |
| Conflicting duplicate command IDs | Differently represented timestamps for the same command ID return invalid_item. Source inspection shows conflict detection completes before statement construction and batch execution, so item entries in the same request cannot be partially written. | Pass |
| No state-transition side effects | The read route updates only seen_version/seen_at. The test asserts an item's version and existing event count are unchanged after marking. | Pass |
| Existing boundaries | Existing counts and list fields remain present; no dependency, deployment, push, migration rewrite, or candidate product write outside the three owned paths was observed. | Pass |

## Residual risks and checks not completed

- The focused SQLite adapter proves query behavior, transaction-facing result handling, and migration defaults, but this review did not run a wrangler dev --local D1 smoke test. The architecture guide recommends that additional environment-level check for real D1 migration/query changes.
- The repository-wide npm test is not currently green for the separately owned frontend reason recorded as OOS-001. It must be rerun by the orchestrator after the concurrent frontend candidate stabilizes; no frontend file was inspected in this review.
- No production migration, deployment, authenticated live request, staging, commit, push, or dependency change was performed.
- The orchestrator-issued external reviewer receipt was not supplied as an inspectable artifact in this reviewer task. The orchestrator must bind this review to its trusted receipt and the exact candidate fingerprint before final acceptance.
- Frontend consumption remains owned by the concurrent usage task and was intentionally excluded.
