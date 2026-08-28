# Contributing

## Safe change sequence

1. Create a branch from the current default branch.
2. Identify whether the change affects static UI, content data, synchronization, API behavior or D1 schema.
3. Keep content in data files, presentation in CSS, browser behavior in app files and API behavior under `worker/src/`.
4. Run `npm test` and `git diff --check`.
5. Preview the affected page through an HTTP server; do not rely on opening HTML with `file://` because root-relative assets and account redirects differ.
6. Describe behavior changes, migrations and verification results in the pull request.

## Compatibility rules

- Do not change `wordmaster` or `smstudy` API identifiers or their localStorage keys without a forward migration.
- Preserve the load order `account.js` → authenticated content loader → shared study utilities → app controller.
- Escape data inserted through `innerHTML`. Use `textContent` for untrusted single values.
- External links opened in a new tab must use `rel="noopener"`.
- Keep the home login `next` redirect same-origin.
- Return stable JSON error messages from the API. Log internal exception details server-side only.
- Keep session IP and user-agent data behind admin authentication. Never include token hashes in an API response.
- Preserve the 90-day session audit retention: logout expires a token immediately, while admin cleanup removes old rows.

## Content changes

WordMaster and social-studies files under `_learning/` are deliberately data-heavy and must never be moved onto a published path or exposed through `.nojekyll`. Keep stable IDs so existing progress and wrong-answer records remain usable. Any addition or removal must update the invariants in `scripts/validate.mjs`, rebuild the private R2 payloads, and update the UI's expected counts and relevant documentation in the same change.

## Database changes

Add a new monotonically numbered SQL migration under `worker/migrations/`. Applied migrations are immutable. Test migrations locally with Wrangler before deployment and document any backfill or rollback plan in the pull request.

Deploy database migrations before Worker code that reads new columns. Exact IP data cannot be reconstructed from the legacy `ip_hash`; the admin UI must continue to label those older records as fingerprint-only.
