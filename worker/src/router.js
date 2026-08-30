import {
  DAY_MS,
  authenticate,
  clientIp,
  createToken,
  issueSession,
  json,
  logActivity,
  normalizeAnswer,
  now,
  passwordHash,
  readJson,
  sha256,
} from './lib.js';

const MAX_PROGRESS_BYTES = 800_000;
// 사용량 스냅샷은 rate_limits 몇 개짜리 객체다. 상한이 없으면 ingest 토큰이 새거나
// 수집기 버그 하나로 D1 행이 무제한으로 부푼다.
const MAX_USAGE_BYTES = 64_000;
const MAX_HARNESS_BYTES = 64_000;
const MAX_HARNESS_INPUT_BYTES = 4_096;
export const HARNESS_STALE_MS = 15 * 60 * 1_000;
const SESSION_HISTORY_MS = 90 * DAY_MS;
const VALID_APPS = new Set(['wordmaster', 'smstudy']);
// 수집 원본. 이 집합이 ingest 허용 목록이자 조회 필터의 단일 원본이다 — 한쪽만 고치면
// 받아 놓고 못 읽는(또는 그 반대의) 상태가 생긴다.
const VALID_USAGE_SOURCES = new Set(['codex', 'claude']);
export const USAGE_SNAPSHOT_UPSERT_SQL = `
  INSERT INTO usage_snapshots(source, captured_at, payload)
  VALUES (?1, ?2, ?3)
  ON CONFLICT(source)
  DO UPDATE SET captured_at = excluded.captured_at, payload = excluded.payload
  WHERE julianday(excluded.captured_at) > julianday(usage_snapshots.captured_at)
    OR julianday(usage_snapshots.captured_at) IS NULL
`;
// 파이프라인 단계 집합. **순서가 곧 진행 방향**이고, 화면(usage/assets/js/usage.js의
// PHASES)이 같은 키를 같은 순서로 그린다 — scripts/validate.mjs가 두 원본을 대조해
// 어긋나면 게이트를 깨뜨린다. 구 4단계(plan/work/review/done)는 이 집합의 부분집합이라
// 옛 보고자가 그대로 보고해도 계속 받아 준다.
const VALID_HARNESS_PHASES = new Set([
  'input', 'plan', 'work', 'gate', 'review', 'revise', 'approve', 'done',
]);
const VALID_HARNESS_REPORT_PHASES = new Set([...VALID_HARNESS_PHASES, 'heartbeat']);
const TERMINAL_HARNESS_PHASES = new Set(['approve', 'done']);
const VALID_HARNESS_TASK_STATES = new Set(['active', 'complete']);
const VALID_HARNESS_ACTOR_KINDS = new Set(['codex', 'webgpt', 'claude']);
const VALID_HARNESS_ACTOR_STATES = new Set([
  'working', 'reviewing', 'waiting', 'done', 'blocked', 'unavailable',
]);
const VALID_HARNESS_REASONING = new Set([
  '', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);
const usageTokenEncoder = new TextEncoder();
const moderatorDecoder = new TextDecoder('utf-8', { fatal: true });
const LOGIN_MINUTE_MS = 60_000;
const LOGIN_FAILURE_WINDOW_MS = 60 * LOGIN_MINUTE_MS;
const LOGIN_LOCK_MS = 15 * LOGIN_MINUTE_MS;
const LOGIN_ATTEMPTS_PER_MINUTE = 5;
const LOGIN_FAILURES_PER_WINDOW = 10;
const GICHUL_HEADERS = Object.freeze({
  'cache-control': 'no-store',
});
const LEARNING_CONTENT_KEYS = Object.freeze({
  wordmaster: 'learning/wordmaster.json',
  smstudy: 'learning/smstudy.json',
});
const MAX_MODERATOR_COMMAND_BYTES = 8_192;
const MAX_MODERATOR_BODY_BYTES = 64_000;
const MAX_MODERATOR_SUMMARY_LENGTH = 240;
const MAX_MODERATOR_CURSOR_LENGTH = 512;
const MODERATOR_COMMAND_LEASE_MS = 60_000;
const MODERATOR_REVIEW_LEASE_MS = 15 * 60_000;
const MODERATOR_REVIEW_PROJECT = Object.freeze({
  project_key: 'claude-workspace',
});
const MODERATOR_REQUESTED_MODEL = 'gpt-5.6-sol';
const MODERATOR_REQUESTED_REASONING = 'xhigh';
const VALID_MODERATOR_KINDS = new Set(['important', 'proposal', 'review']);
const VALID_MODERATOR_REASONING = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);
const MODERATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MODERATOR_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export const MODERATOR_PROPOSAL_APPROVE_SQL = `
  UPDATE moderator_items
  SET status = 'approved', version = version + 1, updated_at = ?2, decided_at = ?2
  WHERE item_id = ?1 AND kind = 'proposal' AND status = 'pending'
`;

export const MODERATOR_ITEM_EVENT_AFTER_CHANGE_SQL = `
  INSERT INTO moderator_item_events(item_id, event, version, occurred_at, payload)
  SELECT item_id, ?2, version, ?3, ?4
  FROM moderator_items
  WHERE item_id = ?1 AND changes() > 0
`;

export const MODERATOR_PROPOSAL_COMMAND_AFTER_EVENT_SQL = `
  INSERT INTO moderator_commands(
    command_id, source, source_item_id, idempotency_key, command_text, status,
    attempts, requested_model, requested_reasoning, created_at, updated_at
  )
  SELECT ?1, 'proposal', item_id, ?2, proposed_command, 'queued', 0, ?3, ?4, ?5, ?5
  FROM moderator_items
  WHERE item_id = ?6 AND kind = 'proposal' AND status = 'approved' AND changes() > 0
`;

export const MODERATOR_COMMAND_CLAIM_SQL = `
  WITH next_command AS (
    SELECT command_id
    FROM moderator_commands
    WHERE status = 'queued' AND attempts < 2
    ORDER BY created_at ASC, command_id ASC
    LIMIT 1
  )
  UPDATE moderator_commands
  SET status = 'claimed', lease_id = ?2, lease_until = ?3,
      attempts = attempts + 1, claimed_at = ?1, updated_at = ?1
  WHERE command_id = (SELECT command_id FROM next_command) AND status = 'queued'
  RETURNING *
`;

export function fixedTimeEqual(left, right) {
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(left, right);
  }

  // Node's Web Crypto test runtime does not expose the Workers extension.
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function fixedTimeTextEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', usageTokenEncoder.encode(String(left))),
    crypto.subtle.digest('SHA-256', usageTokenEncoder.encode(String(right))),
  ]);
  return fixedTimeEqual(new Uint8Array(leftHash), new Uint8Array(rightHash));
}

function rateLimitResponse(retryAt, attemptedAt) {
  const retryAfter = Math.max(1, Math.ceil((retryAt - attemptedAt) / 1_000));
  return json(
    { error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' },
    429,
    { 'retry-after': String(retryAfter) },
  );
}

async function beginLoginAttempt(request, env, scope, account) {
  const attemptedAt = now();
  const normalizedAccount = String(account || '').normalize('NFKC').toLowerCase();
  const keyHash = await sha256(JSON.stringify([scope, clientIp(request), normalizedAccount]));
  const state = await env.DB.prepare(`
    INSERT INTO login_attempt_limits(
      key_hash, minute_started_at, minute_attempts,
      failure_window_started_at, failure_count, locked_until, updated_at
    ) VALUES (?1, ?2, 1, NULL, 0, 0, ?2)
    ON CONFLICT(key_hash) DO UPDATE SET
      minute_started_at = CASE
        WHEN login_attempt_limits.minute_started_at <= ?3 THEN excluded.minute_started_at
        ELSE login_attempt_limits.minute_started_at
      END,
      minute_attempts = CASE
        WHEN login_attempt_limits.minute_started_at <= ?3 THEN 1
        ELSE login_attempt_limits.minute_attempts + 1
      END,
      updated_at = excluded.updated_at
    RETURNING minute_started_at, minute_attempts, locked_until
  `).bind(keyHash, attemptedAt, attemptedAt - LOGIN_MINUTE_MS).first();

  const lockedUntil = Number(state?.locked_until || 0);
  const minuteRetryAt = Number(state?.minute_attempts || 0) > LOGIN_ATTEMPTS_PER_MINUTE
    ? Number(state.minute_started_at) + LOGIN_MINUTE_MS
    : 0;
  const retryAt = Math.max(lockedUntil, minuteRetryAt);
  return {
    attemptedAt,
    keyHash,
    response: retryAt > attemptedAt ? rateLimitResponse(retryAt, attemptedAt) : null,
  };
}

async function recordLoginFailure(env, attempt) {
  const lockUntil = attempt.attemptedAt + LOGIN_LOCK_MS;
  const state = await env.DB.prepare(`
    UPDATE login_attempt_limits
    SET failure_window_started_at = CASE
          WHEN failure_window_started_at IS NULL OR failure_window_started_at <= ?3 THEN ?2
          ELSE failure_window_started_at
        END,
        failure_count = CASE
          WHEN failure_window_started_at IS NULL OR failure_window_started_at <= ?3 THEN 1
          ELSE failure_count + 1
        END,
        locked_until = CASE
          WHEN (CASE
            WHEN failure_window_started_at IS NULL OR failure_window_started_at <= ?3 THEN 1
            ELSE failure_count + 1
          END) >= ?5 THEN MAX(locked_until, ?4)
          ELSE locked_until
        END,
        updated_at = ?2
    WHERE key_hash = ?1
    RETURNING failure_count, locked_until
  `).bind(
    attempt.keyHash,
    attempt.attemptedAt,
    attempt.attemptedAt - LOGIN_FAILURE_WINDOW_MS,
    lockUntil,
    LOGIN_FAILURES_PER_WINDOW,
  ).first();

  return Number(state?.locked_until || 0) > attempt.attemptedAt
    ? rateLimitResponse(Number(state.locked_until), attempt.attemptedAt)
    : null;
}

async function clearLoginFailures(env, attempt) {
  await env.DB.prepare(`
    UPDATE login_attempt_limits
    SET failure_window_started_at = NULL,
        failure_count = 0,
        locked_until = 0,
        updated_at = ?2
    WHERE key_hash = ?1
  `).bind(attempt.keyHash, attempt.attemptedAt).run();
}

async function login(request, env) {
  const input = await readJson(request);
  const username = String(input.username || '').trim();
  const attempt = await beginLoginAttempt(request, env, 'user', username);
  if (attempt.response) return attempt.response;

  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username)
    .first();

  const suppliedHash = user
    ? await passwordHash(String(input.password || ''), user.password_salt)
    : null;
  const passwordMatches = user
    ? await fixedTimeTextEqual(suppliedHash, user.password_hash)
    : false;
  if (!user || user.disabled || !passwordMatches) {
    const locked = await recordLoginFailure(env, attempt);
    if (locked) return locked;
    return json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
  }

  await clearLoginFailures(env, attempt);
  const rawToken = await issueSession(env, user.id, 'user', request);
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(now(), user.id)
    .run();
  await logActivity(env, user.id, 'login');
  return json({ token: rawToken, user: { id: user.id, username: user.username } });
}

async function adminLogin(request, env) {
  const input = await readJson(request);
  const attempt = await beginLoginAttempt(request, env, 'admin', 'admin');
  if (attempt.response) return attempt.response;

  const passwordMatches = await fixedTimeTextEqual(
    String(input.password || ''),
    String(env.ADMIN_PASSWORD || ''),
  );
  if (!env.ADMIN_PASSWORD || !passwordMatches) {
    const locked = await recordLoginFailure(env, attempt);
    if (locked) return locked;
    return json({ error: '비밀번호가 올바르지 않습니다.' }, 401);
  }
  await clearLoginFailures(env, attempt);
  return json({ token: await issueSession(env, null, 'admin', request) });
}

async function ingestTokenMatches(request, expectedValue) {
  const authorization = request.headers.get('authorization') || '';
  const supplied = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const expected = String(expectedValue || '');
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', usageTokenEncoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', usageTokenEncoder.encode(expected)),
  ]);
  const matches = fixedTimeEqual(new Uint8Array(suppliedHash), new Uint8Array(expectedHash));
  return Boolean(supplied && expected && matches);
}

