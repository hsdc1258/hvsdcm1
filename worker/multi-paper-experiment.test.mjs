import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './src/index.js';
import {
  BEHAVIOR_ABC_SNAPSHOT_SOURCE,
  BEHAVIOR_MULTI_EXPERIMENT_ID,
  BEHAVIOR_MULTI_SNAPSHOT_SOURCE,
  MAX_MULTI_PAPER_BYTES,
  normalizeBehaviorMultiPaperExperimentReport,
} from './src/router.js';

const HASHES = ['a', 'b', 'c', 'd', 'e', 'f', '9'].map((letter) => letter.repeat(64));
const SET_HASH = '26c95bb151fcca3cc3a869e4e6a3e8f47ad31eef5d2b75702fa1b698b9390941';
const STRATEGIES = [
  { id: 'multi-trend-persistence-v2', label: 'Trend persistence',
    definition_hash: 'f7b99ba12e2daaa0545663c7b59944baa810641d366e7657b60fa530bab8b9e1',
    policy: ['trend-continuation', ['trend-up', 'trend-down'], ['trendMomentum', 'orderFlow'], 3, 4, .34, 4, 32, 1.25, 10, 2] },
  { id: 'multi-breakout-confirmation-v2', label: 'Breakout confirmation',
    definition_hash: 'f9007a599040a6ba220231e34b4c801e5189e3a7cc70bbe3d061e53e8c76e635',
    policy: ['breakout-confirmation', ['trend-up', 'trend-down'], ['breakout', 'orderFlow'], 3, 4, .36, 3.5, 35, 1.3, 10, 2] },
  { id: 'multi-range-reversion-v2', label: 'Range reversion',
    definition_hash: '638712041d66469b7ff7785f85e0b67e809c61a1ce582299ed373f425c51aacc',
    policy: ['range-reversion', ['range'], ['meanReversion'], 2, 4, .34, 4, 32, 1.2, 10, 2] },
  { id: 'multi-ofi-continuation-v2', label: 'Order-flow continuation',
    definition_hash: '3cfd6c22d0982e411bcbb95aff9323e861a9056877e916f83fb07d7d3c6e99e4',
    policy: ['order-flow-continuation', ['trend-up', 'trend-down', 'range'], ['orderFlow'], 2, 5, .4, 3, 36, 1.35, 10, 2] },
  { id: 'multi-overreaction-fade-v2', label: 'Range overreaction fade',
    definition_hash: 'bbd73cbf1bf42f4bf9f35d5b60991e54c1c06276512202e25688b2507157ff3c',
    policy: ['overreaction-fade', ['range'], ['meanReversion'], 2, 4, .42, 3.5, 34, 1.4, 12, 2] },
  { id: 'multi-consensus-conservative-v2', label: 'Conservative consensus',
    definition_hash: 'a8280bb5356c1c7b780b90668878f69750b214724d210b17d608eb0fa85dd5bd',
    policy: ['multi-factor-consensus', ['trend-up', 'trend-down', 'range'], [], 3, 5, .44, 3, 38, 1.5, 15, 3] },
];

const policyObject = ([style, allowed_regimes, required_features, minimum_feature_agreement,
  min_persistence_seconds, entry_threshold, max_spread_bps, min_target_bps,
  min_net_reward_risk, cooldown_minutes, opposite_confirmations]) => ({ style, allowed_regimes,
  required_features, minimum_feature_agreement, min_persistence_seconds, entry_threshold,
  max_spread_bps, min_target_bps, min_net_reward_risk, cooldown_minutes, opposite_confirmations });

