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
import { createUsageAppSandbox, createUsageRenderers, renderUsageDashboard } from './render-sandbox.mjs';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (offsetMs) => new Date(NOW - offsetMs).toISOString();

// renderUsageDashboard()는 command-center 골격이 없으면 throw한다(샌드박스의 계약 검사).
function dashboard(input, now = NOW) {
  return renderUsageDashboard(input, now);
}

const codexSnapshot = (buckets, capturedAt = iso(HOUR)) => ({
  source: 'codex',
  captured_at: capturedAt,
  payload: { model: 'gpt-5.6-codex', plan_type: 'pro', rate_limits: buckets },
});

// claude 수집기는 모델별로 창을 담는다 (scripts/usage-push.mjs buildClaudeReport).
const claudeSnapshot = (models, capturedAt = iso(HOUR)) => ({
  source: 'claude',
  captured_at: capturedAt,
  payload: {
    models: Object.fromEntries(Object.entries(models)
      .map(([id, rateLimits]) => [id, { captured_at: capturedAt, rate_limits: rateLimits }])),
  },
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

test('bucket labels come from window duration, never primary position', () => {
  const markup = dashboard([codexSnapshot({
    primary: { used_percent: 40 },
    secondary: { used_percent: 20, window_minutes: 300 },
    monthly: { used_percent: 10 },
  })]);
  assert.match(markup, /기본 사용량/u);
  assert.match(markup, /5시간 사용량/u);
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

test('epoch-second resets_at is rendered as a relative time', () => {
  const markup = dashboard([codexSnapshot({
    primary: { used_percent: 30, resets_at: Math.floor((NOW + (2 * HOUR)) / 1000), window_minutes: 300 },
  })]);
  assert.doesNotMatch(markup, /NaN|Invalid/u);
  assert.match(markup, /2시간 후 초기화/u);
});

test('a captured_at older than 15m is marked as delayed', () => {
  const fresh = dashboard([codexSnapshot({ primary: { used_percent: 5 } }, iso((15 * 60_000) - 1000))]);
  assert.doesNotMatch(fresh, /수집 지연/u);

  const stale = dashboard([codexSnapshot({ primary: { used_percent: 5 } }, iso((15 * 60_000) + 1000))]);
  assert.match(stale, /수집 지연/u);
});

test('Pro weekly limit is account-scoped and never named after the active model', () => {
  const markup = dashboard([codexSnapshot({
    primary: { used_percent: 26, window_minutes: 10_080 },
  })]);
  assert.match(markup, /ChatGPT Pro/u);
  assert.match(markup, /주간 사용량/u);
  assert.doesNotMatch(markup, /gpt-5\.6-codex/iu);
  assert.doesNotMatch(markup, /5시간 사용량/u);
});

test('the command layout keeps the pipeline first and the Codex limit in a dedicated side rail', () => {
  const markup = dashboard({
    snapshots: [codexSnapshot({ primary: { used_percent: 12 }, secondary: { used_percent: 88 } })],
    tasks: [harnessTask()],
  });
  assert.match(markup, /class="us-command-layout"/u);
  assert.match(markup, /class="us-pipeline-workspace"/u);
  assert.match(markup, /<aside class="us-quota-rail"/u);
  assert.ok(markup.indexOf('us-pipeline-workspace') < markup.indexOf('us-quota-rail'));
  assert.match(markup, /88%/u);
  assert.doesNotMatch(markup, /summary-strip|활성 작업|작업 카테고리|작업 중 AI|Codex 최고 사용률/u);
});

// 세션 트리는 "지금 어디"가 아니라 **전 단계 + 실제 액터**를 항상 그린다 (plan §4-1).
test('the session tree always renders every phase plus the reported actors', () => {
  const markup = createUsageRenderers().renderSessionView([harnessTask()], NOW, 'active');
  for (const expected of ['사용자 입력', '계약 · 증거 고정', '격리 구현 · 검증', '독립 반증 · 수정', '배포 · 기록', 'Main Codex', 'gpt-5.6-sol · xhigh', '독립 검토', 'WebGPT 실행자', 'WebGPT PRO', 'HARNESS E2E: PASS']) {
    assert.match(markup, new RegExp(expected, 'u'));
  }
  // 네 단계가 모두 노드로 서고, 진행 단계는 상태만 다르다.
  assert.equal((markup.match(/data-org-phase="/gu) || []).length, 4);
  assert.match(markup, /data-org-phase="review" data-phase-state="current"/u);
  assert.match(markup, /data-org-phase="done" data-phase-state="pending"/u);
  // 뿌리 → 총괄 → 단계 → 액터의 중첩 목록. 손계산 SVG 좌표는 쓰지 않는다 (DESIGN.md §9).
  assert.match(markup, /<ul class="h-tree">/u);
  assert.match(markup, /class="h-node is-request"/u);
  assert.match(markup, /class="h-node is-lead/u);
  assert.doesNotMatch(markup, /<svg/u);
  // 보고된 액터 3명이 전부 자기 노드를 갖는다.
  assert.equal((markup.match(/data-actor-id=/gu) || []).length, 3);
  assert.match(markup, /h-node-kind">WEBGPT</u);
  // 조직도는 확대·이동 캔버스 안에 있다.
  assert.match(markup, /class="h-org-viewport" data-org-view="session:usage-harness"/u);
});

test('overall, module, and actor progress render only from reported artifacts', () => {
  const task = harnessTask({
    progress: 64,
    modules: [
      { id: 'verify', name: '검증 단계', progress: 80, status: 'reviewing', owner: 'Main Codex' },
      { id: 'css', name: 'CSS 구현', progress: 88, status: 'working', owner: 'Main Codex' },
    ],
    actors: harnessTask().actors.map((actor, index) => ({
      ...actor,
      ...(index === 1 ? { role: '계산 작업', progress: 37 } : {}),
    })),
  });
  const markup = dashboard({ snapshots: [], tasks: [task] });
  // 진행도 바는 실제로 보고된 수치에만 붙는다: 총괄(64) + progress를 보고한 액터(37).
  // 나머지 액터는 수치가 없으므로 0% 바를 그리지 않는다. 대시보드는 세션 탭과 전체
  // 조직도 두 곳에 같은 세션을 그리므로 2 × 2 = 4가 계약값이다.
  assert.equal((markup.match(/진행도<\/span>/gu) || []).length, 4);
  assert.match(markup, /class="h-node is-lead[^"]*"[^>]*>[\s\S]*?<strong>64%<\/strong>/u);
  assert.match(markup, /계산 작업[\s\S]*?<strong>37%<\/strong>/u);
  for (const expected of ['검증 단계', '80%', 'CSS 구현', '88%']) {
    assert.match(markup, new RegExp(expected, 'u'));
  }
});

test('parallel project, protocol, and visualization reports render as session tabs with one visible panel', () => {
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
    assert.match(markup, new RegExp(category, 'u'));
  }
  assert.match(markup, /role="tablist" aria-label="작업 상태별 보기"/u);
  assert.match(markup, /role="tablist" aria-label="진행 중인 Codex 세션"/u);
  assert.equal((markup.match(/data-session-view="/gu) || []).length, 3);
  assert.equal((markup.match(/data-task-tab="/gu) || []).length, 3);
  assert.equal((markup.match(/data-session-view-panel="[^"]+" hidden/gu) || []).length, 2);
  assert.equal((markup.match(/data-task-panel="\d+" hidden/gu) || []).length, 2);
  assert.doesNotMatch(markup, /작업 카테고리<\/span>/u);
});

// 수정 라운드 M-2: 2차 세션 탭의 상태는 1차 탭(진행중/완료)이 이미 전달한다 — 탭에는
// 점을 두지 않고, 화면에 남는 모든 상태 점은 aria-hidden 점 + 텍스트 라벨 짝이어야 한다.
test('session tabs carry no status dot and every remaining dot pairs with a text label', () => {
  const markup = dashboard({
    snapshots: [codexSnapshot({ primary: { used_percent: 12 } })],
    tasks: [
      harnessTask(),
      harnessTask({ id: 'done-one', name: '완료 세션', status: 'complete', phase: 'done', progress: 100 }),
    ],
  });
  const tabs = markup.match(/<button class="h-session-tab[\s\S]*?<\/button>/gu) || [];
  assert.ok(tabs.length >= 2);
  for (const tab of tabs) assert.doesNotMatch(tab, /status-dot/u);
  // 점 자체는 계속 쓰인다(조직도·액터 상태 등) — 전부 사라져서 통과하는 일은 막는다.
  assert.ok((markup.match(/status-dot/gu) || []).length > 0);
  // 라벨 짝 규칙: 점을 닫은 직후에 태그가 아니라 텍스트가 와야 한다.
  assert.equal((markup.match(/status-dot[^"]*"[^>]*><\/(?:span|i)>\s*</gu) || []).length, 0);
});

test('active and completed tabs separate session state while the portfolio includes every reported actor', () => {
  const renderers = createUsageRenderers();
  const active = harnessTask({ id: 'active-one', name: '진행 세션' });
  const completed = harnessTask({
    id: 'complete-one', name: '완료 세션', status: 'complete', phase: 'done', progress: 100,
    actors: [],
  });
  const tasks = [active, completed];
  const views = renderers.renderSessionViews(tasks, NOW);
  assert.match(views, /data-session-view="active"[^>]*>[\s\S]*?data-view-count="1"/u);
  assert.match(views, /data-session-view="complete"[^>]*>[\s\S]*?data-view-count="1"/u);
  assert.match(views, /data-session-view="org"[^>]*>[\s\S]*?data-view-count="2"/u);

  const activeMarkup = renderers.renderSessionView(tasks, NOW, 'active');
  assert.match(activeMarkup, /진행 세션/u);
  assert.doesNotMatch(activeMarkup, /완료 세션/u);

  const completeMarkup = renderers.renderSessionView(tasks, NOW, 'complete');
  assert.match(completeMarkup, /완료 세션/u);
  assert.doesNotMatch(completeMarkup, /진행 세션/u);

  const org = renderers.renderPortfolioOrg(tasks, NOW);
  assert.match(org, /진행 세션/u);
  assert.match(org, /완료 세션[\s\S]*에이전트 보고 없음/u);
  assert.equal((org.match(/data-portfolio-task=/gu) || []).length, 2);
  assert.equal((org.match(/data-actor-id=/gu) || []).length, 3);
});

test('status-view activation exposes one view and keyboard wiring advances to the next view', () => {
  const { activateSessionView, wireSessionViews } = createUsageRenderers();
  const listeners = {};
  const makeTab = (view, selected = false) => ({
    dataset: { sessionView: view }, tabIndex: selected ? 0 : -1,
    attributes: { 'aria-selected': String(selected) },
    classList: { toggle(_name, value) { this.selected = value; } },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    closest() { return this; },
  });
  const tabs = [makeTab('active', true), makeTab('complete'), makeTab('org')];
  const panels = tabs.map((tab, index) => ({ dataset: { sessionViewPanel: tab.dataset.sessionView }, hidden: index !== 0 }));
  const tablist = {
    addEventListener(type, handler) { listeners[type] = handler; },
    querySelectorAll() { return tabs; },
    contains(tab) { return tabs.includes(tab); },
  };
  const root = {
    querySelector(selector) { return selector === '[data-session-view-panel="org"]' ? panels[2] : tablist; },
    querySelectorAll(selector) { return selector === '[data-session-view]' ? tabs : panels; },
  };

  activateSessionView(root, tabs[1], true);
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, false, true]);
  assert.equal(tabs[1].focused, true);

  wireSessionViews(root);
  let prevented = false;
  listeners.keydown({
    key: 'ArrowRight', target: tabs[1],
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, true, false]);
  assert.equal(tabs[2].focused, true);
});

// ---- 조직도 확대·이동 (plan §4-3) -----------------------------------------
// 계약은 셋이다: 처음에는 트리 전체가 보이게 맞추고, 휠은 커서를 고정점으로 확대하며,
// 배율은 0.3~2.5 밖으로 나가지 않는다. 그리고 그 휠 이벤트는 **조직도 안에서만** 잡는다.
function fakeOrgViewport(key, { clientWidth = 400, contentWidth = 1000 } = {}) {
  const canvas = { style: {}, scrollWidth: contentWidth, offsetWidth: contentWidth };
  return {
    canvas,
    listeners: {},
    dataset: { orgView: key },
    clientWidth,
    clientHeight: 300,
    classList: { add() {}, remove() {} },
    querySelector(selector) { return selector === '[data-org-canvas]' ? canvas : null; },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    getBoundingClientRect() { return { left: 0, top: 0 }; },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
}

const scaleOf = (viewport) => Number(/scale\(([\d.]+)\)/u.exec(viewport.canvas.style.transform)[1]);
const offsetOf = (viewport) => /translate\((-?\d+)px, (-?\d+)px\)/u.exec(viewport.canvas.style.transform).slice(1).map(Number);

test('an org view fits the whole tree on first paint and zooms around the cursor', () => {
  const { wireOrgViews } = createUsageRenderers();
  const viewport = fakeOrgViewport('portfolio');
  wireOrgViews({ querySelectorAll: (selector) => (selector === '[data-org-view]' ? [viewport] : []) });

  // 400px 창에 1000px 트리 → 0.4배로 줄여 전부 보인다. 남는 폭이 없으므로 x는 0.
  assert.equal(scaleOf(viewport), 0.4);
  assert.deepEqual(offsetOf(viewport), [0, 0]);

  // 휠은 preventDefault로 잡는다 — 이 리스너는 뷰포트에만 달려 있어 바깥 페이지
  // 스크롤은 그대로다.
  let prevented = false;
  viewport.listeners.wheel({
    deltaY: -100, clientX: 200, clientY: 150, preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  const zoomed = scaleOf(viewport);
  assert.ok(zoomed > 0.4, '휠 위로는 확대여야 합니다.');
  // 커서(200,150)가 가리키던 내용이 제자리에 있어야 한다: x' = 200 - (200 - x) * r.
  // r은 구현과 같은 식(exp(-deltaY * 0.0015))으로 다시 구한다 — 화면에 찍힌 3자리
  // 반올림 배율로 되계산하면 검사 쪽 오차가 생긴다.
  const ratio = Math.exp(100 * 0.0015);
  assert.equal(offsetOf(viewport)[0], Math.round(200 - (200 - 0) * ratio));
});

test('zoom stops at the 0.3-2.5 band and dragging pans the canvas', () => {
  const { wireOrgViews } = createUsageRenderers();
  const viewport = fakeOrgViewport('session:zoom', { clientWidth: 1000, contentWidth: 1000 });
  wireOrgViews({ querySelectorAll: (selector) => (selector === '[data-org-view]' ? [viewport] : []) });
  assert.equal(scaleOf(viewport), 1);

  const wheel = (deltaY) => viewport.listeners.wheel({ deltaY, clientX: 0, clientY: 0, preventDefault() {} });
  for (let index = 0; index < 60; index += 1) wheel(-200);
  assert.equal(scaleOf(viewport), 2.5);
  for (let index = 0; index < 200; index += 1) wheel(200);
  assert.equal(scaleOf(viewport), 0.3);

  // 끌기 = 이동. 눌린 지점과 커서의 차이가 그대로 오프셋이 된다.
  const before = offsetOf(viewport);
  viewport.listeners.pointerdown({ button: 0, pointerId: 7, clientX: 100, clientY: 100, target: {} });
  viewport.listeners.pointermove({ pointerId: 7, clientX: 160, clientY: 130 });
  assert.deepEqual(offsetOf(viewport), [before[0] + 60, before[1] + 30]);
  viewport.listeners.pointerup({ pointerId: 7 });
  // 손을 뗀 뒤의 커서 이동은 무시한다.
  viewport.listeners.pointermove({ pointerId: 7, clientX: 400, clientY: 400 });
  assert.deepEqual(offsetOf(viewport), [before[0] + 60, before[1] + 30]);
});

test('an org view keeps its zoom and pan across a re-render of the same key', () => {
  const renderers = createUsageRenderers();
  const first = fakeOrgViewport('portfolio');
  renderers.wireOrgViews({ querySelectorAll: (selector) => (selector === '[data-org-view]' ? [first] : []) });
  first.listeners.wheel({ deltaY: -300, clientX: 0, clientY: 0, preventDefault() {} });
  const held = first.canvas.style.transform;

  // 자동 갱신이 DOM을 갈아 끼운 상황: 같은 키의 새 뷰포트에 같은 시점이 복원된다.
  const second = fakeOrgViewport('portfolio');
  renderers.wireOrgViews({ querySelectorAll: (selector) => (selector === '[data-org-view]' ? [second] : []) });
  assert.equal(second.canvas.style.transform, held);
});

test('tab activation exposes one panel and keyboard wiring advances to the next session', () => {
  const { activateTaskTab, wireTaskTabs } = createUsageRenderers();
  const listeners = {};
  const makeTab = (index) => ({
    dataset: { taskTab: String(index), taskId: `task-${index}` },
    tabIndex: index === 0 ? 0 : -1,
    attributes: { 'aria-selected': index === 0 ? 'true' : 'false' },
    classList: { selected: index === 0, toggle(_name, value) { this.selected = value; } },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    closest() { return this; },
  });
  const tabs = [makeTab(0), makeTab(1), makeTab(2)];
  const panels = tabs.map((tab, index) => ({
    dataset: { taskPanel: String(index) },
    hidden: index !== 0,
  }));
  const tablist = {
    addEventListener(type, handler) { listeners[type] = handler; },
    querySelectorAll() { return tabs; },
    contains(tab) { return tabs.includes(tab); },
  };
  const root = {
    querySelector() { return tablist; },
    querySelectorAll(selector) { return selector === '[data-task-tab]' ? tabs : panels; },
  };

  activateTaskTab(root, tabs[1], true);
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, false, true]);
  assert.deepEqual(tabs.map((tab) => tab.attributes['aria-selected']), ['false', 'true', 'false']);
  assert.equal(tabs[1].focused, true);

  wireTaskTabs(root);
  let prevented = false;
  listeners.keydown({
    key: 'ArrowRight',
    target: tabs[1],
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, true, false]);
  assert.equal(tabs[2].focused, true);
});

test('manual refresh bypasses cache, reports success, and preserves the selected session', async () => {
  const tasks = [
    harnessTask({ id: 'task-one', name: '첫 세션' }),
    harnessTask({ id: 'task-two', name: '둘째 세션' }),
  ];
  const sandbox = await createUsageAppSandbox([
    { snapshots: [], tasks },
    { snapshots: [], tasks },
  ]);
  const makeTab = (index, id) => ({
    dataset: { taskTab: String(index), taskId: id }, tabIndex: index ? -1 : 0,
    classList: { toggle() {} }, setAttribute() {}, focus() {},
  });
  const tabs = [makeTab(0, 'task-one'), makeTab(1, 'task-two')];
  const panels = tabs.map((_, index) => ({ dataset: { taskPanel: String(index) }, hidden: index !== 0 }));
  sandbox.renderers.activateTaskTab({
    querySelectorAll(selector) { return selector === '[data-task-tab]' ? tabs : panels; },
  }, tabs[1]);

  await sandbox.store.get('reload').listeners.click();
  assert.equal(sandbox.requests.length, 2);
  assert.match(sandbox.requests[1].url, /\/api\/usage\?_=[0-9]+/u);
  assert.equal(sandbox.requests[1].options.cache, 'no-store');
  assert.equal(sandbox.store.get('reload').textContent, '업데이트됨');
  assert.equal(sandbox.store.get('usageRefreshStatus').textContent, '서버에서 방금 확인했습니다.');
  const markup = sandbox.store.get('usageBody').innerHTML;
  assert.match(markup, /data-task-panel="1"(?! hidden)/u);
});

test('failed manual refresh keeps the last good dashboard and restores the button', async () => {
  const data = { snapshots: [], tasks: [harnessTask()] };
  const sandbox = await createUsageAppSandbox([data, new Error('network down')]);
  const before = sandbox.store.get('usageBody').innerHTML;
  await sandbox.store.get('reload').listeners.click();
  assert.equal(sandbox.store.get('usageBody').innerHTML, before);
  assert.equal(sandbox.store.get('reload').textContent, '새로고침');
  assert.equal(sandbox.store.get('usageRefreshStatus').textContent, '업데이트하지 못했습니다.');
  assert.equal(sandbox.store.get('usageError').textContent, 'network down');
});

// 2026-08-27 사용자 지시로 Claude 한도가 복원됐다. 이전 "Claude 스냅샷은 무시한다"
// 회귀 테스트를 수용 케이스로 뒤집는다.
test('Claude snapshots render beside Codex and actor text is escaped', () => {
  const markup = dashboard({
    snapshots: [
      codexSnapshot({ primary: { used_percent: 12 } }),
      claudeSnapshot({
        'claude-opus-5': { five_hour: { used_percentage: 44 }, seven_day: { used_percentage: 61 } },
      }),
    ],
    tasks: [harnessTask({ name: '<img src=x onerror=alert(1)>' })],
  });
  assert.match(markup, /Claude 한도/u);
  assert.match(markup, /claude-opus-5/u);
  assert.match(markup, /5시간 사용량/u);
  assert.match(markup, /주간 사용량/u);
  assert.match(markup, />44%</u);
  // 카드 제목 기준으로 Codex가 먼저 온다 (SOURCE_LABELS 키 순서). rail 헤더의
  // "Codex · Claude 한도"와 섞이지 않게 태그 경계까지 붙여 찾는다.
  assert.ok(markup.includes('>Claude 한도<'));
  assert.ok(markup.indexOf('>Codex 한도<') < markup.indexOf('>Claude 한도<'));
  assert.doesNotMatch(markup, /<img/u);
  assert.match(markup, /&lt;img/u);
});

// 한쪽 원본이 아직 보고하지 않아도 rail에서 사라지지 않는다 — 빈 상태로 자리를 지킨다.
test('a source with no snapshot keeps its slot as a waiting empty state', () => {
  const markup = dashboard({
    snapshots: [codexSnapshot({ primary: { used_percent: 12 } })],
    tasks: [harnessTask()],
  });
  assert.match(markup, /Claude 한도/u);
  assert.match(markup, /수집 대기/u);
  assert.match(markup, /아직 Claude 스냅샷이 없습니다/u);
});

// 반대 조합도 고정한다 — Claude만 보고했고 Codex가 아직 없을 때 (review nit).
test('a Claude-only snapshot set renders its card while Codex keeps a waiting slot', () => {
  const markup = dashboard({
    snapshots: [claudeSnapshot({
      'claude-opus-5': { five_hour: { used_percentage: 44 }, seven_day: { used_percentage: 61 } },
    })],
    tasks: [harnessTask()],
  });
  assert.ok(markup.includes('>Claude 한도<'));
  assert.match(markup, />44%</u);
  assert.match(markup, />61%</u);
  assert.ok(markup.includes('>Codex 한도<'));
  assert.match(markup, /아직 Codex 스냅샷이 없습니다/u);
  assert.doesNotMatch(markup, /아직 Claude 스냅샷이 없습니다/u);
  // 자리 순서는 원본이 하나뿐이어도 SOURCE_LABELS 키 순서를 지킨다.
  assert.ok(markup.indexOf('>Codex 한도<') < markup.indexOf('>Claude 한도<'));
});

// 조직도는 Claude 파이프라인 액터도 그린다 (worker의 kind 허용 목록과 짝이다).
test('claude actors render in the reporting tree', () => {
  const markup = dashboard({
    snapshots: [codexSnapshot({ primary: { used_percent: 12 } })],
    tasks: [harnessTask({
      actors: [
        {
          id: 'wp-a:main', parent_id: '', name: 'Main Codex', kind: 'codex',
          model: 'gpt-5.6-sol', reasoning: 'xhigh', role: '총괄', status: 'working',
          assignment: '통합', progress: 50,
        },
        {
          id: 'wp-a:claude', parent_id: 'wp-a:main', name: 'Fable 5 오케스트레이터', kind: 'claude',
          model: 'claude-fable-5', reasoning: 'high', role: '기획', status: 'working',
          assignment: '한도 복원', progress: 70,
        },
      ],
    })],
  });
  assert.match(markup, /CLAUDE</u);
  assert.match(markup, /Fable 5 오케스트레이터/u);
  assert.match(markup, /claude-fable-5 · high/u);
});

test('an empty snapshot list and a payload without buckets render an empty state', async () => {
  // buildDashboard()를 직접 불러 빈 payload의 낮은 수준 렌더 계약을 확인한다.
  const { readSource, USAGE_APP_SOURCE } = await import('./render-sandbox.mjs');
  const vm = await import('node:vm');
  const context = {
    window: null,
    // 자동 갱신이 visibilitychange를 구독하므로 document에도 addEventListener가 있어야 한다.
    document: {
      addEventListener() {},
      visibilityState: 'visible',
      getElementById: () => ({ addEventListener() {}, textContent: '', innerHTML: '' }),
    },
    location: { pathname: '/usage/', search: '', replace() { throw new Error('login gate fired'); } },
    localStorage: { getItem: () => 'gate-token', removeItem() {} },
    fetch: () => new Promise(() => {}),
    setTimeout: () => 0,
    clearTimeout() {},
    console: { log() {}, warn() {}, error() {} },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readSource(USAGE_APP_SOURCE), context, { filename: USAGE_APP_SOURCE });
  const { buildDashboard } = context.USAGE_RENDER;

  assert.match(buildDashboard([], NOW), /아직 수집된 한도 기록이 없습니다/u);
  assert.match(buildDashboard(null, NOW), /아직 수집된 한도 기록이 없습니다/u);
  assert.match(
    buildDashboard([{ source: 'codex', captured_at: iso(HOUR), payload: { model: 'x' } }], NOW),
    /읽을 수 있는 Codex 한도 정보가 없습니다/u,
  );
});
