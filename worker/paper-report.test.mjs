import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import worker from './src/index.js';
import {
  BEHAVIOR_PAPER_DEADLINE,
  BEHAVIOR_PAPER_SESSION_ID,
  BEHAVIOR_PAPER_SNAPSHOT_SOURCE,
  normalizeBehaviorPaperReport,
} from './src/router.js';

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
            assert.match(sql, /> COALESCE/u);
            const [source, capturedAt, payload] = this.values;
            const sequence = JSON.parse(payload).sequence;
            const latest = reports[0]?.sequence || 0;
            if (latest >= sequence) return { success: true, meta: { changes: 0 } };
            reports[0] = { source, sequence, payload, captured_at: capturedAt };
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

test('paper ingest requires its dedicated bearer, rejects oversized input, and replaces only with a newer sequence', async () => {
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
  const second = await post(paperReport({ sequence: 2, status: 'complete' }), env);
  assert.equal(second.status, 200);
  assert.equal(db.reports.length, 1);
  assert.equal(db.reports[0].source, BEHAVIOR_PAPER_SNAPSHOT_SOURCE);
  assert.equal(JSON.parse(db.reports[0].payload).status, 'complete');
});

test('paper sequence upsert is atomic and strictly increasing in real SQLite', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { DatabaseSync = null; }
  if (!DatabaseSync) return t.skip('node:sqlite unavailable');
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec(readFileSync(new URL('./migrations/0005_usage_snapshots.sql', import.meta.url), 'utf8'));
  const env = envFor(sqliteD1(database));

  assert.equal((await post(paperReport({ sequence: 2 }), env)).status, 200);
  assert.equal((await post(paperReport({ sequence: 1 }), env)).status, 409);
  assert.equal((await post(paperReport({ sequence: 2 }), env)).status, 409);
  assert.equal((await post(paperReport({ sequence: 3, equity: 103, net_pnl: 3, return_pct: 3 }), env)).status, 200);
  const row = database.prepare('SELECT source, payload FROM usage_snapshots').get();
  assert.equal(row.source, BEHAVIOR_PAPER_SNAPSHOT_SOURCE);
  assert.equal(JSON.parse(row.payload).sequence, 3);
});

test('paper read is exact behavior-owner only, fail-closed, no-store, and returns the latest validated snapshot', async () => {
  const db = memoryDb();
  const env = envFor(db);
  assert.equal((await get(env, '')).status, 401);
  assert.equal((await get(envFor(memoryDb({ username: 'claude-test' })))).status, 404);
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
});

test('dashboard read authenticates the separate human owner before validating or starting upstream work', async () => {
  const url = 'https://api.test/api/behavior-lab/dashboard?symbol=BTCUSDT&period=bad';
  const noSession = await worker.fetch(new Request(url), envFor(memoryDb()));
  assert.equal(noSession.status, 401);
  const testAccount = await worker.fetch(new Request(url, { headers: { authorization: 'Bearer session' } }),
    envFor(memoryDb({ username: 'claude-test' })));
  assert.equal(testAccount.status, 404);
  const owner = await worker.fetch(new Request(url, { headers: { authorization: 'Bearer session' } }),
    envFor(memoryDb()));
  assert.equal(owner.status, 400);
  assert.match(owner.headers.get('cache-control') || '', /no-store/u);
});
