import {
  DAY_MS,
  authenticate,
  clientIp,
  createToken,
  issueSession,
  isOwnerSession,
  json,
  logActivity,
  normalizeAnswer,
  now,
  passwordHash,
  readJson,
  sha256,
} from './lib.js';
import {
  decideCompetitionApproval,
  getCompetitions,
  reportCompetitions,
} from './competitions.js';
import { BehaviorLabRequestError, getBehaviorLabDashboard } from './behavior-lab.js';

const MAX_PROGRESS_BYTES = 800_000;
// 사용량 스냅샷은 rate_limits 몇 개짜리 객체다. 상한이 없으면 ingest 토큰이 새거나
// 수집기 버그 하나로 D1 행이 무제한으로 부푼다.
const MAX_USAGE_BYTES = 64_000;
const MAX_HARNESS_BYTES = 64_000;
const MAX_HARNESS_INPUT_BYTES = 4_096;
const MAX_BEHAVIOR_PAPER_BYTES = 96_000;
export const MAX_MULTI_PAPER_BYTES = 282_000;
const MAX_ABC_EQUITY_CURVE_POINTS = 64;
const MAX_BEHAVIOR_PAPER_SEQUENCE = 1_000_000;
const MAX_BEHAVIOR_PAPER_TRADES = 25;
const MAX_BEHAVIOR_PAPER_LOGS = 50;
const MAX_BEHAVIOR_ADAPTIVE_CHALLENGERS = 8;
const MAX_BEHAVIOR_ADAPTIVE_AUDIT_LOGS = 20;
export const BEHAVIOR_PAPER_SESSION_ID = 'paper-20260831-100usd';
export const BEHAVIOR_PAPER_DEADLINE = '2026-08-30T23:00:00.000Z';
export const BEHAVIOR_PAPER_SNAPSHOT_SOURCE = `behavior-paper:${BEHAVIOR_PAPER_SESSION_ID}`;
export const BEHAVIOR_ABC_EXPERIMENT_ID = 'abc-paper-20260831';
export const BEHAVIOR_ABC_SNAPSHOT_SOURCE = `behavior-paper-experiment:${BEHAVIOR_ABC_EXPERIMENT_ID}`;
export const BEHAVIOR_MULTI_EXPERIMENT_ID = 'multi-paper-20260831-v2';
export const BEHAVIOR_MULTI_SNAPSHOT_SOURCE = `behavior-paper-experiment:${BEHAVIOR_MULTI_EXPERIMENT_ID}`;
const ABC_ARM_IDS = ['A', 'B', 'C'];
const ABC_STRATEGY_IDS = {
  A: 'abc-trend-momentum-v1', B: 'abc-breakout-volatility-v1', C: 'abc-mean-reversion-crowd-fade-v1',
};
const ABC_STRATEGY_LABELS = {
  A: 'Trend / momentum', B: 'Breakout / volatility', C: 'Mean reversion / crowd fade',
};
const MULTI_ARM_IDS = ['A', 'B', 'C', 'D', 'E', 'F'];
const MULTI_FEE_RATE = 6 / 10_000;
const MULTI_ADVERSE_SLIPPAGE_RATE = 4 / 10_000;
const MULTI_STRATEGIES = {
  A: { id: 'multi-trend-persistence-v2', label: 'Trend persistence',
    definition_hash: 'f7b99ba12e2daaa0545663c7b59944baa810641d366e7657b60fa530bab8b9e1', style: 'trend-continuation',
    allowed_regimes: ['trend-up', 'trend-down'], required_features: ['trendMomentum', 'orderFlow'],
    minimum_feature_agreement: 3, min_persistence_seconds: 4, entry_threshold: .34,
    max_spread_bps: 4, min_target_bps: 32, min_net_reward_risk: 1.25, cooldown_minutes: 10,
    opposite_confirmations: 2 },
  B: { id: 'multi-breakout-confirmation-v2', label: 'Breakout confirmation',
    definition_hash: 'f9007a599040a6ba220231e34b4c801e5189e3a7cc70bbe3d061e53e8c76e635', style: 'breakout-confirmation',
    allowed_regimes: ['trend-up', 'trend-down'], required_features: ['breakout', 'orderFlow'],
    minimum_feature_agreement: 3, min_persistence_seconds: 4, entry_threshold: .36,
    max_spread_bps: 3.5, min_target_bps: 35, min_net_reward_risk: 1.3, cooldown_minutes: 10,
    opposite_confirmations: 2 },
  C: { id: 'multi-range-reversion-v2', label: 'Range reversion',
    definition_hash: '638712041d66469b7ff7785f85e0b67e809c61a1ce582299ed373f425c51aacc', style: 'range-reversion',
    allowed_regimes: ['range'], required_features: ['meanReversion'], minimum_feature_agreement: 2,
    min_persistence_seconds: 4, entry_threshold: .34, max_spread_bps: 4, min_target_bps: 32,
    min_net_reward_risk: 1.2, cooldown_minutes: 10, opposite_confirmations: 2 },
  D: { id: 'multi-ofi-continuation-v2', label: 'Order-flow continuation',
    definition_hash: '3cfd6c22d0982e411bcbb95aff9323e861a9056877e916f83fb07d7d3c6e99e4', style: 'order-flow-continuation',
    allowed_regimes: ['trend-up', 'trend-down', 'range'], required_features: ['orderFlow'],
    minimum_feature_agreement: 2, min_persistence_seconds: 5, entry_threshold: .4,
    max_spread_bps: 3, min_target_bps: 36, min_net_reward_risk: 1.35, cooldown_minutes: 10,
    opposite_confirmations: 2 },
  E: { id: 'multi-overreaction-fade-v2', label: 'Range overreaction fade',
    definition_hash: 'bbd73cbf1bf42f4bf9f35d5b60991e54c1c06276512202e25688b2507157ff3c', style: 'overreaction-fade',
    allowed_regimes: ['range'], required_features: ['meanReversion'], minimum_feature_agreement: 2,
    min_persistence_seconds: 4, entry_threshold: .42, max_spread_bps: 3.5, min_target_bps: 34,
    min_net_reward_risk: 1.4, cooldown_minutes: 12, opposite_confirmations: 2 },
  F: { id: 'multi-consensus-conservative-v2', label: 'Conservative consensus',
    definition_hash: 'a8280bb5356c1c7b780b90668878f69750b214724d210b17d608eb0fa85dd5bd', style: 'multi-factor-consensus',
    allowed_regimes: ['trend-up', 'trend-down', 'range'], required_features: [], minimum_feature_agreement: 3,
    min_persistence_seconds: 5, entry_threshold: .44, max_spread_bps: 3, min_target_bps: 38,
    min_net_reward_risk: 1.5, cooldown_minutes: 15, opposite_confirmations: 3 },
};
const MULTI_STRATEGY_SET_HASH = '26c95bb151fcca3cc3a869e4e6a3e8f47ad31eef5d2b75702fa1b698b9390941';
const VALID_ABC_EVENT_TYPES = new Set([
  'arm-started', 'decision', 'position-opened', 'position-marked', 'position-closed', 'arm-terminal', 'arm-error',
]);
const VALID_MULTI_EVENT_TYPES = new Set([...VALID_ABC_EVENT_TYPES, 'entry-rejected']);
const VALID_MULTI_GATE_REASONS = new Set([
  'warmup-incomplete', 'regime-warmup-incomplete', 'invalid-quote', 'stress-regime', 'regime-mismatch',
  'spread-too-wide', 'score-below-threshold', 'persistence-insufficient', 'feature-agreement-insufficient',
  'required-feature-mismatch', 'trend-direction-mismatch', 'target-below-cost-floor',
  'net-reward-risk-insufficient', 'post-exit-cooldown', 'candidate-stale',
]);
const VALID_BEHAVIOR_PAPER_STATUSES = new Set(['starting', 'active', 'halted', 'complete', 'error']);
const VALID_BEHAVIOR_PAPER_LOG_TYPES = new Set([
  'session-started', 'cycle-error', 'risk-halted', 'entry-cutoff', 'position-opened',
  'signal-observed', 'no-signal', 'position-closed', 'position-marked', 'session-terminal',
  'settlement-pending', 'checkpoint', 'strategy-upgraded', 'realtime-no-trade', 'realtime-decision',
  'strategy-promoted', 'strategy-rolled-back', 'strategy-checkpoint',
]);
const VALID_BEHAVIOR_ADAPTIVE_STREAM_STATUSES = new Set(['connecting', 'live', 'stale', 'stopped', 'error']);
const VALID_BEHAVIOR_ADAPTIVE_PROMOTION_STATUSES = new Set(['collecting', 'held', 'promoted', 'rolled-back']);
const VALID_BEHAVIOR_ADAPTIVE_PROMOTION_REASONS = new Set([
  'minimum-evidence-not-yet-complete', 'minimum-age', 'minimum-trades', 'multi-window-stability',
  'net-expectancy', 'drawdown', 'turnover-cost', 'all-bounded-gates-passed', 'post-promotion-drawdown-breach',
]);
const VALID_BEHAVIOR_ADAPTIVE_AUDIT_KINDS = new Set([
  'engine-start', 'connection', 'reconnect', 'heartbeat', 'raw-packet', 'normalized-packet',
  'packet-rejected', 'stream-gap', 'stream-stale', 'feature', 'strategy-vote', 'no-trade',
  'shadow-fill', 'shadow-result', 'position-transition', 'checkpoint', 'promotion', 'rollback',
  'report-attempt', 'report-error', 'engine-stop',
]);
const FORBIDDEN_BEHAVIOR_PAPER_PRIVATE_KEY_ALIASES = new Set([
  'authorization', 'authentication', 'auth', 'apikey', 'apisecret', 'apitoken',
  'secret', 'secretkey', 'token', 'authtoken', 'bearertoken', 'accesstoken',
  'refreshtoken', 'sessiontoken', 'accesskey', 'accesssecret', 'privatekey',
  'passphrase', 'password', 'passwd', 'pwd', 'credential', 'credentials', 'jwt',
  'signature', 'signingkey', 'clientoid', 'clientorderid', 'clordid', 'orderid',
  'accountid', 'subaccountid', 'userid', 'uid', 'subuid', 'oid', 'tradeid',
  'fillid', 'accesssign', 'privatefield',
  'privatedata', 'privateroute', 'privatechannel',
]);
const FORBIDDEN_BEHAVIOR_PAPER_CREDENTIAL_TOKENS = new Set([
  'authorization', 'authentication', 'secret', 'token', 'passphrase', 'password',
  'passwd', 'pwd', 'credential', 'credentials', 'jwt', 'signature',
]);
const FORBIDDEN_BEHAVIOR_PAPER_PRIVATE_KEY_SUFFIXES = [
  'apikey', 'apisecret', 'apitoken', 'secretkey', 'authtoken', 'bearertoken',
  'accesstoken', 'refreshtoken', 'sessiontoken', 'accesskey', 'accesssecret',
  'privatekey', 'passphrase', 'password', 'credential', 'credentials', 'signature',
  'clientoid', 'clientorderid', 'clordid', 'orderid', 'accountid', 'subaccountid',
  'userid', 'subuid', 'tradeid', 'fillid', 'accesssign',
];
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
const MAX_MODERATOR_READ_ENTRIES = 200;
const MODERATOR_COMMAND_LEASE_MS = 60_000;
const MODERATOR_REVIEW_LEASE_MS = 15 * 60_000;
const MODERATOR_REVIEW_PROJECT = Object.freeze({
  project_key: 'claude-workspace',
});
const MODERATOR_REQUESTED_MODEL = 'gpt-5.6-sol';
const MODERATOR_REQUESTED_REASONING = 'xhigh';
const VALID_MODERATOR_KINDS = new Set(['important', 'proposal', 'review']);
// 하네스에 상주하는 보고자들. 이들은 "지금 돌고 있는 작업"이 아니라 감시 장치 자신이므로
// 활성 세션 수에 넣지 않는다. 넣으면 active_task_count가 영원히 1 이상이 되어, 그 값이
// 0일 때만 도는 **유휴 검토가 한 번도 실행되지 않는다** (2026-08-30 실측).
// 화면(usage.js RESIDENT_TASK_IDS)은 이미 같은 집합을 걸러 왔고, 서버가 그것을 따라간다.
const MODERATOR_DAEMON_TASK_ID = 'moderator-daemon';
const MODERATOR_RESIDENT_TASK_IDS = [MODERATOR_DAEMON_TASK_ID, 'kernel-state'];
const VALID_MODERATOR_REASONING = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);
const MODERATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
// 모더 항목 id는 `important:<해시>`처럼 콜론을 담는다. 클라이언트가 encodeURIComponent로
// 감싸면 경로에는 `important%3A...`가 실려 오는데, URL.pathname은 퍼센트 인코딩을 풀지
// 않는다. 풀지 않은 채로 MODERATOR_ID_PATTERN에 넣으면 `%`가 걸려 전부 invalid_item이
// 됐다 — 2026-08-30 실측: 데몬의 항목 자동 닫기가 이 한 줄 때문에 100% 실패했고, 그래서
// 이미 죽은 프로세스에 대한 '중요' 항목이 화면에 영구히 남았다.
function moderatorPathId(raw) {
  const text = String(raw ?? '');
  if (!text.includes('%')) return text;
  try { return decodeURIComponent(text); } catch { return text; }
}
const MODERATOR_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const MODERATOR_ITEM_UNREAD_SQL = `(
  (kind = 'important' AND status = 'open')
  OR (kind = 'proposal' AND status = 'pending')
  OR seen_version < version
)`;
const MODERATOR_COMMAND_UNREAD_SQL = '(seen_at IS NULL OR seen_at < updated_at)';

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