export function multiExperimentReport({ sequence = 10, status = 'active', maximal = false } = {}) {
  const effectiveSequence = maximal ? 64 : sequence;
  const safe240 = 'bounded simulation note. '.repeat(10).slice(0, 240);
  const safe400 = 'bounded note. '.repeat(31).slice(0, 400);
  const maximalReasons = ['warmup-incomplete', 'regime-warmup-incomplete', 'invalid-quote', 'stress-regime',
    'regime-mismatch', 'spread-too-wide', 'score-below-threshold', 'persistence-insufficient'];
  const arms = ['A', 'B', 'C', 'D', 'E', 'F'].map((armId, index) => {
    const strategy = STRATEGIES[index];
    const curveLength = maximal ? 64 : 2;
    const curve = Array.from({ length: curveLength }, (_, point) => ({
      sequence: point === curveLength - 1 ? effectiveSequence : point + 1,
      at: new Date(Date.parse('2026-08-31T00:00:00.000Z') + point * 1_000).toISOString(), equity: 100, net_pnl: 0 }));
    const trades = Array.from({ length: maximal ? 25 : 0 }, (_, trade) => ({ id: maximal ? safe240 : `trade-${armId}-${trade}`,
      symbol: 'BTCUSDT', direction: trade % 2 ? 'short' : 'long', opened_at: '2026-08-31T00:00:10.000Z',
      closed_at: '2026-08-31T00:00:40.000Z', entry_price: 100, exit_price: trade % 2 ? 99.88 : 100.12, quantity: 1,
      notional: 100, net_pnl: 0, return_pct: 0, fees: .12, slippage_cost: .08,
      reason: 'target' }));
    const decisions = Array.from({ length: maximal ? 20 : 1 }, (_, decision) => ({ symbol: 'BTCUSDT',
      signal_bar_at: new Date(Date.parse('2026-08-31T00:00:00.000Z') + decision * 1_000).toISOString(),
      observed_at: new Date(Date.parse('2026-08-31T00:01:00.000Z') + decision * 1_000).toISOString(),
      regime: 'range', direction: 'stand-aside', score: 0, confidence: 0, spread_bps: 1,
      feature_agreement: 1, target_distance_bps: 0, net_reward_risk: 0,
      gate_reasons: maximal ? maximalReasons : ['score-below-threshold'],
      feed_sequence: effectiveSequence, feed_hash: HASHES[6] }));
    const logs = Array.from({ length: maximal ? 30 : 2 }, (_, log) => ({ sequence: log + 1,
      at: new Date(Date.parse('2026-08-31T00:00:00.000Z') + log * 1_000).toISOString(),
      type: log ? 'decision' : 'arm-started',
      message: maximal ? safe240 : 'Fixed v2 event.' }));
    return { arm_id: armId, strategy: { id: strategy.id, label: strategy.label,
      definition_hash: strategy.definition_hash, policy: policyObject(strategy.policy) },
    risk: { risk_pct: 1.5, leverage_cap: 3, drawdown_halt_pct: 10, max_hold_minutes: 45,
      minimum_hold_before_opposite_minutes: 5 }, chain: { sequence: effectiveSequence, hash: HASHES[index] },
    status: 'active', seed_equity: 100, equity: 100, cash: 100, realized_pnl: 0, unrealized_pnl: 0,
    net_pnl: 0, return_pct: 0, max_drawdown_pct: 0, fees: trades.length * .12,
    slippage_cost: trades.length * .08, trade_count: trades.length, win_count: 0, loss_count: 0, equity_curve: curve,
    open_position: maximal ? { id: safe240, symbol: 'BTCUSDT', direction: 'long',
      opened_at: '2026-08-31T00:00:30.000Z', entry_price: 100, mark_price: 100, quantity: 1,
      notional: 100, leverage: 1, unrealized_pnl: 0, stop_price: 99, target_price: 103 } : null,
    recent_trades: trades, recent_decisions: decisions, recent_logs: logs,
    last_cycle_at: '2026-08-31T00:01:20.000Z' };
  });
  return { schema: 'multi-paper-experiment-v2', experiment_id: BEHAVIOR_MULTI_EXPERIMENT_ID,
    simulation: true, public_data_only: true, generated_at: '2026-08-31T00:02:00.000Z',
    started_at: '2026-08-31T00:00:00.000Z', deadline_at: '2026-09-01T00:00:00.000Z', status,
    strategy_set_hash: SET_HASH, shared_feed: { sequence: effectiveSequence, hash: HASHES[6],
      last_packet_at: '2026-08-31T00:01:30.000Z', credential_used: false,
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'], channels: ['ticker', 'books5', 'trade', 'candle1m'] },
    assumptions: { seed_equity_per_arm: 100, fee_bps_per_side: 6, slippage_bps_per_side: 4,
      modeled_round_trip_cost_bps: 20, risk_pct: 1.5, leverage_cap: 3, drawdown_halt_pct: 10,
      entry_cutoff_at: '2026-08-31T23:45:00.000Z', terminal_close: 'deadline', max_positions_per_arm: 1,
      strategy_mutation: false }, leaderboard: arms.map((arm, index) => ({ rank: index + 1,
      arm_id: arm.arm_id, equity: arm.equity, net_pnl: arm.net_pnl, return_pct: arm.return_pct,
      max_drawdown_pct: arm.max_drawdown_pct })), arms,
    limitations: maximal ? Array.from({ length: 12 }, () => safe400)
      : ['All figures are simulated.', 'One day is not statistical evidence.'] };
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
        assert.match(sql, /arms\[5\]\.chain/u);
        const [source, captured_at, payload] = this.values;
        const next = JSON.parse(payload);
        const priorRow = rows.get(source);
        const prior = priorRow ? JSON.parse(priorRow.payload) : null;
        const refs = (report) => [report.shared_feed, ...report.arms.map((arm) => arm.chain)];
        const monotonic = !prior || refs(next).every((ref, index) => ref.sequence >= refs(prior)[index].sequence
          && (ref.sequence > refs(prior)[index].sequence || ref.hash === refs(prior)[index].hash));
        const advanced = !prior || refs(next).some((ref, index) => ref.sequence > refs(prior)[index].sequence);
        const identical = priorRow?.payload === payload;
        if (!monotonic || (!advanced && !identical)) return { success: true, meta: { changes: 0 } };
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
    headers: { authorization: 'Bearer paper-secret', 'content-type': 'application/json' },
    body: JSON.stringify(report) }), env);
}

