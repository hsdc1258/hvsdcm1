import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  competitionEvidenceLedger,
  mergeCompetitionOfficialEvidence,
  parseCompetitionEvidenceArgs,
  runCompetitionEvidenceCli,
} from './competition-evidence.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, 'fixtures', 'competition-report.valid.json');

function unverifiedReport() {
  const report = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  report.candidates[0].official_url = null;
  report.candidates[0].official_verification = 'unverified';
  report.candidates[0].official_verified_at = null;
  report.candidates[0].acceptance = 'unknown';
  report.candidates[0].deadline_at = null;
  report.candidates[0].eligibility = 'unknown';
  report.candidates[0].rights_risk = 'unknown';
  report.candidates[0].submission_risk = 'unknown';
  report.candidates[0].status = 'verifying';
  report.applications = [];
  return report;
}

function evidence(overrides = {}) {
  return {
    version: 1,
    candidates: [{
      contest_id: 'organizer-2026-image',
      category: 'image',
      organizer: 'Verified Organizer',
      official_url: 'https://organizer.example/rules',
      verified_at: '2026-08-31T01:12:00+09:00',
      acceptance: 'open',
      deadline_at: '2026-09-03T15:00:00+09:00',
      eligibility: 'unknown',
      rights_risk: 'medium',
      submission_risk: 'medium',
      status: 'deferred',
      ...overrides,
    }],
  };
}

test('evidence report, input, and output paths are all distinct before any read or write', () => {
  for (const args of [
    ['--report', 'work/Report.JSON', '--evidence', 'work/evidence.json', '--out', 'WORK/report.json'],
    ['--report', 'work/report.json', '--evidence', 'work/Evidence.JSON', '--out', 'WORK/evidence.json'],
    ['--report', 'work/report.json', '--evidence', 'work/evidence.json', '--out', 'work/../work/report.json'],
    ['--report', 'work/report.json', '--evidence', 'work/evidence.json', '--out', 'work/merged.json', '--evidence-out', 'WORK/EVIDENCE.JSON'],
  ]) {
    assert.throws(() => parseCompetitionEvidenceArgs(args), /paths must differ/u);
  }

  let reads = 0;
  let writes = 0;
  const missing = () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  };
  const fsImpl = {
    realpathSync: missing,
    readFileSync: () => { reads += 1; throw new Error('must not read'); },
    writeFileSync: () => { writes += 1; throw new Error('must not write'); },
  };
  assert.throws(
    () => runCompetitionEvidenceCli([
      '--report', 'work/report.json',
      '--evidence', 'work/evidence.json',
      '--out', 'WORK/EVIDENCE.JSON',
    ], { fsImpl }),
    /paths must differ/u,
  );
  assert.deepEqual({ reads, writes }, { reads: 0, writes: 0 });
});

test('official evidence upgrades only the matching candidate and emits a fresh report identity', () => {
  const merged = mergeCompetitionOfficialEvidence(unverifiedReport(), evidence(), {
    finishedAt: '2026-08-31T01:15:00+09:00',
  });
  assert.equal(merged.run.id, 'competition-verified-20260830161500000');
  assert.equal(merged.idempotency_key, merged.run.id);
  assert.equal(merged.candidates[0].official_verification, 'verified');
  assert.equal(merged.candidates[0].organizer, 'Verified Organizer');
  assert.equal(merged.candidates[0].official_url, 'https://organizer.example/rules');
  assert.equal(merged.candidates[0].rights_risk, 'medium');
  assert.equal(merged.candidates[0].status, 'deferred');
  assert.equal(merged.applications.length, 0);
});

test('a merged report can regenerate the complete canonical official-evidence ledger', () => {
  const merged = mergeCompetitionOfficialEvidence(unverifiedReport(), evidence(), {
    finishedAt: '2026-08-31T01:15:00+09:00',
  });
  const ledger = competitionEvidenceLedger(merged);
  assert.deepEqual(ledger, evidence({
    verified_at: '2026-08-31T01:12:00+09:00',
  }));
});

