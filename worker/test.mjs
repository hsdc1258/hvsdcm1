import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './src/index.js';
import {
  clientIp,
  createToken,
  issueSession,
  normalizeAnswer,
  passwordHash,
  readJson,
  sha256,
} from './src/lib.js';

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

test('admin login rejects an incorrect password before issuing a session', async () => {
  const env = {
    ADMIN_PASSWORD: 'correct-password',
    ALLOWED_ORIGIN: 'https://example.test',
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
  let upsert;
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    USAGE_INGEST_TOKEN: 'correct-token',
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            upsert = { sql, values };
            return { async run() { return { success: true }; } };
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
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(upsert.sql, /ON CONFLICT\(source\)/u);
  assert.match(upsert.sql, /DO UPDATE SET captured_at = excluded\.captured_at/u);
  assert.deepEqual(upsert.values, ['codex', capturedAt, JSON.stringify(payload)]);
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
          return {
            async all() {
              return {
                results: [
                  { source: 'claude', captured_at: '2026-08-27T01:02:03.000Z', payload: '{ broken' },
                  { source: 'codex', captured_at: '2026-08-27T01:02:03.000Z', payload: '{"model":"gpt-5.6"}' },
                ],
              };
            },
          };
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
  assert.equal(snapshots[0].payload, null);
  assert.deepEqual(snapshots[1].payload, { model: 'gpt-5.6' });
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

  const storedPayload = { models: { fable: { rate_limits: { five_hour: { used_percentage: 8 } } } } };
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
            async all() {
              return {
                results: [{
                  source: 'claude',
                  captured_at: '2026-08-27T01:02:03.000Z',
                  payload: JSON.stringify(storedPayload),
                }],
              };
            },
          };
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
    snapshots: [{
      source: 'claude',
      captured_at: '2026-08-27T01:02:03.000Z',
      payload: storedPayload,
    }],
  });
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
