import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_REPORT_BYTES = 1_000_000;
export const MAX_COMPETITION_CANDIDATES = 500;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_ACKNOWLEDGEMENT_BYTES = 65_536;

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const APPROVAL_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const CATEGORY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const PROFILE_ID = /^hmac-sha256:[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OFFSET_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const PHONE = /(?:^|[^\p{L}\p{N}])(?:\+?\d{1,3}[- .]?)?(?:\(?\d{2,4}\)?[- .])\d{3,4}[- .]\d{4}(?=$|[^\p{L}\p{N}])/u;
const KOREAN_RESIDENT_ID = /(?:^|[^\d])\d{6}[- ]?[1-8]\d{6}(?!\d)/u;
const LABELED_IDENTITY = /(?:applicant(?:[_. -]?name)?|지원자|신청자|성명)\s*[:=]\s*\S+/iu;
const LABELED_IDENTITY_TEXT = /(?:(?:지원자|신청자)\s+(?!(?:누구나|모두|전원)(?:\s|$))[가-힣]{2,4}(?:의|님|씨)|(?:성명|주소|address)\s+(?!(?:미정|없음)(?:\s|$))\S+)/iu;
const STANDALONE_CREDENTIAL = /(?:bearer\s+[A-Z0-9._~+/-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|mfa\.[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/iu;
const RAW_MARKUP = /(?:<\/?[A-Za-z][^>]*>|<!--|<!DOCTYPE)/iu;
const SENSITIVE_QUERY_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'client_secret', 'authorization', 'auth',
  'session', 'api_key', 'secret', 'credential', 'signature', 'private_key', 'signing_key',
]);

const FORBIDDEN_KEYS = /(?:^|_)(?:pii|applicant_name|legal_name|full_name|first_name|last_name|email|e_mail|phone|mobile|contact|address|birth|birthday|dob|password|private_key|signing_key|account_token|cookie|signature|consent|legal_consent|terms_acceptance|payment|card|bank|receipt|application_answer|application_answers|application_prose|essay|final_submission|submission_payload|legal_acceptance|identity_document|government_id|tax_id)(?:$|_)/iu;
const FORBIDDEN_ASSIGNMENT_SUFFIX = /(?:pii|applicantname|legalname|fullname|firstname|lastname|email|phone|mobile|contact|address|birth|birthday|dob|password|privatekey|signingkey|accounttoken|cookie|signature|consent|legalconsent|termsacceptance|payment|card|bank|receipt|answer|answers|applicationanswer|applicationanswers|applicationprose|essay|submission|finalsubmission|submissionpayload|legalacceptance|identitydocument|governmentid|taxid)$/u;
const RUN_STATUSES = new Set(['running', 'complete', 'partial', 'failed']);
const SOURCE_KINDS = new Set(['listing', 'official', 'search']);
const SOURCE_STATUSES = new Set(['pending', 'ok', 'no_results', 'partial', 'failed']);
const SUCCESSFUL_SOURCE_STATUSES = new Set(['ok', 'no_results']);
const SOURCE_FAILURE_CODES = new Set([
  'none', 'timeout', 'http_403', 'http_404', 'rate_limited', 'network',
  'invalid_response', 'parse_error', 'unknown',
]);
const RECENCY = new Set(['new', 'recent', 'stale']);
const OFFICIAL_VERIFICATION = new Set(['verified', 'unverified', 'not_found', 'failed']);
const ACCEPTANCE = new Set(['open', 'closed', 'unknown']);
const ELIGIBILITY = new Set(['eligible', 'ineligible', 'unknown']);
const RISK_STATES = new Set(['unknown', 'low', 'medium', 'high', 'blocked']);
const FEE_STATUSES = new Set(['free', 'paid', 'unknown']);
const PARTICIPATION_MODES = new Set(['none', 'online_only', 'offline_required', 'unknown']);
const CANDIDATE_STATUSES = new Set([
  'discovered', 'verifying', 'active', 'deferred', 'rejected', 'archived',
]);
const APPLICATION_STATES = new Set([
  'DISCOVERED', 'SOURCE_VERIFIED', 'ELIGIBLE', 'PREPARED', 'VALIDATED',
  'WAITING_DEADLINE_CLARIFICATION', 'WAITING_IDENTITY', 'WAITING_ELIGIBILITY',
  'WAITING_CLARIFICATION', 'WAITING_ARTIFACTS', 'WAITING_LEGAL_CONSENT',
  'WAITING_RIGHTS_APPROVAL', 'WAITING_FEE_APPROVAL', 'WAITING_APPROVAL',
  'AUTHORIZED', 'SUBMITTING', 'SUBMISSION_UNKNOWN',
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
const APPROVAL_KINDS = new Set([
  'preparation', 'legal_consent', 'rights_acceptance', 'payment', 'final_submission',
]);
const APPROVAL_APPLICATION_STATES = new Map([
  ['preparation', 'WAITING_RIGHTS_APPROVAL'],
  ['legal_consent', 'WAITING_LEGAL_CONSENT'],
  ['rights_acceptance', 'WAITING_RIGHTS_APPROVAL'],
  ['payment', 'WAITING_FEE_APPROVAL'],
  ['final_submission', 'WAITING_APPROVAL'],
]);

export class CompetitionReportError extends Error {
  constructor(message, { code = 'invalid_report', status = null } = {}) {
    super(message);
    this.name = 'CompetitionReportError';
    this.code = code;
    this.status = status;
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message, options) {
  throw new CompetitionReportError(message, options);
}

function exactKeys(value, required, optional, label) {
  if (!record(value)) fail(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label}.${key} is required`);
  }
}

function string(value, label, { max = 240, maxBytes = null, pattern, privatePatterns = false } = {}) {
  if (typeof value !== 'string' || value.trim() !== value || !value || value.length > max
    || (maxBytes !== null && Buffer.byteLength(value, 'utf8') > maxBytes)) {
    fail(`${label} must be a non-empty bounded string`);
  }
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format`);
  const normalized = value.normalize('NFKC');
  if (privatePatterns) {
    if (/(?:<\/?[A-Za-z][^>]*>|<!--|<!DOCTYPE)/iu.test(normalized)) {
      fail(`${label} must not contain raw markup`);
    }
    scanPrivateText(normalized, label);
  }
  return value;
}

function oneOf(value, allowed, label) {
  string(value, label, { max: 40 });
  if (!allowed.has(value)) fail(`${label} has an unsupported value`);
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

function timestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  string(value, label, { max: 35 });
  const match = value.match(OFFSET_TIMESTAMP);
  if (!match) fail(`${label} must be a valid offset timestamp`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone,
    , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, '0')));
  const local = new Date(localEpoch);
  const offsetHour = zone === 'Z' ? 0 : Number(offsetHourText);
  const offsetMinute = zone === 'Z' ? 0 : Number(offsetMinuteText);
  if (year < 2000 || year > 2100 || hour > 23 || minute > 59 || second > 59
    || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)
    || local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) {
    fail(`${label} must be a valid offset timestamp`);
  }
  return value;
}

function calendarDate(value, label) {
  string(value, label, { max: 10 });
  const match = value.match(DATE);
  if (!match) fail(`${label} must be a valid date`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2100 || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    fail(`${label} must be a valid date`);
  }
  return value;
}

function kstDate(instant) {
  return new Date(Date.parse(instant) + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
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
    || canonical.startsWith('authentication')
    || canonical.startsWith('authorization')
    || canonical.startsWith('oauth')
    || canonical.startsWith('session')
    || canonical.includes('apikey')
    || canonical.includes('accesskey')
    || canonical.includes('privatekey')
    || canonical.includes('signingkey');
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
    if (/(?:token|secret|signature|credential|private(?:key)?|signingkey|authorization(?:code)?|authentication|oauth(?:code)?|session(?:id|key|token)?|api[_-]?key|access[_-]?key|auth(?:code|header|key|token)?)$/u.test(before)
      || FORBIDDEN_ASSIGNMENT_SUFFIX.test(before)) return true;
  }
  return false;
}

function hasPrivatePatternOnce(value) {
  return EMAIL.test(value) || PHONE.test(value) || KOREAN_RESIDENT_ID.test(value)
    || LABELED_IDENTITY.test(value) || LABELED_IDENTITY_TEXT.test(value)
    || STANDALONE_CREDENTIAL.test(value) || RAW_MARKUP.test(value)
    || hasKoreanPhone(value) || hasPrivateAssignment(value);
}

function hasPrivatePattern(value) {
  const normalized = String(value).normalize('NFKC');
  const folded = privacyFold(normalized);
  return hasPrivatePatternOnce(normalized)
    || (folded !== normalized && hasPrivatePatternOnce(folded));
}

function scanPrivateText(value, label) {
  let decoded = String(value).normalize('NFKC');
  for (let pass = 0; pass < 8; pass += 1) {
    if (hasPrivatePattern(decoded)) fail(`${label} contains private data`);
    if (!/%[0-9A-F]{2}/iu.test(decoded)) return decoded;
    let next;
    try { next = decodeURIComponent(decoded).normalize('NFKC'); }
    catch { fail(`${label} has invalid private-data encoding`); }
    if (next === decoded) return decoded;
    decoded = next;
  }
  fail(`${label} has excessive private-data encoding`);
}

function scanPrivateUrlComponent(value, label) {
  let decoded = String(value).normalize('NFKC');
  for (let pass = 0; pass < 8; pass += 1) {
    if (hasPrivatePattern(decoded)) fail(`${label} contains private data`);
    let next;
    try { next = decodeURIComponent(decoded).normalize('NFKC'); }
    catch { fail(`${label} has invalid URL encoding`); }
    if (next === decoded) return decoded;
    decoded = next;
  }
  fail(`${label} has excessive URL encoding`);
}

function stringContainsSecretInDecodedForms(value, secret) {
  const normalizedSecret = String(secret).normalize('NFKC');
  const foldedSecret = privacyFold(normalizedSecret);
  let decoded = String(value).normalize('NFKC');
  for (let pass = 0; pass < 8; pass += 1) {
    const folded = privacyFold(decoded);
    if (decoded.includes(normalizedSecret) || folded.includes(foldedSecret)) return true;
    if (!/%[0-9A-F]{2}/iu.test(decoded)) return false;
    let next;
    try { next = decodeURIComponent(decoded).normalize('NFKC'); }
    catch { return false; }
    if (next === decoded) return false;
    decoded = next;
  }
  return false;
}

function reportContainsSecret(value, secret) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (stringContainsSecretInDecodedForms(current, secret)) return true;
    } else if (Array.isArray(current)) {
      pending.push(...current);
    } else if (current && typeof current === 'object') {
      pending.push(...Object.values(current));
    }
  }
  return false;
}

