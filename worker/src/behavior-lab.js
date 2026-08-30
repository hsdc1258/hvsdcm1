export const BEHAVIOR_LAB_SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']);
export const BEHAVIOR_LAB_PERIODS = Object.freeze(['5m', '15m', '1h', '4h']);
export const BITGET_PUBLIC_HOST = 'api.bitget.com';
export const BITGET_PUBLIC_PATHS = Object.freeze([
  '/api/v2/mix/market/tickers',
  '/api/v2/mix/market/ticker',
  '/api/v2/mix/market/candles',
  '/api/v2/mix/market/long-short',
  '/api/v2/mix/market/taker-buy-sell',
  '/api/v2/mix/market/history-fund-rate',
  '/api/v2/mix/market/open-interest',
  '/api/v2/mix/market/contracts',
]);

const BITGET_PATH_SET = new Set(BITGET_PUBLIC_PATHS);
const SYMBOL_SET = new Set(BEHAVIOR_LAB_SYMBOLS);
const PERIOD_SET = new Set(BEHAVIOR_LAB_PERIODS);
const PERIOD_TO_GRANULARITY = Object.freeze({ '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H' });
const PERIOD_MS = Object.freeze({ '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 });
const REQUEST_TIMEOUT_MS = 6_000;
const TOTAL_DEADLINE_MS = 12_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const CACHE_TTL_MS = 15_000;
const CACHE_LIMIT = BEHAVIOR_LAB_SYMBOLS.length * BEHAVIOR_LAB_PERIODS.length;
const MAX_ACTIVE_DASHBOARD_LOADS = 2;
const MAX_BEHAVIOR_QUEUE_DEPTH = MAX_ACTIVE_DASHBOARD_LOADS * 2;
const FUTURE_TOLERANCE_MS = 60_000;
const ENVELOPE_MAX_AGE_MS = 5 * 60_000;
const dashboardCache = new Map();
const inflight = new Map();
let behaviorTail = Promise.resolve();
let behaviorLastStartedAt = 0;
let activeDashboardLoads = 0;
let behaviorQueueDepth = 0;
let behaviorReservations = 0;
let maxObservedActiveLoads = 0;
let maxObservedBehaviorQueueDepth = 0;
let observedUpstreamStarts = 0;

export const BEHAVIOR_LAB_PUBLIC_BUDGET = Object.freeze({
  maxActiveDashboardLoads: MAX_ACTIVE_DASHBOARD_LOADS,
  maxDashboardQueueDepth: 0,
  maxBehaviorQueueDepth: MAX_BEHAVIOR_QUEUE_DEPTH,
  maxCacheEntries: CACHE_LIMIT,
  totalDeadlineMs: TOTAL_DEADLINE_MS,
});

export class BehaviorLabRequestError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'BehaviorLabRequestError';
    this.status = status;
  }
}

export function clearBehaviorLabCache() {
  dashboardCache.clear();
  inflight.clear();
  behaviorTail = Promise.resolve();
  behaviorLastStartedAt = 0;
  activeDashboardLoads = 0;
  behaviorQueueDepth = 0;
  behaviorReservations = 0;
  maxObservedActiveLoads = 0;
  maxObservedBehaviorQueueDepth = 0;
  observedUpstreamStarts = 0;
}

export function behaviorLabBudgetSnapshot() {
  return {
    activeDashboardLoads,
    behaviorQueueDepth,
    behaviorReservations,
    maxObservedActiveLoads,
    maxObservedBehaviorQueueDepth,
    upstreamStarts: observedUpstreamStarts,
    inflightEntries: inflight.size,
    cacheEntries: dashboardCache.size,
  };
}

function publicFailure() {
  return new BehaviorLabRequestError('공개 시장 데이터를 검증하지 못했습니다. 잠시 후 다시 시도하세요.');
}

function deadlineFailure() {
  return new BehaviorLabRequestError('공개 시장 요청 시간 한도를 초과했습니다. 잠시 후 다시 시도하세요.', 503);
}

function capacityFailure() {
  return new BehaviorLabRequestError('공개 시장 요청이 많습니다. 잠시 후 다시 시도하세요.', 503);
}

function remainingMs(context) {
  return context.deadlineAt - context.clock();
}

function requireActive(context) {
  if (context.cancelled || remainingMs(context) <= 0) throw deadlineFailure();
}