async function writeUsageHealth(env, source, attemptedAt, outcome, successAt = null) {
  await env.DB.prepare(`
    INSERT INTO usage_source_health(source, last_success_at, last_attempt_at, last_outcome)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(source)
    DO UPDATE SET
      last_success_at = CASE
        WHEN excluded.last_success_at IS NOT NULL
          AND (datetime(excluded.last_attempt_at) >= datetime(usage_source_health.last_attempt_at)
            OR datetime(usage_source_health.last_attempt_at) IS NULL)
        THEN excluded.last_success_at ELSE usage_source_health.last_success_at END,
      last_attempt_at = CASE
        WHEN datetime(excluded.last_attempt_at) >= datetime(usage_source_health.last_attempt_at)
          OR datetime(usage_source_health.last_attempt_at) IS NULL
        THEN excluded.last_attempt_at ELSE usage_source_health.last_attempt_at END,
      last_outcome = CASE
        WHEN datetime(excluded.last_attempt_at) >= datetime(usage_source_health.last_attempt_at)
          OR datetime(usage_source_health.last_attempt_at) IS NULL
        THEN excluded.last_outcome ELSE usage_source_health.last_outcome END
  `).bind(source, successAt, attemptedAt, outcome).run();
}

async function reportUsage(request, env) {
  if (!(await ingestTokenMatches(request, env.USAGE_INGEST_TOKEN))) {
    return json({ error: '인증이 필요합니다.' }, 401);
  }

  const body = await readJson(request);
  const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const source = String(input.source || '');
  const capturedAt = typeof input.captured_at === 'string' ? input.captured_at : '';
  const attemptedAt = typeof input.attempted_at === 'string'
    ? input.attempted_at
    : (capturedAt || new Date().toISOString());
  const requestedOutcome = typeof input.outcome === 'string' ? input.outcome.trim() : '';
  const outcome = requestedOutcome || 'success';
  const payloadIsObject = input.payload !== null
    && typeof input.payload === 'object'
    && !Array.isArray(input.payload);
  if (!VALID_USAGE_SOURCES.has(source)
    || !Number.isFinite(Date.parse(attemptedAt))
    || !['success', 'no-data', 'failed'].includes(outcome)
    || (outcome === 'success' && (
      !capturedAt
      || !Number.isFinite(Date.parse(capturedAt))
      || !payloadIsObject
    ))) {
    return json({ error: '잘못된 사용량 보고입니다.' }, 400);
  }

  const serialized = payloadIsObject ? JSON.stringify(input.payload) : '';
  if (usageTokenEncoder.encode(serialized).byteLength > MAX_USAGE_BYTES) {
    return json({ error: '사용량 보고가 너무 큽니다.' }, 413);
  }

  const normalizedAttemptedAt = new Date(attemptedAt).toISOString();
  if (outcome !== 'success') {
    await writeUsageHealth(env, source, normalizedAttemptedAt, outcome);
    return json({ ok: true, snapshot: false });
  }

  const normalizedCapturedAt = new Date(capturedAt).toISOString();
  const snapshot = await env.DB.prepare(USAGE_SNAPSHOT_UPSERT_SQL)
    .bind(source, normalizedCapturedAt, serialized).run();
  if (snapshot?.meta?.changes === 0) {
    await writeUsageHealth(env, source, normalizedAttemptedAt, 'stale');
    return json({ ok: true, advanced: false, stale: true });
  }

  await writeUsageHealth(env, source, normalizedAttemptedAt, 'success', normalizedAttemptedAt);
  return json({ ok: true, advanced: true });
}

function harnessText(value, maxLength, required = false) {
  if (typeof value !== 'string') return required ? null : '';
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if ((required && !normalized) || normalized.length > maxLength) return null;
  return normalized;
}

