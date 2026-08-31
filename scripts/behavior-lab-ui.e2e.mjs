import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1)));
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
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

function abcExperiment(sequence = 10) {
  const ids = ['abc-trend-momentum-v1', 'abc-breakout-volatility-v1', 'abc-mean-reversion-crowd-fade-v1'];
  const labels = ['Trend / momentum', 'Breakout / volatility', 'Mean reversion / crowd fade'];
  const hashes = [HASH_A, HASH_B, HASH_C];
  const arms = ['A', 'B', 'C'].map((armId, index) => ({
    arm_id: armId, strategy: { id: ids[index], label: labels[index], definition_hash: hashes[index] },
    chain: { sequence: sequence + index + 1, hash: hashes[index] }, status: 'active', seed_equity: 100,
    equity: 103 - index, cash: 103 - index, realized_pnl: 3 - index, unrealized_pnl: 0,
    net_pnl: 3 - index, return_pct: 3 - index, max_drawdown_pct: index + .5, fees: .1, slippage_cost: .1,
    trade_count: 1, win_count: 1, loss_count: 0, open_position: index === 0 ? { id: 'p-1', symbol: 'BTCUSDT',
      direction: 'long', opened_at: '2026-08-31T00:00:30.000Z', entry_price: 100, mark_price: 101,
      quantity: 1, notional: 100, unrealized_pnl: 1, stop_price: 99, target_price: 103 } : null,
    recent_trades: [], recent_decisions: [{ symbol: 'BTCUSDT', signal_bar_at: '2026-08-31T00:00:00.000Z',
      observed_at: '2026-08-31T00:01:00.000Z', direction: index === 2 ? 'stand-aside' : 'long', score: .3,
      confidence: 42, reason: index === 2 ? 'score-below-threshold' : null, feed_sequence: sequence, feed_hash: HASH_A }],
    recent_logs: [{ sequence: 1, at: '2026-08-31T00:00:00.000Z', type: 'arm-started',
      message: index === 0 ? '<img id="unsafe-abc" src=x onerror=alert(1)>' : 'Paper arm started.' }],
    last_cycle_at: '2026-08-31T00:01:00.000Z',
  }));
  return { schema: 'abc-paper-experiment-v1', experiment_id: 'abc-paper-20260831', simulation: true,
    public_data_only: true, generated_at: '2026-08-31T00:01:01.000Z', started_at: '2026-08-31T00:00:00.000Z',
    deadline_at: '2026-09-01T00:00:00.000Z', status: 'active', shared_feed: { sequence, hash: HASH_A,
      last_packet_at: '2026-08-31T00:01:00.000Z', credential_used: false,
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'], channels: ['ticker', 'books5', 'trade', 'candle1m'] },
    assumptions: { seed_equity_per_arm: 100, fee_bps_per_side: 6, slippage_bps_per_side: 4, risk_pct: 5,
      leverage_cap: 10, drawdown_halt_pct: 20, entry_cutoff_at: '2026-08-31T23:45:00.000Z',
      terminal_close: 'deadline', max_positions_per_arm: 1, strategy_mutation: false },
    leaderboard: arms.map((arm, index) => ({ rank: index + 1, arm_id: arm.arm_id, equity: arm.equity,
      net_pnl: arm.net_pnl, return_pct: arm.return_pct, max_drawdown_pct: arm.max_drawdown_pct })),
    arms, limitations: ['All figures are simulated.'] };
}

function browserHarness(responses) {
  localStorage.setItem('hvsdcm.token', 'owner-session');
  window.__paperResponses = responses;
  window.__paperFetchCount = 0;
  window.__paperHangs = [];
  window.fetch = async (url, options = {}) => {
    if (!String(url).includes('/api/behavior-lab/paper')) {
      return new Response(JSON.stringify({ error: 'dashboard omitted in paper UI fixture' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      });
    }
    window.__paperFetchCount += 1;
    const entry = window.__paperResponses.shift() || { status: 500, error: 'fixture exhausted' };
    const response = () => new Response(JSON.stringify(entry.status === 200 ? { report: entry.report, experiment: entry.experiment } : { error: entry.error || 'scripted error' }), {
      status: entry.status, headers: { 'content-type': 'application/json' },
    });
    if (entry.type === 'hang') {
      return new Promise((resolveRequest) => {
        window.__paperHangs.push(() => resolveRequest(new Response(JSON.stringify({ report: entry.lateReport }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })));
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
        body = Buffer.from(body.toString('utf8').replace('/behavior-lab/assets/js/app.js?v=20260831-v4',
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

async function assertGeometry(page, columns) {
  const geometry = await page.evaluate(() => {
    const panel = document.getElementById('paperAdaptive').getBoundingClientRect();
    const table = document.querySelector('#paperAdaptive .paper-table-wrap');
    const gridColumns = (selector) => getComputedStyle(document.querySelector(selector)).gridTemplateColumns.split(' ').filter(Boolean).length;
    return { pageWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      panelLeft: panel.left, panelRight: panel.right, viewport: innerWidth,
      tableContainsOverflow: table.scrollWidth >= table.clientWidth,
      summary: gridColumns('.adaptive-summary-grid'), state: gridColumns('.adaptive-state-grid'), detail: gridColumns('.adaptive-detail-grid'),
      abc: gridColumns('.abc-arm-grid') };
  });
  assert.ok(geometry.pageWidth <= geometry.clientWidth + 1, JSON.stringify(geometry));
  assert.ok(geometry.panelLeft >= -1 && geometry.panelRight <= geometry.viewport + 1, JSON.stringify(geometry));
  assert.equal(geometry.tableContainsOverflow, true);
  assert.deepEqual([geometry.summary, geometry.state, geometry.detail], columns);
  assert.equal(geometry.abc, columns[0] === 4 ? 3 : 1);
}

const { server, url } = await startServer();
const browser = await chromium.launch({ headless: true });
try {
  {
    const responses = [
      { status: 200, report: paperReport(9, 101), experiment: abcExperiment(10) },
      { status: 200, report: paperReport(10, 102, null), experiment: abcExperiment(11) },
      { status: 200, report: paperReport(11, 103), experiment: abcExperiment(12) },
    ];
    const { page, pageErrors } = await openFixture(browser, url, responses);
    await page.waitForSelector('#paperAdaptive:not([hidden])');
    assert.equal(await page.locator('#adaptiveChallengersBody tr').count(), 8);
    assert.equal(await page.locator('#adaptiveAudit li').count(), 20);
    assert.match(await page.locator('#adaptiveChampion').textContent(), /adaptive-balanced-v1/u);
    assert.match(await page.locator('#adaptiveAuditRef').textContent(), /#20/u);
    assert.equal(await page.locator('#unsafe-adaptive').count(), 0);
    assert.equal(await page.locator('#unsafe-abc').count(), 0);
    assert.equal(await page.locator('#experimentArms .abc-arm-card').count(), 3);
    assert.equal(await page.locator('#experimentLeaderboard tr').count(), 3);
    assert.match(await page.locator('#experimentFeed').textContent(), /#10/u);
    assert.match(await page.locator('#adaptiveAudit').textContent(), /<img id="unsafe-adaptive"/u);
    await assertGeometry(page, [4, 2, 2]);
    if (ARTIFACT_DIR) {
      await mkdir(ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: resolve(ARTIFACT_DIR, 'abc-dashboard-desktop.png'), fullPage: true });
    }

    await advance(page, 5_000);
    await page.waitForFunction(() => window.__paperFetchCount === 2 && document.getElementById('paperSequence').textContent === '10');
    assert.equal(await page.locator('#paperAdaptive').getAttribute('hidden'), '');
    await advance(page, 5_000);
    await page.waitForFunction(() => window.__paperFetchCount === 3 && !document.getElementById('paperAdaptive').hidden);
    assert.equal(await page.locator('#paperSequence').textContent(), '11');
    await page.setViewportSize({ width: 390, height: 844 });
    await assertGeometry(page, [1, 1, 1]);
    if (ARTIFACT_DIR) await page.screenshot({ path: resolve(ARTIFACT_DIR, 'abc-dashboard-mobile.png'), fullPage: true });
    assert.deepEqual(pageErrors, []);
    await page.close();
  }

  {
    const responses = [
      { status: 200, report: paperReport(1, 101) },
      { type: 'hang', lateReport: paperReport(99, 999) },
      { status: 200, report: paperReport(3, 103) },
      { type: 'hang', lateReport: paperReport(98, 998) },
      { status: 500, error: 'temporary failure' },
      { status: 200, report: paperReport(5, 105) },
      { status: 401, error: 'expired' },
    ];
    const { page, pageErrors } = await openFixture(browser, url, responses);
    await advance(page, 5_000);
    await page.waitForFunction(() => window.__paperFetchCount === 2);
    await page.locator('#refreshPaper').click();
    await page.waitForFunction(() => window.__paperFetchCount === 3 && document.getElementById('paperSequence').textContent === '3');
    await page.evaluate(() => window.__paperHangs.shift()());
    await page.waitForTimeout(20);
    assert.equal(await page.locator('#paperSequence').textContent(), '3');

    await advance(page, 5_000);
    await page.waitForFunction(() => window.__paperFetchCount === 4);
    await advance(page, 4_000);
    await page.waitForFunction(() => document.getElementById('paperReport').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#paperReport').getAttribute('data-freshness'), 'stale');
    assert.match(await page.locator('#paperErrorText').textContent(), /시간이 초과.*이전 보고/u);
    assert.equal(await page.locator('#paperEquity').textContent(), '103.00 USDT');
    await page.locator('#refreshPaper').click();
    await page.waitForFunction(() => window.__paperFetchCount === 5
      && document.getElementById('paperErrorText').textContent.includes('temporary failure'));
    assert.match(await page.locator('#paperErrorText').textContent(), /temporary failure.*이전 보고/u);
    await page.locator('#refreshPaper').click();
    await page.waitForFunction(() => window.__paperFetchCount === 6 && document.getElementById('paperSequence').textContent === '5');
    assert.equal(await page.locator('#paperReport').getAttribute('data-freshness'), 'fresh');
    assert.equal(await page.locator('#paperError').getAttribute('hidden'), '');
    await advance(page, 1_000);
    await page.waitForFunction(() => window.__paperFetchCount === 7 && !document.getElementById('ownerGate').hidden);
    assert.equal(await page.locator('#labShell').getAttribute('hidden'), '');
    assert.equal(await page.locator('#paperReport').getAttribute('hidden'), '');
    assert.equal(await page.locator('#paperAdaptive').getAttribute('hidden'), '');
    assert.deepEqual(pageErrors, []);
    await page.close();
  }

  for (const status of [401, 404]) {
    const { page, pageErrors } = await openFixture(browser, url, [
      { status: 200, report: paperReport(1, 101) }, { status, error: 'locked' },
    ]);
    await advance(page, 5_000);
    await page.waitForFunction(() => !document.getElementById('ownerGate').hidden);
    assert.equal(await page.locator('#labShell').getAttribute('hidden'), '');
    assert.deepEqual(pageErrors, []);
    await page.close();
  }

  {
    const mutatedUrl = url.replace('/#paper', '/?mutant=render#paper');
    const { page } = await openFixture(browser, mutatedUrl, [{ status: 200, report: paperReport(1, 101) }]);
    await assert.rejects(async () => {
      assert.equal(await page.locator('#paperAdaptive').getAttribute('hidden'), null);
    });
    await page.close();
  }
  {
    const mutatedUrl = url.replace('/#paper', '/?mutant=poll#paper');
    const { page } = await openFixture(browser, mutatedUrl, [
      { status: 200, report: paperReport(1, 101) }, { status: 200, report: paperReport(2, 102) },
    ]);
    await assert.rejects(async () => {
      await advance(page, 5_000);
      assert.equal(await page.evaluate(() => window.__paperFetchCount), 2);
    });
    await page.close();
  }
  console.log('BEHAVIOR LAB UI E2E PASS · real Chromium · polling/render/timeout/relock/recovery/bounds/mobile');
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  server.closeAllConnections?.();
}
