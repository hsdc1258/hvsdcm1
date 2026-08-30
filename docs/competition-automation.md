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

## Crawler

The local crawler performs the actual list parsing; a successful HTTP status alone is not counted as
successful discovery. It follows an HTTPS host allowlist, keeps the timeout and byte cap active through
the complete response body, uses three concurrent
requests, and reports selector drift, TLS/network failures, timeouts, 403 responses, and ambiguous
government listings as manual coverage. If one page succeeds and a later page fails, the discovered
items are retained while the source is marked partial. CampusPick and EveryCareer are separate health
checks for the same corpus, so their candidates are deduplicated before source counts are calculated.
Wevity, Linkareer, ContestKorea, Bizinfo, and 국민생각함 traverse five bounded pages per run;
Gongmobox traverses its home plus six contest categories. Allcon reads its rendered home plus the
site's real JSON listing endpoint for six types, validates each response's requested/current page and
pagination totals, and follows every advertised page up to 50 pages per type and 300 dynamically added
URLs per source. Exceeding either bound is explicit partial coverage; the empty browser shell is never
counted as coverage. Each source also has a 90-second total budget, and two consecutive timeout,
network, rate-limit, or HTTP 403 outcomes stop its remaining pages as partial/manual coverage. Repeated non-empty page identity sets also force partial/manual coverage instead
of allowing an ignored pagination parameter to look successful. Stampit traverses all 17 pages exposed by its current server-rendered
paginator and becomes partial if that page count grows beyond the configured window. CampusPick and its
EveryCareer alias currently return the same 24 detail rows in one response with no pagination, cursor,
or load-more contract. Selector drift or a newly exposed
pagination control makes the affected source partial instead of silently truncating it. Thinkgood and
the robots-allowed K-Startup fragment do not expose a dependable pagination contract, so those rows
are always marked `partial` / `manual_check:true` instead of being misreported as full coverage.
Contest-scoped detail rows are retained even when their title does not
match a narrow keyword; government feeds still require contest evidence and exclude context-specific
grant, hiring, procurement, and event records.

The crawler retains up to 2,500 distinct rows per source and 500 redacted candidates per report. A
capacity overflow never discards the entire daily artifact or claims complete coverage: affected
sources become `partial` with `manual_check:true`, while the external verification queue preserves the
broader discovery work. The strict report transport accepts at most 1 MB.

Create a strict report and an official-verification queue outside Git with:

    node scripts/competition-crawl.mjs --report-out C:\path\outside-git\competition-report.json --verification-out C:\path\outside-git\competition-verification.json

Install the lockfile before the first run in a fresh checkout (`npm ci --ignore-scripts`). Cheerio is a
runtime dependency of the local crawler, not only a test dependency.

The command prints only source status and counts. Raw HTML is never saved or logged. Candidate output is
redacted and remains unverified / verifying; the crawler does not invent organizer verification,
eligibility, deadlines, acceptance, or applications. The report is passed through the same strict
validateCompetitionReport contract before it is written. It can then be dry-run and sent with the
reporter below.

After checking organizer-controlled rules and the live submission destination, record only the
redacted verification fields in a version 1 evidence file and merge it into that same crawl:

```powershell
node scripts/competition-evidence.mjs `
  --report C:\path\outside-git\competition-report.json `
  --evidence C:\path\outside-git\competition-official-evidence.json `
  --out C:\path\outside-git\competition-verified-report.json
```

The evidence merge is bound to the exact `contest_id + category` candidate key, exact-keyed, and
chronological. It replaces the discovery
site's organizer label with the organizer verified from the official source, and refuses stale evidence
that predates the discovery or an existing verification, same-time conflicts, listing-origin URLs posed
as official sources, evidence recorded after the report observation, unknown candidate IDs,
and any `active` result that fails the reporter's official/open/eligible/deadline/risk invariants.
Use the merged report for the dry-run and POST; never copy application answers or contact data into
the evidence file.

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
exact report is an acknowledged replay, not another logical write; reusing a key with different raw
field values is rejected by the API even when storage normalization would produce the same saved text.
JSON object key order alone does not create a conflict.

The report schema rejects raw identity, contact details, application prose, signatures, cookies,
consents, payments, receipts, final-submission payloads, and private data or tokens embedded in
metadata text, URL paths, or URL queries. The run date is bound to the start time's KST calendar day and future observations
have only a five-minute clock-skew allowance; source checks, discovery, official verification, and
application updates cannot claim evidence later than that run's observation. Source counts must equal their reported candidates;
timeouts and HTTP 403 responses require manual follow-up and never prove closure. Active work remains
capped at three and may refer only to an officially verified, eligible, currently open, unexpired
`active` candidate with an offset-qualified deadline.

## Results-only Discord delivery

The Discord helper creates or reuses exactly one text channel named 공모전-지원-결과 under the 기본
category. The channel is bound by the topic marker codex:competition-results:v1 and every send
rechecks the guild, exact `기본` parent category, channel type, name, and topic. A same-name boundary
conflict fails closed instead of creating a duplicate. Channel state is stored outside Git. Requests
have a bounded timeout, mentions are
disabled, and only discovery_complete, submission_complete, or approval_required messages are
accepted:

    node scripts/competition-discord.mjs ensure-channel --env C:\path\to\discord-bot\.env --config C:\path\outside-git\competition-discord.json
    node scripts/competition-discord.mjs send-result --env C:\path\to\discord-bot\.env --config C:\path\outside-git\competition-discord.json --kind discovery_complete --message-file C:\path\outside-git\result.txt

The bot process exits after each request. This helper does not start a resident bot, enable a
scheduled bot task, or revive Moder/session-feedback reporting.

## Human approval boundary

Automation may discover, verify, score, deduplicate, draft, render, and stage. It must stop for exact
action-time approval before transmitting PII, accepting privacy/originality/publicity/rights terms,
signing, paying, or making the final representational submission. A previous schedule or broad approval
does not authorize a later contest's changed terms.

Discord delivery, when enabled, is results-only: completed submissions or exact human-action gates may
be reported, but crawl progress, raw logs, Moder traffic, and session feedback are not sent.