function harnessInputText(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const codePoints = [...value.trim()];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (usageTokenEncoder.encode(codePoints.slice(0, middle).join('')).byteLength <= MAX_HARNESS_INPUT_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return codePoints.slice(0, low).join('');
}

function normalizeHarnessDelivery(value) {
  if (value === undefined) return { request: '', plan: [], changes: [], verification: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const list = (key) => {
    const values = value[key] === undefined ? [] : value[key];
    if (!Array.isArray(values) || values.length > 4) return null;
    const normalized = values.map((entry) => harnessText(entry, 220, true));
    return normalized.some((entry) => entry === null) ? null : normalized;
  };
  const request = value.request === undefined ? '' : harnessText(value.request, 700);
  const plan = list('plan');
  const changes = list('changes');
  const verification = list('verification');
  if (request === null || plan === null || changes === null || verification === null) return null;
  let approval;
  if (Object.hasOwn(value, 'approval') && value.approval !== null) {
    if (typeof value.approval !== 'object' || Array.isArray(value.approval)) return null;
    approval = {};
    for (const key of ['needed', 'reason', 'minimum', 'tabs', 'steps', 'secret_notice', 'completion', 'continuation']) {
      approval[key] = harnessText(value.approval[key], 500, true);
      if (approval[key] === null) return null;
    }
  }
  return {
    request, plan, changes, verification,
    ...(Object.hasOwn(value, 'approval') ? { approval: value.approval === null ? null : approval } : {}),
  };
}

function normalizeHarnessReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1) return null;
  const taskId = harnessText(input.task_id, 120, true);
  const occurredAt = harnessText(input.occurred_at, 40, true);
  const task = input.task;
  const actors = input.actors;
  const artifacts = input.artifacts;
  const modules = input.modules === undefined ? [] : input.modules;
  const delivery = normalizeHarnessDelivery(input.delivery);
  if (!taskId || !occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null;
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
  if (!Array.isArray(actors) || actors.length < 1 || actors.length > 20) return null;
  if (!Array.isArray(modules) || modules.length > 20) return null;
  if (!Array.isArray(artifacts) || artifacts.length > 10 || !delivery) return null;

  const phase = harnessText(task.phase, 16, true);
  const status = harnessText(task.status, 16, true);
  const reasoning = harnessText(task.reasoning, 20);
  const categoryKey = task.category_key === undefined
    ? 'general'
    : harnessText(task.category_key, 60, true);
  const category = task.category === undefined
    ? '기타 Codex 작업'
    : harnessText(task.category, 80, true);
  const progress = Number(task.progress);
  const title = task.title === undefined ? undefined : harnessText(task.title, 120);
  const originalInput = harnessInputText(task.input);
  const heartbeatAt = task.heartbeat_at === undefined
    ? occurredAt
    : harnessText(task.heartbeat_at, 40, true);
  const normalizedTask = {
    name: harnessText(task.name, 120, true),
    phase,
    progress,
    status,
    model: harnessText(task.model, 120, true),
    reasoning,
    category_key: categoryKey,
    category,
    current: harnessText(task.current, 240),
    done: harnessText(task.done, 240),
    next: harnessText(task.next, 240),
    deadline: harnessText(task.deadline, 80),
    ...(title === undefined ? {} : { title }),
    ...(originalInput === undefined ? {} : { input: originalInput }),
    heartbeat_at: heartbeatAt && Number.isFinite(Date.parse(heartbeatAt))
      ? new Date(heartbeatAt).toISOString()
      : null,
  };
  if (Object.values(normalizedTask).some((value) => value === null)
    || !VALID_HARNESS_REPORT_PHASES.has(phase)
    || !VALID_HARNESS_TASK_STATES.has(status)
    || !VALID_HARNESS_REASONING.has(reasoning)
    || !/^[\p{L}\p{N}][\p{L}\p{N}-]*$/u.test(normalizedTask.category_key)
    || !Number.isFinite(progress)
    || progress < 0
    || progress > 100) return null;
  if (TERMINAL_HARNESS_PHASES.has(phase)) {
    normalizedTask.status = 'complete';
    normalizedTask.progress = 100;
  }

  const projectKeyExplicit = input.project_key !== undefined;
  const projectKey = projectKeyExplicit
    ? harnessText(input.project_key, 120, true)
    : taskId;
  const projectTitle = input.project_title === undefined
    ? (normalizedTask.title || normalizedTask.name)
    : harnessText(input.project_title, 120, true);
  if (!projectKey || !projectTitle
    || (projectKeyExplicit && !/^[a-z0-9][a-z0-9-]{0,119}$/u.test(projectKey))) return null;

  const normalizedActors = [];
  const ids = new Set();
  for (const actor of actors) {
    if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return null;
    const actorPhase = actor.phase === undefined
      ? undefined
      : harnessText(actor.phase, 16, true);
    const normalized = {
      id: harnessText(actor.id, 120, true),
      parent_id: harnessText(actor.parent_id, 120),
      name: harnessText(actor.name, 80, true),
      kind: harnessText(actor.kind, 16, true),
      model: harnessText(actor.model, 120, true),
      reasoning: harnessText(actor.reasoning, 20),
      role: harnessText(actor.role, 120),
      status: harnessText(actor.status, 20, true),
      assignment: harnessText(actor.assignment, 240),
      ...(actorPhase === undefined ? {} : { phase: actorPhase }),
      ...(actor.progress === undefined ? {} : { progress: Number(actor.progress) }),
    };
    if (Object.values(normalized).some((value) => value === null)
      || ids.has(normalized.id)
      || !VALID_HARNESS_ACTOR_KINDS.has(normalized.kind)
      || !VALID_HARNESS_REASONING.has(normalized.reasoning)
      || !VALID_HARNESS_ACTOR_STATES.has(normalized.status)
      || (normalized.phase !== undefined && !VALID_HARNESS_PHASES.has(normalized.phase))
      || (normalized.progress !== undefined
        && (!Number.isFinite(normalized.progress) || normalized.progress < 0 || normalized.progress > 100))) return null;
    ids.add(normalized.id);
    normalizedActors.push(normalized);
  }

  const normalizedModules = [];
  const moduleIds = new Set();
  for (const module of modules) {
    if (!module || typeof module !== 'object' || Array.isArray(module)) return null;
    const normalized = {
      id: harnessText(module.id, 120, true),
      name: harnessText(module.name, 120, true),
      progress: Number(module.progress),
      status: harnessText(module.status, 20, true),
      owner: harnessText(module.owner, 80),
    };
    if (Object.values(normalized).some((value) => value === null)
      || moduleIds.has(normalized.id)
      || !Number.isFinite(normalized.progress)
      || normalized.progress < 0
      || normalized.progress > 100
      || !VALID_HARNESS_ACTOR_STATES.has(normalized.status)) return null;
    moduleIds.add(normalized.id);
    normalizedModules.push(normalized);
  }

  const normalizedArtifacts = artifacts.map((artifact) => harnessText(artifact, 180, true));
  if (normalizedArtifacts.some((artifact) => artifact === null)) return null;
  // resume은 terminal(complete) 태스크를 다시 여는 **명시적** 신호다. 빠뜨린 필드와
  // 오타를 구분하려고 boolean만 받는다 ('true' 같은 문자열은 400).
  if (input.resume !== undefined && typeof input.resume !== 'boolean') return null;
  return {
    version: 1,
    task_id: taskId,
    project_key: projectKey,
    project_title: projectTitle,
    project_key_explicit: projectKeyExplicit,
    // 새로 들어오는 시각은 정규 ISO(UTC)로 통일한다. 다만 정규화 이전에 저장된 행에는
    // 오프셋 표기('2026-08-27T10:00:00+09:00')가 그대로 남아 있으므로, 순서 판정은
    // 양쪽 모두 시각으로 한다 — JS는 Date.parse, SQL은 datetime() (사전순 비교 금지).
    occurred_at: new Date(occurredAt).toISOString(),
    resume: input.resume === true,
    task: normalizedTask,
    actors: normalizedActors,
    modules: normalizedModules,
    artifacts: normalizedArtifacts,
    delivery,
  };
}

const TERMINAL_HARNESS_ACTOR_STATES = new Set(['done', 'blocked']);

function harnessUsageStamp(usage) {
  const stamp = {};
  for (const source of ['codex', 'claude']) {
    const remaining = usage?.[source];
    if (Number.isFinite(remaining) && remaining >= 0 && remaining <= 100) stamp[source] = remaining;
  }
  return Object.keys(stamp).length > 0 ? stamp : null;
}

function harnessActorUsageStamp(usage, actor) {
  return harnessUsageStamp(typeof usage === 'function' ? usage(actor) : usage);
}

export function mergeHarnessReport(previous, incoming, usage = null) {
  const current = previous && typeof previous === 'object' ? previous : {};
  const heartbeatOnly = incoming.task.phase === 'heartbeat';
  if (heartbeatOnly && Object.keys(current).length > 0) {
    return {
      ...current,
      id: incoming.task_id,
      heartbeat_at: incoming.task.heartbeat_at || incoming.occurred_at,
      updated_at: incoming.occurred_at,
    };
  }
  const currentDelivery = current.delivery || {};
  const incomingDelivery = incoming.delivery || {};
  const mergeDeliveryList = (key) => [...new Set([
    ...(Array.isArray(currentDelivery[key]) ? currentDelivery[key] : []),
    ...(Array.isArray(incomingDelivery[key]) ? incomingDelivery[key] : []),
  ])].slice(-4);
  const delivery = {
    request: incomingDelivery.request || currentDelivery.request || incoming.task.input || current.input || '',
    plan: mergeDeliveryList('plan'),
    changes: mergeDeliveryList('changes'),
    verification: mergeDeliveryList('verification'),
    approval: Object.hasOwn(incomingDelivery, 'approval') ? incomingDelivery.approval : (currentDelivery.approval || null),
  };
  const actorMap = new Map(
    Array.isArray(current.actors) ? current.actors.map((actor) => [actor.id, actor]) : [],
  );
  for (const incomingActor of incoming.actors) {
    const existing = actorMap.get(incomingActor.id);
    const actor = { ...existing, ...incomingActor, updated_at: incoming.occurred_at };
    const usageStamp = harnessActorUsageStamp(usage, actor);
    if (!existing) {
      actor.started_at = incoming.occurred_at;
      if (!actor.phase) actor.phase = incoming.task.phase;
      if (usageStamp) actor.usage_at_start = { ...usageStamp };
    }
    if (incoming.resume === true
      && TERMINAL_HARNESS_ACTOR_STATES.has(existing?.status)
      && !TERMINAL_HARNESS_ACTOR_STATES.has(actor.status)) {
      actor.started_at = incoming.occurred_at;
      if (usageStamp) actor.usage_at_start = { ...usageStamp };
      else delete actor.usage_at_start;
      delete actor.finished_at;
      delete actor.usage_at_end;
    }
    if (TERMINAL_HARNESS_ACTOR_STATES.has(actor.status)
      && !TERMINAL_HARNESS_ACTOR_STATES.has(existing?.status)) {
      actor.finished_at = incoming.occurred_at;
      if (usageStamp) actor.usage_at_end = { ...usageStamp };
    }
    actorMap.set(actor.id, actor);
  }
  const moduleMap = new Map(
    Array.isArray(current.modules) ? current.modules.map((module) => [module.id, module]) : [],
  );
  for (const module of incoming.modules) {
    moduleMap.set(module.id, { ...moduleMap.get(module.id), ...module, updated_at: incoming.occurred_at });
  }
  let actors = [...actorMap.values()];
  let modules = [...moduleMap.values()];
  // terminal 보호 — 이미 complete로 잠긴 태스크는 늦게 도착한 진행 보고 하나로 되살아나지
  // 않는다. 되살리려면 보고가 resume:true를 명시해야 한다 (review M-A1).
  const terminalHold = current.status === 'complete'
    && incoming.task.status !== 'complete'
    && incoming.resume !== true;
  if (terminalHold || incoming.task.status === 'complete') {
    actors = actors.map((actor) => {
      const usageStamp = harnessActorUsageStamp(usage, actor);
      const finishesNow = (incoming.task.status === 'complete' || terminalHold)
        && actor.status !== 'unavailable'
        && !actor.finished_at;
      return {
        ...actor,
        status: actor.status === 'unavailable' ? actor.status : 'done',
        ...(actor.status === 'unavailable' ? {} : { progress: 100 }),
        ...(finishesNow ? { finished_at: incoming.occurred_at } : {}),
        ...(finishesNow && usageStamp ? { usage_at_end: { ...usageStamp } } : {}),
      };
    });
    modules = modules.map((module) => ({ ...module, status: 'done', progress: 100 }));
  }
  // 이 보고가 title을 실었으면 그것이 지정 제목이다. 아니면 이전 제목의 출처를 본다:
  //   - `title_authored === true`  → 지정으로 확인된 제목이므로 그대로 물려받는다.
  //   - `title_authored === false` → 파생(name 복사) 제목이므로 물려받지 않는다.
  //   - 필드 **부재**(플래그 도입 전 행) → 근거가 없으므로 예전 판정 규칙을 한 번 적용해
  //     `title !== name`인 제목만 지정으로 승격 보존한다 (review 기능 B M-2-R2).
  //     승격하지 않으면 구 행의 사용자 제목이 무제목 보고 한 번에 name으로 덮여 사라진다.
  const legacyAuthored = current.title_authored === undefined
    && typeof current.title === 'string'
    && current.title !== ''
    && current.title !== current.name;
  const inheritedTitle = (current.title_authored === true || legacyAuthored) ? current.title : '';
  const authoredTitle = incoming.task.title || inheritedTitle || '';
  const merged = {
    version: 1,
    ...current,
    ...incoming.task,
    project_key: incoming.project_key || current.project_key || incoming.task_id,
    project_title: incoming.project_title || current.project_title
      || incoming.task.title || incoming.task.name,
    // 사람이 **지정한** 제목과 하위 호환으로 name을 물려받은 제목을 나눠 둔다
    // (review 기능 B M-2). 예전에는 둘 다 `title`에 담겨, 지정한 제목이 마침 name과
    // 같으면 화면이 그것을 "지정한 적 없음"으로 오판해 날짜 꼬리를 떼고 약어를 풀었다.
    // 값 자체의 형태는 그대로 두고 **출처 플래그 한 개만** 더한다 — 이 필드를 모르는
    // 구 소비자는 예전과 똑같은 title을 계속 읽는다.
    title: authoredTitle || incoming.task.name,
    title_authored: authoredTitle !== '',
    input: incoming.task.input || current.input || '',
    heartbeat_at: incoming.task.heartbeat_at || current.heartbeat_at || incoming.occurred_at,
    // 잠긴 태스크의 머리글 수치(상태·단계·진행률)는 늦은 보고를 따라 뒤로 가지 않는다.
    ...(terminalHold ? {
      status: 'complete',
      phase: current.phase || incoming.task.phase,
      progress: Number.isFinite(current.progress) ? current.progress : incoming.task.progress,
    } : {}),
    id: incoming.task_id,
    created_at: current.created_at || incoming.occurred_at,
    updated_at: incoming.occurred_at,
    actors,
    modules,
    artifacts: [...new Set([...(current.artifacts || []), ...incoming.artifacts])].slice(-10),
    delivery,
  };
  if (incoming.task.status === 'complete') {
    merged.completed_at = current.status === 'complete' && current.completed_at
      ? current.completed_at
      : incoming.occurred_at;
  } else if (incoming.resume === true) {
    delete merged.completed_at;
  }
  return merged;
}

export function effectiveHarnessStatus(task, storedStatus = '', nowMs = Date.now()) {
  const status = storedStatus || task?.status || 'active';
  if (status === 'complete') return 'complete';
  const heartbeatAt = Date.parse(task?.heartbeat_at || task?.updated_at || '');
  if (Number.isFinite(heartbeatAt) && nowMs - heartbeatAt > HARNESS_STALE_MS) return 'stale';
  return 'active';
}

function remainingUsagePercent(bucket) {
  if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return null;
  const remaining = Number.isFinite(bucket.remaining_percent)
    ? bucket.remaining_percent
    : bucket.remaining_percentage;
  if (Number.isFinite(remaining) && remaining >= 0 && remaining <= 100) return remaining;
  const used = Number.isFinite(bucket.used_percent) ? bucket.used_percent : bucket.used_percentage;
  if (!Number.isFinite(used) || used < 0 || used > 100) return null;
  return 100 - used;
}

function codexRemainingPercent(payload) {
  const limits = payload?.rate_limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return null;
  const entries = Object.entries(limits).filter(([, bucket]) => (
    bucket && typeof bucket === 'object' && !Array.isArray(bucket)
  ));
  const selected = entries.find(([, bucket]) => bucket.window_minutes === 10_080)?.[1]
    || limits.secondary
    || limits.primary;
  return remainingUsagePercent(selected);
}

function claudeRemainingPercent(payload, subjectModel) {
  const models = payload?.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return null;
  const entries = Object.entries(models).filter(([, value]) => (
    value && typeof value === 'object' && !Array.isArray(value)
  ));
  const exact = entries.find(([model]) => model === subjectModel)?.[1];
  const selectedModel = exact || entries.reduce((newest, candidate) => {
    if (!newest) return candidate;
    const newestTime = Date.parse(newest[1].captured_at || '');
    const candidateTime = Date.parse(candidate[1].captured_at || '');
    return Number.isFinite(candidateTime)
      && (!Number.isFinite(newestTime) || candidateTime > newestTime) ? candidate : newest;
  }, null)?.[1];
  const limits = selectedModel?.rate_limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return null;
  const entriesForModel = Object.entries(limits).filter(([, bucket]) => (
    bucket && typeof bucket === 'object' && !Array.isArray(bucket)
  ));
  const selected = limits.seven_day
    || entriesForModel.find(([key]) => key.startsWith('seven_day'))?.[1]
    || entriesForModel.find(([, bucket]) => bucket.window_minutes === 10_080)?.[1]
    || limits.five_hour
    || entriesForModel[0]?.[1];
  return remainingUsagePercent(selected);
}

async function harnessUsageContext(env) {
  const snapshots = await env.DB.prepare(`
    SELECT source, captured_at, payload
    FROM usage_snapshots
    WHERE source IN (?1, ?2)
  `).bind('codex', 'claude').all();
  const context = { codex: null, claude: null, captured_at: { codex: null, claude: null } };
  for (const row of snapshots.results || []) {
    let payload = null;
    try { payload = JSON.parse(row.payload); } catch { payload = null; }
    if (row.source === 'codex' || row.source === 'claude') {
      context[row.source] = payload;
      context.captured_at[row.source] = optionalEventText(row.captured_at);
    }
  }
  return context;
}

function harnessUsageForModel(context, subjectModel) {
  return {
    codex: codexRemainingPercent(context.codex),
    claude: claudeRemainingPercent(context.claude, subjectModel),
  };
}

function optionalEventText(value) {
  return typeof value === 'string' && value ? value : null;
}

function projectUsageSummary(source, eventRows, usageContext) {
  const column = source === 'codex' ? 'usage_codex' : 'usage_claude';
  const observations = eventRows
    .map((row) => ({
      remaining: typeof row[column] === 'number' ? row[column] : null,
      measured_at: optionalEventText(row.ts),
    }))
    .filter(({ remaining }) => Number.isFinite(remaining) && remaining >= 0 && remaining <= 100);
  let consumed = 0;
  let resets = 0;
  for (let index = 1; index < observations.length; index += 1) {
    const delta = observations[index - 1].remaining - observations[index].remaining;
    if (delta > 0) consumed += delta;
    else if (delta < 0) resets += 1;
  }
  const currentRemaining = source === 'codex'
    ? codexRemainingPercent(usageContext.codex)
    : claudeRemainingPercent(usageContext.claude);
  const measuredAt = usageContext.captured_at[source]
    || observations.at(-1)?.measured_at
    || null;
  return {
    source: 'D1 usage_snapshots + harness_events',
    measured_at: measuredAt,
    remaining_percent: Number.isFinite(currentRemaining) ? currentRemaining : null,
    used_percent: Number.isFinite(currentRemaining) ? 100 - currentRemaining : null,
    consumed_percentage_points: observations.length >= 2 ? consumed : null,
    reset_count: observations.length >= 2 ? resets : null,
    observation_count: observations.length,
  };
}

export function latestHarnessDelivery(tasks = []) {
  const newestFirst = [...tasks].reverse();
  const latestList = (key, maximum) => {
    const values = newestFirst
      .map((task) => task?.delivery?.[key])
      .find((entries) => Array.isArray(entries) && entries.length > 0) || [];
    return [...new Set(values)].slice(-maximum);
  };
  return {
    request: newestFirst
      .map((task) => optionalEventText(task?.delivery?.request) || optionalEventText(task?.input))
      .find(Boolean) || '',
    plan: latestList('plan', 3),
    changes: latestList('changes', 4),
    verification: latestList('verification', 4),
    approval: newestFirst.filter((task) => task.status !== 'complete'
      && (task.actors || []).some((actor) => actor.status === 'blocked'))
      .map((task) => task.delivery?.approval).find(Boolean) || null,
  };
}

async function buildHarnessProjectSnapshot(env, projectKey, projectTitle, usageContext) {
  const [taskRows, eventRows] = await Promise.all([
    env.DB.prepare(`
      SELECT task_id, status, updated_at, payload, project_title
      FROM harness_tasks
      WHERE project_key = ?1
      ORDER BY datetime(updated_at) ASC, task_id ASC
    `).bind(projectKey).all(),
    env.DB.prepare(`
      SELECT events.id, events.task_id, events.ts, events.kind, events.actor_id,
        events.phase, events.percent, events.model, events.reasoning, events.status,
        events.usage_codex, events.usage_claude
      FROM harness_events AS events
      INNER JOIN harness_tasks AS tasks ON tasks.task_id = events.task_id
      WHERE tasks.project_key = ?1
      ORDER BY events.id ASC
    `).bind(projectKey).all(),
  ]);
  const tasks = (taskRows.results || []).flatMap((row) => {
    try {
      const payload = JSON.parse(row.payload);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
      return [{
        ...payload,
        id: payload.id || row.task_id,
        project_key: projectKey,
        project_title: payload.project_title || row.project_title || projectTitle,
        status: effectiveHarnessStatus(payload, row.status),
        updated_at: payload.updated_at || row.updated_at,
      }];
    } catch {
      return [];
    }
  });
  const events = eventRows.results || [];
  const validTimes = (field) => tasks
    .map((task) => optionalEventText(task[field]))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const starts = validTimes('created_at');
  const updates = validTimes('updated_at');
  const completions = validTimes('completed_at');
  const complete = tasks.length > 0 && tasks.every((task) => task.status === 'complete');
  const delivery = latestHarnessDelivery(tasks);
  return {
    version: 1,
    project_key: projectKey,
    project_title: tasks.find((task) => task.project_title)?.project_title || projectTitle,
    revision: events.reduce((maximum, event) => Math.max(maximum, Number(event.id) || 0), 0),
    started_at: starts[0] || null,
    updated_at: updates.at(-1) || null,
    completed_at: complete ? (completions.at(-1) || null) : null,
    delivery,
    tasks,
    events: events.map((event) => ({
      id: Number(event.id),
      task_id: event.task_id,
      ts: event.ts,
      kind: event.kind,
      actor_id: event.actor_id,
      phase: event.phase,
      percent: event.percent,
      model: event.model,
      reasoning: event.reasoning,
      status: event.status,
      usage_codex: event.usage_codex,
      usage_claude: event.usage_claude,
    })),
    usage: {
      codex: projectUsageSummary('codex', events, usageContext),
      claude: projectUsageSummary('claude', events, usageContext),
    },
  };
}

async function reportHarness(request, env) {
  if (!(await ingestTokenMatches(request, env.HARNESS_INGEST_TOKEN))) {
    return json({ error: '인증이 필요합니다.' }, 401);
  }
  const rawBody = await request.text();
  if (usageTokenEncoder.encode(rawBody).byteLength > MAX_HARNESS_BYTES) {
    return json({ error: '하네스 보고가 너무 큽니다.' }, 413);
  }
  let body = {};
  try { body = JSON.parse(rawBody); } catch { body = {}; }
  const incoming = normalizeHarnessReport(body);
  if (!incoming) return json({ error: '잘못된 하네스 보고입니다.' }, 400);

  const row = await env.DB.prepare('SELECT payload FROM harness_tasks WHERE task_id = ?1')
    .bind(incoming.task_id)
    .first();
  let previous = null;
  try { previous = row?.payload ? JSON.parse(row.payload) : null; } catch { previous = null; }
  // 늦게 도착한 과거 보고는 저장하지 않는다 — SELECT→merge→UPSERT 사이에 더 새로운
  // 보고가 들어왔다면 그 위에 옛 상태를 덮어쓰는 셈이 된다 (review M-A1).
  // 같은 시각(재전송·동시 보고)은 통과시킨다: 병합이 멱등이라 손실이 없다.
  // Date.parse는 오프셋 표기를 UTC로 환산하므로 아래 SQL의 datetime() 비교와 같은
  // 순서를 본다. 읽을 수 없는 옛 값은 양쪽 모두 순서 판정을 포기하고 통과시킨다.
  const storedAt = Date.parse(previous?.updated_at ?? '');
  if (Number.isFinite(storedAt) && Date.parse(incoming.occurred_at) < storedAt) {
    const response = { ok: true, task_id: incoming.task_id, stale: true };
    if (incoming.project_key_explicit) {
      const usageContext = await harnessUsageContext(env);
      response.project_snapshot = await buildHarnessProjectSnapshot(
        env, incoming.project_key, incoming.project_title, usageContext,
      );
    }
    return json(response);
  }
  const mergedActorIds = new Set([
    ...(Array.isArray(previous?.actors) ? previous.actors : []),
    ...incoming.actors,
  ].map((actor) => actor?.id).filter(Boolean));
  if (mergedActorIds.size > 20) {
    return json({ error: '하네스 실행자가 너무 많습니다.' }, 400);
  }
  const mergedModuleIds = new Set([
    ...(Array.isArray(previous?.modules) ? previous.modules : []),
    ...incoming.modules,
  ].map((module) => module?.id).filter(Boolean));
  if (mergedModuleIds.size > 20) {
    return json({ error: '하네스 모듈이 너무 많습니다.' }, 400);
  }
  // notify.mjs always emits `${task_id}:main` first and appends an --actor-* report last.
  // Only that distinct final actor changes the event subject; ordinary reports use task fields.
  const mainActorId = `${incoming.task_id}:main`;
  const lastActor = incoming.actors.at(-1);
  const isActorReport = Boolean(lastActor?.id && lastActor.id !== mainActorId);
  const subjectModel = optionalEventText(isActorReport ? lastActor.model : incoming.task.model);
  // The same server-side quota observation drives both the immutable actor lifecycle stamp and
  // the append-only event. Reporters cannot forge timing or quota metadata in their JSON body.
  const usageContext = await harnessUsageContext(env);
  const eventUsage = harnessUsageForModel(usageContext, subjectModel);
  const merged = mergeHarnessReport(
    previous,
    incoming,
    (actor) => harnessUsageForModel(usageContext, actor.model),
  );
  // 순서 비교는 문자열이 아니라 시각으로 한다. 정규화 이전에 저장된 행은 오프셋 표기라
  // 사전순으로는 UTC 표기보다 항상 뒤에 오고, 그래서 더 최신인 보고가 조용히 무시됐다.
  // SQLite datetime()은 '+09:00'과 'Z'를 모두 UTC로 환산한다(실측: sqlite 3.53.3에서
  // datetime('2026-08-27T01:30:00.000Z') >= datetime('2026-08-27T10:00:00+09:00') → 1,
  // 같은 값의 사전순 비교는 0). 읽을 수 없는 옛 값은 datetime()이 NULL이 되어 조건 전체가
  // NULL(거짓)로 굳으므로, JS stale 검사와 같이 그 경우엔 순서 판정을 포기하고 통과시킨다.
  //
  // 잔여 경쟁 조건(Major-1): SELECT→merge→UPSERT는 원자적이지 않다. 같은 task_id에 두
  // 보고자가 동시에 쓰면 나중 UPSERT의 payload(JSON 전문)가 앞선 병합 결과를 덮어 actor가
  // 유실될 수 있다. 완전한 원자화(버전 CAS·트랜잭션)는 스키마 변경을 요구하므로 하지 않는다 —
  // 상호운용 계약이 "task_id는 하네스별로 분리한다(단일 보고자 원칙)"를 이미 못박고 있어
  // 동시 다중 보고자 자체가 계약 밖이다: C:\Users\won\Desktop\Codex\docs\CLAUDE-INTEROP.md.
  // 계약이 깨졌을 때의 최악(끝난 태스크가 되살아남)만 DB 조건으로 한 겹 더 막는다: 우리가
  // 읽은 뒤 행이 complete가 됐다면, resume 없는 active 보고는 그 강등을 적용하지 못한다.
  const guardsTerminal = merged.status !== 'complete' && incoming.resume !== true;
  const serialized = JSON.stringify(merged);
  const subject = isActorReport ? lastActor : merged;
  const kind = previous && previous.phase !== merged.phase ? 'phase-change' : 'report';
  const upsertStatement = env.DB.prepare(`
    INSERT INTO harness_tasks(
      task_id, status, updated_at, payload, title, input, heartbeat_at, project_key, project_title
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(task_id)
    DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload,
      title = excluded.title, input = excluded.input, heartbeat_at = excluded.heartbeat_at,
      project_key = excluded.project_key, project_title = excluded.project_title
    WHERE (datetime(excluded.updated_at) >= datetime(harness_tasks.updated_at)
        OR datetime(harness_tasks.updated_at) IS NULL)
      ${guardsTerminal ? "AND harness_tasks.status != 'complete'" : ''}
  `).bind(
    incoming.task_id,
    merged.status,
    merged.updated_at,
    serialized,
    merged.title,
    merged.input,
    merged.heartbeat_at,
    merged.project_key,
    merged.project_title,
  );
  const eventStatement = env.DB.prepare(`
    INSERT INTO harness_events(
      task_id, ts, kind, actor_id, phase, percent, model, reasoning, status,
      usage_codex, usage_claude, payload
    )
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
    WHERE changes() > 0
  `).bind(
    incoming.task_id,
    incoming.occurred_at,
    kind,
    isActorReport ? lastActor.id : null,
    optionalEventText(merged.phase),
    Number.isFinite(subject.progress) ? subject.progress : null,
    subjectModel,
    optionalEventText(subject.reasoning),
    optionalEventText(subject.status),
    eventUsage.codex,
    eventUsage.claude,
    serialized,
  );
  // D1 batch executes sequentially as one transaction. The SQL changes() predicate observes the
  // immediately preceding conditional upsert, so a rejected task write cannot append an event.
  const [upsert] = await env.DB.batch([upsertStatement, eventStatement]);
  if (upsert?.meta?.changes === 0) {
    const response = { ok: true, task_id: incoming.task_id };
    if (incoming.project_key_explicit) {
      response.project_snapshot = await buildHarnessProjectSnapshot(
        env, incoming.project_key, incoming.project_title, usageContext,
      );
    }
    return json(response);
  }

  if (Math.random() < 0.05) {
    try {
      await env.DB.prepare(`
        DELETE FROM harness_events
        WHERE datetime(ts) < datetime('now', '-14 days')
      `).run();
    } catch { /* Retention is opportunistic and must not reject an accepted report. */ }
  }
  const response = { ok: true, task_id: incoming.task_id };
  if (incoming.project_key_explicit) {
    response.project_snapshot = await buildHarnessProjectSnapshot(
      env, incoming.project_key, incoming.project_title, usageContext,
    );
  }
  return json(response);
}

// 사용량은 소유자 한 사람의 운영 데이터다. 소유자 이름은 wrangler.toml의
// vars.OWNER_USERNAME 하나가 원본이고 코드에 적지 않는다 — 값이 없으면 아무도 통과하지
// 못한다(fail-closed). 세션의 username은 users 테이블에서 조인된 값이다(lib.js).
function isOwnerSession(session, env) {
  const owner = String(env.OWNER_USERNAME || '').trim().toLowerCase();
  const username = String(session?.username || '').trim().toLowerCase();
  return owner.length > 0 && username === owner;
}

function completedTaskLimit(request) {
  const values = new URL(request.url).searchParams.getAll('completed_limit');
  if (values.length === 0) return { ok: true, value: null };
  if (values.length !== 1 || !/^(?:0|[1-9]\d{0,3})$/u.test(values[0])) return { ok: false };
  const value = Number(values[0]);
  return value <= 1_000 ? { ok: true, value } : { ok: false };
}

async function usage(request, env) {
  const session = await authenticate(request, env);
  if (!session) return json({ error: '로그인이 필요합니다.' }, 401);
  // 비소유자에게는 **존재를 숨긴다** — 라우트가 없을 때와 같은 404를 준다.
  // 403이면 "여기 뭔가 있다"는 사실이 새어 나간다 (review WP1 M-5).
  if (!isOwnerSession(session, env)) return json({ error: 'Not found' }, 404);
  const completedLimit = completedTaskLimit(request);
  if (!completedLimit.ok) return json({ error: '잘못된 완료 작업 제한입니다.' }, 400);

  // 필터 목록을 손으로 적지 않는다 — ingest 허용 집합에서 그대로 도출한다.
  const sources = [...VALID_USAGE_SOURCES];
  const sourcePlaceholders = sources.map(() => '?').join(', ');
  const rows = await env.DB.prepare(`
    SELECT source, captured_at, payload, last_success_at, last_attempt_at, last_outcome
    FROM (
      SELECT snapshots.source, snapshots.captured_at, snapshots.payload,
        health.last_success_at, health.last_attempt_at, health.last_outcome
      FROM usage_snapshots AS snapshots
      LEFT JOIN usage_source_health AS health ON health.source = snapshots.source
      WHERE snapshots.source IN (${sourcePlaceholders})
      UNION ALL
      SELECT health.source, NULL AS captured_at, NULL AS payload,
        health.last_success_at, health.last_attempt_at, health.last_outcome
      FROM usage_source_health AS health
      LEFT JOIN usage_snapshots AS snapshots ON snapshots.source = health.source
      WHERE health.source IN (${sourcePlaceholders}) AND snapshots.source IS NULL
    )
    ORDER BY source
  `).bind(...sources, ...sources).all();
  const taskRows = await env.DB.prepare(`
    SELECT task_id, status, updated_at, payload, title, input, heartbeat_at
    FROM harness_tasks
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, datetime(updated_at) DESC
  `).all();
  const eventRows = await env.DB.prepare(`
    SELECT task_id, id, ts, kind, actor_id, phase, percent, model, reasoning, status,
      usage_codex, usage_claude
    FROM (
      SELECT task_id, id, ts, kind, actor_id, phase, percent, model, reasoning, status,
        usage_codex, usage_claude,
        ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY id DESC) AS task_rank
      FROM harness_events
    )
    WHERE task_rank <= 300
    ORDER BY task_id ASC, id ASC
  `).all();
  const eventsByTask = new Map();
  for (const row of eventRows.results || []) {
    const events = eventsByTask.get(row.task_id) || [];
    events.push({
      ts: row.ts,
      kind: row.kind,
      actor_id: row.actor_id,
      phase: row.phase,
      percent: row.percent,
      model: row.model,
      reasoning: row.reasoning,
      status: row.status,
      usage_codex: row.usage_codex,
      usage_claude: row.usage_claude,
    });
    eventsByTask.set(row.task_id, events);
  }
  const parsedTasks = taskRows.results.flatMap((row) => {
    try {
      const payload = JSON.parse(row.payload);
      if (!payload || typeof payload !== 'object') return [];
      const hydrated = {
        ...payload,
        title: payload.title || row.title || payload.name,
        // 출처 플래그는 payload에 실려 있을 때만 참이다. 없는 행(플래그 이전에 저장된
        // 것)은 false로 나가고, 화면은 그 경우에만 예전의 `title !== name` 추정으로
        // 떨어진다 — 새 계약이 옛 행의 지정 제목을 소급해 지우지 않는다.
        title_authored: payload.title_authored === true,
        input: payload.input || row.input || '',
        heartbeat_at: payload.heartbeat_at || row.heartbeat_at || payload.updated_at || row.updated_at,
      };
      return [{
        row,
        payload: {
          ...hydrated,
          status: effectiveHarnessStatus(hydrated, row.status),
          events: eventsByTask.get(row.task_id) || [],
        },
      }];
    } catch {
      return [];
    }
  });
  const limitedTasks = completedLimit.value === null
    ? parsedTasks
    : [
      ...parsedTasks.filter(({ row }) => row.status !== 'complete'),
      ...parsedTasks
        .filter(({ row }) => row.status === 'complete')
        .sort((left, right) => {
          const leftTime = Date.parse(left.payload.completed_at || left.row.updated_at || '') || 0;
          const rightTime = Date.parse(right.payload.completed_at || right.row.updated_at || '') || 0;
          return rightTime - leftTime || String(left.row.task_id).localeCompare(String(right.row.task_id));
        })
        .slice(0, completedLimit.value),
    ];
  return json({
    snapshots: rows.results.filter((row) => VALID_USAGE_SOURCES.has(row.source)).map((row) => {
      // 손상된 행 하나가 조회 전체를 500으로 만들지 않게 한다 — 그 행만 payload를 낮춘다.
      let payload = null;
      try { payload = JSON.parse(row.payload); } catch { payload = null; }
      return {
        source: row.source,
        captured_at: row.captured_at,
        payload,
        last_success_at: row.last_success_at || row.captured_at,
        last_attempt_at: row.last_attempt_at || row.captured_at,
        last_outcome: row.last_outcome || 'legacy',
      };
    }),
    tasks: limitedTasks.map(({ payload }) => payload),
  });
}

function moderatorError(error, status = 400) {
  return json({ error }, status);
}

async function readModeratorJson(request) {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_MODERATOR_BODY_BYTES) {
    return { response: moderatorError('request_too_large', 413) };
  }
  if (!request.body) return { response: moderatorError('invalid_json') };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MODERATOR_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* The 413 response is still authoritative. */ }
        return { response: moderatorError('request_too_large', 413) };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = JSON.parse(moderatorDecoder.decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { response: moderatorError('invalid_json') };
    }
    return { value };
  } catch {
    return { response: moderatorError('invalid_json') };
  }
}

