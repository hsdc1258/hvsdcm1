# hvsdcm

Static learning site served by GitHub Pages, with account synchronization and administration provided by a Cloudflare Worker backed by D1.

## Applications

| Path | Purpose | Browser entrypoint | Persistent key |
| --- | --- | --- | --- |
| `/` | Home, drawer and account login | `assets/js/home.js` | account token/user keys |
| `/WordMaster/` | 2,000-word meaning quiz | `WordMaster/assets/js/app.js` | `wordmaster2000.quiz.v1` |
| `/smstudy/` | Social studies concepts and 78 KICE questions | `smstudy/assets/js/app.js` | `samun2027.study.v1` |
| `/admin/` | User, activity, device/IP and shared-answer administration | `admin/assets/js/admin.js` | session-only admin token |
| Worker | JSON API and D1 access | `worker/src/index.js` | D1 tables |

There is no front-end build step. HTML loads checked-in CSS, JavaScript, WebP and data files directly, so filenames and script order are deployment contracts.

## Local verification

Requires Node.js 20 or newer. No root dependencies need to be installed.

```bash
npm test
```

The command checks every JavaScript file, local HTML asset references, the WordMaster 50 × 40 data shape, all 13 social-studies subunits and 78 image-backed questions, then runs Worker utility and routing tests.

For a static preview:

```bash
python3 -m http.server 4173
```

Worker development remains inside `worker/`:

```bash
cd worker
npm install
npm run db:init
npm run dev
```

Apply D1 migrations before deploying Worker code. Migration `0004_session_ip_address.sql` enables exact IP display for requests made after deployment; older sessions may only have a one-way IP fingerprint.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for request and synchronization flows, and [`CONTRIBUTING.md`](CONTRIBUTING.md) before modifying data or D1 migrations.
