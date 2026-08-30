import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import worker from './src/index.js';
import {
  BEHAVIOR_PAPER_DEADLINE,
  BEHAVIOR_PAPER_SESSION_ID,
  BEHAVIOR_PAPER_SNAPSHOT_SOURCE,
  normalizeBehaviorPaperReport,
} from './src/router.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function adaptiveReport(auditSequence = 10, overrides = {}) {
  return {
    engine_version: 'realtime-paper-v2',
    strategy_schema: 1,
    upgraded_at: '2026-08-30T18:30:00.000Z',
    cadence: {
      regime: '5m', candidate: 'completed-1m', risk: 'ticker-event', microstructure: '1s/3s-persistence',
      weight_checkpoint: '15m', challenger_checkpoint: '24h-minimum',
    },
    stream: {
      status: 'live', last_packet_at: '2026-08-30T18:59:59.000Z', reconnect_count: 1, credential_used: false,
    },
    champion: { id: 'adaptive-balanced-v1', version: 1, hash: HASH_A },
    challengers: [{
      id: 'adaptive-trend-v1', version: 1, hash: HASH_B, trade_count: 4,
      expectancy: 0.12, max_drawdown_pct: 1.5, cost_bps: 20,
    }],
    promotion: {
      status: 'collecting', last_checkpoint_at: null, from: null, to: null,
      reasons: ['minimum-evidence-not-yet-complete'],
    },
    audit: {
      sequence: auditSequence,
      hash: HASH_C,
      recent: [{
        sequence: auditSequence, at: '2026-08-30T18:59:59.000Z', kind: 'report-attempt',
        message: 'bounded-owner-summary', hash: HASH_C,
      }],
    },
    ...overrides,
  };
}

function paperReport(overrides = {}) {
  return {
    session_id: BEHAVIOR_PAPER_SESSION_ID,
    sequence: 1,
    generated_at: '2026-08-30T19:00:00.000Z',
    deadline_at: BEHAVIOR_PAPER_DEADLINE,
    status: 'active',
    simulation: true,
    seed_equity: 100,
    equity: 101.25,
    cash: 101.25,
    realized_pnl: 1.5,
    unrealized_pnl: -0.25,
    net_pnl: 1.25,
    return_pct: 1.25,
    max_drawdown_pct: 2.4,
    fees: 0.18,
    slippage_cost: 0.12,
    trade_count: 2,
    win_count: 1,
    loss_count: 1,
    open_position: {
      symbol: 'ETHUSDT', direction: 'short', entry_price: 4_500, mark_price: 4_490,
      quantity: 0.05, unrealized_pnl: 0.5, opened_at: '2026-08-30T18:55:00.000Z',
    },
    recent_trades: [{
      symbol: 'BTCUSDT', direction: 'long', entry_price: 100_000, exit_price: 100_100,
      net_pnl: 0.4, exit_reason: 'target',
    }],
    recent_logs: [{ at: '2026-08-30T19:00:00.000Z', level: 'info', message: 'cycle completed' }],
    last_cycle_at: '2026-08-30T19:00:00.000Z',
    limitations: ['Funding and liquidation are not modeled.', 'All figures are simulated.'],
    ...overrides,
  };
}

function adaptiveReportWithHistory(auditSequence = 20) {
  const report = adaptiveReport(auditSequence);
  report.audit.recent.unshift({
    sequence: auditSequence - 1,
    at: '2026-08-30T18:59:58.000Z',
    kind: 'checkpoint',
    message: 'checkpoint',
    hash: HASH_A,
  });
  return report;
}

function paperStateJson(report) {
  const copy = structuredClone(report);
  delete copy.generated_at;
  delete copy.adaptive;
  return JSON.stringify(copy);
}