function moderatorChanges(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function moderatorId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function moderatorSummary(value, required = true) {
  if (value === undefined || value === null) return required ? null : '';
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if ((required && !normalized) || [...normalized].length > MAX_MODERATOR_SUMMARY_LENGTH) return null;
  return normalized;
}

function moderatorCommand(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || usageTokenEncoder.encode(normalized).byteLength > MAX_MODERATOR_COMMAND_BYTES) {
    return null;
  }
  return normalized;
}

function moderatorFact(value, maxLength = 120) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, value: null };
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized || [...normalized].length > maxLength) return { ok: false, value: null };
  return { ok: true, value: normalized };
}

function moderatorReasoning(value) {
  const fact = moderatorFact(value, 20);
  if (!fact.ok || (fact.value !== null && !VALID_MODERATOR_REASONING.has(fact.value))) {
    return { ok: false, value: null };
  }
  return fact;
}

function moderatorModelFacts(modelValue, reasoningValue) {
  const model = moderatorFact(modelValue);
  const reasoning = moderatorReasoning(reasoningValue);
  if (!model.ok || !reasoning.ok || (reasoning.value !== null && model.value === null)) {
    return null;
  }
  return { model: model.value, reasoning: reasoning.value };
}

function moderatorTimestamp() {
  return new Date(now()).toISOString();
}

