import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const coreSource = readFileSync(new URL('../behavior-lab/assets/js/core.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../behavior-lab/assets/js/app.js', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../behavior-lab/index.html', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(coreSource, context, { filename: 'behavior-lab/assets/js/core.js' });
const core = context.window.BehaviorLabCore;

function candles(count = 260) {
  return Array.from({ length: count }, (_, index) => {
    const open = 40_000 + index * 16 + Math.sin(index / 4) * 30;
    const close = open + 12 + Math.sin(index / 8) * 8;
    return {
      ts: Date.parse('2026-08-01T00:00:00Z') + index * 300_000,
      open,
      high: Math.max(open, close) + 20,
      low: Math.min(open, close) - 20,
      close,
      volume: 900 + (index % 18) * 80,
    };
  });
}

function liveSnapshot(now, period = '5m') {
  const components = Object.fromEntries([
    'tickers', 'ticker', 'candles', 'behavior', 'funding', 'openInterest', 'contracts',
  ].map((name) => [name, { status: 'fresh', updatedAt: now, ageMs: 0 }]));
  return { source: 'live', quality: 'live', period, components };
}

test('browser core runs chronological four-window backtest with the accepted round-trip costs', () => {
  const result = core.runWalkForwardBacktest(candles());
  assert.equal(result.walkForwardWindows, 4);
  assert.equal(result.windows.length, 4);
  assert.equal(result.assumptions.feeBps, 6);
  assert.equal(result.assumptions.slippageBps, 4);
  assert.match(result.chronology, /다음 봉 시가/u);
  assert.ok(result.windows.every((window, index) => window.index === index + 1
    && window.trainingEndTs < window.testStartTs && [4, 8, 12].includes(window.holdingBars)));
  const duplicated = candles(120);
  duplicated[70].ts = duplicated[69].ts;
  assert.throws(() => core.runWalkForwardBacktest(duplicated), /중복 없이 증가/u);
});

test('manual draft is risk-bounded, cost-inclusive, copy-only text and blocked for stand-aside', () => {
  const contextInput = {
    symbol: 'BTCUSDT',
    period: '5m',
    snapshotUpdatedAt: Date.parse('2026-08-31T00:00:00Z'),
    entry: 100_000,
    direction: 'long',
    marketMaxLeverage: 50,
  };
  const draft = core.createManualDraft({ seed: 5_000, maxLossPct: 1, leverageCap: 3, stopDistancePct: 2 }, contextInput);
  assert.equal(draft.valid, true);
  assert.ok(draft.modeledLoss <= draft.riskBudget);
  assert.equal(draft.costRate, 0.002);
  assert.match(draft.text, /왕복 20bps/u);
  assert.match(draft.text, /전송\/제출 기능 없음/u);
  assert.match(draft.text, /정밀도·최소수량 미검증/u);

  const blocked = core.createManualDraft(
    { seed: 5_000, maxLossPct: 1, leverageCap: 3, stopDistancePct: 2 },
    { ...contextInput, direction: 'stand-aside' },
  );
  assert.equal(blocked.valid, false);
  assert.match(blocked.errors.join(' '), /관망 신호/u);
});

test('component freshness advances with a fake clock and blocks a once-valid manual draft after the shortest deadline', () => {
  const now = Date.parse('2026-08-31T00:00:00Z');
  const snapshot = liveSnapshot(now);
  const contextInput = {
    symbol: 'BTCUSDT', period: '5m', snapshotUpdatedAt: now, entry: 100_000,
    direction: 'long', marketMaxLeverage: 50,
  };
  const input = { seed: 5_000, maxLossPct: 1, leverageCap: 3, stopDistancePct: 2 };
  const live = core.evaluateSnapshotQuality(snapshot, now + 120_000);
  assert.equal(live.isLive, true);
  assert.equal(core.createFreshManualDraft(input, contextInput, snapshot, now + 120_000).valid, true);

  const expired = core.evaluateSnapshotQuality(snapshot, now + 120_001);
  assert.equal(expired.isLive, false);
  assert.equal(expired.quality, 'stale');
  assert.deepEqual([...expired.failures], ['tickers:stale', 'ticker:stale']);
  const blocked = core.createFreshManualDraft(input, contextInput, snapshot, now + 120_001);
  assert.equal(blocked.valid, false);
  assert.match(blocked.errors.join(' '), /다시 불러오/u);

  snapshot.components.ticker.updatedAt = now + 120_002 + 60_000;
  const future = core.evaluateSnapshotQuality(snapshot, now + 120_001);
  assert.equal(future.isLive, false);
  assert.equal(future.components.ticker.status, 'partial');
});

test('published app bearer-gates dashboard and paper reads while retaining no exchange submission surface', () => {
  assert.equal((appSource.match(/\/api\/behavior-lab\/dashboard/gu) || []).length, 1);
  assert.match(appSource, /fetch\(`\$\{API_URL\}\/api\/behavior-lab\/paper`,/u);
  assert.match(appSource, /fetch\(`\$\{API_URL\}\/api\/behavior-lab\/paper\/stop`,/u);
  assert.doesNotMatch(appSource, /api\.bitget\.com/iu);
  assert.match(appSource, /localStorage\.getItem\('hvsdcm\.token'\)/u);
  assert.match(appSource, /authorization: `Bearer \$\{ownerToken\(\)\}`/u);
  assert.doesNotMatch(htmlSource, /<form\b|type=["']submit["']|\baction=/iu);
  assert.match(htmlSource, /id="copyDraft"[^>]*type="button"/u);
  assert.match(htmlSource, /제출 기능은 존재하지 않습니다/u);
  assert.match(htmlSource, /content="noindex, nofollow, noarchive"/u);
  assert.match(htmlSource, /id="labShell"[^>]*\bhidden\b/u);
  assert.match(htmlSource, /id="paperTabPanel"/u);
  assert.match(htmlSource, /id="stopPaper"[^>]*type="button"[^>]*\bhidden\b/u);
  assert.doesNotMatch(appSource, /scheduler|notification|health/iu);
  assert.match(appSource, /setInterval\(refreshLiveClock, 1_000\)/u);
  assert.match(appSource, /function createDraft\(\)[\s\S]*createFreshManualDraft/u);
});

test('owner paper UI removes the completed legacy session surface and keeps bounded refresh', () => {
  assert.doesNotMatch(htmlSource, /id="paperReport"|id="paperAdaptive"|paper-20260831-100usd/u);
  assert.doesNotMatch(htmlSource, /실시간 엔진 · 재귀 개선 감사|현재 포지션<\/h2>/u);
  assert.match(appSource, /PAPER_REFRESH_MS = 5_000/u);
  assert.doesNotMatch(appSource, /function renderPaper\(|renderPaper\(payload\.report\)|validAdaptiveReport/u);
  assert.match(appSource, /\['starting', 'active'\]\.includes\(payload\.experiment\.status\)/u);
});

test('owner paper UI renders six detailed, accessible time-scaled cost-aware curves and hides finished experiments', () => {
  assert.match(htmlSource, /id="paperExperiment"[^>]*\bhidden\b/u);
  assert.match(htmlSource, /SIMULTANEOUS UNTIL STOP · SIX INDEPENDENT ARMS/u);
  assert.doesNotMatch(htmlSource, /SIMULTANEOUS 24H · SIX INDEPENDENT ARMS/u);
  assert.match(htmlSource, /id="experimentLeaderboard"/u);
  assert.match(htmlSource, /id="experimentArms"/u);
  assert.match(appSource, /function validExperimentReport\(experiment\)/u);
  assert.match(appSource, /run_mode === 'until-stopped'/u);
  assert.match(appSource, /experiment\.deadline_at === null/u);
  assert.match(appSource, /experiment\.shared_feed\.credential_used === false/u);
  assert.match(appSource, /experiment\.assumptions\.strategy_mutation === false/u);
  assert.match(appSource, /'multi-paper-experiment-v2'/u);
  assert.match(appSource, /arm\.strategy\.policy/u);
  assert.match(appSource, /arm\.risk\.risk_pct/u);
  assert.match(appSource, /function renderEquityChart\(arm\)/u);
  assert.match(appSource, /function patchRenderedNode\(current, next\)/u);
  assert.match(appSource, /patchRenderedChildren\(elements\.experimentArms, arms\)/u);
  assert.match(appSource, /curve\.length <= 64/u);
  assert.match(appSource, /Date\.parse\(point\.at\) - firstAt/u);
  assert.match(appSource, /setAttribute\('role', 'img'\)/u);
  assert.match(appSource, /'최근 거래'/u);
  assert.match(appSource, /'진입 정책 \/ 위험'/u);
  assert.match(appSource, /elements\.experimentArms\.replaceChildren\(\)/u);
  assert.match(appSource, /state\.experiment = experiment;\s+paperStatus\(experiment\.status\)/u);
  assert.match(appSource, /renderExperiment\(activeExperiment\)/u);
  assert.match(htmlSource, /NO ACTIVE EXPERIMENT/u);
});