function memoryDb({ username = 'hvsdcm' } = {}) {
  const reports = [];
  return {
    reports,
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (sql.includes('SELECT s.*, u.username')) {
            return { token_hash: 'stored-hash', role: 'user', disabled: 0, username };
          }
          if (sql.includes('FROM usage_snapshots')) {
            return reports[0] || null;
          }
          throw new Error(`Unexpected first SQL: ${sql}`);
        },
        async run() {
          if (sql.includes('UPDATE sessions')) return { success: true, meta: { changes: 1 } };
          if (sql.includes('INSERT INTO usage_snapshots')) {
            assert.match(sql, /ON CONFLICT\(source\) DO UPDATE/u);
            assert.match(sql, /json_extract\(excluded\.payload, '\$\.sequence'\)/u);
            assert.match(sql, /\$\.adaptive\.audit\.sequence/u);
            assert.match(sql, /> COALESCE/u);
            const [source, capturedAt, payload] = this.values;
            const parsed = JSON.parse(payload);
            const latest = reports[0] ? JSON.parse(reports[0].payload) : null;
            const auditSequence = parsed.adaptive?.audit?.sequence ?? -1;
            const latestAuditSequence = latest?.adaptive?.audit?.sequence ?? -1;
            const paperAdvanced = !latest || parsed.sequence > latest.sequence;
            const auditAdvanced = latest && parsed.adaptive && auditSequence > latestAuditSequence;
            const paperMonotonic = !latest || parsed.sequence >= latest.sequence;
            const adaptivePreserved = !latest || !latest.adaptive || parsed.adaptive;
            const auditMonotonic = !latest || !latest.adaptive || (parsed.adaptive && auditSequence >= latestAuditSequence
              && (auditSequence > latestAuditSequence || parsed.adaptive.audit.hash === latest.adaptive.audit.hash));
            const samePaperImmutable = !latest || parsed.sequence > latest.sequence
              || paperStateJson(parsed) === paperStateJson(latest);
            const sameAuditReferenceImmutable = !latest || !latest.adaptive
              || auditSequence > latestAuditSequence
              || JSON.stringify(parsed.adaptive?.audit) === JSON.stringify(latest.adaptive.audit);
            if (!paperMonotonic || !adaptivePreserved || !auditMonotonic || (!paperAdvanced && !auditAdvanced)
              || !samePaperImmutable || !sameAuditReferenceImmutable) return { success: true, meta: { changes: 0 } };
            reports[0] = { source, sequence: parsed.sequence, auditSequence, payload, captured_at: capturedAt };
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`Unexpected run SQL: ${sql}`);
        },
      };
      return statement;
    },
  };
}

function envFor(db, overrides = {}) {
  return {
    ALLOWED_ORIGIN: 'https://hvsdcm1.xyz',
    OWNER_USERNAME: 'hvsdcm,claude-test',
    BEHAVIOR_OWNER_USERNAME: 'hvsdcm',
    BEHAVIOR_PAPER_REPORT_TOKEN: 'paper-secret',
    DB: db,
    ...overrides,
  };
}

function post(report, env, token = 'paper-secret') {
  return worker.fetch(new Request('https://api.test/api/behavior-lab/paper/report', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(report),
  }), env);
}

function get(env, token = 'owner-session') {
  return worker.fetch(new Request('https://api.test/api/behavior-lab/paper', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }), env);
}

