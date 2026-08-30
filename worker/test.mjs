import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import worker from './src/index.js';
import {
  HARNESS_STALE_MS,
  MODERATOR_COMMAND_CLAIM_SQL,
  MODERATOR_ITEM_EVENT_AFTER_CHANGE_SQL,
  MODERATOR_PROPOSAL_APPROVE_SQL,
  MODERATOR_PROPOSAL_COMMAND_AFTER_EVENT_SQL,
  USAGE_SNAPSHOT_UPSERT_SQL,
  effectiveHarnessStatus,
  fixedTimeEqual,
  fixedTimeTextEqual,
  latestHarnessDelivery,
  mergeHarnessReport,
} from './src/router.js';
import {
  DAY_MS,
  clientIp,
  createToken,
  issueSession,
  normalizeAnswer,
  passwordHash,
  readJson,
  sha256,
} from './src/lib.js';

const ROUTER_SOURCE = readFileSync(new URL('./src/router.js', import.meta.url), 'utf8');

test('project delivery uses the newest task summary instead of mixing historical release SHAs', () => {
  const oldTask = {
    status: 'complete', input: 'old request',
    delivery: { request: 'old request', plan: ['old plan'], changes: ['Codex old0000'], verification: ['old gate'] },
    actors: [],
  };
  const latestTask = {
    status: 'complete', input: 'current request',
    delivery: {
      request: 'current request', plan: ['current plan'],
      changes: ['Codex abcdef1', 'Claude bcdefa2', 'hvsdcm1 cdefab3'],
      verification: ['current gate'],
    },
    actors: [],
  };
  assert.deepEqual(latestHarnessDelivery([oldTask, latestTask]), {
    request: 'current request',
    plan: ['current plan'],
    changes: ['Codex abcdef1', 'Claude bcdefa2', 'hvsdcm1 cdefab3'],
    verification: ['current gate'],
    approval: null,
  });
});

function createLoginTestDb(user = null) {
  const limits = new Map();
  const sessions = [];
  let userLookups = 0;

  return {
    limits,
    sessions,
    get userLookups() { return userLookups; },
    resetMinuteWindows() {
      for (const state of limits.values()) state.minuteStartedAt = Date.now() - 60_001;
    },
    prepare(sql) {
      const query = sql.replace(/\s+/gu, ' ').trim();
      return {
        bind(...values) {
          if (query.startsWith('INSERT INTO login_attempt_limits')) {
            return {
              async first() {
                const [keyHash, attemptedAt, minuteCutoff] = values;
                let state = limits.get(keyHash);
                if (!state) {
                  state = {
                    minuteStartedAt: attemptedAt,
                    minuteAttempts: 1,
                    failureWindowStartedAt: null,
                    failureCount: 0,
                    lockedUntil: 0,
                    updatedAt: attemptedAt,
                  };
                  limits.set(keyHash, state);
                } else if (state.minuteStartedAt <= minuteCutoff) {
                  state.minuteStartedAt = attemptedAt;
                  state.minuteAttempts = 1;
                  state.updatedAt = attemptedAt;
                } else {
                  state.minuteAttempts += 1;
                  state.updatedAt = attemptedAt;
                }
                return {
                  minute_started_at: state.minuteStartedAt,
                  minute_attempts: state.minuteAttempts,
                  locked_until: state.lockedUntil,
                };
              },
            };
          }

          if (query.startsWith('UPDATE login_attempt_limits SET failure_window_started_at = CASE')) {
            return {
              async first() {
                const [keyHash, attemptedAt, failureCutoff, lockUntil, failureLimit] = values;
                const state = limits.get(keyHash);
                assert.ok(state, 'attempt counter must exist before recording a failure');
                const resetFailures = state.failureWindowStartedAt === null
                  || state.failureWindowStartedAt <= failureCutoff;
                state.failureWindowStartedAt = resetFailures
                  ? attemptedAt
                  : state.failureWindowStartedAt;
                state.failureCount = resetFailures ? 1 : state.failureCount + 1;
                if (state.failureCount >= failureLimit) {
                  state.lockedUntil = Math.max(state.lockedUntil, lockUntil);
                }
                state.updatedAt = attemptedAt;
                return {
                  failure_count: state.failureCount,
                  locked_until: state.lockedUntil,
                };
              },
            };
          }

          if (query.startsWith('UPDATE login_attempt_limits SET failure_window_started_at = NULL')) {
            return {
              async run() {
                const [keyHash, attemptedAt] = values;
                const state = limits.get(keyHash);
                assert.ok(state, 'attempt counter must exist before clearing failures');
                state.failureWindowStartedAt = null;
                state.failureCount = 0;
                state.lockedUntil = 0;
                state.updatedAt = attemptedAt;
                return { success: true };
              },
            };
          }

          if (query.startsWith('SELECT * FROM users WHERE username = ?')) {
            return {
              async first() {
                userLookups += 1;
                return user && user.username.toLowerCase() === String(values[0]).toLowerCase()
                  ? user
                  : null;
              },
            };
          }

          if (query.startsWith('INSERT INTO sessions')) {
            return {
              async run() {
                sessions.push(values);
                return { success: true };
              },
            };
          }

          if (query.startsWith('UPDATE users SET last_login_at')
            || query.startsWith('INSERT INTO activity')) {
            return { async run() { return { success: true }; } };
          }

          throw new Error(`Unexpected login SQL in test: ${query}`);
        },
      };
    },
  };
}

function loginRequest(path, body, ip = '198.51.100.40') {
  return new Request(`https://api.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': ip,
    },
    body: JSON.stringify(body),
  });
}

test('client IP uses the Cloudflare address and enforces a storage limit', () => {
  const request = new Request('https://api.test', {
    headers: { 'cf-connecting-ip': '2001:db8::1234' },
  });
  assert.equal(clientIp(request), '2001:db8::1234');
  assert.equal(clientIp(new Request('https://api.test')), 'unknown');
  assert.equal(clientIp(new Request('https://api.test', {
    headers: { 'cf-connecting-ip': '   ' },
  })), 'unknown');
  assert.equal(clientIp(new Request('https://api.test', {
    headers: { 'cf-connecting-ip': 'a'.repeat(100) },
  })).length, 64);
});

test('issued sessions persist IP and device metadata without storing the raw token', async () => {
  const calls = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            calls.push({ sql, values });
            return { async run() { return { success: true }; } };
          },
        };
      },
    },
  };
  const request = new Request('https://api.test', {
    headers: {
      'cf-connecting-ip': '203.0.113.7',
      'user-agent': 'Example Browser',
    },
  });
  const rawToken = await issueSession(env, 7, 'user', request);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ip_address/u);
  assert.equal(calls[0].values[7], '203.0.113.7');
  assert.equal(calls[0].values[8], 'Example Browser');
  assert.notEqual(calls[0].values[0], rawToken);
});

test('answer normalization is stable for spacing and punctuation', () => {
  assert.equal(normalizeAnswer('  사회·문화 (현상)! '), '사회문화현상');
  assert.equal(normalizeAnswer('Ａ-B_C'), 'abc');
});

test('hash helpers are deterministic and tokens are URL-safe', async () => {
  assert.equal(
    await sha256('hvsdcm'),
    'ce64ad5e16daaa12f3ca200b1179791133d48ae2803c3c70f087e3b7e77c27ed',
  );
  assert.equal(await passwordHash('password', 'salt'), await passwordHash('password', 'salt'));
  assert.match(createToken(), /^[A-Za-z0-9_-]{43}$/);
});

test('login text comparison uses fixed-length constant-time bytes', async () => {
  assert.equal(fixedTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(fixedTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assert.equal(await fixedTimeTextEqual('same password', 'same password'), true);
  assert.equal(await fixedTimeTextEqual('short', 'a different-length password'), false);
});

test('login routes retain atomic D1 counters and fixed-time password calls', () => {
  assert.match(ROUTER_SOURCE, /const LOGIN_ATTEMPTS_PER_MINUTE = 5;/u);
  assert.match(ROUTER_SOURCE, /const LOGIN_FAILURES_PER_WINDOW = 10;/u);
  assert.match(ROUTER_SOURCE, /const LOGIN_LOCK_MS = 15 \* LOGIN_MINUTE_MS;/u);
  assert.match(
    ROUTER_SOURCE,
    /INSERT INTO login_attempt_limits[\s\S]*ON CONFLICT\(key_hash\) DO UPDATE SET[\s\S]*login_attempt_limits\.minute_attempts \+ 1[\s\S]*RETURNING minute_started_at, minute_attempts, locked_until/u,
  );
  assert.match(
    ROUTER_SOURCE,
    /UPDATE login_attempt_limits[\s\S]*SET failure_window_started_at = CASE[\s\S]*failure_count \+ 1[\s\S]*>= \?5 THEN MAX\(locked_until, \?4\)[\s\S]*RETURNING failure_count, locked_until/u,
  );

  const userLogin = /async function login\([\s\S]*?\n\}\n\nasync function adminLogin/u.exec(ROUTER_SOURCE)?.[0] || '';
  const adminLogin = /async function adminLogin\([\s\S]*?\n\}\n\nasync function ingestTokenMatches/u.exec(ROUTER_SOURCE)?.[0] || '';
  assert.match(userLogin, /await fixedTimeTextEqual\(suppliedHash, user\.password_hash\)/u);
  assert.match(userLogin, /if \(!user \|\| user\.disabled \|\| !passwordMatches\)/u);
  assert.match(adminLogin, /await fixedTimeTextEqual\([\s\S]*String\(env\.ADMIN_PASSWORD \|\| ''\)/u);
  assert.match(adminLogin, /if \(!env\.ADMIN_PASSWORD \|\| !passwordMatches\)/u);
});

test('login limiter key combines route, normalized account, and client IP without raw metadata', async () => {
  const db = createLoginTestDb();
  const env = {
    ADMIN_PASSWORD: 'correct-password',
    ALLOWED_ORIGIN: 'https://example.test',
    DB: db,
  };
  const userAttempt = (username, ip) => worker.fetch(loginRequest('/api/login', {
    username, password: 'wrong',
  }, ip), env);

  assert.equal((await userAttempt('Student', '198.51.100.1')).status, 401);
  assert.equal((await userAttempt('student', '198.51.100.1')).status, 401);
  assert.equal(db.limits.size, 1, 'account case variants must share one counter');

  assert.equal((await userAttempt('other', '198.51.100.1')).status, 401);
  assert.equal((await userAttempt('student', '198.51.100.2')).status, 401);
  assert.equal((await userAttempt('admin', '198.51.100.1')).status, 401);
  assert.equal((await worker.fetch(loginRequest('/api/admin/login', {
    password: 'wrong',
  }, '198.51.100.1'), env)).status, 401);
  assert.equal(db.limits.size, 5, 'account, IP, and route changes must each select a distinct counter');
  for (const key of db.limits.keys()) assert.match(key, /^[a-f0-9]{64}$/u);
});

test('user and admin login allow five attempts per minute and reject the sixth', async () => {
  const cases = [
    { path: '/api/login', body: { username: 'student', password: 'wrong' } },
    { path: '/api/admin/login', body: { password: 'wrong' } },
  ];

  for (const current of cases) {
    const db = createLoginTestDb();
    const env = {
      ADMIN_PASSWORD: 'correct-password',
      ALLOWED_ORIGIN: 'https://example.test',
      DB: db,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await worker.fetch(loginRequest(current.path, current.body), env);
      assert.equal(response.status, 401, `${current.path} attempt ${attempt}`);
    }

    const limited = await worker.fetch(loginRequest(current.path, current.body), env);
    assert.equal(limited.status, 429, current.path);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.ok(Number(limited.headers.get('retry-after')) <= 60);
  }
});

test('user and admin login lock for fifteen minutes on the tenth hourly failure', async () => {
  const cases = [
    { path: '/api/login', body: { username: 'student', password: 'wrong' } },
    { path: '/api/admin/login', body: { password: 'wrong' } },
  ];

  for (const current of cases) {
    const db = createLoginTestDb();
    const env = {
      ADMIN_PASSWORD: 'correct-password',
      ALLOWED_ORIGIN: 'https://example.test',
      DB: db,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await worker.fetch(loginRequest(current.path, current.body), env);
      assert.equal(response.status, 401, `${current.path} failure ${attempt}`);
    }
    db.resetMinuteWindows();
    for (let attempt = 6; attempt <= 9; attempt += 1) {
      const response = await worker.fetch(loginRequest(current.path, current.body), env);
      assert.equal(response.status, 401, `${current.path} failure ${attempt}`);
    }

    const locked = await worker.fetch(loginRequest(current.path, current.body), env);
    assert.equal(locked.status, 429, current.path);
    assert.equal(Number(locked.headers.get('retry-after')), 900);

    const lookupsBeforeLockedRetry = db.userLookups;
    const lockedRetry = await worker.fetch(loginRequest(current.path, current.body), env);
    assert.equal(lockedRetry.status, 429, current.path);
    assert.ok(Number(lockedRetry.headers.get('retry-after')) >= 899);
    assert.equal(db.userLookups, lookupsBeforeLockedRetry, 'locked requests must skip credential lookup');
  }
});

test('successful user and admin login clear only their failure lock state', async () => {
  const passwordSalt = 'test-salt';
  const db = createLoginTestDb({
    id: 7,
    username: 'student',
    password_salt: passwordSalt,
    password_hash: await passwordHash('correct-password', passwordSalt),
    disabled: 0,
  });
  const env = {
    ADMIN_PASSWORD: 'correct-password',
    ALLOWED_ORIGIN: 'https://example.test',
    DB: db,
  };

  assert.equal((await worker.fetch(loginRequest('/api/login', {
    username: 'student', password: 'wrong',
  }), env)).status, 401);
  assert.equal((await worker.fetch(loginRequest('/api/admin/login', {
    password: 'wrong',
  }), env)).status, 401);

  assert.equal((await worker.fetch(loginRequest('/api/login', {
    username: 'student', password: 'correct-password',
  }), env)).status, 200);
  assert.equal((await worker.fetch(loginRequest('/api/admin/login', {
    password: 'correct-password',
  }), env)).status, 200);

  assert.equal(db.sessions.length, 2);
  for (const state of db.limits.values()) {
    assert.equal(state.failureCount, 0);
    assert.equal(state.minuteAttempts, 2, 'a success must not reset the per-minute attempt counter');
  }
});

test('invalid JSON request bodies resolve to an empty object', async () => {
  const request = new Request('https://example.test/api', {
    method: 'POST',
    body: '{broken',
  });
  assert.deepEqual(await readJson(request), {});
});

test('OPTIONS and unknown routes include CORS headers', async () => {
  const env = { ALLOWED_ORIGIN: 'https://example.test' };
  const options = await worker.fetch(new Request('https://api.test/api/me', {
    method: 'OPTIONS',
  }), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), env.ALLOWED_ORIGIN);

  const missing = await worker.fetch(new Request('https://api.test/not-found'), env);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Not found' });
  assert.equal(missing.headers.get('access-control-allow-origin'), env.ALLOWED_ORIGIN);
});

const GICHUL_USER_TOKEN_HASH = await sha256('user-token');
const GICHUL_DISABLED_TOKEN_HASH = await sha256('disabled-token');

function createGichulEnv({ exams = [], pdfs = new Map(), learningObjects = new Map(), manifestExists = true } = {}) {
  const r2Reads = [];
  const manifest = { exams };
  return {
    ALLOWED_ORIGIN: 'https://hvsdcm1.xyz',
    r2Reads,
    DB: {
      prepare(sql) {
        const query = sql.replace(/\s+/gu, ' ').trim();
        return {
          bind(...values) {
            if (query.startsWith('SELECT s.*, u.username, u.disabled FROM sessions')) {
              return {
                async first() {
                  if (values[0] === GICHUL_DISABLED_TOKEN_HASH) {
                    return {
                      token_hash: values[0], user_id: 8, role: 'user', username: 'disabled', disabled: 1,
                    };
                  }
                  if (values[0] !== GICHUL_USER_TOKEN_HASH) return null;
                  return {
                    token_hash: values[0], user_id: 7, role: 'user', username: 'learner', disabled: 0,
                  };
                },
              };
            }
            if (query.startsWith('UPDATE sessions SET last_seen_at')) {
              return { async run() { return { success: true }; } };
            }
            throw new Error(`Unexpected gichul SQL in test: ${query}`);
          },
        };
      },
    },
    GICHUL: {
      async get(key) {
        r2Reads.push(key);
        if (learningObjects.has(key)) return { body: learningObjects.get(key) };
        if (key === 'manifest.json') {
          if (!manifestExists) return null;
          return {
            body: JSON.stringify(manifest),
            async json() { return manifest; },
          };
        }
        const body = pdfs.get(key);
        return body === undefined ? null : { body };
      },
    },
  };
}

test('gichul manifest and PDF routes reject anonymous requests before reading R2', async () => {
  const env = createGichulEnv();
  for (const authorization of [null, 'Bearer bogus-token', 'Bearer expired-token', 'Bearer disabled-token']) {
    for (const path of ['/api/gichul/manifest', '/api/gichul/pdf/2024-06-korean-hwajak-question']) {
      const headers = authorization ? { authorization } : undefined;
      const response = await worker.fetch(new Request(`https://api.test${path}`, { headers }), env);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://hvsdcm1.xyz');
    }
  }
  assert.deepEqual(env.r2Reads, []);
});

