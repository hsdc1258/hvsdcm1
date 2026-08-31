import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CompetitionReportError,
  competitionActionSha256,
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

function finalApprovalReport() {
  const report = validReport();
  report.applications[0].state = 'WAITING_APPROVAL';
  report.applications[0].blocker = 'user_approval';
  report.applications[0].next_action = 'request_approval';
  const actionManifest = {
    version: 1,
    organizer: report.candidates[0].organizer,
    contest_id: report.candidates[0].contest_id,
    category: report.candidates[0].category,
    submission_url: 'https://submit.organizer.example/apply',
    submission_host: 'submit.organizer.example',
    fee: { required: false, amount_minor: 0, currency: 'NONE' },
    rights_class: 'limited_license',
    consent_text_sha256: ['1'.repeat(64)],
    artifact_sha256: ['2'.repeat(64)],
    payload_sha256: '3'.repeat(64),
  };
  report.approvals = [{
    request_id: 'competition-final-example-image',
    contest_id: report.candidates[0].contest_id,
    category: report.candidates[0].category,
    kind: 'final_submission',
    action_sha256: competitionActionSha256(actionManifest),
    requested_at: report.applications[0].updated_at,
    expires_at: '2026-08-31T01:20:00+09:00',
    submission_url: actionManifest.submission_url,
    action_manifest: actionManifest,
    read_summary: '공식 제출 목적지와 비식별 manifest의 해시를 마지막으로 확인했습니다.',
    approval_text: '표시된 목적지와 action manifest를 한 번만 최종 제출합니다.',
  }];
  return report;
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
    (report) => { report.candidates[0].official_url = 'https://localhost./rules'; },
    (report) => { report.candidates[0].official_url = 'https://[::ffff:127.0.0.1]/rules'; },
    (report) => { report.candidates[0].official_url = 'https://[::ffff:7f00:1]/rules'; },
    (report) => { report.candidates[0].official_url = 'https://[::ffff:a00:1]/rules'; },
    (report) => { report.candidates[0].official_url = 'https://[::ffff:169.254.169.254]/meta'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules?email=person@example.test'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules/person%2540example.test'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules?access-token=privatevalue123'; },
    (report) => { report.sources[0].reference_url = 'https://list.example/01012345678/contests'; },
    (report) => { report.candidates[0].discovery_url = 'https://list.example/contests?client.secret=privatevalue123'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules?refresh_token=privatevalue123'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules?x-amz-signature=privatevalue123'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules?oauthCode=privatevalue123'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules/ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules?ref=glpat-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules?ref=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules/Bearer%20abcdefghijklmnopqrstuvwxyz123456'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules?ref=Bearer%20abcdefghijklmnopqrstuvwxyz123456'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/%3Cscript%3Ealert%281%29%3C%2Fscript%3E'; },
    (report) => { report.candidates[0].official_url = 'https://[64:ff9b::7f00:1]/rules'; },
    (report) => { report.sources[0].name = '담당자 01012345678'; },
    (report) => { report.candidates[0].title = 'authorization=privatevalue123'; },
    (report) => { report.candidates[0].organizer = '기관 01012345678'; },
    (report) => { report.candidates[0].title = '지원자 900101-1234567 아이디어 공모전'; },
    (report) => { report.candidates[0].title = '지원자: 홍길동 아이디어 공모전'; },
    (report) => { report.candidates[0].organizer = '신청자 성명=홍길동'; },
    (report) => { report.candidates[0].title = '지원자 홍길동의 지원 결과'; },
    (report) => { report.candidates[0].organizer = '주소 서울특별시 중구'; },
    (report) => { report.candidates[0].organizer = '주최 기관 - 공식 확인 필요'; },
    (report) => { report.candidates[0].organizer = '홍길동 900101 5234567'; },
    (report) => { report.candidates[0].title = '<b>Example Contest</b>'; },
    (report) => { report.candidates[0].organizer = '<script>alert(1)</script>기관'; },
    (report) => { report.sources[0].name = '담당자 010·1234·5678'; },
    (report) => { report.sources[0].name = '담당자 0212345678'; },
    (report) => { report.candidates[0].title = 'Contest:+1-212-555-1212'; },
    (report) => { report.candidates[0].title = '안내 (authorization)=privatevalue123'; },
    (report) => { report.candidates[0].title = '안내 private_key=privatevalue123'; },
    (report) => { report.candidates[0].organizer = '기관, client secret: privatevalue123'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/rules?private_key=privatevalue123'; },
    (report) => { report.candidates[0].official_url = 'https://organizer.example/submission=privatevalue123'; },
    (report) => { report.sources[0].name = '담당자 0\u030110\u03011234\u03015678'; },
    (report) => { report.candidates[0].title = '안내【authorization】::privatevalue123'; },
    (report) => { report.candidates[0].title = 'authori\u0301zation=privatevalue123'; },
    (report) => { report.candidates[0].organizer = 'person\u200B@example.com'; },
    (report) => { report.sources[0].name = 'person%25E2%2580%258B@example.com'; },
    (report) => { report.applications[0].profile_id = 'sha256:guessable'; },
    (report) => { report.sources[0].failure_code = 'timeout'; },
    (report) => { report.candidates[0].submission_risk = 'blocked'; },
    (report) => { report.run.date = '2026-02-30'; },
    (report) => { report.idempotency_key = '01012345678'; },
    (report) => { report.run.id = '0212345678'; },
    (report) => {
      report.sources[0].id = '01012345678';
      report.candidates[0].source_id = '01012345678';
    },
    (report) => {
      report.candidates[0].contest_id = '01012345678';
      report.applications[0].contest_id = '01012345678';
    },
    (report) => {
      report.candidates[0].category = '0212345678';
      report.applications[0].category = '0212345678';
    },
  ]) {
    const report = validReport();
    mutate(report);
    assert.throws(() => validateCompetitionReport(report), CompetitionReportError);
  }
});

