# WP1 final independent review

## Reviewed range and evidence

- Contract baseline: `114ee1a5c13a9a2e2bd8321d630a46f9e7ca368e`; current checkout `HEAD`: `a3be0f333b039172eb89728a29ccb32460bdc853`. The intervening commit is unrelated gichul WP2 work.
- Reviewed artifact: exactly `git diff -- worker/src/router.js worker/test.mjs docs/ARCHITECTURE.md` against current `HEAD`. The final uncommitted WP1 product patch is 130 additions/33 deletions in `worker/src/router.js` and 292 additions/1 deletion in `worker/test.mjs`; `docs/ARCHITECTURE.md` has no working-tree delta because its contract text is already present in `a3be0f3`.
- Review inputs: repository `AGENTS.md`, `README.md`, current `docs/ARCHITECTURE.md`, run `plan.md`, and the pipeline independent-review rubric.
- Independently rerun on final inputs: `node --test worker/test.mjs` -> 46/46 pass; `git diff --check -- worker/src/router.js worker/test.mjs docs/ARCHITECTURE.md` -> pass.
- Final integration gate on the current final inputs: an explicit npm CLI run of `npm test` passed in full, including Validation 13,591, Node tests 121/121, SESSION STATE + PORTFOLIO ORG E2E PASS, and FULL PIPELINE ORG E2E PASS.
- Final read-only counterexample recheck: an actor that finished at 10:00 with quota unavailable, followed by task completion at 12:00 with Codex remaining 50, retained only its original `finished_at`; no later `usage_at_end` was attached.

## Verdict

`accept` - blocker 0, major 0, nit 0.

Every WP1 contract branch has implementation evidence, the two adversarial lifecycle defects are repaired with mutation-sensitive regressions, and authentication, owner privacy, schema, and legacy-response boundaries remain intact.

## Repair verification

- Late/unresumed reporting: `worker/src/router.js:443-450` now finalizes a straggler forced to `done` with a same-report finish/quota observation, while task `completed_at` remains stable. `worker/test.mjs:1526-1533` asserts this state.
- Explicit resume: `worker/src/router.js:411-418` starts a new lifecycle for a terminal actor moving to nonterminal, resets start quota, and removes old end metadata; task completion is also cleared. `worker/test.mjs:1536-1548` asserts all affected fields.
- No quota backfill: `worker/src/router.js:443-450` computes `finishesNow` and creates `usage_at_end` only when that report also creates `finished_at`. The regression at `worker/test.mjs:1842` exercises blocked-without-quota followed by completion-with-quota; the old implementation fails its final absent-usage assertion.
- Stable terminal observations: actors already carrying terminal metadata are finalized to task `done`/100 without changing their prior finish time or attaching a later quota sample.

## Findings

### Blocker

None.

### Major

None.

### Nit

None.

## Completion-criteria coverage

| Criterion | Direct evidence | Result |
| --- | --- | --- |
| Optional `actors[].phase` from canonical eight-phase allowlist; omission remains valid | Actor normalization uses `VALID_HARNESS_PHASES`; focused tests cover explicit valid phase, defaulting, preservation on omission, and pre-DB rejection of `ship` | Pass |
| New actor gets server-owned start, default phase, and available model-aware quota snapshot | Merge stamps normalized `occurred_at`; real-derived multi-model fixture distinguishes task-phase default, explicit actor phase, exact Claude model, and Codex actor behavior | Pass |
| `done`/`blocked` gets a coherent end time/quota observation | Direct blocked, task completion, terminal hold, prior-terminal stability, unavailable quota, and resumed lifecycle paths are all exercised | Pass |
| Task completion stamps stable `completed_at` and sets absent actor progress to 100 | Real-derived actors omit progress and finish at 100; late report preserves completion and explicit resume clears it | Pass |
| `completed_limit=0..1000` keeps every active and newest N completed by `completed_at`, then `updated_at` | N=0/N=2, precedence/fallback ordering, invalid negative/fraction/1001, and full active retention are route-tested | Pass |
| No-parameter usage response preserves legacy behavior | Null-limit branch returns every parsed task in prior DB order with events; existing full-response assertion passes | Pass |
| No migrations or DDL; D1/Wrangler ES-module model preserved | State is stored only inside existing payload JSON; no migration delta; route uses existing tables/columns and supported JS | Pass by inspection and route tests |
| Harness ingest authentication and owner-only usage access remain intact | Token check precedes body/DB processing; authentication and fail-closed owner 404 precede parameter parsing and protected queries | Pass |
| Session IP/user-agent remain admin-only | Reviewed routes neither select nor expose these fields | Pass |

## Residual risks and checks not completed

- No fresh reviewer-run `wrangler dev --local` D1 session was performed. Schema and SQL are unchanged, and fake-D1 route behavior plus supplied E2Es cover the affected API paths.
- `completed_limit` caps response tasks only after all task rows and retained events are loaded, so D1 work still grows with task retention. This is a future scalability consideration, not a current response-contract defect.
- Limit tests do not explicitly assert accepted 1000 or rejected empty/duplicate parameters; the parser enforces those cases directly, leaving low residual risk.
- A corrupt truthy legacy `payload.completed_at` sorts at epoch rather than falling back to `row.updated_at`. Worker-generated completion values are normalized ISO timestamps, so normal API-written state is unaffected.