function moderatorCursor(row) {
  const value = JSON.stringify({ version: 1, updated_at: row.updated_at, item_id: row.item_id });
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function parseModeratorCursor(value) {
  if (!value || value.length > MAX_MODERATOR_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return null;
  }
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const decoded = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    if (decoded?.version !== 1
      || typeof decoded.updated_at !== 'string'
      || !Number.isFinite(Date.parse(decoded.updated_at))
      || typeof decoded.item_id !== 'string'
      || !MODERATOR_ID_PATTERN.test(decoded.item_id)) return null;
    return { updatedAt: decoded.updated_at, itemId: decoded.item_id };
  } catch {
    return null;
  }
}

function moderatorListQuery(request) {
  const params = new URL(request.url).searchParams;
  const limits = params.getAll('limit');
  const cursors = params.getAll('cursor');
  if (limits.length > 1 || cursors.length > 1) return null;
  const limitText = limits[0];
  const limit = limitText === undefined ? 50 : Number(limitText);
  if (limitText !== undefined && (!/^[1-9]\d{0,2}$/u.test(limitText) || limit > 100)) return null;
  const cursor = cursors.length === 0 ? null : parseModeratorCursor(cursors[0]);
  if (cursors.length === 1 && cursor === null) return null;
  return { limit, cursor };
}

function parseModeratorEvent(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload); } catch { payload = {}; }
  return {
    id: row.id,
    event: row.event,
    version: row.version,
    occurred_at: row.occurred_at,
    payload,
  };
}

function serializeModeratorItem(row, events = []) {
  if (!row) return null;
  return {
    item_id: row.item_id,
    kind: row.kind,
    status: row.status,
    issue_summary: row.issue_summary,
    action_summary: row.action_summary,
    proposed_command: row.proposed_command ?? null,
    version: row.version,
    brain_model: row.brain_model ?? null,
    brain_reasoning: row.brain_reasoning ?? null,
    worker_model: row.worker_model ?? null,
    worker_reasoning: row.worker_reasoning ?? null,
    source_task_id: row.source_task_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    decided_at: row.decided_at ?? null,
    events,
  };
}

function serializeModeratorCommand(row) {
  if (!row) return null;
  return {
    command_id: row.command_id,
    source: row.source,
    source_item_id: row.source_item_id ?? null,
    idempotency_key: row.idempotency_key,
    command_text: row.command_text,
    status: row.status,
    attempts: row.attempts,
    requested_model: row.requested_model ?? null,
    requested_reasoning: row.requested_reasoning ?? null,
    actual_model: row.actual_model ?? null,
    actual_reasoning: row.actual_reasoning ?? null,
    issue_summary: row.issue_summary ?? null,
    action_summary: row.action_summary ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at ?? null,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
  };
}

async function moderatorOwner(request, env) {
  const session = await authenticate(request, env);
  if (!session) return { response: moderatorError('authentication_required', 401) };
  if (!isOwnerSession(session, env)) return { response: moderatorError('Not found', 404) };
  return { session };
}

async function moderatorDaemonAuthorized(request, env) {
  return ingestTokenMatches(request, env.MODERATOR_DAEMON_TOKEN);
}

async function moderatorActiveTaskCount(env, at = moderatorTimestamp()) {
  const cutoff = new Date(Date.parse(at) - HARNESS_STALE_MS).toISOString();
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM harness_tasks
    WHERE status = 'active'
      AND julianday(COALESCE(NULLIF(heartbeat_at, ''), updated_at)) > julianday(?1)
  `).bind(cutoff).first();
  return Number(row?.count || 0);
}

async function moderatorActiveCommandCount(env) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM moderator_commands
    WHERE status IN ('queued', 'claimed', 'running')
  `).first();
  return Number(row?.count || 0);
}