test('strict consistency rejects untrusted coverage, expired active work, and non-active applications', () => {
  for (const mutate of [
    (report) => { report.sources[0].candidate_count = 0; },
    (report) => { report.sources[0].status = 'no_results'; },
    (report) => { report.candidates[0].deadline_at = report.run.finished_at; },
    (report) => { report.candidates[0].status = 'deferred'; },
    (report) => { report.candidates[0].official_url = 'https://list.example/official-looking-rules'; },
    (report) => { report.candidates[0].official_url = 'https://www.list.example/official-looking-rules'; },
    (report) => { report.candidates[0].official_url = 'https://www2.list.example/official-looking-rules'; },
    (report) => { report.candidates[0].official_url = 'https://rules.list.example/official-looking-rules'; },
    (report) => { report.candidates[0].official_url = 'https://www.list.example../official-looking-rules'; },
    (report) => {
      report.sources[0].status = 'partial';
      report.sources[0].failure_code = 'http_403';
      report.sources[0].manual_check = true;
      report.candidates[0].acceptance = 'closed';
      report.candidates[0].status = 'rejected';
      report.applications = [];
    },
  ]) {
    const report = validReport();
    mutate(report);
    assert.throws(() => validateCompetitionReport(report), CompetitionReportError);
  }
});

test('an official source may verify a candidate on its own origin', () => {
  const report = validReport();
  report.sources[0].kind = 'official';
  report.candidates[0].official_url = 'https://list.example/official/rules';
  assert.equal(validateCompetitionReport(report), report);
});