function publicHttpsUrl(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  string(value, label, { max: 2_048 });
  const normalizedRaw = value.normalize('NFKC');
  scanPrivateUrlComponent(normalizedRaw, label);
  let url;
  try { url = new URL(normalizedRaw); } catch { fail(`${label} must be an absolute HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname) {
    fail(`${label} must be an absolute public HTTPS URL`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.+$/u, '');
  const octets = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) ? host.split('.').map(Number) : null;
  const nonPublicIpv4 = octets?.length === 4 && octets.every((part) => part >= 0 && part <= 255)
    && (octets[0] === 0 || octets[0] === 10 || octets[0] === 127
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && [0, 168].includes(octets[1]))
      || (octets[0] === 198 && [18, 19, 51].includes(octets[1]))
      || (octets[0] === 203 && octets[1] === 0) || octets[0] >= 224);
  const nonPublicIpv6 = host.includes(':') && (
    host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd')
    || /^fe[89ab]/u.test(host) || host.startsWith('ff') || host.startsWith('2001:db8:')
    || host.startsWith('::ffff:') || host.startsWith('64:ff9b:')
  );
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || (!host.includes('.') && !host.includes(':'))
    || nonPublicIpv4 || nonPublicIpv6) {
    fail(`${label} must not target a local or private host`);
  }
  for (const [key, queryValue] of url.searchParams) {
    const decodedKey = scanPrivateUrlComponent(key, `${label} query`);
    scanPrivateUrlComponent(queryValue, `${label} query`);
    const normalizedKey = decodedKey.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').replaceAll('-', '_').toLowerCase();
    if (FORBIDDEN_KEYS.test(normalizedKey) || isSensitiveQueryKey(decodedKey)) {
      fail(`${label} query contains private data`);
    }
  }
  return url.href;
}

export function isCompetitionPublicTextSafe(value) {
  if (typeof value !== 'string') return false;
  try {
    scanPrivateText(value, 'competition discovery text');
    return true;
  } catch (error) {
    if (error instanceof CompetitionReportError) return false;
    throw error;
  }
}

export function isCompetitionPublicUrlSafe(value) {
  try {
    publicHttpsUrl(value, 'competition discovery URL');
    return true;
  } catch (error) {
    if (error instanceof CompetitionReportError) return false;
    throw error;
  }
}

export function isCompetitionPlaceholderOrganizer(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return new Set([
    '주최기관공식확인필요',
    '주최기관확인필요',
    '공식확인필요',
    'organizerverificationrequired',
    'organizerunverified',
  ]).has(normalized);
}

function rejectForbiddenKeys(value, label = 'report') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenKeys(item, `${label}[${index}]`));
    return;
  }
  if (!record(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) fail(`${label}.${key} is private and must not be reported`);
    rejectForbiddenKeys(child, `${label}.${key}`);
  }
}

function boundedArray(value, label, max) {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be an array with at most ${max} entries`);
  return value;
}

function validateRun(run) {
  exactKeys(run, ['id', 'date', 'started_at', 'finished_at', 'status', 'source_coverage'], [], 'report.run');
  string(run.id, 'report.run.id', { max: 160, pattern: IDENTIFIER, privatePatterns: true });
  calendarDate(run.date, 'report.run.date');
  timestamp(run.started_at, 'report.run.started_at');
  timestamp(run.finished_at, 'report.run.finished_at', { nullable: true });
  if (run.finished_at && Date.parse(run.finished_at) < Date.parse(run.started_at)) fail('report.run.finished_at precedes started_at');
  if (run.date !== kstDate(run.started_at)) fail('report.run.date must match the KST date of started_at');
  const observationAt = run.finished_at || run.started_at;
  if (Date.parse(observationAt) > Date.now() + MAX_FUTURE_SKEW_MS) {
    fail('report.run observation time is too far in the future');
  }
  oneOf(run.status, RUN_STATUSES, 'report.run.status');
  exactKeys(run.source_coverage, ['expected', 'checked', 'succeeded'], [], 'report.run.source_coverage');
  const expected = integer(run.source_coverage.expected, 'report.run.source_coverage.expected', { min: 1, max: 32 });
  const checked = integer(run.source_coverage.checked, 'report.run.source_coverage.checked', { max: 32 });
  const succeeded = integer(run.source_coverage.succeeded, 'report.run.source_coverage.succeeded', { max: 32 });
  if (succeeded > checked || checked > expected) fail('report.run.source_coverage must satisfy succeeded <= checked <= expected');
  if ((run.status === 'running') !== (run.finished_at === null)) fail('only a running report may have a null finished_at');
  if (run.status === 'complete' && checked !== expected) fail('a complete run must check every expected source');
}

function validateSource(source, index) {
  const label = `report.sources[${index}]`;
  exactKeys(source, [
    'id', 'kind', 'name', 'reference_url', 'checked_at', 'status', 'failure_code',
    'manual_check', 'candidate_count',
  ], [], label);
  string(source.id, `${label}.id`, { max: 160, pattern: IDENTIFIER, privatePatterns: true });
  oneOf(source.kind, SOURCE_KINDS, `${label}.kind`);
  string(source.name, `${label}.name`, { max: 240, maxBytes: 240, privatePatterns: true });
  publicHttpsUrl(source.reference_url, `${label}.reference_url`);
  timestamp(source.checked_at, `${label}.checked_at`);
  oneOf(source.status, SOURCE_STATUSES, `${label}.status`);
  oneOf(source.failure_code, SOURCE_FAILURE_CODES, `${label}.failure_code`);
  if (typeof source.manual_check !== 'boolean') fail(`${label}.manual_check must be boolean`);
  integer(source.candidate_count, `${label}.candidate_count`, { max: MAX_COMPETITION_CANDIDATES });
  const failed = source.status === 'failed' || source.status === 'partial';
  if (failed !== (source.failure_code !== 'none')) fail(`${label}.failure_code must match failed or partial status`);
  if (['timeout', 'http_403'].includes(source.failure_code) && source.manual_check !== true) {
    fail(`${label}.manual_check must be true for timeout or HTTP 403 coverage`);
  }
  if (['pending', 'no_results', 'failed'].includes(source.status) && source.candidate_count !== 0) {
    fail(`${label}.candidate_count must be zero for ${source.status} coverage`);
  }
}

function validateCandidate(candidate, index, sourceIds) {
  const label = `report.candidates[${index}]`;
  exactKeys(candidate, [
    'contest_id', 'category', 'title', 'organizer', 'source_id', 'discovery_url', 'discovered_at',
    'recency', 'official_url', 'official_verification', 'official_verified_at', 'acceptance',
    'deadline_at', 'eligibility', 'fee_status', 'participation_mode', 'rights_risk',
    'submission_risk', 'status', 'fit_score', 'effort_score',
  ], [], label);
  string(candidate.contest_id, `${label}.contest_id`, { max: 160, pattern: IDENTIFIER, privatePatterns: true });
  string(candidate.category, `${label}.category`, { max: 80, pattern: CATEGORY, privatePatterns: true });
  string(candidate.title, `${label}.title`, { max: 240, maxBytes: 240, privatePatterns: true });
  string(candidate.organizer, `${label}.organizer`, { max: 160, maxBytes: 160, privatePatterns: true });
  string(candidate.source_id, `${label}.source_id`, { max: 160, pattern: IDENTIFIER, privatePatterns: true });
  if (!sourceIds.has(candidate.source_id)) fail(`${label}.source_id does not reference a reported source`);
  publicHttpsUrl(candidate.discovery_url, `${label}.discovery_url`);
  timestamp(candidate.discovered_at, `${label}.discovered_at`);
  oneOf(candidate.recency, RECENCY, `${label}.recency`);
  publicHttpsUrl(candidate.official_url, `${label}.official_url`, { nullable: true });
  oneOf(candidate.official_verification, OFFICIAL_VERIFICATION, `${label}.official_verification`);
  timestamp(candidate.official_verified_at, `${label}.official_verified_at`, { nullable: true });
  oneOf(candidate.acceptance, ACCEPTANCE, `${label}.acceptance`);
  timestamp(candidate.deadline_at, `${label}.deadline_at`, { nullable: true });
  oneOf(candidate.eligibility, ELIGIBILITY, `${label}.eligibility`);
  oneOf(candidate.fee_status, FEE_STATUSES, `${label}.fee_status`);
  oneOf(candidate.participation_mode, PARTICIPATION_MODES, `${label}.participation_mode`);
  oneOf(candidate.rights_risk, RISK_STATES, `${label}.rights_risk`);
  oneOf(candidate.submission_risk, RISK_STATES, `${label}.submission_risk`);
  oneOf(candidate.status, CANDIDATE_STATUSES, `${label}.status`);
  integer(candidate.fit_score, `${label}.fit_score`, { max: 100 });
  integer(candidate.effort_score, `${label}.effort_score`, { max: 100 });
  const verified = candidate.official_verification === 'verified';
  if (verified && isCompetitionPlaceholderOrganizer(candidate.organizer)) {
    fail(`${label}.organizer must identify the officially verified organizer`);
  }
  if (verified !== Boolean(candidate.official_url && candidate.official_verified_at)) {
    fail(`${label} official verification must bind both official URL and verification time`);
  }
  if (candidate.official_verified_at
    && Date.parse(candidate.official_verified_at) < Date.parse(candidate.discovered_at)) {
    fail(`${label}.official_verified_at precedes discovery`);
  }
  if (candidate.status === 'active' && (
    !verified
    || candidate.eligibility !== 'eligible'
    || candidate.fee_status !== 'free'
    || !['none', 'online_only'].includes(candidate.participation_mode)
    || candidate.acceptance !== 'open'
    || !candidate.deadline_at
    || candidate.rights_risk === 'blocked'
    || candidate.submission_risk === 'blocked'
  )) fail(`${label} cannot be active before official, eligibility, and acceptance verification`);
}

function validateApplication(application, index, candidates) {
  const label = `report.applications[${index}]`;
  exactKeys(application, [
    'contest_id', 'category', 'profile_id', 'state', 'blocker', 'next_action', 'updated_at',
  ], [], label);
  string(application.contest_id, `${label}.contest_id`, { max: 160, pattern: IDENTIFIER, privatePatterns: true });
  string(application.category, `${label}.category`, { max: 80, pattern: CATEGORY, privatePatterns: true });
  string(application.profile_id, `${label}.profile_id`, { max: 76, pattern: PROFILE_ID });
  oneOf(application.state, APPLICATION_STATES, `${label}.state`);
  oneOf(application.blocker, APPLICATION_BLOCKERS, `${label}.blocker`);
  oneOf(application.next_action, APPLICATION_NEXT_ACTIONS, `${label}.next_action`);
  timestamp(application.updated_at, `${label}.updated_at`);
  const key = `${application.contest_id}|${application.category}`;
  const candidate = candidates.get(key);
  if (!candidate) fail(`${label} does not reference a reported candidate`);
  if (candidate.official_verification !== 'verified'
    || candidate.eligibility !== 'eligible'
    || candidate.fee_status !== 'free'
    || !['none', 'online_only'].includes(candidate.participation_mode)
    || candidate.acceptance !== 'open'
    || !candidate.deadline_at
    || candidate.rights_risk === 'blocked'
    || candidate.submission_risk === 'blocked') {
    fail(`${label} cannot enter active work before official, eligibility, and acceptance verification`);
  }
  if (candidate.status !== 'active') fail(`${label} must reference an active candidate`);
}

function validateApproval(approval, index, applications, observationTime) {
  const label = `report.approvals[${index}]`;
  exactKeys(approval, [
    'request_id', 'contest_id', 'category', 'kind', 'action_sha256', 'requested_at',
    'expires_at', 'read_summary', 'approval_text',
  ], [], label);
  string(approval.request_id, `${label}.request_id`, {
    max: 160, pattern: APPROVAL_REQUEST_ID, privatePatterns: true,
  });
  string(approval.contest_id, `${label}.contest_id`, {
    max: 160, pattern: IDENTIFIER, privatePatterns: true,
  });
  string(approval.category, `${label}.category`, {
    max: 80, pattern: CATEGORY, privatePatterns: true,
  });
  oneOf(approval.kind, APPROVAL_KINDS, `${label}.kind`);
  string(approval.action_sha256, `${label}.action_sha256`, { max: 64, pattern: SHA256 });
  timestamp(approval.requested_at, `${label}.requested_at`);
  timestamp(approval.expires_at, `${label}.expires_at`, { nullable: true });
  string(approval.read_summary, `${label}.read_summary`, {
    max: 2_000, maxBytes: 2_000, privatePatterns: true,
  });
  string(approval.approval_text, `${label}.approval_text`, {
    max: 1_000, maxBytes: 1_000, privatePatterns: true,
  });
  const key = `${approval.contest_id}|${approval.category}`;
  const application = applications.get(key);
  if (!application || application.state !== APPROVAL_APPLICATION_STATES.get(approval.kind)) {
    fail(`${label} does not match the reported application state`);
  }
  const requested = Date.parse(approval.requested_at);
  if (requested < Date.parse(application.updated_at) || requested > observationTime) {
    fail(`${label}.requested_at is outside the application observation window`);
  }
  if (approval.expires_at) {
    const lifetime = Date.parse(approval.expires_at) - requested;
    if (lifetime <= 0) fail(`${label}.expires_at must follow requested_at`);
    if (approval.kind !== 'preparation' && lifetime > 15 * 60_000) {
      fail(`${label}.expires_at exceeds the 15 minute sensitive-action window`);
    }
  } else if (approval.kind !== 'preparation') {
    fail(`${label}.expires_at is required for sensitive action approval`);
  }
  if (approval.kind !== 'preparation' && Date.parse(approval.expires_at) <= observationTime) {
    fail(`${label} is already expired at the report observation`);
  }
}

function canonicalPublicHost(value) {
  return new URL(value).hostname.toLowerCase().replace(/\.+$/u, '').replace(/^www\d*\./u, '');
}

function matchesListingHost(host, listingHosts) {
  return [...listingHosts].some((listingHost) => host === listingHost
    || host.endsWith('.' + listingHost)
    || listingHost.endsWith('.' + host));
}

export function validateCompetitionReport(report) {
  rejectForbiddenKeys(report);
  exactKeys(
    report,
    ['version', 'idempotency_key', 'run', 'sources', 'candidates', 'applications'],
    ['approvals'],
    'report',
  );
  if (report.version !== 1) fail('report.version must equal 1');
  string(report.idempotency_key, 'report.idempotency_key', { max: 160, pattern: IDENTIFIER, privatePatterns: true });
  validateRun(report.run);

  const sources = boundedArray(report.sources, 'report.sources', 32);
  if (sources.length === 0) fail('report.sources must contain at least one source');
  const sourceIds = new Set();
  sources.forEach((source, index) => {
    validateSource(source, index);
    if (sourceIds.has(source.id)) fail(`report.sources[${index}].id is duplicated`);
    sourceIds.add(source.id);
  });
  if (report.run.source_coverage.expected !== sources.length) fail('report.run.source_coverage.expected must equal sources length');
  const checked = sources.filter((source) => source.status !== 'pending').length;
  const succeeded = sources.filter((source) => SUCCESSFUL_SOURCE_STATUSES.has(source.status)).length;
  if (report.run.source_coverage.checked !== checked || report.run.source_coverage.succeeded !== succeeded) {
    fail('report.run.source_coverage counts do not match source statuses');
  }

  const candidates = new Map();
  const candidateCountBySource = new Map(sources.map((source) => [source.id, 0]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const listingHosts = new Set(sources
    .filter((source) => source.kind === 'listing')
    .map((source) => canonicalPublicHost(source.reference_url)));
  const observationAt = report.run.finished_at || report.run.started_at;
  const observationTime = Date.parse(observationAt);
  sources.forEach((source, index) => {
    if (Date.parse(source.checked_at) > observationTime) {
      fail(`report.sources[${index}].checked_at follows the report observation`);
    }
  });
  const candidateList = boundedArray(
    report.candidates,
    'report.candidates',
    MAX_COMPETITION_CANDIDATES,
  );
  candidateList.forEach((candidate, index) => {
    validateCandidate(candidate, index, sourceIds);
    const key = `${candidate.contest_id}|${candidate.category}`;
    if (candidates.has(key)) fail(`report.candidates[${index}] duplicates a contest/category key`);
    candidates.set(key, candidate);
    candidateCountBySource.set(candidate.source_id, candidateCountBySource.get(candidate.source_id) + 1);
    const source = sourceById.get(candidate.source_id);
    if (source.kind === 'listing') listingHosts.add(canonicalPublicHost(candidate.discovery_url));
    if (Date.parse(candidate.discovered_at) > observationTime
      || (candidate.official_verified_at && Date.parse(candidate.official_verified_at) > observationTime)) {
      fail(`report.candidates[${index}] contains evidence after the report observation`);
    }
    if (candidate.status === 'active' && Date.parse(candidate.deadline_at) <= observationTime) {
      fail(`report.candidates[${index}] cannot remain active after its deadline`);
    }
    if (['timeout', 'http_403'].includes(source.failure_code) && candidate.acceptance === 'closed') {
      fail(`report.candidates[${index}] cannot use timeout or HTTP 403 as closure evidence`);
    }
  });
  candidateList.forEach((candidate, index) => {
    if (candidate.official_verification === 'verified'
      && matchesListingHost(canonicalPublicHost(candidate.official_url), listingHosts)) {
      fail(`report.candidates[${index}].official_url must not point to a discovery listing origin`);
    }
  });
  sources.forEach((source, index) => {
    if (source.candidate_count !== candidateCountBySource.get(source.id)) {
      fail(`report.sources[${index}].candidate_count does not match reported candidates`);
    }
  });

  const applications = boundedArray(report.applications, 'report.applications', 10);
  const applicationKeys = new Set();
  const applicationByKey = new Map();
  applications.forEach((application, index) => {
    validateApplication(application, index, candidates);
    const key = `${application.contest_id}|${application.category}`;
    if (applicationKeys.has(key)) fail(`report.applications[${index}] is duplicated`);
    applicationKeys.add(key);
    applicationByKey.set(key, application);
    const candidate = candidates.get(key);
    if (Date.parse(application.updated_at) > observationTime) {
      fail(`report.applications[${index}].updated_at follows the report observation`);
    }
    if (Date.parse(application.updated_at) < Date.parse(candidate.discovered_at)) {
      fail(`report.applications[${index}].updated_at precedes candidate discovery`);
    }
    if (Date.parse(candidate.deadline_at) <= observationTime) {
      fail(`report.applications[${index}] references a candidate whose deadline has passed`);
    }
  });

  const approvals = boundedArray(report.approvals || [], 'report.approvals', 10);
  const approvalIds = new Set();
  const approvalKeys = new Set();
  approvals.forEach((approval, index) => {
    validateApproval(approval, index, applicationByKey, observationTime);
    const key = `${approval.contest_id}|${approval.category}`;
    if (approvalIds.has(approval.request_id)) fail(`report.approvals[${index}].request_id is duplicated`);
    if (approvalKeys.has(key)) fail(`report.approvals[${index}] duplicates a contest/category key`);
    approvalIds.add(approval.request_id);
    approvalKeys.add(key);
  });

  const serialized = JSON.stringify(report);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REPORT_BYTES) fail(`report exceeds ${MAX_REPORT_BYTES} bytes`);
  return report;
}

export function readCompetitionReport(file, { fsImpl = fs } = {}) {
  const fullPath = path.resolve(file);
  const stat = fsImpl.statSync(fullPath);
  if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) fail(`input must be a JSON file no larger than ${MAX_REPORT_BYTES} bytes`);
  let report;
  try { report = JSON.parse(fsImpl.readFileSync(fullPath, 'utf8').replace(/^\uFEFF/u, '')); }
  catch { fail('input is not valid JSON'); }
  return validateCompetitionReport(report);
}

function nonEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readConfigFile(file, fsImpl) {
  if (!file) return {};
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/u, ''));
    return record(parsed) ? parsed : {};
  } catch {
    fail('competition reporter config is missing or invalid', { code: 'misconfigured' });
  }
}

