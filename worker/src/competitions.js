import { authenticate, isOwnerSession, json, sha256 } from './lib.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const MAX_REPORT_BYTES = 128_000;
const MAX_SOURCES = 32;
const MAX_CANDIDATES = 200;
const MAX_APPLICATIONS = 3;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CATEGORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const PROFILE_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/u;
const EXPLICIT_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const PHONE_PATTERN = /(?:^|[^\p{L}\p{N}])(?:\+?\d{1,3}[- .]?)?(?:\(?\d{2,4}\)?[- .])\d{3,4}[- .]\d{4}(?=$|[^\p{L}\p{N}])/u;
const SENSITIVE_QUERY_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'client_secret', 'authorization', 'auth',
  'session', 'api_key', 'secret', 'credential', 'signature', 'private_key', 'signing_key',
]);

const RUN_STATUSES = new Set(['running', 'complete', 'partial', 'failed']);
const SOURCE_KINDS = new Set(['listing', 'official', 'search']);
const SOURCE_STATUSES = new Set(['pending', 'ok', 'no_results', 'partial', 'failed']);
const SUCCESSFUL_SOURCE_STATUSES = new Set(['ok', 'no_results']);
const SOURCE_FAILURE_CODES = new Set([
  'none', 'timeout', 'http_403', 'http_404', 'rate_limited', 'network',
  'invalid_response', 'parse_error', 'unknown',
]);
const RECENCY_STATES = new Set(['new', 'recent', 'stale']);
const OFFICIAL_VERIFICATION_STATES = new Set(['verified', 'unverified', 'not_found', 'failed']);
const ACCEPTANCE_STATES = new Set(['open', 'closed', 'unknown']);
const ELIGIBILITY_STATES = new Set(['eligible', 'ineligible', 'unknown']);
const RISK_STATES = new Set(['unknown', 'low', 'medium', 'high', 'blocked']);
const CANDIDATE_STATES = new Set([
  'discovered', 'verifying', 'active', 'deferred', 'rejected', 'archived',
]);
const APPLICATION_STATES = new Set([
  'DISCOVERED',
  'SOURCE_VERIFIED',
  'ELIGIBLE',
  'PREPARED',
  'VALIDATED',
  'WAITING_DEADLINE_CLARIFICATION',
  'WAITING_IDENTITY',
  'WAITING_ELIGIBILITY',
  'WAITING_CLARIFICATION',
  'WAITING_ARTIFACTS',
  'WAITING_LEGAL_CONSENT',
  'WAITING_RIGHTS_APPROVAL',
  'WAITING_FEE_APPROVAL',
  'WAITING_APPROVAL',
  'AUTHORIZED',
  'SUBMITTING',
  'SUBMISSION_UNKNOWN',
]);
const APPLICATION_BLOCKERS = new Set([
  'none', 'official_verification', 'eligibility', 'deadline', 'rights', 'submission',
  'artifacts', 'account', 'consent', 'payment', 'user_approval', 'other',
]);
const APPLICATION_NEXT_ACTIONS = new Set([
  'none', 'verify_official_source', 'verify_eligibility', 'review_rights',
  'review_submission', 'prepare_artifacts', 'draft_application', 'stage_form',
  'request_approval', 'manual_check', 'hold',
]);

const FORBIDDEN_FIELD_PARTS = new Set([
  'pii', 'email', 'e_mail', 'phone', 'mobile', 'address', 'birth', 'birthday', 'dob',
  'legal_name', 'full_name', 'first_name', 'last_name', 'applicant_name', 'contact',
  'signature', 'consent', 'legal_consent', 'terms_acceptance', 'application_answer',
  'application_answers', 'answer', 'answers', 'essay', 'application_prose', 'payment',
  'card', 'bank', 'receipt', 'final_submission', 'submission', 'submission_payload',
  'account_token', 'cookie', 'password', 'private_key', 'signing_key', 'identity_document',
  'government_id', 'tax_id',
]);
const SAFE_SCHEMA_FIELDS = new Set([
  'version', 'idempotency_key', 'run', 'sources', 'candidates', 'applications',
  'id', 'date', 'started_at', 'finished_at', 'status', 'source_coverage',
  'expected', 'checked', 'succeeded', 'kind', 'name', 'reference_url', 'checked_at',
  'failure_code', 'manual_check', 'candidate_count', 'contest_id', 'category', 'title',
  'organizer', 'source_id', 'discovery_url', 'discovered_at', 'recency', 'official_url',
  'official_verification', 'official_verified_at', 'acceptance', 'deadline_at',
  'eligibility', 'rights_risk', 'submission_risk', 'fit_score', 'effort_score',
  'profile_id', 'state', 'blocker', 'next_action', 'updated_at',
]);