test('six-arm v2 normalization binds exact id, hashes, policies, lower risk, costs, and six unique chains', () => {
  const normalized = normalizeBehaviorMultiPaperExperimentReport(multiExperimentReport());
  assert.ok(normalized);
  assert.equal(normalized.experiment_id, BEHAVIOR_MULTI_EXPERIMENT_ID);
  assert.equal(normalized.strategy_set_hash, SET_HASH);
  assert.equal(normalized.arms.length, 6);
  assert.equal(new Set(normalized.arms.map((arm) => arm.chain.hash)).size, 6);
  assert.ok(normalized.arms.every((arm) => arm.risk.risk_pct === 1.5 && arm.risk.leverage_cap === 3
    && arm.strategy.policy.min_target_bps > normalized.assumptions.modeled_round_trip_cost_bps));
});

test('six-arm v2 rejects cross-schema/id/hash/source-like downgrade and malformed private data', () => {
  const mutations = [
    (report) => { report.schema = 'abc-paper-experiment-v1'; },
    (report) => { report.experiment_id = 'abc-paper-20260831'; },
    (report) => { report.strategy_set_hash = 'a'.repeat(64); },
    (report) => { report.arms[3].strategy.definition_hash = 'a'.repeat(64); },
    (report) => { report.arms[4].strategy.policy.max_spread_bps = 99; },
    (report) => { report.arms[0].recent_logs[0].message = 'accessToken=must-not-store'; },
    (report) => { report.unknown = true; },
  ];
  for (const mutate of mutations) {
    const report = multiExperimentReport(); mutate(report);
    assert.equal(normalizeBehaviorMultiPaperExperimentReport(report), null);
  }
});

