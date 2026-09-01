import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import worker from './src/index.js';
import {
  HARNESS_STALE_MS,
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
const COMPETITION_REPORTER_FIXTURE = JSON.parse(readFileSync(
  new URL('../scripts/fixtures/competition-report.valid.json', import.meta.url),
  'utf8',
));

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
                      { source: 'behavior-paper:paper-20260831-100usd', captured_at: '2026-08-30T19:00:00.000Z', payload: '{"sequence":1}' },
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
  // 허용 목록 밖의 source(gemini와 Behavior paper)는 걸러지고, 손상된 codex 행만 payload가 null로 낮아진다.
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

  // 값은 쉼표 목록이다(에이전트 테스트 계정을 한시적으로 얹기 위한 것). 목록에 없는
  // 이름은 여전히 404이고, 빈 칸이나 공백만으로는 아무도 통과하지 못한다.
  const listed = await get({
    ALLOWED_ORIGIN: 'https://example.test',
    OWNER_USERNAME: 'hvsdcm, claude-test',
    DB: dbFor('claude-test'),
  });
  assert.notEqual(listed.status, 404);
  const unlisted = await get({
    ALLOWED_ORIGIN: 'https://example.test',
    OWNER_USERNAME: 'hvsdcm, claude-test',
    DB: dbFor('student1'),
  });
  assert.equal(unlisted.status, 404);
  const blanks = await get({
    ALLOWED_ORIGIN: 'https://example.test',
    OWNER_USERNAME: ' , , ',
    DB: dbFor(''),
  });
  assert.equal(blanks.status, 404);
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

async function competitionDatabaseContext(t) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }
  if (!DatabaseSync) {
    t.skip('node:sqlite unavailable');
    return null;
  }
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  for (let number = 1; number <= 18; number += 1) {
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
      '0012': 'moderator_read_state',
      '0013': 'moderator_backfill_read',
      '0014': 'competitions',
      '0015': 'competition_candidate_capacity',
      '0016': 'competition_approval_requests',
      '0017': 'competition_approval_report_links',
      '0018': 'competition_preference_contract',
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
      DB: sqliteD1(database),
    },
  };
}


const COMPETITION_PROFILE_ID = `hmac-sha256:${'0123456789abcdef'.repeat(4)}`;
const COMPETITION_KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

function competitionKstDate(milliseconds) {
  return new Date(milliseconds + COMPETITION_KST_OFFSET_MS).toISOString().slice(0, 10);
}

function setCompetitionTimeline(fixture, startedAt) {
  const start = Math.floor(startedAt / 1_000) * 1_000;
  const finished = start + 5 * 60_000;
  fixture.run.date = competitionKstDate(start);
  fixture.run.started_at = new Date(start).toISOString();
  fixture.run.finished_at = new Date(finished).toISOString();
  fixture.sources[0].checked_at = new Date(start + 60_000).toISOString();
  if (fixture.candidates[0]) {
    fixture.candidates[0].discovered_at = new Date(start + 60_000).toISOString();
    fixture.candidates[0].official_verified_at = new Date(start + 2 * 60_000).toISOString();
    fixture.candidates[0].deadline_at = new Date(finished + 3 * DAY_MS).toISOString();
  }
  if (fixture.applications[0]) {
    fixture.applications[0].updated_at = new Date(start + 4 * 60_000).toISOString();
  }
  if (fixture.approvals?.[0]) {
    fixture.approvals[0].requested_at = new Date(start + 4 * 60_000).toISOString();
    if (fixture.approvals[0].expires_at) {
      fixture.approvals[0].expires_at = new Date(start + 14 * 60_000).toISOString();
    }
  }
  return fixture;
}

function assertCompetitionNoStore(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
}

function competitionFixture() {
  const fixture = {
    version: 1,
    idempotency_key: 'competition-daily-2026-08-31-001',
    run: {
      id: 'competition-2026-08-31-001',
      date: '2026-08-31',
      started_at: '2026-08-31T00:00:00+09:00',
      finished_at: '2026-08-31T00:05:00+09:00',
      status: 'complete',
      source_coverage: { expected: 1, checked: 1, succeeded: 1 },
    },
    sources: [{
      id: 'contest-listing',
      kind: 'listing',
      name: 'Contest Listing',
      reference_url: 'https://list.example/contests/123',
      checked_at: '2026-08-31T00:01:00+09:00',
      status: 'ok',
      failure_code: 'none',
      manual_check: false,
      candidate_count: 1,
    }],
    candidates: [{
      contest_id: 'organizer-2026-image',
      category: 'image',
      title: 'Example Image Contest',
      organizer: 'Example Organizer',
      source_id: 'contest-listing',
      discovery_url: 'https://list.example/contests/123',
      discovered_at: '2026-08-31T00:01:00+09:00',
      recency: 'new',
      official_url: 'https://organizer.example/rules',
      official_verification: 'verified',
      official_verified_at: '2026-08-31T00:02:00+09:00',
      acceptance: 'open',
      deadline_at: '2026-09-03T14:59:00Z',
      eligibility: 'eligible',
      fee_status: 'free',
      participation_mode: 'none',
      rights_risk: 'low',
      submission_risk: 'low',
      status: 'active',
      fit_score: 80,
      effort_score: 20,
    }],
    applications: [{
      contest_id: 'organizer-2026-image',
      category: 'image',
      profile_id: COMPETITION_PROFILE_ID,
      state: 'WAITING_ARTIFACTS',
      blocker: 'artifacts',
      next_action: 'prepare_artifacts',
      updated_at: '2026-08-31T00:04:00+09:00',
    }],
  };
  const currentKstDate = competitionKstDate(Date.now());
  const currentKstMidnight = Date.parse(`${currentKstDate}T00:00:00+09:00`);
  return setCompetitionTimeline(fixture, Math.max(currentKstMidnight, Date.now() - 10 * 60_000));
}

function competitionRequest(env, { method = 'POST', token = 'competition-token', body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return worker.fetch(new Request('https://api.test/api/competitions/report', {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
}

function competitionWithPreparationApproval() {
  const fixture = competitionFixture();
  fixture.applications[0].state = 'WAITING_RIGHTS_APPROVAL';
  fixture.applications[0].blocker = 'rights';
  fixture.applications[0].next_action = 'review_rights';
  fixture.approvals = [{
    request_id: 'competition-preparation-organizer-2026-image',
    contest_id: fixture.candidates[0].contest_id,
    category: fixture.candidates[0].category,
    kind: 'preparation',
    action_sha256: 'a'.repeat(64),
    requested_at: fixture.applications[0].updated_at,
    expires_at: null,
    read_summary: '권리 이용 범위가 넓습니다. 공식 공고와 마감, 자격, 제출 규격을 확인했습니다.',
    approval_text: '작품 초안과 비식별 서류 준비만 허용합니다. 개인정보, 서명, 동의, 전송은 포함하지 않습니다.',
  }];
  return fixture;
}

function competitionApprovalRequest(env, {
  requestId = 'competition-preparation-organizer-2026-image',
  token = 'owner-token',
  body = { decision: 'approved', action_sha256: 'a'.repeat(64) },
} = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return worker.fetch(new Request(
    `https://api.test/api/competitions/approvals/${requestId}/decision`,
    { method: 'POST', headers, body: JSON.stringify(body) },
  ), env);
}

async function competitionTestContext(t) {
  const context = await competitionDatabaseContext(t);
  if (!context) return null;
  context.env.COMPETITION_INGEST_TOKEN = 'competition-token';
  return context;
}

test('competition routes fail closed at the owner and dedicated-ingest-token boundaries', async () => {
  const noDatabase = {
    prepare() { throw new Error('competition authentication boundary reached the database'); },
  };
  for (const token of ['', 'wrong-token']) {
    const response = await competitionRequest({
      ALLOWED_ORIGIN: 'https://example.test',
      COMPETITION_INGEST_TOKEN: 'competition-token',
      DB: noDatabase,
    }, { token, body: competitionFixture() });
    assert.equal(response.status, 401);
    assertCompetitionNoStore(response);
    assert.deepEqual(await response.json(), { error: '인증이 필요합니다.' });
  }
  const unrelatedToken = await competitionRequest({
    ALLOWED_ORIGIN: 'https://example.test',
    COMPETITION_INGEST_TOKEN: '',
    USAGE_INGEST_TOKEN: 'competition-token',
    HARNESS_INGEST_TOKEN: 'competition-token',
    DB: noDatabase,
  }, { body: competitionFixture() });
  assert.equal(unrelatedToken.status, 401);
  assertCompetitionNoStore(unrelatedToken);

  const anonymous = await worker.fetch(new Request('https://api.test/api/competitions'), {
    ALLOWED_ORIGIN: 'https://example.test',
  });
  assert.equal(anonymous.status, 401);
  assertCompetitionNoStore(anonymous);
  assert.deepEqual(await anonymous.json(), { error: '로그인이 필요합니다.' });

  const nonOwnerDb = {
    prepare(sql) {
      if (sql.includes('SELECT s.*, u.username')) {
        return {
          bind() {
            return {
              async first() {
                return { token_hash: 'student-hash', role: 'user', disabled: 0, username: 'student' };
              },
            };
          },
        };
      }
      if (sql.includes('UPDATE sessions')) {
        return { bind() { return { async run() { return { success: true }; } }; } };
      }
      throw new Error('non-owner reached competition data');
    },
  };
  const nonOwner = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer student-token' },
  }), {
    ALLOWED_ORIGIN: 'https://example.test',
    OWNER_USERNAME: 'hvsdcm',
    DB: nonOwnerDb,
  });
  assert.equal(nonOwner.status, 404);
  assertCompetitionNoStore(nonOwner);
  assert.deepEqual(await nonOwner.json(), { error: 'Not found' });
});

test('checked-in reporter fixture is accepted by the Worker competition contract', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const fixture = setCompetitionTimeline(
    structuredClone(COMPETITION_REPORTER_FIXTURE),
    Math.max(
      Date.parse(`${competitionKstDate(Date.now())}T00:00:00+09:00`),
      Date.now() - 10 * 60_000,
    ),
  );
  const response = await competitionRequest(context.env, { body: fixture });
  assert.equal(response.status, 201);
  assertCompetitionNoStore(response);
  assert.deepEqual(await response.json(), {
    ok: true,
    version: 1,
    idempotency_key: fixture.idempotency_key,
    run_id: fixture.run.id,
    replayed: false,
    counts: { sources: 1, candidates: 1, applications: 1 },
  });
});

