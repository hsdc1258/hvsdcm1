import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_FILE), '..');
const MAX_RESPONSE_BYTES = 64_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 90_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const RECEIPT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u;
const JOB_STATUSES = new Set([
  'queued', 'claimed', 'running', 'succeeded', 'blocked', 'submission_unknown',
]);
const RESULT_CODES = new Map([
  ['succeeded', new Set(['submitted'])],
  ['blocked', new Set([
    'unsupported_organizer_flow', 'private_config_missing', 'destination_mismatch',
    'captcha_required', 'account_required', 'payment_required', 'terms_changed',
    'eligibility_unknown', 'manual_action_required', 'destination_unavailable',
  ])],
  ['submission_unknown', new Set([
    'timeout_after_send', 'connection_lost_after_send', 'ambiguous_response', 'lease_expired',
  ])],
]);

export class CompetitionSubmissionError extends Error {
  constructor(message, { code = 'submission_client_error' } = {}) {
    super(message);
    this.name = 'CompetitionSubmissionError';
    this.code = code;
  }
}

function fail(message, code = 'submission_client_error') {
  throw new CompetitionSubmissionError(message, { code });
}

function exactObject(value, keys, label, code = 'invalid_config') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is invalid`, code);
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(`${label} has unknown fields`, code);
  return value;
}

function normalizedHttpsUrl(value, label, code = 'invalid_config') {
  let url;
  try { url = new URL(value); } catch { fail(`${label} must be a valid HTTPS URL`, code); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    fail(`${label} must be a valid HTTPS URL`, code);
  }
  return url.href;
}

function safeMessage(value, secrets = []) {
  let message = String(value || '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 500);
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, '[redacted]');
  return message;
}

function outsideRepository(file) {
  const relative = path.relative(REPOSITORY_ROOT, file);
  if (!(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) return false;
  let directory = path.dirname(file);
  while (true) {
    if (fs.existsSync(path.join(directory, '.git'))) return false;
    const parent = path.dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
}

export function readCompetitionSubmissionConfig(configPath, fsImpl = fs) {
  const file = path.resolve(configPath);
  if (!outsideRepository(file)) {
    fail('competition submission config must be stored outside Git', 'invalid_config');
  }
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    fail('competition submission config is missing or invalid', 'invalid_config');
  }
  exactObject(parsed, ['api_url', 'competition_submission_token', 'actions'], 'competition submission config');
  const apiUrl = normalizedHttpsUrl(parsed.api_url, 'api_url').replace(/\/+$/u, '');
  if (typeof parsed.competition_submission_token !== 'string'
    || parsed.competition_submission_token.length < 43
    || /\s/u.test(parsed.competition_submission_token)) {
    fail('competition submission token is invalid', 'invalid_config');
  }
  if (!parsed.actions || typeof parsed.actions !== 'object' || Array.isArray(parsed.actions)
    || Object.keys(parsed.actions).length > 100) {
    fail('competition submission actions are invalid', 'invalid_config');
  }
  const actions = {};
  for (const [actionSha256, rawAction] of Object.entries(parsed.actions)) {
    if (!SHA256.test(actionSha256)) fail('competition submission action hash is invalid', 'invalid_config');
    const action = exactObject(rawAction, ['request_id', 'official_url', 'adapter'], 'competition submission action');
    if (typeof action.request_id !== 'string' || !ID.test(action.request_id)) {
      fail('competition submission request id is invalid', 'invalid_config');
    }
    if (typeof action.adapter !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(action.adapter)) {
      fail('competition submission adapter is invalid', 'invalid_config');
    }
    actions[actionSha256] = {
      request_id: action.request_id,
      official_url: normalizedHttpsUrl(action.official_url, 'official_url'),
      adapter: action.adapter,
    };
  }
  return {
    apiUrl,
    token: parsed.competition_submission_token,
    actions,
  };
}

async function boundedText(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    fail('competition submission response is too large', 'invalid_response');
  }
  const body = response.body;
  if (!body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      fail('competition submission response is too large', 'invalid_response');
    }
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel('competition submission response too large');
        fail('competition submission response is too large', 'invalid_response');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof CompetitionSubmissionError) throw error;
    fail('competition submission response could not be read', 'invalid_response');
  }
  return text;
}

async function requestJson(url, {
  token, body, fetchImpl, timeoutMs, setTimer, clearTimer,
}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimer(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let response;
  let responseText;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    responseText = await boundedText(response);
  } catch (error) {
    if (error instanceof CompetitionSubmissionError) throw error;
    fail(
      timedOut ? 'competition submission request timed out' : 'competition submission request failed',
      timedOut ? 'request_timeout' : 'request_failed',
    );
  } finally {
    clearTimer(timer);
  }
  if (!response.ok) {
    fail(
      `competition submission API rejected the request (HTTP ${response.status}): ${safeMessage(responseText, [token])}`,
      'api_rejected',
    );
  }
  let parsed;
  try { parsed = JSON.parse(responseText); }
  catch { fail('competition submission API returned invalid JSON', 'invalid_response'); }
  return parsed;
}

function optionalTimestamp(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`${label} is invalid`, 'invalid_response');
  return value;
}

function validateSubmissionJobState(value) {
  const hasLiveLease = typeof value.lease_id === 'string' && value.lease_until !== null;
  const hasClaim = value.claimed_at !== null;
  const resultIsValid = typeof value.result_code === 'string'
    && RESULT_CODES.get(value.status)?.has(value.result_code);
  if (value.status === 'queued') {
    return value.lease_id === null && value.lease_until === null && !hasClaim
      && value.started_at === null && value.completed_at === null
      && value.result_code === null && value.receipt_reference === null;
  }
  if (value.status === 'claimed') {
    return hasLiveLease && hasClaim && value.started_at === null && value.completed_at === null
      && value.result_code === null && value.receipt_reference === null;
  }
  if (value.status === 'running') {
    return hasLiveLease && hasClaim && value.started_at !== null && value.completed_at === null
      && value.result_code === null && value.receipt_reference === null;
  }
  if (!RESULT_CODES.has(value.status)) return false;
  return typeof value.lease_id === 'string' && value.lease_until === null && hasClaim
    && value.completed_at !== null && resultIsValid
    && (value.status !== 'succeeded' || value.started_at !== null)
    && (value.status !== 'blocked' || value.receipt_reference === null);
}

export function validateClaimedSubmissionJob(value) {
  if (value === null) return null;
  exactObject(value, [
    'job_id', 'request_id', 'action_sha256', 'contest_id', 'category', 'official_url',
    'status', 'queued_at', 'claimed_at', 'started_at', 'completed_at', 'result_code',
    'receipt_reference', 'lease_id', 'lease_until',
  ], 'competition submission job', 'invalid_response');
  if (!ID.test(value.job_id) || !ID.test(value.request_id) || !SHA256.test(value.action_sha256)
    || typeof value.contest_id !== 'string' || value.contest_id.length < 1 || value.contest_id.length > 160
    || typeof value.category !== 'string' || value.category.length < 1 || value.category.length > 80
    || !JOB_STATUSES.has(value.status)) fail('competition submission job is invalid', 'invalid_response');
  const officialUrl = normalizedHttpsUrl(value.official_url, 'official_url', 'invalid_response');
  const leaseId = value.lease_id === null ? null : value.lease_id;
  if (leaseId !== null && (typeof leaseId !== 'string' || !LEASE_ID.test(leaseId))) {
    fail('competition submission lease is invalid', 'invalid_response');
  }
  if (value.receipt_reference !== null
    && (typeof value.receipt_reference !== 'string' || !RECEIPT_REFERENCE.test(value.receipt_reference))) {
    fail('competition submission receipt reference is invalid', 'invalid_response');
  }
  const job = {
    ...value,
    official_url: officialUrl,
    queued_at: optionalTimestamp(value.queued_at, 'queued_at'),
    claimed_at: optionalTimestamp(value.claimed_at, 'claimed_at'),
    started_at: optionalTimestamp(value.started_at, 'started_at'),
    completed_at: optionalTimestamp(value.completed_at, 'completed_at'),
    lease_until: optionalTimestamp(value.lease_until, 'lease_until'),
  };
  if (job.queued_at === null || !validateSubmissionJobState(job)) {
    fail('competition submission job state is invalid', 'invalid_response');
  }
  return job;
}

function validateClaimResponse(value) {
  exactObject(value, ['job'], 'competition submission claim response', 'invalid_response');
  const job = validateClaimedSubmissionJob(value.job);
  if (job && (job.status !== 'claimed' || !job.lease_id || !job.lease_until)) {
    fail('competition submission claim response is invalid', 'invalid_response');
  }
  return job;
}

function validateStateResponse(value, expectedState) {
  exactObject(value, ['job', 'replayed'], 'competition submission state response', 'invalid_response');
  const job = validateClaimedSubmissionJob(value.job);
  if (!job || job.status !== expectedState || typeof value.replayed !== 'boolean') {
    fail('competition submission state response is invalid', 'invalid_response');
  }
  return job;
}

function validateExecutorResult(result) {
  exactObject(
    result,
    ['state', 'result_code', 'receipt_reference'],
    'competition submission executor result',
    'invalid_executor_result',
  );
  if (!RESULT_CODES.has(result.state) || !RESULT_CODES.get(result.state).has(result.result_code)) {
    fail('competition submission executor result is invalid', 'invalid_executor_result');
  }
  const receipt = result.receipt_reference === undefined ? null : result.receipt_reference;
  if (receipt !== null && (typeof receipt !== 'string' || !RECEIPT_REFERENCE.test(receipt))) {
    fail('competition submission executor receipt reference is invalid', 'invalid_executor_result');
  }
  if (result.state === 'blocked' && receipt !== null) {
    fail('blocked submission cannot carry a receipt reference', 'invalid_executor_result');
  }
  return { state: result.state, result_code: result.result_code, receipt_reference: receipt };
}

async function defaultExecuteAction() {
  return { state: 'blocked', result_code: 'unsupported_organizer_flow' };
}

async function executeOnce(executeAction, context, timeoutMs, setTimer, clearTimer) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimer(() => {
      controller.abort();
      resolve({ state: 'submission_unknown', result_code: 'timeout_after_send' });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => executeAction({ ...context, signal: controller.signal })),
      timeout,
    ]);
  } catch {
    return { state: 'submission_unknown', result_code: 'ambiguous_response' };
  } finally {
    clearTimer(timer);
  }
}

export async function runCompetitionSubmissionOnce({
  configPath,
  fsImpl = fs,
  fetchImpl = fetch,
  executeAction = defaultExecuteAction,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!configPath) fail('competition submission config path is required', 'invalid_config');
  const config = readCompetitionSubmissionConfig(configPath, fsImpl);
  const requestOptions = {
    token: config.token, fetchImpl, timeoutMs: requestTimeoutMs, setTimer, clearTimer,
  };
  const claimed = validateClaimResponse(await requestJson(
    `${config.apiUrl}/api/competitions/submissions/claim`, requestOptions,
  ));
  if (!claimed) return { ok: true, status: 'idle' };

  const stateUrl = `${config.apiUrl}/api/competitions/submissions/${encodeURIComponent(claimed.job_id)}/state`;
  const postState = async (body) => validateStateResponse(await requestJson(stateUrl, {
    ...requestOptions, body,
  }), body.state);
  const configured = config.actions[claimed.action_sha256];
  let terminal;
  if (!configured) {
    terminal = { state: 'blocked', result_code: 'private_config_missing', receipt_reference: null };
  } else if (configured.request_id !== claimed.request_id
    || configured.official_url !== claimed.official_url) {
    terminal = { state: 'blocked', result_code: 'destination_mismatch', receipt_reference: null };
  } else if (configured.adapter === 'unsupported') {
    terminal = { state: 'blocked', result_code: 'unsupported_organizer_flow', receipt_reference: null };
  } else {
    await postState({ state: 'running', lease_id: claimed.lease_id });
    const executed = await executeOnce(
      executeAction,
      { job: claimed, action: configured },
      executionTimeoutMs,
      setTimer,
      clearTimer,
    );
    try { terminal = validateExecutorResult(executed); }
    catch {
      terminal = { state: 'submission_unknown', result_code: 'ambiguous_response', receipt_reference: null };
    }
  }
  const finalJob = await postState({
    state: terminal.state,
    lease_id: claimed.lease_id,
    result_code: terminal.result_code,
    ...(terminal.receipt_reference ? { receipt_reference: terminal.receipt_reference } : {}),
  });
  return {
    ok: true,
    job_id: finalJob.job_id,
    status: finalJob.status,
    result_code: finalJob.result_code,
    receipt_reference: finalJob.receipt_reference,
  };
}

function parseArgs(argv) {
  let configPath = process.env.COMPETITION_SUBMISSION_CONFIG || '';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--config') fail(`unknown argument: ${argument}`, 'invalid_arguments');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail('--config requires a path', 'invalid_arguments');
    configPath = value;
    index += 1;
  }
  if (!configPath) fail('--config is required', 'invalid_arguments');
  return { configPath };
}

async function main() {
  try {
    const result = await runCompetitionSubmissionOnce(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof CompetitionSubmissionError ? error.code : 'unexpected_failure';
    const message = error instanceof CompetitionSubmissionError
      ? error.message
      : 'unexpected competition submission failure';
    process.stderr.write(`[competition-submit] ${code}: ${safeMessage(message)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) await main();
