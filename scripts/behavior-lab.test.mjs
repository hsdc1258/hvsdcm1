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

test('published app fetches only the one Worker dashboard route and has no submission surface', () => {
  assert.equal((appSource.match(/\/api\/behavior-lab\/dashboard/gu) || []).length, 1);
  assert.doesNotMatch(appSource, /api\.bitget\.com/iu);
  assert.doesNotMatch(appSource, /authorization|api[-_ ]?key|passphrase|signature/iu);
  assert.doesNotMatch(htmlSource, /<form\b|type=["']submit["']|\baction=/iu);
  assert.match(htmlSource, /id="copyDraft"[^>]*type="button"/u);
  assert.match(htmlSource, /제출 기능은 존재하지 않습니다/u);
  assert.doesNotMatch(appSource, /scheduler|notification|health/iu);
});
