# WP1 Worker harness API extension

- Requested outcome: extend the v1 Worker harness contract so the deployed usage UI receives stable actor phase, timing, quota-snapshot, and task completion metadata.
- Smallest E2E proof: two authenticated harness reports for one real-payload-derived actor survive `POST /api/harness/report` and the stored payload shows a stable phase, start/end stamps, quota snapshots, completion time, and 100% completion progress; an owner `GET /api/usage?completed_limit=2` returns every active task plus only the two newest completed tasks.
- Deadline for this run: 2026-08-28 17:00 KST.

## Contract

- Accept optional `actors[].phase` from the canonical eight-phase allowlist; reports without it remain valid.
- On first actor merge, stamp `started_at`, default a missing actor phase to the report task phase, and capture the report's remaining Codex/Claude quota snapshot when available.
- On an actor transition to `done` or `blocked`, stamp `finished_at` and the ending quota snapshot.
- On task completion, stamp `completed_at`, finalize non-unavailable actors, and set their progress to 100 even when progress was previously absent.
- Accept `GET /api/usage?completed_limit=N`; keep all active tasks and return at most N completed tasks ordered by `completed_at`, falling back to `updated_at`. With no parameter, preserve the full legacy response.
- Do not alter migrations 0006/0007 or add DDL: all new state belongs in the existing JSON payload.

## Boundaries

- Preserve the static Pages plus Wrangler ES-module deployment model.
- Preserve ingest-token authentication and owner-only usage lookup.
- Do not expose session IP or user-agent data.
- Do not change the reporting clients, front-end layout, production D1, secrets, deployment workflow, or unrelated user-owned `work/real-harness-task-sample.json`.

## Completion evidence

1. Focused Worker proof: `node --test worker/test.mjs`.
2. Repository regression gate: `npm test`.
3. Patch hygiene: `git diff --check`.
4. Independent review: blocker 0 and major 0 against this contract.

## Execution ownership

- Main Codex: contract, implementation, integration, fixes, and final verdict.
- Fresh reviewer context: independent blocker/major/nit review after deterministic gates.
- Approval-only actions: none anticipated; production deployment or credential changes are out of scope.
