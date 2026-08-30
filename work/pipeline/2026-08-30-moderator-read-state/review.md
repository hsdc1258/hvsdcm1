# Independent review: moderator read state

## Reviewed candidate and evidence

- Active gate: `moderator-read-state implementation`.
- Base: `2fcf9f643f9b592d8802bff9143c2af3ca33c603` (`HEAD` and `origin/main` at review time).
- Candidate: current working-tree contents of only:
  - `worker/migrations/0012_moderator_read_state.sql`
  - `worker/src/router.js`
  - `worker/test.mjs`
- Candidate fingerprint: `sha256:77518eb6f88036f5d513787d568de8cf454effff0177857ce11e5fefb9a7bba8`, independently reproduced from the ordered `path=sha256` records below:
  - `worker/migrations/0012_moderator_read_state.sql=431098f82442218c1a616e7adec1a10a8108b5ab5499880e28e6703a52dd98ea`
  - `worker/src/router.js=afd565b3724f3ac8ba7ca2e54f8c6f20d143b4e3b33521a8587389208c2728e5`
  - `worker/test.mjs=819309aec69dd4d3f7d143fc7c146abedb44e9a2da3393b83e38107a3038d567`
- Contract evidence inspected: repository `AGENTS.md`, `README.md`, `docs/ARCHITECTURE.md`, `plan.md`, `route.json`, the producer brief `j1-worker.md`, and the pipeline independent-review rubric.
- Deterministic evidence supplied by the orchestrator: `npm test` passed with 13,690 validation checks, three E2Es passing, and 207/207 Node tests passing; `git diff --check` was clean.
- Independent checks in this reviewer context:
  - The four directly relevant SQLite tests passed: migration, read markers/action reactivation, SQL unread pagination/global counts, and read endpoint validation.
  - `node --check worker/src/router.js` and `node --check worker/test.mjs` passed.
  - Candidate-only diff checking was clean.
  - An adversarial Node plus SQLite probe showed that the endpoint's timestamp normalization stores `2026-08-30T03:00:00.000Z` for a client-observed `2026-08-30T03:00:00Z`, and `2026-08-30T00:00:00.000Z` for `2026-08-30T09:00:00+09:00`; both the serializer expression and SQLite `seen_at < updated_at` then evaluate those just-marked rows as unread.
  - Cloudflare's current D1 binding documentation confirms that `batch()` is transactional and returns one `D1Result` per statement in input order, supporting the implementation's result slicing and `meta.changes` aggregation: [D1 `batch()` documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
- The concurrent `usage/` changes and `docs/_snapshots/usage.html` were explicitly excluded from candidate inspection and were not modified.

## Verdict

`repair`

The item/read-count/filter/auth/atomic-write design is otherwise coherent, but command read markers do not preserve the exact timestamp representation the client saw, so valid ISO timestamp forms can remain unread immediately after a successful mark and the tests do not catch it.

## Findings

### MRR-001

- `id`: `MRR-001`
- `severity`: `major`
- `gate`: `moderator-read-state implementation`
- `scope`: `current`
- `artifact_ref`: `worker/src/router.js:1611` and `worker/test.mjs:3215`
- `impact`: `moderatorReadTimestamp()` validates by converting every accepted value through `Date.parse()` and `toISOString()`, then stores the converted string. The unread contract is intentionally a string comparison in both SQL (`seen_at < updated_at`) and `serializeModeratorCommand`. Therefore an otherwise valid exact client echo such as `2026-08-30T03:00:00Z` or `2026-08-30T09:00:00+09:00` is changed before storage and compares as older than the row's unchanged `updated_at`; the response can report one command marked while subsequent list/count/filter responses still report it unread. All command fixtures use canonical millisecond `Z` timestamps, so the tests would remain green with this wrong behavior. They also do not send an older command marker after a newer one, so removing the command monotonic predicate would not currently make the suite fail.
- `correction`: Validate parseability without replacing the submitted string, and bind the exact `entry.updated_at` representation that the client received. If duplicate command IDs remain accepted, choose or reject duplicates without silently changing the winning representation. Add regressions using actual row `updated_at` values with omitted fractional seconds and with an offset; echo each exact value through `POST /api/moderator/read`, then assert exact `seen_at`, `unread: false`, a zero record unread count, and exclusion from `unread=1`. Also send an older command marker after a newer marker and assert `marked.commands === 0` and that `seen_at` does not decrease.

## Completion-criteria coverage

| Criterion | Evidence and test sensitivity | Result |
| --- | --- | --- |
| Append-only migration and legacy defaults | Migration `0012` only adds `seen_version DEFAULT 0` and nullable `seen_at`; the pre-migration fixture proves legacy rows receive those values and serialize unread. The test would fail if either column/default were missing. | Pass |
| Item and command serialization | Both new fields and unread booleans are serialized. Item behavior is directly exercised. Command behavior is correct only for canonical millisecond-`Z` strings; alternate valid exact representations fail as described in MRR-001. | Repair |
| Action-required semantics | Open important and pending proposal rows remain unread after their markers reach the current version; queued review becomes read. The unread-only response asserts exactly the two action-required rows, so removing either action-required branch would fail the test. | Pass |
| Closed-item/command reactivation | A resolved item and succeeded command become read, then a later version/timestamp makes each unread again. Those assertions would fail if reactivation were absent. | Pass |
| `unread` query validation | Invalid and duplicate values return `invalid_pagination`; `0` preserves the all-items behavior. | Pass |
| SQL filtering before limit and cursor ordering | A read newest item is excluded before `LIMIT 1`, the first unread item is `resolved-050`, and the cursor continues to `resolved-049` under `updated_at DESC, item_id DESC`. Command filtering leaves 50 rather than 49 rows, proving it also occurs before its limit. | Pass |
| Database-wide unread counts | Fifty-two rows with a one-row page produce counts of 51 for items and commands; counts remain unchanged on the next cursor page. Computing from returned arrays would fail. | Pass |
| Owner authorization | The new route reuses `moderatorOwner`; anonymous and non-owner requests assert 401 and hidden 404 respectively. | Pass |
| Whole-body validation, 200-entry cap, and atomic writes | Entry shape validation completes before statement creation/execution; 201 entries return 413, and a valid item followed by an invalid command leaves both markers unchanged. D1 `batch()` provides the required transaction boundary. | Pass |
| D1 batch changed-row counts | The happy path batches four item and one command update and asserts `{items: 4, commands: 1}`; stale item marking asserts zero. Result ordering and per-statement result objects match D1's documented contract. Command stale-marker sensitivity is missing and is included in MRR-001. | Repair |
| Monotonic markers | Item monotonicity is directly tested and implemented. The command predicate is present, but its string domain is broken by normalization and stale-command regression coverage is absent. | Repair |
| No item event/version side effects | The read route updates only marker columns; the test asserts unchanged item version and unchanged event count. | Pass |
| Existing boundaries | No dependencies, deployment, push, migration rewrite, or product writes outside the three owned paths were part of this candidate. Existing `counts` and list fields remain present. | Pass |

## Residual risk and checks not completed

- The SQLite adapter exercises transaction behavior and result counts but is not a `wrangler dev --local` D1 execution. The architecture guide recommends that additional smoke test for real D1 migration/query changes; deployment was explicitly outside this gate.
- No production migration, deployment, authenticated live request, staging, commit, or push was performed.
- The orchestrator-issued external reviewer receipt was not supplied as an inspectable artifact in this reviewer task. The orchestrator must still bind this review to its trusted receipt and the exact candidate fingerprint before final acceptance.
- Front-end consumption is owned by the concurrent `usage/` task and was intentionally not reviewed here.