export function resolveCompetitionConfig({ env = process.env, configPath, apiUrl: apiUrlOverride, fsImpl = fs } = {}) {
  const file = readConfigFile(configPath || nonEmpty(env.COMPETITION_REPORT_CONFIG), fsImpl);
  const apiUrl = nonEmpty(apiUrlOverride) || nonEmpty(env.COMPETITION_API_URL) || nonEmpty(file.api_url);
  const token = nonEmpty(env.COMPETITION_INGEST_TOKEN) || nonEmpty(file.competition_ingest_token);
  if (!apiUrl || !token) fail('COMPETITION_API_URL and COMPETITION_INGEST_TOKEN (or config equivalents) are required', { code: 'misconfigured' });
  let url;
  try { url = new URL(apiUrl); } catch { fail('competition API URL is invalid', { code: 'misconfigured' }); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('competition API URL must use HTTPS', { code: 'misconfigured' });
  return { apiUrl: url.href.replace(/\/+$/u, ''), token };
}

function safeResponseText(text, secrets = []) {
  let safe = String(text ?? '').replace(/[\r\n\t]+/gu, ' ');
  for (const secret of secrets) {
    if (secret) safe = safe.replaceAll(secret, '[redacted]');
  }
  return safe.slice(0, 240);
}

function validateAcknowledgement(data, report, responseStatus) {
  if (!record(data) || data.ok !== true || data.version !== 1
    || data.idempotency_key !== report.idempotency_key || data.run_id !== report.run.id
    || typeof data.replayed !== 'boolean' || !record(data.counts)) {
    fail('competition API returned an invalid acknowledgement', { code: 'invalid_acknowledgement' });
  }
  for (const [key, expected] of [
    ['sources', report.sources.length],
    ['candidates', report.candidates.length],
    ['applications', report.applications.length],
  ]) {
    if (data.counts[key] !== expected) fail(`competition API acknowledgement count mismatch for ${key}`, { code: 'invalid_acknowledgement' });
  }
  if (!((responseStatus === 201 && data.replayed === false)
    || (responseStatus === 200 && data.replayed === true))) {
    fail('competition API acknowledgement status does not match replay state', {
      code: 'invalid_acknowledgement',
    });
  }
  return {
    ok: true,
    version: 1,
    idempotency_key: report.idempotency_key,
    run_id: report.run.id,
    replayed: data.replayed,
    counts: {
      sources: data.counts.sources,
      candidates: data.counts.candidates,
      applications: data.counts.applications,
    },
  };
}

async function readBoundedAcknowledgement(response, signal) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ACKNOWLEDGEMENT_BYTES) {
    fail('competition API acknowledgement is too large', { code: 'invalid_acknowledgement' });
  }
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted', 'AbortError'));
    }, { once: true });
  });
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = '';
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_ACKNOWLEDGEMENT_BYTES) {
          reader.cancel('competition acknowledgement exceeded the byte limit').catch(() => {});
          fail('competition API acknowledgement is too large', { code: 'invalid_acknowledgement' });
        }
        body += decoder.decode(value, { stream: true });
      }
      reader.releaseLock();
      return body + decoder.decode();
    } catch (error) {
      reader.cancel('competition acknowledgement read stopped').catch(() => {});
      throw error;
    }
  }
  const body = String(await Promise.race([response.text(), aborted]));
  if (Buffer.byteLength(body, 'utf8') > MAX_ACKNOWLEDGEMENT_BYTES) {
    fail('competition API acknowledgement is too large', { code: 'invalid_acknowledgement' });
  }
  return body;
}