test('learning content and images reject anonymous requests before reading R2', async () => {
  const env = createGichulEnv();
  for (const path of [
    '/api/learning/wordmaster',
    '/api/learning/smstudy',
    '/api/learning/smstudy/image/2026-csat-01.webp',
  ]) {
    const response = await worker.fetch(new Request(`https://api.test${path}`), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(env.r2Reads, []);
});

test('authenticated learning routes stream only fixed R2 keys', async () => {
  const objects = new Map([
    ['learning/wordmaster.json', JSON.stringify({ words: [{ id: 'fixture' }], emoji: {} })],
    ['learning/smstudy.json', JSON.stringify({ data: {}, notebook: {}, explanations: {} })],
    ['learning/smstudy/kice/2026-csat-01.webp', new Uint8Array([82, 73, 70, 70])],
  ]);
  const env = createGichulEnv({ learningObjects: objects });
  const headers = { authorization: 'Bearer user-token' };

  const words = await worker.fetch(new Request('https://api.test/api/learning/wordmaster', { headers }), env);
  assert.equal(words.status, 200);
  assert.match(words.headers.get('content-type'), /^application\/json/u);
  assert.equal(words.headers.get('cache-control'), 'no-store');
  assert.equal((await words.json()).words[0].id, 'fixture');

  const image = await worker.fetch(new Request('https://api.test/api/learning/smstudy/image/2026-csat-01.webp', { headers }), env);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/webp');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.deepEqual(env.r2Reads, ['learning/wordmaster.json', 'learning/smstudy/kice/2026-csat-01.webp']);

  const invalid = await worker.fetch(new Request('https://api.test/api/learning/smstudy/image/not-a-webp.txt', { headers }), env);
  assert.equal(invalid.status, 404);
  assert.equal(env.r2Reads.length, 2);
});

test('authenticated gichul routes stream only manifest-mapped PDFs with no-store CORS', async () => {
  const id = '2024-06-korean-hwajak-question';
  const pdfBytes = new TextEncoder().encode('%PDF-fixture');
  const env = createGichulEnv({
    exams: [{ id, r2_key: 'papers/shared-korean.pdf' }],
    pdfs: new Map([['papers/shared-korean.pdf', pdfBytes]]),
  });
  const headers = { authorization: 'Bearer user-token' };

  const manifest = await worker.fetch(new Request('https://api.test/api/gichul/manifest', { headers }), env);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(manifest.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await manifest.json(), { exams: [{ id, r2_key: 'papers/shared-korean.pdf' }] });

  const pdf = await worker.fetch(new Request(`https://api.test/api/gichul/pdf/${id}`, { headers }), env);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.headers.get('cache-control'), 'no-store');
  assert.equal(pdf.headers.get('access-control-allow-origin'), 'https://hvsdcm1.xyz');
  assert.deepEqual(new Uint8Array(await pdf.arrayBuffer()), pdfBytes);
  assert.deepEqual(env.r2Reads, ['manifest.json', 'manifest.json', 'papers/shared-korean.pdf']);
});

test('authenticated gichul PDF lookup returns 404 without arbitrary R2 key access', async () => {
  const env = createGichulEnv({
    exams: [{ id: 'known-id', r2_key: 'paper.pdf' }],
  });
  const headers = { authorization: 'Bearer user-token' };
  const missing = await worker.fetch(new Request('https://api.test/api/gichul/pdf/missing-id', { headers }), env);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.deepEqual(env.r2Reads, ['manifest.json']);

  const invalid = await worker.fetch(new Request('https://api.test/api/gichul/pdf/%2e%2e%2fsecret', { headers }), env);
  assert.equal(invalid.status, 404);
  assert.equal(invalid.headers.get('cache-control'), 'no-store');
  assert.deepEqual(env.r2Reads, ['manifest.json']);
});

test('authenticated gichul routes return 404 when the R2 manifest or mapped object is absent', async () => {
  const headers = { authorization: 'Bearer user-token' };
  const noManifest = createGichulEnv({ manifestExists: false });
  assert.equal((await worker.fetch(new Request('https://api.test/api/gichul/manifest', { headers }), noManifest)).status, 404);

  const noPdf = createGichulEnv({ exams: [{ id: 'known-id', r2_key: 'missing.pdf' }] });
  const response = await worker.fetch(new Request('https://api.test/api/gichul/pdf/known-id', { headers }), noPdf);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('unexpected gichul storage failures stay generic, CORS-enabled, and no-store', async () => {
  const env = createGichulEnv();
  env.GICHUL.get = async () => ({
    async json() { throw new Error('corrupt R2 manifest detail'); },
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await worker.fetch(new Request('https://api.test/api/gichul/pdf/known-id', {
      headers: { authorization: 'Bearer user-token' },
    }), env);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://hvsdcm1.xyz');
    assert.deepEqual(await response.json(), { error: '서버 오류' });
  } finally {
    console.error = originalError;
  }
});

test('admin login rejects an incorrect password before issuing a session', async () => {
  const env = {
    ADMIN_PASSWORD: 'correct-password',
    ALLOWED_ORIGIN: 'https://example.test',
    DB: createLoginTestDb(),
  };
  const response = await worker.fetch(new Request('https://api.test/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  }), env);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: '비밀번호가 올바르지 않습니다.' });
});

test('admin session route returns device metadata without token hashes', async () => {
  const timestamp = Date.now();
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    DB: {
      prepare(sql) {
        return {
          bind() {
            if (sql.includes('SELECT s.*, u.username')) {
              return { async first() { return { token_hash: 'stored-admin-hash', role: 'admin', disabled: 0 }; } };
            }
            if (sql.includes('UPDATE sessions')) {
              return { async run() { return { success: true }; } };
            }
            if (sql.includes('DELETE FROM sessions')) {
              return { async run() { return { success: true }; } };
            }
            if (sql.includes('INNER JOIN users')) {
              return {
                async all() {
                  return {
                    results: [{
                      user_id: 3,
                      username: 'tester',
                      created_at: timestamp - 1_000,
                      expires_at: timestamp + 60_000,
                      last_seen_at: timestamp,
                      ip_address: '203.0.113.8',
                      ip_fingerprint: '1234567890ab',
                      user_agent: 'Example Browser',
                    }],
                  };
                },
              };
            }
            throw new Error(`Unexpected SQL in test: ${sql}`);
          },
        };
      },
    },
  };

  const response = await worker.fetch(new Request('https://api.test/api/admin/sessions', {
    headers: {
      authorization: 'Bearer admin-token',
      'cf-connecting-ip': '198.51.100.1',
      'user-agent': 'Admin Browser',
    },
  }), env);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.sessions[0].active, true);
  assert.equal(data.sessions[0].ip_address, '203.0.113.8');
  assert.equal(data.sessions[0].ip_fingerprint, '1234567890ab');
  assert.equal('ip_hash' in data.sessions[0], false);
  assert.equal('token_hash' in data.sessions[0], false);
});

test('admin user statistics include the latest activity time separately from login', async () => {
  const lastLoginAt = Date.now() - 60_000;
  const lastActivityAt = Date.now();
  let userQuery = '';
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    DB: {
      prepare(sql) {
        return {
          bind() {
            if (sql.includes('SELECT s.*, u.username')) {
              return { async first() { return { token_hash: 'stored-admin-hash', role: 'admin', disabled: 0 }; } };
            }
            if (sql.includes('UPDATE sessions')) {
              return { async run() { return { success: true }; } };
            }
            if (sql.includes('FROM users u')) {
              userQuery = sql;
              return {
                async all() {
                  return {
                    results: [{
                      id: 3,
                      username: 'tester',
                      created_at: lastLoginAt - 60_000,
                      last_login_at: lastLoginAt,
                      last_activity_at: lastActivityAt,
                      active_devices: 1,
                      recent_ip: '203.0.113.8',
                      logins: 2,
                      word_events: 5,
                      sm_events: 4,
                    }],
                  };
                },
              };
            }
            throw new Error(`Unexpected SQL in test: ${sql}`);
          },
        };
      },
    },
  };

  const response = await worker.fetch(new Request('https://api.test/api/admin/users', {
    headers: {
      authorization: 'Bearer admin-token',
      'cf-connecting-ip': '198.51.100.1',
      'user-agent': 'Admin Browser',
    },
  }), env);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.users[0].last_login_at, lastLoginAt);
  assert.equal(data.users[0].last_activity_at, lastActivityAt);
  assert.match(userQuery, /MAX\(activity_session\.last_seen_at\)/u);
  assert.match(userQuery, /activity_session\.role = 'user'/u);
});

test('logout expires the session but preserves its audit record', async () => {
  let updateCall;
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    DB: {
      prepare(sql) {
        assert.match(sql, /UPDATE sessions/u);
        assert.doesNotMatch(sql, /DELETE FROM sessions/u);
        return {
          bind(...values) {
            updateCall = { sql, values };
            return { async run() { return { success: true }; } };
          },
        };
      },
    },
  };

  const response = await worker.fetch(new Request('https://api.test/api/logout', {
    method: 'POST',
    headers: {
      authorization: 'Bearer user-token',
      'cf-connecting-ip': '203.0.113.9',
      'user-agent': 'Logout Browser',
    },
  }), env);

  assert.equal(response.status, 200);
  assert.equal(updateCall.values[3], '203.0.113.9');
  assert.equal(updateCall.values[4], 'Logout Browser');
});

test('usage report rejects missing and incorrect ingest tokens', async () => {
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    USAGE_INGEST_TOKEN: 'correct-token',
    DB: {
      prepare() {
        throw new Error('database must not be reached');
      },
    },
  };

  for (const authorization of [null, 'Bearer wrong-token']) {
    const headers = { 'content-type': 'application/json' };
    if (authorization) headers.authorization = authorization;
    const response = await worker.fetch(new Request('https://api.test/api/usage/report', {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: 'codex', captured_at: new Date().toISOString(), payload: {} }),
    }), env);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: '인증이 필요합니다.' });
  }
});

test('usage report upserts the latest source snapshot', async () => {
  const statements = [];
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    USAGE_INGEST_TOKEN: 'correct-token',
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            const statement = { sql, values };
            statements.push(statement);
            return { async run() { return { success: true, meta: { changes: 1 } }; } };
          },
        };
      },
    },
  };
  const capturedAt = '2026-08-27T01:02:03.000Z';
  const payload = {
    model: 'gpt-5.6-sol',
    rate_limits: { primary: { used_percent: 12, window_minutes: 300 } },
  };
  const response = await worker.fetch(new Request('https://api.test/api/usage/report', {
    method: 'POST',
    headers: {
      authorization: 'Bearer correct-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ source: 'codex', captured_at: capturedAt, payload }),
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, advanced: true });
  const upsert = statements.find(({ sql }) => sql.includes('INSERT INTO usage_snapshots'));
  assert.match(upsert.sql, /ON CONFLICT\(source\)/u);
  assert.match(upsert.sql, /DO UPDATE SET captured_at = excluded\.captured_at/u);
  assert.match(upsert.sql, /julianday\(excluded\.captured_at\) > julianday\(usage_snapshots\.captured_at\)/u);
  assert.deepEqual(upsert.values, ['codex', capturedAt, JSON.stringify(payload)]);
  const health = statements.find(({ sql }) => sql.includes('INSERT INTO usage_source_health'));
  assert.deepEqual(health.values, ['codex', capturedAt, capturedAt, 'success']);
});

test('usage report records no-data health without changing a snapshot and rejects stale captures', async () => {
  const statements = [];
  let rejectSnapshot = false;
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    USAGE_INGEST_TOKEN: 'correct-token',
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            statements.push({ sql, values });
            return {
              async run() {
                if (sql.includes('INSERT INTO usage_snapshots') && rejectSnapshot) {
                  return { success: true, meta: { changes: 0 } };
                }
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
  const post = (body) => worker.fetch(new Request('https://api.test/api/usage/report', {
    method: 'POST',
    headers: { authorization: 'Bearer correct-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  const noData = await post({
    source: 'claude', attempted_at: '2026-08-29T00:00:00.000Z', outcome: 'no-data',
  });
  assert.equal(noData.status, 200);
  assert.deepEqual(await noData.json(), { ok: true, snapshot: false });
  assert.equal(statements.some(({ sql }) => sql.includes('INSERT INTO usage_snapshots')), false);

  rejectSnapshot = true;
  const stale = await post({
    source: 'codex',
    attempted_at: '2026-08-29T00:01:00.000Z',
    captured_at: '2026-08-28T00:00:00.000Z',
    outcome: 'success',
    payload: {},
  });
  assert.deepEqual(await stale.json(), { ok: true, advanced: false, stale: true });
  assert.equal(statements.at(-1).values.at(-1), 'stale');
});

test('usage report rejects oversized payloads and non-object bodies', async () => {
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    USAGE_INGEST_TOKEN: 'correct-token',
    DB: {
      prepare() {
        throw new Error('database must not be reached');
      },
    },
  };
  const headers = {
    authorization: 'Bearer correct-token',
    'content-type': 'application/json',
  };

  const oversized = await worker.fetch(new Request('https://api.test/api/usage/report', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source: 'codex',
      captured_at: '2026-08-27T01:02:03.000Z',
      payload: { blob: 'x'.repeat(70_000) },
    }),
  }), env);
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: '사용량 보고가 너무 큽니다.' });

  for (const body of ['"just a string"', 'null', '[1,2,3]']) {
    const response = await worker.fetch(new Request('https://api.test/api/usage/report', {
      method: 'POST',
      headers,
      body,
    }), env);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: '잘못된 사용량 보고입니다.' });
  }

  const unknownSource = await worker.fetch(new Request('https://api.test/api/usage/report', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source: 'gemini',
      captured_at: '2026-08-27T01:02:03.000Z',
      payload: {},
    }),
  }), env);
  assert.equal(unknownSource.status, 400);
});

// 2026-08-27 사용자 지시 — Claude 한도를 다시 수집·조회한다. 이전 계약("Claude는
// 수집·조회·UI에서 제외")은 무효다. 그때의 회귀 테스트를 수용 케이스로 뒤집어 둔다.
test('usage report accepts the claude source and stores it beside codex', async () => {
  const upserts = [];
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    USAGE_INGEST_TOKEN: 'correct-token',
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            upserts.push({ sql, values });
            return { async run() { return { success: true }; } };
          },
        };
      },
    },
  };
  const capturedAt = '2026-08-27T01:02:03.000Z';
  const payload = {
    models: {
      'claude-opus-5': {
        captured_at: capturedAt,
        rate_limits: { five_hour: { used_percentage: 31.4, resets_at: '2026-08-27T05:00:00.000Z' } },
      },
    },
  };
  const response = await worker.fetch(new Request('https://api.test/api/usage/report', {
    method: 'POST',
    headers: {
      authorization: 'Bearer correct-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ source: 'claude', captured_at: capturedAt, payload }),
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, advanced: true });
  assert.deepEqual(
    upserts.find(({ sql }) => sql.includes('INSERT INTO usage_snapshots')).values,
    ['claude', capturedAt, JSON.stringify(payload)],
  );
});

