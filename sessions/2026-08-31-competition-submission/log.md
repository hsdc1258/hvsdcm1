# Competition submission pipeline session

- Confirmed checkout `C:\Users\won\Desktop\Codex\.worktrees\20260831-competition-release`, branch `codex/competition-release`, clean base `c2121c07888861a5a30ee727ebf0e3250daad16d`, and product gate `npm test`.
- Defined the minimum proof as one latest unexpired `final_submission` approval atomically queueing one job, one lease-bound claim/state lifecycle, and safe owner serialization/UI rendering.
- Added migration/API/client/secret/fast-lane/UI vertical artifacts. The combined focused script gate passes 40/40 and the Worker competition/submission gate passes 29/29.
- Applied migrations 0001 through 0017 with Wrangler against an isolated local D1 state; all 17 passed. `node scripts/validate.mjs` passed 13,857 checks and the final `npm test` passed 418/418 Node tests plus all four E2E gates.
- Independent-review repair bound rules and submission URLs separately, added the canonical redacted action manifest and immutable approval expiry, enforced expiry before claim/running/adapter, and made claimed/running lease expiry directly regression-tested. Focused scripts pass 61/61, focused Worker competition/submission tests pass 32/32, a fresh isolated Wrangler D1 applied 0001-0017, validation passes 13,860 checks, and `npm test` passes 427/427 Node tests plus all four E2E gates.
