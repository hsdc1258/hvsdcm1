import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './src/index.js';
import { BEHAVIOR_ABC_EXPERIMENT_ID, BEHAVIOR_ABC_SNAPSHOT_SOURCE,
  normalizeBehaviorPaperExperimentReport } from './src/router.js';

const HASHES = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(64));
const IDS = ['abc-trend-momentum-v1', 'abc-breakout-volatility-v1', 'abc-mean-reversion-crowd-fade-v1'];
const LABELS = ['Trend / momentum', 'Breakout / volatility', 'Mean reversion / crowd fade'];

export function experimentReport(overrides = {}) {
  const arms = ['A', 'B', 'C'].map((armId, index) => ({
    arm_id: armId, strategy: { id: IDS[index], label: LABELS[index], definition_hash: HASHES[index] },
    chain: { sequence: 2, hash: HASHES[index] }, status: 'active', seed_equity: 100,
    equity: 100, cash: 100, realized_pnl: 0, unrealized_pnl: 0, net_pnl: 0, return_pct: 0,
    max_drawdown_pct: 0, fees: 0, slippage_cost: 0, trade_count: 0, win_count: 0, loss_count: 0,
    open_position: null, recent_trades: [], recent_decisions: [{ symbol: 'BTCUSDT',
      signal_bar_at: '2026-08-31T00:00:00.000Z', observed_at: '2026-08-31T00:01:00.000Z',
      direction: index === 2 ? 'stand-aside' : 'long', score: index === 2 ? 0 : .3, confidence: index === 2 ? 0 : 42,
      reason: index === 2 ? 'score-below-threshold' : null, feed_sequence: 10, feed_hash: HASHES[3] }],
    recent_logs: [{ sequence: 1, at: '2026-08-31T00:00:00.000Z', type: 'arm-started', message: 'Paper arm started.' },
      { sequence: 2, at: '2026-08-31T00:01:00.000Z', type: 'decision', message: 'Fixed strategy decision.' }],
    last_cycle_at: '2026-08-31T00:01:00.000Z',
  }));
  return {
    schema: 'abc-paper-experiment-v1', experiment_id: BEHAVIOR_ABC_EXPERIMENT_ID, simulation: true,
    public_data_only: true, generated_at: '2026-08-31T00:01:01.000Z', started_at: '2026-08-31T00:00:00.000Z',
    deadline_at: '2026-09-01T00:00:00.000Z', status: 'active',
    shared_feed: { sequence: 10, hash: HASHES[3], last_packet_at: '2026-08-31T00:01:00.000Z',
      credential_used: false, symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
      channels: ['ticker', 'books5', 'trade', 'candle1m'] },
    assumptions: { seed_equity_per_arm: 100, fee_bps_per_side: 6, slippage_bps_per_side: 4, risk_pct: 5,
      leverage_cap: 10, drawdown_halt_pct: 20, entry_cutoff_at: '2026-08-31T23:45:00.000Z',
      terminal_close: 'deadline', max_positions_per_arm: 1, strategy_mutation: false },
    leaderboard: arms.map((arm, index) => ({ rank: index + 1, arm_id: arm.arm_id, equity: arm.equity,
      net_pnl: arm.net_pnl, return_pct: arm.return_pct, max_drawdown_pct: arm.max_drawdown_pct })),
    arms, limitations: ['All figures are simulated.', 'One day is not statistical evidence.'], ...overrides,
  };
}