class ReportValidationError extends Error {
  constructor(code = 'invalid_report') {
    super(code);
    this.code = code;
  }
}

function fail(code = 'invalid_report') {
  throw new ReportValidationError(code);
}

function competitionJson(data, status = 200) {
  return json(data, status, { 'cache-control': 'no-store' });
}

function competitionError(error, status = 400) {
  return competitionJson({ error }, status);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function strictObject(value, keys) {
  if (!isObject(value)) fail();
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail();
  return value;
}

function forbiddenFieldName(key, { allowSafeSchema = true } = {}) {
  const normalized = String(key)
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replaceAll('-', '_')
    .toLowerCase();
  if (allowSafeSchema && SAFE_SCHEMA_FIELDS.has(normalized)) return false;
  if (FORBIDDEN_FIELD_PARTS.has(normalized)) return true;
  return [...FORBIDDEN_FIELD_PARTS].some((part) => normalized.startsWith(`${part}_`));
}

function containsForbiddenFields(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenFields);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    forbiddenFieldName(key) || containsForbiddenFields(child)
  ));
}

function bytes(value) {
  return encoder.encode(value).byteLength;
}

function canonicalRawJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalRawJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalRawJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasKoreanPhone(value) {
  for (const match of String(value).matchAll(
    /(?:^|[^\d])(\+?\d(?:[\p{P}\p{Z}\p{Cf}\p{S}\p{M}]*\d){8,12})(?!\d)/gu,
  )) {
    const digits = match[1].replace(/\D/gu, '');
    if (/^(?:010\d{8}|01[16789]\d{7,8}|02\d{7,8}|0(?:3[1-3]|4[1-4]|5[1-5]|6[1-4])\d{7,8}|8210\d{8}|822\d{7,8}|82(?:3[1-3]|4[1-4]|5[1-5]|6[1-4])\d{7,8})$/u.test(digits)) {
      return true;
    }
  }
  return false;
}

function privacyFold(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .normalize('NFKC');
}

function hasPrivateAssignment(value) {
  const text = privacyFold(value);
  for (const operator of text.matchAll(/[=:/]/gu)) {
    const before = text.slice(0, operator.index)
      .replace(/[^\p{L}\p{N}]/gu, '')
      .toLowerCase();
    const after = text.slice(operator.index + operator[0].length);
    if (!/^[^\p{L}\p{N}]*[\p{L}\p{N}]/u.test(after)) continue;
    if (/(?:token|secret|signature|credential|private(?:key)?|signingkey|authorization(?:code)?|authentication|oauth(?:code)?|session(?:id|key|token)?|api[_-]?key|access[_-]?key|auth(?:code|header|key|token)?)$/u.test(before)) {
      return true;
    }
    if ([...FORBIDDEN_FIELD_PARTS].some((part) => (
      before.endsWith(part.replaceAll('_', ''))
    ))) return true;
  }
  return false;
}

function hasPrivatePatternOnce(value) {
  return EMAIL_PATTERN.test(value)
    || PHONE_PATTERN.test(value)
    || hasKoreanPhone(value)
    || hasPrivateAssignment(value);
}

function hasPrivatePattern(value) {
  const normalized = String(value).normalize('NFKC');
  const folded = privacyFold(normalized);
  return hasPrivatePatternOnce(normalized)
    || (folded !== normalized && hasPrivatePatternOnce(folded));
}

function scanPrivateText(value) {
  let decoded = String(value).normalize('NFKC');
  for (let pass = 0; pass < 8; pass += 1) {
    if (hasPrivatePattern(decoded)) fail('forbidden_data');
    if (!/%[0-9A-F]{2}/iu.test(decoded)) return;
    let next;
    try { next = decodeURIComponent(decoded).normalize('NFKC'); } catch { fail('forbidden_data'); }
    if (next === decoded) return;
    decoded = next;
  }
  fail('forbidden_data');
}

function normalizedText(value, maxBytes, { privatePatterns = false } = {}) {
  if (typeof value !== 'string') fail();
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized || bytes(normalized) > maxBytes || /[\u0000-\u001f\u007f]/u.test(normalized)) fail();
  if (privatePatterns) scanPrivateText(normalized);
  return normalized;
}

function normalizedId(value, pattern = ID_PATTERN) {
  if (typeof value !== 'string' || value !== value.trim() || !pattern.test(value)) fail();
  scanPrivateText(value);
  return value;
}

