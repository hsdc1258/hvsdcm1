// 사용량 화면(usage/assets/js/usage.js)의 렌더 계약 단위 테스트.
//
// 왜 있는가 (review WP1 M-2)
//   이전에는 validate.mjs가 소스 **문자열**을 grep해 계약을 지켰다. 그 검사는 변수명만
//   바꿔도 깨지고, 로직이 틀려도 통과한다 — `readPercent`가 0을 falsy로 떨어뜨리거나
//   STALE_MS 부등호가 뒤집혀도 전부 초록불이었다. 여기서는 렌더러를 **실제로 실행해**
//   산출 마크업을 본다. 스냅샷 생성기와 같은 샌드박스(render-sandbox.mjs)를 쓴다.
//
// 이 테스트가 **못 보는 것**: 네트워크 계층(api()), DOM 이벤트 배선, 시각 조판.
//   API 계약은 worker/test.mjs가, 조판은 docs/_snapshots/usage.html이 본다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderUsageDashboard } from './render-sandbox.mjs';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (offsetMs) => new Date(NOW - offsetMs).toISOString();

// renderUsageDashboard()는 요약 스트립·게이지가 없으면 throw한다(샌드박스의 계약 검사).
// 게이지가 필요 없는 표본은 이 함수 대신 아래 buildOnly()로 부른다.
function dashboard(snapshots, now = NOW) {
  return renderUsageDashboard(snapshots, now);
}

const codexSnapshot = (buckets, capturedAt = iso(HOUR)) => ({
  source: 'codex',
  captured_at: capturedAt,
  payload: { model: 'gpt-5.6-codex', rate_limits: buckets },
});

const claudeSnapshot = (models, capturedAt = iso(HOUR)) => ({
  source: 'claude',
  captured_at: capturedAt,
  payload: { models },
});

test('unknown bucket keys render with the key itself and known keys with their label', () => {
  const markup = dashboard([codexSnapshot({
    primary: { used_percent: 40 },
    monthly: { used_percent: 10 },
  })]);
  assert.match(markup, /5시간/u);          // primary → 사전에 있는 라벨
  assert.match(markup, />monthly</u);      // 모르는 키 → 키 문자열 그대로
  assert.doesNotMatch(markup, />primary</u);
});

test('both used_percent and used_percentage field names are recognized', () => {
  const markup = dashboard([
    codexSnapshot({ primary: { used_percent: 41 } }),
    claudeSnapshot({ 'claude-opus-5': { rate_limits: { five_hour: { used_percentage: 62 } } } }),
  ]);
  assert.match(markup, /41%/u);
  assert.match(markup, /62%/u);
});

test('0% renders as a zero gauge, not as a missing record', () => {
  const markup = dashboard([codexSnapshot({
    primary: { used_percent: 0 },
    secondary: { used_percent: 100 },
  })]);
  assert.match(markup, /width: 0\.0%/u);
  assert.match(markup, />0%</u);
  assert.doesNotMatch(markup, /기록 없음/u);
});

test('a bucket without any percent field says so instead of drawing a 0% gauge', () => {
  const markup = dashboard([codexSnapshot({
    primary: { used_percent: 50 },
    secondary: { window_minutes: 10_080 },
  })]);
  assert.match(markup, /기록 없음/u);
  // 게이지는 퍼센트가 있는 버킷에만 그린다.
  assert.equal((markup.match(/gauge-fill/gu) || []).length, 1);
});

test('the gauge colour band switches at 75% and 95%', () => {
  const normal = dashboard([codexSnapshot({ primary: { used_percent: 74.9 } })]);
  assert.doesNotMatch(normal, /gauge-fill is-/u);

  const warn = dashboard([codexSnapshot({ primary: { used_percent: 75 } })]);
  assert.match(warn, /gauge-fill is-warn/u);
  assert.doesNotMatch(warn, /is-over/u);

  const over = dashboard([codexSnapshot({ primary: { used_percent: 95 } })]);
  assert.match(over, /gauge-fill is-over/u);
});