function cancelContext(context) {
  context.cancelled = true;
  for (const controller of context.controllers) controller.abort();
  context.controllers.clear();
}

function finite(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string'
    && (!value.trim() || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value.trim()))) return null;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function assertTimestamp(value, nowMs, maxAgeMs) {
  if (!Number.isFinite(value) || value <= 0 || value > nowMs + FUTURE_TOLERANCE_MS || nowMs - value > maxAgeMs) {
    throw publicFailure();
  }
}

function unwrap(value, nowMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.code !== '00000') {
    throw publicFailure();
  }
  const requestTime = finite(value.requestTime);
  assertTimestamp(requestTime, nowMs, ENVELOPE_MAX_AGE_MS);
  return { data: value.data, requestTime };
}

function parseTicker(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const rawChange = finite(row.change24h ?? row.changeUtc24h);
  const last = finite(row.lastPr ?? row.last);
  const quoteVolume = finite(row.usdtVolume ?? row.quoteVolume ?? row.baseVolume);
  const high24h = finite(row.high24h ?? row.high);
  const low24h = finite(row.low24h ?? row.low);
  const ts = finite(row.ts);
  const symbol = typeof row.symbol === 'string' ? row.symbol : '';
  if ([rawChange, last, quoteVolume, high24h, low24h, ts].some((item) => item === null)) return null;
  if (last <= 0 || quoteVolume < 0 || low24h <= 0 || high24h < low24h || ts <= 0) return null;
  return {
    symbol,
    last,
    change24h: Math.abs(rawChange) <= 1 ? rawChange * 100 : rawChange,
    quoteVolume,
    high24h,
    low24h,
    ts,
  };
}

function parseCandle(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const values = row.slice(0, 6).map(finite);
  if (values.some((value) => value === null)) return null;
  const [ts, open, high, low, close, volume] = values;
  if (ts <= 0 || open <= 0 || high < Math.max(open, close)
    || low <= 0 || low > Math.min(open, close) || close <= 0 || volume < 0) return null;
  return { ts, open, high, low, close, volume };
}

async function readBoundedJson(response) {
  const statedLength = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(statedLength) && statedLength > MAX_RESPONSE_BYTES) throw publicFailure();
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw publicFailure();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw publicFailure(); }
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw publicFailure();
  try { return JSON.parse(text); } catch { throw publicFailure(); }
}

