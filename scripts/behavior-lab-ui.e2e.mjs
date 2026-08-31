import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1)));
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);
const ARTIFACT_DIR = process.env.BEHAVIOR_LAB_E2E_ARTIFACT_DIR || '';

function adaptiveReport(sequence = 20) {
  return {
    engine_version: 'realtime-paper-v2', strategy_schema: 1, upgraded_at: '2026-08-30T18:30:00.000Z',
    cadence: { regime: '5m', candidate: 'completed-1m', risk: 'ticker-event', microstructure: '1s/3s-persistence',
      weight_checkpoint: '15m', challenger_checkpoint: '24h-minimum' },
    stream: { status: 'live', last_packet_at: '2026-08-30T18:59:59.000Z', reconnect_count: 2, credential_used: false },
    champion: { id: 'adaptive-balanced-v1', version: 1, hash: HASH_A },
    challengers: Array.from({ length: 8 }, (_, index) => ({ id: `adaptive-shadow-${index + 1}`, version: 1,
      hash: HASH_B, trade_count: index + 1, expectancy: .1 + index / 100,
      max_drawdown_pct: 1 + index / 10, cost_bps: 10 + index })),
    promotion: { status: 'collecting', last_checkpoint_at: null, from: null, to: null,
      reasons: ['minimum-evidence-not-yet-complete'] },
    audit: { sequence, hash: HASH_C, recent: Array.from({ length: 20 }, (_, index) => ({
      sequence: sequence - 19 + index, at: `2026-08-30T18:59:${String(40 + index).padStart(2, '0')}.000Z`,
      kind: 'checkpoint', message: index === 19 ? '<img id="unsafe-adaptive" src=x onerror=alert(1)>' : `checkpoint ${index + 1}`,
      hash: HASH_C,
    })) },
  };
}

function paperReport(sequence, equity, adaptive = adaptiveReport()) {
  return {
    session_id: 'paper-20260831-100usd', sequence, generated_at: '2026-08-30T19:00:00.000Z',
    deadline_at: '2026-08-30T23:00:00.000Z', status: 'active', simulation: true, seed_equity: 100,
    equity, cash: equity, realized_pnl: equity - 100, unrealized_pnl: 0, net_pnl: equity - 100,
    return_pct: equity - 100, max_drawdown_pct: 1, fees: .1, slippage_cost: .1,
    trade_count: 1, win_count: 1, loss_count: 0, open_position: null, recent_trades: [], recent_logs: [],
    last_cycle_at: '2026-08-30T18:59:59.000Z', limitations: ['All figures are simulated.'],
    ...(adaptive ? { adaptive } : {}),
  };
}