function experimentDb() {
  const rows = new Map();
  return { rows, prepare(sql) {
    return { values: [], bind(...values) { this.values = values; return this; },
      async first() {
        if (sql.includes('SELECT s.*, u.username')) return { token_hash: 'stored-hash', role: 'user', disabled: 0, username: 'hvsdcm' };
        if (sql.includes('FROM usage_snapshots')) return rows.get(this.values[0]) || null;
        throw new Error(`Unexpected first SQL: ${sql}`);
      },
      async run() {
        if (sql.includes('UPDATE sessions')) return { success: true, meta: { changes: 1 } };
        if (!sql.includes('INSERT INTO usage_snapshots')) throw new Error(`Unexpected run SQL: ${sql}`);
        assert.match(sql, /shared_feed\.sequence/u);
        assert.match(sql, /arms\[2\]\.chain\.hash/u);
        const [source, captured_at, payload] = this.values;
        const next = JSON.parse(payload);
        const priorRow = rows.get(source);
        const prior = priorRow ? JSON.parse(priorRow.payload) : null;
        const refs = (value) => [value.shared_feed, ...value.arms.map((arm) => arm.chain)];
        const monotonic = !prior || refs(next).every((ref, index) => ref.sequence >= refs(prior)[index].sequence
          && (ref.sequence > refs(prior)[index].sequence || ref.hash === refs(prior)[index].hash));
        const advanced = !prior || refs(next).some((ref, index) => ref.sequence > refs(prior)[index].sequence);
        if (!monotonic || !advanced) return { success: true, meta: { changes: 0 } };
        rows.set(source, { source, captured_at, payload });
        return { success: true, meta: { changes: 1 } };
      } };
  } };
}

function envFor(db) {
  return { ALLOWED_ORIGIN: 'https://hvsdcm1.xyz', OWNER_USERNAME: 'hvsdcm,claude-test',
    BEHAVIOR_OWNER_USERNAME: 'hvsdcm', BEHAVIOR_PAPER_REPORT_TOKEN: 'paper-secret', DB: db };
}

function post(report, env) {
  return worker.fetch(new Request('https://api.test/api/behavior-lab/paper/report', { method: 'POST',
    headers: { authorization: 'Bearer paper-secret', 'content-type': 'application/json' }, body: JSON.stringify(report) }), env);
}

test('A/B/C report fixes one shared feed, three isolated accounts, exact costs, and start plus 24 hours', () => {
  const normalized = normalizeBehaviorPaperExperimentReport(experimentReport());
  assert.ok(normalized);
  assert.equal(Date.parse(normalized.deadline_at) - Date.parse(normalized.started_at), 24 * 60 * 60_000);
  assert.deepEqual(normalized.arms.map((arm) => arm.arm_id), ['A', 'B', 'C']);
  assert.equal(new Set(normalized.arms.map((arm) => arm.chain.hash)).size, 3);
  assert.ok(normalized.arms.every((arm) => arm.seed_equity === 100
    && arm.recent_decisions[0].feed_hash === normalized.shared_feed.hash));
  assert.equal(normalized.assumptions.strategy_mutation, false);
});

test('A/B/C normalization fails closed on unknown, secret, private-route, mutation, and shared-feed drift', () => {
  const mutations = [
    (report) => { report.unknown = true; },
    (report) => { report.arms[0].recent_logs[0].message = 'accessToken=do-not-store'; },
    (report) => { report.arms[0].recent_logs[0].message = 'GET /api/v2/mix/order/place-order'; },
    (report) => { report.assumptions.strategy_mutation = true; },
    (report) => { report.arms[1].recent_decisions[0].feed_sequence = 11; },
    (report) => { report.arms[2].chain.hash = report.arms[1].chain.hash; },
  ];
  for (const mutate of mutations) { const report = experimentReport(); mutate(report); assert.equal(normalizeBehaviorPaperExperimentReport(report), null); }
});

test('owner ingest stores A/B/C separately and rejects replay while owner read remains legacy-compatible', async () => {
  const db = experimentDb(); const env = envFor(db);
  assert.equal((await post(experimentReport(), env)).status, 200);
  assert.ok(db.rows.has(BEHAVIOR_ABC_SNAPSHOT_SOURCE));
  assert.equal((await post(experimentReport(), env)).status, 409);
  const read = await worker.fetch(new Request('https://api.test/api/behavior-lab/paper', {
    headers: { authorization: 'Bearer owner-session' },
  }), env);
  assert.equal(read.status, 200);
  const body = await read.json();
  assert.equal(body.report, null);
  assert.equal(body.experiment.experiment_id, BEHAVIOR_ABC_EXPERIMENT_ID);
  assert.equal(body.experiment.shared_feed.credential_used, false);
});