test('competition report round-trips through normalized SQLite and exact replay adds no rows', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const fixture = competitionFixture();
  const created = await competitionRequest(env, { body: fixture });
  assert.equal(created.status, 201);
  assertCompetitionNoStore(created);
  assert.deepEqual(await created.json(), {
    ok: true,
    version: 1,
    idempotency_key: fixture.idempotency_key,
    run_id: fixture.run.id,
    replayed: false,
    counts: { sources: 1, candidates: 1, applications: 1 },
  });

  const replay = await competitionRequest(env, { body: structuredClone(fixture) });
  assert.equal(replay.status, 200);
  assertCompetitionNoStore(replay);
  assert.equal((await replay.json()).replayed, true);
  for (const table of [
    'competition_reports', 'competition_sources', 'competition_candidates',
    'competition_applications',
  ]) {
    assert.equal(Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count), 1);
  }

  const looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(looked.status, 200);
  assertCompetitionNoStore(looked);
  const body = await looked.json();
  assert.deepEqual(Object.keys(body), ['summary', 'runs', 'sources', 'candidates', 'applications']);
  assert.deepEqual(body.summary, {
    latest_scan_at: fixture.run.finished_at,
    partial: false,
    today: {
      discovered: 1,
      verified: 1,
      ready: 1,
      awaiting_approval: 0,
      deadline_soon: 1,
    },
  });
  assert.deepEqual(body.runs, [{
    id: fixture.run.id,
    date: fixture.run.date,
    started_at: fixture.run.started_at,
    finished_at: fixture.run.finished_at,
    status: 'complete',
    source_coverage: { expected: 1, checked: 1, succeeded: 1 },
  }]);
  assert.deepEqual(body.sources, [{
    id: 'contest-listing',
    kind: 'listing',
    name: 'Contest Listing',
    reference_url: 'https://list.example/contests/123',
    status: 'ok',
    checked_at: fixture.sources[0].checked_at,
    candidate_count: 1,
    failure_code: 'none',
    manual_check: false,
  }]);
  assert.deepEqual(body.candidates, [{
    contest_id: 'organizer-2026-image',
    category: 'image',
    title: 'Example Image Contest',
    organizer: 'Example Organizer',
    source_id: 'contest-listing',
    discovery_url: 'https://list.example/contests/123',
    discovered_at: fixture.candidates[0].discovered_at,
    recency: 'new',
    official_url: 'https://organizer.example/rules',
    official_verification: 'verified',
    official_verified_at: fixture.candidates[0].official_verified_at,
    acceptance: 'open',
    deadline_at: fixture.candidates[0].deadline_at,
    eligibility: 'eligible',
    fee_status: 'free',
    participation_mode: 'none',
    status: 'active',
    rights_risk: 'low',
    submission_risk: 'low',
    fit_score: 80,
    effort_score: 20,
  }]);
  assert.deepEqual(body.applications, [{
    contest_id: 'organizer-2026-image',
    category: 'image',
    state: 'WAITING_ARTIFACTS',
    updated_at: fixture.applications[0].updated_at,
    blocker: 'artifacts',
    next_action: 'prepare_artifacts',
    approval: null,
  }]);
  assert.throws(
    () => database.prepare("UPDATE competition_reports SET run_status = 'failed'").run(),
    /immutable/u,
  );
});

test('competition web approval is owner-only, action-bound, idempotent and durable', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const fixture = competitionWithPreparationApproval();
  const created = await competitionRequest(env, { body: fixture });
  assert.equal(created.status, 201);

  const before = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(before.status, 200);
  const beforeBody = await before.json();
  assert.equal(beforeBody.summary.today.awaiting_approval, 1);
  assert.deepEqual(beforeBody.applications[0].approval, {
    request_id: fixture.approvals[0].request_id,
    kind: 'preparation',
    action_sha256: 'a'.repeat(64),
    requested_at: fixture.approvals[0].requested_at,
    expires_at: null,
    read_summary: fixture.approvals[0].read_summary,
    approval_text: fixture.approvals[0].approval_text,
    status: 'pending',
    decided_at: null,
  });

  const anonymous = await competitionApprovalRequest(env, { token: '' });
  assert.equal(anonymous.status, 401);
  assertCompetitionNoStore(anonymous);
  const nonOwner = await competitionApprovalRequest(env, { token: 'student-token' });
  assert.equal(nonOwner.status, 404);
  assertCompetitionNoStore(nonOwner);

  const stale = await competitionApprovalRequest(env, {
    body: { decision: 'approved', action_sha256: 'b'.repeat(64) },
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'approval_stale' });

  const approved = await competitionApprovalRequest(env);
  assert.equal(approved.status, 201);
  assertCompetitionNoStore(approved);
  assert.equal((await approved.json()).replayed, false);
  const replay = await competitionApprovalRequest(env);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  const conflict = await competitionApprovalRequest(env, {
    body: { decision: 'held', action_sha256: 'a'.repeat(64) },
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'approval_conflict' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_decisions',
  ).get().count), 1);

  const after = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(after.status, 200);
  const afterBody = await after.json();
  assert.equal(afterBody.summary.today.awaiting_approval, 0);
  assert.equal(afterBody.applications[0].approval.status, 'approved');
  assert.ok(afterBody.applications[0].approval.decided_at);
});