function multiExperiment(sequence = 10, status = 'active') {
  const ids = ['multi-trend-persistence-v2', 'multi-breakout-confirmation-v2', 'multi-range-reversion-v2',
    'multi-ofi-continuation-v2', 'multi-overreaction-fade-v2', 'multi-consensus-conservative-v2'];
  const labels = ['Trend persistence', 'Breakout confirmation', 'Range reversion',
    'Order-flow continuation', 'Range overreaction fade', 'Conservative consensus'];
  const hashes = [HASH_A, HASH_B, HASH_C, HASH_D, HASH_E, HASH_F];
  const arms = ['A', 'B', 'C', 'D', 'E', 'F'].map((armId, index) => ({
    arm_id: armId, strategy: { id: ids[index], label: labels[index], definition_hash: hashes[index],
      policy: { style: ['trend-continuation', 'breakout-confirmation', 'range-reversion', 'order-flow-continuation',
        'overreaction-fade', 'multi-factor-consensus'][index], allowed_regimes: ['range'], required_features: ['orderFlow'],
        minimum_feature_agreement: 2, min_persistence_seconds: 4, entry_threshold: .4, max_spread_bps: 3,
        min_target_bps: 36, min_net_reward_risk: 1.35, cooldown_minutes: 10, opposite_confirmations: 2 } },
    risk: { risk_pct: 1.5, leverage_cap: 3, drawdown_halt_pct: 10, max_hold_minutes: 45,
      minimum_hold_before_opposite_minutes: 5 },
    chain: { sequence, hash: hashes[index] }, status: index === 2 ? 'halted' : status, seed_equity: 100,
    equity: 103 - index, cash: 103 - index, realized_pnl: 3 - index, unrealized_pnl: 0,
    net_pnl: 3 - index, return_pct: 3 - index, max_drawdown_pct: index + .5, fees: .1, slippage_cost: .1,
    trade_count: 1, win_count: 1, loss_count: 0, open_position: index === 0 ? { id: 'p-1', symbol: 'BTCUSDT',
      direction: 'long', opened_at: '2026-08-31T00:00:30.000Z', entry_price: 100, mark_price: 101,
      quantity: 1, notional: 100, unrealized_pnl: 1, stop_price: 99, target_price: 103 } : null,
    equity_curve: [
      { sequence: 1, at: '2026-08-31T00:00:00.000Z', equity: 100, net_pnl: 0 },
      { sequence: 2, at: '2026-08-31T00:00:06.000Z', equity: 100.5 + index, net_pnl: .5 + index },
      { sequence, at: '2026-08-31T00:01:00.000Z', equity: 103 - index, net_pnl: 3 - index },
    ],
    recent_trades: [{ id: `trade-${armId}`, symbol: 'BTCUSDT', direction: 'long',
      opened_at: '2026-08-31T00:00:10.000Z', closed_at: '2026-08-31T00:00:40.000Z',
      entry_price: 100, exit_price: 101, quantity: 1, notional: 100, net_pnl: 1,
      return_pct: 1, fees: .1, slippage_cost: .1, reason: 'target' }],
    recent_decisions: [{ symbol: 'BTCUSDT', signal_bar_at: '2026-08-31T00:00:00.000Z',
      observed_at: '2026-08-31T00:01:00.000Z', regime: 'range',
      direction: index === 2 ? 'stand-aside' : 'long', score: .5, confidence: 72, spread_bps: 1,
      feature_agreement: 3, target_distance_bps: 80, net_reward_risk: 1.6,
      gate_reasons: index === 2 ? ['regime-mismatch'] : [], feed_sequence: sequence, feed_hash: HASH_A }],
    recent_logs: [{ sequence: 1, at: '2026-08-31T00:00:00.000Z', type: 'arm-started',
      message: index === 0 ? '<img id="unsafe-abc" src=x onerror=alert(1)>' : 'Paper arm started.' }],
    last_cycle_at: '2026-08-31T00:01:00.000Z',
  }));
  return { schema: 'multi-paper-experiment-v2', experiment_id: 'multi-paper-20260831-v2', simulation: true,
    public_data_only: true, generated_at: '2026-08-31T00:01:01.000Z', started_at: '2026-08-31T00:00:00.000Z',
    run_mode: 'until-stopped', deadline_at: null, stopped_at: null, status, strategy_set_hash: HASH_A,
    shared_feed: { sequence, hash: HASH_A,
      last_packet_at: '2026-08-31T00:01:00.000Z', credential_used: false,
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'], channels: ['ticker', 'books5', 'trade', 'candle1m'] },
    assumptions: { seed_equity_per_arm: 100, fee_bps_per_side: 6, slippage_bps_per_side: 4,
      modeled_round_trip_cost_bps: 20, risk_pct: 1.5, leverage_cap: 3, drawdown_halt_pct: 10,
      entry_cutoff_at: null,
      terminal_close: 'owner-stop', max_positions_per_arm: 1, strategy_mutation: false },
    leaderboard: arms.map((arm, index) => ({ rank: index + 1, arm_id: arm.arm_id, equity: arm.equity,
      net_pnl: arm.net_pnl, return_pct: arm.return_pct, max_drawdown_pct: arm.max_drawdown_pct })),
    arms, limitations: ['All figures are simulated.'] };
}

function browserHarness(responses) {
  localStorage.setItem('hvsdcm.token', 'owner-session');
  window.__paperResponses = responses;
  window.__paperFetchCount = 0;
  window.__paperStopRequests = [];
  window.__paperHangs = [];
  window.fetch = async (url, options = {}) => {
    if (!String(url).includes('/api/behavior-lab/paper')) {
      return new Response(JSON.stringify({ error: 'dashboard omitted in paper UI fixture' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/api/behavior-lab/paper/stop') && options.method === 'POST') {
      window.__paperStopRequests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, experiment_id: 'multi-paper-20260831-v2',
        stop_requested: true, stop_requested_at: '2026-08-31T00:03:00.000Z' }), {
        status: 202, headers: { 'content-type': 'application/json' },
      });
    }
    window.__paperFetchCount += 1;
    const entry = window.__paperResponses.shift() || { status: 500, error: 'fixture exhausted' };
    const response = () => new Response(JSON.stringify(entry.status === 200 ? { report: entry.report,
      experiment: entry.experiment, control: entry.control || { experiment_id: 'multi-paper-20260831-v2',
        stop_requested: false, stop_requested_at: null } } : { error: entry.error || 'scripted error' }), {
      status: entry.status, headers: { 'content-type': 'application/json' },
    });
    if (entry.type === 'hang') {
      return new Promise((resolveRequest) => {
        window.__paperHangs.push(() => resolveRequest(response()));
      });
    }
    return response();
  };

  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const schedule = (callback, delay, interval, args) => {
    const id = ++timerId;
    timers.set(id, { callback, due: now + Math.max(0, Number(delay) || 0), interval, args });
    return id;
  };
  window.setTimeout = (callback, delay, ...args) => schedule(callback, delay, 0, args);
  window.clearTimeout = (id) => timers.delete(id);
  window.setInterval = (callback, delay, ...args) => schedule(callback, delay, Math.max(1, Number(delay) || 1), args);
  window.clearInterval = (id) => timers.delete(id);
  window.__advanceTimers = async (milliseconds) => {
    const target = now + milliseconds;
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.due;
      if (timer.interval) timer.due += timer.interval;
      else timers.delete(id);
      timer.callback(...timer.args);
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    }
    now = target;
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  };
}

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const requested = new URL(request.url, 'http://localhost');
      const pathname = requested.pathname;
      const relative = pathname === '/' ? 'behavior-lab/index.html'
        : pathname === '/behavior-lab/' ? 'behavior-lab/index.html' : pathname.replace(/^\//u, '');
      const file = resolve(ROOT, relative);
      if (file !== ROOT && !file.startsWith(`${ROOT}${sep}`)) throw new Error('invalid path');
      let body = await readFile(file);
      const mutant = requested.searchParams.get('mutant');
      if (relative === 'behavior-lab/index.html' && mutant) {
        body = Buffer.from(body.toString('utf8').replace('/behavior-lab/assets/js/app.js?v=20260831-v8',
          `/behavior-lab/assets/js/app.js?mutant=${mutant}`));
      } else if (relative === 'behavior-lab/assets/js/app.js' && mutant === 'render') {
        body = Buffer.from(body.toString('utf8').replace('renderAdaptiveReport(report.adaptive);', 'renderAdaptiveReport(null);'));
      } else if (relative === 'behavior-lab/assets/js/app.js' && mutant === 'poll') {
        body = Buffer.from(body.toString('utf8').replace('if (state.ownerVerified) void loadPaper();', 'if (state.ownerVerified) void 0;'));
      }
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream';
      response.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return { server, url: `http://127.0.0.1:${server.address().port}/behavior-lab/#paper` };
}

