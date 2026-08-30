import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import worker from './src/index.js';
import {
  BEHAVIOR_LAB_PUBLIC_BUDGET,
  BITGET_PUBLIC_HOST,
  BITGET_PUBLIC_PATHS,
  BehaviorLabRequestError,
  behaviorLabBudgetSnapshot,
  clearBehaviorLabCache,
  getBehaviorLabDashboard,
} from './src/behavior-lab.js';

const NOW = Date.parse('2026-08-31T03:00:00+09:00');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

function fixtureFor(url, mutation = () => {}) {
  const symbol = url.searchParams.get('symbol') || 'BTCUSDT';
  const candles = Array.from({ length: 130 }, (_, index) => {
    const open = 90_000 + index * 24;
    const close = open + 18;
    return [
      String(NOW - (129 - index) * 300_000),
      String(open),
      String(close + 15),
      String(open - 15),
      String(close),
      String(1_000 + index * 4),
      '0',
    ];
  });
  const behavior = Array.from({ length: 24 }, (_, index) => ({
    ts: String(NOW - (23 - index) * 300_000),
    longRatio: '0.5',
    shortRatio: '0.5',
  }));
  const taker = behavior.map((row) => ({ ts: row.ts, buyVolume: '140', sellVolume: '60' }));
  const ticker = (item, index = 0) => ({
    symbol: item,
    lastPr: String(93_100 + index * 100),
    change24h: '0.012',
    usdtVolume: String(1_000_000 + index),
    high24h: String(94_000 + index * 100),
    low24h: String(90_000 + index * 100),
    ts: String(NOW),
  });
  let data;
  switch (url.pathname) {
    case '/api/v2/mix/market/tickers': data = SYMBOLS.map(ticker); break;
    case '/api/v2/mix/market/ticker': data = [ticker(symbol)]; break;
    case '/api/v2/mix/market/candles': data = candles; break;
    case '/api/v2/mix/market/long-short': data = behavior; break;
    case '/api/v2/mix/market/taker-buy-sell': data = taker; break;
    case '/api/v2/mix/market/history-fund-rate': data = [{ symbol, fundingRate: '0.0001', fundingTime: String(NOW - 3_600_000) }]; break;
    case '/api/v2/mix/market/open-interest': data = { openInterestList: [{ symbol, size: '184205.31' }], ts: String(NOW) }; break;
    case '/api/v2/mix/market/contracts': data = [{ symbol, maxLever: '50' }]; break;
    default: throw new Error(`unexpected fixture path ${url.pathname}`);
  }
  const body = { code: '00000', msg: 'success', requestTime: NOW, data };
  mutation(body, url);
  return body;
}