// 사용량은 소유자의 운영 데이터다. 소유자 이름은 wrangler.toml의 vars.OWNER_USERNAME
// 하나가 원본이고 코드에 적지 않는다 — 값이 없으면 아무도 통과하지 못한다(fail-closed).
// 값은 쉼표로 구분한 목록이며, 사람 소유자 외에 에이전트 테스트 계정을 한시적으로 얹기
// 위한 것이다. 이름을 지우면 그 계정은 즉시 404로 돌아간다.
// 세션의 username은 users 테이블에서 조인된 값이다(lib.js).
// Behavior Lab is deliberately stricter than the broader owner control plane. This setting is one
// normalized human username, never a comma-separated list and never OWNER_USERNAME's test accounts.
function behaviorOwnerUsername(env) {
  const username = String(env.BEHAVIOR_OWNER_USERNAME || '').normalize('NFKC').trim().toLowerCase();
  return username && username.length <= 80 && !username.includes(',') ? username : '';
}

function isBehaviorOwnerSession(session, env) {
  const username = String(session?.username || '').normalize('NFKC').trim().toLowerCase();
  const expected = behaviorOwnerUsername(env);
  return Boolean(username && expected && username === expected);
}

async function behaviorOwner(request, env) {
  const session = await authenticate(request, env);
  if (!session) {
    return { response: json({ error: '로그인이 필요합니다.' }, 401, { 'cache-control': 'private, no-store' }) };
  }
  if (!isBehaviorOwnerSession(session, env)) {
    return { response: json({ error: 'Not found' }, 404, { 'cache-control': 'private, no-store' }) };
  }
  return { session, response: null };
}

function boundedPaperNumber(value, minimum, maximum, integer = false) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
    && (!integer || Number.isInteger(value))
    ? value
    : null;
}

function boundedPaperText(value, maximum, required = false) {
  if (typeof value !== 'string') return required ? null : '';
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').trim();
  return (!normalized && required) || normalized.length > maximum ? null : normalized;
}

function normalizePaperTimestamp(value, nullable = false) {
  if (nullable && value === null) return null;
  const text = boundedPaperText(value, 40, true);
  const parsed = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

// Detail keys come from the simulator, but they are still untrusted ingest data. Split camelCase,
// snake_case and environment-style aliases into the same small token vocabulary before deciding
// whether a key could carry exchange credentials or private account/order identifiers.
function normalizePaperIdentifierTokens(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 96) return null;
  const separated = value.normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/[^A-Za-z0-9]+/gu, ' ')
    .trim()
    .toLowerCase();
  if (!separated) return null;
  const tokens = separated.split(/\s+/u);
  return separated.length <= 96 && tokens.length <= 12 && tokens.every((token) => token.length <= 48)
    ? tokens
    : null;
}

function isForbiddenPaperPrivateKey(value) {
  const tokens = normalizePaperIdentifierTokens(value);
  if (!tokens) return true;
  const compact = tokens.join('');
  if (FORBIDDEN_BEHAVIOR_PAPER_PRIVATE_KEY_ALIASES.has(compact)) return true;
  if (FORBIDDEN_BEHAVIOR_PAPER_PRIVATE_KEY_SUFFIXES.some((alias) => compact.endsWith(alias))) return true;
  if (tokens.some((token) => FORBIDDEN_BEHAVIOR_PAPER_CREDENTIAL_TOKENS.has(token))) return true;
  if (tokens.includes('key')
    && tokens.some((token) => ['api', 'access', 'private', 'auth', 'signing', 'exchange'].includes(token))) return true;
  if (tokens.includes('sign')
    && tokens.some((token) => ['api', 'access', 'private', 'auth', 'exchange', 'bitget'].includes(token))) return true;
  if (tokens.some((token) => ['id', 'oid', 'uid', 'uuid', 'number', 'no'].includes(token))
    && tokens.some((token) => [
      'account', 'subaccount', 'sub', 'user', 'client', 'order', 'trade', 'fill', 'position',
    ].includes(token))) return true;
  return tokens.includes('private')
    && tokens.some((token) => ['field', 'data', 'route', 'channel', 'account', 'order'].includes(token));
}

function containsForbiddenPaperPrivateAssignment(value) {
  let assignments = 0;
  const assignmentPattern = /(?:^|[^A-Za-z0-9])((?:[A-Za-z][A-Za-z0-9]{0,47})(?:(?:[-_.]|\s+)[A-Za-z][A-Za-z0-9]{0,47}){0,7})\s*(?:=|:)\s*\S+/gu;
  for (const match of value.matchAll(assignmentPattern)) {
    assignments += 1;
    if (assignments > 24 || isForbiddenPaperPrivateKey(match[1])) return true;
  }
  return false;
}

// Scan identifier-shaped fragments independently of assignment syntax. This catches quoted or
// nested-looking JSON keys even when an allowed outer assignment would otherwise consume the text.
function containsForbiddenPaperPrivateIdentifier(value) {
  let identifiers = 0;
  const recent = [];
  const identifierPattern = /[A-Za-z][A-Za-z0-9]*(?:(?:[-_./])[A-Za-z0-9]+)*/gu;
  for (const match of value.matchAll(identifierPattern)) {
    identifiers += 1;
    if (identifiers > 64 || match[0].length > 96 || isForbiddenPaperPrivateKey(match[0])) return true;
    recent.push(match[0]);
    if (recent.length > 3) recent.shift();
    for (let width = 2; width <= recent.length; width += 1) {
      const combined = recent.slice(-width).join('_');
      if (combined.length <= 96 && isForbiddenPaperPrivateKey(combined)) return true;
    }
  }
  return false;
}

// Trade and position details are display-only and versioned by the local simulator. Preserve safe,
// bounded scalar fields without allowing arbitrary depth or non-finite JSON values into D1.
function normalizePaperDetail(value, { maxKeys = 32, maxString = 240 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > maxKeys) return null;
  const normalized = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/u.test(key)) return null;
    if (isForbiddenPaperPrivateKey(key)) return null;
    if (item === null || typeof item === 'boolean') {
      normalized[key] = item;
    } else if (typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1_000_000_000_000) {
      normalized[key] = item;
    } else if (typeof item === 'string') {
      const text = boundedPaperText(item, maxString);
      if (text === null || containsForbiddenPaperPrivateText(text)) return null;
      normalized[key] = text;
    } else {
      return null;
    }
  }
  return normalized;
}

function normalizePaperLogs(value) {
  if (!Array.isArray(value) || value.length > MAX_BEHAVIOR_PAPER_LOGS) return null;
  const logs = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const message = boundedPaperText(entry, 500, true);
      if (!message || containsForbiddenPaperPrivateText(message)) return null;
      logs.push({ message });
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const entries = Object.entries(entry);
    if (entries.length > 12) return null;
    const normalized = normalizePaperDetail(
      Object.fromEntries(entries.filter(([key]) => key !== 'type')),
      { maxKeys: 12, maxString: 500 },
    );
    if (normalized === null) return null;
    if (!Object.prototype.hasOwnProperty.call(entry, 'type')) {
      logs.push(normalized);
      continue;
    }
    // Event type is a closed engine enum; every other log field stays on the private-text scanner above.
    const type = boundedPaperText(entry.type, 32, true);
    if (!VALID_BEHAVIOR_PAPER_LOG_TYPES.has(type)) return null;
    logs.push(Object.fromEntries(entries.map(([key]) => [key, key === 'type' ? type : normalized[key]])));
  }
  return logs;
}

function normalizePaperLimitations(value) {
  const entries = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 12) return null;
  const normalized = entries.map((entry) => boundedPaperText(entry, 400, true));
  return normalized.some((entry) => entry === null || containsForbiddenPaperPrivateText(entry)) ? null : normalized;
}

function normalizeAdaptiveStrategyId(value, nullable = false) {
  if (nullable && value === null) return null;
  const text = boundedPaperText(value, 64, true);
  return typeof text === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/u.test(text) ? text : undefined;
}

function normalizeAdaptiveHash(value, allowGenesis = false) {
  const text = boundedPaperText(value, 64, true);
  if (allowGenesis && text === 'GENESIS') return text;
  return text && /^[a-f0-9]{64}$/u.test(text) ? text : undefined;
}

function normalizeAdaptiveStrategy(value, metrics = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = normalizeAdaptiveStrategyId(value.id);
  const version = boundedPaperNumber(value.version, 1, 1_000_000, true);
  const hash = normalizeAdaptiveHash(value.hash);
  if (!id || version === null || !hash) return null;
  if (!metrics) return { id, version, hash };
  const tradeCount = boundedPaperNumber(value.trade_count, 0, 1_000_000, true);
  const expectancy = boundedPaperNumber(value.expectancy, -1_000_000, 1_000_000);
  const maxDrawdownPct = boundedPaperNumber(value.max_drawdown_pct, 0, 100);
  const costBps = boundedPaperNumber(value.cost_bps, 0, 1_000_000);
  if ([tradeCount, expectancy, maxDrawdownPct, costBps].some((item) => item === null)) return null;
  return { id, version, hash, trade_count: tradeCount, expectancy, max_drawdown_pct: maxDrawdownPct, cost_bps: costBps };
}

function normalizeAdaptiveAudit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sequence = boundedPaperNumber(value.sequence, 0, 100_000_000, true);
  const hash = normalizeAdaptiveHash(value.hash, sequence === 0);
  if (sequence === null || !hash || (sequence === 0 && hash !== 'GENESIS')) return null;
  if (!Array.isArray(value.recent) || value.recent.length > MAX_BEHAVIOR_ADAPTIVE_AUDIT_LOGS) return null;
  const recent = [];
  let previousSequence = 0;
  for (const entry of value.recent) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const entrySequence = boundedPaperNumber(entry.sequence, 1, 100_000_000, true);
    const at = normalizePaperTimestamp(entry.at);
    const kind = boundedPaperText(entry.kind, 40, true);
    const producerMessage = boundedPaperText(entry.message, 240, true);
    const entryHash = normalizeAdaptiveHash(entry.hash);
    if (entrySequence === null || entrySequence <= previousSequence || entrySequence > sequence
      || !at || !kind || !VALID_BEHAVIOR_ADAPTIVE_AUDIT_KINDS.has(kind) || !producerMessage || !entryHash) return null;
    recent.push({ sequence: entrySequence, at, kind, message: kind, hash: entryHash });
    previousSequence = entrySequence;
  }
  if (sequence === 0 ? recent.length !== 0
    : !recent.length || recent.at(-1).sequence !== sequence || recent.at(-1).hash !== hash) return null;
  return { sequence, hash, recent };
}