async function openFixture(browser, url, responses, viewport = { width: 1280, height: 900 }) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(browserHarness, responses);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__paperFetchCount >= 1 && !document.getElementById('labShell').hidden);
  return { page, pageErrors };
}

async function advance(page, milliseconds) {
  await page.evaluate((value) => window.__advanceTimers(value), milliseconds);
  await page.waitForTimeout(20);
}

async function assertGeometry(page, expectedColumns) {
  const geometry = await page.evaluate(() => {
    const panel = document.getElementById('paperExperiment').getBoundingClientRect();
    const charts = [...document.querySelectorAll('.abc-equity-chart svg')].map((chart) => {
      const box = chart.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    });
    const gridColumns = (selector) => getComputedStyle(document.querySelector(selector)).gridTemplateColumns.split(' ').filter(Boolean).length;
    return { pageWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      panelLeft: panel.left, panelRight: panel.right, viewport: innerWidth,
      charts, abc: gridColumns('.abc-arm-grid') };
  });
  assert.ok(geometry.pageWidth <= geometry.clientWidth + 1, JSON.stringify(geometry));
  assert.ok(geometry.panelLeft >= -1 && geometry.panelRight <= geometry.viewport + 1, JSON.stringify(geometry));
  assert.equal(geometry.abc, expectedColumns);
  assert.equal(geometry.charts.length, 6);
  assert.ok(geometry.charts.every((chart) => chart.left >= -1 && chart.right <= geometry.viewport + 1 && chart.width > 0), JSON.stringify(geometry));
}