// review nit — ingest와 조회가 같은 행을 두고 실제로 이어지는지 한 흐름으로 고정한다.
// (지금까지는 POST와 GET을 각각 다른 가짜 DB로만 확인했다.)
test('a claude usage report posted through the API comes back from the usage lookup', async () => {
  const snapshots = new Map();
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    OWNER_USERNAME: 'hvsdcm',
    USAGE_INGEST_TOKEN: 'correct-token',
    DB: {
      prepare(sql) {
        if (sql.includes('INSERT INTO usage_source_health') || sql.includes('UPDATE usage_source_health')) {
          return { bind() { return { async run() { return { success: true, meta: { changes: 1 } }; } }; } };
        }
        if (sql.includes('INSERT INTO usage_snapshots')) {
          return {
            bind(source, capturedAt, payload) {
              return {
                async run() {
                  snapshots.set(source, { source, captured_at: capturedAt, payload });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }
        if (sql.includes('FROM usage_snapshots')) {
          return { bind() { return { async all() { return { results: [...snapshots.values()] }; } }; } };
        }
        if (sql.includes('SELECT s.*, u.username')) {
          return {
            bind() {
              return { async first() { return { token_hash: 'stored-user-hash', role: 'user', disabled: 0, username: 'hvsdcm' }; } };
            },
          };
        }
        if (sql.includes('UPDATE sessions')) {
          return { bind() { return { async run() { return { success: true }; } }; } };
        }
        if (sql.includes('FROM harness_tasks')) {
          return { async all() { return { results: [] }; } };
        }
        if (sql.includes('FROM harness_events')) {
          return { async all() { return { results: [] }; } };
        }
        throw new Error(`Unexpected SQL in usage round-trip test: ${sql}`);
      },
    },
  };
  const capturedAt = '2026-08-27T02:03:04.000Z';
  const payload = {
    models: {
      'claude-opus-5': {
        captured_at: capturedAt,
        rate_limits: { five_hour: { used_percentage: 44 }, seven_day: { used_percentage: 61 } },
      },
    },
  };

  const posted = await worker.fetch(new Request('https://api.test/api/usage/report', {
    method: 'POST',
    headers: { authorization: 'Bearer correct-token', 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'claude', captured_at: capturedAt, payload }),
  }), env);
  assert.equal(posted.status, 200);

  const looked = await worker.fetch(new Request('https://api.test/api/usage', {
    headers: { authorization: 'Bearer user-token', 'cf-connecting-ip': '198.51.100.7' },
  }), env);
  assert.equal(looked.status, 200);
  assert.deepEqual(await looked.json(), {
    snapshots: [{
      source: 'claude', captured_at: capturedAt, payload,
      last_success_at: capturedAt, last_attempt_at: capturedAt, last_outcome: 'legacy',
    }],
    tasks: [],
  });
});

test('usage lookup exposes health for a source that has never produced a snapshot', async () => {
  const attemptedAt = '2026-08-29T00:00:00.000Z';
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    OWNER_USERNAME: 'hvsdcm',
    DB: {
      prepare(sql) {
        if (sql.includes('FROM usage_snapshots')) {
          assert.match(sql, /UNION ALL/u);
          assert.match(sql, /FROM usage_source_health AS health/u);
          return {
            bind(...values) {
              assert.deepEqual(values, ['codex', 'claude', 'codex', 'claude']);
              return {
                async all() {
                  return { results: [{
                    source: 'claude', captured_at: null, payload: null,
                    last_success_at: null, last_attempt_at: attemptedAt, last_outcome: 'no-data',
                  }] };
                },
              };
            },
          };
        }
        if (sql.includes('SELECT s.*, u.username')) {
          return {
            bind() {
              return { async first() { return { token_hash: 'stored-user-hash', role: 'user', disabled: 0, username: 'hvsdcm' }; } };
            },
          };
        }
        if (sql.includes('UPDATE sessions')) {
          return { bind() { return { async run() { return { success: true }; } }; } };
        }
        if (sql.includes('FROM harness_tasks') || sql.includes('FROM harness_events')) {
          return { async all() { return { results: [] }; } };
        }
        throw new Error(`Unexpected SQL in health-only lookup test: ${sql}`);
      },
    },
  };

  const response = await worker.fetch(new Request('https://api.test/api/usage', {
    headers: { authorization: 'Bearer user-token', 'cf-connecting-ip': '198.51.100.7' },
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).snapshots, [{
    source: 'claude', captured_at: null, payload: null,
    last_success_at: null, last_attempt_at: attemptedAt, last_outcome: 'no-data',
  }]);
});

function harnessInput(overrides = {}) {
  return {
    version: 1,
    task_id: 'usage-harness',
    occurred_at: '2026-08-27T09:00:00.000Z',
    task: {
      name: '사용량 하네스 시각화 (08-27)',
      phase: 'work',
      progress: 55,
      status: 'active',
      model: 'gpt-5.6-sol',
      reasoning: 'xhigh',
      category_key: 'pipeline-visualization',
      category: '파이프라인 시각화',
      current: 'Worker 연결',
      done: '계약 고정',
      next: '화면 렌더',
      deadline: '20:10 KST',
    },
    actors: [{
      id: 'usage-harness:main',
      parent_id: '',
      name: 'Main Codex',
      kind: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'xhigh',
      role: '기획 · 통합 · 최종 판정',
      status: 'working',
      assignment: 'Worker 연결',
      progress: 55,
    }],
    modules: [{
      id: 'css',
      name: 'CSS 구현',
      progress: 88,
      status: 'working',
      owner: 'Main Codex',
    }],
    artifacts: ['npm test'],
    ...overrides,
  };
}

test('a later non-blocked delivery clears an earlier approval request in the persisted task', () => {
  const approval = {
    needed: '로그인 승인', reason: '인증 경계', minimum: '로그인만', tabs: '설정 탭',
    steps: '로그인 버튼', secret_notice: '비밀값 공유 금지', completion: 'GET 200', continuation: '다른 WP 가능',
  };
  const first = mergeHarnessReport(null, harnessInput({
    delivery: { request: '요청', plan: [], changes: [], verification: [], approval },
  }));
  assert.equal(first.delivery.approval.needed, '로그인 승인');
  const resolved = mergeHarnessReport(first, harnessInput({
    occurred_at: '2026-08-27T09:01:00.000Z',
    delivery: { request: '요청', plan: [], changes: [], verification: [], approval: null },
  }));
  assert.equal(resolved.delivery.approval, null);
});

function emptyHarnessEventStatement(sql) {
  if (sql.includes('FROM usage_snapshots')) {
    return { bind() { return { async all() { return { results: [] }; } }; } };
  }
  if (sql.includes('INSERT INTO harness_events')) {
    return { bind() { return { async run() { return { success: true, meta: { changes: 1 } }; } }; } };
  }
  if (sql.includes('DELETE FROM harness_events')) {
    return { async run() { return { success: true, meta: { changes: 0 } }; } };
  }
  return null;
}

async function runFakeBatch(statements) {
  const results = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
}

test('harness report requires its own token and merges actors into one task', async () => {
  let storedPayload = '';
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    HARNESS_INGEST_TOKEN: 'harness-token',
    DB: {
      batch: runFakeBatch,
      prepare(sql) {
        if (sql.includes('SELECT payload FROM harness_tasks')) {
          return { bind() { return { async first() { return storedPayload ? { payload: storedPayload } : null; } }; } };
        }
        if (sql.includes('INSERT INTO harness_tasks')) {
          return {
            bind(taskId, status, updatedAt, payload) {
              assert.equal(taskId, 'usage-harness');
              assert.equal(status, 'active');
              assert.equal(updatedAt, '2026-08-27T09:00:00.000Z');
              return { async run() { storedPayload = payload; return { success: true, meta: { changes: 1 } }; } };
            },
          };
        }
        const eventStatement = emptyHarnessEventStatement(sql);
        if (eventStatement) return eventStatement;
        throw new Error(`Unexpected SQL in test: ${sql}`);
      },
    },
  };
  const post = (body, token = 'harness-token') => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  const denied = await post(harnessInput(), 'wrong');
  assert.equal(denied.status, 401);

  const first = await post(harnessInput());
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, task_id: 'usage-harness' });

  const second = await post(harnessInput({
    actors: [{
      id: 'usage-harness:webgpt',
      parent_id: 'usage-harness:main',
      name: 'WebGPT 실행자',
      kind: 'webgpt',
      model: 'WebGPT PRO',
      role: '위임 실행',
      status: 'working',
      assignment: 'fixture 정리',
    }],
    artifacts: ['HARNESS E2E: PASS'],
  }));
  assert.equal(second.status, 200);
  const merged = JSON.parse(storedPayload);
  assert.equal(merged.category_key, 'pipeline-visualization');
  assert.equal(merged.category, '파이프라인 시각화');
  assert.equal(merged.reasoning, 'xhigh');
  assert.equal(merged.actors[0].reasoning, 'xhigh');
  assert.equal(merged.actors[0].progress, 55);
  assert.deepEqual(merged.actors.map((actor) => actor.kind), ['codex', 'webgpt']);
  assert.deepEqual(merged.modules.map((module) => [module.name, module.progress]), [['CSS 구현', 88]]);
  assert.deepEqual(merged.artifacts, ['npm test', 'HARNESS E2E: PASS']);

  // 2026-08-27 사용자 지시 — Claude 파이프라인도 같은 조직도에 보고한다.
  const claudeActor = await post(harnessInput({
    actors: [{
      id: 'usage-harness:claude',
      parent_id: 'usage-harness:main',
      name: 'Fable 5 오케스트레이터',
      kind: 'claude',
      model: 'claude-fable-5',
      reasoning: 'high',
      role: '기획 · 총괄',
      status: 'working',
      assignment: 'Claude 한도 복원',
    }],
    artifacts: [],
  }));
  assert.equal(claudeActor.status, 200);
  assert.deepEqual(
    JSON.parse(storedPayload).actors.map((actor) => actor.kind),
    ['codex', 'webgpt', 'claude'],
  );

  const invalidReasoning = await post(harnessInput({
    task: { ...harnessInput().task, reasoning: 'made-up-effort' },
  }));
  assert.equal(invalidReasoning.status, 400);

  const invalidCategory = await post(harnessInput({
    task: { ...harnessInput().task, category_key: 'bad category!' },
  }));
  assert.equal(invalidCategory.status, 400);
});

test('harness title, 4KB input, and heartbeat survive normalization and stale is derived at lookup time', async () => {
  let storedPayload = '';
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    HARNESS_INGEST_TOKEN: 'harness-token',
    DB: {
      batch: runFakeBatch,
      prepare(sql) {
        if (sql.includes('SELECT payload FROM harness_tasks')) {
          return { bind() { return { async first() { return null; } }; } };
        }
        if (sql.includes('INSERT INTO harness_tasks')) {
          return {
            bind(_taskId, _status, _updatedAt, payload, title, input, heartbeatAt) {
              assert.equal(title, '관제탑 UI 개선');
              assert.equal(Buffer.byteLength(input, 'utf8'), 4_095);
              assert.equal(heartbeatAt, '2026-08-27T09:00:00.000Z');
              return { async run() { storedPayload = payload; return { success: true, meta: { changes: 1 } }; } };
            },
          };
        }
        const eventStatement = emptyHarnessEventStatement(sql);
        if (eventStatement) return eventStatement;
        throw new Error(`Unexpected SQL in contract test: ${sql}`);
      },
    },
  };
  const input = '한'.repeat(2_000);
  const response = await worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(harnessInput({
      task: {
        ...harnessInput().task,
        title: '관제탑 UI 개선',
        input,
        heartbeat_at: '2026-08-27T09:00:00.000Z',
      },
    })),
  }), env);
  assert.equal(response.status, 200);
  const stored = JSON.parse(storedPayload);
  assert.equal(stored.title, '관제탑 UI 개선');
  assert.equal(Buffer.byteLength(stored.input, 'utf8'), 4_095);
  assert.equal(
    effectiveHarnessStatus(stored, 'active', Date.parse(stored.heartbeat_at) + HARNESS_STALE_MS),
    'active',
  );
  assert.equal(
    effectiveHarnessStatus(stored, 'active', Date.parse(stored.heartbeat_at) + HARNESS_STALE_MS + 1),
    'stale',
  );
});

test('heartbeat-only reports preserve task meaning, actors, modules, and artifacts', () => {
  const current = {
    version: 1,
    id: 'usage-harness',
    name: '기존 이름',
    title: '관제탑 UI 개선',
    input: '원래 요청',
    phase: 'work',
    progress: 73,
    status: 'active',
    current: '실제 Worker 수정',
    created_at: '2026-08-27T09:00:00.000Z',
    updated_at: '2026-08-27T09:01:00.000Z',
    heartbeat_at: '2026-08-27T09:01:00.000Z',
    actors: [{ id: 'usage-harness:main', assignment: '실제 Worker 수정', progress: 73 }],
    modules: [{ id: 'worker', name: 'Worker', progress: 73 }],
    artifacts: ['npm test'],
  };
  const incoming = harnessInput({
    occurred_at: '2026-08-27T09:05:00.000Z',
    task: {
      ...harnessInput().task,
      phase: 'heartbeat',
      progress: 0,
      current: '진행 중',
      heartbeat_at: '2026-08-27T09:05:00.000Z',
    },
    actors: [{
      ...harnessInput().actors[0],
      assignment: '진행 중',
      progress: 0,
    }],
    modules: [],
    artifacts: [],
  });

  const merged = mergeHarnessReport(current, incoming);
  for (const field of ['name', 'title', 'input', 'phase', 'progress', 'status', 'current']) {
    assert.deepEqual(merged[field], current[field]);
  }
  assert.deepEqual(merged.actors, current.actors);
  assert.deepEqual(merged.modules, current.modules);
  assert.deepEqual(merged.artifacts, current.artifacts);
  assert.equal(merged.heartbeat_at, '2026-08-27T09:05:00.000Z');
  assert.equal(merged.updated_at, '2026-08-27T09:05:00.000Z');
});

