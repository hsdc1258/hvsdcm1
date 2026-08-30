import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CompetitionReportError,
  readCompetitionReport,
  runCompetitionReporter,
  sendCompetitionReport,
  validateCompetitionReport,
} from './competition-report.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, 'fixtures', 'competition-report.valid.json');

function validReport() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

function acknowledgement(report, replayed = false) {
  return {
    ok: true,
    version: 1,
    idempotency_key: report.idempotency_key,
    run_id: report.run.id,
    replayed,
    counts: {
      sources: report.sources.length,
      candidates: report.candidates.length,
      applications: report.applications.length,
    },
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test('checked-in fixture is a strict redacted competition report and dry-runs without credentials', async () => {
  const report = readCompetitionReport(FIXTURE);
  assert.equal(report.version, 1);
  assert.equal(report.applications.length, 1);
  const result = await runCompetitionReporter(['--input', FIXTURE, '--dry-run'], { env: {} });
  assert.deepEqual(result, {
    ok: true,
    dry_run: true,
    version: 1,
    idempotency_key: report.idempotency_key,
    run_id: report.run.id,
    counts: { sources: 1, candidates: 1, applications: 1 },
  });
});

test('strict validation rejects private fields, extra fields, floating deadlines, and unsafe URLs', () => {
  for (const mutate of [
    (report) => { report.candidates[0].email = 'person@example.test'; },
    (report) => { report.run.unexpected = true; },
    (report) => { report.candidates[0].deadline_at = '2026-09-15T14:59:00'; },
    (report) => { report.candidates[0].official_url = 'http://127.0.0.1/rules'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules?email=person@example.test'; },
    (report) => { report.applications[0].profile_id = 'sha256:guessable'; },
    (report) => { report.sources[0].failure_code = 'timeout'; },
    (report) => { report.candidates[0].submission_risk = 'blocked'; },
    (report) => { report.run.date = '2026-02-30'; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.throws(() => validateCompetitionReport(report), CompetitionReportError);
  }
});

test('reporter sends the exact body idempotency key with only the dedicated bearer token', async () => {
  const report = validReport();
  let request;
  const result = await sendCompetitionReport(report, {
    apiUrl: 'https://api.test/',
    token: 'dedicated-secret',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return response(200, acknowledgement(report));
    },
  });
  assert.equal(request.url, 'https://api.test/api/competitions/report');
  assert.equal(request.options.headers.authorization, 'Bearer dedicated-secret');
  assert.equal(request.options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), report);
  assert.equal(result.replayed, false);
  assert.doesNotMatch(JSON.stringify(result), /dedicated-secret/u);
});

test('invalid secret is explicit while the secret never appears in the error', async () => {
  const report = validReport();
  await assert.rejects(
    sendCompetitionReport(report, {
      apiUrl: 'https://api.test',
      token: 'wrong-secret-value',
      fetchImpl: async () => response(401, { error: 'wrong-secret-value' }),
    }),
    (error) => {
      assert.equal(error.code, 'unauthorized');
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /wrong-secret-value/u);
      return true;
    },
  );
});

test('an exact idempotency replay is acknowledged without a second logical write', async () => {
  const report = validReport();
  const stored = new Map();
  let writes = 0;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const replayed = stored.has(body.idempotency_key);
    if (!replayed) {
      stored.set(body.idempotency_key, options.body);
      writes += 1;
    } else {
      assert.equal(stored.get(body.idempotency_key), options.body);
    }
    return response(200, acknowledgement(body, replayed));
  };
  const options = { apiUrl: 'https://api.test', token: 'secret', fetchImpl };
  const first = await sendCompetitionReport(report, options);
  const second = await sendCompetitionReport(report, options);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(writes, 1);
});

test('a success response must bind the same report and exact counts', async () => {
  const report = validReport();
  await assert.rejects(sendCompetitionReport(report, {
    apiUrl: 'https://api.test',
    token: 'secret',
    fetchImpl: async () => response(200, {
      ...acknowledgement(report),
      idempotency_key: 'competition-daily-other-001',
    }),
  }), /invalid acknowledgement/u);
});
