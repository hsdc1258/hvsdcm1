import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_REPORT_BYTES,
  MAX_COMPETITION_CANDIDATES,
  isCompetitionPlaceholderOrganizer,
  readCompetitionReport,
  validateCompetitionReport,
} from './competition-report.mjs';
import { requireCompetitionDistinctPaths } from './competition-paths.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const ACCEPTANCE = new Set(['open', 'closed', 'unknown']);
const ELIGIBILITY = new Set(['eligible', 'ineligible', 'unknown']);
const RISK = new Set(['unknown', 'low', 'medium', 'high', 'blocked']);
const STATUS = new Set(['verifying', 'active', 'deferred', 'rejected', 'archived']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

function exactKeys(value, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object');
  }
  const expected = new Set(required);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(label + '.' + key + ' is not allowed');
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(label + '.' + key + ' is required');
    }
  }
}

function enumValue(value, values, label) {
  if (!values.has(value)) throw new Error(label + ' has an unsupported value');
  return value;
}

function offsetTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error(label + ' must be an offset timestamp');
  }
  return value;
}

function readBoundedJson(file, fsImpl = fs) {
  const fullPath = path.resolve(file);
  const stat = fsImpl.statSync(fullPath);
  if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) {
    throw new Error('evidence must be a bounded JSON file');
  }
  return JSON.parse(fsImpl.readFileSync(fullPath, 'utf8').replace(/^\uFEFF/u, ''));
}

function canonicalPublicHost(value) {
  return new URL(value).hostname.toLowerCase().replace(/\.+$/u, '').replace(/^www\d*\./u, '');
}

function matchesListingHost(host, listingHosts) {
  return [...listingHosts].some((listingHost) => host === listingHost
    || host.endsWith('.' + listingHost)
    || listingHost.endsWith('.' + host));
}

export function mergeCompetitionOfficialEvidence(report, evidence, options = {}) {
  validateCompetitionReport(report);
  exactKeys(evidence, ['version', 'candidates'], 'evidence');
  if (evidence.version !== 1 || !Array.isArray(evidence.candidates)
    || evidence.candidates.length > MAX_COMPETITION_CANDIDATES) {
    throw new Error('evidence must be version 1 with at most 500 candidates');
  }
  const output = structuredClone(report);
  const candidateByKey = new Map(output.candidates.map((candidate) => [
    candidate.contest_id + '|' + candidate.category,
    candidate,
  ]));
  const listingHosts = new Set(output.sources
    .filter((source) => source.kind === 'listing')
    .map((source) => canonicalPublicHost(source.reference_url)));
  for (const candidate of output.candidates) {
    const source = output.sources.find((item) => item.id === candidate.source_id);
    if (source?.kind === 'listing') listingHosts.add(canonicalPublicHost(candidate.discovery_url));
  }
  const seen = new Set();
  for (let index = 0; index < evidence.candidates.length; index += 1) {
    const entry = evidence.candidates[index];
    const label = 'evidence.candidates[' + index + ']';
    exactKeys(entry, [
      'contest_id',
      'category',
      'organizer',
      'official_url',
      'verified_at',
      'acceptance',
      'deadline_at',
      'eligibility',
      'rights_risk',
      'submission_risk',
      'status',
    ], label);
    if (typeof entry.contest_id !== 'string' || !IDENTIFIER.test(entry.contest_id)) {
      throw new Error(label + '.contest_id has an invalid format');
    }
    if (typeof entry.category !== 'string' || !IDENTIFIER.test(entry.category)) {
      throw new Error(label + '.category has an invalid format');
    }
    const candidateKey = entry.contest_id + '|' + entry.category;
    if (seen.has(candidateKey)) throw new Error(label + ' candidate key is duplicated');
    seen.add(candidateKey);
    const candidate = candidateByKey.get(candidateKey);
    if (!candidate) throw new Error(label + ' does not match a reported candidate');
    if (isCompetitionPlaceholderOrganizer(entry.organizer)) {
      throw new Error(label + '.organizer must identify the officially verified organizer');
    }
    offsetTimestamp(entry.verified_at, label + '.verified_at');
    if (Date.parse(entry.verified_at) < Date.parse(candidate.discovered_at)) {
      throw new Error(label + '.verified_at precedes discovery');
    }
    if (candidate.official_verified_at) {
      const incomingTime = Date.parse(entry.verified_at);
      const existingTime = Date.parse(candidate.official_verified_at);
      if (incomingTime < existingTime) {
        throw new Error(label + '.verified_at is older than existing official evidence');
      }
      const sameEvidence = candidate.organizer === entry.organizer
        && candidate.official_url === entry.official_url
        && candidate.acceptance === entry.acceptance
        && candidate.deadline_at === entry.deadline_at
        && candidate.eligibility === entry.eligibility
        && candidate.rights_risk === entry.rights_risk
        && candidate.submission_risk === entry.submission_risk
        && candidate.status === entry.status;
      if (incomingTime === existingTime && !sameEvidence) {
        throw new Error(label + ' conflicts with existing official evidence at the same time');
      }
    }
    let officialHost;
    try {
      officialHost = canonicalPublicHost(entry.official_url);
    } catch {
      throw new Error(label + '.official_url is invalid');
    }
    if (matchesListingHost(officialHost, listingHosts)) {
      throw new Error(label + '.official_url must not point to a discovery listing origin');
    }
    if (entry.deadline_at !== null) offsetTimestamp(entry.deadline_at, label + '.deadline_at');
    candidate.organizer = entry.organizer;
    candidate.official_url = entry.official_url;
    candidate.official_verification = 'verified';
    candidate.official_verified_at = entry.verified_at;
    candidate.acceptance = enumValue(entry.acceptance, ACCEPTANCE, label + '.acceptance');
    candidate.deadline_at = entry.deadline_at;
    candidate.eligibility = enumValue(entry.eligibility, ELIGIBILITY, label + '.eligibility');
    candidate.rights_risk = enumValue(entry.rights_risk, RISK, label + '.rights_risk');
    candidate.submission_risk = enumValue(
      entry.submission_risk,
      RISK,
      label + '.submission_risk',
    );
    candidate.status = enumValue(entry.status, STATUS, label + '.status');
  }

  const finishedAt = options.finishedAt || new Date().toISOString();
  offsetTimestamp(finishedAt, 'finishedAt');
  const priorObservation = output.run.finished_at || output.run.started_at;
  if (Date.parse(finishedAt) < Date.parse(priorObservation)) {
    throw new Error('finishedAt precedes the current report observation');
  }
  for (const entry of evidence.candidates) {
    if (Date.parse(entry.verified_at) > Date.parse(finishedAt)) {
      throw new Error('evidence verification follows the report observation');
    }
  }
  const suffix = new Date(finishedAt).toISOString().replace(/\D/gu, '').slice(0, 17);
  output.run.id = 'competition-verified-' + suffix;
  output.idempotency_key = 'competition-verified-' + suffix;
  output.run.finished_at = finishedAt;
  return validateCompetitionReport(output);
}

