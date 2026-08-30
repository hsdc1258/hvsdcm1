# Architecture

## Deployment boundaries

The front end is static and requires no bundler. GitHub Pages serves the repository root through the custom domain in `CNAME`. The API is a separate Cloudflare Worker whose D1 binding and allowed browser origin are configured in `worker/wrangler.toml`.

## Browser flow

1. The home page logs a user in through `POST /api/login` and stores `hvsdcm.token` plus `hvsdcm.user` in localStorage.
2. A learning page loads `/account.js` with `data-app` and `data-key` attributes.
3. `account.js` requires the account token, fetches remote progress and shared accepted answers, then hydrates the app-specific localStorage record.
4. The public content loader uses the same bearer session to fetch private R2 content through `/api/learning/*`; the app controller renders that content plus the local record.
5. Each app saves its local record and explicitly schedules a debounced 350 ms synchronization to `PUT /api/progress/:app`. Custom aliases are also sent to `/api/answers/accept`.
6. The local Codex control plane sends one authenticated harness report alongside each Discord progress report. The Worker merges actors by stable ID and returns every retained harness task to the owner-only usage screen, which separates parallel tasks into `active`, derived `stale`, and `complete` views. The active view offers portfolio and organization modes and places each retained active session exactly once below its reported phase; completed and stale tasks stay in their dedicated lists. Each session connects to a compact hierarchy containing only the actors actually present in the report by stable parent ID; it never invents a Main Codex for a report with no actors. Display titles remove a trailing `(MM-DD)` suffix and demote that date to small metadata beside phase progress. A selected session still renders the canonical eight reported phases (legacy four-key reports stay valid as a subset; the screen's `PHASES` and the Worker's `VALID_HARNESS_PHASES` are cross-checked source-to-source by `scripts/validate.mjs`), module progress, evidence and its own reporting tree. Model plus reasoning, role, assignment, status and progress come directly from each actor report; gate and evidence remain non-person session metadata. A desktop `aside` shows only Codex account-limit snapshots and reflows below the pipeline on narrower screens.
7. The past-paper screen fetches its R2-resident manifest and PDFs only through bearer-authenticated Worker routes. Selection extraction and merging remain in the browser; neither the static Pages deployment nor logged-out HTML contains the exam list.
8. The owner-only moderator control plane keeps proposed work in `moderator_items` until an explicit approval transaction creates one `moderator_commands` row. A separately authenticated local daemon atomically claims one queued command with a lease, reports forward-only execution states, and can acquire an idle-review lease only when no live harness task, active command, or other review exists.
9. The Behavior Lab static shell is noindexed and covered until `GET /api/behavior-lab/paper` authenticates the bearer session as the exact, separately configured `BEHAVIOR_OWNER_USERNAME`. The test-account list in `OWNER_USERNAME` is deliberately irrelevant: a missing or comma-separated Behavior owner fails closed, unauthenticated reads return 401, and non-owner sessions receive 404. The owner-only market tab calls `GET /api/behavior-lab/dashboard?symbol=...&period=...`; the Worker then constructs the exact eight accepted Bitget public-market GETs and returns only a fully validated live snapshot. The paper tab reads the fixed $100 simulation's reserved `usage_snapshots` source, which the ordinary usage route's codex/claude allowlist excludes. Its dedicated report-token POST validates content length, exact session/deadline/simulation, finite bounded metrics and log/trade limits before an atomic sequence-only-newer upsert. Neither path exposes a token, credential, private exchange route, balance, or order surface.

The local record is a fast browser cache, while D1 is the cross-device source of truth. The one-time session marker `hvsdcm.loaded.<app>` prevents repeated reloads during hydration.

## Front-end ownership