test('accepted harness upserts append subject-aware events with remaining usage snapshots', async () => {
  const state = {
    payload: '',
    allowUpsert: true,
    failEventInsert: false,
    batchCalls: 0,
    snapshotReads: 0,
    operations: [],
    events: [],
    snapshots: [
      {
        source: 'codex',
        payload: JSON.stringify({
          rate_limits: {
            primary: { remaining_percent: 91, window_minutes: 300 },
            secondary: { remaining_percent: 62, used_percent: 99, window_minutes: 10_080 },
          },
        }),
      },
      {
        source: 'claude',
        payload: JSON.stringify({
          models: {
            'claude-opus-5': {
              captured_at: '2026-08-27T09:00:00.000Z',
              rate_limits: { seven_day: { used_percentage: 41 } },
            },
            'claude-newest': {
              captured_at: '2026-08-27T09:01:00.000Z',
              rate_limits: { seven_day_sonnet: { remaining_percentage: 44 } },
            },
          },
        }),
      },
    ],
  };
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    HARNESS_INGEST_TOKEN: 'harness-token',
    DB: {
      async batch(statements) {
        state.batchCalls += 1;
        state.operations.push('batch');
        assert.deepEqual(statements.map((statement) => statement.kind), ['task-upsert', 'event-insert']);
        const beforePayload = state.payload;
        const beforeEvents = state.events.length;
        let lastChanges = 0;
        try {
          const results = [];
          for (const statement of statements) {
            const result = await statement.run(lastChanges);
            lastChanges = result?.meta?.changes || 0;
            results.push(result);
          }
          return results;
        } catch (error) {
          state.payload = beforePayload;
          state.events.length = beforeEvents;
          throw error;
        }
      },
      prepare(sql) {
        if (sql.includes('SELECT payload FROM harness_tasks')) {
          return { bind() { return { async first() { return state.payload ? { payload: state.payload } : null; } }; } };
        }
        if (sql.includes('INSERT INTO harness_tasks')) {
          return {
            bind(taskId, status, updatedAt, payload) {
              return {
                kind: 'task-upsert',
                async run() {
                  if (!state.allowUpsert) return { success: true, meta: { changes: 0 } };
                  state.payload = payload;
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }
        if (sql.includes('FROM usage_snapshots')) {
          return {
            bind(...sources) {
              assert.deepEqual(sources, ['codex', 'claude']);
              return {
                async all() {
                  state.snapshotReads += 1;
                  state.operations.push('snapshots');
                  return { results: state.snapshots };
                },
              };
            },
          };
        }
        if (sql.includes('INSERT INTO harness_events')) {
          assert.match(sql, /SELECT \?1, \?2, \?3, \?4, \?5, \?6, \?7, \?8, \?9, \?10, \?11, \?12\s+WHERE changes\(\) > 0/u);
          return {
            bind(...values) {
              return {
                kind: 'event-insert',
                async run(lastChanges) {
                  if (state.failEventInsert) throw new Error('forced event insert failure');
                  if (lastChanges === 0) return { success: true, meta: { changes: 0 } };
                  state.events.push(values);
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }
        if (sql.includes('DELETE FROM harness_events')) {
          return { async run() { return { success: true, meta: { changes: 0 } }; } };
        }
        throw new Error(`Unexpected SQL in event insertion test: ${sql}`);
      },
    },
  };
  const post = (body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  assert.equal((await post(harnessInput())).status, 200);
  assert.deepEqual(state.operations.slice(0, 2), ['snapshots', 'batch']);
  assert.equal(state.batchCalls, 1);
  assert.deepEqual(state.events[0].slice(0, 11), [
    'usage-harness', '2026-08-27T09:00:00.000Z', 'report', null, 'work', 55,
    'gpt-5.6-sol', 'xhigh', 'active', 62, 44,
  ]);

  const extraActor = {
    id: 'usage-harness:reviewer',
    parent_id: 'usage-harness:main',
    name: 'Reviewer',
    kind: 'claude',
    model: 'claude-opus-5',
    reasoning: 'high',
    role: '독립 검토',
    status: 'reviewing',
    assignment: 'event contract review',
    progress: 77,
  };
  assert.equal((await post(harnessInput({
    occurred_at: '2026-08-27T09:05:00.000Z',
    actors: [harnessInput().actors[0], extraActor],
  }))).status, 200);
  assert.deepEqual(state.events[1].slice(2, 11), [
    'report', 'usage-harness:reviewer', 'work', 77,
    'claude-opus-5', 'high', 'reviewing', 62, 59,
  ]);

  assert.equal((await post(harnessInput({
    occurred_at: '2026-08-27T09:10:00.000Z',
    task: { ...harnessInput().task, phase: 'review', progress: 80 },
    actors: [{ ...harnessInput().actors[0], progress: 80, status: 'reviewing' }],
  }))).status, 200);
  assert.equal(state.events[2][2], 'phase-change');
  assert.equal(state.events[2][4], 'review');
  assert.equal(JSON.parse(state.events[2][11]).phase, 'review');

  state.snapshots = [
    { source: 'codex', payload: JSON.stringify({ rate_limits: { secondary: { used_percent: 120 } } }) },
    { source: 'claude', payload: '{broken' },
  ];
  assert.equal((await post(harnessInput({
    occurred_at: '2026-08-27T09:15:00.000Z',
    task: { ...harnessInput().task, phase: 'review', progress: 85 },
  }))).status, 200);
  assert.deepEqual(state.events[3].slice(9, 11), [null, null]);
  assert.equal(state.events.length, 4);

  state.allowUpsert = false;
  const readsBeforeRejectedUpsert = state.snapshotReads;
  const eventsBeforeRejectedUpsert = state.events.length;
  assert.equal((await post(harnessInput({ occurred_at: '2026-08-27T09:20:00.000Z' }))).status, 200);
  assert.equal(state.snapshotReads, readsBeforeRejectedUpsert + 1);
  assert.equal(state.events.length, eventsBeforeRejectedUpsert);

  state.allowUpsert = true;
  state.failEventInsert = true;
  const payloadBeforeFailedBatch = state.payload;
  const eventsBeforeFailedBatch = state.events.length;
  const originalError = console.error;
  console.error = () => {};
  try {
    const failed = await post(harnessInput({ occurred_at: '2026-08-27T09:25:00.000Z' }));
    assert.equal(failed.status, 500);
  } finally {
    console.error = originalError;
    state.failEventInsert = false;
  }
  assert.equal(state.payload, payloadBeforeFailedBatch);
  assert.equal(state.events.length, eventsBeforeFailedBatch);
  assert.equal(state.batchCalls, 6);
});

test('harness retention uses the strict five-percent boundary and stays best-effort', async () => {
  const createEnv = (deleteFails = false) => {
    const state = { deletes: [] };
    return {
      state,
      env: {
        ALLOWED_ORIGIN: 'https://example.test',
        HARNESS_INGEST_TOKEN: 'harness-token',
        DB: {
          batch: runFakeBatch,
          prepare(sql) {
            if (sql.includes('SELECT payload FROM harness_tasks')) {
              return { bind() { return { async first() { return null; } }; } };
            }
            if (sql.includes('FROM usage_snapshots')) {
              return { bind() { return { async all() { return { results: [] }; } }; } };
            }
            if (sql.includes('INSERT INTO harness_tasks')) {
              return { bind() { return { async run() { return { success: true, meta: { changes: 1 } }; } }; } };
            }
            if (sql.includes('INSERT INTO harness_events')) {
              assert.match(sql, /WHERE changes\(\) > 0/u);
              return { bind() { return { async run() { return { success: true, meta: { changes: 1 } }; } }; } };
            }
            if (sql.includes('DELETE FROM harness_events')) {
              state.deletes.push(sql);
              return {
                async run() {
                  if (deleteFails) throw new Error('forced retention failure');
                  return { success: true, meta: { changes: 0 } };
                },
              };
            }
            throw new Error(`Unexpected SQL in retention test: ${sql}`);
          },
        },
      },
    };
  };
  const post = (env) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(harnessInput()),
  }), env);
  const originalRandom = Math.random;
  try {
    const boundary = createEnv();
    Math.random = () => 0.05;
    assert.equal((await post(boundary.env)).status, 200);
    assert.equal(boundary.state.deletes.length, 0);

    const belowBoundary = createEnv();
    Math.random = () => 0.049;
    assert.equal((await post(belowBoundary.env)).status, 200);
    assert.equal(belowBoundary.state.deletes.length, 1);
    assert.match(
      belowBoundary.state.deletes[0],
      /WHERE datetime\(ts\) < datetime\('now', '-14 days'\)/u,
    );

    const failedDelete = createEnv(true);
    assert.equal((await post(failedDelete.env)).status, 200);
    assert.equal(failedDelete.state.deletes.length, 1);
  } finally {
    Math.random = originalRandom;
  }
});

test('harness report keeps the merged actor total within twenty', async () => {
  let storedPayload = '';
  let upserts = 0;
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    HARNESS_INGEST_TOKEN: 'harness-token',
    DB: {
      batch: runFakeBatch,
      prepare(sql) {
        if (sql.includes('SELECT payload FROM harness_tasks')) {
          return { bind() { return { async first() { return storedPayload ? { payload: storedPayload } : null; } }; } };
        }
        if (sql.includes('INSERT INTO harness_tasks')) {
          return {
            bind(taskId, status, updatedAt, payload) {
              return {
                async run() {
                  upserts += 1;
                  storedPayload = payload;
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }
        const eventStatement = emptyHarnessEventStatement(sql);
        if (eventStatement) return eventStatement;
        throw new Error(`Unexpected SQL in actor cap test: ${sql}`);
      },
    },
  };
  const post = (body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: {
      authorization: 'Bearer harness-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }), env);
  const actors = (prefix) => Array.from({ length: 20 }, (_, index) => ({
    ...harnessInput().actors[0],
    id: `usage-harness:${prefix}-${index}`,
    parent_id: '',
  }));

  const first = await post(harnessInput({ actors: actors('a') }));
  assert.equal(first.status, 200);
  const second = await post(harnessInput({ actors: actors('b') }));
  assert.equal(second.status, 400);
  assert.deepEqual(await second.json(), { error: '하네스 실행자가 너무 많습니다.' });
  assert.equal(JSON.parse(storedPayload).actors.length, 20);
  assert.equal(upserts, 1);
});

// review M-A1 — SELECT→merge→UPSERT는 버전 검사가 없으면 늦게 도착한 과거 보고가
// 끝난 태스크를 되살리고 최신 상태를 덮어쓴다. 저장 자체를 막는지 확인한다.
// 가짜 D1은 UPSERT를 무조건 적용하지 않고 WHERE 절의 의미를 그대로 흉내 낸다 —
// 그러지 않으면 "조건부 UPSERT"를 고쳐도 테스트가 아무것도 검증하지 못한다.
// datetime()은 오프셋 표기와 Z를 모두 UTC로 환산하고 읽을 수 없는 값은 NULL이 되는데,
// Date.parse가 정확히 같은 순서를 본다(실측 확인: sqlite 3.53.3).
// state.readOverride를 채우면 SELECT만 옛 스냅샷을 보게 되어 동시 보고를 재현할 수 있다.
function harnessStoreEnv() {
  const state = {
    payload: '', status: '', updatedAt: '', upserts: 0, rejected: 0, readOverride: null,
    usageSnapshots: [],
  };
  return {
    state,
    env: {
      ALLOWED_ORIGIN: 'https://example.test',
      HARNESS_INGEST_TOKEN: 'harness-token',
      DB: {
        batch: runFakeBatch,
        prepare(sql) {
          if (sql.includes('FROM usage_snapshots')) {
            return {
              bind() {
                return { async all() { return { results: state.usageSnapshots }; } };
              },
            };
          }
          if (sql.includes('SELECT payload FROM harness_tasks')) {
            return {
              bind() {
                return {
                  async first() {
                    const stored = state.readOverride ?? state.payload;
                    return stored ? { payload: stored } : null;
                  },
                };
              },
            };
          }
          if (sql.includes('INSERT INTO harness_tasks')) {
            // 동시 보고 방어는 D1 쪽 조건부 UPSERT도 함께 쓴다 — 마이그레이션 없이
            // 기존 컬럼(updated_at, status)만 비교한다. 시각 비교는 사전순이 아니라
            // datetime() 기반이어야 오프셋 표기가 섞여도 순서가 뒤집히지 않는다.
            assert.match(
              sql,
              /WHERE \(datetime\(excluded\.updated_at\) >= datetime\(harness_tasks\.updated_at\)\s*\n?\s*OR datetime\(harness_tasks\.updated_at\) IS NULL\)/u,
            );
            const guardsTerminal = sql.includes("harness_tasks.status != 'complete'");
            return {
              bind(taskId, status, updatedAt, payload) {
                return {
                  async run() {
                    if (state.updatedAt) {
                      const storedAt = Date.parse(state.updatedAt);
                      const orderOk = !Number.isFinite(storedAt) || Date.parse(updatedAt) >= storedAt;
                      if (!orderOk || (guardsTerminal && state.status === 'complete')) {
                        state.rejected += 1;
                        return { success: true, meta: { changes: 0 } };
                      }
                    }
                    state.upserts += 1;
                    state.status = status;
                    state.updatedAt = updatedAt;
                    state.payload = payload;
                    return { success: true, meta: { changes: 1 } };
                  },
                };
              },
            };
          }
          const eventStatement = emptyHarnessEventStatement(sql);
          if (eventStatement) return eventStatement;
          throw new Error(`Unexpected SQL in stale-report test: ${sql}`);
        },
      },
    },
  };
}

test('approve alone completes a harness task and late or unresumed reports never revive it', async () => {
  const { state, env } = harnessStoreEnv();
  const setRemaining = (codex, claude) => {
    state.usageSnapshots = [
      {
        source: 'codex',
        payload: JSON.stringify({ rate_limits: { secondary: { remaining_percent: codex } } }),
      },
      {
        source: 'claude',
        payload: JSON.stringify({
          models: {
            'claude-opus-5': {
              captured_at: '2026-08-27T09:00:00.000Z',
              rate_limits: { seven_day: { remaining_percent: claude } },
            },
          },
        }),
      },
    ];
  };
  const post = (body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  const completed = harnessInput({
    occurred_at: '2026-08-27T10:00:00.000Z',
    task: { ...harnessInput().task, status: 'active', phase: 'approve', progress: 41 },
  });

  setRemaining(70, 60);
  assert.equal((await post(completed)).status, 200);
  assert.equal(state.status, 'complete');
  const upsertsAfterComplete = state.upserts;

  // ① 저장된 updated_at보다 오래된 보고 → no-op 200 (기존 응답 형태 + stale 표시).
  const late = await post(harnessInput({ occurred_at: '2026-08-27T09:00:00.000Z' }));
  assert.equal(late.status, 200);
  assert.deepEqual(await late.json(), { ok: true, task_id: 'usage-harness', stale: true });
  assert.equal(state.upserts, upsertsAfterComplete);
  assert.equal(state.status, 'complete');
  assert.equal(state.updatedAt, '2026-08-27T10:00:00.000Z');

  // ② 최신 보고라도 명시적 재개 없이는 complete를 active로 강등하지 못한다.
  setRemaining(68, 58);
  const newer = await post(harnessInput({
    occurred_at: '2026-08-27T11:00:00.000Z',
    actors: [{
      id: 'usage-harness:straggler',
      parent_id: 'usage-harness:main',
      name: '늦은 실행자',
      kind: 'claude',
      model: 'claude-opus-5',
      reasoning: 'high',
      role: '후속',
      status: 'working',
      assignment: '뒤늦은 보고',
    }],
  }));
  assert.equal(newer.status, 200);
  assert.deepEqual(await newer.json(), { ok: true, task_id: 'usage-harness' });
  assert.equal(state.upserts, upsertsAfterComplete + 1);
  assert.equal(state.status, 'complete');
  const held = JSON.parse(state.payload);
  assert.equal(held.status, 'complete');
  assert.equal(held.phase, 'approve');
  assert.equal(held.progress, 100);
  assert.equal(held.completed_at, '2026-08-27T10:00:00.000Z');
  assert.deepEqual(held.actors.map((actor) => actor.status), ['done', 'done']);
  const heldStraggler = held.actors.find((actor) => actor.id === 'usage-harness:straggler');
  assert.equal(heldStraggler.finished_at, '2026-08-27T11:00:00.000Z');
  assert.deepEqual(heldStraggler.usage_at_end, { codex: 68, claude: 58 });

  // ③ resume:true를 담은 보고만 태스크를 다시 연다.
  setRemaining(65, 55);
  const resumed = await post(harnessInput({ occurred_at: '2026-08-27T12:00:00.000Z', resume: true }));
  assert.equal(resumed.status, 200);
  assert.equal(state.status, 'active');
  const resumedPayload = JSON.parse(state.payload);
  assert.equal(resumedPayload.phase, 'work');
  assert.equal(resumedPayload.completed_at, undefined);
  const resumedMain = resumedPayload.actors.find((actor) => actor.id === 'usage-harness:main');
  assert.equal(resumedMain.status, 'working');
  assert.equal(resumedMain.started_at, '2026-08-27T12:00:00.000Z');
  assert.deepEqual(resumedMain.usage_at_start, { codex: 65, claude: 55 });
  assert.equal(resumedMain.finished_at, undefined);
  assert.equal(resumedMain.usage_at_end, undefined);

  // resume은 boolean만 받는다 — 문자열 'true'는 재개 신호로 통하지 않는다.
  const bogusResume = await post(harnessInput({ occurred_at: '2026-08-27T13:00:00.000Z', resume: 'true' }));
  assert.equal(bogusResume.status, 400);
});

test('two reports from separate harnesses keep both actors on the shared task', async () => {
  const { state, env } = harnessStoreEnv();
  const post = (body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  const actor = (id, kind, model) => ({
    id, parent_id: 'usage-harness:main', name: id, kind, model,
    reasoning: 'high', role: '실행', status: 'working', assignment: '병렬 보고',
  });

  assert.equal((await post(harnessInput({
    occurred_at: '2026-08-27T09:00:00.000Z',
    actors: [actor('usage-harness:codex-side', 'codex', 'gpt-5.6-sol')],
  }))).status, 200);
  assert.equal((await post(harnessInput({
    occurred_at: '2026-08-27T09:00:30.000Z',
    actors: [actor('usage-harness:claude-side', 'claude', 'claude-opus-5')],
  }))).status, 200);

  assert.deepEqual(
    JSON.parse(state.payload).actors.map((entry) => entry.id),
    ['usage-harness:codex-side', 'usage-harness:claude-side'],
  );
});

// 위 가짜 D1은 "SQLite datetime()이 Date.parse와 같은 순서를 본다"는 전제 위에 서 있다.
// 그 전제를 실제 SQLite로 잠근다 — node:sqlite가 없는 런타임(Node 20)에서는 건너뛴다.
// review 기능 B M-2 — 저장된 payload는 title 값만으로 출처를 말하지 못했다. 보고가
// title을 싣지 않으면 name이 그 자리를 채웠기 때문이다. 이제 출처 플래그를 함께 저장해,
// 화면이 지정 제목과 파생 이름을 값이 같을 때도 구별할 수 있게 한다.
test('a stored task records whether its title was authored or inherited from the name', async () => {
  const post = (env, body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  // (1) title을 싣지 않은 보고 — title은 name을 물려받고 출처는 거짓이다.
  const inherited = harnessStoreEnv();
  assert.equal((await post(inherited.env, harnessInput())).status, 200);
  const withoutTitle = JSON.parse(inherited.state.payload);
  assert.equal(withoutTitle.title, '사용량 하네스 시각화 (08-27)');
  assert.equal(withoutTitle.title_authored, false);

  // (2) **반례**: 지정한 title이 마침 name과 글자까지 같은 보고. 값은 구별되지 않지만
  // 출처는 참이어야 한다 — 여기서 갈라 두지 않으면 화면에서 되살릴 근거가 없다.
  const authored = harnessStoreEnv();
  const sameText = 'WP2 관제탑 (08-29)';
  assert.equal((await post(authored.env, harnessInput({
    task: { ...harnessInput().task, name: sameText, title: sameText },
  }))).status, 200);
  const stored = JSON.parse(authored.state.payload);
  assert.equal(stored.title, sameText);
  assert.equal(stored.title_authored, true);

  // (3) 출처는 후속 보고를 넘어 유지된다 — title을 다시 싣지 않아도 지정 사실은 남는다.
  assert.equal((await post(authored.env, harnessInput({
    occurred_at: '2026-08-27T10:00:00.000Z',
    task: { ...harnessInput().task, name: sameText },
  }))).status, 200);
  const carried = JSON.parse(authored.state.payload);
  assert.equal(carried.title, sameText);
  assert.equal(carried.title_authored, true);
});

// review 기능 B M-2-R2 — 위 테스트는 모두 플래그 도입 **후** 새로 만든 행만 다룬다.
// 실제 D1에는 플래그가 없던 시절의 행이 남아 있고, 그 행의 명시 제목은 후속 무제목 보고
// 한 번에 name으로 덮여 사라졌다. 플래그 부재는 "파생"이 아니라 "근거 없음"이므로,
// 그런 행에는 예전 판정 규칙(title !== name)을 한 번 적용해 지정 제목을 승격 보존한다.
test('a pre-flag row keeps its authored title when a later report carries none', async () => {
  const post = (env, body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  const legacyName = 'WP2 관제탑 (08-29)';
  const legacyTitle = '관제탑 UI 개선';

  // (1) 플래그가 없던 시절의 행: 사람이 지정한 title이 name과 다르고, title_authored 자체가
  //     payload에 **없다**.
  const kept = harnessStoreEnv();
  kept.state.payload = JSON.stringify({
    version: 1,
    id: 'usage-harness',
    name: legacyName,
    title: legacyTitle,
    phase: 'work',
    status: 'active',
    progress: 40,
    created_at: '2026-08-27T08:00:00.000Z',
    updated_at: '2026-08-27T08:00:00.000Z',
    actors: [],
    modules: [],
    artifacts: [],
  });
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(kept.state.payload), 'title_authored'), false);

  // title을 싣지 않은 후속 보고가 들어와도 지정 제목이 살아남고, 출처가 참으로 승격된다.
  assert.equal((await post(kept.env, harnessInput({
    occurred_at: '2026-08-27T09:00:00.000Z',
    task: { ...harnessInput().task, name: legacyName },
  }))).status, 200);
  const promoted = JSON.parse(kept.state.payload);
  assert.equal(promoted.title, legacyTitle);
  assert.equal(promoted.title_authored, true);

  // (2) **반례**: 같은 플래그 부재라도 title이 name과 같은 행은 name에서 채워졌을 뿐이므로
  //     승격하지 않는다. 여기까지 승격하면 파생 제목이 지정 제목으로 둔갑한다.
  const derived = harnessStoreEnv();
  derived.state.payload = JSON.stringify({
    version: 1,
    id: 'usage-harness',
    name: legacyName,
    title: legacyName,
    phase: 'work',
    status: 'active',
    progress: 40,
    created_at: '2026-08-27T08:00:00.000Z',
    updated_at: '2026-08-27T08:00:00.000Z',
    actors: [],
    modules: [],
    artifacts: [],
  });
  assert.equal((await post(derived.env, harnessInput({
    occurred_at: '2026-08-27T09:00:00.000Z',
    task: { ...harnessInput().task, name: '사용량 하네스 시각화 (08-27)' },
  }))).status, 200);
  const stayedDerived = JSON.parse(derived.state.payload);
  assert.equal(stayedDerived.title, '사용량 하네스 시각화 (08-27)');
  assert.equal(stayedDerived.title_authored, false);

  // (3) 명시적 `false`는 근거가 있는 파생 판정이므로 승격 대상이 아니다.
  const explicitFalse = harnessStoreEnv();
  explicitFalse.state.payload = JSON.stringify({
    version: 1,
    id: 'usage-harness',
    name: legacyName,
    title: legacyTitle,
    title_authored: false,
    phase: 'work',
    status: 'active',
    progress: 40,
    created_at: '2026-08-27T08:00:00.000Z',
    updated_at: '2026-08-27T08:00:00.000Z',
    actors: [],
    modules: [],
    artifacts: [],
  });
  assert.equal((await post(explicitFalse.env, harnessInput({
    occurred_at: '2026-08-27T09:00:00.000Z',
    task: { ...harnessInput().task, name: legacyName },
  }))).status, 200);
  const notPromoted = JSON.parse(explicitFalse.state.payload);
  assert.equal(notPromoted.title, legacyName);
  assert.equal(notPromoted.title_authored, false);
});

test('the real SQLite UPSERT preserves milliseconds and advances strictly', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }
  if (!DatabaseSync) return t.skip('node:sqlite unavailable');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE usage_snapshots(source TEXT PRIMARY KEY, captured_at TEXT, payload TEXT)');
  const upsert = db.prepare(USAGE_SNAPSHOT_UPSERT_SQL);
  assert.equal(upsert.run('codex', '2026-08-27T01:00:00.900Z', 'newest').changes, 1);
  assert.equal(upsert.run('codex', '2026-08-27T01:00:00.100Z', 'older-same-second').changes, 0);
  assert.equal(upsert.run('codex', '2026-08-27T01:00:00.900Z', 'equal').changes, 0);
  assert.equal(upsert.run('codex', '2026-08-27T10:00:01+09:00', 'newer-offset').changes, 1);
  assert.deepEqual({ ...db.prepare('SELECT captured_at, payload FROM usage_snapshots').get() }, {
    captured_at: '2026-08-27T10:00:01+09:00',
    payload: 'newer-offset',
  });
  db.close();
});

// review 2R Major-2 — 정규화 이전에 저장된 행은 오프셋 표기라 사전순으로는 UTC 표기보다
// 항상 뒤에 온다. 시각으로 비교하지 않으면 더 최신인 보고가 조용히 무시된다.
test('a newer UTC report still updates a row whose stored time uses a +09:00 offset', async () => {
  const { state, env } = harnessStoreEnv();
  const storedTime = '2026-08-27T10:00:00+09:00'; // 실제로는 01:00Z
  const incomingTime = '2026-08-27T01:30:00.000Z'; // 30분 뒤인데 사전순으로는 과거

  // 사전순 비교는 이 쌍에서 순서를 뒤집는다 — 이 테스트가 지키려는 결함 그 자체다.
  assert.equal(incomingTime >= storedTime, false);
  assert.equal(Date.parse(incomingTime) >= Date.parse(storedTime), true);

  state.status = 'active';
  state.updatedAt = storedTime;
  state.payload = JSON.stringify({
    version: 1,
    id: 'usage-harness',
    status: 'active',
    phase: 'work',
    progress: 40,
    created_at: storedTime,
    updated_at: storedTime,
    actors: [{ id: 'usage-harness:legacy', name: '이전 실행자', kind: 'codex', status: 'working' }],
    modules: [],
    artifacts: [],
  });

  const response = await worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(harnessInput({ occurred_at: incomingTime })),
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, task_id: 'usage-harness' });
  assert.equal(state.upserts, 1);
  assert.equal(state.rejected, 0);
  assert.equal(state.updatedAt, incomingTime);
  const saved = JSON.parse(state.payload);
  assert.equal(saved.updated_at, incomingTime);
  assert.deepEqual(
    saved.actors.map((entry) => entry.id),
    ['usage-harness:legacy', 'usage-harness:main'],
  );
});

// review 2R Major-1 — SELECT→merge→UPSERT는 원자적이지 않다. 계약(단일 보고자)이 깨져
// 두 보고가 겹쳤을 때, 그 사이에 complete가 된 행을 늦은 active 보고가 강등하지 못하게
// UPSERT WHERE 절이 DB 수준에서 한 겹 더 막는지 확인한다.
test('a concurrent active report cannot demote a task that completed after its read', async () => {
  const { state, env } = harnessStoreEnv();
  const post = (body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  assert.equal((await post(harnessInput({ occurred_at: '2026-08-27T09:00:00.000Z' }))).status, 200);
  const readBeforeCompletion = state.payload; // 두 번째 보고자가 이 시점에 읽었다고 본다

  assert.equal((await post(harnessInput({
    occurred_at: '2026-08-27T10:00:00.000Z',
    task: { ...harnessInput().task, status: 'complete', phase: 'done', progress: 100 },
  }))).status, 200);
  assert.equal(state.status, 'complete');
  const upsertsAfterComplete = state.upserts;

  // 겹친 보고: 아직 active이던 payload를 읽었으므로 병합 결과도 active다.
  state.readOverride = readBeforeCompletion;
  const racing = await post(harnessInput({ occurred_at: '2026-08-27T11:00:00.000Z' }));
  state.readOverride = null;

  assert.equal(racing.status, 200);
  assert.equal(state.upserts, upsertsAfterComplete);
  assert.equal(state.rejected, 1);
  assert.equal(state.status, 'complete');
  assert.equal(JSON.parse(state.payload).status, 'complete');
});

// 단계 사슬 확장 — 조직도 계약은 "입력 → 기획 → 구현 → 게이트 → 리뷰 → 수정 → 승인 →
// 완료" 여덟 단계를 요구한다. 이 목록은 화면(usage/assets/js/usage.js의 PHASES)과 같아야
// 하고, 그 원본 대 원본 대조는 scripts/validate.mjs가 한다. 여기서는 Worker가 여덟 개를
// 실제로 **받아 저장하는지**와, 구 4단계만 보고하는 옛 보고자가 계속 통하는지를 본다.
const HARNESS_PHASE_CHAIN = ['input', 'plan', 'work', 'gate', 'review', 'revise', 'approve', 'done'];
const LEGACY_HARNESS_PHASES = ['plan', 'work', 'review', 'done'];

test('the harness accepts all eight pipeline phases and stores each one verbatim', async () => {
  const { state, env } = harnessStoreEnv();
  const post = (body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  for (const [index, phase] of HARNESS_PHASE_CHAIN.entries()) {
    const minute = String(index).padStart(2, '0');
    const response = await post(harnessInput({
      occurred_at: `2026-08-27T09:${minute}:00.000Z`,
      task: { ...harnessInput().task, phase },
    }));
    assert.equal(response.status, 200, `${phase} 단계 보고는 수용돼야 합니다.`);
    assert.equal(JSON.parse(state.payload).phase, phase);
  }
  assert.equal(state.rejected, 0);
  assert.equal(state.upserts, HARNESS_PHASE_CHAIN.length);
});

// WP1 fixture ownership: identifiers and actor shapes come from the owner-provided production D1
// sample in work/real-harness-task-sample.json; timestamps and quota values are deterministic.
test('real-payload-derived actors receive stable lifecycle, phase, quota, and completion stamps', async () => {
  const { state, env } = harnessStoreEnv();
  const post = (body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  const setRemaining = (codex, claude, capturedAt) => {
    state.usageSnapshots = [
      {
        source: 'codex',
        payload: JSON.stringify({ rate_limits: { secondary: { remaining_percent: codex } } }),
      },
      {
        source: 'claude',
        payload: JSON.stringify({
          models: {
            'claude-fable-5': {
              captured_at: capturedAt,
              rate_limits: { seven_day: { remaining_percent: claude } },
            },
            // A newer unrelated model proves each actor is stamped against its own exact model,
            // rather than whichever actor happened to be last in this multi-actor report.
            'claude-newest': {
              captured_at: '2026-08-28T23:59:00.000Z',
              rate_limits: { seven_day: { remaining_percent: 12 } },
            },
          },
        }),
      },
    ];
  };
  const task = {
    ...harnessInput().task,
    name: 'usage 조직도 개선 (08-28)',
    model: 'claude-fable-5',
    reasoning: 'xhigh',
    category_key: 'pipeline-visualization',
    category: '파이프라인 시각화',
  };
  const main = {
    id: '2026-08-28-usage-조직도-개선:main',
    parent_id: '',
    name: 'Fable 5',
    kind: 'claude',
    model: 'claude-fable-5',
    reasoning: 'xhigh',
    role: '오케스트레이션·기획',
    status: 'working',
    assignment: '기획 착수',
  };
  const investigator = {
    id: 'codex-investigate',
    parent_id: '2026-08-28-usage-조직도-개선:main',
    name: 'GPT-5.2-Codex',
    kind: 'codex',
    model: 'gpt-5.2-codex',
    reasoning: 'xhigh',
    role: '조사(read-only)',
    status: 'working',
    assignment: '배정 작업 수행',
    phase: 'work',
  };

  const startedAt = '2026-08-28T05:20:14.683Z';
  setRemaining(88, 61, startedAt);
  const started = await post(harnessInput({
    task_id: '2026-08-28-usage-조직도-개선',
    occurred_at: startedAt,
    task: { ...task, phase: 'plan', progress: 5, status: 'active' },
    actors: [main, investigator],
    modules: [],
    artifacts: [],
  }));
  assert.equal(started.status, 200);
  let saved = JSON.parse(state.payload);
  let savedMain = saved.actors.find((actor) => actor.id === main.id);
  let savedInvestigator = saved.actors.find((actor) => actor.id === investigator.id);
  assert.deepEqual(
    {
      phase: savedMain.phase,
      started_at: savedMain.started_at,
      usage_at_start: savedMain.usage_at_start,
    },
    { phase: 'plan', started_at: startedAt, usage_at_start: { codex: 88, claude: 61 } },
  );
  assert.equal(savedInvestigator.phase, 'work');
  assert.equal(savedInvestigator.started_at, startedAt);

  const blockedAt = '2026-08-28T05:35:00.000Z';
  setRemaining(82.5, 57, blockedAt);
  const blocked = await post(harnessInput({
    task_id: '2026-08-28-usage-조직도-개선',
    occurred_at: blockedAt,
    task: { ...task, phase: 'work', progress: 45, status: 'active' },
    actors: [{ ...investigator, status: 'blocked', phase: undefined }],
    modules: [],
    artifacts: ['조사-결론.md'],
  }));
  assert.equal(blocked.status, 200);
  saved = JSON.parse(state.payload);
  savedInvestigator = saved.actors.find((actor) => actor.id === investigator.id);
  assert.equal(savedInvestigator.phase, 'work');
  assert.equal(savedInvestigator.started_at, startedAt);
  assert.equal(savedInvestigator.finished_at, blockedAt);
  assert.deepEqual(savedInvestigator.usage_at_end, { codex: 82.5, claude: 12 });

  const completedAt = '2026-08-28T06:00:00.000Z';
  setRemaining(79, 54, completedAt);
  const completed = await post(harnessInput({
    task_id: '2026-08-28-usage-조직도-개선',
    occurred_at: completedAt,
    task: { ...task, phase: 'done', progress: 100, status: 'complete' },
    actors: [main],
    modules: [],
    artifacts: ['npm test'],
  }));
  assert.equal(completed.status, 200);
  saved = JSON.parse(state.payload);
  savedMain = saved.actors.find((actor) => actor.id === main.id);
  savedInvestigator = saved.actors.find((actor) => actor.id === investigator.id);
  assert.equal(saved.completed_at, completedAt);
  assert.deepEqual(saved.actors.map((actor) => [actor.status, actor.progress]), [
    ['done', 100], ['done', 100],
  ]);
  assert.equal(savedMain.finished_at, completedAt);
  assert.deepEqual(savedMain.usage_at_end, { codex: 79, claude: 54 });
  assert.equal(savedInvestigator.finished_at, blockedAt, 'an earlier terminal stamp must stay stable');
});

test('a later completion never backfills quota that was unavailable at the actor terminal transition', async () => {
  const { state, env } = harnessStoreEnv();
  const post = (body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  const actor = {
    ...harnessInput().actors[0],
    id: 'usage-harness:no-quota-at-end',
    parent_id: 'usage-harness:main',
    progress: undefined,
  };
  assert.equal((await post(harnessInput({ actors: [harnessInput().actors[0], actor] }))).status, 200);

  const blockedAt = '2026-08-27T10:00:00.000Z';
  assert.equal((await post(harnessInput({
    occurred_at: blockedAt,
    actors: [{ ...actor, status: 'blocked' }],
  }))).status, 200);
  let savedActor = JSON.parse(state.payload).actors.find((entry) => entry.id === actor.id);
  assert.equal(savedActor.finished_at, blockedAt);
  assert.equal(savedActor.usage_at_end, undefined);

  state.usageSnapshots = [{
    source: 'codex',
    payload: JSON.stringify({ rate_limits: { secondary: { remaining_percent: 50 } } }),
  }];
  assert.equal((await post(harnessInput({
    occurred_at: '2026-08-27T12:00:00.000Z',
    task: { ...harnessInput().task, status: 'complete', phase: 'done', progress: 100 },
  }))).status, 200);
  savedActor = JSON.parse(state.payload).actors.find((entry) => entry.id === actor.id);
  assert.equal(savedActor.finished_at, blockedAt);
  assert.equal(savedActor.usage_at_end, undefined);
});

// 하위호환: 구 4단계는 새 사슬의 **부분집합**이다. 옛 보고자가 그대로 계속 보고해도
// 거절되지 않아야 하며, 사슬 밖의 값은 예전처럼 400이다.
test('legacy four-phase reporters keep working while off-chain phases stay rejected', async () => {
  assert.ok(LEGACY_HARNESS_PHASES.every((phase) => HARNESS_PHASE_CHAIN.includes(phase)),
    '구 4단계는 새 사슬의 부분집합이어야 합니다 — 아니면 하위호환이 깨집니다.');

  const { state, env } = harnessStoreEnv();
  const post = (body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

  for (const [index, phase] of LEGACY_HARNESS_PHASES.entries()) {
    const response = await post(harnessInput({
      occurred_at: `2026-08-27T10:0${index}:00.000Z`,
      task: {
        ...harnessInput().task,
        phase,
        ...(phase === 'done' ? { status: 'complete', progress: 100 } : {}),
      },
    }));
    assert.equal(response.status, 200, `구 ${phase} 단계 보고는 계속 수용돼야 합니다.`);
    assert.equal(JSON.parse(state.payload).phase, phase);
  }
  assert.equal(state.rejected, 0);

  for (const phase of ['ship', 'plan2', 'PLAN', '']) {
    const response = await worker.fetch(new Request('https://api.test/api/harness/report', {
      method: 'POST',
      headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
      body: JSON.stringify(harnessInput({
        occurred_at: '2026-08-27T11:00:00.000Z',
        task: { ...harnessInput().task, phase },
      })),
    }), harnessStoreEnv().env);
    assert.equal(response.status, 400, `사슬 밖의 "${phase}"는 거절돼야 합니다.`);
  }
});

test('harness report rejects every bounded or non-allowlisted shape before database access', async () => {
  let databaseCalls = 0;
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    HARNESS_INGEST_TOKEN: 'harness-token',
    DB: {
      prepare() {
        databaseCalls += 1;
        throw new Error('invalid harness input must not reach the database');
      },
    },
  };
  const post = (body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: {
      authorization: 'Bearer harness-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }), env);
  const postRaw = (body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: {
      authorization: 'Bearer harness-token',
      'content-type': 'application/json',
    },
    body,
  }), env);
  const invalidCases = [
    ['phase allowlist', (input) => { input.task.phase = 'ship'; }],
    ['actor phase allowlist', (input) => { input.actors[0].phase = 'ship'; }],
    ['task status allowlist', (input) => { input.task.status = 'paused'; }],
    ['actor kind allowlist', (input) => { input.actors[0].kind = 'gemini'; }],
    ['actor status allowlist', (input) => { input.actors[0].status = 'idle'; }],
    ['actor progress range', (input) => { input.actors[0].progress = 101; }],
    ['module status allowlist', (input) => { input.modules[0].status = 'idle'; }],
    ['module progress range', (input) => { input.modules[0].progress = -1; }],
    ['at least one actor', (input) => { input.actors = []; }],
    ['at most twenty actors', (input) => {
      input.actors = Array.from({ length: 21 }, (_, index) => ({
        ...input.actors[0],
        id: `usage-harness:actor-${index}`,
      }));
    }],
    ['at most twenty modules', (input) => {
      input.modules = Array.from({ length: 21 }, (_, index) => ({
        ...input.modules[0], id: `module-${index}`,
      }));
    }],
    ['at most ten artifacts', (input) => {
      input.artifacts = Array.from({ length: 11 }, (_, index) => `artifact-${index}`);
    }],
    ['bounded task strings', (input) => { input.task.name = 'x'.repeat(121); }],
  ];

  for (const [label, mutate] of invalidCases) {
    const input = structuredClone(harnessInput());
    mutate(input);
    const response = await post(input);
    assert.equal(response.status, 400, label);
    assert.deepEqual(await response.json(), { error: '잘못된 하네스 보고입니다.' }, label);
  }

  const oversized = structuredClone(harnessInput());
  oversized.ignored = '한'.repeat(25_000);
  const oversizedResponse = await post(oversized);
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), { error: '하네스 보고가 너무 큽니다.' });

  const whitespaceResponse = await postRaw(`${' '.repeat(70_000)}${JSON.stringify(harnessInput())}`);
  assert.equal(whitespaceResponse.status, 413);
  assert.deepEqual(await whitespaceResponse.json(), { error: '하네스 보고가 너무 큽니다.' });
  assert.equal(databaseCalls, 0);
});

test('usage lookup survives a corrupted snapshot row', async () => {
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    OWNER_USERNAME: 'hvsdcm',
    DB: {
      prepare(sql) {
        if (sql.includes('SELECT s.*, u.username')) {
          return {
            bind() {
              return { async first() { return { token_hash: 'stored-user-hash', role: 'user', disabled: 0, username: 'hvsdcm' }; } };
            },
          };
        }
        if (sql.includes('UPDATE sessions')) {
          return { bind() { return { async run() { return { success: true }; } }; } };
        }
        if (sql.includes('FROM usage_snapshots')) {
          assert.match(sql, /WHERE snapshots\.source IN \(\?, \?\)/u);
          return {
            bind(...sources) {
              assert.deepEqual([...sources].sort(), ['claude', 'claude', 'codex', 'codex']);
              return {
                async all() {
                  return {
                    results: [
                      { source: 'claude', captured_at: '2026-08-27T01:02:03.000Z', payload: '{"models":{}}' },
                      { source: 'codex', captured_at: '2026-08-27T01:02:03.000Z', payload: '{ broken' },
                      { source: 'gemini', captured_at: '2026-08-27T01:02:03.000Z', payload: '{}' },
                    ],
                  };
                },
              };
            },
          };
        }
        if (sql.includes('FROM harness_tasks')) {
          return { async all() { return { results: [] }; } };
        }
        if (sql.includes('FROM harness_events')) {
          return { async all() { return { results: [] }; } };
        }
        throw new Error(`Unexpected SQL in test: ${sql}`);
      },
    },
  };

  const response = await worker.fetch(new Request('https://api.test/api/usage', {
    headers: { authorization: 'Bearer user-token' },
  }), env);
  assert.equal(response.status, 200);
  const { snapshots } = await response.json();
  // 허용 목록 밖의 source(gemini)는 걸러지고, 손상된 codex 행만 payload가 null로 낮아진다.
  assert.deepEqual(snapshots.map((snapshot) => snapshot.source), ['claude', 'codex']);
  assert.deepEqual(snapshots[0].payload, { models: {} });
  assert.equal(snapshots[1].payload, null);
});

// review WP1 M-5 — 사용량은 소유자 개인 데이터다. 로그인만으로는 부족하고,
// 비소유자에게는 존재 자체를 숨긴다(404). 소유자 이름은 vars.OWNER_USERNAME이 원본이므로
// 그 값이 없으면 아무도 통과하지 못한다(fail-closed).
test('usage lookup hides itself from every account that is not the owner', async () => {
  const dbFor = (username) => ({
    prepare(sql) {
      if (sql.includes('SELECT s.*, u.username')) {
        return {
          bind() {
            return { async first() { return { token_hash: 'stored-user-hash', role: 'user', disabled: 0, username }; } };
          },
        };
      }
      if (sql.includes('UPDATE sessions')) {
        return { bind() { return { async run() { return { success: true }; } }; } };
      }
      if (sql.includes('FROM usage_snapshots')) {
        throw new Error('the owner gate let a non-owner reach the snapshot query');
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  });
  const get = (env) => worker.fetch(new Request('https://api.test/api/usage', {
    headers: { authorization: 'Bearer user-token' },
  }), env);

  // 학생 계정 — 로그인은 유효하지만 소유자가 아니다.
  const student = await get({ ALLOWED_ORIGIN: 'https://example.test', OWNER_USERNAME: 'hvsdcm', DB: dbFor('student1') });
  assert.equal(student.status, 404);
  assert.deepEqual(await student.json(), { error: 'Not found' });

  // 비밀번호만으로 발급되는 관리자 세션에는 username이 없다 — 소유자가 아니다.
  const adminOnly = await get({ ALLOWED_ORIGIN: 'https://example.test', OWNER_USERNAME: 'hvsdcm', DB: dbFor(null) });
  assert.equal(adminOnly.status, 404);

  // OWNER_USERNAME 미설정 — 소유자 이름을 알 수 없으면 소유자도 막힌다(fail-closed).
  const unset = await get({ ALLOWED_ORIGIN: 'https://example.test', DB: dbFor('hvsdcm') });
  assert.equal(unset.status, 404);
});

test('usage lookup requires a session and returns parsed snapshots', async () => {
  const unauthenticated = await worker.fetch(new Request('https://api.test/api/usage'), {
    ALLOWED_ORIGIN: 'https://example.test',
  });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: '로그인이 필요합니다.' });

  const storedPayload = { model: 'gpt-5.6-sol', rate_limits: { primary: { used_percent: 8 } } };
  const storedClaudePayload = {
    models: {
      'claude-opus-5': {
        captured_at: '2026-08-27T01:04:05.000Z',
        rate_limits: { five_hour: { used_percentage: 24 } },
      },
    },
  };
  const storedTask = {
    version: 1,
    id: 'usage-harness',
    name: '사용량 하네스 시각화 (08-27)',
    phase: 'work',
    progress: 55,
    status: 'active',
    model: 'gpt-5.6-sol',
    reasoning: 'xhigh',
    category_key: 'pipeline-visualization',
    category: '파이프라인 시각화',
    actors: [],
    artifacts: [],
    updated_at: '2026-08-27T09:00:00.000Z',
  };
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    OWNER_USERNAME: 'hvsdcm',
    DB: {
      prepare(sql) {
        if (sql.includes('SELECT s.*, u.username')) {
          return {
            bind() {
              return { async first() { return { token_hash: 'stored-user-hash', role: 'user', disabled: 0, username: 'hvsdcm' }; } };
            },
          };
        }
        if (sql.includes('UPDATE sessions')) {
          return { bind() { return { async run() { return { success: true }; } }; } };
        }
        if (sql.includes('FROM usage_snapshots')) {
          return {
            bind() {
              return {
                async all() {
                  return {
                    results: [
                      {
                        source: 'claude',
                        captured_at: '2026-08-27T01:04:05.000Z',
                        payload: JSON.stringify(storedClaudePayload),
                      },
                      {
                        source: 'codex',
                        captured_at: '2026-08-27T01:02:03.000Z',
                        payload: JSON.stringify(storedPayload),
                      },
                    ],
                  };
                },
              };
            },
          };
        }
        if (sql.includes('FROM harness_tasks')) {
          return {
            async all() {
              return {
                results: [{
                  task_id: 'usage-harness',
                  status: 'active',
                  updated_at: '2026-08-27T09:00:00.000Z',
                  payload: JSON.stringify(storedTask),
                }],
              };
            },
          };
        }
        if (sql.includes('FROM harness_events')) {
          return { async all() { return { results: [] }; } };
        }
        throw new Error(`Unexpected SQL in test: ${sql}`);
      },
    },
  };
  const response = await worker.fetch(new Request('https://api.test/api/usage', {
    headers: {
      authorization: 'Bearer user-token',
      'cf-connecting-ip': '198.51.100.1',
      'user-agent': 'Usage Browser',
    },
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    snapshots: [
      {
        source: 'claude',
        captured_at: '2026-08-27T01:04:05.000Z',
        payload: storedClaudePayload,
        last_success_at: '2026-08-27T01:04:05.000Z',
        last_attempt_at: '2026-08-27T01:04:05.000Z',
        last_outcome: 'legacy',
      },
      {
        source: 'codex',
        captured_at: '2026-08-27T01:02:03.000Z',
        payload: storedPayload,
        last_success_at: '2026-08-27T01:02:03.000Z',
        last_attempt_at: '2026-08-27T01:02:03.000Z',
        last_outcome: 'legacy',
      },
    ],
    tasks: [{
      ...storedTask,
      title: storedTask.name,
      // 이 행은 title을 지정한 적이 없다 — 하위 호환으로 name을 물려받았을 뿐이므로
      // 출처는 거짓이다. 화면은 이 값이 false일 때만 예전 추정으로 떨어진다 (M-2).
      title_authored: false,
      input: '',
      heartbeat_at: storedTask.updated_at,
      status: 'stale',
      events: [],
    }],
  });
});

test('usage completed_limit keeps every active task and returns newest completions by completion time', async () => {
  const taskRow = (id, status, updatedAt, completedAt = '') => ({
    task_id: id,
    status,
    updated_at: updatedAt,
    payload: JSON.stringify({
      version: 1,
      id,
      name: id,
      phase: status === 'complete' ? 'done' : 'work',
      progress: status === 'complete' ? 100 : 50,
      status,
      actors: [],
      modules: [],
      artifacts: [],
      updated_at: updatedAt,
      ...(completedAt ? { completed_at: completedAt } : {}),
    }),
  });
  // The old completion has the newest updated_at on purpose: completed_at must win when present.
  const storedRows = [
    taskRow('active-one', 'active', '2026-08-28T13:00:00.000Z'),
    taskRow('done-old', 'complete', '2026-08-28T15:00:00.000Z', '2026-08-28T10:00:00.000Z'),
    taskRow('done-new', 'complete', '2026-08-28T12:00:00.000Z', '2026-08-28T12:00:00.000Z'),
    taskRow('done-fallback', 'complete', '2026-08-28T11:00:00.000Z'),
  ];
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    OWNER_USERNAME: 'hvsdcm',
    DB: {
      prepare(sql) {
        if (sql.includes('SELECT s.*, u.username')) {
          return {
            bind() {
              return { async first() { return { token_hash: 'stored-user-hash', role: 'user', disabled: 0, username: 'hvsdcm' }; } };
            },
          };
        }
        if (sql.includes('UPDATE sessions')) {
          return { bind() { return { async run() { return { success: true }; } }; } };
        }
        if (sql.includes('FROM usage_snapshots')) {
          return { bind() { return { async all() { return { results: [] }; } }; } };
        }
        if (sql.includes('FROM harness_tasks')) {
          return { async all() { return { results: storedRows }; } };
        }
        if (sql.includes('FROM harness_events')) {
          return { async all() { return { results: [] }; } };
        }
        throw new Error(`Unexpected SQL in completed limit test: ${sql}`);
      },
    },
  };
  const get = (query = '') => worker.fetch(new Request(`https://api.test/api/usage${query}`, {
    headers: { authorization: 'Bearer user-token' },
  }), env);

  const legacy = await get();
  assert.equal(legacy.status, 200);
  assert.deepEqual((await legacy.json()).tasks.map((task) => task.id), storedRows.map((row) => row.task_id));

  const limited = await get('?completed_limit=2');
  assert.equal(limited.status, 200);
  assert.deepEqual((await limited.json()).tasks.map((task) => task.id), [
    'active-one', 'done-new', 'done-fallback',
  ]);

  const activeOnly = await get('?completed_limit=0');
  assert.equal(activeOnly.status, 200);
  assert.deepEqual((await activeOnly.json()).tasks.map((task) => task.id), ['active-one']);

  for (const query of ['?completed_limit=-1', '?completed_limit=1.5', '?completed_limit=1001']) {
    const invalid = await get(query);
    assert.equal(invalid.status, 400, query);
    assert.deepEqual(await invalid.json(), { error: '잘못된 완료 작업 제한입니다.' });
  }
});

test('usage lookup returns each task latest three hundred events in ascending order', async () => {
  const task = (id) => ({
    version: 1, id, name: id, phase: 'work', progress: 50, status: 'active',
    actors: [], modules: [], artifacts: [], updated_at: '2026-08-27T09:00:00.000Z',
  });
  const event = (taskId, id) => ({
    task_id: taskId,
    id,
    ts: `2026-08-27T09:${String(id).padStart(3, '0')}:00.000Z`,
    kind: id % 10 === 0 ? 'phase-change' : 'report',
    actor_id: null,
    phase: 'work',
    percent: id,
    model: 'gpt-5.6-sol',
    reasoning: 'high',
    status: 'active',
    usage_codex: 100 - (id / 10),
    usage_claude: null,
  });
  const latest = (taskId, count) => Array.from({ length: count }, (_, index) => event(taskId, index + 1)).slice(-300);
  let eventQueries = 0;
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    OWNER_USERNAME: 'hvsdcm',
    DB: {
      prepare(sql) {
        if (sql.includes('SELECT s.*, u.username')) {
          return {
            bind() {
              return { async first() { return { token_hash: 'stored-user-hash', role: 'user', disabled: 0, username: 'hvsdcm' }; } };
            },
          };
        }
        if (sql.includes('UPDATE sessions')) {
          return { bind() { return { async run() { return { success: true }; } }; } };
        }
        if (sql.includes('FROM usage_snapshots')) {
          return { bind() { return { async all() { return { results: [] }; } }; } };
        }
        if (sql.includes('FROM harness_tasks')) {
          return {
            async all() {
              return {
                results: ['task-a', 'task-b', 'task-empty'].map((taskId) => ({
                  task_id: taskId,
                  status: 'active',
                  updated_at: '2026-08-27T09:00:00.000Z',
                  payload: JSON.stringify(task(taskId)),
                })),
              };
            },
          };
        }
        if (sql.includes('FROM harness_events')) {
          eventQueries += 1;
          assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY task_id ORDER BY id DESC\) AS task_rank/u);
          assert.match(sql, /WHERE task_rank <= 300/u);
          assert.match(sql, /ORDER BY task_id ASC, id ASC/u);
          return { async all() { return { results: [...latest('task-a', 302), ...latest('task-b', 301)] }; } };
        }
        throw new Error(`Unexpected SQL in event cap test: ${sql}`);
      },
    },
  };

  const response = await worker.fetch(new Request('https://api.test/api/usage', {
    headers: { authorization: 'Bearer user-token' },
  }), env);
  assert.equal(response.status, 200);
  const { tasks } = await response.json();
  assert.equal(eventQueries, 1);
  assert.deepEqual(tasks.map((entry) => entry.events.length), [300, 300, 0]);
  assert.deepEqual(tasks[0].events.map((entry) => entry.percent).slice(0, 2), [3, 4]);
  assert.deepEqual(tasks[0].events.map((entry) => entry.percent).slice(-2), [301, 302]);
  assert.deepEqual(tasks[1].events.map((entry) => entry.percent).slice(0, 2), [2, 3]);
  assert.deepEqual(Object.keys(tasks[0].events[0]), [
    'ts', 'kind', 'actor_id', 'phase', 'percent', 'model', 'reasoning', 'status',
    'usage_codex', 'usage_claude',
  ]);
});

test('explicit project keys return one persisted project snapshot with monotonic revision and measured usage', async () => {
  let storedPayload = '';
  let storedStatus = 'active';
  let storedUpdatedAt = '';
  let storedProjectKey = '';
  let storedProjectTitle = '';
  let nextEventId = 1;
  const events = [];
  const usageRows = [
    {
      source: 'codex',
      captured_at: '2026-08-29T05:00:00.000Z',
      payload: JSON.stringify({ rate_limits: { secondary: { remaining_percent: 80 } } }),
    },
    {
      source: 'claude',
      captured_at: '2026-08-29T05:00:00.000Z',
      payload: JSON.stringify({
        models: {
          'claude-opus-5': {
            captured_at: '2026-08-29T05:00:00.000Z',
            rate_limits: { seven_day: { remaining_percent: 70 } },
          },
        },
      }),
    },
  ];
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    HARNESS_INGEST_TOKEN: 'harness-token',
    DB: {
      batch: runFakeBatch,
      prepare(sql) {
        if (sql.includes('FROM usage_snapshots')) {
          return { bind() { return { async all() { return { results: usageRows }; } }; } };
        }
        if (sql.includes('SELECT payload FROM harness_tasks')) {
          return {
            bind() {
              return { async first() { return storedPayload ? { payload: storedPayload } : null; } };
            },
          };
        }
        if (sql.includes('INSERT INTO harness_tasks')) {
          assert.match(sql, /project_key = excluded\.project_key/u);
          return {
            bind(taskId, status, updatedAt, payload, title, input, heartbeatAt, projectKey, projectTitle) {
              return {
                async run() {
                  storedPayload = payload;
                  storedStatus = status;
                  storedUpdatedAt = updatedAt;
                  storedProjectKey = projectKey;
                  storedProjectTitle = projectTitle;
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }
        if (sql.includes('INSERT INTO harness_events')) {
          return {
            bind(taskId, ts, kind, actorId, phase, percent, model, reasoning, status,
              usageCodex, usageClaude) {
              return {
                async run() {
                  events.push({
                    id: nextEventId++, task_id: taskId, ts, kind, actor_id: actorId,
                    phase, percent, model, reasoning, status,
                    usage_codex: usageCodex, usage_claude: usageClaude,
                  });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }
        if (sql.includes('FROM harness_tasks') && sql.includes('WHERE project_key = ?1')) {
          return {
            bind(projectKey) {
              assert.equal(projectKey, storedProjectKey);
              return {
                async all() {
                  return {
                    results: [{
                      task_id: 'usage-harness', status: storedStatus, updated_at: storedUpdatedAt,
                      payload: storedPayload, project_title: storedProjectTitle,
                    }],
                  };
                },
              };
            },
          };
        }
        if (sql.includes('INNER JOIN harness_tasks')) {
          return {
            bind(projectKey) {
              assert.equal(projectKey, storedProjectKey);
              return { async all() { return { results: events }; } };
            },
          };
        }
        if (sql.includes('DELETE FROM harness_events')) {
          return { async run() { return { success: true, meta: { changes: 0 } }; } };
        }
        throw new Error(`Unexpected SQL in project snapshot test: ${sql}`);
      },
    },
  };
  const post = (occurredAt) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(harnessInput({
      project_key: 'discord-bot-a1b2c3d4e5f6',
      project_title: '디스코드 봇 전환',
      occurred_at: occurredAt,
      delivery: {
        request: '프로젝트별 Discord 보고 전환',
        plan: occurredAt.endsWith('00:00.000Z') ? ['D1 단일 원본'] : [],
        changes: occurredAt.endsWith('05:00.000Z') ? ['Bot worker 연결'] : [],
        verification: occurredAt.endsWith('05:00.000Z') ? ['Worker API 200'] : [],
        approval: null,
      },
    })),
  }), env);

  const first = await post('2026-08-29T05:00:00.000Z');
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.task_id, 'usage-harness');
  assert.equal(firstBody.project_snapshot.project_key, 'discord-bot-a1b2c3d4e5f6');
  assert.equal(firstBody.project_snapshot.project_title, '디스코드 봇 전환');
  assert.equal(firstBody.project_snapshot.revision, 1);
  assert.equal(firstBody.project_snapshot.tasks.length, 1);
  assert.equal(firstBody.project_snapshot.delivery.request, '프로젝트별 Discord 보고 전환');
  assert.deepEqual(firstBody.project_snapshot.delivery.plan, ['D1 단일 원본']);
  assert.equal(firstBody.project_snapshot.usage.codex.used_percent, 20);
  assert.equal(firstBody.project_snapshot.usage.codex.consumed_percentage_points, null);

  usageRows[0] = {
    ...usageRows[0],
    captured_at: '2026-08-29T05:05:00.000Z',
    payload: JSON.stringify({ rate_limits: { secondary: { remaining_percent: 75 } } }),
  };
  const second = await post('2026-08-29T05:05:00.000Z');
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.project_snapshot.revision, 2);
  assert.equal(secondBody.project_snapshot.events.length, 2);
  assert.equal(secondBody.project_snapshot.usage.codex.used_percent, 25);
  assert.equal(secondBody.project_snapshot.usage.codex.consumed_percentage_points, 5);
  assert.equal(secondBody.project_snapshot.usage.codex.measured_at, '2026-08-29T05:05:00.000Z');
  assert.deepEqual(secondBody.project_snapshot.delivery.changes, ['Bot worker 연결']);
  assert.deepEqual(secondBody.project_snapshot.delivery.verification, ['Worker API 200']);
});

function sqliteD1(database) {
  let batchTail = Promise.resolve();
  const wrap = (statement, values = []) => ({
    bind(...nextValues) { return wrap(statement, nextValues); },
    async first() {
      const row = statement.get(...values);
      return row === undefined ? null : { ...row };
    },
    async all() {
      return { results: statement.all(...values).map((row) => ({ ...row })) };
    },
    async run() {
      const result = statement.run(...values);
      return {
        success: true,
        meta: {
          changes: Number(result.changes),
          last_row_id: Number(result.lastInsertRowid || 0),
        },
      };
    },
  });
  return {
    prepare(sql) { return wrap(database.prepare(sql)); },
    batch(statements) {
      const execute = async () => {
        database.exec('BEGIN IMMEDIATE');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          database.exec('COMMIT');
          return results;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      };
      const result = batchTail.then(execute, execute);
      batchTail = result.catch(() => {});
      return result;
    },
  };
}

async function moderatorTestContext(t) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }
  if (!DatabaseSync) {
    t.skip('node:sqlite unavailable');
    return null;
  }
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  for (let number = 1; number <= 11; number += 1) {
    const prefix = String(number).padStart(4, '0');
    const migrationNames = {
      '0001': 'init',
      '0002': 'answer_labels',
      '0003': 'answer_context',
      '0004': 'session_ip_address',
      '0005': 'usage_snapshots',
      '0006': 'harness_tasks',
      '0007': 'harness_events',
      '0008': 'login_attempt_limits',
      '0009': 'usage_health_harness_heartbeat',
      '0010': 'harness_project_snapshots',
      '0011': 'moderator_control_plane',
    };
    const sql = readFileSync(
      new URL(`./migrations/${prefix}_${migrationNames[prefix]}.sql`, import.meta.url),
      'utf8',
    );
    database.exec(sql);
  }
  const createdAt = Date.now();
  const owner = database.prepare(`
    INSERT INTO users(username, password_hash, password_salt, created_at, disabled)
    VALUES ('hvsdcm', 'unused', 'unused', ?, 0)
  `).run(createdAt);
  const student = database.prepare(`
    INSERT INTO users(username, password_hash, password_salt, created_at, disabled)
    VALUES ('student', 'unused', 'unused', ?, 0)
  `).run(createdAt);
  const insertSession = database.prepare(`
    INSERT INTO sessions(token_hash, user_id, role, created_at, expires_at, last_seen_at)
    VALUES (?, ?, 'user', ?, ?, ?)
  `);
  insertSession.run(
    await sha256('owner-token'),
    Number(owner.lastInsertRowid),
    createdAt,
    createdAt + DAY_MS,
    createdAt,
  );
  insertSession.run(
    await sha256('student-token'),
    Number(student.lastInsertRowid),
    createdAt,
    createdAt + DAY_MS,
    createdAt,
  );
  return {
    database,
    env: {
      ALLOWED_ORIGIN: 'https://example.test',
      OWNER_USERNAME: 'hvsdcm',
      MODERATOR_DAEMON_TOKEN: 'daemon-token',
      DB: sqliteD1(database),
    },
  };
}

function moderatorRequest(env, path, { method = 'GET', token = '', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return worker.fetch(new Request(`https://api.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
}

function insertModeratorItemForTest(database, {
  itemId, kind, status, version = 1,
}) {
  database.prepare(`
    INSERT INTO moderator_items(
      item_id, kind, status, issue_summary, action_summary, proposed_command,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, 'Test issue', 'Test action', ?, ?,
      '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z')
  `).run(itemId, kind, status, kind === 'proposal' ? 'run test command' : null, version);
}

function closeModeratorItem(env, itemId, reason, token = 'daemon-token') {
  return moderatorRequest(env, `/api/moderator/daemon/items/${itemId}/close`, {
    method: 'POST', token, body: { reason },
  });
}

test('moderator migration enforces kind states, proposal separation, and one active review', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database } = context;
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'moderator_%'
    ORDER BY name
  `).all().map((row) => row.name);
  assert.deepEqual(tables, ['moderator_commands', 'moderator_item_events', 'moderator_items']);
  assert.throws(() => database.prepare(`
    INSERT INTO moderator_items(
      item_id, kind, status, issue_summary, action_summary, created_at, updated_at
    ) VALUES ('bad-important', 'important', 'pending', 'issue', 'action', '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z')
  `).run(), /CHECK constraint failed/u);
  const insertReview = database.prepare(`
    INSERT INTO moderator_items(
      item_id, kind, status, issue_summary, action_summary,
      lease_id, lease_until, created_at, updated_at
    ) VALUES (?, 'review', 'running', 'issue', 'action', ?, '2026-08-29T01:00:00Z',
      '2026-08-29T00:00:00Z', '2026-08-29T00:00:00Z')
  `);
  insertReview.run('review-one', 'lease-one');
  assert.throws(() => insertReview.run('review-two', 'lease-two'), /UNIQUE constraint failed/u);
  assert.match(MODERATOR_PROPOSAL_APPROVE_SQL, /status = 'pending'/u);
  assert.match(MODERATOR_ITEM_EVENT_AFTER_CHANGE_SQL, /changes\(\) > 0/u);
  assert.match(MODERATOR_PROPOSAL_COMMAND_AFTER_EVENT_SQL, /source_item_id/u);
  assert.match(MODERATOR_COMMAND_CLAIM_SQL, /UPDATE moderator_commands[\s\S]*status = 'queued'/u);
});

test('daemon close resolves an open important item and records its reason', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const reason = '정지 세션이 사라져 중요 항목을 닫습니다.';
  const rawReason = '  정지   세션이 사라져\n중요 항목을 닫습니다.  ';
  insertModeratorItemForTest(database, {
    itemId: 'important-close', kind: 'important', status: 'open', version: 3,
  });

  const response = await closeModeratorItem(env, 'important-close', rawReason);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.item.status, 'resolved');
  assert.equal(body.item.version, 4);
  assert.equal(body.item.updated_at, body.item.decided_at);
  const events = database.prepare(`
    SELECT event, version, payload FROM moderator_item_events WHERE item_id = ? ORDER BY id
  `).all('important-close');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'resolved');
  assert.equal(events[0].version, 4);
  assert.deepEqual(JSON.parse(events[0].payload), {
    action: 'resolved', reason, by: 'moderator-daemon',
  });
});

test('daemon close rejects a pending proposal and records its reason', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const reason = '제안 원인이 사라져 대기 항목을 닫습니다.';
  insertModeratorItemForTest(database, {
    itemId: 'proposal-close', kind: 'proposal', status: 'pending', version: 5,
  });

  const response = await closeModeratorItem(env, 'proposal-close', reason);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.item.status, 'rejected');
  assert.equal(body.item.version, 6);
  assert.equal(body.item.updated_at, body.item.decided_at);
  const events = database.prepare(`
    SELECT event, version, payload FROM moderator_item_events WHERE item_id = ?
  `).all('proposal-close');
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.event, 'rejected');
  assert.equal(event.version, 6);
  assert.deepEqual(JSON.parse(event.payload), {
    action: 'rejected', reason, by: 'moderator-daemon',
  });
});