test('competition runtime fails closed for legacy unknown preferences and expired deadlines', async (t) => {
  const legacyContext = await competitionTestContext(t);
  if (!legacyContext) return;
  const legacy = competitionWithPreparationApproval();
  assert.equal((await competitionRequest(legacyContext.env, { body: legacy })).status, 201);

  // Simulate an active row written before 0018: ALTER TABLE supplies unknown while the old row
  // retains its legacy active/application/approval state.
  legacyContext.database.exec('DROP TRIGGER competition_candidates_no_update');
  legacyContext.database.prepare(`
    UPDATE competition_candidates SET fee_status = 'unknown'
    WHERE idempotency_key = ? AND contest_id = ? AND category = ?
  `).run(legacy.idempotency_key, legacy.candidates[0].contest_id, legacy.candidates[0].category);

  const lookup = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), legacyContext.env);
  assert.equal(lookup.status, 200);
  const payload = await lookup.json();
  assert.equal(payload.candidates[0].status, 'deferred');
  assert.equal(payload.applications[0].state, 'WAITING_CLARIFICATION');
  assert.equal(payload.applications[0].approval, null);
  assert.equal(payload.summary.today.ready, 0);
  assert.equal(payload.summary.today.awaiting_approval, 0);
  const staleDecision = await competitionApprovalRequest(legacyContext.env);
  assert.equal(staleDecision.status, 409);
  assert.deepEqual(await staleDecision.json(), { error: 'approval_stale' });
  assert.equal(Number(legacyContext.database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_decisions',
  ).get().count), 0);

  const deadlineContext = await competitionTestContext(t);
  if (!deadlineContext) return;
  const expired = competitionWithPreparationApproval();
  expired.idempotency_key = 'competition-action-deadline-expired';
  expired.run.id = expired.idempotency_key;
  expired.candidates[0].deadline_at = new Date(Date.now() - 1_000).toISOString();
  assert.ok(Date.parse(expired.candidates[0].deadline_at) > Date.parse(expired.run.finished_at));
  assert.equal((await competitionRequest(deadlineContext.env, { body: expired })).status, 201);
  const expiredDecision = await competitionApprovalRequest(deadlineContext.env);
  assert.equal(expiredDecision.status, 409);
  assert.deepEqual(await expiredDecision.json(), { error: 'approval_stale' });
});

test('competition database rejects paid and offline active candidates before application insertion', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const fixture = competitionFixture();
  fixture.applications = [];
  assert.equal((await competitionRequest(context.env, { body: fixture })).status, 201);
  const insert = context.database.prepare(`
    INSERT INTO competition_candidates(
      idempotency_key, contest_id, category, title, organizer, source_id,
      discovery_url, discovered_at, recency, official_url, official_verification,
      official_verified_at, acceptance, deadline_at, eligibility, fee_status,
      participation_mode, rights_risk, submission_risk, status, fit_score, effort_score
    ) VALUES (?, ?, 'image', 'Preference probe', 'Example Organizer', 'contest-listing',
      'https://list.example/contests/probe', ?, 'new', 'https://organizer.example/rules/probe',
      'verified', ?, 'open', ?, 'eligible', ?, ?, 'low', 'low', 'active', 80, 20)
  `);
  for (const [id, feeStatus, participationMode] of [
    ['paid-active', 'paid', 'none'],
    ['offline-active', 'free', 'offline_required'],
  ]) {
    assert.throws(() => insert.run(
      fixture.idempotency_key,
      id,
      fixture.candidates[0].discovered_at,
      fixture.candidates[0].official_verified_at,
      fixture.candidates[0].deadline_at,
      feeStatus,
      participationMode,
    ), /active competition requires free remote-compatible participation/u);
  }
});

test('competition approval survives a newer snapshot while raw state regression and request rebinding fail', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const first = competitionWithPreparationApproval();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const approved = await competitionApprovalRequest(env);
  assert.equal(approved.status, 201);

  const carried = structuredClone(first);
  carried.idempotency_key = 'competition-carried-approval-request';
  carried.run.id = 'competition-carried-approval-request';
  carried.run.finished_at = new Date(Date.parse(first.run.finished_at) + 1_000).toISOString();
  assert.equal((await competitionRequest(env, { body: carried })).status, 201);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_requests',
  ).get().count), 1, 'one immutable action is reused');
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_report_approval_requests',
  ).get().count), 2, 'both immutable reports link the same action');
  const looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(looked.status, 200);
  assert.equal((await looked.json()).applications[0].approval.status, 'approved');

  const newer = competitionFixture();
  setCompetitionTimeline(newer, Date.parse(carried.run.started_at) + 2_000);
  newer.idempotency_key = 'competition-newer-without-old-approval';
  newer.run.id = 'competition-newer-without-old-approval';
  const regression = await competitionRequest(env, { body: newer });
  assert.equal(regression.status, 409);
  assert.deepEqual(await regression.json(), { error: 'report_state_regression' });

  const rebound = competitionWithPreparationApproval();
  setCompetitionTimeline(rebound, Date.parse(carried.run.started_at) + 3_000);
  rebound.idempotency_key = 'competition-rebound-approval-request';
  rebound.run.id = 'competition-rebound-approval-request';
  rebound.approvals[0].action_sha256 = 'b'.repeat(64);
  const collision = await competitionRequest(env, { body: rebound });
  assert.equal(collision.status, 409);
  assert.deepEqual(await collision.json(), { error: 'approval_request_conflict' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_reports',
  ).get().count), 2, 'only the original and safely carried snapshots exist');
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_requests',
  ).get().count), 1);

  const reworded = structuredClone(carried);
  reworded.idempotency_key = 'competition-reworded-approval-request';
  reworded.run.id = 'competition-reworded-approval-request';
  reworded.run.finished_at = new Date(Date.parse(carried.run.finished_at) + 4_000).toISOString();
  reworded.approvals[0].approval_text += ' 변경된 문구';
  const wordingCollision = await competitionRequest(env, { body: reworded });
  assert.equal(wordingCollision.status, 409);
  assert.deepEqual(await wordingCollision.json(), { error: 'approval_request_conflict' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_reports',
  ).get().count), 2, 'the same request id cannot be rebound by changing only its wording');
});

test('competition approval transitions preserve exact decisions without freezing later workflow', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const first = competitionWithPreparationApproval();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const replacement = structuredClone(first);
  setCompetitionTimeline(replacement, Date.parse(first.run.started_at) + 10_000);
  replacement.idempotency_key = 'competition-replacement-approval-request';
  replacement.run.id = 'competition-replacement-approval-request';
  replacement.approvals[0].request_id = 'competition-preparation-organizer-2026-image-v2';
  replacement.approvals[0].action_sha256 = 'c'.repeat(64);
  replacement.approvals[0].approval_text += ' 새 조건을 다시 확인합니다.';
  assert.equal((await competitionRequest(env, { body: replacement })).status, 201);
  let looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(looked.status, 200);
  let body = await looked.json();
  assert.equal(body.applications[0].approval.request_id, replacement.approvals[0].request_id);
  assert.equal(body.applications[0].approval.status, 'pending', 'changed action never reuses a decision');

  const approved = await competitionApprovalRequest(env, {
    requestId: replacement.approvals[0].request_id,
    body: { decision: 'approved', action_sha256: 'c'.repeat(64) },
  });
  assert.equal(approved.status, 201);

  const unauthorized = structuredClone(replacement);
  setCompetitionTimeline(unauthorized, Date.parse(replacement.run.started_at) + 10_000);
  unauthorized.idempotency_key = 'competition-preparation-cannot-authorize-submission';
  unauthorized.run.id = 'competition-preparation-cannot-authorize-submission';
  unauthorized.applications[0].state = 'AUTHORIZED';
  unauthorized.applications[0].blocker = 'none';
  unauthorized.applications[0].next_action = 'none';
  unauthorized.approvals = [];
  const unauthorizedResponse = await competitionRequest(env, { body: unauthorized });
  assert.equal(unauthorizedResponse.status, 409);
  assert.deepEqual(await unauthorizedResponse.json(), { error: 'report_state_regression' });

  const premature = structuredClone(replacement);
  setCompetitionTimeline(premature, Date.parse(replacement.run.started_at) + 10_000);
  premature.idempotency_key = 'competition-approved-preparation-predated';
  premature.run.id = 'competition-approved-preparation-predated';
  premature.applications[0].state = 'PREPARED';
  premature.applications[0].blocker = 'none';
  premature.applications[0].next_action = 'draft_application';
  premature.approvals = [];
  const prematureResponse = await competitionRequest(env, { body: premature });
  assert.equal(prematureResponse.status, 409);
  assert.deepEqual(await prematureResponse.json(), { error: 'report_state_regression' });

  const progressed = structuredClone(replacement);
  setCompetitionTimeline(progressed, Date.now());
  progressed.idempotency_key = 'competition-approved-preparation-progressed';
  progressed.run.id = 'competition-approved-preparation-progressed';
  progressed.applications[0].state = 'PREPARED';
  progressed.applications[0].blocker = 'none';
  progressed.applications[0].next_action = 'draft_application';
  progressed.approvals = [];
  assert.equal((await competitionRequest(env, { body: progressed })).status, 201);
  looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  body = await looked.json();
  assert.equal(body.applications[0].state, 'PREPARED');
  assert.equal(body.applications[0].approval, null);

  const heldContext = await competitionTestContext(t);
  if (!heldContext) return;
  const heldFirst = competitionWithPreparationApproval();
  assert.equal((await competitionRequest(heldContext.env, { body: heldFirst })).status, 201);
  assert.equal((await competitionApprovalRequest(heldContext.env, {
    body: { decision: 'held', action_sha256: 'a'.repeat(64) },
  })).status, 201);
  const bypass = structuredClone(heldFirst);
  setCompetitionTimeline(bypass, Date.parse(heldFirst.run.started_at) + 10_000);
  bypass.idempotency_key = 'competition-held-preparation-bypass';
  bypass.run.id = 'competition-held-preparation-bypass';
  bypass.applications[0].state = 'PREPARED';
  bypass.applications[0].blocker = 'none';
  bypass.applications[0].next_action = 'draft_application';
  bypass.approvals = [];
  const rejected = await competitionRequest(heldContext.env, { body: bypass });
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { error: 'report_state_regression' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_reports',
  ).get().count), 3);
});