function integerInRange(value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail();
  return value;
}

function normalizedDate(value) {
  if (typeof value !== 'string') fail();
  const match = value.match(DATE_PATTERN);
  if (!match) fail();
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 2000 || year > 2100) fail();
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (instant.getUTCFullYear() !== year
    || instant.getUTCMonth() !== month - 1
    || instant.getUTCDate() !== day) fail();
  return value;
}

function normalizedInstant(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') fail();
  const match = value.match(EXPLICIT_INSTANT_PATTERN);
  if (!match) fail();
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone,
    sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(fraction.padEnd(3, '0'));
  if (year < 2000 || year > 2100 || hour > 23 || minute > 59 || second > 59) fail();
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const local = new Date(localEpoch);
  if (local.getUTCFullYear() !== year
    || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day
    || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute
    || local.getUTCSeconds() !== second) fail();
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) fail();
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (sign === '+' ? 1 : -1);
  }
  return new Date(localEpoch - offsetMinutes * 60_000).toISOString();
}

function ipv4Octets(hostname) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return null;
  const octets = hostname.split('.').map(Number);
  return octets.every((part) => part >= 0 && part <= 255) ? octets : null;
}

function isNonPublicIpv4(octets) {
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isNonPublicIpv6(hostname) {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (!host.includes(':')) return false;
  return host === '::'
    || host === '::1'
    || host.startsWith('fc')
    || host.startsWith('fd')
    || /^fe[89abcdef]/u.test(host)
    || host.startsWith('ff')
    || host.startsWith('2001:db8:')
    || host.startsWith('::ffff:');
}

function normalizedSensitiveKey(value) {
  return String(value)
    .normalize('NFKC')
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
}

function isSensitiveQueryKey(value) {
  const normalized = normalizedSensitiveKey(value);
  const canonical = normalized.replaceAll('_', '');
  return SENSITIVE_QUERY_KEYS.has(normalized)
    || /(?:token|secret|signature|credential)/u.test(canonical)
    || canonical === 'auth'
    || /^(?:auth|authentication|authorization)(?:code|header|key|token)?$/u.test(canonical)
    || canonical.includes('authentication')
    || canonical.includes('authorization')
    || canonical.includes('oauth')
    || canonical.includes('session')
    || canonical.includes('apikey')
    || canonical.includes('accesskey')
    || canonical.includes('privatekey')
    || canonical.includes('signingkey');
}

function scanPrivateUrlComponent(value) {
  let decoded = String(value).normalize('NFKC');
  for (let pass = 0; pass < 8; pass += 1) {
    if (hasPrivatePattern(decoded)) fail('forbidden_data');
    let next;
    try { next = decodeURIComponent(decoded).normalize('NFKC'); } catch { fail(); }
    if (next === decoded) return decoded;
    decoded = next;
  }
  // Deeply nested encoding is unnecessary for a public reference and is unsafe to interpret
  // differently across the reporter, Worker, and UI.
  fail();
}

function normalizedPublicHttpsUrl(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value !== value.trim() || bytes(value) > 2_048) fail();
  const normalizedRaw = value.normalize('NFKC');
  scanPrivateUrlComponent(normalizedRaw);
  let url;
  try { url = new URL(normalizedRaw); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail();
  let hostname = url.hostname.toLowerCase();
  if (!hostname.includes(':')) {
    hostname = hostname.replace(/\.+$/u, '');
    if (!hostname) fail();
    url.hostname = hostname;
  }
  if (!hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || (!hostname.includes('.') && !hostname.includes(':'))) fail();
  const octets = ipv4Octets(hostname);
  if ((octets && isNonPublicIpv4(octets)) || isNonPublicIpv6(hostname)) fail();
  for (const [key, queryValue] of url.searchParams) {
    const decodedKey = scanPrivateUrlComponent(key);
    scanPrivateUrlComponent(queryValue);
    if (forbiddenFieldName(decodedKey, { allowSafeSchema: false })
      || isSensitiveQueryKey(decodedKey)) {
      fail('forbidden_data');
    }
  }
  return url.href;
}

function enumValue(value, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) fail();
  return value;
}