function transport(mutation, ledger = []) {
  return async (input, init) => {
    const url = input instanceof URL ? input : new URL(input);
    ledger.push({ url, init });
    return new Response(JSON.stringify(fixtureFor(url, mutation)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('dashboard makes exactly the eight accepted public Bitget GETs and returns only validated live data', async () => {
  const ledger = [];
  const result = await getBehaviorLabDashboard(
    'https://worker.example/api/behavior-lab/dashboard?symbol=BTCUSDT&period=5m',
    { cache: false, nowMs: NOW, behaviorGapMs: 0, fetchImpl: transport(() => {}, ledger) },
  );

  assert.equal(result.source, 'live');
  assert.equal(result.quality, 'live');
  assert.equal(result.snapshot.symbol, 'BTCUSDT');
  assert.equal(result.snapshot.period, '5m');
  assert.equal(result.snapshot.candles.length, 130);
  assert.equal(result.snapshot.behaviorSeries.length, 24);
  assert.equal(result.signal.dataQuality, 'live');
  assert.deepEqual(ledger.map(({ url }) => url.pathname).sort(), [...BITGET_PUBLIC_PATHS].sort());
  assert.equal(ledger.length, 8);
  for (const { url, init } of ledger) {
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, BITGET_PUBLIC_HOST);
    assert.equal(init.method, 'GET');
    assert.deepEqual(init.headers, { accept: 'application/json' });
    assert.equal('credentials' in init, false);
    assert.equal('body' in init, false);
  }
});

test('unknown enums, duplicated keys, extra query input, and injection stop before network access', async () => {
  const attempted = [];
  const cases = [
    'symbol=DOGEUSDT&period=5m',
    'symbol=BTCUSDT&period=1d',
    'symbol=BTCUSDT%26productType%3Dcoin-futures&period=5m',
    'symbol=BTCUSDT&period=5m%26limit%3D999',
    'symbol=BTCUSDT&symbol=ETHUSDT&period=5m',
    'symbol=BTCUSDT&period=5m&url=https%3A%2F%2Fevil.example',
  ];
  for (const query of cases) {
    await assert.rejects(
      getBehaviorLabDashboard(`https://worker.example/api/behavior-lab/dashboard?${query}`, {
        cache: false,
        nowMs: NOW,
        behaviorGapMs: 0,
        fetchImpl: async (...args) => { attempted.push(args); throw new Error('must not run'); },
      }),
      (error) => error instanceof BehaviorLabRequestError && error.status === 400,
    );
  }
  assert.equal(attempted.length, 0);
});

test('stale, null, malformed, and timestamp-misaligned upstream data fail closed without a fallback', async () => {
  const mutations = [
    (body, url) => { if (url.pathname === '/api/v2/mix/market/ticker') body.data[0].ts = String(NOW - 3 * 60_000); },
    (body, url) => { if (url.pathname === '/api/v2/mix/market/candles') body.data[20][4] = null; },
    (body, url) => { if (url.pathname === '/api/v2/mix/market/open-interest') body.code = '99999'; },
    (body, url) => { if (url.pathname === '/api/v2/mix/market/taker-buy-sell') body.data = body.data.map((row) => ({ ...row, ts: String(Number(row.ts) + 1) })); },
  ];
  for (const mutation of mutations) {
    await assert.rejects(
      getBehaviorLabDashboard('https://worker.example/api/behavior-lab/dashboard?symbol=BTCUSDT&period=5m', {
        cache: false,
        nowMs: NOW,
        behaviorGapMs: 0,
        fetchImpl: transport(mutation),
      }),
      (error) => error instanceof BehaviorLabRequestError && error.status === 502,
    );
  }
});

test('the public route keeps CORS, method, and unknown-route behavior while invalid input stays bounded', async () => {
  const env = { ALLOWED_ORIGIN: 'https://hvsdcm1.xyz' };
  const invalid = await worker.fetch(new Request(
    'https://worker.example/api/behavior-lab/dashboard?symbol=BTCUSDT&period=bad',
    { headers: { origin: 'https://hvsdcm1.xyz' } },
  ), env);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('access-control-allow-origin'), 'https://hvsdcm1.xyz');
  assert.deepEqual(await invalid.json(), { error: '지원하지 않는 심볼 또는 주기입니다.' });

  const wrongMethod = await worker.fetch(new Request(
    'https://worker.example/api/behavior-lab/dashboard?symbol=BTCUSDT&period=5m',
    { method: 'POST', headers: { origin: 'https://hvsdcm1.xyz' } },
  ), env);
  assert.equal(wrongMethod.status, 404);
  assert.equal(wrongMethod.headers.get('access-control-allow-origin'), 'https://hvsdcm1.xyz');

  const unknown = await worker.fetch(new Request('https://worker.example/api/behavior-lab/unknown', {
    headers: { origin: 'https://hvsdcm1.xyz' },
  }), env);
  assert.equal(unknown.status, 404);
});

test('all 16 enums saturate within the module budget and overflow never starts upstream later', async () => {
  clearBehaviorLabCache();
  const ledger = [];
  const startedAt = Date.now();
  const requests = SYMBOLS.flatMap((symbol) => ['5m', '15m', '1h', '4h'].map((period) => (
    getBehaviorLabDashboard(`https://worker.example/api/behavior-lab/dashboard?symbol=${symbol}&period=${period}`, {
      nowMs: NOW,
      behaviorGapMs: 5,
      totalDeadlineMs: 500,
      fetchImpl: transport(() => {}, ledger),
    })
  )));
  const settled = await Promise.allSettled(requests);
  const elapsedMs = Date.now() - startedAt;
  const fulfilled = settled.filter((item) => item.status === 'fulfilled');
  const rejected = settled.filter((item) => item.status === 'rejected');
  assert.equal(fulfilled.length, BEHAVIOR_LAB_PUBLIC_BUDGET.maxActiveDashboardLoads);
  assert.equal(rejected.length, 16 - BEHAVIOR_LAB_PUBLIC_BUDGET.maxActiveDashboardLoads);
  assert.ok(rejected.every((item) => item.reason instanceof BehaviorLabRequestError && item.reason.status === 503));
  assert.ok(elapsedMs < BEHAVIOR_LAB_PUBLIC_BUDGET.totalDeadlineMs);

  const snapshot = behaviorLabBudgetSnapshot();
  assert.equal(snapshot.maxObservedActiveLoads, BEHAVIOR_LAB_PUBLIC_BUDGET.maxActiveDashboardLoads);
  assert.ok(snapshot.maxObservedBehaviorQueueDepth <= BEHAVIOR_LAB_PUBLIC_BUDGET.maxBehaviorQueueDepth);
  assert.equal(snapshot.upstreamStarts, BEHAVIOR_LAB_PUBLIC_BUDGET.maxActiveDashboardLoads * 8);
  assert.equal(snapshot.activeDashboardLoads, 0);
  assert.equal(snapshot.behaviorQueueDepth, 0);
  assert.equal(snapshot.behaviorReservations, 0);
  assert.ok(snapshot.cacheEntries <= BEHAVIOR_LAB_PUBLIC_BUDGET.maxCacheEntries);
  const startsAtSettlement = ledger.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ledger.length, startsAtSettlement);
});

test('the total deadline includes behavior queue wait and timed-out work never starts later', async () => {
  clearBehaviorLabCache();
  const ledger = [];
  await assert.rejects(
    getBehaviorLabDashboard('https://worker.example/api/behavior-lab/dashboard?symbol=BTCUSDT&period=5m', {
      cache: false,
      nowMs: NOW,
      behaviorGapMs: 60,
      timeoutMs: 1_000,
      totalDeadlineMs: 20,
      fetchImpl: transport(() => {}, ledger),
    }),
    (error) => error instanceof BehaviorLabRequestError && error.status === 503,
  );
  const startsAtTimeout = ledger.length;
  assert.equal(startsAtTimeout, 7);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(ledger.length, startsAtTimeout);
  assert.deepEqual(behaviorLabBudgetSnapshot(), {
    activeDashboardLoads: 0,
    behaviorQueueDepth: 0,
    behaviorReservations: 0,
    maxObservedActiveLoads: 1,
    maxObservedBehaviorQueueDepth: 2,
    upstreamStarts: 7,
    inflightEntries: 0,
    cacheEntries: 0,
  });
});

test('same-key loads dedupe and successful cache TTL starts at completion', async () => {
  clearBehaviorLabCache();
  let cacheClock = 0;
  const ledger = [];
  const delayedByClock = async (input, init) => {
    const url = input instanceof URL ? input : new URL(input);
    cacheClock += 3_000;
    ledger.push({ url, init });
    return new Response(JSON.stringify(fixtureFor(url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const url = 'https://worker.example/api/behavior-lab/dashboard?symbol=BTCUSDT&period=5m';
  const options = {
    nowMs: NOW,
    behaviorGapMs: 0,
    totalDeadlineMs: 60_000,
    clock: () => cacheClock,
    fetchImpl: delayedByClock,
  };
  const [first, deduped] = await Promise.all([
    getBehaviorLabDashboard(url, options),
    getBehaviorLabDashboard(url, options),
  ]);
  assert.deepEqual(deduped, first);
  assert.equal(ledger.length, 8);
  assert.equal(cacheClock, 24_000);

  cacheClock = 30_000;
  assert.deepEqual(await getBehaviorLabDashboard(url, options), first);
  assert.equal(ledger.length, 8);

  cacheClock = 40_000;
  await getBehaviorLabDashboard(url, options);
  assert.equal(ledger.length, 16);
});

test('the Worker boundary contains no credential, account, private, or trading request vocabulary', () => {
  const source = readFileSync(new URL('./src/behavior-lab.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /authorization|api[-_ ]?key|passphrase|signature/iu);
  assert.doesNotMatch(source, /\/api\/v\d+\/(?:mix\/)?(?:account|order|position|trade|private)(?:\/|['"`])/iu);
  assert.equal((source.match(/\/api\/v2\/mix\/market\//gu) || []).length >= 8, true);
});