const { server, url } = await startServer();
const browser = await chromium.launch({ headless: true });
try {
  {
    const responses = [
      { status: 200, report: paperReport(9, 101), experiment: multiExperiment(10) },
      { type: 'hang', status: 500, error: 'temporary failure' },
      { status: 200, report: paperReport(11, 103), experiment: multiExperiment(12) },
      { status: 200, report: paperReport(12, 104), experiment: multiExperiment(13, 'complete') },
    ];
    const { page, pageErrors } = await openFixture(browser, url, responses);
    await page.waitForSelector('#paperExperiment:not([hidden])');
    assert.match(await page.locator('#paperStatus').textContent(), /ACTIVE/u);
    assert.equal(await page.locator('#paperReport').count(), 0);
    assert.equal(await page.getByText('실시간 엔진 · 재귀 개선 감사').count(), 0);
    assert.equal(await page.locator('#unsafe-abc').count(), 0);
    assert.equal(await page.locator('#experimentArms .abc-arm-card').count(), 6);
    assert.equal(await page.locator('#experimentLeaderboard tr').count(), 6);
    assert.equal(await page.locator('.abc-equity-chart svg').count(), 6);
    assert.deepEqual(await page.locator('.abc-equity-chart svg').evaluateAll((charts) => charts.map((chart) => Number(chart.dataset.pointCount))), [3, 3, 3, 3, 3, 3]);
    assert.equal(await page.locator('.abc-arm-section h4').filter({ hasText: '진입 정책 / 위험' }).count(), 6);
    assert.equal(await page.locator('.abc-arm-section h4').filter({ hasText: '최근 거래' }).count(), 6);
    assert.equal(await page.locator('.abc-arm-section h4').filter({ hasText: '현재 포지션' }).count(), 6);
    assert.equal(await page.locator('.abc-arm-section h4').filter({ hasText: '최근 판단' }).count(), 6);
    assert.equal(await page.locator('.abc-arm-section h4').filter({ hasText: '최근 로그' }).count(), 6);
    assert.match(await page.locator('.abc-arm-card').nth(0).textContent(), /trade-A|BTCUSDT/u);
    assert.match(await page.locator('#experimentFeed').textContent(), /#10/u);
    assert.equal(await page.locator('#stopPaper').isVisible(), true);
    await page.evaluate(() => { window.__initialArmNodes = [...document.querySelectorAll('.abc-arm-card')]; });
    const polylinePoints = (await page.locator('.abc-equity-chart polyline').first().getAttribute('points')).split(' ');
    assert.ok(Number(polylinePoints[1].split(',')[0]) < 100, polylinePoints.join(' '));
    await assertGeometry(page, 3);
    if (ARTIFACT_DIR) {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: resolve(ARTIFACT_DIR, 'abc-dashboard-desktop.png'), fullPage: true });
    }

    await advance(page, 5_000);
    await page.waitForFunction(() => window.__paperFetchCount === 2 && window.__paperHangs.length === 1);
    assert.equal(await page.locator('#paperExperiment').evaluate((element) => getComputedStyle(element).opacity), '1');
    assert.equal(await page.evaluate(() => window.__initialArmNodes.every((node, index) =>
      node === document.querySelectorAll('.abc-arm-card')[index])), true);
    await page.evaluate(() => window.__paperHangs.shift()());
    await page.waitForFunction(() => window.__paperFetchCount === 2 && !document.getElementById('paperError').hidden);
    assert.match(await page.locator('#paperStatus').textContent(), /STALE/u);
    assert.match(await page.locator('#paperErrorText').textContent(), /temporary failure.*이전 보고/u);
    assert.match(await page.locator('#experimentFeed').textContent(), /#10/u);
    assert.equal(await page.locator('#experimentArms .abc-arm-card').count(), 6);
    await page.locator('#refreshPaper').click();
    await page.waitForFunction(() => window.__paperFetchCount === 3 && document.getElementById('experimentFeed').textContent.includes('#12'));
    assert.match(await page.locator('#paperStatus').textContent(), /ACTIVE/u);
    assert.equal(await page.locator('#paperError').getAttribute('hidden'), '');
    assert.equal(await page.locator('#experimentArms .abc-arm-card').count(), 6);
    assert.equal(await page.evaluate(() => window.__initialArmNodes.every((node, index) =>
      node === document.querySelectorAll('.abc-arm-card')[index])), true);
    await page.locator('#stopPaper').click();
    await page.waitForFunction(() => window.__paperStopRequests.length === 1
      && document.getElementById('stopPaper').disabled
      && document.getElementById('stopPaper').textContent.includes('중단 요청됨'));
    assert.deepEqual(await page.evaluate(() => window.__paperStopRequests), [
      { experiment_id: 'multi-paper-20260831-v2' },
    ]);
    assert.match(await page.locator('#stopPaper').textContent(), /중단 요청됨/u);
    await page.setViewportSize({ width: 390, height: 844 });
    await assertGeometry(page, 1);
    if (ARTIFACT_DIR) await page.screenshot({ path: resolve(ARTIFACT_DIR, 'abc-dashboard-mobile.png'), fullPage: true });
    await advance(page, 5_000);
    await page.waitForFunction(() => window.__paperFetchCount === 4 && document.getElementById('paperExperiment').hidden);
    assert.equal(await page.locator('#experimentArms .abc-arm-card').count(), 0);
    assert.equal(await page.locator('#paperEmpty').getAttribute('hidden'), null);
    assert.deepEqual(pageErrors, []);
    await page.close();
  }

  for (const status of [401, 404]) {
    const { page, pageErrors } = await openFixture(browser, url, [
      { status: 200, experiment: multiExperiment(10) }, { status, error: 'locked' },
    ]);
    await advance(page, 5_000);
    await page.waitForFunction(() => !document.getElementById('ownerGate').hidden);
    assert.equal(await page.locator('#labShell').getAttribute('hidden'), '');
    assert.deepEqual(pageErrors, []);
    await page.close();
  }
  console.log('BEHAVIOR LAB UI E2E PASS · active-only six-arm v2 · 6 curves/policy details · refresh retention · finished hidden · mobile bounds');
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  server.closeAllConnections?.();
}