async function publicGet(path, query, fetchImpl, timeoutMs, ledger, context) {
  requireActive(context);
  const url = new URL(`https://${BITGET_PUBLIC_HOST}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  if (url.protocol !== 'https:' || url.hostname !== BITGET_PUBLIC_HOST || !BITGET_PATH_SET.has(url.pathname)) {
    throw publicFailure();
  }
  for (const [key, value] of url.searchParams) {
    if (!/^[A-Za-z0-9._-]{1,40}$/u.test(key) || !/^[A-Za-z0-9._-]{1,80}$/u.test(value)) {
      throw publicFailure();
    }
  }
  const controller = new AbortController();
  context.controllers.add(controller);
  const requestBudgetMs = Math.min(timeoutMs, remainingMs(context));
  if (requestBudgetMs <= 0) {
    context.controllers.delete(controller);
    throw deadlineFailure();
  }
  const timeout = setTimeout(() => controller.abort(), requestBudgetMs);
  try {
    requireActive(context);
    observedUpstreamStarts += 1;
    ledger?.push({ method: 'GET', host: url.hostname, path: url.pathname, query: url.searchParams.toString() });
    const fetchPromise = fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      // Workerd implements no-follow as manual; redirect:"error" throws before any network I/O.
      redirect: 'manual',
      signal: controller.signal,
    });
    const abortPromise = new Promise((_, reject) => {
      const rejectAbort = () => reject(new Error('upstream aborted'));
      if (controller.signal.aborted) rejectAbort();
      else controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const response = await Promise.race([fetchPromise, abortPromise]);
    if (!response || !response.ok || response.status < 200 || response.status >= 300) throw publicFailure();
    return await readBoundedJson(response);
  } catch (error) {
    if (error instanceof BehaviorLabRequestError) throw error;
    if (context.cancelled || remainingMs(context) <= 0) throw deadlineFailure();
    throw publicFailure();
  } finally {
    clearTimeout(timeout);
    context.controllers.delete(controller);
  }
}

function behaviorPublicGet(job, gapMs, context) {
  behaviorReservations += 1;
  behaviorQueueDepth += 1;
  maxObservedBehaviorQueueDepth = Math.max(maxObservedBehaviorQueueDepth, behaviorQueueDepth);
  const next = behaviorTail.then(async () => {
    behaviorQueueDepth -= 1;
    requireActive(context);
    const waitMs = Math.max(0, gapMs - (context.clock() - behaviorLastStartedAt));
    if (waitMs > 0) {
      const availableMs = remainingMs(context);
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, Math.max(0, availableMs))));
      requireActive(context);
      if (waitMs > availableMs) throw deadlineFailure();
    }
    requireActive(context);
    behaviorLastStartedAt = context.clock();
    return job();
  });
  const tracked = next.finally(() => { behaviorReservations -= 1; });
  behaviorTail = tracked.then(() => undefined, () => undefined);
  return tracked;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function ema(candles, period) {
  const alpha = 2 / (period + 1);
  return candles.reduce((value, candle) => value + alpha * (candle.close - value), candles[0]?.close ?? 0);
}

function buildSignal(snapshot, nowMs) {
  const candles = snapshot.candles;
  const latest = candles.at(-1);
  if (!latest || candles.length < 40) throw publicFailure();
  const recent = candles.slice(-36);
  const fast = ema(recent, 9);
  const slow = ema(recent, 26);
  const prior = candles.at(-13)?.close ?? latest.close;
  const momentum = latest.close / prior - 1;
  const volatility = average(recent.slice(-12).map((candle) => (candle.high - candle.low) / candle.close));
  const behavior = snapshot.behaviorSeries.at(-1);
  const longRatio = behavior.longRatio;
  const takerBalance = (behavior.buyVolume - behavior.sellVolume) / Math.max(1, behavior.buyVolume + behavior.sellVolume);
  const factors = [];
  let score = 0;
  const trendImpact = Math.max(-28, Math.min(28, (fast / slow - 1) * 3_000));
  score += trendImpact;
  factors.push({
    label: '추세 정렬',
    detail: `EMA 9가 EMA 26 대비 ${fast / slow - 1 >= 0 ? '+' : ''}${((fast / slow - 1) * 100).toFixed(2)}%`,
    impact: trendImpact,
  });
  const momentumImpact = Math.max(-24, Math.min(24, momentum * 900));
  score += momentumImpact;
  factors.push({ label: '12봉 모멘텀', detail: `${(momentum * 100).toFixed(2)}%`, impact: momentumImpact });
  const takerImpact = Math.max(-22, Math.min(22, takerBalance * 75));
  score += takerImpact;
  factors.push({
    label: '적극 체결 균형',
    detail: `${takerBalance >= 0 ? '매수' : '매도'} 우위 ${Math.abs(takerBalance * 100).toFixed(1)}%`,
    impact: takerImpact,
  });
  const crowdImpact = longRatio > 0.62 ? -14 : longRatio < 0.38 ? 14 : 0;
  score += crowdImpact;
  if (crowdImpact) factors.push({ label: '군중 과밀 역추세', detail: `롱 비중 ${(longRatio * 100).toFixed(1)}%`, impact: crowdImpact });
  const fundingImpact = snapshot.fundingRate > 0.0005 ? -8 : snapshot.fundingRate < -0.0005 ? 8 : 0;
  score += fundingImpact;
  if (fundingImpact) factors.push({ label: '펀딩 과열', detail: `${(snapshot.fundingRate * 100).toFixed(4)}%`, impact: fundingImpact });
  const direction = Math.abs(score) >= 18 ? (score > 0 ? 'long' : 'short') : 'stand-aside';
  const supports = (impact) => direction === 'long' ? impact > 0 : direction === 'short' ? impact < 0 : impact > 0;
  const atr = average(recent.slice(-14).map((candle) => candle.high - candle.low));
  const sign = direction === 'short' ? -1 : 1;
  return {
    direction,
    directionLabel: direction === 'long' ? '롱 후보' : direction === 'short' ? '숏 후보' : '관망',
    confidence: Math.round(Math.max(12, Math.min(92, Math.abs(score) + 32))),
    score: Math.round(score * 10) / 10,
    regime: volatility > 0.012 ? '변동성 확장' : fast > slow * 1.002 ? '상승 추세' : fast < slow * 0.998 ? '하락 추세' : '중립/혼조',
    crowdState: longRatio > 0.62 ? '롱 과밀' : longRatio < 0.38 ? '숏 과밀' : '쏠림 제한적',
    evidence: factors.filter((item) => item.impact !== 0 && supports(item.impact)).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)),
    counterSignals: factors.filter((item) => item.impact !== 0 && !supports(item.impact)).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)),
    invalidationPrice: latest.close - sign * atr * 1.25,
    targetPrice: latest.close + sign * atr * 2,
    generatedAt: nowMs,
    dataQuality: 'live',
  };
}

function parseDashboardRequest(requestUrl) {
  const url = new URL(requestUrl);
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || !keys.every((key) => key === 'symbol' || key === 'period')
    || url.searchParams.getAll('symbol').length !== 1 || url.searchParams.getAll('period').length !== 1) {
    throw new BehaviorLabRequestError('허용되지 않은 대시보드 요청입니다.', 400);
  }
  const symbol = url.searchParams.get('symbol');
  const period = url.searchParams.get('period');
  if (!SYMBOL_SET.has(symbol) || !PERIOD_SET.has(period)) {
    throw new BehaviorLabRequestError('지원하지 않는 심볼 또는 주기입니다.', 400);
  }
  return { symbol, period };
}

async function loadDashboard(symbol, period, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const behaviorGapMs = options.behaviorGapMs ?? 1_050;
  const ledger = options.ledger;
  const context = options.context;
  const common = { productType: 'usdt-futures' };
  const ordinary = [
    publicGet('/api/v2/mix/market/tickers', common, fetchImpl, timeoutMs, ledger, context),
    publicGet('/api/v2/mix/market/ticker', { ...common, symbol }, fetchImpl, timeoutMs, ledger, context),
    publicGet('/api/v2/mix/market/candles', { ...common, symbol, granularity: PERIOD_TO_GRANULARITY[period], limit: '260' }, fetchImpl, timeoutMs, ledger, context),
    publicGet('/api/v2/mix/market/history-fund-rate', { ...common, symbol, pageSize: '20' }, fetchImpl, timeoutMs, ledger, context),
    publicGet('/api/v2/mix/market/open-interest', { ...common, symbol }, fetchImpl, timeoutMs, ledger, context),
    publicGet('/api/v2/mix/market/contracts', { ...common, symbol }, fetchImpl, timeoutMs, ledger, context),
  ];
  const longShortPromise = behaviorPublicGet(
    () => publicGet('/api/v2/mix/market/long-short', { symbol, period }, fetchImpl, timeoutMs, ledger, context),
    behaviorGapMs,
    context,
  );
  const takerPromise = behaviorPublicGet(
    () => publicGet('/api/v2/mix/market/taker-buy-sell', { symbol, period }, fetchImpl, timeoutMs, ledger, context),
    behaviorGapMs,
    context,
  );
  const [allRaw, tickerRaw, candlesRaw, fundingRaw, interestRaw, contractsRaw, longShortRaw, takerRaw] = await Promise.all([
    ...ordinary, longShortPromise, takerPromise,
  ]);
  requireActive(context);
  const nowMs = options.nowMs ?? context.clock();

  const allEnvelope = unwrap(allRaw, nowMs);
  const allRows = Array.isArray(allEnvelope.data) ? allEnvelope.data : [];
  const requiredTickerRows = allRows.filter((row) => row && typeof row === 'object' && SYMBOL_SET.has(row.symbol));
  const tickers = requiredTickerRows.map(parseTicker);
  if (requiredTickerRows.length !== BEHAVIOR_LAB_SYMBOLS.length || tickers.some((item) => item === null)
    || new Set(tickers.map((item) => item.symbol)).size !== BEHAVIOR_LAB_SYMBOLS.length
    || !BEHAVIOR_LAB_SYMBOLS.every((required) => tickers.some((item) => item.symbol === required))) throw publicFailure();
  const tickersUpdatedAt = Math.min(...tickers.map((item) => item.ts));
  assertTimestamp(tickersUpdatedAt, nowMs, 2 * 60_000);

  const tickerEnvelope = unwrap(tickerRaw, nowMs);
  const tickerRows = Array.isArray(tickerEnvelope.data) ? tickerEnvelope.data : [];
  const tickerCandidates = tickerRows.map(parseTicker).filter(Boolean);
  const ticker = tickerCandidates.find((item) => item.symbol === symbol);
  if (tickerRows.length !== 1 || tickerCandidates.length !== 1 || !ticker) throw publicFailure();
  assertTimestamp(ticker.ts, nowMs, 2 * 60_000);

  const candleEnvelope = unwrap(candlesRaw, nowMs);
  const candleRows = Array.isArray(candleEnvelope.data) ? candleEnvelope.data : [];
  const parsedCandles = candleRows.map(parseCandle);
  if (parsedCandles.some((item) => item === null)) throw publicFailure();
  const candles = parsedCandles.sort((left, right) => left.ts - right.ts);
  if (candles.length < 120 || new Set(candles.map((item) => item.ts)).size !== candles.length) throw publicFailure();
  const candlesUpdatedAt = candles.at(-1).ts;
  assertTimestamp(candlesUpdatedAt, nowMs, PERIOD_MS[period] * 2.25);

  const longEnvelope = unwrap(longShortRaw, nowMs);
  const longRows = Array.isArray(longEnvelope.data) ? longEnvelope.data : [];
  const longMap = new Map();
  let longValid = longRows.length >= 2;
  for (const row of longRows) {
    const ts = finite(row?.ts);
    const longRatio = finite(row?.longRatio);
    const shortRatio = finite(row?.shortRatio);
    if (ts === null || longRatio === null || shortRatio === null || ts <= 0 || longRatio < 0 || longRatio > 1
      || shortRatio < 0 || shortRatio > 1 || Math.abs(longRatio + shortRatio - 1) > 0.05 || longMap.has(ts)) {
      longValid = false;
    } else longMap.set(ts, { longRatio, shortRatio });
  }
  const takerEnvelope = unwrap(takerRaw, nowMs);
  const takerRows = Array.isArray(takerEnvelope.data) ? takerEnvelope.data : [];
  const takerMap = new Map();
  let takerValid = takerRows.length >= 2;
  for (const row of takerRows) {
    const ts = finite(row?.ts);
    const buyVolume = finite(row?.buyVolume);
    const sellVolume = finite(row?.sellVolume);
    if (ts === null || buyVolume === null || sellVolume === null || ts <= 0 || buyVolume < 0 || sellVolume < 0
      || buyVolume + sellVolume <= 0 || takerMap.has(ts)) {
      takerValid = false;
    } else takerMap.set(ts, { buyVolume, sellVolume });
  }
  const joinedTimes = [...longMap.keys()].filter((ts) => takerMap.has(ts)).sort((left, right) => left - right);
  const unmatchedLong = longMap.size - joinedTimes.length;
  const unmatchedTaker = takerMap.size - joinedTimes.length;
  if (!longValid || !takerValid || joinedTimes.length < 20 || unmatchedLong > 2 || unmatchedTaker > 2) throw publicFailure();
  const behaviorSeries = joinedTimes.map((ts) => ({ ts, ...longMap.get(ts), ...takerMap.get(ts) }));
  const behaviorUpdatedAt = behaviorSeries.at(-1).ts;
  assertTimestamp(behaviorUpdatedAt, nowMs, PERIOD_MS[period] * 3);

  const fundingEnvelope = unwrap(fundingRaw, nowMs);
  const fundingRows = Array.isArray(fundingEnvelope.data) ? fundingEnvelope.data : [];
  const fundingEntries = fundingRows.map((row) => {
    const rate = finite(row?.fundingRate);
    const time = finite(row?.fundingTime);
    return row?.symbol === symbol && rate !== null && Math.abs(rate) <= 1 && time !== null && time > 0 ? { rate, time } : null;
  });
  if (!fundingRows.length || fundingEntries.some((item) => item === null)) throw publicFailure();
  fundingEntries.sort((left, right) => right.time - left.time);
  assertTimestamp(fundingEntries[0].time, nowMs, 12 * 3_600_000);

  const interestEnvelope = unwrap(interestRaw, nowMs);
  const interestData = interestEnvelope.data && typeof interestEnvelope.data === 'object' && !Array.isArray(interestEnvelope.data)
    ? interestEnvelope.data : {};
  const interestRows = Array.isArray(interestData.openInterestList) ? interestData.openInterestList : [];
  const interestMatches = interestRows.map((row) => {
    const size = finite(row?.size);
    return row?.symbol === symbol && size !== null && size > 0 ? size : null;
  }).filter((value) => value !== null);
  const interestUpdatedAt = finite(interestData.ts);
  if (interestRows.length !== 1 || interestMatches.length !== 1) throw publicFailure();
  assertTimestamp(interestUpdatedAt, nowMs, 5 * 60_000);

  const contractsEnvelope = unwrap(contractsRaw, nowMs);
  const contractRows = Array.isArray(contractsEnvelope.data) ? contractsEnvelope.data : [];
  const contractMatches = contractRows.map((row) => {
    const leverage = finite(row?.maxLever ?? row?.maxLeverage);
    return row?.symbol === symbol && leverage !== null && leverage >= 1 && leverage <= 1_000 ? leverage : null;
  }).filter((value) => value !== null);
  if (contractRows.length !== 1 || contractMatches.length !== 1) throw publicFailure();
  assertTimestamp(contractsEnvelope.requestTime, nowMs, 24 * 3_600_000);

  const components = {
    tickers: { status: 'fresh', updatedAt: tickersUpdatedAt, ageMs: Math.max(0, nowMs - tickersUpdatedAt) },
    ticker: { status: 'fresh', updatedAt: ticker.ts, ageMs: Math.max(0, nowMs - ticker.ts) },
    candles: { status: 'fresh', updatedAt: candlesUpdatedAt, ageMs: Math.max(0, nowMs - candlesUpdatedAt) },
    behavior: { status: 'fresh', updatedAt: behaviorUpdatedAt, ageMs: Math.max(0, nowMs - behaviorUpdatedAt) },
    funding: { status: 'fresh', updatedAt: fundingEntries[0].time, ageMs: Math.max(0, nowMs - fundingEntries[0].time) },
    openInterest: { status: 'fresh', updatedAt: interestUpdatedAt, ageMs: Math.max(0, nowMs - interestUpdatedAt) },
    contracts: { status: 'fresh', updatedAt: contractsEnvelope.requestTime, ageMs: Math.max(0, nowMs - contractsEnvelope.requestTime) },
  };
  const snapshot = {
    symbol,
    period,
    source: 'live',
    quality: 'live',
    sourceLabel: 'LIVE · component 검증',
    notice: 'Bitget 인증 없는 공개 시장 GET 데이터입니다.',
    fetchedAt: nowMs,
    updatedAt: Math.max(...Object.values(components).map((item) => item.updatedAt)),
    freshnessMs: Math.max(...Object.values(components).map((item) => item.ageMs)),
    components,
    tickers,
    ticker,
    candles,
    behaviorSeries,
    fundingRate: fundingEntries[0].rate,
    openInterest: interestMatches[0],
    maxLeverage: contractMatches[0],
  };
  return {
    source: 'live',
    quality: 'live',
    generatedAt: nowMs,
    upstream: { method: 'GET', host: BITGET_PUBLIC_HOST, requestCount: BITGET_PUBLIC_PATHS.length },
    snapshot,
    signal: buildSignal(snapshot, nowMs),
  };
}

export async function getBehaviorLabDashboard(requestUrl, options = {}) {
  const clock = options.clock ?? Date.now;
  const arrivalAt = clock();
  const { symbol, period } = parseDashboardRequest(requestUrl);
  const key = `${symbol}|${period}`;
  const cache = options.cache === false ? null : dashboardCache;
  const cached = cache?.get(key);
  if (cached && cached.expiresAt > arrivalAt) return cached.value;
  if (cached) cache.delete(key);
  if (options.cache !== false && inflight.has(key)) return inflight.get(key);
  if (activeDashboardLoads >= MAX_ACTIVE_DASHBOARD_LOADS
    || behaviorReservations + 2 > MAX_BEHAVIOR_QUEUE_DEPTH) throw capacityFailure();
  const context = {
    arrivalAt,
    deadlineAt: arrivalAt + (options.totalDeadlineMs ?? TOTAL_DEADLINE_MS),
    clock,
    cancelled: false,
    controllers: new Set(),
  };
  activeDashboardLoads += 1;
  maxObservedActiveLoads = Math.max(maxObservedActiveLoads, activeDashboardLoads);
  const loading = (async () => {
    try {
      return await loadDashboard(symbol, period, { ...options, context });
    } finally {
      cancelContext(context);
      activeDashboardLoads -= 1;
    }
  })();
  if (options.cache === false) return loading;
  inflight.set(key, loading);
  try {
    const value = await loading;
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { expiresAt: clock() + CACHE_TTL_MS, value });
    return value;
  } finally {
    inflight.delete(key);
  }
}
