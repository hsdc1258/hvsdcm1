# hvsdcm

Static learning site served by GitHub Pages, with account synchronization and administration provided by a Cloudflare Worker backed by D1.

## Applications

| Path | Purpose | Browser entrypoint | Persistent key |
| --- | --- | --- | --- |
| `/` | Home, drawer and account login | `assets/js/home.js` | account token/user keys |
| `/WordMaster/` | 2,000-word meaning quiz with personal error-rate/recent sorting | `WordMaster/assets/js/app.js` | `wordmaster2000.quiz.v1` |
| `/smstudy/` | Social studies concepts and 78 sortable KICE questions | `smstudy/assets/js/app.js` | `samun2027.study.v1` |
| `/gichul/` | Login-only KICE past-paper filtering, viewing and client-side PDF merge | `gichul/app.js` | filter settings |
| `/admin/` | User, activity, device/IP and shared-answer administration | `admin/assets/js/admin.js` | session-only admin token |
| `/usage/` | Owner-only Codex limits and live AI harness hierarchy | `usage/assets/js/usage.js` | account token |
| Worker | JSON API, D1 access and authenticated R2 PDF proxy | `worker/src/index.js` | D1 tables and R2 objects |

There is no front-end build step. HTML loads checked-in CSS, JavaScript, WebP and data files directly, so filenames and script order are deployment contracts.

## Local verification

Requires Node.js 20 or newer. The normal test suite does not load the optional real-PDF extractor, so it can run before the root development dependency is installed.

```bash
npm test
```

The command checks every JavaScript file, local HTML asset references, the WordMaster 50 × 40 data shape, all 13 social-studies subunits and 78 image-backed questions, shared study sorting behavior, then runs Worker utility and routing tests.

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

## KICE past-paper data

The KICE list pages are the only collection source; there is no hand-maintained post seed. The collector covers academic years 2020-2027 for Korean, mathematics, English, Social and Culture, and the Politics and Law lineage (including its former `법과 정치` name). Source PDFs, their current list-derived `fileSeq` inventory, and the generated manifest stay in ignored `gichul-src/`. A repeated crawl skips a cached file only when its PDF signature is valid and its inventory `fileSeq` still matches; an official attachment replacement is downloaded atomically.

```bash
node scripts/gichul/fetch-kice.mjs
npm install
node scripts/gichul/build-manifest.mjs
node scripts/gichul/upload-r2.mjs --bucket hvsdcm-gichul
```

Only the orchestrator should run the networked collection and upload commands. In its default production mode, `build-manifest.mjs` refuses missing question/answer or track coverage, PDFs absent from the current crawl inventory, and inventory entries whose PDFs are absent. It uses `pdfjs-dist` to count pages and detect the 2022+ Korean and mathematics selection-section headers. If a real PDF needs correction, add that final manifest ID to `scripts/gichul/overrides.json` under `sections`, with exactly `common` and `selection` as inclusive one-based page ranges. Invalid, unused, out-of-document, inconsistent-common, or overlapping ranges stop the build. `--allow-partial` exists only for isolated fixtures and diagnostics, never publication.

The R2 uploader includes `manifest.json` and every referenced PDF. It records content hashes in `gichul-src/.r2-upload-state.json`, so a repeat run uploads only locally new or changed objects. Changed PDFs are uploaded first and `manifest.json` is published last; the checkpoint advances only after every upload succeeds. Deleting an object directly from R2 requires removing that local checkpoint before restoring it.

Apply D1 migrations before deploying Worker code. Migration `0004_session_ip_address.sql` enables exact IP display for requests made after deployment; `0006_harness_tasks.sql` stores the latest owner-only pipeline state mirrored from Discord reporting. Older sessions may only have a one-way IP fingerprint.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for request and synchronization flows, and [`CONTRIBUTING.md`](CONTRIBUTING.md) before modifying data or D1 migrations.