test('approval requests bind redacted review wording and exact action to the matching application state', () => {
  const report = validReport();
  report.applications[0].state = 'WAITING_RIGHTS_APPROVAL';
  report.applications[0].blocker = 'rights';
  report.applications[0].next_action = 'review_rights';
  report.approvals = [{
    request_id: 'competition-preparation-example-image',
    contest_id: report.candidates[0].contest_id,
    category: report.candidates[0].category,
    kind: 'preparation',
    action_sha256: 'a'.repeat(64),
    requested_at: report.applications[0].updated_at,
    expires_at: null,
    read_summary: '권리 이용 범위와 제출 규격을 공식 공고에서 확인했습니다.',
    approval_text: '작품 초안과 비식별 서류 준비만 허용합니다.',
  }];
  assert.equal(validateCompetitionReport(report), report);

  const privateCopy = structuredClone(report);
  privateCopy.approvals[0].read_summary = '담당자 person@example.test';
  assert.throws(() => validateCompetitionReport(privateCopy), CompetitionReportError);

  const mismatched = structuredClone(report);
  mismatched.approvals[0].kind = 'final_submission';
  mismatched.approvals[0].expires_at = report.run.finished_at;
  assert.throws(() => validateCompetitionReport(mismatched), CompetitionReportError);
});

