import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import worker from './src/index.js';
import {
  BEHAVIOR_ABC_SNAPSHOT_SOURCE,
  BEHAVIOR_MULTI_CONTROL_SOURCE,
  BEHAVIOR_MULTI_EXPERIMENT_ID,
  BEHAVIOR_MULTI_SNAPSHOT_SOURCE,
  MAX_MULTI_PAPER_BYTES,
  normalizeBehaviorMultiPaperExperimentReport,
} from './src/router.js';

const HASHES = ['a', 'b', 'c', 'd', 'e', 'f', '9'].map((letter) => letter.repeat(64));
const SET_HASH = 'e8c8095f59bab11d6a6c1060c6278fa37af07a2101073391eaa2bec405c671ac';
const FEE_RATE = 6 / 10_000;
const ADVERSE_SLIPPAGE_RATE = 4 / 10_000;
const OWNER_SESSION_HASH = createHash('sha256').update('owner-session').digest('hex');
const STRATEGIES = [
  { id: 'multi-trend-persistence-v3', label: 'Trend persistence',
    definition_hash: '61b98082823a210087ace1472883fe18a8f6f8268dec9f53e76b3b3b72ad8ae4',
    policy: ['trend-continuation', ['trend-up', 'trend-down'], ['trendMomentum'], 2, 3, .28, 4, 32, 1.25, 10, 2] },
  { id: 'multi-breakout-confirmation-v3', label: 'Breakout confirmation',
    definition_hash: '8873352d336b081916e70bae1ee83e22bbc3e369f8592d7063b0f5131b7aaee7',
    policy: ['breakout-confirmation', ['trend-up', 'trend-down', 'range'], ['breakout'], 2, 3, .28, 3.5, 35, 1.25, 10, 2] },
  { id: 'multi-range-reversion-v3', label: 'Range reversion',
    definition_hash: 'db16839b63dcd67f00bae7e134842530a83a4deed823cfbd8ae800d189f95edd',
    policy: ['range-reversion', ['range'], ['meanReversion'], 2, 4, .34, 4, 32, 1.2, 10, 2] },
  { id: 'multi-ofi-continuation-v3', label: 'Order-flow continuation',
    definition_hash: '35df86229264db1e3ae426e80205384103af9fa1226e0c7a78c1af5244512e0e',
    policy: ['order-flow-continuation', ['trend-up', 'trend-down', 'range'], ['orderFlow'], 2, 5, .4, 3, 36, 1.25, 10, 2] },
  { id: 'multi-overreaction-fade-v3', label: 'Range overreaction fade',
    definition_hash: 'd1173d71fe7a07e8b95e5bc84e3bbc9cdeb2de63aa0f0529c773d5b0acd8b65e',
    policy: ['overreaction-fade', ['range'], ['meanReversion'], 2, 4, .42, 3.5, 34, 1.25, 12, 2] },
  { id: 'multi-consensus-conservative-v3', label: 'Conservative consensus',
    definition_hash: '9adcbd0ffed74e9d26bbc971b8c66a5f4cb3113bc1236b68a690e5856d9c109b',
    policy: ['multi-factor-consensus', ['trend-up', 'trend-down', 'range'], [], 2, 4, .34, 3, 38, 1.3, 15, 3] },
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
    const trades = Array.from({ length: maximal ? 25 : 0 }, (_, trade) => ({ id: maximal ? safe240 : `trade-${armId}-${trade}`,
      symbol: 'BTCUSDT', direction: 'long', opened_at: '2026-08-31T00:00:10.000Z',
      closed_at: '2026-08-31T00:00:40.000Z', entry_price: 100, exit_price: 101, quantity: 1,
      notional: 100, net_pnl: .8794, return_pct: .8794, fees: .1206, slippage_cost: .08,
      reason: 'target' }));
    const closedNetPnl = trades.reduce((sum, trade) => sum + trade.net_pnl, 0);
    const preEntryEquity = 100 + closedNetPnl;
    const entryFee = maximal ? 100 * FEE_RATE : 0;
    const openUnrealizedPnl = maximal
      ? (100 * (1 - ADVERSE_SLIPPAGE_RATE) - 100) - 100 * (1 - ADVERSE_SLIPPAGE_RATE) * FEE_RATE : 0;
    const finalCash = preEntryEquity - entryFee;
    const finalEquity = finalCash + openUnrealizedPnl;
    const netPnl = finalEquity - 100;
    const maxDrawdownPct = maximal ? (preEntryEquity - finalEquity) / preEntryEquity * 100 : 0;
    const curve = Array.from({ length: curveLength }, (_, point) => ({
      sequence: point === curveLength - 1 ? effectiveSequence : point + 1,
      at: new Date(Date.parse('2026-08-31T00:00:00.000Z') + point * 1_000).toISOString(),
      equity: point === curveLength - 1 ? finalEquity : 100,
      net_pnl: point === curveLength - 1 ? netPnl : 0 }));
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
      message: maximal ? safe240 : 'Fixed v3 event.' }));
    return { arm_id: armId, strategy: { id: strategy.id, label: strategy.label,
      definition_hash: strategy.definition_hash, policy: policyObject(strategy.policy) },
    risk: { risk_pct: 1.5, leverage_cap: 3, drawdown_halt_pct: 10, max_hold_minutes: 45,
      minimum_hold_before_opposite_minutes: 5 }, chain: { sequence: effectiveSequence, hash: HASHES[index] },
    status: 'active', seed_equity: 100, equity: finalEquity, cash: finalCash,
    realized_pnl: finalCash - 100, unrealized_pnl: openUnrealizedPnl, net_pnl: netPnl, return_pct: netPnl,
    max_drawdown_pct: maxDrawdownPct, fees: trades.length * .1206 + entryFee,
    slippage_cost: trades.length * .08 + (maximal ? .04 : 0), trade_count: trades.length,
    win_count: trades.length, loss_count: 0, equity_curve: curve,
    open_position: maximal ? { id: safe240, symbol: 'BTCUSDT', direction: 'long',
      opened_at: '2026-08-31T00:00:50.000Z', entry_price: 100, mark_price: 100, quantity: 1,
      notional: 100, leverage: 100 / preEntryEquity, unrealized_pnl: openUnrealizedPnl,
      stop_price: 99, target_price: 103 } : null,
    recent_trades: trades, recent_decisions: decisions, recent_logs: logs,
    last_cycle_at: '2026-08-31T00:01:20.000Z' };
  });
  const generatedAt = status === 'complete' ? '2026-08-31T00:02:00.000Z' : '2026-08-31T00:02:00.000Z';
  return { schema: 'multi-paper-experiment-v3', experiment_id: BEHAVIOR_MULTI_EXPERIMENT_ID,
    simulation: true, public_data_only: true, generated_at: '2026-08-31T00:02:00.000Z',
    started_at: '2026-08-31T00:00:00.000Z', run_mode: 'until-stopped', deadline_at: null,
    stopped_at: status === 'complete' ? generatedAt : null, status,
    strategy_set_hash: SET_HASH, shared_feed: { sequence: effectiveSequence, hash: HASHES[6],
      last_packet_at: '2026-08-31T00:01:30.000Z', credential_used: false,
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'], channels: ['ticker', 'books5', 'trade', 'candle1m'] },
    assumptions: { seed_equity_per_arm: 100, fee_bps_per_side: 6, slippage_bps_per_side: 4,
      modeled_round_trip_cost_bps: 20, risk_pct: 1.5, leverage_cap: 3, drawdown_halt_pct: 10,
      entry_cutoff_at: null, terminal_close: 'owner-stop', max_positions_per_arm: 1,
      strategy_mutation: false }, leaderboard: arms.map((arm, index) => ({ rank: index + 1,
      arm_id: arm.arm_id, equity: arm.equity, net_pnl: arm.net_pnl, return_pct: arm.return_pct,
      max_drawdown_pct: arm.max_drawdown_pct })), arms,
    limitations: maximal ? Array.from({ length: 12 }, () => safe400)
      : ['All figures are simulated.', 'One day is not statistical evidence.'] };
}