async function moderatorActiveReviewLeaseCount(env, at = moderatorTimestamp()) {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM moderator_items
    WHERE kind = 'review' AND status = 'running'
      AND julianday(lease_until) > julianday(?1)
  `).bind(at).first();
  return Number(row?.count || 0);
}

async function moderatorDaemonCounts(env, at = moderatorTimestamp()) {
  const [effectiveActiveTasks, activeCommands, reviewLeases] = await Promise.all([
    moderatorActiveTaskCount(env, at),
    moderatorActiveCommandCount(env),
    moderatorActiveReviewLeaseCount(env, at),
  ]);
  return {
    version: 1,
    effective_active_tasks: effectiveActiveTasks,
    active_commands: activeCommands,
    review_leases: reviewLeases,
  };
}

async function moderatorItemById(env, itemId) {
  return env.DB.prepare('SELECT * FROM moderator_items WHERE item_id = ?1')
    .bind(itemId)
    .first();
}

async function moderatorCommandBySourceItem(env, itemId) {
  return env.DB.prepare('SELECT * FROM moderator_commands WHERE source_item_id = ?1')
    .bind(itemId)
    .first();
}

async function getModerator(request, env) {
  const owner = await moderatorOwner(request, env);
  if (owner.response) return owner.response;
  const query = moderatorListQuery(request);
  if (!query) return moderatorError('invalid_pagination');

  const itemStatement = query.cursor
    ? env.DB.prepare(`
      SELECT * FROM moderator_items
      WHERE updated_at < ?1 OR (updated_at = ?1 AND item_id < ?2)
      ORDER BY updated_at DESC, item_id DESC
      LIMIT ?3
    `).bind(query.cursor.updatedAt, query.cursor.itemId, query.limit + 1)
    : env.DB.prepare(`
      SELECT * FROM moderator_items
      ORDER BY updated_at DESC, item_id DESC
      LIMIT ?1
    `).bind(query.limit + 1);
  const itemRows = await itemStatement.all();
  const pageRows = (itemRows.results || []).slice(0, query.limit);
  const eventsByItem = new Map();
  if (pageRows.length > 0) {
    const placeholders = pageRows.map(() => '?').join(', ');
    const eventRows = await env.DB.prepare(`
      SELECT id, item_id, event, version, occurred_at, payload
      FROM moderator_item_events
      WHERE item_id IN (${placeholders})
      ORDER BY item_id ASC, id ASC
    `).bind(...pageRows.map((row) => row.item_id)).all();
    for (const row of eventRows.results || []) {
      const events = eventsByItem.get(row.item_id) || [];
      events.push(parseModeratorEvent(row));
      eventsByItem.set(row.item_id, events);
    }
  }

  const [commandRows, countRows, brainRow, activeSessions, activeCommands] = await Promise.all([
    env.DB.prepare(`
      SELECT * FROM moderator_commands
      ORDER BY updated_at DESC, command_id DESC
      LIMIT 50
    `).all(),
    env.DB.prepare(`
      SELECT kind, status, COUNT(*) AS count
      FROM moderator_items
      GROUP BY kind, status
      ORDER BY kind, status
    `).all(),
    env.DB.prepare(`
      SELECT brain_model, brain_reasoning, worker_model, worker_reasoning, updated_at
      FROM moderator_items
      WHERE brain_model IS NOT NULL OR worker_model IS NOT NULL
      ORDER BY updated_at DESC, item_id DESC
      LIMIT 1
    `).first(),
    moderatorActiveTaskCount(env),
    moderatorActiveCommandCount(env),
  ]);
  const counts = { important: {}, proposal: {}, review: {} };
  for (const row of countRows.results || []) {
    if (counts[row.kind]) counts[row.kind][row.status] = Number(row.count || 0);
  }
  const hasNext = (itemRows.results || []).length > query.limit;
  return json({
    brain: {
      model: brainRow?.brain_model ?? null,
      reasoning: brainRow?.brain_reasoning ?? null,
      worker_model: brainRow?.worker_model ?? null,
      worker_reasoning: brainRow?.worker_reasoning ?? null,
      updated_at: brainRow?.updated_at ?? null,
    },
    active_sessions: activeSessions,
    active_commands: activeCommands,
    counts,
    commands: (commandRows.results || []).map(serializeModeratorCommand),
    items: pageRows.map((row) => serializeModeratorItem(row, eventsByItem.get(row.item_id) || [])),
    next_cursor: hasNext ? moderatorCursor(pageRows.at(-1)) : null,
  });
}

async function createModeratorCommand(request, env) {
  const owner = await moderatorOwner(request, env);
  if (owner.response) return owner.response;
  const parsed = await readModeratorJson(request);
  if (parsed.response) return parsed.response;
  const input = parsed.value;
  const commandText = moderatorCommand(input.command);
  const idempotencyKey = typeof input.idempotency_key === 'string'
    ? input.idempotency_key.trim()
    : '';
  if (!commandText || !MODERATOR_IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    return moderatorError('invalid_command');
  }
  const timestamp = moderatorTimestamp();
  const commandId = moderatorId('cmd');
  const inserted = await env.DB.prepare(`
    INSERT INTO moderator_commands(
      command_id, source, source_item_id, idempotency_key, command_text, status,
      attempts, requested_model, requested_reasoning, created_at, updated_at
    ) VALUES (?1, 'direct', NULL, ?2, ?3, 'queued', 0, ?4, ?5, ?6, ?6)
    ON CONFLICT(idempotency_key) DO NOTHING
    RETURNING *
  `).bind(
    commandId,
    idempotencyKey,
    commandText,
    MODERATOR_REQUESTED_MODEL,
    MODERATOR_REQUESTED_REASONING,
    timestamp,
  ).first();
  if (inserted) return json({ command: serializeModeratorCommand(inserted), duplicate: false }, 201);

  const existing = await env.DB.prepare('SELECT * FROM moderator_commands WHERE idempotency_key = ?1')
    .bind(idempotencyKey)
    .first();
  if (!existing || existing.source !== 'direct' || existing.command_text !== commandText) {
    return moderatorError('idempotency_conflict', 409);
  }
  return json({ command: serializeModeratorCommand(existing), duplicate: true });
}

async function decideModeratorItem(request, env, itemId) {
  const owner = await moderatorOwner(request, env);
  if (owner.response) return owner.response;
  if (!MODERATOR_ID_PATTERN.test(itemId)) return moderatorError('invalid_item');
  const parsed = await readModeratorJson(request);
  if (parsed.response) return parsed.response;
  const input = parsed.value;
  const action = typeof input.action === 'string' ? input.action : '';
  if (!['approve', 'reject', 'edit'].includes(action)) return moderatorError('invalid_decision');
  const timestamp = moderatorTimestamp();
  let update;
  if (action === 'approve') {
    update = env.DB.prepare(MODERATOR_PROPOSAL_APPROVE_SQL).bind(itemId, timestamp);
  } else if (action === 'reject') {
    update = env.DB.prepare(`
      UPDATE moderator_items
      SET status = 'rejected', version = version + 1, updated_at = ?2, decided_at = ?2
      WHERE item_id = ?1 AND kind = 'proposal' AND status = 'pending'
    `).bind(itemId, timestamp);
  } else {
    const editedCommand = moderatorCommand(input.edited_command);
    if (!editedCommand) return moderatorError('invalid_command');
    update = env.DB.prepare(`
      UPDATE moderator_items
      SET proposed_command = ?2, version = version + 1, updated_at = ?3
      WHERE item_id = ?1 AND kind = 'proposal' AND status = 'pending'
    `).bind(itemId, editedCommand, timestamp);
  }
  const payload = JSON.stringify(action === 'edit'
    ? { action, command_changed: true }
    : { action });
  const statements = [
    update,
    env.DB.prepare(MODERATOR_ITEM_EVENT_AFTER_CHANGE_SQL)
      .bind(itemId, action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'edited', timestamp, payload),
  ];
  if (action === 'approve') {
    const commandId = moderatorId('cmd');
    statements.push(env.DB.prepare(MODERATOR_PROPOSAL_COMMAND_AFTER_EVENT_SQL).bind(
      commandId,
      `proposal:${itemId}`,
      MODERATOR_REQUESTED_MODEL,
      MODERATOR_REQUESTED_REASONING,
      timestamp,
      itemId,
    ));
  }
  const results = await env.DB.batch(statements);
  if (moderatorChanges(results[0]) !== 1) return moderatorError('invalid_transition', 409);
  const item = await moderatorItemById(env, itemId);
  const command = action === 'approve' ? await moderatorCommandBySourceItem(env, itemId) : null;
  return json({ item: serializeModeratorItem(item), command: serializeModeratorCommand(command) });
}

async function acknowledgeModeratorItem(request, env, itemId) {
  const owner = await moderatorOwner(request, env);
  if (owner.response) return owner.response;
  if (!MODERATOR_ID_PATTERN.test(itemId)) return moderatorError('invalid_item');
  const timestamp = moderatorTimestamp();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE moderator_items
      SET status = 'acknowledged', version = version + 1, updated_at = ?2
      WHERE item_id = ?1 AND kind = 'important' AND status = 'open'
    `).bind(itemId, timestamp),
    env.DB.prepare(MODERATOR_ITEM_EVENT_AFTER_CHANGE_SQL)
      .bind(itemId, 'acknowledged', timestamp, JSON.stringify({ action: 'acknowledge' })),
  ]);
  if (moderatorChanges(results[0]) !== 1) return moderatorError('invalid_transition', 409);
  return json({ item: serializeModeratorItem(await moderatorItemById(env, itemId)) });
}