test('percentages outside 0-100 are clamped instead of overflowing the track', () => {
  const markup = dashboard([codexSnapshot({
    primary: { used_percent: 140 },
    secondary: { used_percent: -20 },
  })]);
  assert.match(markup, /width: 100\.0%/u);
  assert.match(markup, /width: 0\.0%/u);
  assert.doesNotMatch(markup, /width: 140/u);
});

test('resets_at is read as an ISO8601 string and rendered as a relative time', () => {
  const markup = dashboard([codexSnapshot({
    primary: { used_percent: 30, resets_at: new Date(NOW + (2 * HOUR)).toISOString() },
  })]);
  assert.match(markup, /2시간 후 초기화/u);
});

test('an unparsable resets_at falls back to the window length, never to NaN', () => {
  // 수집기가 정규화하지 못한 값(계약상 필드째 빠져야 하는 값)이 들어와도 화면이 깨지지 않는다.
  const markup = dashboard([codexSnapshot({
    primary: { used_percent: 30, resets_at: 1787804453, window_minutes: 300 },
  })]);
  assert.doesNotMatch(markup, /NaN|Invalid/u);
  assert.match(markup, /5시간 창/u);
});

test('a captured_at older than 24h flips the stale state, 23h59m does not', () => {
  const fresh = dashboard([codexSnapshot({ primary: { used_percent: 5 } }, iso((24 * HOUR) - 60_000))]);
  assert.match(fresh, /최신/u);
  assert.doesNotMatch(fresh, /오래된 데이터/u);
  assert.doesNotMatch(fresh, /status-dot is-warn/u);

  const stale = dashboard([codexSnapshot({ primary: { used_percent: 5 } }, iso((24 * HOUR) + 60_000))]);
  assert.match(stale, /오래된 데이터/u);
  assert.match(stale, /status-dot is-warn/u);
  assert.match(stale, /오래됨/u);
});

test('the summary strip aggregates the highest percentage and the bucket count', () => {
  const markup = dashboard([
    codexSnapshot({ primary: { used_percent: 12 }, secondary: { used_percent: 88 } }),
    claudeSnapshot({
      'claude-opus-5': { rate_limits: { five_hour: { used_percentage: 44 } } },
      'claude-fable-5': { rate_limits: { seven_day: { used_percentage: 5 } } },
    }),
  ]);
  assert.match(markup, /88%/u);
  assert.match(markup, /<span class="stat-value">4<\/span>/u);
});

test('an empty snapshot list and a payload without buckets render an empty state', async () => {
  // buildDashboard()를 직접 부른다 — 게이지가 없는 표본이라 샌드박스의 계약 검사에 걸린다.
  const { readSource, USAGE_APP_SOURCE } = await import('./render-sandbox.mjs');
  const vm = await import('node:vm');
  const context = {
    window: null,
    document: { getElementById: () => ({ addEventListener() {}, textContent: '', innerHTML: '' }) },
    location: { pathname: '/usage/', search: '', replace() { throw new Error('login gate fired'); } },
    localStorage: { getItem: () => 'gate-token', removeItem() {} },
    fetch: () => new Promise(() => {}),
    console: { log() {}, warn() {}, error() {} },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readSource(USAGE_APP_SOURCE), context, { filename: USAGE_APP_SOURCE });
  const { buildDashboard } = context.USAGE_RENDER;

  assert.match(buildDashboard([], NOW), /아직 수집된 사용량 기록이 없습니다/u);
  assert.match(buildDashboard(null, NOW), /아직 수집된 사용량 기록이 없습니다/u);
  assert.match(
    buildDashboard([{ source: 'codex', captured_at: iso(HOUR), payload: { model: 'x' } }], NOW),
    /읽을 수 있는 한도 정보가 없습니다/u,
  );
});