test('daemon close never changes an acknowledged important item', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database, env } = context;
  insertModeratorItemForTest(database, {
    itemId: 'important-acknowledged', kind: 'important', status: 'acknowledged', version: 7,
  });

  const response = await closeModeratorItem(
    env, 'important-acknowledged', '사용자가 확인한 항목은 그대로 둡니다.',
  );
  assert.equal(response.status, 409);
  const row = database.prepare(`
    SELECT status, version FROM moderator_items WHERE item_id = ?
  `).get('important-acknowledged');
  assert.deepEqual({ ...row }, { status: 'acknowledged', version: 7 });
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM moderator_item_events WHERE item_id = ?
  `).get('important-acknowledged').count, 0);
});

test('daemon close never changes an approved proposal', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database, env } = context;
  insertModeratorItemForTest(database, {
    itemId: 'proposal-approved', kind: 'proposal', status: 'approved', version: 8,
  });

  const response = await closeModeratorItem(
    env, 'proposal-approved', '사용자가 승인한 제안은 그대로 둡니다.',
  );
  assert.equal(response.status, 409);
  const row = database.prepare(`
    SELECT status, version FROM moderator_items WHERE item_id = ?
  `).get('proposal-approved');
  assert.deepEqual({ ...row }, { status: 'approved', version: 8 });
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM moderator_item_events WHERE item_id = ?
  `).get('proposal-approved').count, 0);
});