async function closeModeratorDaemonItem(request, env, itemId) {
  if (!(await moderatorDaemonAuthorized(request, env))) {
    return moderatorError('daemon_unauthorized', 401);
  }
  if (!MODERATOR_ID_PATTERN.test(itemId)) return moderatorError('invalid_item');
  const parsed = await readModeratorJson(request);
  if (parsed.response) return parsed.response;
  const reason = moderatorSummary(parsed.value.reason);
  if (!reason) return moderatorError('invalid_reason');

  const item = await moderatorItemById(env, itemId);
  if (!item) return moderatorError('Not found', 404);
  if (item.kind === 'review') return moderatorError('invalid_transition');

  const transition = item.kind === 'important' && item.status === 'open'
    ? { from: 'open', to: 'resolved' }
    : item.kind === 'proposal' && item.status === 'pending'
      ? { from: 'pending', to: 'rejected' }
      : null;
  if (!transition) return moderatorError('invalid_transition', 409);

  const timestamp = moderatorTimestamp();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE moderator_items
      SET status = ?4, version = version + 1, updated_at = ?5, decided_at = ?5
      WHERE item_id = ?1 AND kind = ?2 AND status = ?3
    `).bind(itemId, item.kind, transition.from, transition.to, timestamp),
    env.DB.prepare(MODERATOR_ITEM_EVENT_AFTER_CHANGE_SQL).bind(
      itemId,
      transition.to,
      timestamp,
      JSON.stringify({ action: transition.to, reason, by: 'moderator-daemon' }),
    ),
  ]);
  if (moderatorChanges(results[0]) !== 1) return moderatorError('invalid_transition', 409);
  return json({ item: serializeModeratorItem(await moderatorItemById(env, itemId)) });
}

function normalizeDaemonItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const kind = typeof input.kind === 'string' ? input.kind : '';
  const itemId = input.item_id === undefined ? moderatorId('item') : String(input.item_id);
  const issueSummary = moderatorSummary(input.issue_summary);
  const actionSummary = moderatorSummary(input.action_summary);
  const proposedCommand = input.proposed_command === undefined
    ? null
    : moderatorCommand(input.proposed_command);
  const brain = moderatorModelFacts(input.brain_model, input.brain_reasoning);
  const worker = moderatorModelFacts(input.worker_model, input.worker_reasoning);
  const sourceTask = moderatorFact(input.source_task_id);
  const reviewLease = moderatorFact(input.review_lease_id, 160);
  const defaultStatus = kind === 'important' ? 'open' : kind === 'proposal' ? 'pending' : '';
  const status = input.status === undefined ? defaultStatus : String(input.status);
  if (!VALID_MODERATOR_KINDS.has(kind)
    || !MODERATOR_ID_PATTERN.test(itemId)
    || !issueSummary
    || !actionSummary
    || !brain
    || !worker
    || !sourceTask.ok
    || !reviewLease.ok
    || (kind === 'proposal' ? !proposedCommand : proposedCommand !== null)) return null;
  return {
    itemId,
    kind,
    status,
    issueSummary,
    actionSummary,
    proposedCommand,
    brain,
    worker,
    sourceTaskId: sourceTask.value,
    reviewLeaseId: reviewLease.value,
  };
}

async function createOrUpdateDaemonItem(request, env) {
  if (!(await moderatorDaemonAuthorized(request, env))) {
    return moderatorError('daemon_unauthorized', 401);
  }
  const parsed = await readModeratorJson(request);
  if (parsed.response) return parsed.response;
  const normalized = normalizeDaemonItem(parsed.value);
  if (!normalized) return moderatorError('invalid_item');
  const timestamp = moderatorTimestamp();
  const existing = await moderatorItemById(env, normalized.itemId);
  if (existing) {
    if (existing.kind !== 'review' || normalized.kind !== 'review'
      || !['running', 'done', 'failed', 'escalated'].includes(normalized.status)
      || !normalized.reviewLeaseId) return moderatorError('item_conflict', 409);
    const refreshedUntil = new Date(Date.parse(timestamp) + MODERATOR_REVIEW_LEASE_MS).toISOString();
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE moderator_items
        SET status = ?2, issue_summary = ?3, action_summary = ?4,
            brain_model = ?5, brain_reasoning = ?6,
            worker_model = ?7, worker_reasoning = ?8,
            source_task_id = ?9, version = version + 1, updated_at = ?10,
            lease_until = CASE WHEN ?2 = 'running' THEN ?11 ELSE lease_until END,
            decided_at = CASE WHEN ?2 IN ('done', 'failed', 'escalated') THEN ?10 ELSE decided_at END
        WHERE item_id = ?1 AND kind = 'review' AND status = 'running'
          AND lease_id = ?12 AND julianday(lease_until) > julianday(?10)
      `).bind(
        normalized.itemId,
        normalized.status,
        normalized.issueSummary,
        normalized.actionSummary,
        normalized.brain.model,
        normalized.brain.reasoning,
        normalized.worker.model,
        normalized.worker.reasoning,
        normalized.sourceTaskId,
        timestamp,
        refreshedUntil,
        normalized.reviewLeaseId,
      ),
      env.DB.prepare(MODERATOR_ITEM_EVENT_AFTER_CHANGE_SQL).bind(
        normalized.itemId,
        normalized.status === 'running' ? 'lease_refreshed' : normalized.status,
        timestamp,
        JSON.stringify({ status: normalized.status }),
      ),
    ]);
    if (moderatorChanges(results[0]) !== 1) return moderatorError('invalid_transition', 409);
    return json({ item: serializeModeratorItem(await moderatorItemById(env, normalized.itemId)), duplicate: false });
  }

  const validInitial = (normalized.kind === 'important' && normalized.status === 'open')
    || (normalized.kind === 'proposal' && normalized.status === 'pending');
  if (!validInitial || normalized.reviewLeaseId !== null) return moderatorError('invalid_transition');
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO moderator_items(
        item_id, kind, status, issue_summary, action_summary, proposed_command, version,
        brain_model, brain_reasoning, worker_model, worker_reasoning, source_task_id,
        created_at, updated_at, decided_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13)
      ON CONFLICT(item_id) DO NOTHING
    `).bind(
      normalized.itemId,
      normalized.kind,
      normalized.status,
      normalized.issueSummary,
      normalized.actionSummary,
      normalized.proposedCommand,
      normalized.brain.model,
      normalized.brain.reasoning,
      normalized.worker.model,
      normalized.worker.reasoning,
      normalized.sourceTaskId,
      timestamp,
      normalized.kind === 'review' ? timestamp : null,
    ),
    env.DB.prepare(MODERATOR_ITEM_EVENT_AFTER_CHANGE_SQL)
      .bind(normalized.itemId, 'created', timestamp, JSON.stringify({ kind: normalized.kind })),
  ]);
  if (moderatorChanges(results[0]) !== 1) return moderatorError('item_conflict', 409);
  return json({ item: serializeModeratorItem(await moderatorItemById(env, normalized.itemId)), duplicate: false }, 201);
}

async function claimModeratorCommand(request, env) {
  if (!(await moderatorDaemonAuthorized(request, env))) {
    return moderatorError('daemon_unauthorized', 401);
  }
  const timestamp = moderatorTimestamp();
  await env.DB.prepare(`
    UPDATE moderator_commands
    SET status = CASE
          WHEN status = 'claimed' AND attempts < 2 THEN 'queued'
          ELSE 'failed'
        END,
        lease_id = CASE
          WHEN status = 'claimed' AND attempts < 2 THEN NULL
          ELSE lease_id
        END,
        lease_until = NULL,
        issue_summary = CASE
          WHEN status = 'claimed' AND attempts < 2 THEN issue_summary
          ELSE COALESCE(issue_summary, 'Command lease expired')
        END,
        action_summary = CASE
          WHEN status = 'claimed' AND attempts < 2 THEN action_summary
          ELSE COALESCE(action_summary, 'Execution stopped without a valid lease')
        END,
        completed_at = CASE
          WHEN status = 'claimed' AND attempts < 2 THEN completed_at
          ELSE ?1
        END,
        updated_at = ?1
    WHERE status IN ('claimed', 'running') AND julianday(lease_until) <= julianday(?1)
  `).bind(timestamp).run();
  const leaseId = moderatorId('lease');
  const leaseUntil = new Date(Date.parse(timestamp) + MODERATOR_COMMAND_LEASE_MS).toISOString();
  const command = await env.DB.prepare(MODERATOR_COMMAND_CLAIM_SQL)
    .bind(timestamp, leaseId, leaseUntil)
    .first();
  const counts = await moderatorDaemonCounts(env, timestamp);
  return json({
    command: command ? { ...serializeModeratorCommand(command), lease_id: command.lease_id, lease_until: command.lease_until } : null,
    counts,
    active_task_count: counts.effective_active_tasks,
  });
}

async function updateModeratorCommandState(request, env, commandId) {
  if (!(await moderatorDaemonAuthorized(request, env))) {
    return moderatorError('daemon_unauthorized', 401);
  }
  if (!MODERATOR_ID_PATTERN.test(commandId)) return moderatorError('invalid_command');
  const parsed = await readModeratorJson(request);
  if (parsed.response) return parsed.response;
  const input = parsed.value;
  const state = typeof input.state === 'string' ? input.state : '';
  const leaseId = typeof input.lease_id === 'string' ? input.lease_id : '';
  if (!['running', 'succeeded', 'failed'].includes(state) || !MODERATOR_ID_PATTERN.test(leaseId)) {
    return moderatorError('invalid_state');
  }
  const timestamp = moderatorTimestamp();
  let updated;
  if (state === 'running') {
    const leaseUntil = new Date(Date.parse(timestamp) + MODERATOR_COMMAND_LEASE_MS).toISOString();
    updated = await env.DB.prepare(`
      UPDATE moderator_commands
      SET status = 'running', lease_until = ?3, started_at = COALESCE(started_at, ?2), updated_at = ?2
      WHERE command_id = ?1 AND status IN ('claimed', 'running')
        AND lease_id = ?4 AND julianday(lease_until) > julianday(?2)
      RETURNING *
    `).bind(commandId, timestamp, leaseUntil, leaseId).first();
  } else {
    const issueSummary = moderatorSummary(input.issue_summary);
    const actionSummary = moderatorSummary(input.action_summary);
    const actual = moderatorModelFacts(input.actual_model, input.actual_reasoning);
    if (!issueSummary || !actionSummary || !actual) return moderatorError('invalid_result');
    updated = await env.DB.prepare(`
      UPDATE moderator_commands
      SET status = ?2, lease_until = NULL, actual_model = ?4, actual_reasoning = ?5,
          issue_summary = ?6, action_summary = ?7, completed_at = ?3, updated_at = ?3
      WHERE command_id = ?1 AND status = 'running'
        AND lease_id = ?8 AND julianday(lease_until) > julianday(?3)
      RETURNING *
    `).bind(
      commandId,
      state,
      timestamp,
      actual.model,
      actual.reasoning,
      issueSummary,
      actionSummary,
      leaseId,
    ).first();
  }
  if (!updated) return moderatorError('invalid_transition_or_lease', 409);
  return json({ command: serializeModeratorCommand(updated) });
}

async function expireModeratorReviewLease(env, timestamp) {
  const stale = await env.DB.prepare(`
    SELECT item_id
    FROM moderator_items
    WHERE kind = 'review' AND status = 'running'
      AND julianday(lease_until) <= julianday(?1)
    ORDER BY updated_at ASC, item_id ASC
    LIMIT 1
  `).bind(timestamp).first();
  if (!stale) return false;
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE moderator_items
      SET status = 'failed', action_summary = 'Review lease expired before completion',
          version = version + 1, updated_at = ?2, decided_at = ?2
      WHERE item_id = ?1 AND kind = 'review' AND status = 'running'
        AND julianday(lease_until) <= julianday(?2)
    `).bind(stale.item_id, timestamp),
    env.DB.prepare(MODERATOR_ITEM_EVENT_AFTER_CHANGE_SQL).bind(
      stale.item_id,
      'lease_expired',
      timestamp,
      JSON.stringify({ status: 'failed' }),
    ),
  ]);
  return moderatorChanges(results[0]) === 1;
}

async function acquireModeratorReviewLease(request, env) {
  if (!(await moderatorDaemonAuthorized(request, env))) {
    return moderatorError('daemon_unauthorized', 401);
  }
  const timestamp = moderatorTimestamp();
  await expireModeratorReviewLease(env, timestamp);
  const activeCutoff = new Date(Date.parse(timestamp) - HARNESS_STALE_MS).toISOString();
  const leaseUntil = new Date(Date.parse(timestamp) + MODERATOR_REVIEW_LEASE_MS).toISOString();
  const itemId = moderatorId('review');
  const leaseId = moderatorId('lease');
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(`
      INSERT INTO moderator_items(
        item_id, kind, status, issue_summary, action_summary, proposed_command, version,
        lease_id, lease_until, created_at, updated_at
      )
      SELECT ?1, 'review', 'running', 'Idle review started', 'Review in progress', NULL, 1,
        ?2, ?3, ?4, ?4
      WHERE NOT EXISTS (
        SELECT 1 FROM harness_tasks
        WHERE status = 'active'
          AND julianday(COALESCE(NULLIF(heartbeat_at, ''), updated_at)) > julianday(?5)
      )
        AND NOT EXISTS (
          SELECT 1 FROM moderator_commands WHERE status IN ('queued', 'claimed', 'running')
        )
        AND NOT EXISTS (
          SELECT 1 FROM moderator_items
          WHERE kind = 'review' AND status IN ('queued', 'running')
        )
      `).bind(itemId, leaseId, leaseUntil, timestamp, activeCutoff),
      env.DB.prepare(MODERATOR_ITEM_EVENT_AFTER_CHANGE_SQL)
        .bind(itemId, 'lease_acquired', timestamp, JSON.stringify({ source: 'idle' })),
    ]);
  } catch (error) {
    if (!String(error?.message || error).includes('UNIQUE')) throw error;
    results = [];
  }
  const item = moderatorChanges(results[0]) === 1 ? await moderatorItemById(env, itemId) : null;
  return json({
    lease: item ? {
      item_id: item.item_id,
      lease_id: item.lease_id,
      lease_until: item.lease_until,
      project_key: MODERATOR_REVIEW_PROJECT.project_key,
    } : null,
    active_task_count: await moderatorActiveTaskCount(env, timestamp),
    active_command_count: await moderatorActiveCommandCount(env),
  });
}

function gichulError(message, status) {
  return json({ error: message }, status, GICHUL_HEADERS);
}

async function gichulSession(request, env) {
  const session = await authenticate(request, env);
  return session || null;
}

async function storedGichulManifest(env) {
  const object = await env.GICHUL.get('manifest.json');
  if (!object) return null;
  return object;
}