test('actual v2 POST rejects impossible position, trade, count, state, and experiment status without a D1 write', async () => {
  const validPosition = { id: 'BTCUSDT-1-long', symbol: 'BTCUSDT', direction: 'long',
    opened_at: '2026-08-31T00:01:30.000Z', entry_price: 100, mark_price: 100, quantity: 1,
    notional: 100, leverage: 1, unrealized_pnl: 0, stop_price: 99, target_price: 103 };
  const validTrade = { id: 'BTCUSDT-0-long', symbol: 'BTCUSDT', direction: 'long',
    opened_at: '2026-08-31T00:00:10.000Z', closed_at: '2026-08-31T00:00:40.000Z',
    entry_price: 100, exit_price: 100.12, quantity: 1, notional: 100, net_pnl: 0, return_pct: 0,
    fees: .12, slippage_cost: .08, reason: 'target' };
  const mutations = [
    (report) => { report.arms[0].open_position = { ...validPosition, entry_price: -100, mark_price: -90,
      quantity: -1, notional: -100, stop_price: -110, target_price: -80 }; },
    (report) => { report.arms[0].open_position = { ...validPosition, quantity: 0, notional: 0 }; },
    (report) => { report.arms[0].open_position = { ...validPosition, opened_at: '2026-08-31T00:03:00.000Z' }; },
    (report) => { report.arms[0].open_position = { ...validPosition, stop_price: 101, target_price: 99 }; },
    (report) => { report.arms[0].recent_trades = [{ ...validTrade, entry_price: 0 }];
      report.arms[0].trade_count = 1; report.arms[0].fees = .12; report.arms[0].slippage_cost = .08; },
    (report) => { report.arms[0].recent_trades = [{ ...validTrade,
      opened_at: '2026-08-31T00:01:00.000Z', closed_at: '2026-08-31T00:00:40.000Z' }];
      report.arms[0].trade_count = 1; report.arms[0].fees = .12; report.arms[0].slippage_cost = .08; },
    (report) => { report.arms[0].recent_trades = [{ ...validTrade, closed_at: '2026-08-31T00:03:00.000Z' }];
      report.arms[0].trade_count = 1; report.arms[0].fees = .12; report.arms[0].slippage_cost = .08; },
    (report) => { report.arms[0].win_count = 1; },
    (report) => { report.arms[0].equity = 101; report.arms[0].net_pnl = 1; report.arms[0].return_pct = 1; },
    (report) => { report.status = 'complete'; for (const arm of report.arms) {
      arm.status = 'starting'; arm.recent_decisions = []; arm.last_cycle_at = null;
    } },
  ];
  for (const mutate of mutations) {
    const report = multiExperimentReport(); mutate(report);
    const db = experimentDb();
    const response = await post(report, envFor(db));
    assert.equal(response.status, 400);
    assert.equal(db.rows.has(BEHAVIOR_MULTI_SNAPSHOT_SOURCE), false);
  }
});

test('six-arm source is separate, monotonic, idempotent, and cannot touch the v1 row', async () => {
  const db = experimentDb(); const env = envFor(db);
  db.rows.set(BEHAVIOR_ABC_SNAPSHOT_SOURCE, { source: BEHAVIOR_ABC_SNAPSHOT_SOURCE,
    captured_at: '2026-08-31T00:00:00.000Z', payload: '{"immutable":"v1"}' });
  const first = await post(multiExperimentReport({ sequence: 10 }), env);
  assert.equal(first.status, 200);
  assert.ok(db.rows.has(BEHAVIOR_MULTI_SNAPSHOT_SOURCE));
  assert.equal(db.rows.get(BEHAVIOR_ABC_SNAPSHOT_SOURCE).payload, '{"immutable":"v1"}');
  assert.equal((await post(multiExperimentReport({ sequence: 10 }), env)).status, 200);
  assert.equal((await post(multiExperimentReport({ sequence: 9 }), env)).status, 409);
  assert.equal((await post(multiExperimentReport({ sequence: 11 }), env)).status, 200);
});