- `assets/`: home-only presentation and behavior.
- `assets/js/study-utils.js`: shared HTML escaping, stable sorting and randomization for both learning apps.
- `admin/assets/`: admin-only presentation and behavior.
- `account.js`: shared authentication and synchronization adapter.
- `_learning/wordmaster/words.js`: Jekyll-hidden vocabulary source used by validation and the R2 payload builder.
- `WordMaster/assets/js/words.js`: public authenticated-content loader; contains no vocabulary rows.
- `WordMaster/assets/js/app.js`: WordMaster state, grading, personal error-rate metrics and rendering.
- `_learning/smstudy/`: Jekyll-hidden concept, question, explanation and 78-image source used by validation and the R2 payload builder.
- `smstudy/assets/js/data.js`: public authenticated-content loader; the companion data filenames remain empty compatibility stubs for script-order stability.
- `smstudy/assets/js/app.js`: social-studies state, source error-rate sorting, grading and rendering.
- `gichul/`: login-gated past-paper filtering, viewing, extraction and client-side merge UI. The data list itself is not checked into this directory. The screen loads `account.js` in gate-only mode (`data-app`, no `data-key` — there is no study progress to sync), then the vendored icon set, then `assets/vendor/pdf-lib/`, then `gichul/app.js`; filter options, labels and results are all derived from the manifest that `GET /api/gichul/manifest` returns after authentication.
- `behavior-lab/`: owner-gated classic-script dashboard. `assets/js/app.js` reads the existing account bearer, keeps the shell covered until exact-owner verification, and renders separate market and paper-session tabs; `assets/js/core.js` owns the deterministic walk-forward and inert manual draft calculations.
- `assets/vendor/pdf-lib/`: pinned pdf-lib UMD bundle plus its MIT text, used for in-browser merging and selection-section extraction. `scripts/validate.mjs` locks the bundle bytes with a sha256 so it cannot be swapped silently.

## Worker ownership

- `worker/src/index.js`: CORS, top-level exception boundary and Worker entrypoint.
- `worker/src/router.js`: endpoint matching and domain handlers.
- `worker/src/lib.js`: HTTP, hashing, token, authentication and activity helpers.
- `worker/src/behavior-lab.js`: fixed-host/fixed-path public Bitget adapter, strict response/freshness/join validation, bounded timeout/response/cache controls and explanatory signal construction. It has no D1/R2 or credential dependency; owner authentication and paper persistence stay in `router.js`.
- `worker/migrations/`: append-only D1 schema history.
- R2 binding `GICHUL`: generated past-paper manifest/PDFs plus WordMaster and social-studies payloads/images. All are private behind Worker session checks rather than static Pages assets.

The KICE ingestion pipeline is owned by `scripts/gichul/`. `fetch-kice.mjs` derives attachments and a current `fileSeq` inventory from the official list filters for academic years 2020-2027, refreshing an existing PDF when that sequence changes. `build-manifest.mjs` derives deterministic metadata and page sections from only the inventoried filesystem and rejects incomplete question/answer or track coverage. `upload-r2.mjs` uploads content-hash changes through the locally installed Wrangler CLI, placing changed PDFs before the manifest visibility switch and advancing its checkpoint only after success. `gichul-src/`, the crawl inventory, and the upload checkpoint are ignored. The checked-in `overrides.json` is only an exact `common`/`selection` correction layer keyed by final manifest ID; it is not a second source list.

Sessions store SHA-256 token hashes rather than raw tokens. User passwords use PBKDF2-SHA-256 with per-user salts and 100,000 iterations. Admin authentication uses the `ADMIN_PASSWORD` Worker secret and receives a role-scoped session. Each authenticated request refreshes the session's last-seen time, Cloudflare client IP, IP fingerprint and user-agent; exact IP and user-agent fields are returned only by admin routes. Logout expires a session instead of deleting its audit row, and the admin session query prunes records after 90 days.

Moderator browser routes reuse the existing owner session and hide the route from every other signed-in account with a 404. Daemon routes instead require `MODERATOR_DAEMON_TOKEN`; that secret is never stored in D1 or returned to the browser. Migration `0011` separates items, append-only item events, and executable commands. Proposal approval runs the pending-state update, event insert, and command insert in one D1 batch, while unique idempotency and source-item constraints make retries and double-clicks non-duplicating. Command claim uses one conditional `UPDATE ... RETURNING`; later state writes require the same unexpired lease. Missing model facts remain JSON `null`, and only bounded two-line result summaries—not execution logs, IP addresses, or user-agent values—are returned from moderator routes.