function experimentDb(username = 'hvsdcm') {
  const rows = new Map();
  return { rows, prepare(sql) {
    return { values: [], bind(...values) { this.values = values; return this; },
      async first() {
        if (sql.includes('SELECT s.*, u.username')) return this.values[0] === OWNER_SESSION_HASH
          ? { token_hash: OWNER_SESSION_HASH, role: 'user', disabled: 0, username } : null;
        if (sql.includes('FROM usage_snapshots')) return rows.get(this.values[0]) || null;
        throw new Error(`Unexpected first SQL: ${sql}`);
      },
      async run() {
        if (sql.includes('UPDATE sessions')) return { success: true, meta: { changes: 1 } };
        if (!sql.includes('INSERT INTO usage_snapshots')) throw new Error(`Unexpected run SQL: ${sql}`);
        const [source, captured_at, payload] = this.values;
        if (source === BEHAVIOR_MULTI_CONTROL_SOURCE) {
          if (rows.has(source)) return { success: true, meta: { changes: 0 } };
          rows.set(source, { source, captured_at, payload });
          return { success: true, meta: { changes: 1 } };
        }
        assert.match(sql, /arms\[5\]\.chain/u);
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

function envFor(db, overrides = {}) {
  return { ALLOWED_ORIGIN: 'https://hvsdcm1.xyz', OWNER_USERNAME: 'hvsdcm,claude-test',
    BEHAVIOR_OWNER_USERNAME: 'hvsdcm', BEHAVIOR_PAPER_REPORT_TOKEN: 'paper-secret', DB: db, ...overrides };
}
function post(report, env) {
  return worker.fetch(new Request('https://api.test/api/behavior-lab/paper/report', { method: 'POST',
    headers: { authorization: 'Bearer paper-secret', 'content-type': 'application/json' },
    body: JSON.stringify(report) }), env);
}

function installOpenPosition(report, position) {
  const arm = report.arms[0];
  arm.open_position = position;
  arm.cash = 99.94; arm.realized_pnl = -.06; arm.unrealized_pnl = position.unrealized_pnl;
  arm.equity = arm.cash + arm.unrealized_pnl; arm.net_pnl = arm.equity - 100; arm.return_pct = arm.net_pnl;
  arm.max_drawdown_pct = Math.max(0, -arm.net_pnl); arm.fees = .06;
  arm.equity_curve.at(-1).equity = arm.equity; arm.equity_curve.at(-1).net_pnl = arm.net_pnl;
  syncLeaderboard(report);
}

function installClosedTrade(report, trade) {
  const arm = report.arms[0];
  arm.open_position = null; arm.recent_trades = [trade]; arm.trade_count = 1;
  arm.win_count = trade.net_pnl > 0 ? 1 : 0; arm.loss_count = trade.net_pnl < 0 ? 1 : 0;
  arm.cash = 100 + trade.net_pnl; arm.realized_pnl = trade.net_pnl; arm.unrealized_pnl = 0;
  arm.equity = arm.cash; arm.net_pnl = trade.net_pnl; arm.return_pct = trade.net_pnl;
  arm.max_drawdown_pct = Math.max(0, -trade.net_pnl); arm.fees = trade.fees;
  arm.slippage_cost = trade.slippage_cost;
  arm.equity_curve.at(-1).equity = arm.equity; arm.equity_curve.at(-1).net_pnl = arm.net_pnl;
  syncLeaderboard(report);
}

function syncLeaderboard(report) {
  report.leaderboard = [...report.arms].sort((left, right) => right.equity - left.equity
    || left.arm_id.localeCompare(right.arm_id)).map((entry, index) => ({ rank: index + 1,
    arm_id: entry.arm_id, equity: entry.equity, net_pnl: entry.net_pnl, return_pct: entry.return_pct,
    max_drawdown_pct: entry.max_drawdown_pct }));
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
  assert.equal(normalized.run_mode, 'until-stopped');
  assert.equal(normalized.deadline_at, null);
  assert.equal(normalized.assumptions.terminal_close, 'owner-stop');
});

test('six-arm normalizer retains fixed-24h rollout compatibility while enforcing continuous stop semantics', () => {
  const legacy = multiExperimentReport();
  delete legacy.run_mode; delete legacy.stopped_at;
  legacy.deadline_at = '2026-09-01T00:00:00.000Z';
  legacy.assumptions.entry_cutoff_at = '2026-08-31T23:45:00.000Z';
  legacy.assumptions.terminal_close = 'deadline';
  assert.ok(normalizeBehaviorMultiPaperExperimentReport(legacy));
  const mutations = [
    (report) => { report.deadline_at = '2026-09-01T00:00:00.000Z'; },
    (report) => { report.stopped_at = report.generated_at; },
    (report) => { report.assumptions.terminal_close = 'deadline'; },
  ];
  for (const mutate of mutations) {
    const report = multiExperimentReport(); mutate(report);
    assert.equal(normalizeBehaviorMultiPaperExperimentReport(report), null);
  }
});

test('exact owner can request one idempotent stop and only the ingest reporter can poll it', async () => {
  const db = experimentDb(); const env = envFor(db);
  db.rows.set(BEHAVIOR_MULTI_SNAPSHOT_SOURCE, { source: BEHAVIOR_MULTI_SNAPSHOT_SOURCE,
    captured_at: '2026-08-31T00:02:01.000Z', payload: JSON.stringify(multiExperimentReport()) });
  const stopRequest = () => worker.fetch(new Request('https://api.test/api/behavior-lab/paper/stop', {
    method: 'POST', headers: { authorization: 'Bearer owner-session', 'content-type': 'application/json' },
    body: JSON.stringify({ experiment_id: BEHAVIOR_MULTI_EXPERIMENT_ID }),
  }), env);
  const first = await stopRequest();
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  assert.equal(firstBody.stop_requested, true);
  assert.ok(Number.isFinite(Date.parse(firstBody.stop_requested_at)));
  const second = await stopRequest();
  assert.equal(second.status, 202);
  assert.equal((await second.json()).stop_requested_at, firstBody.stop_requested_at);
  const control = await worker.fetch(new Request(`https://api.test/api/behavior-lab/paper/control?experiment_id=${BEHAVIOR_MULTI_EXPERIMENT_ID}`, {
    headers: { authorization: 'Bearer paper-secret' },
  }), env);
  assert.equal(control.status, 200);
  assert.deepEqual(await control.json(), { experiment_id: BEHAVIOR_MULTI_EXPERIMENT_ID,
    stop_requested: true, stop_requested_at: firstBody.stop_requested_at });
  const unauthorized = await worker.fetch(new Request(`https://api.test/api/behavior-lab/paper/control?experiment_id=${BEHAVIOR_MULTI_EXPERIMENT_ID}`), env);
  assert.equal(unauthorized.status, 401);
  const ownerBearerOnControl = await worker.fetch(new Request(`https://api.test/api/behavior-lab/paper/control?experiment_id=${BEHAVIOR_MULTI_EXPERIMENT_ID}`, {
    headers: { authorization: 'Bearer owner-session' },
  }), env);
  assert.equal(ownerBearerOnControl.status, 401);
  const nonOwner = envFor(experimentDb('claude-test'));
  nonOwner.DB.rows.set(BEHAVIOR_MULTI_SNAPSHOT_SOURCE, db.rows.get(BEHAVIOR_MULTI_SNAPSHOT_SOURCE));
  const nonOwnerStop = await worker.fetch(new Request('https://api.test/api/behavior-lab/paper/stop', {
    method: 'POST', headers: { authorization: 'Bearer owner-session', 'content-type': 'application/json' },
    body: JSON.stringify({ experiment_id: BEHAVIOR_MULTI_EXPERIMENT_ID }),
  }), nonOwner);
  assert.equal(nonOwnerStop.status, 404);
  const reportBearerStop = await worker.fetch(new Request('https://api.test/api/behavior-lab/paper/stop', {
    method: 'POST', headers: { authorization: 'Bearer paper-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ experiment_id: BEHAVIOR_MULTI_EXPERIMENT_ID }),
  }), env);
  assert.equal(reportBearerStop.status, 401);
  const wrongExperiment = await worker.fetch(new Request('https://api.test/api/behavior-lab/paper/stop', {
    method: 'POST', headers: { authorization: 'Bearer owner-session', 'content-type': 'application/json' },
    body: JSON.stringify({ experiment_id: 'multi-paper-wrong' }),
  }), env);
  assert.equal(wrongExperiment.status, 400);
  const missingOwnerConfig = await worker.fetch(new Request('https://api.test/api/behavior-lab/paper/stop', {
    method: 'POST', headers: { authorization: 'Bearer owner-session', 'content-type': 'application/json' },
    body: JSON.stringify({ experiment_id: BEHAVIOR_MULTI_EXPERIMENT_ID }),
  }), envFor(experimentDb(), { BEHAVIOR_OWNER_USERNAME: '' }));
  assert.equal(missingOwnerConfig.status, 404);
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
    notional: 100, leverage: 1, unrealized_pnl: -.099976, stop_price: 99, target_price: 103 };
  const validTrade = { id: 'BTCUSDT-0-long', symbol: 'BTCUSDT', direction: 'long',
    opened_at: '2026-08-31T00:00:10.000Z', closed_at: '2026-08-31T00:00:40.000Z',
    entry_price: 100, exit_price: 101, quantity: 1, notional: 100, net_pnl: .8794, return_pct: .8794,
    fees: .1206, slippage_cost: .08, reason: 'target' };
  const mutations = [
    (report) => { installOpenPosition(report, { ...validPosition, entry_price: -100, mark_price: -90,
      quantity: -1, notional: -100, stop_price: -110, target_price: -80 }); },
    (report) => { installOpenPosition(report, { ...validPosition, quantity: 0, notional: 0 }); },
    (report) => { installOpenPosition(report, { ...validPosition, opened_at: '2026-08-31T00:03:00.000Z' }); },
    (report) => { installOpenPosition(report, { ...validPosition, stop_price: 101, target_price: 99 }); },
    (report) => { installOpenPosition(report, { ...validPosition, mark_price: 110 }); },
    (report) => { installOpenPosition(report, { ...validPosition, leverage: 2 }); },
    (report) => { installClosedTrade(report, { ...validTrade, entry_price: 0 }); },
    (report) => { installClosedTrade(report, { ...validTrade,
      opened_at: '2026-08-31T00:01:00.000Z', closed_at: '2026-08-31T00:00:40.000Z' }); },
    (report) => { installClosedTrade(report, { ...validTrade, closed_at: '2026-08-31T00:03:00.000Z' }); },
    (report) => { installClosedTrade(report, { ...validTrade, fees: 0, net_pnl: 1, return_pct: 1 }); },
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
