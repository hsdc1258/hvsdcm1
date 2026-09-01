import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../behavior-lab/assets/js/app.js', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../behavior-lab/index.html', import.meta.url), 'utf8');

test('published app bearer-gates paper and live reads without the retired market surface', () => {
  assert.equal((appSource.match(/\/api\/behavior-lab\/dashboard/gu) || []).length, 0);
  assert.match(appSource, /fetch\(`\$\{API_URL\}\/api\/behavior-lab\/paper`,/u);
  assert.match(appSource, /fetch\(`\$\{API_URL\}\/api\/behavior-lab\/live`,/u);
  assert.match(appSource, /fetch\(`\$\{API_URL\}\/api\/behavior-lab\/paper\/stop`,/u);
  assert.doesNotMatch(appSource, /api\.bitget\.com/iu);
  assert.match(appSource, /localStorage\.getItem\('hvsdcm\.token'\)/u);
  assert.match(appSource, /authorization: `Bearer \$\{ownerToken\(\)\}`/u);
  assert.doesNotMatch(htmlSource, /<form\b|type=["']submit["']|\baction=|marketTab|marketTabPanel|runBacktest|copyDraft/iu);
  assert.doesNotMatch(htmlSource, /core\.js/u);
  assert.match(htmlSource, /content="noindex, nofollow, noarchive"/u);
  assert.match(htmlSource, /id="labShell"[^>]*\bhidden\b/u);
  assert.match(htmlSource, /id="paperTabPanel"/u);
  assert.match(htmlSource, /id="stopPaper"[^>]*type="button"[^>]*\bhidden\b/u);
  assert.doesNotMatch(appSource, /setInterval|loadDashboard|createDraft|BehaviorLabCore/iu);
});

test('owner paper UI removes the completed legacy session surface and keeps bounded refresh', () => {
  assert.doesNotMatch(htmlSource, /id="paperReport"|id="paperAdaptive"|paper-20260831-100usd/u);
  assert.doesNotMatch(htmlSource, /실시간 엔진 · 재귀 개선 감사|현재 포지션<\/h2>/u);
  assert.match(appSource, /PAPER_REFRESH_MS = 30_000/u);
  assert.match(appSource, /LIVE_REFRESH_MS = 60_000/u);
  assert.match(appSource, /visibilitychange/u);
  assert.doesNotMatch(appSource, /function renderPaper\(|renderPaper\(payload\.report\)|validAdaptiveReport/u);
  assert.match(appSource, /\['starting', 'active'\]\.includes\(payload\.experiment\.status\)/u);
});

test('owner paper UI renders a task-first six-model dashboard with accessible detailed curves and hides finished experiments', () => {
  assert.match(htmlSource, /id="paperExperiment"[^>]*\bhidden\b/u);
  assert.match(htmlSource, /6개 모의매매 모델의 성과와 최신 판단을 비교해요/u);
  assert.doesNotMatch(htmlSource, /결과보다 먼저|lab-hero/u);
  assert.doesNotMatch(htmlSource, /SIMULTANEOUS 24H · SIX INDEPENDENT ARMS/u);
  assert.match(htmlSource, /id="experimentLeaderboard"/u);
  assert.match(htmlSource, /id="experimentArms"/u);
  assert.match(htmlSource, /id="experimentLeaderReturn"/u);
  assert.match(htmlSource, /실험 조건과 데이터 상태 보기/u);
  assert.match(appSource, /function validExperimentReport\(experiment\)/u);
  assert.match(appSource, /run_mode === 'until-stopped'/u);
  assert.match(appSource, /experiment\.deadline_at === null/u);
  assert.match(appSource, /experiment\.shared_feed\.credential_used === false/u);
  assert.match(appSource, /experiment\.assumptions\.strategy_mutation === false/u);
  assert.match(appSource, /'multi-paper-experiment-v3'/u);
  assert.match(appSource, /arm\.strategy\.policy/u);
  assert.match(appSource, /arm\.risk\.risk_pct/u);
  assert.match(appSource, /function renderEquityChart\(arm\)/u);
  assert.match(appSource, /function patchRenderedNode\(current, next\)/u);
  assert.match(appSource, /patchRenderedChildren\(elements\.experimentArms, arms\)/u);
  assert.match(appSource, /curve\.length <= 64/u);
  assert.match(appSource, /Date\.parse\(point\.at\) - firstAt/u);
  assert.match(appSource, /setAttribute\('role', 'img'\)/u);
  assert.match(appSource, /'최근 거래 · 최신순'/u);
  assert.match(appSource, /function newestFirst\(items, timestampKey, sequenceKey\)/u);
  assert.match(appSource, /function experimentDisplayStatus\(experiment, now = Date\.now\(\)\)/u);
  assert.match(appSource, /PAPER_STALE_MS = 2 \* 60_000/u);
  assert.match(appSource, /'진입 정책 \/ 위험'/u);
  assert.match(appSource, /'전략 상세와 최신 기록 보기'/u);
  assert.match(appSource, /current\.tagName === 'DETAILS' && name === 'open'/u);
  assert.match(appSource, /elements\.experimentArms\.replaceChildren\(\)/u);
  assert.match(appSource, /state\.experiment = experiment;\s+const displayStatus = experimentDisplayStatus\(experiment\);/u);
  assert.match(appSource, /renderExperiment\(activeExperiment\)/u);
  assert.match(htmlSource, /NO ACTIVE EXPERIMENT/u);
});