function normalizeBehaviorPaperAdaptive(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.engine_version !== 'realtime-paper-v2' || value.strategy_schema !== 1) return null;
  const upgradedAt = normalizePaperTimestamp(value.upgraded_at);
  const cadence = value.cadence;
  if (!upgradedAt || !cadence || typeof cadence !== 'object' || Array.isArray(cadence)
    || cadence.regime !== '5m' || cadence.candidate !== 'completed-1m' || cadence.risk !== 'ticker-event'
    || cadence.microstructure !== '1s/3s-persistence' || cadence.weight_checkpoint !== '15m'
    || cadence.challenger_checkpoint !== '24h-minimum') return null;

  const stream = value.stream;
  if (!stream || typeof stream !== 'object' || Array.isArray(stream)) return null;
  const streamStatus = boundedPaperText(stream.status, 16, true);
  const lastPacketAt = normalizePaperTimestamp(stream.last_packet_at, true);
  const reconnectCount = boundedPaperNumber(stream.reconnect_count, 0, 1_000_000, true);
  if (!streamStatus || !VALID_BEHAVIOR_ADAPTIVE_STREAM_STATUSES.has(streamStatus)
    || lastPacketAt === undefined || reconnectCount === null || stream.credential_used !== false) return null;

  const champion = normalizeAdaptiveStrategy(value.champion);
  if (!champion || !Array.isArray(value.challengers)
    || value.challengers.length > MAX_BEHAVIOR_ADAPTIVE_CHALLENGERS) return null;
  const challengers = value.challengers.map((entry) => normalizeAdaptiveStrategy(entry, true));
  if (challengers.some((entry) => entry === null)) return null;
  const strategyIds = [champion.id, ...challengers.map((entry) => entry.id)];
  if (new Set(strategyIds).size !== strategyIds.length) return null;

  const promotion = value.promotion;
  if (!promotion || typeof promotion !== 'object' || Array.isArray(promotion)) return null;
  const promotionStatus = boundedPaperText(promotion.status, 16, true);
  const checkpointAt = normalizePaperTimestamp(promotion.last_checkpoint_at, true);
  const from = normalizeAdaptiveStrategyId(promotion.from, true);
  const to = normalizeAdaptiveStrategyId(promotion.to, true);
  if (!promotionStatus || !VALID_BEHAVIOR_ADAPTIVE_PROMOTION_STATUSES.has(promotionStatus)
    || checkpointAt === undefined || from === undefined || to === undefined
    || !Array.isArray(promotion.reasons) || promotion.reasons.length < 1 || promotion.reasons.length > 12) return null;
  const reasons = promotion.reasons.map((reason) => boundedPaperText(reason, 160, true));
  if (reasons.some((reason) => reason === null || !VALID_BEHAVIOR_ADAPTIVE_PROMOTION_REASONS.has(reason))) return null;
  if (promotionStatus === 'collecting' && (checkpointAt !== null || from !== null || to !== null)) return null;
  if (promotionStatus !== 'collecting' && checkpointAt === null) return null;
  if (['promoted', 'rolled-back'].includes(promotionStatus) && (!from || !to || from === to)) return null;

  const audit = normalizeAdaptiveAudit(value.audit);
  if (!audit) return null;
  return {
    engine_version: 'realtime-paper-v2',
    strategy_schema: 1,
    upgraded_at: upgradedAt,
    cadence: {
      regime: '5m', candidate: 'completed-1m', risk: 'ticker-event', microstructure: '1s/3s-persistence',
      weight_checkpoint: '15m', challenger_checkpoint: '24h-minimum',
    },
    stream: { status: streamStatus, last_packet_at: lastPacketAt, reconnect_count: reconnectCount, credential_used: false },
    champion,
    challengers,
    promotion: { status: promotionStatus, last_checkpoint_at: checkpointAt, from, to, reasons },
    audit,
  };
}

export function normalizeBehaviorPaperReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.session_id !== BEHAVIOR_PAPER_SESSION_ID || input.simulation !== true) return null;
  const deadlineAt = normalizePaperTimestamp(input.deadline_at);
  if (deadlineAt !== BEHAVIOR_PAPER_DEADLINE) return null;
  const generatedAt = normalizePaperTimestamp(input.generated_at);
  const lastCycleAt = normalizePaperTimestamp(input.last_cycle_at, true);
  if (!generatedAt || lastCycleAt === undefined) return null;
  const status = boundedPaperText(input.status, 16, true);
  if (!VALID_BEHAVIOR_PAPER_STATUSES.has(status)) return null;

  const sequence = boundedPaperNumber(input.sequence, 1, MAX_BEHAVIOR_PAPER_SEQUENCE, true);
  const seedEquity = boundedPaperNumber(input.seed_equity, 100, 100);
  const equity = boundedPaperNumber(input.equity, 0, 1_000_000);
  const cash = boundedPaperNumber(input.cash, 0, 1_000_000);
  const realizedPnl = boundedPaperNumber(input.realized_pnl, -1_000_000, 1_000_000);
  const unrealizedPnl = boundedPaperNumber(input.unrealized_pnl, -1_000_000, 1_000_000);
  const netPnl = boundedPaperNumber(input.net_pnl, -1_000_000, 1_000_000);
  const returnPct = boundedPaperNumber(input.return_pct, -100, 1_000_000);
  const maxDrawdownPct = boundedPaperNumber(input.max_drawdown_pct, 0, 100);
  const fees = boundedPaperNumber(input.fees, 0, 1_000_000);
  const slippageCost = boundedPaperNumber(input.slippage_cost, 0, 1_000_000);
  const tradeCount = boundedPaperNumber(input.trade_count, 0, 10_000, true);
  const winCount = boundedPaperNumber(input.win_count, 0, 10_000, true);
  const lossCount = boundedPaperNumber(input.loss_count, 0, 10_000, true);
  const numbers = [sequence, seedEquity, equity, cash, realizedPnl, unrealizedPnl, netPnl,
    returnPct, maxDrawdownPct, fees, slippageCost, tradeCount, winCount, lossCount];
  if (numbers.some((value) => value === null) || winCount + lossCount > tradeCount) return null;

  let openPosition = null;
  if (input.open_position !== null) {
    openPosition = normalizePaperDetail(input.open_position);
    const symbol = openPosition?.symbol;
    const direction = openPosition?.direction ?? openPosition?.side;
    if (!['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(symbol)
      || !['long', 'short'].includes(direction)) return null;
  }
  if (!Array.isArray(input.recent_trades) || input.recent_trades.length > MAX_BEHAVIOR_PAPER_TRADES) return null;
  const recentTrades = input.recent_trades.map((trade) => normalizePaperDetail(trade));
  if (recentTrades.some((trade) => trade === null)) return null;
  const recentLogs = normalizePaperLogs(input.recent_logs);
  const limitations = normalizePaperLimitations(input.limitations);
  if (!recentLogs || !limitations) return null;
  let adaptive;
  if (Object.prototype.hasOwnProperty.call(input, 'adaptive')) {
    adaptive = normalizeBehaviorPaperAdaptive(input.adaptive);
    if (!adaptive || Date.parse(adaptive.upgraded_at) > Date.parse(generatedAt)
      || (adaptive.stream.last_packet_at && Date.parse(adaptive.stream.last_packet_at) > Date.parse(generatedAt))) return null;
  }

  return {
    session_id: BEHAVIOR_PAPER_SESSION_ID,
    sequence,
    generated_at: generatedAt,
    deadline_at: BEHAVIOR_PAPER_DEADLINE,
    status,
    simulation: true,
    seed_equity: seedEquity,
    equity,
    cash,
    realized_pnl: realizedPnl,
    unrealized_pnl: unrealizedPnl,
    net_pnl: netPnl,
    return_pct: returnPct,
    max_drawdown_pct: maxDrawdownPct,
    fees,
    slippage_cost: slippageCost,
    trade_count: tradeCount,
    win_count: winCount,
    loss_count: lossCount,
    open_position: openPosition,
    recent_trades: recentTrades,
    recent_logs: recentLogs,
    last_cycle_at: lastCycleAt,
    limitations,
    ...(adaptive ? { adaptive } : {}),
  };
}

function exactPaperKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));
}

function normalizedExperimentHash(value, allowGenesis = false) {
  const text = boundedPaperText(value, 64, true);
  return allowGenesis && text === 'GENESIS' ? text : text && /^[a-f0-9]{64}$/u.test(text) ? text : null;
}

function normalizeExperimentDetail(value, keys) {
  if (!exactPaperKeys(value, keys)) return null;
  const normalized = normalizePaperDetail(value, { maxKeys: keys.length, maxString: 240 });
  return normalized && exactPaperKeys(normalized, keys) ? normalized : null;
}