Harness payload version 1 remains backward compatible while accepting `title`, a UTF-8 4KB-truncated original `input`, and `heartbeat_at`. Migration `0009` keeps queryable copies beside the canonical JSON and adds source-level collector health. Migration `0010` adds `project_key` and `project_title`; reporters that explicitly send a project key receive a backward-compatible `project_snapshot` response containing every task in that project, append-only event revision, server-observed weekly-limit data, and wall-clock start/update/completion timestamps. Legacy reporters still receive the original `{ ok, task_id }` shape. The Worker owns lifecycle metadata rather than trusting reporters: it stamps a new actor's start time and initial remaining-limit snapshot, normalizes `approve` and `done` reports to terminal `complete` with progress 100, stamps `done`/`blocked` actor transitions, records task completion time, and derives an `active` task as `stale` only after more than fifteen minutes without a heartbeat. A terminal task stays complete unless a newer report explicitly carries `resume: true`. Heartbeat-only reports update liveness without rewriting task or actor meaning. Usage snapshots accept only a strictly newer, millisecond-preserving `captured_at` and return `advanced: true|false`; collectors treat anything except `true` as failure. Health-only sources remain visible to the owner even before their first snapshot. Owner lookup accepts `completed_limit=0..1000`; when present it keeps every non-complete task and returns only the newest completed tasks by `completed_at` with `updated_at` as the legacy fallback. Omitting the parameter preserves the full response.

## API surface

| Method and path | Role | Purpose |
| --- | --- | --- |
| `POST /api/login` | public | User login |
| `POST /api/admin/login` | public | Admin login |
| `GET /api/behavior-lab/dashboard?symbol=...&period=...` | behavior owner | Validated live Bitget public-market snapshot and explanatory candidate; fixed enum and exact eight upstream GET boundary |
| `GET /api/behavior-lab/paper` | behavior owner | Latest validated snapshot for the fixed $100 paper session |
| `POST /api/behavior-lab/paper/report` | paper report token | Replace the reserved snapshot only with a strictly newer bounded sequence |
| `GET /api/me` | user | Current user |
| `POST /api/logout` | token | Delete current session |
| `GET/PUT /api/progress/:app` | user | Read or replace app progress |
| `GET /api/answers/:app` | user | Read shared accepted answers |
| `POST /api/answers/accept` | user | Add a shared accepted answer |
| `GET/POST /api/admin/users` | admin | List or create users |
| `DELETE /api/admin/users/:id` | admin | Delete a user and related data |
| `GET /api/admin/stats` | admin | Aggregate activity |
| `GET /api/admin/sessions` | admin | Recent device, IP and session activity |
| `GET /api/admin/answers` | admin | Review accepted answers |
| `POST /api/usage/report` | ingest token | Replace the latest Codex limit snapshot |
| `POST /api/harness/report` | harness ingest token | Merge a task, gate, actor and artifact report |
| `GET /api/usage[?completed_limit=N]` | owner user | Read Codex limits and harness tasks; optionally cap completed tasks while retaining all active tasks |
| `GET /api/moderator[?cursor=...&limit=50]` | owner user | Read moderator brain facts, item/event pages, command summaries and active counts |
| `POST /api/moderator/commands` | owner user | Idempotently enqueue one direct command |
| `POST /api/moderator/items/:id/decision` | owner user | Edit, reject, or atomically approve a pending proposal |
| `POST /api/moderator/items/:id/acknowledge` | owner user | Acknowledge an open important item without creating a command |
| `POST /api/moderator/daemon/claim` | daemon token | Atomically lease one queued command and return the effective active-task count |
| `POST /api/moderator/daemon/commands/:id/state` | daemon token | Advance or heartbeat a command under its current lease |
| `POST /api/moderator/daemon/items` | daemon token | Record bounded important/proposal/review summaries or finish a leased review |
| `POST /api/moderator/daemon/review-lease` | daemon token | Acquire the single idle-review lease only when server-side idle checks pass |
| `GET /api/gichul/manifest` | user | Read the R2 past-paper manifest with caching disabled |
| `GET /api/gichul/pdf/:id` | user | Stream a manifest-mapped R2 PDF with caching disabled |
| `GET /api/learning/wordmaster` | user | Read the private WordMaster payload with caching disabled |
| `GET /api/learning/smstudy` | user | Read the private social-studies payload with caching disabled |
| `GET /api/learning/smstudy/image/:name` | user | Stream one allowlisted-name private WebP with caching disabled |

## Regression boundaries

`scripts/validate.mjs` treats stable IDs, counts, source coverage, image presence, HTML asset paths, and the KICE/R2 backend wiring as contracts. `worker/test.mjs` covers pure security helpers plus response/CORS behavior that can run without a live D1 database or R2 bucket. Script tests inject PDF text extraction, so real-PDF section accuracy remains a deployment gate. A real D1 migration or query change should additionally be exercised with `wrangler dev --local`; the past-paper feature additionally requires an authenticated live R2/CORS check after upload.