test('competition report guard rejects a same-time official fact rewrite atomically', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const first = competitionFixture();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const rewritten = structuredClone(first);
  rewritten.idempotency_key = 'competition-same-time-official-rewrite';
  rewritten.run.id = 'competition-same-time-official-rewrite';
  rewritten.run.finished_at = new Date(Date.parse(first.run.finished_at) + 1_000).toISOString();
  rewritten.candidates[0].organizer = 'Rewritten Organizer';
  const response = await competitionRequest(env, { body: rewritten });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'report_state_regression' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_reports',
  ).get().count), 1);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_report_guards',
  ).get().count), 1);
});

test('competition report guard rolls back a writer whose expected prior changed', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const first = competitionFixture();
  assert.equal((await competitionRequest(env, { body: first })).status, 201);

  const winner = structuredClone(first);
  winner.idempotency_key = 'competition-concurrent-winner';
  winner.run.id = 'competition-concurrent-winner';
  winner.run.finished_at = new Date(Date.parse(first.run.finished_at) + 1_000).toISOString();
  const loser = structuredClone(first);
  loser.idempotency_key = 'competition-concurrent-loser';
  loser.run.id = 'competition-concurrent-loser';
  loser.run.finished_at = new Date(Date.parse(first.run.finished_at) + 2_000).toISOString();

  let injected = false;
  const racingEnv = {
    ...env,
    DB: {
      prepare(sql) { return env.DB.prepare(sql); },
      async batch(statements) {
        if (!injected) {
          injected = true;
          const winningResponse = await competitionRequest(env, { body: winner });
          assert.equal(winningResponse.status, 201);
        }
        return env.DB.batch(statements);
      },
    },
  };
  const response = await competitionRequest(racingEnv, { body: loser });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'report_concurrent_conflict' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_reports',
  ).get().count), 2, 'the stale writer batch is fully rolled back');
  assert.equal(Number(database.prepare(
    "SELECT COUNT(*) AS count FROM competition_reports WHERE idempotency_key = 'competition-concurrent-loser'",
  ).get().count), 0);
});

test('competition approval expiry is checked by the same SQLite clock that stores the decision', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const fixture = competitionWithPreparationApproval();
  fixture.idempotency_key = 'competition-expiry-at-write';
  fixture.run.id = 'competition-expiry-at-write';
  fixture.applications[0].state = 'WAITING_APPROVAL';
  fixture.applications[0].blocker = 'user_approval';
  fixture.applications[0].next_action = 'request_approval';
  fixture.approvals[0].kind = 'final_submission';
  fixture.approvals[0].expires_at = new Date(Date.now() + 500).toISOString();
  assert.equal((await competitionRequest(env, { body: fixture })).status, 201);

  const delayedDb = {
    ...env.DB,
    prepare(sql) {
      const prepared = env.DB.prepare(sql);
      if (!sql.includes('INSERT INTO competition_approval_decisions')) return prepared;
      const delayRun = (statement) => ({
        bind(...values) { return delayRun(statement.bind(...values)); },
        first() { return statement.first(); },
        all() { return statement.all(); },
        async run() {
          await new Promise((resolve) => setTimeout(resolve, 650));
          return statement.run();
        },
      });
      return delayRun(prepared);
    },
  };
  const expired = await competitionApprovalRequest({ ...env, DB: delayedDb });
  assert.equal(expired.status, 409);
  assert.deepEqual(await expired.json(), { error: 'approval_expired' });
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_decisions',
  ).get().count), 0);
});

test('competition approval report rejects state mismatch and stale sensitive windows', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;

  const mismatched = competitionWithPreparationApproval();
  mismatched.idempotency_key = 'competition-approval-state-mismatch';
  mismatched.run.id = 'competition-approval-state-mismatch';
  mismatched.applications[0].state = 'WAITING_ARTIFACTS';
  const mismatchResponse = await competitionRequest(env, { body: mismatched });
  assert.equal(mismatchResponse.status, 400);

  const expired = competitionWithPreparationApproval();
  expired.idempotency_key = 'competition-expired-final-approval';
  expired.run.id = 'competition-expired-final-approval';
  expired.applications[0].state = 'WAITING_APPROVAL';
  expired.applications[0].blocker = 'user_approval';
  expired.applications[0].next_action = 'request_approval';
  expired.approvals[0].kind = 'final_submission';
  expired.approvals[0].requested_at = new Date(
    Date.parse(expired.run.finished_at) - 10 * 60_000,
  ).toISOString();
  expired.approvals[0].expires_at = new Date(
    Date.parse(expired.run.finished_at) - 60_000,
  ).toISOString();
  const expiredResponse = await competitionRequest(env, { body: expired });
  assert.equal(expiredResponse.status, 400);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_approval_requests',
  ).get().count), 0);
});

test('competition idempotency binds the key to one payload and concurrent conflict cannot mix children', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const left = competitionFixture();
  const right = structuredClone(left);
  right.candidates[0].title = 'Different Contest Title';
  const responses = await Promise.all([
    competitionRequest(env, { body: left }),
    competitionRequest(env, { body: right }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const conflict = responses.find((response) => response.status === 409);
  assertCompetitionNoStore(conflict);
  assert.deepEqual(await conflict.json(), { error: 'idempotency_conflict' });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 1);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_candidates').get().count), 1);
  const storedTitle = database.prepare('SELECT title FROM competition_candidates').get().title;
  assert.ok(['Example Image Contest', 'Different Contest Title'].includes(storedTitle));
  const storedHash = database.prepare('SELECT payload_hash FROM competition_reports').get().payload_hash;
  assert.match(storedHash, /^[a-f0-9]{64}$/u);
});

test('competition idempotency preserves raw field values across storage normalization', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const first = competitionFixture();
  first.idempotency_key = 'competition-raw-value-idempotency';
  first.run.id = 'competition-raw-value-idempotency';
  first.candidates[0].title = 'Example  Image Contest';
  const second = structuredClone(first);
  second.candidates[0].title = 'Example Image Contest';

  const created = await competitionRequest(context.env, { body: first });
  assert.equal(created.status, 201);
  const conflict = await competitionRequest(context.env, { body: second });
  assert.equal(conflict.status, 409);
  assertCompetitionNoStore(conflict);
  assert.deepEqual(await conflict.json(), { error: 'idempotency_conflict' });
});