function atomicWrite(file, value, fsImpl = fs) {
  const fullPath = path.resolve(file);
  fsImpl.mkdirSync(path.dirname(fullPath), { recursive: true });
  const temporary = fullPath + '.' + process.pid + '.tmp';
  fsImpl.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  fsImpl.renameSync(temporary, fullPath);
}

export function parseCompetitionEvidenceArgs(argv, parseOptions = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--report', '--evidence', '--out'].includes(argument)) {
      throw new Error('unknown argument: ' + argument);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value');
    index += 1;
    if (argument === '--report') options.report = value;
    else if (argument === '--evidence') options.evidence = value;
    else options.out = value;
  }
  if (!options.report || !options.evidence || !options.out) {
    throw new Error('--report, --evidence, and --out are required');
  }
  requireCompetitionDistinctPaths([
    ['--report', options.report],
    ['--evidence', options.evidence],
    ['--out', options.out],
  ], { fsImpl: parseOptions.fsImpl || fs, label: 'competition evidence' });
  return options;
}

export function runCompetitionEvidenceCli(argv, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const args = parseCompetitionEvidenceArgs(argv, { fsImpl });
  const report = readCompetitionReport(args.report, { fsImpl });
  const evidence = readBoundedJson(args.evidence, fsImpl);
  const merged = mergeCompetitionOfficialEvidence(report, evidence);
  atomicWrite(args.out, merged, fsImpl);
  return {
    ok: true,
    run_id: merged.run.id,
    candidates: merged.candidates.length,
    verified: merged.candidates.filter(
      (candidate) => candidate.official_verification === 'verified',
    ).length,
  };
}

function main() {
  try {
    const result = runCompetitionEvidenceCli(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write(
      '[competition-evidence] ' + (error?.message || 'unexpected evidence failure') + '\n',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) main();
