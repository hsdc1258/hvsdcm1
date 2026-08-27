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
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(upserts.at(-1).values, ['claude', capturedAt, JSON.stringify(payload)]);
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
        if (sql.includes('INSERT INTO usage_snapshots')) {
          return {
            bind(source, capturedAt, payload) {
              return {
                async run() {
                  snapshots.set(source, { source, captured_at: capturedAt, payload });
                  return { success: true };
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
    snapshots: [{ source: 'claude', captured_at: capturedAt, payload }],
    tasks: [],
  });
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
  };
  return {
    state,
    env: {
      ALLOWED_ORIGIN: 'https://example.test',
      HARNESS_INGEST_TOKEN: 'harness-token',
      DB: {
        batch: runFakeBatch,
        prepare(sql) {
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

test('a late or unresumed report never revives a completed harness task', async () => {
  const { state, env } = harnessStoreEnv();
  const post = (body) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  const completed = harnessInput({
    occurred_at: '2026-08-27T10:00:00.000Z',
    task: { ...harnessInput().task, status: 'complete', phase: 'done', progress: 100 },
  });

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
  assert.equal(held.phase, 'done');
  assert.equal(held.progress, 100);
  assert.deepEqual(held.actors.map((actor) => actor.status), ['done', 'done']);

  // ③ resume:true를 담은 보고만 태스크를 다시 연다.
  const resumed = await post(harnessInput({ occurred_at: '2026-08-27T12:00:00.000Z', resume: true }));
  assert.equal(resumed.status, 200);
  assert.equal(state.status, 'active');
  assert.equal(JSON.parse(state.payload).phase, 'work');

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
test('SQLite datetime() converts +09:00 offsets to UTC for the UPSERT ordering guard', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }
  if (!DatabaseSync) return t.skip('node:sqlite unavailable');
  const db = new DatabaseSync(':memory:');
  const value = (expression) => db.prepare(`SELECT ${expression} AS v`).get().v;
  const offset = "'2026-08-27T10:00:00+09:00'";
  const utc = "'2026-08-27T01:30:00.000Z'";

  // 사전순 비교는 뒤집히고, datetime() 비교는 바로 선다.
  assert.equal(value(`(${utc} >= ${offset})`), 0);
  assert.equal(value(`(datetime(${utc}) >= datetime(${offset}))`), 1);
  assert.equal(value(`(datetime('2026-08-27T00:30:00.000Z') >= datetime(${offset}))`), 0);
  // 같은 순간은 통과한다(재전송 멱등).
  assert.equal(value(`(datetime('2026-08-27T01:00:00.000Z') >= datetime(${offset}))`), 1);
  // 읽을 수 없는 값은 NULL이므로 IS NULL 폴백이 필요하다.
  assert.equal(value("datetime('not-a-time') IS NULL"), 1);
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
          assert.match(sql, /WHERE source IN \(\?, \?\)/u);
          return {
            bind(...sources) {
              assert.deepEqual([...sources].sort(), ['claude', 'codex']);
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
      },
      {
        source: 'codex',
        captured_at: '2026-08-27T01:02:03.000Z',
        payload: storedPayload,
      },
    ],
    tasks: [{ ...storedTask, events: [] }],
  });
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
