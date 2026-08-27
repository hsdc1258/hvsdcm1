# Repository guide for agents

This repository is a no-build GitHub Pages site plus a Cloudflare Worker API. Preserve that deployment model: browser files must continue to work as static assets, and Worker modules must remain compatible with Wrangler's ES module runtime.

Before changing code, read `README.md` and `docs/ARCHITECTURE.md`. After every material change, run:

```bash
npm test
git diff --check
```

Critical invariants:

- `WordMaster/assets/js/words.js` contains exactly 2,000 entries: 50 DAYs × 40 words.
- `smstudy/assets/js/data.js` contains 4 units, 13 subunits and 78 questions: 6 per subunit.
- Do not rename the localStorage keys or the API app names without a migration.
- Keep content data separate from UI logic. Do not move CSS or executable JavaScript back into HTML.
- Add D1 schema changes as a new numbered file under `worker/migrations/`; never rewrite an applied migration.
- Session IP addresses and user-agent strings are admin-only personal data. Do not expose them from user or public routes, logs, or front-end pages.
- Never commit `ADMIN_PASSWORD`, tokens or local Wrangler state.

Generated or data-heavy files should receive invariant checks and a short ownership comment; do not add noisy line-by-line comments. Prefer explanations of constraints and reasons over restating syntax.

## Web ChatGPT Git writer contract

When the Web ChatGPT Git writer app is selected, Web ChatGPT is the primary autonomous coding agent.
It must translate the user's natural-language request into a complete implementation without waiting
for another orchestrator. It must read this file, investigate and reproduce material findings, change
every required source and directly related test, critically inspect the complete diff, run all applicable
checks, fix failures, commit and push only `chatgpt/*`, create or update a pull request, and squash-merge it
after required checks pass. It must not impose arbitrary file-count or scope limits.
It must never push directly to `main`, force-push, delete branches, expose secrets, weaken tests,
or modify protected repository, workflow, credential, or writer files.