test('daemon close refuses review items', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database, env } = context;
  insertModeratorItemForTest(database, {
    itemId: 'review-close', kind: 'review', status: 'done', version: 2,
  });

  const response = await closeModeratorItem(env, 'review-close', '검토는 기존 경로로 닫습니다.');
  assert.equal(response.status, 400);
  const row = database.prepare(`
    SELECT status, version FROM moderator_items WHERE item_id = ?
  `).get('review-close');
  assert.deepEqual({ ...row }, { status: 'done', version: 2 });
});

test('daemon close requires the daemon token', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database, env } = context;
  insertModeratorItemForTest(database, {
    itemId: 'important-unauthorized', kind: 'important', status: 'open', version: 2,
  });

  const response = await closeModeratorItem(
    env, 'important-unauthorized', '인증되지 않은 요청은 거절합니다.', '',
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'daemon_unauthorized' });
  const row = database.prepare(`
    SELECT status, version FROM moderator_items WHERE item_id = ?
  `).get('important-unauthorized');
  assert.deepEqual({ ...row }, { status: 'open', version: 2 });
});

test('daemon close distinguishes missing and invalid item ids', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { env } = context;

  const missing = await closeModeratorItem(env, 'missing-close-item', '없는 항목은 찾을 수 없습니다.');
  assert.equal(missing.status, 404);
  const invalid = await closeModeratorItem(env, 'invalid$item', '잘못된 식별자는 거절합니다.');
  assert.equal(invalid.status, 400);
});