test('final approval binds a distinct rules URL and canonical submission action manifest', () => {
  const report = finalApprovalReport();
  assert.notEqual(report.candidates[0].official_url, report.approvals[0].submission_url);
  assert.equal(validateCompetitionReport(report), report);

  const mutations = [
    (approval) => { approval.action_manifest.version = 2; },
    (approval) => { approval.action_manifest.organizer = 'Different Organizer'; },
    (approval) => { approval.action_manifest.contest_id = 'different-contest'; },
    (approval) => { approval.action_manifest.category = 'different-category'; },
    (approval) => {
      approval.submission_url = 'https://other.organizer.example/apply';
      approval.action_manifest.submission_url = approval.submission_url;
      approval.action_manifest.submission_host = 'other.organizer.example';
    },
    (approval) => { approval.action_manifest.submission_host = 'other.organizer.example'; },
    (approval) => { approval.action_manifest.fee = { required: true, amount_minor: 1000, currency: 'KRW' }; },
    (approval) => { approval.action_manifest.rights_class = 'ownership_transfer'; },
    (approval) => { approval.action_manifest.consent_text_sha256 = ['4'.repeat(64)]; },
    (approval) => { approval.action_manifest.artifact_sha256 = ['5'.repeat(64)]; },
    (approval) => { approval.action_manifest.payload_sha256 = '6'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const changed = finalApprovalReport();
    const originalHash = changed.approvals[0].action_sha256;
    mutate(changed.approvals[0]);
    assert.equal(changed.approvals[0].action_sha256, originalHash);
    assert.throws(() => validateCompetitionReport(changed), CompetitionReportError);
  }

  for (const submissionUrl of [
    'http://organizer.example/apply',
    'https://localhost./apply',
    'https://organizer.example/apply?token=privatevalue123',
  ]) {
    const unsafe = finalApprovalReport();
    unsafe.approvals[0].submission_url = submissionUrl;
    unsafe.approvals[0].action_manifest.submission_url = submissionUrl;
    assert.throws(() => validateCompetitionReport(unsafe), CompetitionReportError);
  }
});

test('run date is KST-bound and observation time allows no more than five minutes of future skew', () => {
  const wrongDate = validReport();
  wrongDate.run.date = '2026-08-30';
  assert.throws(() => validateCompetitionReport(wrongDate), CompetitionReportError);

  const future = validReport();
  const started = new Date(Date.now() + 10 * 60 * 1_000);
  const finished = new Date(Date.now() + 11 * 60 * 1_000);
  future.run.started_at = started.toISOString();
  future.run.finished_at = finished.toISOString();
  future.run.date = new Date(started.getTime() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  assert.throws(() => validateCompetitionReport(future), CompetitionReportError);
});

test('source, candidate, verification, and application evidence cannot follow the report observation', () => {
  for (const mutate of [
    (report) => { report.sources[0].checked_at = '2100-01-01T00:00:00Z'; },
    (report) => { report.candidates[0].discovered_at = '2100-01-01T00:00:00Z'; },
    (report) => { report.candidates[0].official_verified_at = '2100-01-01T00:00:00Z'; },
    (report) => { report.applications[0].updated_at = '2100-01-01T00:00:00Z'; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.throws(() => validateCompetitionReport(report), CompetitionReportError);
  }

  const beforeDiscovery = validReport();
  beforeDiscovery.applications[0].updated_at = '2026-08-31T01:10:30+09:00';
  assert.throws(() => validateCompetitionReport(beforeDiscovery), CompetitionReportError);
});

test('reporter sends the exact body idempotency key with only the dedicated bearer token', async () => {
  const report = validReport();
  let request;
  const result = await sendCompetitionReport(report, {
    apiUrl: 'https://api.test/',
    token: 'dedicated-secret',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return response(201, acknowledgement(report));
    },
  });
  assert.equal(request.url, 'https://api.test/api/competitions/report');
  assert.equal(request.options.headers.authorization, 'Bearer dedicated-secret');
  assert.equal(request.options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), report);
  assert.equal(result.replayed, false);
  assert.doesNotMatch(JSON.stringify(result), /dedicated-secret/u);
});

test('reporter refuses to transmit a report containing the exact active ingest token', async () => {
  const report = validReport();
  const token = 'opaque-active-ingest-secret-123456789';
  report.candidates[0].organizer = token;
  let calls = 0;
  await assert.rejects(
    sendCompetitionReport(report, {
      apiUrl: 'https://api.test',
      token,
      fetchImpl: async () => {
        calls += 1;
        return response(201, acknowledgement(report));
      },
    }),
    (error) => error instanceof CompetitionReportError && error.code === 'forbidden_data',
  );
  assert.equal(calls, 0);
});

test('reporter refuses a fully percent-encoded active ingest token in any report string', async () => {
  const report = validReport();
  const token = 'opaque-active-ingest-value-123456789';
  const encodedToken = [...Buffer.from(token, 'utf8')]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
  report.candidates[0].official_url = `https://organizer.example/${encodedToken}/rules`;
  let calls = 0;
  await assert.rejects(
    sendCompetitionReport(report, {
      apiUrl: 'https://api.test',
      token,
      fetchImpl: async () => {
        calls += 1;
        return response(201, acknowledgement(report));
      },
    }),
    (error) => error instanceof CompetitionReportError && error.code === 'forbidden_data',
  );
  assert.equal(calls, 0);
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
    return response(replayed ? 200 : 201, acknowledgement(body, replayed));
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
    fetchImpl: async () => response(201, {
      ...acknowledgement(report),
      idempotency_key: 'competition-daily-other-001',
    }),
  }), /invalid acknowledgement/u);
});

test('acknowledgement status is bound to exact new and replay semantics', async () => {
  const report = validReport();
  for (const [status, replayed] of [[200, false], [201, true], [202, false]]) {
    await assert.rejects(
      sendCompetitionReport(report, {
        apiUrl: 'https://api.test',
        token: 'secret',
        fetchImpl: async () => response(status, acknowledgement(report, replayed)),
      }),
      (error) => error instanceof CompetitionReportError
        && error.code === 'invalid_acknowledgement',
    );
  }
});

test('reporter timeout and byte cap cover the acknowledgement body', async () => {
  const report = validReport();
  const stalled = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
  }), { status: 201, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    sendCompetitionReport(report, {
      apiUrl: 'https://api.test',
      token: 'dedicated-secret',
      timeoutMs: 1_000,
      fetchImpl: async () => stalled,
    }),
    (error) => error instanceof CompetitionReportError && error.code === 'timeout',
  );

  const oversized = new Response('x'.repeat(65_537), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(
    sendCompetitionReport(report, {
      apiUrl: 'https://api.test',
      token: 'dedicated-secret',
      fetchImpl: async () => oversized,
    }),
    (error) => error instanceof CompetitionReportError
      && error.code === 'invalid_acknowledgement',
  );
});