export async function sendCompetitionReport(report, {
  apiUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  validateCompetitionReport(report);
  const normalizedToken = nonEmpty(token);
  if (!nonEmpty(apiUrl) || !normalizedToken) fail('competition reporter is missing API URL or token', { code: 'misconfigured' });
  if (typeof fetchImpl !== 'function') fail('fetch is unavailable', { code: 'misconfigured' });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) fail('timeout must be from 1000 to 120000 ms');
  const body = JSON.stringify(report);
  if (normalizedToken.length >= 16 && reportContainsSecret(report, normalizedToken)) {
    fail('competition report contains the active ingest secret', { code: 'forbidden_data' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let responseText;
  try {
    response = await fetchImpl(`${apiUrl.replace(/\/+$/u, '')}/api/competitions/report`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${normalizedToken}`,
        'content-type': 'application/json',
      },
      body,
      signal: controller.signal,
    });
    responseText = await readBoundedAcknowledgement(response, controller.signal);
  } catch (error) {
    if (error instanceof CompetitionReportError) throw error;
    const timedOut = error?.name === 'AbortError' || controller.signal.aborted;
    const message = timedOut ? 'competition report request timed out' : 'competition report request failed';
    fail(message, { code: timedOut ? 'timeout' : 'network_error', status: 0 });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    fail(`competition API rejected the report (HTTP ${response.status}): ${safeResponseText(responseText, [normalizedToken])}`, {
      code: response.status === 401 ? 'unauthorized' : 'http_error',
      status: response.status,
    });
  }
  let data;
  try { data = JSON.parse(responseText); } catch { fail('competition API returned non-JSON success', { code: 'invalid_acknowledgement' }); }
  return validateAcknowledgement(data, report, response.status);
}

function parseArgs(argv) {
  const options = { dryRun: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (['--input', '--config', '--api-url', '--timeout-ms'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`, { code: 'usage' });
      index += 1;
      if (argument === '--input') options.input = value;
      else if (argument === '--config') options.configPath = value;
      else if (argument === '--api-url') options.apiUrl = value;
      else options.timeoutMs = Number(value);
    } else fail(`unknown argument: ${argument}`, { code: 'usage' });
  }
  if (!options.input) fail('--input is required', { code: 'usage' });
  return options;
}

export async function runCompetitionReporter(argv, {
  env = process.env,
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
} = {}) {
  const options = parseArgs(argv);
  const report = readCompetitionReport(options.input, { fsImpl });
  if (options.dryRun) {
    return {
      ok: true,
      dry_run: true,
      version: report.version,
      idempotency_key: report.idempotency_key,
      run_id: report.run.id,
      counts: {
        sources: report.sources.length,
        candidates: report.candidates.length,
        applications: report.applications.length,
      },
    };
  }
  const config = resolveCompetitionConfig({
    env, configPath: options.configPath, apiUrl: options.apiUrl, fsImpl,
  });
  return sendCompetitionReport(report, {
    apiUrl: config.apiUrl,
    token: config.token,
    timeoutMs: options.timeoutMs,
    fetchImpl,
  });
}

async function main() {
  try {
    const result = await runCompetitionReporter(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof CompetitionReportError ? error.code : 'unexpected_error';
    const message = error instanceof CompetitionReportError ? error.message : 'unexpected competition reporter failure';
    process.stderr.write(`[competition-report] ${code}: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) void main();