test('daemon close requires a normalized reason of at most 240 characters', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database, env } = context;
  insertModeratorItemForTest(database, {
    itemId: 'important-reason', kind: 'important', status: 'open', version: 4,
  });

  assert.equal((await closeModeratorItem(env, 'important-reason', '   ')).status, 400);
  assert.equal((await closeModeratorItem(env, 'important-reason', '가'.repeat(241))).status, 400);
  const row = database.prepare(`
    SELECT status, version FROM moderator_items WHERE item_id = ?
  `).get('important-reason');
  assert.deepEqual({ ...row }, { status: 'open', version: 4 });
});

test('daemon close rejects repeated closes without another version or event', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database, env } = context;
  insertModeratorItemForTest(database, {
    itemId: 'important-close-twice', kind: 'important', status: 'open', version: 9,
  });

  const first = await closeModeratorItem(
    env, 'important-close-twice', '사라진 정지 세션 항목을 닫습니다.',
  );
  assert.equal(first.status, 200);
  const second = await closeModeratorItem(
    env, 'important-close-twice', '같은 항목을 다시 닫지 않습니다.',
  );
  assert.equal(second.status, 409);
  const row = database.prepare(`
    SELECT status, version FROM moderator_items WHERE item_id = ?
  `).get('important-close-twice');
  assert.deepEqual({ ...row }, { status: 'resolved', version: 10 });
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM moderator_item_events WHERE item_id = ?
  `).get('important-close-twice').count, 1);

  insertModeratorItemForTest(database, {
    itemId: 'proposal-close-twice', kind: 'proposal', status: 'pending', version: 11,
  });
  assert.equal((await closeModeratorItem(
    env, 'proposal-close-twice', '사라진 제안 원인 항목을 닫습니다.',
  )).status, 200);
  assert.equal((await closeModeratorItem(
    env, 'proposal-close-twice', '같은 제안을 다시 닫지 않습니다.',
  )).status, 409);
  const proposal = database.prepare(`
    SELECT status, version FROM moderator_items WHERE item_id = ?
  `).get('proposal-close-twice');
  assert.deepEqual({ ...proposal }, { status: 'rejected', version: 12 });
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM moderator_item_events WHERE item_id = ?
  `).get('proposal-close-twice').count, 1);
});