function kstDate(instant) {
  return new Date(Date.parse(instant) + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function normalizeRun(input) {
  strictObject(input, [
    'id', 'date', 'started_at', 'finished_at', 'status', 'source_coverage',
  ]);
  const coverage = strictObject(input.source_coverage, ['expected', 'checked', 'succeeded']);
  const run = {
    id: normalizedId(input.id),
    date: normalizedDate(input.date),
    started_at: normalizedInstant(input.started_at),
    finished_at: normalizedInstant(input.finished_at, true),
    status: enumValue(input.status, RUN_STATUSES),
    source_coverage: {
      expected: integerInRange(coverage.expected, 1, MAX_SOURCES),
      checked: integerInRange(coverage.checked, 0, MAX_SOURCES),
      succeeded: integerInRange(coverage.succeeded, 0, MAX_SOURCES),
    },
  };
  if (run.source_coverage.checked > run.source_coverage.expected
    || run.source_coverage.succeeded > run.source_coverage.checked) fail();
  if ((run.status === 'running') !== (run.finished_at === null)) fail();
  if (run.finished_at && Date.parse(run.finished_at) < Date.parse(run.started_at)) fail();
  if (run.date !== kstDate(run.started_at)) fail();
  const observationAt = run.finished_at || run.started_at;
  if (Date.parse(observationAt) > Date.now() + MAX_FUTURE_SKEW_MS) fail();
  return run;
}

function normalizeSource(input) {
  strictObject(input, [
    'id', 'kind', 'name', 'reference_url', 'checked_at', 'status', 'failure_code',
    'manual_check', 'candidate_count',
  ]);
  const source = {
    id: normalizedId(input.id),
    kind: enumValue(input.kind, SOURCE_KINDS),
    name: normalizedText(input.name, 240, { privatePatterns: true }),
    reference_url: normalizedPublicHttpsUrl(input.reference_url),
    checked_at: normalizedInstant(input.checked_at),
    status: enumValue(input.status, SOURCE_STATUSES),
    failure_code: enumValue(input.failure_code, SOURCE_FAILURE_CODES),
    manual_check: input.manual_check,
    candidate_count: integerInRange(input.candidate_count, 0, MAX_CANDIDATES),
  };
  if (typeof source.manual_check !== 'boolean') fail();
  const failed = source.status === 'failed' || source.status === 'partial';
  if (failed !== (source.failure_code !== 'none')) fail();
  if (['timeout', 'http_403'].includes(source.failure_code) && !source.manual_check) fail();
  if (['pending', 'no_results', 'failed'].includes(source.status) && source.candidate_count > 0) fail();
  return source;
}

function normalizeCandidate(input) {
  strictObject(input, [
    'contest_id', 'category', 'title', 'organizer', 'source_id', 'discovery_url',
    'discovered_at', 'recency', 'official_url', 'official_verification',
    'official_verified_at', 'acceptance', 'deadline_at', 'eligibility', 'rights_risk',
    'submission_risk', 'status', 'fit_score', 'effort_score',
  ]);
  const candidate = {
    contest_id: normalizedId(input.contest_id),
    category: normalizedId(input.category, CATEGORY_PATTERN),
    title: normalizedText(input.title, 240, { privatePatterns: true }),
    organizer: normalizedText(input.organizer, 160, { privatePatterns: true }),
    source_id: normalizedId(input.source_id),
    discovery_url: normalizedPublicHttpsUrl(input.discovery_url),
    discovered_at: normalizedInstant(input.discovered_at),
    recency: enumValue(input.recency, RECENCY_STATES),
    official_url: normalizedPublicHttpsUrl(input.official_url, true),
    official_verification: enumValue(input.official_verification, OFFICIAL_VERIFICATION_STATES),
    official_verified_at: normalizedInstant(input.official_verified_at, true),
    acceptance: enumValue(input.acceptance, ACCEPTANCE_STATES),
    deadline_at: normalizedInstant(input.deadline_at, true),
    eligibility: enumValue(input.eligibility, ELIGIBILITY_STATES),
    rights_risk: enumValue(input.rights_risk, RISK_STATES),
    submission_risk: enumValue(input.submission_risk, RISK_STATES),
    status: enumValue(input.status, CANDIDATE_STATES),
    fit_score: integerInRange(input.fit_score, 0, 100),
    effort_score: integerInRange(input.effort_score, 0, 100),
  };
  const verified = candidate.official_verification === 'verified';
  if (verified !== Boolean(candidate.official_url && candidate.official_verified_at)) fail();
  if (candidate.official_verified_at
    && Date.parse(candidate.official_verified_at) < Date.parse(candidate.discovered_at)) fail();
  if (candidate.status === 'active'
    && (!verified || candidate.eligibility !== 'eligible'
      || candidate.acceptance !== 'open' || !candidate.deadline_at
      || candidate.rights_risk === 'blocked' || candidate.submission_risk === 'blocked')) fail();
  return candidate;
}

function normalizeApplication(input) {
  strictObject(input, [
    'contest_id', 'category', 'profile_id', 'state', 'blocker', 'next_action', 'updated_at',
  ]);
  if (typeof input.profile_id !== 'string' || !PROFILE_PATTERN.test(input.profile_id)) fail();
  return {
    contest_id: normalizedId(input.contest_id),
    category: normalizedId(input.category, CATEGORY_PATTERN),
    profile_id: input.profile_id,
    state: enumValue(input.state, APPLICATION_STATES),
    blocker: enumValue(input.blocker, APPLICATION_BLOCKERS),
    next_action: enumValue(input.next_action, APPLICATION_NEXT_ACTIONS),
    updated_at: normalizedInstant(input.updated_at),
  };
}

function normalizeReport(input) {
  if (containsForbiddenFields(input)) fail('forbidden_data');
  strictObject(input, ['version', 'idempotency_key', 'run', 'sources', 'candidates', 'applications']);
  if (input.version !== 1) fail();
  if (!Array.isArray(input.sources)
    || input.sources.length < 1
    || input.sources.length > MAX_SOURCES
    || !Array.isArray(input.candidates)
    || input.candidates.length > MAX_CANDIDATES
    || !Array.isArray(input.applications)
    || input.applications.length > MAX_APPLICATIONS) fail();

  const report = {
    version: 1,
    idempotency_key: normalizedId(input.idempotency_key),
    run: normalizeRun(input.run),
    sources: input.sources.map(normalizeSource),
    candidates: input.candidates.map(normalizeCandidate),
    applications: input.applications.map(normalizeApplication),
  };
  const sourceIds = new Set(report.sources.map((source) => source.id));
  if (sourceIds.size !== report.sources.length) fail();
  if (report.run.source_coverage.expected !== report.sources.length) fail();
  const checked = report.sources.filter((source) => source.status !== 'pending').length;
  const succeeded = report.sources.filter((source) => SUCCESSFUL_SOURCE_STATUSES.has(source.status)).length;
  if (report.run.source_coverage.checked !== checked
    || report.run.source_coverage.succeeded !== succeeded
    || (report.run.status === 'complete' && checked !== report.sources.length)) fail();

  const candidateKeys = new Set();
  const candidates = new Map();
  const sources = new Map(report.sources.map((source) => [source.id, source]));
  const candidateCountBySource = new Map(report.sources.map((source) => [source.id, 0]));
  const observationAt = report.run.finished_at || report.run.started_at;
  const observationTime = Date.parse(observationAt);
  for (const source of report.sources) {
    if (Date.parse(source.checked_at) > observationTime) fail();
  }
  for (const candidate of report.candidates) {
    if (!sourceIds.has(candidate.source_id)) fail();
    const key = `${candidate.contest_id}|${candidate.category}`;
    if (candidateKeys.has(key)) fail();
    candidateKeys.add(key);
    candidates.set(key, candidate);
    candidateCountBySource.set(candidate.source_id, candidateCountBySource.get(candidate.source_id) + 1);
    const source = sources.get(candidate.source_id);
    if (Date.parse(candidate.discovered_at) > observationTime
      || (candidate.official_verified_at
        && Date.parse(candidate.official_verified_at) > observationTime)) fail();
    if (candidate.status === 'active'
      && Date.parse(candidate.deadline_at) <= observationTime) fail();
    if (['timeout', 'http_403'].includes(source.failure_code)
      && candidate.acceptance === 'closed') fail();
  }
  for (const source of report.sources) {
    if (source.candidate_count !== candidateCountBySource.get(source.id)) fail();
  }

  const applicationKeys = new Set();
  for (const application of report.applications) {
    const candidate = candidates.get(`${application.contest_id}|${application.category}`);
    const key = `${application.contest_id}|${application.category}`;
    if (!candidate || applicationKeys.has(key)) fail();
    applicationKeys.add(key);
    if (Date.parse(application.updated_at) > observationTime
      || Date.parse(application.updated_at) < Date.parse(candidate.discovered_at)) fail();
    if (candidate.official_verification !== 'verified'
      || candidate.eligibility !== 'eligible'
      || candidate.acceptance !== 'open'
      || !candidate.deadline_at
      || candidate.rights_risk === 'blocked'
      || candidate.submission_risk === 'blocked'
      || candidate.status !== 'active'
      || Date.parse(candidate.deadline_at) <= observationTime) fail();
  }
  return report;
}

async function tokenMatches(request, expectedValue) {
  const authorization = request.headers.get('authorization') || '';
  const supplied = authorization.match(/^Bearer\s+(.+)$/iu)?.[1] || '';
  const expected = String(expectedValue || '');
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  let difference = 0;
  const left = new Uint8Array(suppliedHash);
  const right = new Uint8Array(expectedHash);
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return Boolean(supplied && expected && difference === 0);
}

async function readCompetitionJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    return { response: competitionError('invalid_json') };
  }
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REPORT_BYTES) {
    return { response: competitionError('report_too_large', 413) };
  }
  if (!request.body) return { response: competitionError('invalid_json') };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REPORT_BYTES) {
        try { await reader.cancel(); } catch { /* The bounded response remains authoritative. */ }
        return { response: competitionError('report_too_large', 413) };
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(decoder.decode(body)) };
  } catch {
    return { response: competitionError('invalid_json') };
  }
}