function sqliteD1(database) {
  const wrap = (statement, values = []) => ({
    bind(...next) { return wrap(statement, next); },
    async first() { return statement.get(...values) || null; },
    async run() {
      const result = statement.run(...values);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  return { prepare(sql) { return wrap(database.prepare(sql)); } };
}

function initializeOwnerPaperSqlite(database, ownerToken = 'owner-session') {
  for (const migration of ['0001_init.sql', '0004_session_ip_address.sql', '0005_usage_snapshots.sql']) {
    database.exec(readFileSync(new URL(`./migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const timestamp = Date.now();
  database.prepare(`
    INSERT INTO users(username, password_hash, password_salt, created_at, disabled)
    VALUES (?, 'hash', 'salt', ?, 0)
  `).run('hvsdcm', timestamp);
  const userId = database.prepare('SELECT id FROM users WHERE username = ?').get('hvsdcm').id;
  const tokenHash = createHash('sha256').update(ownerToken).digest('hex');
  database.prepare(`
    INSERT INTO sessions(token_hash, user_id, role, created_at, expires_at, last_seen_at)
    VALUES (?, ?, 'user', ?, ?, ?)
  `).run(tokenHash, userId, timestamp, timestamp + 60_000, timestamp);
}

test('paper report schema fixes the simulation, $100 seed, session, deadline, finite bounds, and bounded details', () => {
  const normalized = normalizeBehaviorPaperReport(paperReport());
  assert.equal(normalized.session_id, BEHAVIOR_PAPER_SESSION_ID);
  assert.equal(normalized.deadline_at, BEHAVIOR_PAPER_DEADLINE);
  assert.equal(normalized.simulation, true);
  assert.equal(normalized.seed_equity, 100);
  assert.equal(normalized.recent_trades.length, 1);

  for (const mutation of [
    { session_id: 'another-session' },
    { deadline_at: '2026-08-31T08:00:00.000Z' },
    { simulation: false },
    { seed_equity: 99 },
    { status: 'completed' },
    { equity: Number.NaN },
    { max_drawdown_pct: 100.01 },
    { win_count: 3 },
    { recent_trades: Array.from({ length: 26 }, () => ({})) },
    { recent_logs: Array.from({ length: 51 }, () => 'log') },
    { open_position: { symbol: 'DOGEUSDT', direction: 'long' } },
  ]) {
    assert.equal(normalizeBehaviorPaperReport(paperReport(mutation)), null, JSON.stringify(mutation));
  }
});

test('adaptive paper v2 is strict, bounded, credential-free, and keeps legacy reports readable', () => {
  const legacy = normalizeBehaviorPaperReport(paperReport());
  assert.equal(Object.hasOwn(legacy, 'adaptive'), false);
  const normalized = normalizeBehaviorPaperReport(paperReport({ adaptive: adaptiveReport() }));
  assert.equal(normalized.adaptive.engine_version, 'realtime-paper-v2');
  assert.equal(normalized.adaptive.stream.credential_used, false);
  assert.equal(normalized.adaptive.challengers.length, 1);
  assert.equal(normalized.adaptive.audit.sequence, 10);

  const valid = adaptiveReport();
  for (const adaptive of [
    { ...valid, engine_version: 'realtime-paper-v3' },
    { ...valid, cadence: { ...valid.cadence, candidate: '5m' } },
    { ...valid, stream: { ...valid.stream, credential_used: true } },
    { ...valid, champion: { ...valid.champion, hash: 'short' } },
    { ...valid, challengers: Array.from({ length: 9 }, (_, index) => ({
      ...valid.challengers[0], id: `adaptive-shadow-${index}`,
    })) },
    { ...valid, challengers: [{ ...valid.challengers[0], id: valid.champion.id }] },
    { ...valid, challengers: [{ ...valid.challengers[0], expectancy: Number.NaN }] },
    { ...valid, promotion: { ...valid.promotion, reasons: Array.from({ length: 13 }, () => 'reason') } },
    { ...valid, audit: { ...valid.audit, recent: Array.from({ length: 21 }, () => valid.audit.recent[0]) } },
    { ...valid, audit: { ...valid.audit, recent: [{ ...valid.audit.recent[0], sequence: 11 }] } },
    { ...valid, audit: { ...valid.audit, hash: HASH_B } },
    { ...valid, stream: { ...valid.stream, last_packet_at: '2026-08-30T19:00:01.000Z' } },
  ]) {
    assert.equal(normalizeBehaviorPaperReport(paperReport({ adaptive })), null, JSON.stringify(adaptive));
  }

  const allowedVocabulary = normalizeBehaviorPaperReport(paperReport({
    recent_logs: [{
      strategy_id: 'adaptive-trend-v1', orderflow_imbalance: 0.42, accounting_mode: 'paper',
      signal_strength: 0.8, signed_volume: -12, trade_count: 4, filled_ratio: 0.5,
      access_mode: 'public', subperiod_id: 'one-minute',
      message: 'Public API orderflow strategy signal=long',
    }],
    limitations: [
      'Public market data only; strategy output remains simulated.',
      '{"strategy_id":"adaptive-trend-v1","signal_strength":0.8,"signed_volume":-12,'
        + '"trade_count":4,"filled_ratio":0.5,"access_mode":"public","subperiod_id":"one-minute"}',
    ],
  }));
  assert.ok(allowedVocabulary);
  assert.equal(allowedVocabulary.recent_logs[0].strategy_id, 'adaptive-trend-v1');
});

test('paper ingest requires its dedicated bearer and advances paper or same-session audit sequence without downgrade', async () => {
  const db = memoryDb();
  const env = envFor(db);
  const missing = await post(paperReport(), env, '');
  assert.equal(missing.status, 401);
  assert.equal(db.reports.length, 0);
  const wrong = await post(paperReport(), env, 'wrong');
  assert.equal(wrong.status, 401);

  const oversized = await worker.fetch(new Request('https://api.test/api/behavior-lab/paper/report', {
    method: 'POST',
    headers: { authorization: 'Bearer paper-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(70_000) }),
  }), env);
  assert.equal(oversized.status, 413);
  assert.equal(db.reports.length, 0);

  const first = await post(paperReport(), env);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, session_id: BEHAVIOR_PAPER_SESSION_ID, sequence: 1 });
  assert.equal(db.reports.length, 1);

  const replay = await post(paperReport(), env);
  assert.equal(replay.status, 409);
  assert.equal(db.reports.length, 1);

  const upgraded = await post(paperReport({ adaptive: adaptiveReport(10) }), env);
  assert.equal(upgraded.status, 200);
  assert.equal((await post(paperReport({ adaptive: adaptiveReport(10) }), env)).status, 409);
  assert.equal((await post(paperReport({ adaptive: adaptiveReport(11) }), env)).status, 200);
  assert.equal((await post(paperReport({ sequence: 2 }), env)).status, 409);

  const second = await post(paperReport({ sequence: 2, status: 'complete', adaptive: adaptiveReport(12) }), env);
  assert.equal(second.status, 200);
  assert.equal(db.reports.length, 1);
  assert.equal(db.reports[0].source, BEHAVIOR_PAPER_SNAPSHOT_SOURCE);
  assert.equal(JSON.parse(db.reports[0].payload).status, 'complete');
});

test('paper and adaptive audit upsert is atomic and monotonic in real SQLite', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }
  if (!DatabaseSync) return t.skip('node:sqlite unavailable');
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(readFileSync(new URL('./migrations/0005_usage_snapshots.sql', import.meta.url), 'utf8'));
  const env = envFor(sqliteD1(database));
  const stored = () => JSON.parse(database.prepare('SELECT payload FROM usage_snapshots').get().payload);

  assert.equal((await post(paperReport({ sequence: 2, adaptive: adaptiveReport(20) }), env)).status, 200);
  assert.equal((await post(paperReport({ sequence: 1, adaptive: adaptiveReport(99) }), env)).status, 409);
  assert.deepEqual([stored().sequence, stored().adaptive.audit.sequence], [2, 20]);
  assert.equal((await post(paperReport({ sequence: 2, adaptive: adaptiveReport(20) }), env)).status, 409);
  assert.equal((await post(paperReport({ sequence: 3, adaptive: adaptiveReport(19) }), env)).status, 409);
  assert.deepEqual([stored().sequence, stored().adaptive.audit.sequence], [2, 20]);
  assert.equal((await post(paperReport({ sequence: 2, equity: 999, adaptive: adaptiveReport(21) }), env)).status, 409);
  assert.equal(stored().equity, 101.25);
  assert.equal((await post(paperReport({ sequence: 2, generated_at: '2026-08-30T19:00:01.000Z',
    adaptive: adaptiveReport(21) }), env)).status, 200);
  assert.equal((await post(paperReport({ sequence: 3 }), env)).status, 409);
  assert.equal((await post(paperReport({
    sequence: 3, equity: 103, net_pnl: 3, return_pct: 3, adaptive: adaptiveReport(21),
  }), env)).status, 200);
  assert.equal((await post(paperReport({
    sequence: 3, equity: 103, net_pnl: 3, return_pct: 3, adaptive: adaptiveReport(22),
  }), env)).status, 200);
  assert.equal((await post(paperReport({
    sequence: 3, equity: 104, net_pnl: 4, return_pct: 4, adaptive: adaptiveReport(23),
  }), env)).status, 409);
  const rewrittenAudit = adaptiveReport(22);
  rewrittenAudit.audit.hash = HASH_B;
  rewrittenAudit.audit.recent[0].hash = HASH_B;
  assert.equal((await post(paperReport({
    sequence: 4, equity: 104, net_pnl: 4, return_pct: 4, adaptive: rewrittenAudit,
  }), env)).status, 409);
  assert.deepEqual([stored().sequence, stored().adaptive.audit.sequence, stored().adaptive.audit.hash], [3, 22, HASH_C]);
  const row = database.prepare('SELECT source, payload FROM usage_snapshots').get();
  assert.equal(row.source, BEHAVIOR_PAPER_SNAPSHOT_SOURCE);
  assert.equal(JSON.parse(row.payload).sequence, 3);
  assert.equal(JSON.parse(row.payload).adaptive.audit.sequence, 22);
  assert.equal(Object.hasOwn(JSON.parse(row.payload), '_paper_state_hash'), false);
});

test('an equal adaptive audit reference cannot rewrite bounded history during a paper advance', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }
  if (!DatabaseSync) return t.skip('node:sqlite unavailable');
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(readFileSync(new URL('./migrations/0005_usage_snapshots.sql', import.meta.url), 'utf8'));
  const env = envFor(sqliteD1(database));
  const stored = () => JSON.parse(database.prepare('SELECT payload FROM usage_snapshots').get().payload);
  const baselineAudit = adaptiveReportWithHistory(20);

  assert.equal((await post(paperReport({ sequence: 2, adaptive: baselineAudit }), env)).status, 200);
  const committedAudit = structuredClone(stored().adaptive.audit);
  const mutations = [
    ['timestamp', 409, (audit) => { audit.audit.recent[0].at = '2026-08-30T18:50:00.000Z'; }],
    ['kind', 409, (audit) => { audit.audit.recent[0].kind = 'rollback'; }],
    ['hash', 409, (audit) => { audit.audit.recent[0].hash = HASH_B; }],
    ['length', 409, (audit) => { audit.audit.recent.shift(); }],
    ['order', 400, (audit) => { audit.audit.recent.reverse(); }],
  ];
  for (const [label, expectedStatus, mutate] of mutations) {
    const changed = structuredClone(baselineAudit);
    mutate(changed);
    const response = await post(paperReport({
      sequence: 3, equity: 103, net_pnl: 3, return_pct: 3, adaptive: changed,
    }), env);
    assert.equal(response.status, expectedStatus, label);
    assert.deepEqual(stored().adaptive.audit, committedAudit, label);
  }

  const advanced = await post(paperReport({
    sequence: 3, equity: 103, net_pnl: 3, return_pct: 3,
    generated_at: '2026-08-30T19:00:01.000Z', adaptive: baselineAudit,
  }), env);
  assert.equal(advanced.status, 200);
  assert.equal(stored().sequence, 3);
  assert.deepEqual(stored().adaptive.audit, committedAudit);
});

test('credential, environment, account, order, and private-route sentinels never reach stored or owner response bytes', async () => {
  const sentinels = [
    'Bearer exchange-private-sentinel', 'Basic ZXhjaGFuZ2UtcHJpdmF0ZQ==',
    'api_key=exchange-private-sentinel', 'passphrase: exchange-private-sentinel',
    'BITGET_API_SECRET=exchange-private-sentinel', 'account_id=exchange-private-sentinel',
    'order_id=exchange-private-sentinel', '/api/v2/mix/order/place-order', 'private-route',
    'wss://ws.bitget.com/v2/ws/private',
  ];
  for (const sentinel of sentinels) {
    const db = memoryDb();
    const env = envFor(db);
    const adaptive = adaptiveReport(10);
    adaptive.audit.recent[0].message = sentinel;
    const response = await post(paperReport({ adaptive }), env);
    assert.equal(response.status, 200, sentinel);
    const responseBytes = await response.text();
    const ownerBytes = await (await get(env)).text();
    assert.equal(db.reports.length, 1, sentinel);
    assert.equal(JSON.stringify(db.reports).includes(sentinel), false, sentinel);
    assert.equal(responseBytes.includes(sentinel), false, sentinel);
    assert.equal(ownerBytes.includes(sentinel), false, sentinel);
    assert.equal(JSON.parse(db.reports[0].payload).adaptive.audit.recent[0].message, 'report-attempt', sentinel);

    const reasonDb = memoryDb();
    const reasonAdaptive = adaptiveReport(10);
    reasonAdaptive.promotion.reasons = [sentinel];
    assert.equal((await post(paperReport({ adaptive: reasonAdaptive }), envFor(reasonDb))).status, 400, sentinel);
    assert.equal(reasonDb.reports.length, 0, sentinel);
  }
});

test('credential and private identifier aliases fail closed before real SQLite persistence', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }
  if (!DatabaseSync) return t.skip('node:sqlite unavailable');

  const cases = [
    ['log-secretKey', (report, sentinel) => { report.recent_logs = [{ event: 'checkpoint', secretKey: sentinel }]; }],
    ['trade-apiSecret', (report, sentinel) => { report.recent_trades[0].apiSecret = sentinel; }],
    ['position-clientOid', (report, sentinel) => { report.open_position.clientOid = sentinel; }],
    ['log-uid', (report, sentinel) => { report.recent_logs = [{ event: 'checkpoint', uid: sentinel }]; }],
    ['log-api_secret', (report, sentinel) => { report.recent_logs = [{ event: 'checkpoint', api_secret: sentinel }]; }],
    ['trade-secret_key', (report, sentinel) => { report.recent_trades[0].secret_key = sentinel; }],
    ['position-client_oid', (report, sentinel) => { report.open_position.client_oid = sentinel; }],
    ['log-accountId', (report, sentinel) => { report.recent_logs = [{ event: 'checkpoint', accountId: sentinel }]; }],
    ['trade-clOrdId', (report, sentinel) => { report.recent_trades[0].clOrdId = sentinel; }],
    ['log-authToken', (report, sentinel) => { report.recent_logs = [{ event: 'checkpoint', authToken: sentinel }]; }],
    ['log-accessSign', (report, sentinel) => { report.recent_logs = [{ event: 'checkpoint', accessSign: sentinel }]; }],
    ['trade-ACCESS_SIGN', (report, sentinel) => { report.recent_trades[0].ACCESS_SIGN = sentinel; }],
    ['position-subUid', (report, sentinel) => { report.open_position.subUid = sentinel; }],
    ['log-SUB_UID', (report, sentinel) => { report.recent_logs = [{ event: 'checkpoint', SUB_UID: sentinel }]; }],
    ['log-subuid', (report, sentinel) => { report.recent_logs = [{ event: 'checkpoint', subuid: sentinel }]; }],
    ['trade-tradeId', (report, sentinel) => { report.recent_trades[0].tradeId = sentinel; }],
    ['log-TRADE_ID', (report, sentinel) => { report.recent_logs = [{ event: 'checkpoint', TRADE_ID: sentinel }]; }],
    ['log-tradeid', (report, sentinel) => { report.recent_logs = [{ event: 'checkpoint', tradeid: sentinel }]; }],
    ['position-fillId', (report, sentinel) => { report.open_position.fillId = sentinel; }],
    ['log-FILL_ID', (report, sentinel) => { report.recent_logs = [{ event: 'checkpoint', FILL_ID: sentinel }]; }],
    ['log-fillid', (report, sentinel) => { report.recent_logs = [{ event: 'checkpoint', fillid: sentinel }]; }],
    ['text-lower-snake-secret', (report, sentinel) => {
      report.recent_logs = [{ message: `bitget_api_secret=${sentinel}` }];
    }],
    ['text-lower-secret-key', (report, sentinel) => {
      report.recent_logs = [{ message: `bitget_secret_key=${sentinel}` }];
    }],
    ['text-camel-secret-key', (report, sentinel) => {
      report.limitations = [`bitgetSecretKey=${sentinel}`];
    }],
    ['text-lower-compact-secret', (report, sentinel) => {
      report.limitations = [`bitgetapisecret=${sentinel}`];
    }],
    ['text-access-sign', (report, sentinel) => {
      report.recent_logs = [{ message: `ACCESS-SIGN=${sentinel}` }];
    }],
    ['text-bitget-sign', (report, sentinel) => {
      report.recent_logs = [{ message: `BITGET-SIGN=${sentinel}` }];
    }],
    ['text-json-access-sign', (report, sentinel) => {
      report.recent_logs = [{ message: `{"ACCESS-SIGN":"${sentinel}"}` }];
    }],
    ['text-json-api-key', (report, sentinel) => {
      report.limitations = [`{"apiKey":"${sentinel}"}`];
    }],
    ['text-json-sub-uid', (report, sentinel) => {
      report.recent_trades[0].note = `{"subUid":"${sentinel}"}`;
    }],
    ['text-nested-access-dot-sign', (report, sentinel) => {
      report.recent_logs = [{ message: `{"headers":{"Access.Sign":"${sentinel}"}}` }];
    }],
    ['text-single-quoted-api-key', (report, sentinel) => {
      report.limitations = [`{'API_KEY'='${sentinel}'}`];
    }],
    ['text-mismatched-sub-uid-quote', (report, sentinel) => {
      report.recent_trades[0].note = `{"SUB-UID':"${sentinel}"}`;
    }],
    ['text-split-nested-access-sign', (report, sentinel) => {
      report.recent_logs = [{ message: JSON.stringify({ access: { sign: sentinel } }) }];
    }],
    ['text-split-nested-api-key', (report, sentinel) => {
      report.recent_logs = [{ message: JSON.stringify({ api: { key: sentinel } }) }];
    }],
    ['text-split-nested-trade-id', (report, sentinel) => {
      report.recent_logs = [{ message: JSON.stringify({ trade: { id: sentinel } }) }];
    }],
    ['text-split-nested-fill-id', (report, sentinel) => {
      report.recent_logs = [{ message: JSON.stringify({ fill: { id: sentinel } }) }];
    }],
    ['text-split-nested-private-key', (report, sentinel) => {
      report.recent_logs = [{ message: JSON.stringify({ private: { key: sentinel } }) }];
    }],
    ['text-split-colon-access-sign', (report, sentinel) => {
      report.limitations = [`access:sign=${sentinel}`];
    }],
    ['text-split-equals-api-key', (report, sentinel) => {
      report.limitations = [`api=key:${sentinel}`];
    }],
    ['text-split-double-colon-access-sign', (report, sentinel) => {
      report.limitations = [`ACCESS::SIGN:${sentinel}`];
    }],
    ['text-client-oid', (report, sentinel) => {
      report.recent_trades[0].note = `clientOid: ${sentinel}`;
    }],
  ];

  for (const [index, [label, mutate]] of cases.entries()) {
    const sentinel = `synthetic-private-${index}-sentinel`;
    const candidate = paperReport({ sequence: 2, adaptive: adaptiveReport(20) });
    mutate(candidate, sentinel);
    assert.equal(normalizeBehaviorPaperReport(candidate), null, label);

    const database = new DatabaseSync(':memory:');
    try {
      initializeOwnerPaperSqlite(database);
      const env = envFor(sqliteD1(database));
      assert.equal((await post(paperReport({ sequence: 1, adaptive: adaptiveReport(19) }), env)).status, 200, label);
      const response = await post(candidate, env);
      assert.equal(response.status, 400, label);
      const responseBytes = await response.text();
      const storedBytes = database.prepare('SELECT payload FROM usage_snapshots').get().payload;
      const ownerResponse = await get(env);
      assert.equal(ownerResponse.status, 200, label);
      const ownerBytes = await ownerResponse.text();
      assert.equal(storedBytes.includes(sentinel), false, label);
      assert.equal(responseBytes.includes(sentinel), false, label);
      assert.equal(ownerBytes.includes(sentinel), false, label);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM usage_snapshots').get().count, 1, label);
      assert.equal(JSON.parse(storedBytes).sequence, 1, label);
    } finally {
      database.close();
    }
  }

  const allowedCases = [
    ['plain-strategy', (report, marker) => {
      report.recent_logs = [{ message: `Public market strategy output remains simulated ${marker}` }];
    }],
    ['json-flat-strategy', (report, marker) => {
      report.limitations = [JSON.stringify({
        strategy_id: 'adaptive-trend-v1', signal_strength: 0.8, signed_volume: -12,
        trade_count: 4, filled_ratio: 0.5, access_mode: 'public', subperiod_id: 'one-minute', marker,
      })];
    }],
    ['json-nested-strategy', (report, marker) => {
      report.recent_logs = [{ message: JSON.stringify({
        strategy: { signal: { direction: 'long', strength: 0.8 }, risk: { mode: 'paper' } }, marker,
      }) }];
    }],
    ['assignment-strategy', (report, marker) => {
      report.limitations = [`strategy_id=adaptive-trend-v1 signal_strength:0.8 marker=${marker}`];
    }],
    ['camel-strategy', (report, marker) => {
      report.recent_logs = [{
        message: `signalStrength=0.8 signedVolume=-12 tradeCount=4 filledRatio=0.5 marker=${marker}`,
      }];
    }],
    ['safe-separators', (report, marker) => {
      report.recent_logs = [{
        message: `strategy.id=adaptive-trend-v1 orderflow/imbalance=0.42 marker=${marker}`,
      }];
    }],
    ['normal-signed-fill-prose', (report, marker) => {
      report.limitations = [`The designated strategy assigned signed volume to a simulated paper fill ${marker}`];
    }],
    ['single-quoted-safe-json', (report, marker) => {
      report.recent_logs = [{
        message: `{'strategy_id'='adaptive-trend-v1','signal'='long','marker'='${marker}'}`,
      }];
    }],
    ['json-safe-modes', (report, marker) => {
      report.recent_logs = [{ message: JSON.stringify({
        access_mode: 'public', subperiod_id: 'one-minute', paper_accounting: true, marker,
      }) }];
    }],
    ['json-trade-metrics', (report, marker) => {
      report.limitations = [JSON.stringify({
        trade_count: 4, filled_ratio: 0.5, orderflow_imbalance: 0.42, public_api: 'market', marker,
      })];
    }],
  ];

  for (const [index, [label, mutate]] of allowedCases.entries()) {
    const marker = `safevalue${String(index).padStart(2, '0')}`;
    const candidate = paperReport({ sequence: 1, adaptive: adaptiveReport(19) });
    mutate(candidate, marker);
    assert.ok(normalizeBehaviorPaperReport(candidate), label);

    const database = new DatabaseSync(':memory:');
    try {
      initializeOwnerPaperSqlite(database);
      const env = envFor(sqliteD1(database));
      const response = await post(candidate, env);
      assert.equal(response.status, 200, label);
      const responseBytes = await response.text();
      const storedBytes = database.prepare('SELECT payload FROM usage_snapshots').get().payload;
      const ownerResponse = await get(env);
      assert.equal(ownerResponse.status, 200, label);
      const ownerBytes = await ownerResponse.text();
      assert.equal(storedBytes.includes(marker), true, label);
      assert.equal(responseBytes.includes(marker), false, label);
      assert.equal(ownerBytes.includes(marker), true, label);
    } finally {
      database.close();
    }
  }
});

test('paper read is exact behavior-owner only, fail-closed, no-store, and returns the latest validated snapshot', async () => {
  const db = memoryDb();
  const env = envFor(db);
  const anonymous = await get(env, '');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('cache-control'), 'private, no-store');
  const nonOwner = await get(envFor(memoryDb({ username: 'claude-test' })));
  assert.equal(nonOwner.status, 404);
  assert.equal(nonOwner.headers.get('cache-control'), 'private, no-store');
  assert.equal((await get(envFor(memoryDb(), { BEHAVIOR_OWNER_USERNAME: '' }))).status, 404);
  assert.equal((await get(envFor(memoryDb(), { BEHAVIOR_OWNER_USERNAME: 'hvsdcm,claude-test' }))).status, 404);

  const empty = await get(env);
  assert.equal(empty.status, 200);
  assert.match(empty.headers.get('cache-control'), /no-store/u);
  assert.equal((await empty.json()).report, null);

  await post(paperReport(), env);
  await post(paperReport({ sequence: 2, equity: 102, net_pnl: 2, return_pct: 2 }), env);
  const latest = await get(env);
  assert.equal(latest.status, 200);
  assert.match(latest.headers.get('cache-control'), /private/u);
  const payload = await latest.json();
  assert.equal(payload.report.sequence, 2);
  assert.equal(payload.report.equity, 102);
  assert.ok(payload.received_at);

  db.reports[0].payload = '{"invalid":true}';
  const corrupt = await get(env);
  assert.equal(corrupt.status, 500);
  assert.equal(corrupt.headers.get('cache-control'), 'private, no-store');

  const throwingDb = memoryDb();
  const originalPrepare = throwingDb.prepare.bind(throwingDb);
  throwingDb.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (sql.includes('FROM usage_snapshots')) statement.first = async () => { throw new Error('synthetic database failure'); };
    return statement;
  };
  const failed = await get(envFor(throwingDb));
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get('cache-control'), 'private, no-store');
});

test('dashboard read authenticates the separate human owner before validating or starting upstream work', async () => {
  const url = 'https://api.test/api/behavior-lab/dashboard?symbol=BTCUSDT&period=bad';
  const noSession = await worker.fetch(new Request(url), envFor(memoryDb()));
  assert.equal(noSession.status, 401);
  assert.equal(noSession.headers.get('cache-control'), 'private, no-store');
  const testAccount = await worker.fetch(new Request(url, { headers: { authorization: 'Bearer session' } }),
    envFor(memoryDb({ username: 'claude-test' })));
  assert.equal(testAccount.status, 404);
  assert.equal(testAccount.headers.get('cache-control'), 'private, no-store');
  const owner = await worker.fetch(new Request(url, { headers: { authorization: 'Bearer session' } }),
    envFor(memoryDb()));
  assert.equal(owner.status, 400);
  assert.match(owner.headers.get('cache-control') || '', /no-store/u);
});