test('owner GET prefers a valid active v2 row and falls back when v2 is absent', async () => {
  const db = experimentDb(); const env = envFor(db);
  db.rows.set(BEHAVIOR_MULTI_SNAPSHOT_SOURCE, { source: BEHAVIOR_MULTI_SNAPSHOT_SOURCE,
    captured_at: '2026-08-31T00:02:01.000Z', payload: JSON.stringify(multiExperimentReport()) });
  db.rows.set(BEHAVIOR_ABC_SNAPSHOT_SOURCE, { source: BEHAVIOR_ABC_SNAPSHOT_SOURCE,
    captured_at: '2026-08-31T00:01:00.000Z', payload: '{"malformed":"ignored-while-v2-active"}' });
  let response = await worker.fetch(new Request('https://api.test/api/behavior-lab/paper', {
    headers: { authorization: 'Bearer owner-session' },
  }), env);
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.experiment.experiment_id, BEHAVIOR_MULTI_EXPERIMENT_ID);
  assert.equal(body.experiment_received_at, '2026-08-31T00:02:01.000Z');
  db.rows.delete(BEHAVIOR_MULTI_SNAPSHOT_SOURCE);
  db.rows.delete(BEHAVIOR_ABC_SNAPSHOT_SOURCE);
  response = await worker.fetch(new Request('https://api.test/api/behavior-lab/paper', {
    headers: { authorization: 'Bearer owner-session' },
  }), env);
  body = await response.json();
  assert.equal(body.experiment, null);
});

test('measured maximal six-arm report fits its exact cap and one-byte or one-element overflow is rejected', async () => {
  const maximal = multiExperimentReport({ maximal: true });
  assert.ok(normalizeBehaviorMultiPaperExperimentReport(maximal));
  const measuredBytes = Buffer.byteLength(JSON.stringify(maximal));
  assert.ok(measuredBytes < MAX_MULTI_PAPER_BYTES, `${measuredBytes} must fit ${MAX_MULTI_PAPER_BYTES}`);
  const db = experimentDb(); const env = envFor(db);
  assert.equal((await post(maximal, env)).status, 200);

  const envelopeBytes = Buffer.byteLength(JSON.stringify({ padding: '' }));
  const overflowBody = JSON.stringify({ padding: 'x'.repeat(MAX_MULTI_PAPER_BYTES - envelopeBytes + 1) });
  assert.equal(Buffer.byteLength(overflowBody), MAX_MULTI_PAPER_BYTES + 1);
  const overflow = await worker.fetch(new Request('https://api.test/api/behavior-lab/paper/report', { method: 'POST',
    headers: { authorization: 'Bearer paper-secret', 'content-type': 'application/json' }, body: overflowBody }), env);
  assert.equal(overflow.status, 413);

  const curveOverflow = multiExperimentReport({ maximal: true });
  curveOverflow.arms[0].chain.sequence = 65; curveOverflow.shared_feed.sequence = 65;
  curveOverflow.arms[0].equity_curve.push({ sequence: 65, at: '2026-08-31T00:01:04.000Z', equity: 100, net_pnl: 0 });
  assert.equal(normalizeBehaviorMultiPaperExperimentReport(curveOverflow), null);
  const decisionOverflow = multiExperimentReport({ maximal: true });
  decisionOverflow.arms[0].recent_decisions.push({ ...decisionOverflow.arms[0].recent_decisions[0] });
  assert.equal(normalizeBehaviorMultiPaperExperimentReport(decisionOverflow), null);
  console.log(`MULTI_V2_MAX_BYTES=${measuredBytes} CAP=${MAX_MULTI_PAPER_BYTES} HEADROOM=${MAX_MULTI_PAPER_BYTES - measuredBytes}`);
});