function resultChanges(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function acceptedResponse(report, replayed, status = 200) {
  return competitionJson({
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
  }, status);
}

function acceptedStoredResponse(row, replayed = true) {
  return competitionJson({
    ok: true,
    version: 1,
    idempotency_key: row.idempotency_key,
    run_id: row.run_id,
    replayed,
    counts: {
      sources: Number(row.source_count),
      candidates: Number(row.candidate_count),
      applications: Number(row.application_count),
    },
  });
}

async function reportCompetitionsInternal(request, env) {
  if (!(await tokenMatches(request, env.COMPETITION_INGEST_TOKEN))) {
    return competitionJson({ error: '인증이 필요합니다.' }, 401);
  }
  const parsed = await readCompetitionJson(request);
  if (parsed.response) return parsed.response;
  let report;
  try {
    report = normalizeReport(parsed.value);
  } catch (error) {
    if (error instanceof ReportValidationError) return competitionError(error.code);
    throw error;
  }
  // Idempotency binds one key to the caller's exact field values. Object key order is irrelevant,
  // but storage normalization (for example, collapsing repeated spaces) must not turn different
  // report content into an acknowledged replay.
  const payloadHash = await sha256(canonicalRawJson(parsed.value));
  const existing = await env.DB.prepare(`
    SELECT idempotency_key, payload_hash, run_id, source_count, candidate_count, application_count
    FROM competition_reports
    WHERE idempotency_key = ?1
  `).bind(report.idempotency_key).first();
  if (existing) {
    return existing.payload_hash === payloadHash
      ? acceptedStoredResponse(existing)
      : competitionError('idempotency_conflict', 409);
  }

  const receivedAt = new Date().toISOString();
  const statements = [
    env.DB.prepare(`
      INSERT INTO competition_reports(
        idempotency_key, payload_hash, schema_version, received_at,
        run_id, run_date, run_status, started_at, finished_at,
        coverage_expected, coverage_checked, coverage_succeeded,
        source_count, candidate_count, application_count
      ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).bind(
      report.idempotency_key,
      payloadHash,
      receivedAt,
      report.run.id,
      report.run.date,
      report.run.status,
      report.run.started_at,
      report.run.finished_at,
      report.run.source_coverage.expected,
      report.run.source_coverage.checked,
      report.run.source_coverage.succeeded,
      report.sources.length,
      report.candidates.length,
      report.applications.length,
    ),
    env.DB.prepare(`
      INSERT INTO competition_sources(
        idempotency_key, source_id, kind, name, reference_url,
        checked_at, status, failure_code, manual_check, candidate_count
      )
      SELECT ?1,
        json_extract(item.value, '$.id'), json_extract(item.value, '$.kind'),
        json_extract(item.value, '$.name'), json_extract(item.value, '$.reference_url'),
        json_extract(item.value, '$.checked_at'), json_extract(item.value, '$.status'),
        json_extract(item.value, '$.failure_code'), json_extract(item.value, '$.manual_check'),
        json_extract(item.value, '$.candidate_count')
      FROM json_each(?3) AS item
      WHERE EXISTS (
        SELECT 1 FROM competition_reports
        WHERE idempotency_key = ?1 AND payload_hash = ?2
      ) AND NOT EXISTS (
        SELECT 1 FROM competition_sources AS stored
        WHERE stored.idempotency_key = ?1
          AND stored.source_id = json_extract(item.value, '$.id')
      )
      ON CONFLICT(idempotency_key, source_id) DO NOTHING
    `).bind(report.idempotency_key, payloadHash, JSON.stringify(report.sources)),
    env.DB.prepare(`
      INSERT INTO competition_candidates(
        idempotency_key, contest_id, category, title, organizer, source_id,
        discovery_url, discovered_at, recency, official_url, official_verification,
        official_verified_at, acceptance, deadline_at, eligibility, rights_risk,
        submission_risk, status, fit_score, effort_score
      )
      SELECT ?1,
        json_extract(item.value, '$.contest_id'), json_extract(item.value, '$.category'),
        json_extract(item.value, '$.title'), json_extract(item.value, '$.organizer'),
        json_extract(item.value, '$.source_id'), json_extract(item.value, '$.discovery_url'),
        json_extract(item.value, '$.discovered_at'), json_extract(item.value, '$.recency'),
        json_extract(item.value, '$.official_url'),
        json_extract(item.value, '$.official_verification'),
        json_extract(item.value, '$.official_verified_at'),
        json_extract(item.value, '$.acceptance'), json_extract(item.value, '$.deadline_at'),
        json_extract(item.value, '$.eligibility'), json_extract(item.value, '$.rights_risk'),
        json_extract(item.value, '$.submission_risk'), json_extract(item.value, '$.status'),
        json_extract(item.value, '$.fit_score'), json_extract(item.value, '$.effort_score')
      FROM json_each(?3) AS item
      WHERE EXISTS (
        SELECT 1 FROM competition_reports
        WHERE idempotency_key = ?1 AND payload_hash = ?2
      ) AND NOT EXISTS (
        SELECT 1 FROM competition_candidates AS stored
        WHERE stored.idempotency_key = ?1
          AND stored.contest_id = json_extract(item.value, '$.contest_id')
          AND stored.category = json_extract(item.value, '$.category')
      )
      ON CONFLICT(idempotency_key, contest_id, category) DO NOTHING
    `).bind(report.idempotency_key, payloadHash, JSON.stringify(report.candidates)),
    env.DB.prepare(`
      INSERT INTO competition_applications(
        idempotency_key, contest_id, category, profile_id, state, blocker, next_action, updated_at
      )
      SELECT ?1,
        json_extract(item.value, '$.contest_id'), json_extract(item.value, '$.category'),
        json_extract(item.value, '$.profile_id'), json_extract(item.value, '$.state'),
        json_extract(item.value, '$.blocker'), json_extract(item.value, '$.next_action'),
        json_extract(item.value, '$.updated_at')
      FROM json_each(?3) AS item
      WHERE EXISTS (
        SELECT 1 FROM competition_reports
        WHERE idempotency_key = ?1 AND payload_hash = ?2
      ) AND NOT EXISTS (
        SELECT 1 FROM competition_applications AS stored
        WHERE stored.idempotency_key = ?1
          AND stored.contest_id = json_extract(item.value, '$.contest_id')
          AND stored.category = json_extract(item.value, '$.category')
          AND stored.profile_id = json_extract(item.value, '$.profile_id')
      )
      ON CONFLICT(idempotency_key, contest_id, category, profile_id) DO NOTHING
    `).bind(report.idempotency_key, payloadHash, JSON.stringify(report.applications)),
  ];
  const results = await env.DB.batch(statements);
  if (resultChanges(results[0]) === 1) return acceptedResponse(report, false, 201);

  const raced = await env.DB.prepare(`
    SELECT idempotency_key, payload_hash, run_id, source_count, candidate_count, application_count
    FROM competition_reports
    WHERE idempotency_key = ?1
  `).bind(report.idempotency_key).first();
  if (raced?.payload_hash === payloadHash) return acceptedStoredResponse(raced);
  return competitionError('idempotency_conflict', 409);
}

export async function reportCompetitions(request, env) {
  try {
    return await reportCompetitionsInternal(request, env);
  } catch (error) {
    console.error('competition_request_error', error);
    return competitionJson({ error: '서버 오류' }, 500);
  }
}

function serializeRun(row) {
  return {
    id: row.run_id,
    date: row.run_date,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.run_status,
    source_coverage: {
      expected: Number(row.coverage_expected),
      checked: Number(row.coverage_checked),
      succeeded: Number(row.coverage_succeeded),
    },
  };
}

function emptyCompetitionResponse() {
  return {
    summary: {
      latest_scan_at: null,
      partial: false,
      today: {
        discovered: 0,
        verified: 0,
        ready: 0,
        awaiting_approval: 0,
        deadline_soon: 0,
      },
    },
    runs: [],
    sources: [],
    candidates: [],
    applications: [],
  };
}

async function getCompetitionsInternal(request, env) {
  const session = await authenticate(request, env);
  if (!session) return competitionJson({ error: '로그인이 필요합니다.' }, 401);
  if (!isOwnerSession(session, env)) return competitionJson({ error: 'Not found' }, 404);

  const reportRows = await env.DB.prepare(`
    SELECT *
    FROM (
      SELECT competition_reports.*,
        ROW_NUMBER() OVER (
          PARTITION BY run_id
          ORDER BY COALESCE(finished_at, started_at) DESC,
            received_at DESC, idempotency_key DESC
        ) AS run_rank
      FROM competition_reports
    )
    WHERE run_rank = 1
    ORDER BY COALESCE(finished_at, started_at) DESC,
      received_at DESC, idempotency_key DESC
    LIMIT 31
  `).all();
  const reports = reportRows.results || [];
  if (reports.length === 0) return competitionJson(emptyCompetitionResponse());
  const latest = reports[0];
  const [sourceRows, candidateRows, applicationRows] = await Promise.all([
    env.DB.prepare(`
      SELECT * FROM competition_sources
      WHERE idempotency_key = ?1
      ORDER BY source_id
    `).bind(latest.idempotency_key).all(),
    env.DB.prepare(`
      SELECT * FROM competition_candidates
      WHERE idempotency_key = ?1
      ORDER BY CASE WHEN deadline_at IS NULL THEN 1 ELSE 0 END, deadline_at, contest_id, category
    `).bind(latest.idempotency_key).all(),
    env.DB.prepare(`
      SELECT * FROM competition_applications
      WHERE idempotency_key = ?1
      ORDER BY updated_at DESC, contest_id, category
    `).bind(latest.idempotency_key).all(),
  ]);
  const sources = (sourceRows.results || []).map((row) => ({
    id: row.source_id,
    kind: row.kind,
    name: row.name,
    reference_url: row.reference_url,
    status: row.status,
    checked_at: row.checked_at,
    candidate_count: Number(row.candidate_count),
    failure_code: row.failure_code,
    manual_check: Boolean(row.manual_check),
  }));
  const candidates = (candidateRows.results || []).map((row) => ({
    contest_id: row.contest_id,
    category: row.category,
    title: row.title,
    organizer: row.organizer,
    source_id: row.source_id,
    discovery_url: row.discovery_url,
    discovered_at: row.discovered_at,
    recency: row.recency,
    official_url: row.official_url,
    official_verification: row.official_verification,
    official_verified_at: row.official_verified_at,
    acceptance: row.acceptance,
    deadline_at: row.deadline_at,
    eligibility: row.eligibility,
    status: row.status,
    rights_risk: row.rights_risk,
    submission_risk: row.submission_risk,
    fit_score: Number(row.fit_score),
    effort_score: Number(row.effort_score),
  }));
  const applications = (applicationRows.results || []).map((row) => ({
    contest_id: row.contest_id,
    category: row.category,
    state: row.state,
    updated_at: row.updated_at,
    blocker: row.blocker,
    next_action: row.next_action,
  }));
  const latestScanAt = latest.finished_at || latest.started_at;
  const latestScanTime = Date.parse(latestScanAt);
  const deadlineSoonLimit = latestScanTime + 7 * 86_400_000;
  const isToday = latest.run_date === kstDate(new Date().toISOString());
  const today = isToday
    ? {
      discovered: (candidateRows.results || []).filter((row) => row.recency === 'new').length,
      verified: candidates.filter((candidate) => candidate.official_verification === 'verified').length,
      ready: candidates.filter((candidate) => candidate.status === 'active').length,
      awaiting_approval: applications.filter((application) => (
        application.state === 'WAITING_APPROVAL'
      )).length,
      deadline_soon: candidates.filter((candidate) => {
        const deadline = Date.parse(candidate.deadline_at || '');
        return candidate.acceptance === 'open'
          && Number.isFinite(deadline)
          && deadline > latestScanTime
          && deadline <= deadlineSoonLimit;
      }).length,
    }
    : emptyCompetitionResponse().summary.today;
  return competitionJson({
    summary: {
      latest_scan_at: latestScanAt,
      partial: latest.run_status !== 'complete'
        || sources.some((source) => source.status === 'partial' || source.status === 'failed'),
      today,
    },
    runs: reports.map(serializeRun),
    sources,
    candidates,
    applications,
  });
}

export async function getCompetitions(request, env) {
  try {
    return await getCompetitionsInternal(request, env);
  } catch (error) {
    console.error('competition_request_error', error);
    return competitionJson({ error: '서버 오류' }, 500);
  }
}