test('moderator owner and daemon boundaries protect an atomic direct-command lease flow', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const anonymous = await moderatorRequest(env, '/api/moderator');
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: 'authentication_required' });
  const nonOwner = await moderatorRequest(env, '/api/moderator', { token: 'student-token' });
  assert.equal(nonOwner.status, 404);
  assert.deepEqual(await nonOwner.json(), { error: 'Not found' });
  const invalidPage = await moderatorRequest(env, '/api/moderator?limit=0', { token: 'owner-token' });
  assert.equal(invalidPage.status, 400);
  const duplicateCursor = await moderatorRequest(
    env,
    '/api/moderator?cursor=first&cursor=second',
    { token: 'owner-token' },
  );
  assert.equal(duplicateCursor.status, 400);
  const wrongDaemon = await moderatorRequest(env, '/api/moderator/daemon/claim', {
    method: 'POST', token: 'wrong-token',
  });
  assert.equal(wrongDaemon.status, 401);
  assert.deepEqual(await wrongDaemon.json(), { error: 'daemon_unauthorized' });

  const nullCommand = await moderatorRequest(env, '/api/moderator/commands', {
    method: 'POST', token: 'owner-token', body: null,
  });
  assert.equal(nullCommand.status, 400);
  assert.deepEqual(await nullCommand.json(), { error: 'invalid_json' });
  const oversized = await moderatorRequest(env, '/api/moderator/commands', {
    method: 'POST', token: 'owner-token',
    body: { command: 'canary', idempotency_key: 'oversized', ignored: 'x'.repeat(64_001) },
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'request_too_large' });
  const overlongCommand = await moderatorRequest(env, '/api/moderator/commands', {
    method: 'POST', token: 'owner-token',
    body: { command: 'x'.repeat(8_193), idempotency_key: 'overlong-command' },
  });
  assert.equal(overlongCommand.status, 400);
  const malformed = await worker.fetch(new Request('https://api.test/api/moderator/commands', {
    method: 'POST',
    headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
    body: '{',
  }), env);
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid_json' });

  const directBody = { command: 'write canary artifact', idempotency_key: 'direct-canary-1' };
  const created = await moderatorRequest(env, '/api/moderator/commands', {
    method: 'POST', token: 'owner-token', body: directBody,
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('access-control-allow-origin'), env.ALLOWED_ORIGIN);
  const createdBody = await created.json();
  assert.equal(createdBody.command.status, 'queued');
  assert.equal(createdBody.command.requested_model, 'gpt-5.6-sol');
  assert.equal(createdBody.duplicate, false);
  const repeated = await moderatorRequest(env, '/api/moderator/commands', {
    method: 'POST', token: 'owner-token', body: directBody,
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).duplicate, true);
  const conflicting = await moderatorRequest(env, '/api/moderator/commands', {
    method: 'POST', token: 'owner-token',
    body: { ...directBody, command: 'different command' },
  });
  assert.equal(conflicting.status, 409);

  const claimed = await moderatorRequest(env, '/api/moderator/daemon/claim', {
    method: 'POST', token: 'daemon-token',
  });
  assert.equal(claimed.status, 200);
  const claimBody = await claimed.json();
  assert.equal(claimBody.command.command_id, createdBody.command.command_id);
  assert.equal(claimBody.command.status, 'claimed');
  assert.equal(claimBody.command.attempts, 1);
  assert.match(claimBody.command.lease_id, /^lease_/u);
  assert.equal(claimBody.active_task_count, 0);
  assert.deepEqual(claimBody.counts, {
    version: 1,
    effective_active_tasks: 0,
    active_commands: 1,
    review_leases: 0,
  });
  const emptyClaim = await moderatorRequest(env, '/api/moderator/daemon/claim', {
    method: 'POST', token: 'daemon-token',
  });
  const emptyClaimBody = await emptyClaim.json();
  assert.equal(emptyClaimBody.command, null);
  assert.equal(emptyClaimBody.counts.active_commands, 1);

  const statePath = `/api/moderator/daemon/commands/${claimBody.command.command_id}/state`;
  const nullState = await moderatorRequest(env, statePath, {
    method: 'POST', token: 'daemon-token', body: null,
  });
  assert.equal(nullState.status, 400);
  const wrongLease = await moderatorRequest(env, statePath, {
    method: 'POST', token: 'daemon-token', body: { state: 'running', lease_id: 'lease_wrong' },
  });
  assert.equal(wrongLease.status, 409);
  const running = await moderatorRequest(env, statePath, {
    method: 'POST', token: 'daemon-token',
    body: { state: 'running', lease_id: claimBody.command.lease_id },
  });
  assert.equal(running.status, 200);
  assert.equal((await running.json()).command.status, 'running');
  const completed = await moderatorRequest(env, statePath, {
    method: 'POST', token: 'daemon-token',
    body: {
      state: 'succeeded',
      lease_id: claimBody.command.lease_id,
      actual_model: 'gpt-5.6-sol',
      actual_reasoning: 'xhigh',
      issue_summary: 'Canary requested',
      action_summary: 'Canary written',
    },
  });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).command.status, 'succeeded');
  const regression = await moderatorRequest(env, statePath, {
    method: 'POST', token: 'daemon-token',
    body: { state: 'running', lease_id: claimBody.command.lease_id },
  });
  assert.equal(regression.status, 409);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM moderator_commands').get().count, 1);
});

test('expired command leases recover once, exhaust safely, and fail an abandoned running command', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const create = (key) => moderatorRequest(env, '/api/moderator/commands', {
    method: 'POST',
    token: 'owner-token',
    body: { command: `run ${key}`, idempotency_key: key },
  });
  const claim = () => moderatorRequest(env, '/api/moderator/daemon/claim', {
    method: 'POST', token: 'daemon-token',
  });

  const firstCreated = await create('claimed-crash');
  const firstId = (await firstCreated.json()).command.command_id;
  const firstClaim = (await (await claim()).json()).command;
  assert.equal(firstClaim.command_id, firstId);
  database.prepare(`
    UPDATE moderator_commands SET lease_until = '2000-01-01T00:00:00.000Z'
    WHERE command_id = ?
  `).run(firstId);
  const secondClaim = (await (await claim()).json()).command;
  assert.equal(secondClaim.command_id, firstId);
  assert.equal(secondClaim.attempts, 2);
  database.prepare(`
    UPDATE moderator_commands SET lease_until = '2000-01-01T00:00:00.000Z'
    WHERE command_id = ?
  `).run(firstId);
  assert.equal((await (await claim()).json()).command, null);
  const exhausted = database.prepare(`
    SELECT status, attempts, issue_summary, action_summary
    FROM moderator_commands WHERE command_id = ?
  `).get(firstId);
  assert.deepEqual({ ...exhausted }, {
    status: 'failed',
    attempts: 2,
    issue_summary: 'Command lease expired',
    action_summary: 'Execution stopped without a valid lease',
  });

  const runningCreated = await create('running-crash');
  const runningId = (await runningCreated.json()).command.command_id;
  const runningClaim = (await (await claim()).json()).command;
  const statePath = `/api/moderator/daemon/commands/${runningId}/state`;
  assert.equal((await moderatorRequest(env, statePath, {
    method: 'POST', token: 'daemon-token',
    body: { state: 'running', lease_id: runningClaim.lease_id },
  })).status, 200);
  database.prepare(`
    UPDATE moderator_commands SET lease_until = '2000-01-01T00:00:00.000Z'
    WHERE command_id = ?
  `).run(runningId);
  assert.equal((await (await claim()).json()).command, null);
  assert.equal(
    database.prepare('SELECT status FROM moderator_commands WHERE command_id = ?').get(runningId).status,
    'failed',
  );
  assert.equal(moderatorActiveCommandsForTest(database), 0);
});

function moderatorActiveCommandsForTest(database) {
  return database.prepare(`
    SELECT COUNT(*) AS count FROM moderator_commands
    WHERE status IN ('queued', 'claimed', 'running')
  `).get().count;
}

test('simultaneous proposal approvals and command claims each produce one winner', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const proposal = await moderatorRequest(env, '/api/moderator/daemon/items', {
    method: 'POST',
    token: 'daemon-token',
    body: {
      item_id: 'proposal-race',
      kind: 'proposal',
      issue_summary: 'Race approval',
      action_summary: 'Approve exactly once',
      proposed_command: 'write race canary',
    },
  });
  assert.equal(proposal.status, 201);
  const approve = () => moderatorRequest(env, '/api/moderator/items/proposal-race/decision', {
    method: 'POST', token: 'owner-token', body: { action: 'approve' },
  });
  const approvals = await Promise.all([approve(), approve()]);
  assert.deepEqual(approvals.map((response) => response.status).sort(), [200, 409]);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM moderator_commands WHERE source_item_id = ?')
      .get('proposal-race').count,
    1,
  );
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS count FROM moderator_item_events
      WHERE item_id = ? AND event = 'approved'
    `).get('proposal-race').count,
    1,
  );

  const claim = () => moderatorRequest(env, '/api/moderator/daemon/claim', {
    method: 'POST', token: 'daemon-token',
  });
  const claims = await Promise.all([claim(), claim()]);
  const claimedCommands = await Promise.all(claims.map((response) => response.json()));
  assert.equal(claimedCommands.filter((body) => body.command !== null).length, 1);
  assert.equal(claimedCommands.filter((body) => body.command === null).length, 1);
  assert.equal(
    database.prepare('SELECT attempts FROM moderator_commands WHERE source_item_id = ?')
      .get('proposal-race').attempts,
    1,
  );
});

test('proposal approval queues exactly once and idle review leases remain exclusive', async (t) => {
  const context = await moderatorTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const daemonItem = (body) => moderatorRequest(env, '/api/moderator/daemon/items', {
    method: 'POST', token: 'daemon-token', body,
  });
  const overlongSummary = await daemonItem({
    item_id: 'important-too-long',
    kind: 'important',
    issue_summary: 'x'.repeat(241),
    action_summary: 'Reject this item',
  });
  assert.equal(overlongSummary.status, 400);
  const bypassedReview = await daemonItem({
    item_id: 'review-bypass',
    kind: 'review',
    status: 'done',
    issue_summary: 'No lease was acquired',
    action_summary: 'This must be rejected',
  });
  assert.equal(bypassedReview.status, 400);
  const proposal = await daemonItem({
    item_id: 'proposal-canary',
    kind: 'proposal',
    issue_summary: 'A canary is needed',
    action_summary: 'Approve the canary command',
    proposed_command: 'write proposal canary',
    brain_model: 'gpt-5.6-sol',
    brain_reasoning: 'xhigh',
  });
  assert.equal(proposal.status, 201);
  assert.equal((await proposal.json()).item.status, 'pending');
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM moderator_commands WHERE source_item_id = ?').get('proposal-canary').count,
    0,
  );
  const nullDecision = await moderatorRequest(env, '/api/moderator/items/proposal-canary/decision', {
    method: 'POST', token: 'owner-token', body: null,
  });
  assert.equal(nullDecision.status, 400);
  const edit = await moderatorRequest(env, '/api/moderator/items/proposal-canary/decision', {
    method: 'POST', token: 'owner-token',
    body: { action: 'edit', edited_command: 'write edited proposal canary' },
  });
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).item.status, 'pending');
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM moderator_commands WHERE source_item_id = ?').get('proposal-canary').count,
    0,
  );
  const approve = await moderatorRequest(env, '/api/moderator/items/proposal-canary/decision', {
    method: 'POST', token: 'owner-token', body: { action: 'approve' },
  });
  assert.equal(approve.status, 200);
  const approvedBody = await approve.json();
  assert.equal(approvedBody.item.status, 'approved');
  assert.equal(approvedBody.command.command_text, 'write edited proposal canary');
  const secondApprove = await moderatorRequest(env, '/api/moderator/items/proposal-canary/decision', {
    method: 'POST', token: 'owner-token', body: { action: 'approve' },
  });
  assert.equal(secondApprove.status, 409);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM moderator_commands WHERE source_item_id = ?').get('proposal-canary').count,
    1,
  );

  const important = await daemonItem({
    item_id: 'important-canary',
    kind: 'important',
    issue_summary: 'Owner attention needed',
    action_summary: 'Acknowledge only',
  });
  assert.equal(important.status, 201);
  const acknowledged = await moderatorRequest(env, '/api/moderator/items/important-canary/acknowledge', {
    method: 'POST', token: 'owner-token', body: {},
  });
  assert.equal(acknowledged.status, 200);
  assert.equal((await acknowledged.json()).item.status, 'acknowledged');
  const secondAcknowledge = await moderatorRequest(env, '/api/moderator/items/important-canary/acknowledge', {
    method: 'POST', token: 'owner-token', body: {},
  });
  assert.equal(secondAcknowledge.status, 409);

  const deniedReview = await moderatorRequest(env, '/api/moderator/daemon/review-lease', {
    method: 'POST', token: 'daemon-token',
  });
  assert.equal((await deniedReview.json()).lease, null, 'a queued proposal command blocks idle review');
  const claim = await moderatorRequest(env, '/api/moderator/daemon/claim', {
    method: 'POST', token: 'daemon-token',
  });
  const claimed = (await claim.json()).command;
  const statePath = `/api/moderator/daemon/commands/${claimed.command_id}/state`;
  assert.equal((await moderatorRequest(env, statePath, {
    method: 'POST', token: 'daemon-token', body: { state: 'running', lease_id: claimed.lease_id },
  })).status, 200);
  assert.equal((await moderatorRequest(env, statePath, {
    method: 'POST', token: 'daemon-token',
    body: {
      state: 'succeeded', lease_id: claimed.lease_id,
      issue_summary: 'Proposal approved', action_summary: 'Canary written',
    },
  })).status, 200);

  const acquired = await moderatorRequest(env, '/api/moderator/daemon/review-lease', {
    method: 'POST', token: 'daemon-token',
  });
  const lease = (await acquired.json()).lease;
  assert.match(lease.item_id, /^review_/u);
  assert.equal(lease.project_key, 'claude-workspace');
  assert.equal(Object.hasOwn(lease, 'allowed_paths'), false, 'server cannot authorize local paths');
  const duplicateLease = await moderatorRequest(env, '/api/moderator/daemon/review-lease', {
    method: 'POST', token: 'daemon-token',
  });
  assert.equal((await duplicateLease.json()).lease, null);
  const finishedReview = await daemonItem({
    item_id: lease.item_id,
    kind: 'review',
    status: 'done',
    issue_summary: 'No blocker found',
    action_summary: 'Review completed',
    review_lease_id: lease.lease_id,
  });
  assert.equal(finishedReview.status, 200);
  assert.equal((await finishedReview.json()).item.status, 'done');
  const nextReview = await moderatorRequest(env, '/api/moderator/daemon/review-lease', {
    method: 'POST', token: 'daemon-token',
  });
  const staleLease = (await nextReview.json()).lease;
  assert.ok(staleLease);
  database.prepare(`
    UPDATE moderator_items SET lease_until = '2000-01-01T00:00:00.000Z'
    WHERE item_id = ?
  `).run(staleLease.item_id);
  const recoveredReview = await moderatorRequest(env, '/api/moderator/daemon/review-lease', {
    method: 'POST', token: 'daemon-token',
  });
  const recoveredLease = (await recoveredReview.json()).lease;
  assert.ok(recoveredLease);
  assert.notEqual(recoveredLease.item_id, staleLease.item_id);
  const staleRow = database.prepare(`
    SELECT status, action_summary FROM moderator_items WHERE item_id = ?
  `).get(staleLease.item_id);
  assert.equal(staleRow.status, 'failed');
  assert.equal(staleRow.action_summary, 'Review lease expired before completion');

  const firstPage = await moderatorRequest(env, '/api/moderator?limit=1', { token: 'owner-token' });
  assert.equal(firstPage.status, 200);
  const firstPageBody = await firstPage.json();
  assert.equal(firstPageBody.items.length, 1);
  assert.ok(firstPageBody.next_cursor);
  const secondPage = await moderatorRequest(
    env,
    `/api/moderator?limit=1&cursor=${encodeURIComponent(firstPageBody.next_cursor)}`,
    { token: 'owner-token' },
  );
  assert.equal(secondPage.status, 200);
  const secondPageBody = await secondPage.json();
  assert.notEqual(secondPageBody.items[0].item_id, firstPageBody.items[0].item_id);
  const allItems = await moderatorRequest(env, '/api/moderator?limit=100', { token: 'owner-token' });
  const allBody = await allItems.json();
  const storedProposal = allBody.items.find((item) => item.item_id === 'proposal-canary');
  assert.deepEqual(storedProposal.events.map((event) => event.event), ['created', 'edited', 'approved']);
  assert.equal(storedProposal.worker_model, null);
  assert.equal(JSON.stringify(allBody).includes('student-token'), false);
  assert.equal(JSON.stringify(allBody).includes('ip_address'), false);
  assert.equal(JSON.stringify(allBody).includes('user_agent'), false);
});

test('unexpected server errors do not expose internal details', async () => {
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    DB: {
      prepare() {
        throw new Error('sensitive database detail');
      },
    },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await worker.fetch(new Request('https://api.test/api/me', {
      headers: { authorization: 'Bearer example-token' },
    }), env);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: '서버 오류' });
  } finally {
    console.error = originalError;
  }
});