test('competition cross-object trust probes fail closed without writing any report rows', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const probes = [
    ['expired-active', (body) => {
      body.candidates[0].deadline_at = body.run.finished_at;
    }],
    ['timeout-closed', (body) => {
      body.run.status = 'partial';
      body.run.source_coverage.succeeded = 0;
      body.sources[0].status = 'partial';
      body.sources[0].failure_code = 'timeout';
      body.sources[0].manual_check = true;
      body.candidates[0].status = 'rejected';
      body.candidates[0].acceptance = 'closed';
      body.applications = [];
    }],
    ['no-results-with-candidate', (body) => {
      body.sources[0].status = 'no_results';
    }],
    ['rejected-with-application', (body) => {
      body.candidates[0].status = 'rejected';
    }],
    ['verified-placeholder-organizer', (body) => {
      body.candidates[0].organizer = '주최 기관 - 공식 확인 필요';
    }],
  ];
  for (const [name, mutate] of probes) {
    const body = competitionFixture();
    body.idempotency_key = `competition-probe-${name}`;
    body.run.id = `competition-probe-${name}`;
    mutate(body);
    const response = await competitionRequest(env, { body });
    assert.equal(response.status, 400, name);
    assertCompetitionNoStore(response);
    assert.deepEqual(await response.json(), { error: 'invalid_report' }, name);
    assert.equal(
      Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count),
      0,
      name,
    );
  }
});

test('competition identifier slots reject private contact values without writes', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const probes = [
    ['idempotency', (body) => { body.idempotency_key = '01012345678'; }],
    ['run', (body) => { body.run.id = '0212345678'; }],
    ['source', (body) => {
      body.sources[0].id = '01012345678';
      body.candidates[0].source_id = '01012345678';
    }],
    ['contest', (body) => {
      body.candidates[0].contest_id = '01012345678';
      body.applications[0].contest_id = '01012345678';
    }],
    ['category', (body) => {
      body.candidates[0].category = '0212345678';
      body.applications[0].category = '0212345678';
    }],
  ];
  for (const [name, mutate] of probes) {
    const body = competitionFixture();
    body.idempotency_key = `competition-private-id-${name}`;
    body.run.id = `competition-private-id-${name}`;
    mutate(body);
    const response = await competitionRequest(env, { body });
    assert.equal(response.status, 400, name);
  }
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);
});

test('competition ingest rejects its exact active secret anywhere in the payload', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const body = competitionFixture();
  body.idempotency_key = 'competition-active-secret-payload';
  body.run.id = body.idempotency_key;
  body.candidates[0].organizer = env.COMPETITION_INGEST_TOKEN;
  const response = await competitionRequest(env, {
    body,
    token: env.COMPETITION_INGEST_TOKEN,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'forbidden_data' });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);
});

test('competition ingest rejects its fully percent-encoded active secret without writes', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  env.COMPETITION_INGEST_TOKEN = 'opaque-active-ingest-value-123456789';
  const encodedToken = [...Buffer.from(env.COMPETITION_INGEST_TOKEN, 'utf8')]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .join('');
  const body = competitionFixture();
  body.idempotency_key = 'competition-encoded-active-secret';
  body.run.id = body.idempotency_key;
  body.candidates[0].official_url = `https://organizer.example/${encodedToken}/rules`;
  const response = await competitionRequest(env, {
    body,
    token: env.COMPETITION_INGEST_TOKEN,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'forbidden_data' });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);
});