function normalizeExperimentPosition(value) {
  if (value === null) return null;
  const keys = ['id', 'symbol', 'direction', 'opened_at', 'entry_price', 'mark_price', 'quantity', 'notional',
    'unrealized_pnl', 'stop_price', 'target_price'];
  const result = normalizeExperimentDetail(value, keys);
  if (!result || !['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(result.symbol)
    || !['long', 'short'].includes(result.direction) || !normalizePaperTimestamp(result.opened_at)) return undefined;
  return result;
}

function normalizeExperimentTrades(value) {
  if (!Array.isArray(value) || value.length > 25) return null;
  const keys = ['id', 'symbol', 'direction', 'opened_at', 'closed_at', 'entry_price', 'exit_price', 'quantity',
    'notional', 'net_pnl', 'return_pct', 'fees', 'slippage_cost', 'reason'];
  const trades = value.map((entry) => normalizeExperimentDetail(entry, keys));
  if (trades.some((entry) => !entry || !['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(entry.symbol)
    || !['long', 'short'].includes(entry.direction) || !normalizePaperTimestamp(entry.opened_at)
    || !normalizePaperTimestamp(entry.closed_at))) return null;
  return trades;
}

function normalizeExperimentDecisions(value, sharedSequence) {
  if (!Array.isArray(value) || value.length > 20) return null;
  const keys = ['symbol', 'signal_bar_at', 'observed_at', 'direction', 'score', 'confidence', 'reason', 'feed_sequence', 'feed_hash'];
  const decisions = [];
  for (const entry of value) {
    if (!exactPaperKeys(entry, keys)) return null;
    const signalBarAt = normalizePaperTimestamp(entry.signal_bar_at);
    const observedAt = normalizePaperTimestamp(entry.observed_at);
    const score = boundedPaperNumber(entry.score, -1, 1);
    const confidence = boundedPaperNumber(entry.confidence, 0, 100, true);
    const feedSequence = boundedPaperNumber(entry.feed_sequence, 1, sharedSequence, true);
    const feedHash = normalizedExperimentHash(entry.feed_hash);
    const reason = entry.reason === null ? null : boundedPaperText(entry.reason, 160, true);
    if (!['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(entry.symbol)
      || !['long', 'short', 'stand-aside'].includes(entry.direction) || !signalBarAt || !observedAt
      || score === null || confidence === null || feedSequence === null || !feedHash
      || (reason !== null && containsForbiddenPaperPrivateText(reason))) return null;
    decisions.push({ symbol: entry.symbol, signal_bar_at: signalBarAt, observed_at: observedAt,
      direction: entry.direction, score, confidence, reason, feed_sequence: feedSequence, feed_hash: feedHash });
  }
  return decisions;
}

function normalizeExperimentLogs(value) {
  if (!Array.isArray(value) || value.length > 30) return null;
  const keys = ['sequence', 'at', 'type', 'message'];
  const logs = value.map((entry) => normalizeExperimentDetail(entry, keys));
  if (logs.some((entry) => !entry || boundedPaperNumber(entry.sequence, 1, 1_000_000, true) === null
    || !normalizePaperTimestamp(entry.at) || !VALID_ABC_EVENT_TYPES.has(entry.type)
    || boundedPaperText(entry.message, 240, true) === null || containsForbiddenPaperPrivateText(entry.message))) return null;
  return logs;
}

function normalizeExperimentEquityCurve(value, chainSequence, finalEquity) {
  if (!Array.isArray(value) || value.length > MAX_ABC_EQUITY_CURVE_POINTS) return null;
  const points = [];
  for (const entry of value) {
    if (!exactPaperKeys(entry, ['sequence', 'at', 'equity', 'net_pnl'])) return null;
    const sequence = boundedPaperNumber(entry.sequence, 1, chainSequence, true);
    const at = normalizePaperTimestamp(entry.at);
    const equity = boundedPaperNumber(entry.equity, 0, 1_000_000);
    const netPnl = boundedPaperNumber(entry.net_pnl, -100, 999_900);
    const previous = points.at(-1);
    if (sequence === null || !at || equity === null || netPnl === null
      || Math.abs(netPnl - (equity - 100)) > 1e-6
      || (previous && (sequence <= previous.sequence || Date.parse(at) <= Date.parse(previous.at)))) return null;
    points.push({ sequence, at, equity, net_pnl: netPnl });
  }
  if (points.length && (points.at(-1).sequence !== chainSequence || Math.abs(points.at(-1).equity - finalEquity) > 1e-6)) return null;
  return points;
}

function normalizeExperimentArm(value, armId, sharedSequence) {
  const legacyKeys = ['arm_id', 'strategy', 'chain', 'status', 'seed_equity', 'equity', 'cash', 'realized_pnl',
    'unrealized_pnl', 'net_pnl', 'return_pct', 'max_drawdown_pct', 'fees', 'slippage_cost', 'trade_count',
    'win_count', 'loss_count', 'open_position', 'recent_trades', 'recent_decisions', 'recent_logs', 'last_cycle_at'];
  const hasEquityCurve = exactPaperKeys(value, [...legacyKeys, 'equity_curve']);
  if ((!hasEquityCurve && !exactPaperKeys(value, legacyKeys)) || value.arm_id !== armId
    || !exactPaperKeys(value.strategy, ['id', 'label', 'definition_hash'])
    || value.strategy.id !== ABC_STRATEGY_IDS[armId] || value.strategy.label !== ABC_STRATEGY_LABELS[armId]
    || !normalizedExperimentHash(value.strategy.definition_hash)
    || !exactPaperKeys(value.chain, ['sequence', 'hash'])) return null;
  const chainSequence = boundedPaperNumber(value.chain.sequence, 1, 1_000_000, true);
  const chainHash = normalizedExperimentHash(value.chain.hash);
  const status = boundedPaperText(value.status, 16, true);
  const numbers = {
    seed_equity: boundedPaperNumber(value.seed_equity, 100, 100),
    equity: boundedPaperNumber(value.equity, 0, 1_000_000), cash: boundedPaperNumber(value.cash, 0, 1_000_000),
    realized_pnl: boundedPaperNumber(value.realized_pnl, -1_000_000, 1_000_000),
    unrealized_pnl: boundedPaperNumber(value.unrealized_pnl, -1_000_000, 1_000_000),
    net_pnl: boundedPaperNumber(value.net_pnl, -100, 999_900), return_pct: boundedPaperNumber(value.return_pct, -100, 999_900),
    max_drawdown_pct: boundedPaperNumber(value.max_drawdown_pct, 0, 100), fees: boundedPaperNumber(value.fees, 0, 1_000_000),
    slippage_cost: boundedPaperNumber(value.slippage_cost, 0, 1_000_000),
    trade_count: boundedPaperNumber(value.trade_count, 0, 10_000, true), win_count: boundedPaperNumber(value.win_count, 0, 10_000, true),
    loss_count: boundedPaperNumber(value.loss_count, 0, 10_000, true),
  };
  if (chainSequence === null || chainSequence > sharedSequence || !chainHash
    || !['starting', 'active', 'halted', 'complete', 'error'].includes(status)
    || Object.values(numbers).some((entry) => entry === null)
    || Math.abs(numbers.net_pnl - (numbers.equity - 100)) > 1e-6
    || Math.abs(numbers.return_pct - numbers.net_pnl) > 1e-6
    || numbers.win_count + numbers.loss_count > numbers.trade_count) return null;
  const openPosition = normalizeExperimentPosition(value.open_position);
  const trades = normalizeExperimentTrades(value.recent_trades);
  const decisions = normalizeExperimentDecisions(value.recent_decisions, sharedSequence);
  const logs = normalizeExperimentLogs(value.recent_logs);
  const equityCurve = hasEquityCurve ? normalizeExperimentEquityCurve(value.equity_curve, chainSequence, numbers.equity) : [];
  const lastCycleAt = normalizePaperTimestamp(value.last_cycle_at, true);
  if (openPosition === undefined || !trades || !decisions || !logs || !equityCurve || lastCycleAt === undefined) return null;
  return { arm_id: armId, strategy: { id: ABC_STRATEGY_IDS[armId], label: ABC_STRATEGY_LABELS[armId],
    definition_hash: value.strategy.definition_hash }, chain: { sequence: chainSequence, hash: chainHash }, status,
    ...numbers, equity_curve: equityCurve, open_position: openPosition, recent_trades: trades, recent_decisions: decisions, recent_logs: logs,
    last_cycle_at: lastCycleAt };
}

export function normalizeBehaviorPaperExperimentReport(input) {
  const keys = ['schema', 'experiment_id', 'simulation', 'public_data_only', 'generated_at', 'started_at', 'deadline_at',
    'status', 'shared_feed', 'assumptions', 'leaderboard', 'arms', 'limitations'];
  if (!exactPaperKeys(input, keys) || input.schema !== 'abc-paper-experiment-v1'
    || input.experiment_id !== BEHAVIOR_ABC_EXPERIMENT_ID || input.simulation !== true || input.public_data_only !== true) return null;
  const generatedAt = normalizePaperTimestamp(input.generated_at);
  const startedAt = normalizePaperTimestamp(input.started_at);
  const deadlineAt = normalizePaperTimestamp(input.deadline_at);
  const status = boundedPaperText(input.status, 16, true);
  if (!generatedAt || !startedAt || !deadlineAt || Date.parse(deadlineAt) - Date.parse(startedAt) !== DAY_MS
    || Date.parse(generatedAt) < Date.parse(startedAt) || Date.parse(generatedAt) > Date.parse(deadlineAt) + 60 * 60_000
    || !['starting', 'active', 'complete', 'error'].includes(status)) return null;
  const feedKeys = ['sequence', 'hash', 'last_packet_at', 'credential_used', 'symbols', 'channels'];
  if (!exactPaperKeys(input.shared_feed, feedKeys)) return null;
  const sharedSequence = boundedPaperNumber(input.shared_feed.sequence, 1, 100_000_000, true);
  const sharedHash = normalizedExperimentHash(input.shared_feed.hash);
  const lastPacketAt = normalizePaperTimestamp(input.shared_feed.last_packet_at, true);
  if (sharedSequence === null || !sharedHash || lastPacketAt === undefined || input.shared_feed.credential_used !== false
    || JSON.stringify(input.shared_feed.symbols) !== JSON.stringify(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'])
    || JSON.stringify(input.shared_feed.channels) !== JSON.stringify(['ticker', 'books5', 'trade', 'candle1m'])
    || (lastPacketAt && Date.parse(lastPacketAt) > Date.parse(generatedAt))) return null;
  const assumptionKeys = ['seed_equity_per_arm', 'fee_bps_per_side', 'slippage_bps_per_side', 'risk_pct', 'leverage_cap',
    'drawdown_halt_pct', 'entry_cutoff_at', 'terminal_close', 'max_positions_per_arm', 'strategy_mutation'];
  if (!exactPaperKeys(input.assumptions, assumptionKeys)
    || input.assumptions.seed_equity_per_arm !== 100 || input.assumptions.fee_bps_per_side !== 6
    || input.assumptions.slippage_bps_per_side !== 4 || input.assumptions.risk_pct !== 5
    || input.assumptions.leverage_cap !== 10 || input.assumptions.drawdown_halt_pct !== 20
    || normalizePaperTimestamp(input.assumptions.entry_cutoff_at) !== new Date(Date.parse(deadlineAt) - 15 * 60_000).toISOString()
    || input.assumptions.terminal_close !== 'deadline' || input.assumptions.max_positions_per_arm !== 1
    || input.assumptions.strategy_mutation !== false) return null;
  if (!Array.isArray(input.arms) || input.arms.length !== 3) return null;
  const arms = input.arms.map((arm, index) => normalizeExperimentArm(arm, ABC_ARM_IDS[index], sharedSequence));
  if (arms.some((arm) => !arm) || new Set(arms.map((arm) => arm.chain.hash)).size !== 3) return null;
  if (!Array.isArray(input.leaderboard) || input.leaderboard.length !== 3) return null;
  const expectedLeaderboard = [...arms].sort((left, right) => right.equity - left.equity || left.arm_id.localeCompare(right.arm_id));
  const leaderboard = input.leaderboard.map((row, index) => {
    if (!exactPaperKeys(row, ['rank', 'arm_id', 'equity', 'net_pnl', 'return_pct', 'max_drawdown_pct'])) return null;
    const arm = expectedLeaderboard[index];
    return row.rank === index + 1 && row.arm_id === arm.arm_id && ['equity', 'net_pnl', 'return_pct', 'max_drawdown_pct']
      .every((key) => row[key] === arm[key]) ? { ...row } : null;
  });
  const limitations = normalizePaperLimitations(input.limitations);
  if (leaderboard.some((row) => !row) || !limitations) return null;
  return { schema: 'abc-paper-experiment-v1', experiment_id: BEHAVIOR_ABC_EXPERIMENT_ID, simulation: true,
    public_data_only: true, generated_at: generatedAt, started_at: startedAt, deadline_at: deadlineAt, status,
    shared_feed: { sequence: sharedSequence, hash: sharedHash, last_packet_at: lastPacketAt, credential_used: false,
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'], channels: ['ticker', 'books5', 'trade', 'candle1m'] },
    assumptions: { ...input.assumptions, entry_cutoff_at: normalizePaperTimestamp(input.assumptions.entry_cutoff_at) },
    leaderboard, arms, limitations };
}

function closePaperNumber(left, right) {
  return Math.abs(left - right) <= Math.max(1e-6, Math.max(Math.abs(left), Math.abs(right)) * 1e-9);
}

function normalizeMultiPosition(value, startedAtMs, latestAtMs) {
  if (value === null) return null;
  const keys = ['id', 'symbol', 'direction', 'opened_at', 'entry_price', 'mark_price', 'quantity', 'notional',
    'leverage', 'unrealized_pnl', 'stop_price', 'target_price'];
  const result = normalizeExperimentDetail(value, keys);
  const openedAt = result && normalizePaperTimestamp(result.opened_at);
  const numbers = result && {
    entry_price: boundedPaperNumber(result.entry_price, 0, 1_000_000_000),
    mark_price: boundedPaperNumber(result.mark_price, 0, 1_000_000_000),
    quantity: boundedPaperNumber(result.quantity, 0, 1_000_000_000),
    notional: boundedPaperNumber(result.notional, 0, 1_000_000_000),
    leverage: boundedPaperNumber(result.leverage, 0, 3),
    unrealized_pnl: boundedPaperNumber(result.unrealized_pnl, -1_000_000, 1_000_000),
    stop_price: boundedPaperNumber(result.stop_price, 0, 1_000_000_000),
    target_price: boundedPaperNumber(result.target_price, 0, 1_000_000_000),
  };
  const sign = result?.direction === 'long' ? 1 : -1;
  const modeledExitPrice = numbers && numbers.mark_price * (1 - sign * MULTI_ADVERSE_SLIPPAGE_RATE);
  const modeledExitFee = numbers && numbers.quantity * modeledExitPrice * MULTI_FEE_RATE;
  const expectedUnrealizedPnl = numbers && sign * numbers.quantity
    * (modeledExitPrice - numbers.entry_price) - modeledExitFee;
  if (!result || !['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(result.symbol)
    || !['long', 'short'].includes(result.direction) || !openedAt
    || Object.values(numbers).some((entry) => entry === null)
    || ['entry_price', 'mark_price', 'quantity', 'notional', 'leverage', 'stop_price', 'target_price']
      .some((key) => numbers[key] <= 0)
    || Date.parse(openedAt) < startedAtMs || Date.parse(openedAt) > latestAtMs
    || !closePaperNumber(numbers.notional, numbers.entry_price * numbers.quantity)
    || !closePaperNumber(numbers.unrealized_pnl, expectedUnrealizedPnl)
    || (result.direction === 'long'
      ? !(numbers.stop_price < numbers.entry_price && numbers.entry_price < numbers.target_price)
      : !(numbers.target_price < numbers.entry_price && numbers.entry_price < numbers.stop_price))) return undefined;
  return { id: result.id, symbol: result.symbol, direction: result.direction, opened_at: openedAt, ...numbers };
}

function normalizeMultiTrades(value, startedAtMs, latestAtMs) {
  if (!Array.isArray(value) || value.length > 25) return null;
  const keys = ['id', 'symbol', 'direction', 'opened_at', 'closed_at', 'entry_price', 'exit_price', 'quantity',
    'notional', 'net_pnl', 'return_pct', 'fees', 'slippage_cost', 'reason'];
  const trades = [];
  for (const entry of value) {
    const result = normalizeExperimentDetail(entry, keys);
    const openedAt = result && normalizePaperTimestamp(result.opened_at);
    const closedAt = result && normalizePaperTimestamp(result.closed_at);
    const numbers = result && {
      entry_price: boundedPaperNumber(result.entry_price, 0, 1_000_000_000),
      exit_price: boundedPaperNumber(result.exit_price, 0, 1_000_000_000),
      quantity: boundedPaperNumber(result.quantity, 0, 1_000_000_000),
      notional: boundedPaperNumber(result.notional, 0, 1_000_000_000),
      net_pnl: boundedPaperNumber(result.net_pnl, -1_000_000, 1_000_000),
      return_pct: boundedPaperNumber(result.return_pct, -1_000_000, 1_000_000),
      fees: boundedPaperNumber(result.fees, 0, 1_000_000),
      slippage_cost: boundedPaperNumber(result.slippage_cost, 0, 1_000_000),
    };
    if (!result || !['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(result.symbol)
      || !['long', 'short'].includes(result.direction) || !openedAt || !closedAt
      || Object.values(numbers).some((item) => item === null)
      || ['entry_price', 'exit_price', 'quantity', 'notional'].some((key) => numbers[key] <= 0)
      || Date.parse(openedAt) < startedAtMs || Date.parse(closedAt) < Date.parse(openedAt)
      || Date.parse(closedAt) > latestAtMs || !closePaperNumber(numbers.notional, numbers.entry_price * numbers.quantity)
      || !closePaperNumber(numbers.fees,
        numbers.quantity * (numbers.entry_price + numbers.exit_price) * MULTI_FEE_RATE)
      || !closePaperNumber(numbers.net_pnl, (result.direction === 'long' ? 1 : -1)
        * numbers.quantity * (numbers.exit_price - numbers.entry_price) - numbers.fees)
      || !closePaperNumber(numbers.return_pct, numbers.net_pnl / numbers.notional * 100)
      || !['stop', 'target', 'opposite-signal', 'max-hold', 'risk-halt', 'deadline'].includes(result.reason)) return null;
    trades.push({ id: result.id, symbol: result.symbol, direction: result.direction,
      opened_at: openedAt, closed_at: closedAt, ...numbers, reason: result.reason });
  }
  return trades;
}

function normalizeMultiDecisions(value, sharedSequence, startedAtMs, latestAtMs) {
  if (!Array.isArray(value) || value.length > 20) return null;
  const keys = ['symbol', 'signal_bar_at', 'observed_at', 'regime', 'direction', 'score', 'confidence',
    'spread_bps', 'feature_agreement', 'target_distance_bps', 'net_reward_risk', 'gate_reasons',
    'feed_sequence', 'feed_hash'];
  const decisions = [];
  for (const entry of value) {
    if (!exactPaperKeys(entry, keys)) return null;
    const signalBarAt = normalizePaperTimestamp(entry.signal_bar_at);
    const observedAt = normalizePaperTimestamp(entry.observed_at);
    const score = boundedPaperNumber(entry.score, -1, 1);
    const confidence = boundedPaperNumber(entry.confidence, 0, 100, true);
    const spreadBps = boundedPaperNumber(entry.spread_bps, 0, 100);
    const featureAgreement = boundedPaperNumber(entry.feature_agreement, 0, 4, true);
    const targetDistanceBps = boundedPaperNumber(entry.target_distance_bps, 0, 10_000);
    const netRewardRisk = boundedPaperNumber(entry.net_reward_risk, 0, 100);
    const feedSequence = boundedPaperNumber(entry.feed_sequence, 1, sharedSequence, true);
    const feedHash = normalizedExperimentHash(entry.feed_hash);
    if (!Array.isArray(entry.gate_reasons) || entry.gate_reasons.length > 8) return null;
    const gateReasons = entry.gate_reasons.map((reason) => boundedPaperText(reason, 48, true));
    if (gateReasons.some((reason) => !VALID_MULTI_GATE_REASONS.has(reason))
      || new Set(gateReasons).size !== gateReasons.length) return null;
    if (!['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'].includes(entry.symbol)
      || !['trend-up', 'trend-down', 'range', 'stress'].includes(entry.regime)
      || !['long', 'short', 'stand-aside'].includes(entry.direction) || !signalBarAt || !observedAt
      || Date.parse(signalBarAt) > Date.parse(observedAt) || Date.parse(observedAt) < startedAtMs
      || Date.parse(observedAt) > latestAtMs
      || [score, confidence, spreadBps, featureAgreement, targetDistanceBps, netRewardRisk, feedSequence]
        .some((item) => item === null) || !feedHash
      || (entry.direction === 'stand-aside' ? gateReasons.length < 1 : gateReasons.length !== 0)) return null;
    decisions.push({ symbol: entry.symbol, signal_bar_at: signalBarAt, observed_at: observedAt,
      regime: entry.regime, direction: entry.direction, score, confidence, spread_bps: spreadBps,
      feature_agreement: featureAgreement, target_distance_bps: targetDistanceBps,
      net_reward_risk: netRewardRisk, gate_reasons: gateReasons, feed_sequence: feedSequence, feed_hash: feedHash });
  }
  return decisions;
}

function normalizeMultiLogs(value, startedAtMs, latestAtMs) {
  if (!Array.isArray(value) || value.length > 30) return null;
  const keys = ['sequence', 'at', 'type', 'message'];
  const logs = value.map((entry) => normalizeExperimentDetail(entry, keys));
  if (logs.some((entry) => !entry || boundedPaperNumber(entry.sequence, 1, 1_000_000, true) === null
    || !normalizePaperTimestamp(entry.at) || !VALID_MULTI_EVENT_TYPES.has(entry.type)
    || Date.parse(entry.at) < startedAtMs || Date.parse(entry.at) > latestAtMs
    || boundedPaperText(entry.message, 240, true) === null || containsForbiddenPaperPrivateText(entry.message))) return null;
  return logs;
}

function normalizeMultiPolicy(value, armId) {
  const expected = MULTI_STRATEGIES[armId];
  const keys = ['style', 'allowed_regimes', 'required_features', 'minimum_feature_agreement',
    'min_persistence_seconds', 'entry_threshold', 'max_spread_bps', 'min_target_bps',
    'min_net_reward_risk', 'cooldown_minutes', 'opposite_confirmations'];
  if (!exactPaperKeys(value, keys)) return null;
  const facts = Object.fromEntries(keys.map((key) => [key, expected[key]]));
  return JSON.stringify(value) === JSON.stringify(facts) ? facts : null;
}

function normalizeMultiArm(value, armId, sharedSequence, startedAtMs, latestAtMs) {
  const keys = ['arm_id', 'strategy', 'risk', 'chain', 'status', 'seed_equity', 'equity', 'cash',
    'realized_pnl', 'unrealized_pnl', 'net_pnl', 'return_pct', 'max_drawdown_pct', 'fees',
    'slippage_cost', 'trade_count', 'win_count', 'loss_count', 'equity_curve', 'open_position',
    'recent_trades', 'recent_decisions', 'recent_logs', 'last_cycle_at'];
  const expected = MULTI_STRATEGIES[armId];
  if (!exactPaperKeys(value, keys) || value.arm_id !== armId
    || !exactPaperKeys(value.strategy, ['id', 'label', 'definition_hash', 'policy'])
    || value.strategy.id !== expected.id || value.strategy.label !== expected.label
    || value.strategy.definition_hash !== expected.definition_hash || !normalizeMultiPolicy(value.strategy.policy, armId)
    || !exactPaperKeys(value.risk, ['risk_pct', 'leverage_cap', 'drawdown_halt_pct', 'max_hold_minutes',
      'minimum_hold_before_opposite_minutes'])
    || JSON.stringify(value.risk) !== JSON.stringify({ risk_pct: 1.5, leverage_cap: 3, drawdown_halt_pct: 10,
      max_hold_minutes: 45, minimum_hold_before_opposite_minutes: 5 })
    || !exactPaperKeys(value.chain, ['sequence', 'hash'])) return null;
  const chainSequence = boundedPaperNumber(value.chain.sequence, 1, 1_000_000, true);
  const chainHash = normalizedExperimentHash(value.chain.hash);
  const status = boundedPaperText(value.status, 16, true);
  const numbers = {
    seed_equity: boundedPaperNumber(value.seed_equity, 100, 100),
    equity: boundedPaperNumber(value.equity, 0, 1_000_000), cash: boundedPaperNumber(value.cash, 0, 1_000_000),
    realized_pnl: boundedPaperNumber(value.realized_pnl, -1_000_000, 1_000_000),
    unrealized_pnl: boundedPaperNumber(value.unrealized_pnl, -1_000_000, 1_000_000),
    net_pnl: boundedPaperNumber(value.net_pnl, -100, 999_900), return_pct: boundedPaperNumber(value.return_pct, -100, 999_900),
    max_drawdown_pct: boundedPaperNumber(value.max_drawdown_pct, 0, 100), fees: boundedPaperNumber(value.fees, 0, 1_000_000),
    slippage_cost: boundedPaperNumber(value.slippage_cost, 0, 1_000_000),
    trade_count: boundedPaperNumber(value.trade_count, 0, 10_000, true),
    win_count: boundedPaperNumber(value.win_count, 0, 10_000, true),
    loss_count: boundedPaperNumber(value.loss_count, 0, 10_000, true),
  };
  if (chainSequence === null || chainSequence > sharedSequence || !chainHash
    || !['starting', 'active', 'halted', 'complete', 'error'].includes(status)
    || Object.values(numbers).some((entry) => entry === null)
    || Math.abs(numbers.net_pnl - (numbers.equity - 100)) > 1e-6
    || Math.abs(numbers.return_pct - numbers.net_pnl) > 1e-6
    || numbers.win_count + numbers.loss_count > numbers.trade_count) return null;
  const equityCurve = normalizeExperimentEquityCurve(value.equity_curve, chainSequence, numbers.equity);
  const openPosition = normalizeMultiPosition(value.open_position, startedAtMs, latestAtMs);
  const trades = normalizeMultiTrades(value.recent_trades, startedAtMs, latestAtMs);
  const decisions = normalizeMultiDecisions(value.recent_decisions, sharedSequence, startedAtMs, latestAtMs);
  const logs = normalizeMultiLogs(value.recent_logs, startedAtMs, latestAtMs);
  const lastCycleAt = normalizePaperTimestamp(value.last_cycle_at, true);
  const startingState = status === 'starting' && openPosition === null && numbers.trade_count === 0
    && numbers.win_count === 0 && numbers.loss_count === 0 && closePaperNumber(numbers.equity, 100)
    && closePaperNumber(numbers.cash, 100) && closePaperNumber(numbers.realized_pnl, 0)
    && closePaperNumber(numbers.unrealized_pnl, 0) && closePaperNumber(numbers.fees, 0)
    && closePaperNumber(numbers.slippage_cost, 0) && decisions?.length === 0 && trades?.length === 0
    && lastCycleAt === null;
  const recentFees = trades?.reduce((sum, trade) => sum + trade.fees, 0) ?? 0;
  const recentSlippage = trades?.reduce((sum, trade) => sum + trade.slippage_cost, 0) ?? 0;
  const recentNetPnl = trades?.reduce((sum, trade) => sum + trade.net_pnl, 0) ?? 0;
  const recentWins = trades?.filter((trade) => trade.net_pnl > 0).length ?? 0;
  const recentLosses = trades?.filter((trade) => trade.net_pnl < 0).length ?? 0;
  const retainedEntryFee = openPosition === null ? 0 : numbers.fees - recentFees;
  const retainedRealizedPnl = recentNetPnl - retainedEntryFee;
  const modeledOpenEntryFee = !openPosition ? 0 : openPosition.notional * MULTI_FEE_RATE;
  const modeledPreEntryEquity = !openPosition ? 0 : numbers.cash + modeledOpenEntryFee;
  if (!equityCurve || openPosition === undefined || !trades || !decisions || !logs || lastCycleAt === undefined
    || !closePaperNumber(numbers.realized_pnl, numbers.cash - 100)
    || !closePaperNumber(numbers.equity, numbers.cash + numbers.unrealized_pnl)
    || (openPosition === null ? !closePaperNumber(numbers.unrealized_pnl, 0)
      : !closePaperNumber(openPosition.unrealized_pnl, numbers.unrealized_pnl))
    || (openPosition !== null && (!(modeledPreEntryEquity > 0)
      || !closePaperNumber(openPosition.leverage, openPosition.notional / modeledPreEntryEquity)))
    || trades.length > numbers.trade_count || numbers.fees + 1e-6 < recentFees
    || numbers.slippage_cost + 1e-6 < recentSlippage
    || recentWins > numbers.win_count || recentLosses > numbers.loss_count
    || (trades.length === numbers.trade_count && (!closePaperNumber(retainedRealizedPnl, numbers.realized_pnl)
      || (openPosition !== null && !closePaperNumber(retainedEntryFee, modeledOpenEntryFee))
      || recentWins !== numbers.win_count || recentLosses !== numbers.loss_count))
    || (status === 'starting' && !startingState) || (status !== 'starting' && lastCycleAt === null)
    || (lastCycleAt && (Date.parse(lastCycleAt) < startedAtMs || Date.parse(lastCycleAt) > latestAtMs))
    || (['complete', 'error'].includes(status) && openPosition !== null)
    || equityCurve.some((point) => Date.parse(point.at) < startedAtMs || Date.parse(point.at) > latestAtMs)) return null;
  return { arm_id: armId, strategy: { id: expected.id, label: expected.label,
    definition_hash: expected.definition_hash, policy: normalizeMultiPolicy(value.strategy.policy, armId) },
  risk: { ...value.risk }, chain: { sequence: chainSequence, hash: chainHash }, status,
  ...numbers, equity_curve: equityCurve, open_position: openPosition, recent_trades: trades,
  recent_decisions: decisions, recent_logs: logs, last_cycle_at: lastCycleAt };
}

export function normalizeBehaviorMultiPaperExperimentReport(input) {
  const keys = ['schema', 'experiment_id', 'simulation', 'public_data_only', 'generated_at', 'started_at',
    'deadline_at', 'status', 'strategy_set_hash', 'shared_feed', 'assumptions', 'leaderboard', 'arms', 'limitations'];
  if (!exactPaperKeys(input, keys) || input.schema !== 'multi-paper-experiment-v2'
    || input.experiment_id !== BEHAVIOR_MULTI_EXPERIMENT_ID || input.simulation !== true
    || input.public_data_only !== true || input.strategy_set_hash !== MULTI_STRATEGY_SET_HASH) return null;
  const generatedAt = normalizePaperTimestamp(input.generated_at);
  const startedAt = normalizePaperTimestamp(input.started_at);
  const deadlineAt = normalizePaperTimestamp(input.deadline_at);
  const status = boundedPaperText(input.status, 16, true);
  if (!generatedAt || !startedAt || !deadlineAt || Date.parse(deadlineAt) - Date.parse(startedAt) !== DAY_MS
    || Date.parse(generatedAt) < Date.parse(startedAt) || Date.parse(generatedAt) > Date.parse(deadlineAt) + 60 * 60_000
    || !['starting', 'active', 'complete', 'error'].includes(status)) return null;
  const feedKeys = ['sequence', 'hash', 'last_packet_at', 'credential_used', 'symbols', 'channels'];
  if (!exactPaperKeys(input.shared_feed, feedKeys)) return null;
  const sharedSequence = boundedPaperNumber(input.shared_feed.sequence, 1, 100_000_000, true);
  const sharedHash = normalizedExperimentHash(input.shared_feed.hash);
  const lastPacketAt = normalizePaperTimestamp(input.shared_feed.last_packet_at, true);
  if (sharedSequence === null || !sharedHash || lastPacketAt === undefined || input.shared_feed.credential_used !== false
    || JSON.stringify(input.shared_feed.symbols) !== JSON.stringify(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'])
    || JSON.stringify(input.shared_feed.channels) !== JSON.stringify(['ticker', 'books5', 'trade', 'candle1m'])
    || (lastPacketAt && Date.parse(lastPacketAt) > Date.parse(generatedAt))) return null;
  const assumptions = { seed_equity_per_arm: 100, fee_bps_per_side: 6, slippage_bps_per_side: 4,
    modeled_round_trip_cost_bps: 20, risk_pct: 1.5, leverage_cap: 3, drawdown_halt_pct: 10,
    entry_cutoff_at: new Date(Date.parse(deadlineAt) - 15 * 60_000).toISOString(), terminal_close: 'deadline',
    max_positions_per_arm: 1, strategy_mutation: false };
  if (!exactPaperKeys(input.assumptions, Object.keys(assumptions))
    || JSON.stringify(input.assumptions) !== JSON.stringify(assumptions)) return null;
  if (!Array.isArray(input.arms) || input.arms.length !== 6) return null;
  const startedAtMs = Date.parse(startedAt);
  const latestAtMs = Math.min(Date.parse(generatedAt), Date.parse(deadlineAt));
  const arms = input.arms.map((arm, index) => normalizeMultiArm(arm, MULTI_ARM_IDS[index], sharedSequence,
    startedAtMs, latestAtMs));
  if (arms.some((arm) => !arm) || new Set(arms.map((arm) => arm.chain.hash)).size !== 6) return null;
  const armStatuses = arms.map((arm) => arm.status);
  const coherentStatus = status === 'starting' ? armStatuses.every((armStatus) => armStatus === 'starting')
    : status === 'complete' ? armStatuses.every((armStatus) => armStatus === 'complete')
      : status === 'active' ? armStatuses.every((armStatus) => ['active', 'halted'].includes(armStatus))
        : status === 'error' && armStatuses.some((armStatus) => armStatus === 'error')
          && armStatuses.every((armStatus) => ['complete', 'error'].includes(armStatus));
  if (!coherentStatus) return null;
  if (!Array.isArray(input.leaderboard) || input.leaderboard.length !== 6) return null;
  const expectedLeaderboard = [...arms].sort((left, right) => right.equity - left.equity || left.arm_id.localeCompare(right.arm_id));
  const leaderboard = input.leaderboard.map((row, index) => {
    if (!exactPaperKeys(row, ['rank', 'arm_id', 'equity', 'net_pnl', 'return_pct', 'max_drawdown_pct'])) return null;
    const arm = expectedLeaderboard[index];
    return row.rank === index + 1 && row.arm_id === arm.arm_id && ['equity', 'net_pnl', 'return_pct', 'max_drawdown_pct']
      .every((key) => row[key] === arm[key]) ? { ...row } : null;
  });
  const limitations = normalizePaperLimitations(input.limitations);
  if (leaderboard.some((row) => !row) || !limitations) return null;
  return { schema: 'multi-paper-experiment-v2', experiment_id: BEHAVIOR_MULTI_EXPERIMENT_ID,
    simulation: true, public_data_only: true, generated_at: generatedAt, started_at: startedAt,
    deadline_at: deadlineAt, status, strategy_set_hash: MULTI_STRATEGY_SET_HASH,
    shared_feed: { sequence: sharedSequence, hash: sharedHash, last_packet_at: lastPacketAt,
      credential_used: false, symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
      channels: ['ticker', 'books5', 'trade', 'candle1m'] }, assumptions, leaderboard, arms, limitations };
}

function containsForbiddenPaperPrivateText(value) {
  return /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}/iu.test(value)
    || containsForbiddenPaperPrivateIdentifier(value)
    || containsForbiddenPaperPrivateAssignment(value)
    || /(?:^|[\s"'`])\/api\/[^\s"'`]*(?:account|orders?|positions?|private|trade)(?:\/|[\s"'`]|$)/iu.test(value)
    || /\bwss?:\/\/[^\s"'`]+\/private(?:\/|\b)/iu.test(value)
    || /\b(?:account[-_ ]?id|order[-_ ]?id|private[-_ ]?(?:route|field|data))\b(?:\s*(?:=|:)\s*\S+)?/iu.test(value);
}

async function readBehaviorPaperJson(request) {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTI_PAPER_BYTES) {
    return { error: json({ error: '모의투자 보고가 너무 큽니다.' }, 413) };
  }
  const reader = request.body?.getReader();
  if (!reader) return { value: null };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MULTI_PAPER_BYTES) {
        await reader.cancel();
        return { error: json({ error: '모의투자 보고가 너무 큽니다.' }, 413) };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { value: JSON.parse(text), size };
  } catch {
    return { value: null };
  }
}

async function reportBehaviorPaper(request, env) {
  if (!(await ingestTokenMatches(request, env.BEHAVIOR_PAPER_REPORT_TOKEN))) {
    return json({ error: '인증이 필요합니다.' }, 401);
  }
  const body = await readBehaviorPaperJson(request);
  if (body.error) return body.error;
  if (body.value?.schema === 'multi-paper-experiment-v2') return reportBehaviorMultiPaperExperiment(body.value, body.size, env);
  if (body.value?.schema === 'abc-paper-experiment-v1') {
    if (body.size > MAX_BEHAVIOR_PAPER_BYTES) return json({ error: '모의투자 보고가 너무 큽니다.' }, 413);
    return reportBehaviorPaperExperiment(body.value, env);
  }
  if (body.size > MAX_BEHAVIOR_PAPER_BYTES) return json({ error: '모의투자 보고가 너무 큽니다.' }, 413);
  const report = normalizeBehaviorPaperReport(body.value);
  if (!report) return json({ error: '잘못된 모의투자 보고입니다.' }, 400);
  const receivedAt = new Date().toISOString();
  const inserted = await env.DB.prepare(`
    INSERT INTO usage_snapshots(source, captured_at, payload)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(source) DO UPDATE SET
      captured_at = excluded.captured_at,
      payload = excluded.payload
    WHERE CAST(json_extract(excluded.payload, '$.sequence') AS INTEGER)
        >= CAST(json_extract(usage_snapshots.payload, '$.sequence') AS INTEGER)
      AND (
        json_type(usage_snapshots.payload, '$.adaptive') IS NULL
        OR json_type(excluded.payload, '$.adaptive') = 'object'
      )
      AND (
        json_type(usage_snapshots.payload, '$.adaptive') IS NULL
        OR (
          CAST(json_extract(excluded.payload, '$.adaptive.audit.sequence') AS INTEGER)
            >= CAST(json_extract(usage_snapshots.payload, '$.adaptive.audit.sequence') AS INTEGER)
          AND (
            CAST(json_extract(excluded.payload, '$.adaptive.audit.sequence') AS INTEGER)
              > CAST(json_extract(usage_snapshots.payload, '$.adaptive.audit.sequence') AS INTEGER)
            OR (
              json_extract(excluded.payload, '$.adaptive.audit.hash')
                = json_extract(usage_snapshots.payload, '$.adaptive.audit.hash')
              AND json_extract(excluded.payload, '$.adaptive.audit')
                = json_extract(usage_snapshots.payload, '$.adaptive.audit')
            )
          )
        )
      )
      AND (
        CAST(json_extract(excluded.payload, '$.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.sequence') AS INTEGER)
        OR (
          json_type(excluded.payload, '$.adaptive') = 'object'
          AND CAST(json_extract(excluded.payload, '$.adaptive.audit.sequence') AS INTEGER)
            > COALESCE(CAST(json_extract(usage_snapshots.payload, '$.adaptive.audit.sequence') AS INTEGER), -1)
        )
      )
      AND (
        CAST(json_extract(excluded.payload, '$.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.sequence') AS INTEGER)
        OR json_remove(excluded.payload, '$.generated_at', '$.adaptive')
          = json_remove(usage_snapshots.payload, '$.generated_at', '$.adaptive')
      )
  `).bind(
    BEHAVIOR_PAPER_SNAPSHOT_SOURCE,
    receivedAt,
    JSON.stringify(report),
  ).run();
  if (inserted?.meta?.changes !== 1) {
    return json({ error: '더 최신인 보고가 이미 저장되어 있습니다.' }, 409);
  }
  return json({ ok: true, session_id: report.session_id, sequence: report.sequence });
}

async function reportBehaviorPaperExperiment(value, env) {
  const report = normalizeBehaviorPaperExperimentReport(value);
  if (!report) return json({ error: '잘못된 A/B/C 모의실험 보고입니다.' }, 400);
  const receivedAt = new Date().toISOString();
  const inserted = await env.DB.prepare(`
    INSERT INTO usage_snapshots(source, captured_at, payload)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(source) DO UPDATE SET
      captured_at = excluded.captured_at,
      payload = excluded.payload
    WHERE CAST(json_extract(excluded.payload, '$.shared_feed.sequence') AS INTEGER)
        >= CAST(json_extract(usage_snapshots.payload, '$.shared_feed.sequence') AS INTEGER)
      AND CAST(json_extract(excluded.payload, '$.arms[0].chain.sequence') AS INTEGER)
        >= CAST(json_extract(usage_snapshots.payload, '$.arms[0].chain.sequence') AS INTEGER)
      AND CAST(json_extract(excluded.payload, '$.arms[1].chain.sequence') AS INTEGER)
        >= CAST(json_extract(usage_snapshots.payload, '$.arms[1].chain.sequence') AS INTEGER)
      AND CAST(json_extract(excluded.payload, '$.arms[2].chain.sequence') AS INTEGER)
        >= CAST(json_extract(usage_snapshots.payload, '$.arms[2].chain.sequence') AS INTEGER)
      AND (
        CAST(json_extract(excluded.payload, '$.shared_feed.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.shared_feed.sequence') AS INTEGER)
        OR CAST(json_extract(excluded.payload, '$.arms[0].chain.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.arms[0].chain.sequence') AS INTEGER)
        OR CAST(json_extract(excluded.payload, '$.arms[1].chain.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.arms[1].chain.sequence') AS INTEGER)
        OR CAST(json_extract(excluded.payload, '$.arms[2].chain.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.arms[2].chain.sequence') AS INTEGER)
        OR excluded.payload = usage_snapshots.payload
      )
      AND (
        CAST(json_extract(excluded.payload, '$.shared_feed.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.shared_feed.sequence') AS INTEGER)
        OR json_extract(excluded.payload, '$.shared_feed.hash') = json_extract(usage_snapshots.payload, '$.shared_feed.hash')
      )
      AND (
        CAST(json_extract(excluded.payload, '$.arms[0].chain.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.arms[0].chain.sequence') AS INTEGER)
        OR json_extract(excluded.payload, '$.arms[0].chain.hash') = json_extract(usage_snapshots.payload, '$.arms[0].chain.hash')
      )
      AND (
        CAST(json_extract(excluded.payload, '$.arms[1].chain.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.arms[1].chain.sequence') AS INTEGER)
        OR json_extract(excluded.payload, '$.arms[1].chain.hash') = json_extract(usage_snapshots.payload, '$.arms[1].chain.hash')
      )
      AND (
        CAST(json_extract(excluded.payload, '$.arms[2].chain.sequence') AS INTEGER)
          > CAST(json_extract(usage_snapshots.payload, '$.arms[2].chain.sequence') AS INTEGER)
        OR json_extract(excluded.payload, '$.arms[2].chain.hash') = json_extract(usage_snapshots.payload, '$.arms[2].chain.hash')
      )
  `).bind(BEHAVIOR_ABC_SNAPSHOT_SOURCE, receivedAt, JSON.stringify(report)).run();
  if (inserted?.meta?.changes !== 1) return json({ error: '더 최신인 A/B/C 보고가 이미 저장되어 있습니다.' }, 409);
  return json({ ok: true, experiment_id: report.experiment_id, shared_feed_sequence: report.shared_feed.sequence,
    snapshot_fingerprint: await sha256(JSON.stringify(report)) });
}

async function reportBehaviorMultiPaperExperiment(value, bodySize, env) {
  if (!Number.isSafeInteger(bodySize) || bodySize < 1 || bodySize > MAX_MULTI_PAPER_BYTES) {
    return json({ error: '모의투자 보고가 너무 큽니다.' }, 413);
  }
  const report = normalizeBehaviorMultiPaperExperimentReport(value);
  if (!report) return json({ error: '잘못된 6-arm v2 모의실험 보고입니다.' }, 400);
  const receivedAt = new Date().toISOString();
  const references = ['$.shared_feed', ...MULTI_ARM_IDS.map((_, index) => `$.arms[${index}].chain`)];
  const monotonic = references.map((path) => `
    CAST(json_extract(excluded.payload, '${path}.sequence') AS INTEGER)
      >= CAST(json_extract(usage_snapshots.payload, '${path}.sequence') AS INTEGER)
  `).join(' AND ');
  const advanced = references.map((path) => `
    CAST(json_extract(excluded.payload, '${path}.sequence') AS INTEGER)
      > CAST(json_extract(usage_snapshots.payload, '${path}.sequence') AS INTEGER)
  `).join(' OR ');
  const stableAtSameSequence = references.map((path) => `(
    CAST(json_extract(excluded.payload, '${path}.sequence') AS INTEGER)
      > CAST(json_extract(usage_snapshots.payload, '${path}.sequence') AS INTEGER)
    OR json_extract(excluded.payload, '${path}.hash') = json_extract(usage_snapshots.payload, '${path}.hash')
  )`).join(' AND ');
  const inserted = await env.DB.prepare(`
    INSERT INTO usage_snapshots(source, captured_at, payload)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(source) DO UPDATE SET
      captured_at = excluded.captured_at,
      payload = excluded.payload
    WHERE ${monotonic}
      AND (${advanced} OR excluded.payload = usage_snapshots.payload)
      AND ${stableAtSameSequence}
  `).bind(BEHAVIOR_MULTI_SNAPSHOT_SOURCE, receivedAt, JSON.stringify(report)).run();
  if (inserted?.meta?.changes !== 1) return json({ error: '더 최신인 6-arm v2 보고가 이미 저장되어 있습니다.' }, 409);
  return json({ ok: true, experiment_id: report.experiment_id,
    shared_feed_sequence: report.shared_feed.sequence,
    snapshot_fingerprint: await sha256(JSON.stringify(report)) });
}

async function getBehaviorPaper(request, env) {
  const owner = await behaviorOwner(request, env);
  if (owner.response) return owner.response;
  const row = await env.DB.prepare(`
    SELECT captured_at, payload
    FROM usage_snapshots
    WHERE source = ?1
    LIMIT 1
  `).bind(BEHAVIOR_PAPER_SNAPSHOT_SOURCE).first();
  const experimentRow = await env.DB.prepare(`
    SELECT source, captured_at, payload
    FROM usage_snapshots
    WHERE source = ?1
    LIMIT 1
  `).bind(BEHAVIOR_ABC_SNAPSHOT_SOURCE).first();
  const multiExperimentRow = await env.DB.prepare(`
    SELECT source, captured_at, payload
    FROM usage_snapshots
    WHERE source = ?1
    LIMIT 1
  `).bind(BEHAVIOR_MULTI_SNAPSHOT_SOURCE).first();
  let v2Experiment = null;
  if (multiExperimentRow?.source === BEHAVIOR_MULTI_SNAPSHOT_SOURCE) {
    try { v2Experiment = normalizeBehaviorMultiPaperExperimentReport(JSON.parse(multiExperimentRow.payload)); }
    catch { v2Experiment = null; }
    if (!v2Experiment) return json({ error: '6-arm v2 보고 데이터를 읽지 못했습니다.' }, 500,
      { 'cache-control': 'private, no-store' });
  }
  const v2Active = v2Experiment && ['starting', 'active'].includes(v2Experiment.status) ? v2Experiment : null;
  let v1Experiment = null;
  if (!v2Active && experimentRow?.source === BEHAVIOR_ABC_SNAPSHOT_SOURCE) {
    try { v1Experiment = normalizeBehaviorPaperExperimentReport(JSON.parse(experimentRow.payload)); } catch { v1Experiment = null; }
    if (!v1Experiment) return json({ error: 'A/B/C 보고 데이터를 읽지 못했습니다.' }, 500,
      { 'cache-control': 'private, no-store' });
  }
  const experiment = v2Active || v1Experiment;
  const experimentReceivedAt = v2Active ? multiExperimentRow.captured_at : experimentRow?.captured_at ?? null;
  if (!row) return json({ session_id: BEHAVIOR_PAPER_SESSION_ID, deadline_at: BEHAVIOR_PAPER_DEADLINE,
    report: null, experiment, experiment_received_at: experimentReceivedAt }, 200,
  { 'cache-control': 'private, no-store' });
  let report;
  try { report = normalizeBehaviorPaperReport(JSON.parse(row.payload)); } catch { report = null; }
  if (!report) return json({ error: '보고 데이터를 읽지 못했습니다.' }, 500);
  return json({ report, received_at: row.captured_at, experiment, experiment_received_at: experimentReceivedAt }, 200,
    { 'cache-control': 'private, no-store' });
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
  const unreadValues = params.getAll('unread');
  if (limits.length > 1 || cursors.length > 1 || unreadValues.length > 1) return null;
  const limitText = limits[0];
  const limit = limitText === undefined ? 50 : Number(limitText);
  if (limitText !== undefined && (!/^[1-9]\d{0,2}$/u.test(limitText) || limit > 100)) return null;
  const cursor = cursors.length === 0 ? null : parseModeratorCursor(cursors[0]);
  if (cursors.length === 1 && cursor === null) return null;
  const unreadText = unreadValues[0];
  if (unreadText !== undefined && unreadText !== '0' && unreadText !== '1') return null;
  return { limit, cursor, unreadOnly: unreadText === '1' };
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

function moderatorItemRequiresAction(row) {
  return (row.kind === 'important' && row.status === 'open')
    || (row.kind === 'proposal' && row.status === 'pending');
}

function serializeModeratorItem(row, events = []) {
  if (!row) return null;
  const seenVersion = Number(row.seen_version ?? 0);
  return {
    item_id: row.item_id,
    kind: row.kind,
    status: row.status,
    issue_summary: row.issue_summary,
    action_summary: row.action_summary,
    proposed_command: row.proposed_command ?? null,
    version: row.version,
    seen_version: seenVersion,
    unread: moderatorItemRequiresAction(row) || seenVersion < Number(row.version),
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
  const seenAt = row.seen_at ?? null;
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
    seen_at: seenAt,
    unread: seenAt === null || seenAt < row.updated_at,
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
      AND task_id NOT IN (${MODERATOR_RESIDENT_TASK_IDS.map((_, index) => `?${index + 2}`).join(', ')})
      AND julianday(COALESCE(NULLIF(heartbeat_at, ''), updated_at)) > julianday(?1)
  `).bind(cutoff, ...MODERATOR_RESIDENT_TASK_IDS).first();
  return Number(row?.count || 0);
}

// 모더 데몬이 스스로 남기는 하트비트. `/api/moderator`는 이것으로 "모더가 살아 있는가"를
// 말한다 — 예전에는 마지막 **항목**의 시각을 그 자리에 세워서, 데몬이 죽어도 화면은
// 마지막 항목 시각을 그대로 보여 주었고 사용자가 그것을 생존 신호로 읽었다.
async function moderatorDaemonHeartbeat(env) {
  const row = await env.DB.prepare(`
    SELECT COALESCE(NULLIF(heartbeat_at, ''), updated_at) AS at
    FROM harness_tasks
    WHERE task_id = ?1
  `).bind(MODERATOR_DAEMON_TASK_ID).first();
  return row?.at ?? null;
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

  const itemUnreadWhere = query.unreadOnly ? MODERATOR_ITEM_UNREAD_SQL : '1 = 1';
  const itemStatement = query.cursor
    ? env.DB.prepare(`
      SELECT * FROM moderator_items
      WHERE ${itemUnreadWhere}
        AND (updated_at < ?1 OR (updated_at = ?1 AND item_id < ?2))
      ORDER BY updated_at DESC, item_id DESC
      LIMIT ?3
    `).bind(query.cursor.updatedAt, query.cursor.itemId, query.limit + 1)
    : env.DB.prepare(`
      SELECT * FROM moderator_items
      WHERE ${itemUnreadWhere}
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

  const commandUnreadWhere = query.unreadOnly ? MODERATOR_COMMAND_UNREAD_SQL : '1 = 1';
  const [
    commandRows,
    countRows,
    unreadItemCountRows,
    unreadCommandCountRow,
    brainRow,
    activeSessions,
    activeCommands,
    daemonHeartbeatAt,
  ] = await Promise.all([
    env.DB.prepare(`
      SELECT * FROM moderator_commands
      WHERE ${commandUnreadWhere}
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
      SELECT kind, COUNT(*) AS count
      FROM moderator_items
      WHERE ${MODERATOR_ITEM_UNREAD_SQL}
      GROUP BY kind
      ORDER BY kind
    `).all(),
    env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM moderator_commands
      WHERE ${MODERATOR_COMMAND_UNREAD_SQL}
    `).first(),
    env.DB.prepare(`
      SELECT brain_model, brain_reasoning, worker_model, worker_reasoning, updated_at
      FROM moderator_items
      WHERE brain_model IS NOT NULL OR worker_model IS NOT NULL
      ORDER BY updated_at DESC, item_id DESC
      LIMIT 1
    `).first(),
    moderatorActiveTaskCount(env),
    moderatorActiveCommandCount(env),
    moderatorDaemonHeartbeat(env),
  ]);
  const counts = { important: {}, proposal: {}, review: {} };
  for (const row of countRows.results || []) {
    if (counts[row.kind]) counts[row.kind][row.status] = Number(row.count || 0);
  }
  const unreadCounts = { important: 0, proposal: 0, review: 0, record: 0 };
  for (const row of unreadItemCountRows.results || []) {
    if (Object.hasOwn(unreadCounts, row.kind)) unreadCounts[row.kind] = Number(row.count || 0);
  }
  unreadCounts.record = Number(unreadCommandCountRow?.count || 0);
  const hasNext = (itemRows.results || []).length > query.limit;
  return json({
    brain: {
      model: brainRow?.brain_model ?? null,
      reasoning: brainRow?.brain_reasoning ?? null,
      worker_model: brainRow?.worker_model ?? null,
      worker_reasoning: brainRow?.worker_reasoning ?? null,
      updated_at: brainRow?.updated_at ?? null,
    },
    // 모더 자신의 생존. brain.updated_at(마지막 항목 시각)과 **다른 사실**이다.
    daemon: { heartbeat_at: daemonHeartbeatAt, stale_after_ms: HARNESS_STALE_MS },
    active_sessions: activeSessions,
    active_commands: activeCommands,
    counts,
    unread_counts: unreadCounts,
    commands: (commandRows.results || []).map(serializeModeratorCommand),
    items: pageRows.map((row) => serializeModeratorItem(row, eventsByItem.get(row.item_id) || [])),
    next_cursor: hasNext ? moderatorCursor(pageRows.at(-1)) : null,
  });
}

function moderatorReadTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? value : null;
}

async function markModeratorRead(request, env) {
  const owner = await moderatorOwner(request, env);
  if (owner.response) return owner.response;
  const parsed = await readModeratorJson(request);
  if (parsed.response) return parsed.response;
  const itemEntries = parsed.value.items === undefined ? [] : parsed.value.items;
  const commandEntries = parsed.value.commands === undefined ? [] : parsed.value.commands;
  if (!Array.isArray(itemEntries) || !Array.isArray(commandEntries)) {
    return moderatorError('invalid_item');
  }
  const entryCount = itemEntries.length + commandEntries.length;
  if (entryCount > MAX_MODERATOR_READ_ENTRIES) {
    return moderatorError('request_too_large', 413);
  }
  if (entryCount === 0) return moderatorError('invalid_item');

  const items = new Map();
  for (const entry of itemEntries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.item_id !== 'string'
      || !MODERATOR_ID_PATTERN.test(entry.item_id)
      || !Number.isSafeInteger(entry.version)
      || entry.version <= 0) return moderatorError('invalid_item');
    items.set(entry.item_id, Math.max(items.get(entry.item_id) || 0, entry.version));
  }
  const commands = new Map();
  for (const entry of commandEntries) {
    const updatedAt = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? moderatorReadTimestamp(entry.updated_at)
      : null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.command_id !== 'string'
      || !MODERATOR_ID_PATTERN.test(entry.command_id)
      || updatedAt === null) return moderatorError('invalid_item');
    const existing = commands.get(entry.command_id);
    if (existing !== undefined && existing !== updatedAt) return moderatorError('invalid_item');
    commands.set(entry.command_id, updatedAt);
  }

  const itemStatements = [...items].map(([itemId, version]) => env.DB.prepare(`
    UPDATE moderator_items
    SET seen_version = ?2
    WHERE item_id = ?1 AND seen_version < ?2
  `).bind(itemId, version));
  const commandStatements = [...commands].map(([commandId, updatedAt]) => env.DB.prepare(`
    UPDATE moderator_commands
    SET seen_at = ?2
    WHERE command_id = ?1 AND (seen_at IS NULL OR seen_at < ?2)
  `).bind(commandId, updatedAt));
  const results = await env.DB.batch([...itemStatements, ...commandStatements]);
  return json({
    marked: {
      items: results.slice(0, itemStatements.length).reduce(
        (total, result) => total + moderatorChanges(result),
        0,
      ),
      commands: results.slice(itemStatements.length).reduce(
        (total, result) => total + moderatorChanges(result),
        0,
      ),
    },
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
  // The moderator decides everything the user policy does not reserve for the user:
  // new-feature proposals, payment and credentials, critical deletion. Work it decided
  // itself arrives already approved and carries the policy clause that let it through,
  // so the tab can always show why nobody was asked.
  const moderatorOwned = input.moderator_owned === true;
  const policyBasis = moderatorFact(input.policy_basis, 200);
  if (!VALID_MODERATOR_KINDS.has(kind)
    || !MODERATOR_ID_PATTERN.test(itemId)
    || !issueSummary
    || !actionSummary
    || !brain
    || !worker
    || !sourceTask.ok
    || !reviewLease.ok
    || !policyBasis.ok
    || (moderatorOwned && (kind !== 'proposal' || status !== 'approved' || !policyBasis.value))
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
    moderatorOwned,
    policyBasis: policyBasis.value,
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
    || (normalized.kind === 'proposal' && normalized.status === 'pending')
    || (normalized.kind === 'proposal' && normalized.status === 'approved' && normalized.moderatorOwned);
  if (!validInitial || normalized.reviewLeaseId !== null) return moderatorError('invalid_transition');
  const statements = [
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
      normalized.kind === 'review' || normalized.moderatorOwned ? timestamp : null,
    ),
    env.DB.prepare(MODERATOR_ITEM_EVENT_AFTER_CHANGE_SQL).bind(
      normalized.itemId,
      normalized.moderatorOwned ? 'moderator_approved' : 'created',
      timestamp,
      JSON.stringify(normalized.moderatorOwned
        ? { kind: normalized.kind, decided_by: 'moderator', policy_basis: normalized.policyBasis }
        : { kind: normalized.kind }),
    ),
  ];
  // Queue insertion reuses the approval statement, so a moderator-owned item reaches the
  // executor through exactly the same path a user-approved proposal does. There is no
  // second way for a command to enter the queue.
  if (normalized.moderatorOwned) {
    statements.push(env.DB.prepare(MODERATOR_PROPOSAL_COMMAND_AFTER_EVENT_SQL).bind(
      moderatorId('cmd'),
      `proposal:${normalized.itemId}`,
      MODERATOR_REQUESTED_MODEL,
      MODERATOR_REQUESTED_REASONING,
      timestamp,
      normalized.itemId,
    ));
  }
  const results = await env.DB.batch(statements);
  if (moderatorChanges(results[0]) !== 1) return moderatorError('item_conflict', 409);
  const command = normalized.moderatorOwned
    ? await moderatorCommandBySourceItem(env, normalized.itemId)
    : null;
  return json({
    item: serializeModeratorItem(await moderatorItemById(env, normalized.itemId)),
    command: serializeModeratorCommand(command),
    duplicate: false,
  }, 201);
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

  if (method === 'GET' && path === '/api/behavior-lab/dashboard') {
    const owner = await behaviorOwner(request, env);
    if (owner.response) return owner.response;
    try {
      return json(await getBehaviorLabDashboard(request.url), 200, { 'cache-control': 'private, no-store' });
    } catch (error) {
      if (error instanceof BehaviorLabRequestError) {
        return json({ error: error.message }, error.status, { 'cache-control': 'private, no-store' });
      }
      throw error;
    }
  }
  if (method === 'GET' && path === '/api/behavior-lab/paper') {
    return getBehaviorPaper(request, env);
  }
  if (method === 'POST' && path === '/api/behavior-lab/paper/report') {
    return reportBehaviorPaper(request, env);
  }

  if (method === 'GET' && path === '/api/me') {
    const session = await authenticate(request, env);
    return session
      ? json({ user: { id: session.user_id, username: session.username } })
      : json({ error: '로그인이 필요합니다.' }, 401);
  }

  if (method === 'POST' && path === '/api/logout') return logout(request, env);
  if (method === 'POST' && path === '/api/usage/report') return reportUsage(request, env);
  if (method === 'POST' && path === '/api/harness/report') return reportHarness(request, env);
  if (method === 'POST' && path === '/api/competitions/report') {
    return reportCompetitions(request, env);
  }
  const competitionApprovalMatch = path.match(
    /^\/api\/competitions\/approvals\/([A-Za-z0-9][A-Za-z0-9._-]{0,159})\/decision$/u,
  );
  if (method === 'POST' && competitionApprovalMatch) {
    return decideCompetitionApproval(request, env, competitionApprovalMatch[1]);
  }
  if (method === 'GET' && path === '/api/competitions') return getCompetitions(request, env);
  if (method === 'GET' && path === '/api/usage') return usage(request, env);
  if (method === 'GET' && path === '/api/moderator') return getModerator(request, env);
  if (method === 'POST' && path === '/api/moderator/read') return markModeratorRead(request, env);
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
    return updateModeratorCommandState(request, env, moderatorPathId(moderatorCommandStateMatch[1]));
  }
  const moderatorDaemonCloseMatch = path.match(/^\/api\/moderator\/daemon\/items\/([^/]+)\/close$/u);
  if (method === 'POST' && moderatorDaemonCloseMatch) {
    return closeModeratorDaemonItem(request, env, moderatorPathId(moderatorDaemonCloseMatch[1]));
  }
  const moderatorDecisionMatch = path.match(/^\/api\/moderator\/items\/([^/]+)\/decision$/u);
  if (method === 'POST' && moderatorDecisionMatch) {
    return decideModeratorItem(request, env, moderatorPathId(moderatorDecisionMatch[1]));
  }
  const moderatorAcknowledgeMatch = path.match(/^\/api\/moderator\/items\/([^/]+)\/acknowledge$/u);
  if (method === 'POST' && moderatorAcknowledgeMatch) {
    return acknowledgeModeratorItem(request, env, moderatorPathId(moderatorAcknowledgeMatch[1]));
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
