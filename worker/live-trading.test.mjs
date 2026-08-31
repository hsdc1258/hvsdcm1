import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import worker from './src/index.js';
import { BEHAVIOR_LIVE_EXPERIMENT_ID, BEHAVIOR_LIVE_SNAPSHOT_SOURCE, normalizeBehaviorLiveReport } from './src/router.js';

const ownerHash = createHash('sha256').update('owner-session').digest('hex');
const stable = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;

function report(sequence = 0) {
  const model = (id, name, style, symbols, leverage) => ({ id, name, style, symbols, allocation_usdt: 3,
    leverage_cap: leverage, status: 'blocked', status_message: '실거래 API 자격증명을 확인하지 못했습니다.',
    last_decision: null, open_order: null, trade_count: 0, win_count: 0, loss_count: 0, realized_pnl: 0,
    recent_decisions: [], recent_logs: [] });
  const unsigned = { schema: 'dual-live-v1', experiment_id: BEHAVIOR_LIVE_EXPERIMENT_ID, live_trading: true,
    generated_at: '2026-09-01T00:00:00.000Z', sequence, status: 'blocked',
    status_message: '실거래 API 자격증명이 필요합니다.',
    exchange: { name: 'Bitget', product: 'USDT-FUTURES', api: 'uta-v3', hold_mode: null },
    allocation: { per_model_usdt: 3, total_usdt: 6, mode: 'isolated-margin-hard-cap' },
    models: [model('beast', '야수의 심장', '수수료 반영 공격형 추세·돌파, 고레버리지', ['BTCUSDT', 'SOLUSDT'], 25),
      model('ddokdogi', '똑도기', '다중요인 합의와 보수적 확률 보정, 70% 문턱', ['ETHUSDT', 'XRPUSDT'], 6)],
    warnings: ['실거래이며 원금 손실과 강제청산이 발생할 수 있습니다.'] };
  return { ...unsigned, fingerprint: createHash('sha256').update(stable(unsigned)).digest('hex') };
}

function db() {
  const rows = new Map();
  return { rows, prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; },
    async first() {
      if (sql.includes('SELECT s.*, u.username')) return this.values[0] === ownerHash
        ? { token_hash: ownerHash, role: 'user', disabled: 0, username: 'hvsdcm' } : null;
      if (sql.includes('FROM usage_snapshots')) return rows.get(this.values[0]) || null;
      throw new Error(`Unexpected SQL: ${sql}`);
    }, async run() {
      if (sql.includes('UPDATE sessions')) return { meta: { changes: 1 } };
      const [source, captured_at, payload] = this.values; const prior = rows.get(source);
      const next = JSON.parse(payload); const previous = prior ? JSON.parse(prior.payload) : null;
      if (previous && next.sequence <= previous.sequence && payload !== prior.payload) return { meta: { changes: 0 } };
      rows.set(source, { source, captured_at, payload }); return { meta: { changes: 1 } };
    } }; } };
}

const envFor = (database) => ({ ALLOWED_ORIGIN: 'https://hvsdcm1.xyz', OWNER_USERNAME: 'hvsdcm',
  BEHAVIOR_OWNER_USERNAME: 'hvsdcm', BEHAVIOR_PAPER_REPORT_TOKEN: 'paper-secret', DB: database });
const post = (value, env) => worker.fetch(new Request('https://api.test/api/behavior-lab/live/report', {
  method: 'POST', headers: { authorization: 'Bearer paper-secret', 'content-type': 'application/json' },
  body: JSON.stringify(value) }), env);

test('live report is strict, fixed to two 3 USDT models, and owner-only readable', async () => {
  const database = db(); const env = envFor(database); const value = report();
  assert.ok(normalizeBehaviorLiveReport(value));
  const accepted = await post(value, env); assert.equal(accepted.status, 200);
  assert.equal(database.rows.has(BEHAVIOR_LIVE_SNAPSHOT_SOURCE), true);
  const denied = await worker.fetch(new Request('https://api.test/api/behavior-lab/live'), env);
  assert.equal(denied.status, 401);
  const read = await worker.fetch(new Request('https://api.test/api/behavior-lab/live', {
    headers: { authorization: 'Bearer owner-session' } }), env);
  assert.equal(read.status, 200); assert.equal((await read.json()).report.models[0].name, '야수의 심장');
});

test('live report rejects cap expansion, bad fingerprint, credentials, and rollback', async () => {
  const database = db(); const env = envFor(database);
  const expanded = report(); expanded.models[0].allocation_usdt = 4;
  assert.equal((await post(expanded, env)).status, 400);
  const credential = report(); credential.models[0].secret = 'should-never-arrive';
  assert.equal((await post(credential, env)).status, 400);
  const wrong = report(); wrong.fingerprint = 'a'.repeat(64);
  assert.equal((await post(wrong, env)).status, 400);
  assert.equal((await post(report(2), env)).status, 200);
  assert.equal((await post(report(1), env)).status, 409);
});