async function gichulManifest(request, env) {
  if (!(await gichulSession(request, env))) {
    return gichulError('로그인이 필요합니다.', 401);
  }
  const object = await storedGichulManifest(env);
  if (!object) return gichulError('Not found', 404);
  return new Response(object.body, {
    headers: {
      ...GICHUL_HEADERS,
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

async function gichulPdf(request, env, id) {
  if (!(await gichulSession(request, env))) {
    return gichulError('로그인이 필요합니다.', 401);
  }
  if (!/^[a-z0-9_-]{1,160}$/u.test(id)) return gichulError('Not found', 404);

  const manifestObject = await storedGichulManifest(env);
  if (!manifestObject) return gichulError('Not found', 404);
  const manifest = await manifestObject.json();
  if (!Array.isArray(manifest?.exams)) throw new Error('invalid_gichul_manifest');
  const exam = manifest.exams.find((candidate) => candidate?.id === id);
  const key = typeof exam?.r2_key === 'string' ? exam.r2_key : '';
  if (!key || key.startsWith('/') || key.split('/').includes('..')) {
    return gichulError('Not found', 404);
  }

  const object = await env.GICHUL.get(key);
  if (!object) return gichulError('Not found', 404);
  return new Response(object.body, {
    headers: {
      ...GICHUL_HEADERS,
      'content-type': 'application/pdf',
    },
  });
}

async function learningContent(request, env, app) {
  if (!(await gichulSession(request, env))) {
    return gichulError('로그인이 필요합니다.', 401);
  }
  const key = LEARNING_CONTENT_KEYS[app];
  if (!key) return gichulError('Not found', 404);
  const object = await env.GICHUL.get(key);
  if (!object) return gichulError('Not found', 404);
  return new Response(object.body, {
    headers: {
      ...GICHUL_HEADERS,
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

async function learningImage(request, env, name) {
  if (!(await gichulSession(request, env))) {
    return gichulError('로그인이 필요합니다.', 401);
  }
  if (!/^[a-z0-9-]{1,120}\.webp$/u.test(name)) return gichulError('Not found', 404);
  const object = await env.GICHUL.get(`learning/smstudy/kice/${name}`);
  if (!object) return gichulError('Not found', 404);
  return new Response(object.body, {
    headers: {
      ...GICHUL_HEADERS,
      'content-type': 'image/webp',
    },
  });
}

async function logout(request, env) {
  const rawToken = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (rawToken) {
    const timestamp = now();
    const ipAddress = clientIp(request);
    await env.DB.prepare(`
      UPDATE sessions
      SET expires_at = ?, last_seen_at = ?, ip_hash = ?, ip_address = ?, user_agent = ?
      WHERE token_hash = ?
    `)
      .bind(
        timestamp,
        timestamp,
        await sha256(ipAddress),
        ipAddress,
        (request.headers.get('user-agent') || '').slice(0, 240),
        await sha256(rawToken),
      )
      .run();
  }
  return json({ ok: true });
}

async function progress(request, env, app) {
  const session = await authenticate(request, env);
  if (!session) return json({ error: '로그인이 필요합니다.' }, 401);

  if (request.method === 'GET') {
    const row = await env.DB.prepare(`
      SELECT data, updated_at
      FROM progress
      WHERE user_id = ? AND app = ?
    `).bind(session.user_id, app).first();
    return json({
      data: row ? JSON.parse(row.data) : null,
      updatedAt: row?.updated_at || 0,
    });
  }

  if (request.method === 'PUT') {
    const input = await readJson(request);
    const rawData = JSON.stringify(input.data ?? {});
    if (rawData.length > MAX_PROGRESS_BYTES) {
      return json({ error: '기록이 너무 큽니다.' }, 413);
    }

    await env.DB.prepare(`
      INSERT INTO progress(user_id, app, data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, app)
      DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).bind(session.user_id, app, rawData, now()).run();
    await logActivity(env, session.user_id, 'progress_sync', app);
    return json({ ok: true });
  }

  return null;
}

async function sharedAnswers(request, env, app) {
  const session = await authenticate(request, env);
  if (!session) return json({ error: '로그인이 필요합니다.' }, 401);

  const rows = await env.DB.prepare(`
    SELECT question_id, display_answer
    FROM shared_answers
    WHERE app = ?
    ORDER BY created_at
  `).bind(app).all();
  return json({ answers: rows.results });
}

async function acceptAnswer(request, env) {
  const session = await authenticate(request, env);
  if (!session) return json({ error: '로그인이 필요합니다.' }, 401);

  const input = await readJson(request);
  const app = String(input.app);
  const questionId = String(input.questionId || '');
  const answer = String(input.answer || '').trim();
  const questionLabel = String(input.questionLabel || '').trim().slice(0, 300);
  const baseAnswer = String(input.baseAnswer || '').trim().slice(0, 500);

  if (!VALID_APPS.has(app) || !questionId || !answer || answer.length > 200) {
    return json({ error: '잘못된 답안입니다.' }, 400);
  }

  await env.DB.prepare(`
    INSERT INTO shared_answers(
      app, question_id, normalized_answer, display_answer,
      created_by, created_at, question_label, base_answer
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(app, question_id, normalized_answer)
    DO UPDATE SET
      question_label = CASE
        WHEN excluded.question_label != '' THEN excluded.question_label
        ELSE shared_answers.question_label
      END,
      base_answer = CASE
        WHEN excluded.base_answer != '' THEN excluded.base_answer
        ELSE shared_answers.base_answer
      END
  `).bind(
    app,
    questionId,
    normalizeAnswer(answer),
    answer,
    session.user_id,
    now(),
    questionLabel,
    baseAnswer,
  ).run();

  await logActivity(env, session.user_id, 'shared_answer', app, questionId);
  return json({ ok: true });
}

async function listUsers(env) {
  const currentTime = now();
  const rows = await env.DB.prepare(`
    SELECT
      u.id,
      u.username,
      u.created_at,
      u.last_login_at,
      (
        SELECT MAX(activity_session.last_seen_at)
        FROM sessions activity_session
        WHERE activity_session.user_id = u.id
          AND activity_session.role = 'user'
      ) last_activity_at,
      u.disabled,
      COALESCE(SUM(CASE WHEN a.event = 'login' THEN 1 ELSE 0 END), 0) logins,
      COUNT(DISTINCT CASE WHEN a.app = 'wordmaster' THEN a.id END) word_events,
      COUNT(DISTINCT CASE WHEN a.app = 'smstudy' THEN a.id END) sm_events,
      (
        SELECT COUNT(DISTINCT
          COALESCE(active_session.user_agent, '') || '|' ||
          COALESCE(active_session.ip_address, active_session.ip_hash, '')
        )
        FROM sessions active_session
        WHERE active_session.user_id = u.id
          AND active_session.role = 'user'
          AND active_session.expires_at > ?
      ) active_devices,
      (
        SELECT recent_session.ip_address
        FROM sessions recent_session
        WHERE recent_session.user_id = u.id
          AND recent_session.role = 'user'
          AND recent_session.last_seen_at > ?
        ORDER BY recent_session.last_seen_at DESC
        LIMIT 1
      ) recent_ip
    FROM users u
    LEFT JOIN activity a ON a.user_id = u.id
    GROUP BY u.id
    ORDER BY u.id DESC
  `).bind(currentTime, currentTime - SESSION_HISTORY_MS).all();
  return json({ users: rows.results });
}

async function listSessions(env) {
  const currentTime = now();
  await env.DB.prepare('DELETE FROM sessions WHERE last_seen_at <= ?')
    .bind(currentTime - SESSION_HISTORY_MS)
    .run();
  const rows = await env.DB.prepare(`
    SELECT
      s.user_id,
      u.username,
      s.created_at,
      s.expires_at,
      s.last_seen_at,
      s.ip_address,
      SUBSTR(s.ip_hash, 1, 12) ip_fingerprint,
      s.user_agent
    FROM sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.role = 'user' AND s.last_seen_at > ?
    ORDER BY s.last_seen_at DESC
    LIMIT 500
  `).bind(currentTime - SESSION_HISTORY_MS).all();

  return json({
    sessions: rows.results.map((session) => ({
      ...session,
      active: session.expires_at > currentTime,
    })),
  });
}

async function createUser(request, env) {
  const input = await readJson(request);
  const username = String(input.username || '').trim();
  const password = String(input.password || '');
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || password.length < 6) {
    return json({ error: '아이디 형식 또는 비밀번호 길이를 확인하세요.' }, 400);
  }

  const salt = createToken();
  try {
    const result = await env.DB.prepare(`
      INSERT INTO users(username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(username, await passwordHash(password, salt), salt, now()).run();
    return json({ ok: true, id: result.meta.last_row_id });
  } catch (error) {
    console.error('create_user', error);
    if (String(error?.message || error).includes('UNIQUE')) {
      return json({ error: '이미 존재하는 아이디입니다.' }, 409);
    }
    return json({ error: '사용자 생성에 실패했습니다.' }, 500);
  }
}

async function deleteUser(env, userId) {
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  return json({ ok: true });
}

async function adminStats(env) {
  const currentTime = now();
  const totals = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) users,
      (SELECT COUNT(*) FROM sessions WHERE expires_at > ${currentTime}) active_sessions,
      (SELECT COUNT(*) FROM activity WHERE created_at > ${currentTime - DAY_MS}) events_24h,
      (SELECT COUNT(*) FROM shared_answers) shared_answers,
      (
        SELECT COUNT(DISTINCT ip_address)
        FROM sessions
        WHERE role = 'user'
          AND ip_address IS NOT NULL
          AND ip_address != 'unknown'
          AND last_seen_at > ${currentTime - (30 * DAY_MS)}
      ) known_ips_30d
  `).first();
  const daily = await env.DB.prepare(`
    SELECT
      strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') day,
      COUNT(*) events,
      COUNT(DISTINCT user_id) users
    FROM activity
    WHERE created_at > ?
    GROUP BY day
    ORDER BY day
  `).bind(currentTime - (14 * DAY_MS)).all();
  return json({ totals, daily: daily.results });
}

async function adminAnswers(env) {
  const rows = await env.DB.prepare(`
    SELECT
      s.app,
      s.question_id,
      s.question_label,
      s.base_answer,
      s.display_answer,
      s.created_at,
      u.username
    FROM shared_answers s
    LEFT JOIN users u ON u.id = s.created_by
    ORDER BY s.created_at DESC
    LIMIT 500
  `).all();
  return json({ answers: rows.results });
}

async function adminRoute(request, env, path) {
  const session = await authenticate(request, env, 'admin');
  if (!session) return json({ error: '관리자 로그인이 필요합니다.' }, 401);

  if (request.method === 'GET' && path === '/api/admin/users') return listUsers(env);
  if (request.method === 'POST' && path === '/api/admin/users') return createUser(request, env);

  const userMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userMatch && request.method === 'DELETE') {
    return deleteUser(env, Number(userMatch[1]));
  }

  if (request.method === 'GET' && path === '/api/admin/stats') return adminStats(env);
  if (request.method === 'GET' && path === '/api/admin/sessions') return listSessions(env);
  if (request.method === 'GET' && path === '/api/admin/answers') return adminAnswers(env);
  return null;
}

export async function route(request, env) {
  const path = new URL(request.url).pathname;
  const { method } = request;

  if (method === 'POST' && path === '/api/login') return login(request, env);
  if (method === 'POST' && path === '/api/admin/login') return adminLogin(request, env);

  if (method === 'GET' && path === '/api/me') {
    const session = await authenticate(request, env);
    return session
      ? json({ user: { id: session.user_id, username: session.username } })
      : json({ error: '로그인이 필요합니다.' }, 401);
  }

  if (method === 'POST' && path === '/api/logout') return logout(request, env);
  if (method === 'POST' && path === '/api/usage/report') return reportUsage(request, env);
  if (method === 'POST' && path === '/api/harness/report') return reportHarness(request, env);
  if (method === 'GET' && path === '/api/usage') return usage(request, env);
  if (method === 'GET' && path === '/api/moderator') return getModerator(request, env);
  if (method === 'POST' && path === '/api/moderator/commands') {
    return createModeratorCommand(request, env);
  }
  if (method === 'POST' && path === '/api/moderator/daemon/claim') {
    return claimModeratorCommand(request, env);
  }
  if (method === 'POST' && path === '/api/moderator/daemon/items') {
    return createOrUpdateDaemonItem(request, env);
  }
  if (method === 'POST' && path === '/api/moderator/daemon/review-lease') {
    return acquireModeratorReviewLease(request, env);
  }
  const moderatorCommandStateMatch = path.match(/^\/api\/moderator\/daemon\/commands\/([^/]+)\/state$/u);
  if (method === 'POST' && moderatorCommandStateMatch) {
    return updateModeratorCommandState(request, env, moderatorCommandStateMatch[1]);
  }
  const moderatorDaemonCloseMatch = path.match(/^\/api\/moderator\/daemon\/items\/([^/]+)\/close$/u);
  if (method === 'POST' && moderatorDaemonCloseMatch) {
    return closeModeratorDaemonItem(request, env, moderatorDaemonCloseMatch[1]);
  }
  const moderatorDecisionMatch = path.match(/^\/api\/moderator\/items\/([^/]+)\/decision$/u);
  if (method === 'POST' && moderatorDecisionMatch) {
    return decideModeratorItem(request, env, moderatorDecisionMatch[1]);
  }
  const moderatorAcknowledgeMatch = path.match(/^\/api\/moderator\/items\/([^/]+)\/acknowledge$/u);
  if (method === 'POST' && moderatorAcknowledgeMatch) {
    return acknowledgeModeratorItem(request, env, moderatorAcknowledgeMatch[1]);
  }
  if (method === 'GET' && path === '/api/gichul/manifest') return gichulManifest(request, env);

  const learningContentMatch = path.match(/^\/api\/learning\/(wordmaster|smstudy)$/u);
  if (method === 'GET' && learningContentMatch) {
    return learningContent(request, env, learningContentMatch[1]);
  }

  const learningImageMatch = path.match(/^\/api\/learning\/smstudy\/image\/([^/]+)$/u);
  if (method === 'GET' && learningImageMatch) {
    return learningImage(request, env, learningImageMatch[1]);
  }

  const gichulPdfMatch = path.match(/^\/api\/gichul\/pdf\/(.+)$/u);
  if (method === 'GET' && gichulPdfMatch) {
    return gichulPdf(request, env, gichulPdfMatch[1]);
  }

  const progressMatch = path.match(/^\/api\/progress\/(wordmaster|smstudy)$/);
  if (progressMatch) {
    const response = await progress(request, env, progressMatch[1]);
    if (response) return response;
  }

  const answersMatch = path.match(/^\/api\/answers\/(wordmaster|smstudy)$/);
  if (answersMatch && method === 'GET') {
    return sharedAnswers(request, env, answersMatch[1]);
  }

  if (method === 'POST' && path === '/api/answers/accept') {
    return acceptAnswer(request, env);
  }

  if (path.startsWith('/api/admin/')) {
    const response = await adminRoute(request, env, path);
    if (response) return response;
  }

  return json({ error: 'Not found' }, 404);
}
