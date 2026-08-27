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
function dashboard(input, now = NOW) {
  return renderUsageDashboard(input, now);
}

const codexSnapshot = (buckets, capturedAt = iso(HOUR)) => ({
  source: 'codex',
  captured_at: capturedAt,
  payload: { model: 'gpt-5.6-codex', rate_limits: buckets },
});

const harnessTask = (overrides = {}) => ({
  version: 1,
  id: 'usage-harness',
  name: '사용량 하네스 시각화 (08-27)',
  phase: 'review',
  progress: 86,
  status: 'active',
  model: 'gpt-5.6-sol',
  reasoning: 'xhigh',
  category_key: 'pipeline-visualization',
  category: '파이프라인 시각화',
  current: '독립 검토',
  done: '구현과 결정적 gate',
  next: '라이브 배포',
  deadline: '20:10 KST',
  updated_at: iso(HOUR),
  actors: [
    {
      id: 'usage-harness:main', parent_id: '', name: 'Main Codex', kind: 'codex',
      model: 'gpt-5.6-sol', reasoning: 'xhigh', role: '기획 · 통합 · 최종 판정', status: 'reviewing',
      assignment: '독립 검토 통합',
    },
    {
      id: 'usage-harness:reviewer', parent_id: 'usage-harness:main', name: '독립 검토', kind: 'codex',
      model: 'gpt-5.6-sol', reasoning: 'xhigh', role: '검토자', status: 'reviewing', assignment: 'diff 반증',
    },
    {
      id: 'usage-harness:webgpt', parent_id: 'usage-harness:main', name: 'WebGPT 실행자', kind: 'webgpt',
      model: 'WebGPT PRO', role: '위임 실행', status: 'done', assignment: 'fixture 정리',
    },
  ],
  artifacts: ['npm test', 'HARNESS E2E: PASS'],
  ...overrides,
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

test('both used_percent and used_percentage field names are recognized for Codex', () => {
  const markup = dashboard([codexSnapshot({
    primary: { used_percent: 41 },
    secondary: { used_percentage: 62 },
  })]);
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
  assert.doesNotMatch(fresh, /오래된 데이터/u);

  const stale = dashboard([codexSnapshot({ primary: { used_percent: 5 } }, iso((24 * HOUR) + 60_000))]);
  assert.match(stale, /오래된 데이터/u);
});

test('the summary strip joins Codex usage with active task, actor, and gate counts', () => {
  const markup = dashboard({
    snapshots: [codexSnapshot({ primary: { used_percent: 12 }, secondary: { used_percent: 88 } })],
    tasks: [harnessTask()],
  });
  assert.match(markup, /88%/u);
  assert.match(markup, /활성 작업<\/span><span class="stat-value">1<\/span>/u);
  assert.match(markup, /작업 중 AI<\/span><span class="stat-value">2<\/span>/u);
  assert.match(markup, /작업 카테고리<\/span><span class="stat-value">1<\/span>/u);
  assert.match(markup, /현재 gate<\/span><span class="stat-value">검토<\/span>/u);
});

test('the hierarchy renders model reasoning, subagent, WebGPT, gates, and evidence as peers in one task', () => {
  const markup = dashboard({
    snapshots: [codexSnapshot({ primary: { used_percent: 12 } })],
    tasks: [harnessTask()],
  });
  for (const expected of ['Main Codex', 'gpt-5.6-sol · xhigh', '독립 검토', 'WebGPT 실행자', 'WebGPT PRO', 'HARNESS E2E: PASS']) {
    assert.match(markup, new RegExp(expected, 'u'));
  }
  assert.equal((markup.match(/class="h-phase(?: |")/gu) || []).length, 4);
  assert.match(markup, /h-org-level is-command/u);
  assert.match(markup, /h-org-level is-agents/u);
  assert.match(markup, /h-actor is-webgpt/u);
});

test('project, protocol, and visualization reports render as three separate categories', () => {
  const markup = dashboard({
    snapshots: [codexSnapshot({ primary: { used_percent: 12 } })],
    tasks: [
      harnessTask({
        id: 'jimunhanjang',
        name: '프로젝트 지문한장',
        category_key: 'jimunhanjang-project',
        category: '지문한장 프로젝트',
      }),
      harnessTask({
        id: 'pipeline-hardening',
        name: 'Pipeline 개선',
        category_key: 'pipeline-protocol',
        category: '자체 pipeline 개선 프로토콜',
      }),
      harnessTask(),
    ],
  });
  for (const category of ['지문한장 프로젝트', '자체 pipeline 개선 프로토콜', '파이프라인 시각화']) {
    assert.match(markup, new RegExp(`<h3 id="hCategory\\d">${category}</h3>`, 'u'));
  }
  assert.equal((markup.match(/class="h-category"/gu) || []).length, 3);
  assert.match(markup, /작업 카테고리<\/span><span class="stat-value">3<\/span>/u);
});

test('Claude snapshots are ignored and actor text is escaped', () => {
  const markup = dashboard({
    snapshots: [
      codexSnapshot({ primary: { used_percent: 12 } }),
      { source: 'claude', captured_at: iso(HOUR), payload: { model: 'Claude' } },
    ],
    tasks: [harnessTask({ name: '<img src=x onerror=alert(1)>' })],
  });
  assert.doesNotMatch(markup, /Claude/u);
  assert.doesNotMatch(markup, /<img/u);
  assert.match(markup, /&lt;img/u);
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

  assert.match(buildDashboard([], NOW), /아직 수집된 Codex 사용량 기록이 없습니다/u);
  assert.match(buildDashboard(null, NOW), /아직 수집된 Codex 사용량 기록이 없습니다/u);
  assert.match(
    buildDashboard([{ source: 'codex', captured_at: iso(HOUR), payload: { model: 'x' } }], NOW),
    /읽을 수 있는 Codex 한도 정보가 없습니다/u,
  );
});