test('the CLI writes a complete ledger containing carried and newly verified candidates', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'competition-evidence-'));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.match(path.basename(directory), /^competition-evidence-/u);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const reportPath = path.join(directory, 'report.json');
  const evidencePath = path.join(directory, 'evidence.json');
  const outPath = path.join(directory, 'merged.json');
  const ledgerPath = path.join(directory, 'ledger.json');
  const report = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const newCandidate = structuredClone(report.candidates[0]);
  newCandidate.contest_id = 'organizer-2026-second';
  newCandidate.title = 'Second Example Contest';
  newCandidate.official_url = null;
  newCandidate.official_verification = 'unverified';
  newCandidate.official_verified_at = null;
  newCandidate.acceptance = 'unknown';
  newCandidate.deadline_at = null;
  newCandidate.eligibility = 'unknown';
  newCandidate.rights_risk = 'unknown';
  newCandidate.submission_risk = 'unknown';
  newCandidate.status = 'verifying';
  report.candidates.push(newCandidate);
  report.sources[0].candidate_count = 2;
  fs.writeFileSync(reportPath, `${JSON.stringify(report)}\n`, 'utf8');
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence({
    contest_id: newCandidate.contest_id,
  }))}\n`, 'utf8');

  const result = runCompetitionEvidenceCli([
    '--report', reportPath,
    '--evidence', evidencePath,
    '--out', outPath,
    '--evidence-out', ledgerPath,
  ]);
  assert.equal(result.verified, 2);
  assert.equal(result.evidence_candidates, 2);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.deepEqual(ledger.candidates.map((candidate) => candidate.contest_id), [
    'organizer-2026-image',
    'organizer-2026-second',
  ]);
  assert.equal(JSON.parse(fs.readFileSync(outPath, 'utf8')).candidates.length, 2);
});

test('official evidence is exact, candidate-bound, and chronologically bound', () => {
  const report = unverifiedReport();
  assert.throws(
    () => mergeCompetitionOfficialEvidence(report, evidence({
      organizer: '주최 기관 - 공식 확인 필요',
    }), { finishedAt: '2026-08-31T01:15:00+09:00' }),
    /must identify the officially verified organizer/u,
  );
  assert.throws(
    () => mergeCompetitionOfficialEvidence(report, {
      ...evidence(),
      extra: true,
    }),
    /evidence\.extra is not allowed/u,
  );
  assert.throws(
    () => mergeCompetitionOfficialEvidence(report, evidence({ contest_id: 'missing-candidate' })),
    /does not match a reported candidate/u,
  );
  assert.throws(
    () => mergeCompetitionOfficialEvidence(report, evidence({ category: 'video' })),
    /does not match a reported candidate/u,
  );
  assert.throws(
    () => mergeCompetitionOfficialEvidence(report, evidence({
      verified_at: '2026-08-31T01:10:30+09:00',
    })),
    /precedes discovery/u,
  );
  assert.throws(
    () => mergeCompetitionOfficialEvidence(report, evidence({
      verified_at: '2026-08-31T01:16:00+09:00',
    }), { finishedAt: '2026-08-31T01:15:00+09:00' }),
    /follows the report observation/u,
  );
  assert.throws(
    () => mergeCompetitionOfficialEvidence(report, evidence({
      official_url: 'https://list.example/contests/123',
    }), { finishedAt: '2026-08-31T01:15:00+09:00' }),
    /must not point to a discovery listing origin/u,
  );
  assert.throws(
    () => mergeCompetitionOfficialEvidence(report, evidence({
      official_url: 'https://www.list.example/official-looking-rules',
    }), { finishedAt: '2026-08-31T01:15:00+09:00' }),
    /must not point to a discovery listing origin/u,
  );
  assert.throws(
    () => mergeCompetitionOfficialEvidence(report, evidence({
      official_url: 'https://rules.list.example/official-looking-rules',
    }), { finishedAt: '2026-08-31T01:15:00+09:00' }),
    /must not point to a discovery listing origin/u,
  );
  assert.throws(
    () => mergeCompetitionOfficialEvidence(report, evidence({
      official_url: 'https://list.example../official-looking-rules',
    }), { finishedAt: '2026-08-31T01:15:00+09:00' }),
    /must not point to a discovery listing origin/u,
  );
});

test('an active evidence result must satisfy the strict report invariants', () => {
  assert.throws(
    () => mergeCompetitionOfficialEvidence(unverifiedReport(), evidence({
      status: 'active',
      eligibility: 'unknown',
    }), { finishedAt: '2026-08-31T01:15:00+09:00' }),
    /cannot be active before official, eligibility, and acceptance verification/u,
  );
});

test('official evidence cannot roll back or rewrite an equally fresh verification', () => {
  const verified = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.throws(
    () => mergeCompetitionOfficialEvidence(verified, evidence({
      verified_at: '2026-08-31T01:11:30+09:00',
    }), { finishedAt: '2026-08-31T01:15:00+09:00' }),
    /older than existing official evidence/u,
  );
  assert.throws(
    () => mergeCompetitionOfficialEvidence(verified, evidence({
      organizer: 'Conflicting Organizer',
    }), { finishedAt: '2026-08-31T01:15:00+09:00' }),
    /conflicts with existing official evidence at the same time/u,
  );
});

test('official evidence cannot rewind the report observation time', () => {
  assert.throws(
    () => mergeCompetitionOfficialEvidence(unverifiedReport(), evidence({
      verified_at: '2026-08-31T01:13:00+09:00',
    }), { finishedAt: '2026-08-31T01:14:00+09:00' }),
    /precedes the current report observation/u,
  );
});

test('an official-source candidate may verify against its own official origin', () => {
  const report = unverifiedReport();
  report.sources[0].kind = 'official';
  const merged = mergeCompetitionOfficialEvidence(report, evidence({
    official_url: 'https://list.example/official/rules',
  }), { finishedAt: '2026-08-31T01:15:00+09:00' });
  assert.equal(merged.candidates[0].official_verification, 'verified');
});
