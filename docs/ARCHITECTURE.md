# Architecture

## Deployment boundaries

The front end is static and requires no bundler. GitHub Pages serves the repository root through the custom domain in `CNAME`. The API is a separate Cloudflare Worker whose D1 binding and allowed browser origin are configured in `worker/wrangler.toml`.

## Browser flow

1. The home page logs a user in through `POST /api/login` and stores `hvsdcm.token` plus `hvsdcm.user` in localStorage.
2. A learning page loads `/account.js` with `data-app` and `data-key` attributes.
3. `account.js` requires the account token, fetches remote progress and shared accepted answers, then hydrates the app-specific localStorage record.
4. The app controller renders from static content plus that local record.
5. Writes to the app's localStorage key are debounced for 350 ms and synchronized to `PUT /api/progress/:app`. Custom aliases are also sent to `/api/answers/accept`.

The local record is a fast browser cache, while D1 is the cross-device source of truth. The one-time session marker `hvsdcm.loaded.<app>` prevents repeated reloads during hydration.

## Front-end ownership

- `assets/`: home-only presentation and behavior.
- `admin/assets/`: admin-only presentation and behavior.
- `account.js`: shared authentication and synchronization adapter.
- `WordMaster/assets/js/words.js`: vocabulary content only.
- `WordMaster/assets/js/app.js`: WordMaster state, grading and rendering.
- `smstudy/assets/js/data.js`: concept, source and question content only.
- `smstudy/assets/js/app.js`: social-studies state, grading and rendering.
- `smstudy/assets/kice/`: question images referenced by stable question IDs.

## Worker ownership

- `worker/src/index.js`: CORS, top-level exception boundary and Worker entrypoint.
- `worker/src/router.js`: endpoint matching and domain handlers.
- `worker/src/lib.js`: HTTP, hashing, token, authentication and activity helpers.
- `worker/migrations/`: append-only D1 schema history.

Sessions store SHA-256 token hashes rather than raw tokens. User passwords use PBKDF2-SHA-256 with per-user salts and 100,000 iterations. Admin authentication uses the `ADMIN_PASSWORD` Worker secret and receives a role-scoped session. Each authenticated request refreshes the session's last-seen time, Cloudflare client IP, IP fingerprint and user-agent; exact IP and user-agent fields are returned only by admin routes. Logout expires a session instead of deleting its audit row, and the admin session query prunes records after 90 days.

## API surface

| Method and path | Role | Purpose |
| --- | --- | --- |
| `POST /api/login` | public | User login |
| `POST /api/admin/login` | public | Admin login |
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

## Regression boundaries

`scripts/validate.mjs` treats stable IDs, counts, source coverage, image presence and HTML asset paths as contracts. `worker/test.mjs` covers pure security helpers plus response/CORS behavior that can run without a live D1 database. A real D1 migration or query change should additionally be exercised with `wrangler dev --local`.
