# Competition discovery reporting

The daily competition heartbeat discovers and prepares opportunities, but it does not submit an
application. The private local ledger and profile HMAC secret remain outside this repository. The
owner-only `/usage/?view=competition` dashboard receives only the redacted operational snapshot.

## Daily source coverage

Each cycle checks these discovery sources and keeps one coverage row per source, including failed,
blocked, timeout, and manual-check outcomes rather than treating access trouble as a closed source:

- 씽굿
- 위비티
- 공모박스
- 링커리어
- 캠퍼스픽
- 에브리커리어
- 콘테스트코리아
- 올콘
- 스탬플릿
- 기업마당
- K-Startup
- 국민생각함

The last three sources are filtered to actual contests, competitions, and challenges. Grants, jobs,
procurement, and sweepstakes are excluded. An aggregator listing is discovery evidence only. Before a
candidate can become active, the cycle must resolve an organizer-controlled HTTPS rules page and the
exact submission destination, then verify live acceptance, precise deadline, eligibility, fee, rights,
privacy terms, AI policy, deliverables, and receipt mechanism from that official source.

## Reporter

The checked-in fixture at `scripts/fixtures/competition-report.valid.json` is the minimal version 1
request contract. Validate a generated report without reading credentials or making a request:

```powershell
node scripts/competition-report.mjs --input path\to\report.json --dry-run
```

For a real report, create the dedicated connection once in an ignored Codex workspace configuration
directory. The initializer refuses to overwrite an existing secret and prints only a short hash
fingerprint, never the token:

```powershell
node scripts/competition-secret.mjs init `
  --config C:\Users\won\Desktop\Codex\config\competition.json `
  --api-url https://hvsdcm-api.hvsdcm1.workers.dev
```

The resulting file has this shape:

```json
{
  "api_url": "https://hvsdcm-api.hvsdcm1.workers.dev",
  "competition_ingest_token": "stored-outside-git"
}
```

Then run:

```powershell
node scripts/competition-report.mjs --input path\to\report.json --config path\to\competition.json
```

Set the same value as the dedicated Worker secret without placing it on the command line:

```powershell
node scripts/competition-secret.mjs put `
  --config C:\Users\won\Desktop\Codex\config\competition.json `
  --worker-config worker\wrangler.toml
```

`COMPETITION_API_URL`, `COMPETITION_INGEST_TOKEN`, and `COMPETITION_REPORT_CONFIG` provide equivalent
environment-based configuration. The helper sends the token only as a dedicated bearer credential,
requires a response bound to the same body `idempotency_key`, and never prints the token. Repeating the
exact report is an acknowledged replay, not another logical write; reusing a key with different content
is rejected by the API.

The report schema rejects raw identity, contact details, application prose, signatures, cookies,
consents, payments, receipts, final-submission payloads, and private data or tokens embedded in URL
paths or queries. The run date is bound to the start time's KST calendar day and future observations
have only a five-minute clock-skew allowance. Source counts must equal their reported candidates;
timeouts and HTTP 403 responses require manual follow-up and never prove closure. Active work remains
capped at three and may refer only to an officially verified, eligible, currently open, unexpired
`active` candidate with an offset-qualified deadline.

## Human approval boundary

Automation may discover, verify, score, deduplicate, draft, render, and stage. It must stop for exact
action-time approval before transmitting PII, accepting privacy/originality/publicity/rights terms,
signing, paying, or making the final representational submission. A previous schedule or broad approval
does not authorize a later contest's changed terms.
