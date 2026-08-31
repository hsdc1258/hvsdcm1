# Behavior Lab readability redesign

- Started: 2026-08-31 19:28 KST
- Writer: Codex `/root`
- Route: substantial-implementation / one fresh Codex verifier
- Deadline: 2026-08-31 21:00 KST
- Scope: frontend presentation and UI tests only
- Invariants: owner-only, public-data-only, paper-only, active six-arm runtime, in-place refresh, no live stop action
- Baseline SHA: `6215084027a5086f6f11c7f07922347f15b9e23d`
- Remote baseline SHA: `6215084027a5086f6f11c7f07922347f15b9e23d`
- Status: implementation and deterministic gates complete; independent review accepted; release pending
- Source correction: the supplied YouTube URL was accidental and is excluded. Toss official guidance and the Brunch UX-law article remain the design inputs.
- Baseline: focused Behavior Lab UI E2E passed; desktop and mobile screenshots confirm excessive vertical density and six fully expanded cards.
- Implementation: added scan-first experiment summary, Korean strategy names, ranked list, two-column desktop cards, progressive-disclosure detail/log sections, and compact paper-tab entry without changing API or engine behavior.
- Refresh: card node identity and each native details disclosure state survive the 5-second in-place patch; retained data remains fully opaque on a hanging or failed refresh.
- Responsive artifacts: 1280px, 768px, and 390px screenshots in the pipeline run; no horizontal overflow at any tested width.
- Gate: `npm test` passed with 13,846 validation checks and 399 Node tests; `git diff --check` passed.
- Independent review: ACCEPT; blocker 0, major 0, non-blocking 1. The deferred note is additional leaderboard-entry shape hardening for a malformed trusted API payload, outside the current release gate.