test('competition capacity migration preserves immutable rows, constraints, and indexes', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }
  if (!DatabaseSync) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(readFileSync(new URL('./migrations/0014_competitions.sql', import.meta.url), 'utf8'));
  database.prepare(`
    INSERT INTO competition_reports(
      idempotency_key, payload_hash, schema_version, received_at, run_id, run_date,
      run_status, started_at, finished_at, coverage_expected, coverage_checked,
      coverage_succeeded, source_count, candidate_count, application_count
    ) VALUES (?, ?, 1, ?, ?, ?, 'complete', ?, ?, 1, 1, 1, 1, 1, 0)
  `).run(
    'capacity-existing', 'a'.repeat(64), '2026-08-31T00:02:00.000Z',
    'capacity-existing', '2026-08-31', '2026-08-31T00:00:00.000Z',
    '2026-08-31T00:01:00.000Z',
  );
  database.prepare(`
    INSERT INTO competition_sources(
      idempotency_key, source_id, kind, name, reference_url, checked_at,
      status, failure_code, manual_check, candidate_count
    ) VALUES ('capacity-existing', 'source', 'listing', 'Source',
      'https://list.example/contests', '2026-08-31T00:00:30.000Z',
      'ok', 'none', 0, 1)
  `).run();
  database.prepare(`
    INSERT INTO competition_candidates(
      idempotency_key, contest_id, category, title, organizer, source_id,
      discovery_url, discovered_at, recency, official_url, official_verification,
      official_verified_at, acceptance, deadline_at, eligibility, rights_risk,
      submission_risk, status, fit_score, effort_score
    ) VALUES ('capacity-existing', 'contest', 'idea', 'Existing Contest', 'Organizer',
      'source', 'https://list.example/contests/1', '2026-08-31T00:00:30.000Z',
      'new', NULL, 'unverified', NULL, 'unknown', NULL, 'unknown', 'unknown',
      'unknown', 'verifying', 50, 50)
  `).run();

  database.exec(readFileSync(
    new URL('./migrations/0015_competition_candidate_capacity.sql', import.meta.url),
    'utf8',
  ));
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_reports',
  ).get().count), 1);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_sources',
  ).get().count), 1);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_candidates',
  ).get().count), 1);
  const capacityTables = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name IN ('competition_reports', 'competition_sources')
  `).all();
  assert.equal(capacityTables.length, 2);
  assert.ok(capacityTables.every((entry) => (
    entry.sql.includes('candidate_count BETWEEN 0 AND 500')
  )));
  assert.throws(
    () => database.prepare("UPDATE competition_reports SET run_status = 'failed'").run(),
    /competition reports are immutable/u,
  );
});

test('competition accepts and exactly replays the full 500-candidate contract', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const body = competitionFixture();
  body.idempotency_key = 'competition-capacity-500';
  body.run.id = body.idempotency_key;
  body.sources[0].candidate_count = 500;
  body.applications = [];
  body.candidates = Array.from({ length: 500 }, (_, index) => ({
    ...body.candidates[0],
    contest_id: `capacity-contest-${index}`,
    title: `Capacity Contest ${index}`,
    official_url: null,
    official_verification: 'unverified',
    official_verified_at: null,
    acceptance: 'unknown',
    deadline_at: null,
    eligibility: 'unknown',
    rights_risk: 'unknown',
    submission_risk: 'unknown',
    status: 'verifying',
  }));
  const created = await competitionRequest(env, { body });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).counts, {
    sources: 1,
    candidates: 500,
    applications: 0,
  });
  const replay = await competitionRequest(env, { body: structuredClone(body) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(Number(database.prepare(
    'SELECT candidate_count FROM competition_reports WHERE idempotency_key = ?',
  ).get(body.idempotency_key).candidate_count), 500);
  assert.equal(Number(database.prepare(
    'SELECT candidate_count FROM competition_sources WHERE idempotency_key = ?',
  ).get(body.idempotency_key).candidate_count), 500);
  assert.equal(Number(database.prepare(
    'SELECT COUNT(*) AS count FROM competition_candidates WHERE idempotency_key = ?',
  ).get(body.idempotency_key).count), 500);
});

test('competition migration rejects malformed timestamps in every normalized table', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database } = context;
  const canonical = '2026-08-31T00:00:00.000Z';
  const malformed = 'xxxx-xx-xxTxx:xx:xx.xxxZ';
  const reportInsert = database.prepare(`
    INSERT INTO competition_reports(
      idempotency_key, payload_hash, schema_version, received_at,
      run_id, run_date, run_status, started_at, finished_at,
      coverage_expected, coverage_checked, coverage_succeeded,
      source_count, candidate_count, application_count
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?, ?)
  `);
  const insertReport = ({
    key, receivedAt = canonical, runDate = '2026-08-31', startedAt = canonical,
    finishedAt = '2026-08-31T00:05:00.000Z', status = 'complete',
    candidateCount = 0, applicationCount = 0,
  }) => reportInsert.run(
    key, 'a'.repeat(64), receivedAt, key, runDate, status, startedAt, finishedAt,
    candidateCount, applicationCount,
  );
  const invalidReports = [
    { key: 'bad-received-at', receivedAt: malformed },
    { key: 'bad-received-hour', receivedAt: '2026-09-01T24:00:00.000Z' },
    { key: 'bad-run-date', runDate: 'xxxx-xx-xx' },
    { key: 'bad-started-at', startedAt: malformed },
    { key: 'bad-started-hour', startedAt: '2026-08-31T24:00:00.000Z' },
    { key: 'bad-finished-at', finishedAt: '2026-08-31T00:05:xx.xxxZ' },
    { key: 'bad-finished-hour', finishedAt: '2026-08-31T24:00:00.000Z' },
  ];
  for (const probe of invalidReports) {
    assert.throws(() => insertReport(probe), /CHECK constraint failed/u, probe.key);
  }

  insertReport({ key: 'timestamp-parent', candidateCount: 1, applicationCount: 1 });
  const sourceInsert = database.prepare(`
    INSERT INTO competition_sources(
      idempotency_key, source_id, kind, name, reference_url, checked_at,
      status, failure_code, manual_check, candidate_count
    ) VALUES ('timestamp-parent', ?, 'listing', 'Public listing',
      'https://public.example/contests', ?, 'ok', 'none', 0, 1)
  `);
  assert.throws(
    () => sourceInsert.run('bad-source-time', '2026-08-31T00:01:xx.xxxZ'),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => sourceInsert.run('bad-source-hour', '2026-08-30T24:01:00.000Z'),
    /CHECK constraint failed/u,
  );
  sourceInsert.run('timestamp-source', '2026-08-31T00:01:00.000Z');

  const candidateInsert = database.prepare(`
    INSERT INTO competition_candidates(
      idempotency_key, contest_id, category, title, organizer, source_id,
      discovery_url, discovered_at, recency, official_url, official_verification,
      official_verified_at, acceptance, deadline_at, eligibility, fee_status,
      participation_mode, rights_risk, submission_risk, status, fit_score, effort_score
    ) VALUES ('timestamp-parent', ?, 'test', 'Public contest', 'Public organizer',
      'timestamp-source', 'https://public.example/contest', ?, 'new', ?, ?, ?, ?, ?, ?,
      'free', 'none', 'low', 'low', ?, 50, 50)
  `);
  const insertCandidate = ({
    id, discoveredAt = '2026-08-31T00:01:00.000Z', officialUrl = null,
    verification = 'unverified', verifiedAt = null, acceptance = 'unknown',
    deadlineAt = null, eligibility = 'unknown', status = 'discovered',
  }) => candidateInsert.run(
    id, discoveredAt, officialUrl, verification, verifiedAt, acceptance, deadlineAt,
    eligibility, status,
  );
  assert.throws(
    () => insertCandidate({ id: 'bad-discovered', discoveredAt: '2026-08-31T00:01:xx.xxxZ' }),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => insertCandidate({ id: 'bad-discovered-hour', discoveredAt: '2026-08-30T24:01:00.000Z' }),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => insertCandidate({
      id: 'bad-verified',
      officialUrl: 'https://official.example/rules',
      verification: 'verified',
      verifiedAt: '2026-08-31T00:02:xx.xxxZ',
    }),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => insertCandidate({
      id: 'bad-verified-hour',
      discoveredAt: '2026-08-30T23:00:00.000Z',
      officialUrl: 'https://official.example/rules',
      verification: 'verified',
      verifiedAt: '2026-08-30T24:01:00.000Z',
    }),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => insertCandidate({ id: 'bad-deadline', deadlineAt: '2026-09-03T14:59:xx.xxxZ' }),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () => insertCandidate({ id: 'bad-deadline-hour', deadlineAt: '2026-09-03T24:00:00.000Z' }),
    /CHECK constraint failed/u,
  );
  insertCandidate({
    id: 'timestamp-candidate',
    discoveredAt: '2026-08-30T23:00:00.000Z',
    officialUrl: 'https://official.example/rules',
    verification: 'verified',
    verifiedAt: '2026-08-30T23:30:00.000Z',
    acceptance: 'open',
    deadlineAt: '2026-09-03T14:59:00.000Z',
    eligibility: 'eligible',
    status: 'active',
  });

  assert.throws(() => database.prepare(`
    INSERT INTO competition_applications(
      idempotency_key, contest_id, category, profile_id, state, blocker, next_action, updated_at
    ) VALUES ('timestamp-parent', 'timestamp-candidate', 'test', ?,
      'WAITING_ARTIFACTS', 'artifacts', 'prepare_artifacts', '2026-08-31T00:04:xx.xxxZ')
  `).run(COMPETITION_PROFILE_ID), /CHECK constraint failed/u);
  assert.throws(() => database.prepare(`
    INSERT INTO competition_applications(
      idempotency_key, contest_id, category, profile_id, state, blocker, next_action, updated_at
    ) VALUES ('timestamp-parent', 'timestamp-candidate', 'test', ?,
      'WAITING_ARTIFACTS', 'artifacts', 'prepare_artifacts', '2026-08-30T24:01:00.000Z')
  `).run(COMPETITION_PROFILE_ID), /CHECK constraint failed/u);
});

test('competition URLs reject decoded PII, private-token aliases, and trailing-dot local hosts', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const unsafeUrls = [
    'https://public.example/person@example.com/rules',
    'https://public.example/person%40example.com/rules',
    'https://public.example/person%2540example.com/rules',
    'https://public.example/010-1234-5678/rules',
    'https://public.example/%30%31%30%2D%31%32%33%34%2D%35%36%37%38/rules',
    'https://public.example/01012345678/rules',
    'https://public.example/%30%31%30%31%32%33%34%35%36%37%38/rules',
    'https://public.example/0212345678/rules',
    'https://public.example/rules?email=person@example.com',
    'https://public.example/rules?person=person%2540example.com',
    'https://public.example/rules?access_token=privatevalue123',
    'https://public.example/rules?access%255Ftoken=privatevalue123',
    'https://public.example/rules?client_secret=privatevalue123',
    'https://public.example/rules?client-secret=privatevalue123',
    'https://public.example/rules?clientSecret=privatevalue123',
    'https://public.example/rules?client.secret=privatevalue123',
    'https://public.example/rules?CLIENT%255FSECRET=privatevalue123',
    'https://public.example/rules?refresh_token=privatevalue123',
    'https://public.example/rules?refreshToken=privatevalue123',
    'https://public.example/rules?authorization=privatevalue123',
    'https://public.example/rules?signature=privatevalue123',
    'https://public.example/private_key=privatevalue123/rules',
    'https://public.example/rules?auth_token=privatevalue123',
    'https://public.example/rules?session_id=privatevalue123',
    'https://public.example/rules?oauthCode=privatevalue123',
    'https://public.example/rules?x-amz-signature=privatevalue123',
    'https://public.example/access_token/privatevalue123/rules',
    'https://public.example/access%255Ftoken%252Fprivatevalue123/rules',
    'https://public.example/clientSecret/privatevalue123/rules',
    'https://public.example/client%255Fsecret%252Fprivatevalue123/rules',
    'https://public.example/authToken/privatevalue123/rules',
    'https://public.example/x-amz-signature/privatevalue123/rules',
    'https://public.example/(authorization=privatevalue123)/rules',
    'https://public.example/[client_secret=privatevalue123]/rules',
    'https://public.example/,refresh_token=privatevalue123/rules',
    'https://public.example/%28authorization%3Dprivatevalue123%29/rules',
    'https://public.example/%22authorization%22=%22privatevalue123%22/rules',
    'https://public.example/proxy_authorization=privatevalue123/rules',
    'https://public.example/api%20key=privatevalue123/rules',
    'https://public.example/(authorization!=privatevalue123)/rules',
    'https://public.example/[client_secret·=privatevalue123]/rules',
    'https://public.example/authorization！=privatevalue123/rules',
    'https://public.example/authori\u0301zation=privatevalue123/rules',
    'https://public.example/authori%CC%81zation=privatevalue123/rules',
    'https://public.example/person\u200B@example.com/rules',
    'https://public.example/person%E2%80%8B@example.com/rules',
    'https://public.example/perso\u0301n@example.com/rules',
    'https://public.example/%252528authorization%252521%25253Dprivatevalue123%252529/rules',
    'https://localhost./rules',
    'https://foo.local./rules',
    'https://[::ffff:127.0.0.1]/rules',
    'https://[::ffff:7f00:1]/rules',
    'https://[::ffff:a00:1]/rules',
    'https://[::ffff:169.254.169.254]/meta',
    'https://[64:ff9b::7f00:1]/rules',
    'https://public.example/rules/ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'https://public.example/rules?ref=glpat-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'https://public.example/rules?ref=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'https://public.example/rules/Bearer%20abcdefghijklmnopqrstuvwxyz123456',
    'https://public.example/rules?ref=Bearer%20abcdefghijklmnopqrstuvwxyz123456',
    'https://public.example/%3Cscript%3Ealert%281%29%3C%2Fscript%3E',
  ];
  const fields = [
    ['source.reference_url', (body, value) => { body.sources[0].reference_url = value; }],
    ['candidate.discovery_url', (body, value) => { body.candidates[0].discovery_url = value; }],
    ['candidate.official_url', (body, value) => { body.candidates[0].official_url = value; }],
  ];
  let caseNumber = 0;
  for (const [field, assign] of fields) {
    for (const value of unsafeUrls) {
      caseNumber += 1;
      const body = competitionFixture();
      body.idempotency_key = `competition-url-probe-${caseNumber}`;
      body.run.id = `competition-url-probe-${caseNumber}`;
      assign(body, value);
      const response = await competitionRequest(env, { body });
      assert.equal(response.status, 400, `${field}: ${value}`);
      assertCompetitionNoStore(response);
      assert.ok(
        ['invalid_report', 'forbidden_data'].includes((await response.json()).error),
        `${field}: ${value}`,
      );
    }
  }
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_sources').get().count), 0);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_candidates').get().count), 0);

  const numericContest = competitionFixture();
  numericContest.idempotency_key = 'competition-public-numeric-path';
  numericContest.run.id = 'competition-public-numeric-path';
  numericContest.sources[0].kind = 'official';
  numericContest.sources[0].reference_url = 'https://public.example/contests/20260831123';
  numericContest.candidates[0].discovery_url = 'https://public.example/entries/20260831123';
  numericContest.candidates[0].official_url = 'https://public.example/rules/20260831123';
  const accepted = await competitionRequest(env, { body: numericContest });
  assert.equal(accepted.status, 201);
  assertCompetitionNoStore(accepted);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 1);
});

test('competition free text rejects compact phones and secret assignments without writes', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const unsafeTexts = [
    '담당자 01012345678',
    'Contact 010 12345678',
    'Contact 010·1234·5678',
    'Contact 010​1234​5678',
    'Contact 010͏1234͏5678',
    'Contact 010️1234️5678',
    'Contact 010̸1234̸5678',
    'Contact 010́1234́5678',
    'Contact 0212345678',
    'Feed(authorization=privatevalue123)',
    '지원자 900101-1234567 아이디어 공모전',
    '지원자: 홍길동 아이디어 공모전',
    '신청자 성명=홍길동',
    '지원자 홍길동의 지원 결과',
    '주소 서울특별시 중구',
    '홍길동 900101 5234567',
    '<b>Example Contest</b>',
    '<script>alert(1)</script>기관',
    'Notice,client_secret=privatevalue123',
    'Agency[refresh_token=privatevalue123]',
    'Secret private_key=privatevalue123',
    'Encoded %28authorization%3Dprivatevalue123%29',
    'Quoted "authorization"="privatevalue123"',
    'Proxy proxy_authorization=privatevalue123',
    'Spaced api key=privatevalue123',
    'Punctuated authorization!=privatevalue123',
    'Middle dot client_secret·=privatevalue123',
    'Full width authorization！=privatevalue123',
    'Combining mark authori\u0301zation=privatevalue123',
    'Format mark person\u200B@example.com',
    'Combining mark perso\u0301n@example.com',
    '문의 %30%31%30%31%32%33%34%35%36%37%38',
  ];
  const fields = [
    ['source-name', (body, value) => { body.sources[0].name = value; }],
    ['candidate-title', (body, value) => { body.candidates[0].title = value; }],
    ['organizer', (body, value) => { body.candidates[0].organizer = value; }],
  ];
  let caseNumber = 0;
  for (const [field, assign] of fields) {
    for (const value of unsafeTexts) {
      caseNumber += 1;
      const body = competitionFixture();
      body.idempotency_key = `competition-private-text-${caseNumber}`;
      body.run.id = `competition-private-text-${caseNumber}`;
      assign(body, value);
      const response = await competitionRequest(env, { body });
      assert.equal(response.status, 400, `${field}: ${value}`);
      assertCompetitionNoStore(response);
      assert.deepEqual(await response.json(), { error: 'forbidden_data' }, `${field}: ${value}`);
      assert.equal(
        Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count),
        0,
        `${field}: ${value}`,
      );
    }
  }

  const publicNumber = competitionFixture();
  publicNumber.idempotency_key = 'competition-public-number-title';
  publicNumber.run.id = 'competition-public-number-title';
  publicNumber.candidates[0].title = 'Contest 20260831123';
  const accepted = await competitionRequest(env, { body: publicNumber });
  assert.equal(accepted.status, 201);
  assertCompetitionNoStore(accepted);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 1);
});

test('competition partial source keeps timeout and 403 evidence visibly separate from closed contests', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { env } = context;
  const fixture = competitionFixture();
  fixture.idempotency_key = 'competition-daily-2026-08-31-partial';
  fixture.run.id = 'competition-2026-08-31-partial';
  fixture.run.status = 'partial';
  fixture.run.source_coverage.succeeded = 0;
  fixture.sources[0].status = 'partial';
  fixture.sources[0].failure_code = 'http_403';
  fixture.sources[0].manual_check = true;
  fixture.sources[0].candidate_count = 0;
  fixture.candidates = [];
  fixture.applications = [];
  const created = await competitionRequest(env, { body: fixture });
  assert.equal(created.status, 201);
  assertCompetitionNoStore(created);
  const looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assertCompetitionNoStore(looked);
  const body = await looked.json();
  assert.equal(body.summary.partial, true);
  assert.deepEqual(body.sources, [{
    id: 'contest-listing',
    kind: 'listing',
    name: 'Contest Listing',
    reference_url: 'https://list.example/contests/123',
    status: 'partial',
    checked_at: fixture.sources[0].checked_at,
    candidate_count: 0,
    failure_code: 'http_403',
    manual_check: true,
  }]);
  assert.deepEqual(body.candidates, []);
  assert.deepEqual(body.applications, []);
});

test('competition report day uses Asia/Seoul and stale latest scans zero every today count', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const staleKstDate = competitionKstDate(Date.now() - DAY_MS);
  const boundaryStart = Date.parse(`${staleKstDate}T00:01:00+09:00`);
  const fixture = setCompetitionTimeline(competitionFixture(), boundaryStart);
  fixture.idempotency_key = 'competition-kst-boundary';
  fixture.run.id = 'competition-kst-boundary';
  fixture.run.started_at = `${staleKstDate}T00:01:00+09:00`;
  fixture.run.date = staleKstDate;
  const created = await competitionRequest(env, { body: fixture });
  assert.equal(created.status, 201);
  assertCompetitionNoStore(created);

  const looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(looked.status, 200);
  assertCompetitionNoStore(looked);
  const body = await looked.json();
  assert.equal(body.runs[0].date, staleKstDate);
  assert.equal(body.runs[0].started_at, new Date(boundaryStart).toISOString());
  assert.deepEqual(body.summary.today, {
    discovered: 0,
    verified: 0,
    ready: 0,
    awaiting_approval: 0,
    deadline_soon: 0,
  });

  const mismatched = setCompetitionTimeline(competitionFixture(), boundaryStart);
  mismatched.idempotency_key = 'competition-kst-mismatch';
  mismatched.run.id = 'competition-kst-mismatch';
  mismatched.run.date = competitionKstDate(boundaryStart - DAY_MS);
  const rejected = await competitionRequest(env, { body: mismatched });
  assert.equal(rejected.status, 400);
  assertCompetitionNoStore(rejected);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 1);
});

test('competition rejects observations beyond the five-minute future skew without writes', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const fixture = setCompetitionTimeline(competitionFixture(), Date.now() + 10 * 60_000);
  fixture.idempotency_key = 'competition-future-scan';
  fixture.run.id = 'competition-future-scan';
  const response = await competitionRequest(env, { body: fixture });
  assert.equal(response.status, 400);
  assertCompetitionNoStore(response);
  assert.deepEqual(await response.json(), { error: 'invalid_report' });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);
});

test('competition evidence cannot follow its report observation while older evidence remains valid', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const probes = [
    ['future-source-check', (body, future) => { body.sources[0].checked_at = future; }],
    ['future-discovery', (body, future) => { body.candidates[0].discovered_at = future; }],
    ['future-active-verification', (body, future) => {
      body.candidates[0].official_verified_at = future;
    }],
    ['future-application-update', (body, future) => { body.applications[0].updated_at = future; }],
  ];
  for (const [name, mutate] of probes) {
    const body = competitionFixture();
    body.idempotency_key = `competition-${name}`;
    body.run.id = `competition-${name}`;
    const futureEvidence = new Date(Date.parse(body.run.finished_at) + 60_000).toISOString();
    mutate(body, futureEvidence);
    const response = await competitionRequest(env, { body });
    assert.equal(response.status, 400, name);
    assertCompetitionNoStore(response);
    assert.deepEqual(await response.json(), { error: 'invalid_report' }, name);
    assert.equal(
      Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count),
      0,
      name,
    );
  }

  const beforeDiscovery = competitionFixture();
  beforeDiscovery.idempotency_key = 'competition-application-before-discovery';
  beforeDiscovery.run.id = 'competition-application-before-discovery';
  beforeDiscovery.applications[0].updated_at = new Date(
    Date.parse(beforeDiscovery.candidates[0].discovered_at) - 60_000,
  ).toISOString();
  const beforeDiscoveryResponse = await competitionRequest(env, { body: beforeDiscovery });
  assert.equal(beforeDiscoveryResponse.status, 400);
  assertCompetitionNoStore(beforeDiscoveryResponse);
  assert.deepEqual(await beforeDiscoveryResponse.json(), { error: 'invalid_report' });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);

  const carried = competitionFixture();
  carried.idempotency_key = 'competition-carried-evidence';
  carried.run.id = 'competition-carried-evidence';
  const olderDiscovery = new Date(Date.parse(carried.run.started_at) - 2 * DAY_MS).toISOString();
  carried.sources[0].checked_at = olderDiscovery;
  carried.candidates[0].discovered_at = olderDiscovery;
  carried.candidates[0].official_verified_at = new Date(Date.parse(olderDiscovery) + 60_000).toISOString();
  carried.applications[0].updated_at = new Date(Date.parse(olderDiscovery) + 2 * 60_000).toISOString();
  const accepted = await competitionRequest(env, { body: carried });
  assert.equal(accepted.status, 201);
  assertCompetitionNoStore(accepted);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 1);
});

test('competition latest snapshot follows observation time and deduplicates repeated run ids', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const staleKstDate = competitionKstDate(Date.now() - DAY_MS);
  const midnight = Date.parse(`${staleKstDate}T00:00:00+09:00`);
  const newer = setCompetitionTimeline(competitionFixture(), midnight + 20 * 60 * 60_000);
  newer.idempotency_key = 'competition-repeat-newer';
  newer.run.id = 'competition-repeated-run';
  newer.candidates[0].title = 'Newer observed snapshot';
  const older = setCompetitionTimeline(competitionFixture(), midnight + 18 * 60 * 60_000);
  older.idempotency_key = 'competition-repeat-older';
  older.run.id = 'competition-repeated-run';
  older.candidates[0].title = 'Older late-delivered snapshot';

  const first = await competitionRequest(env, { body: newer });
  const second = await competitionRequest(env, { body: older });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const looked = await worker.fetch(new Request('https://api.test/api/competitions', {
    headers: { authorization: 'Bearer owner-token' },
  }), env);
  assert.equal(looked.status, 200);
  const body = await looked.json();
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 2);
  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].id, 'competition-repeated-run');
  assert.equal(body.runs[0].started_at, newer.run.started_at);
  assert.equal(body.candidates[0].title, 'Newer observed snapshot');
});

test('competition schema rejects unknown, private, unsafe, inconsistent and oversized reports without writes', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  const invalid = [];
  const add = (mutate) => {
    const fixture = competitionFixture();
    mutate(fixture);
    invalid.push(fixture);
  };
  add((body) => { body.run.unexpected = true; });
  add((body) => { body.candidates[0].application_answers = { why: 'private prose' }; });
  add((body) => { body.candidates[0].submission_payload = { action: 'submit' }; });
  add((body) => { body.applications[0].final_submission = true; });
  add((body) => { body.applications[0].legal_consent = true; });
  add((body) => { body.applications[0].payment = { amount: 10 }; });
  add((body) => { body.applications[0].receipt = 'organizer receipt'; });
  add((body) => { body.applications[0].email = 'person@example.com'; });
  add((body) => { body.candidates[0].discovery_url = 'http://list.example/contests/123'; });
  add((body) => { body.candidates[0].official_url = 'https://127.0.0.1/rules'; });
  add((body) => { body.candidates[0].official_url = 'https://localhost/rules'; });
  add((body) => { body.candidates[0].official_url = 'https://10.0.0.1/rules'; });
  add((body) => { body.candidates[0].official_url = 'https://user:secret@organizer.example/rules'; });
  add((body) => { body.candidates[0].official_url = 'https://organizer.example/rules#private'; });
  add((body) => { body.candidates[0].official_url = 'https://list.example/official-looking-rules'; });
  add((body) => { body.candidates[0].official_url = 'https://www.list.example/official-looking-rules'; });
  add((body) => { body.candidates[0].official_url = 'https://www2.list.example/official-looking-rules'; });
  add((body) => { body.candidates[0].official_url = 'https://rules.list.example/official-looking-rules'; });
  add((body) => { body.candidates[0].official_url = 'https://www.list.example../official-looking-rules'; });
  add((body) => {
    body.candidates[0].discovery_url = 'https://list.example/contests/123?email=person%40example.com';
  });
  add((body) => { body.run.started_at = '2026-08-31T00:00:00'; });
  add((body) => { body.candidates[0].status = 'preparing'; });
  add((body) => { body.candidates[0].eligibility = 'unknown'; });
  add((body) => {
    body.sources[0].status = 'failed';
    body.sources[0].failure_code = 'timeout';
    body.sources[0].manual_check = false;
    body.run.status = 'partial';
    body.run.source_coverage.succeeded = 0;
  });
  add((body) => {
    body.applications = Array.from({ length: 4 }, (_, index) => ({
      ...body.applications[0],
      contest_id: `organizer-2026-image-${index}`,
      profile_id: `hmac-sha256:${String(index).repeat(64)}`,
    }));
  });
  for (const body of invalid) {
    const response = await competitionRequest(env, { body });
    assert.equal(response.status, 400);
    assertCompetitionNoStore(response);
    assert.ok(['invalid_report', 'forbidden_data'].includes((await response.json()).error));
  }
  const tooLarge = await worker.fetch(new Request('https://api.test/api/competitions/report', {
    method: 'POST',
    headers: {
      authorization: 'Bearer competition-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ padding: 'x'.repeat(1_000_001) }),
  }), env);
  assert.equal(tooLarge.status, 413);
  assertCompetitionNoStore(tooLarge);
  assert.deepEqual(await tooLarge.json(), { error: 'report_too_large' });
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_reports').get().count), 0);
  assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM competition_sources').get().count), 0);
});

test('competition accepted-report batch rolls back every normalized table on a child failure', async (t) => {
  const context = await competitionTestContext(t);
  if (!context) return;
  const { database, env } = context;
  database.exec(`
    CREATE TRIGGER competition_test_source_failure
    BEFORE INSERT ON competition_sources
    BEGIN SELECT RAISE(ABORT, 'forced competition child failure'); END;
  `);
  t.mock.method(console, 'error', () => {});
  const response = await competitionRequest(env, { body: competitionFixture() });
  assert.equal(response.status, 500);
  assertCompetitionNoStore(response);
  assert.deepEqual(await response.json(), { error: '서버 오류' });
  for (const table of [
    'competition_reports', 'competition_sources', 'competition_candidates',
    'competition_applications',
  ]) {
    assert.equal(Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count), 0);
  }
});
