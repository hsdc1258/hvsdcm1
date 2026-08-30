# Moderator read-state contract

## Outcome

Make D1 the source of truth for moderator read state. Owner list responses expose read metadata and database-wide unread counts, `unread=1` filters before pagination, and an owner-only read endpoint marks only the exact item versions or command timestamps the browser actually saw.

## Non-goals and ownership

- Do not edit `usage/` or `scripts/usage.test.mjs`.
- Do not deploy, push, add dependencies, or change existing moderator state transitions.
- Product writes are limited to `worker/migrations/0012_moderator_read_state.sql`, `worker/src/router.js`, and `worker/test.mjs`.
- Preserve the pre-existing untracked `.wrangler/` directory.

## Contracts and boundaries

- Append migration `0012`; never alter migration `0011`.
- `moderator_items` uses monotonic `version`/`seen_version`; commands use `updated_at`/`seen_at` because commands have no version.
- Action-required important/proposal items remain unread until their state changes.
- Filtering and unread counts execute in SQL so page size cannot hide unread data.
- `POST /api/moderator/read` uses owner authentication, validates the whole body before writes, caps entries at 200, updates markers monotonically, and creates no item events or version increments.
- Existing response fields, counts, routes, localStorage keys, and deployment model remain unchanged.

## Completion evidence

1. SQLite migration tests prove defaults, existing-row unread behavior, action-required behavior, closed-item reactivation, command behavior, SQL filtering with cursor pagination, database-wide counts, monotonic updates, no state event/version side effects, authorization, size limits, and all-or-nothing validation.
2. `npm test` passes from the repository root.
3. `git diff --check` passes.
4. Final diff contains no writes outside the three owned product paths; only those paths are staged and committed.
5. Detailed results are recorded in `work/pipeline/2026-08-30-moderator-read-state/report.md` without deploying or pushing.

## Assignment and deadline

- Producer: routed `gpt-5.6-sol`, xhigh, standard mode.
- Reviewer: fresh routed `gpt-5.6-sol`, xhigh, standard mode after deterministic gates.
- Orchestrator/final verdict: root Codex context.
- Run deadline: 2026-08-30 15:59 KST.

No additional approval is required. Production mutation, deployment, push, secrets, privilege expansion, and destructive history changes are outside the authorized scope.
