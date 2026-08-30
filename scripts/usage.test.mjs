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
import {
  createFakeClock, createUsageAppSandbox, createUsageRenderers, renderUsageDashboard,
  HANGING_RESPONSE,
} from './render-sandbox.mjs';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (offsetMs) => new Date(NOW - offsetMs).toISOString();

// renderUsageDashboard()는 command-center 골격이 없으면 throw한다(샌드박스의 계약 검사).
// 진행 중 패널은 워크트리 조판 하나만 사용한다.
function dashboard(input, now = NOW) {
  return renderUsageDashboard(input, now);
}

function worktree(renderers, task, now = NOW) {
  return renderers.renderWorktree(renderers.sessionWorktree(task, now), `${task.name || task.id} 실행 워크트리`);
}

function worktreeRow(markup, attribute, value) {
  const needle = `${attribute}="${value}"`;
  return markup.split(/(?=<div class="wt-row )/u).find((part) => part.includes(needle)) || '';
}

const codexSnapshot = (buckets, capturedAt = iso(HOUR)) => ({
  source: 'codex',
  captured_at: capturedAt,
  payload: { model: 'gpt-5.6-codex', plan_type: 'pro', rate_limits: buckets },
});

// claude 수집기는 모델별로 창을 담고, **모델마다 자기 수집 시각**을 함께 싣는다
// (claude-workspace scripts/usage-push.mjs buildClaudeReport).
// rateLimits 자리에 { at, buckets }를 주면 그 모델만 다른 시각으로 수집된 것으로 만든다.
const claudeSnapshot = (models, capturedAt = iso(HOUR)) => ({
  source: 'claude',
  captured_at: capturedAt,
  payload: {
    models: Object.fromEntries(Object.entries(models).map(([id, value]) => [id, {
      captured_at: value?.at || capturedAt,
      rate_limits: value?.buckets || value,
    }])),
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
  // 게이지 제목은 `<수집 원본> <창>`이다 (사용자 지시 ② — 게이지만 보고도 어느 계정의
  // 어떤 창인지 알 수 있어야 한다).
  assert.match(markup, />Codex 기본 사용량</u);
  assert.match(markup, />Codex 5시간</u);
  assert.match(markup, />Codex monthly</u);      // 모르는 키 → 키 문자열 그대로
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
  // 검사 범위는 **게이지 행의 값**이다. 화면의 다른 곳(수집 건강 상태·보고되지 않은 단계)도
  // 같은 말로 미기록을 판정하므로, 마크업 전체를 훑으면 이 계약과 무관한 문자열이 걸린다.
  const values = [...markup.matchAll(/<span class="list-row-value">([^<]*)<\/span>/gu)].map(([, value]) => value);
  assert.ok(values.length > 0, '게이지 행이 하나도 렌더되지 않으면 이 검사는 공허하게 통과한다.');
  for (const value of values) assert.notEqual(value, '기록 없음');
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

// ---- 수집 시각은 그룹(계정·모델)마다 정직하게 -------------------------------
//
// 실측된 결함(2026-08-28): 한 카드에 여러 그룹이 들어가는데 시각은 카드 머리 하나뿐이라,
// 몇 시간 전에 멈춘 모델과 방금 수집된 모델이 한 문장으로 뭉뚱그려졌다. 계약은
// usage.js의 "수집 시각 계약" 주석에 있다 — 그룹마다 자기 시각·지연, 카드 머리는
// 가장 신선한 그룹.

test('each model carries its own capture time and only the stale one is flagged', () => {
  const markup = dashboard([claudeSnapshot({
    'claude-opus-5': { at: iso(5 * 60_000), buckets: { five_hour: { used_percentage: 44 } } },
    'claude-fable-5': { at: iso(3 * HOUR), buckets: { five_hour: { used_percentage: 12 } } },
  }, iso(5 * 60_000))]);
  // 신선한 모델의 시각과 낡은 모델의 시각이 **둘 다** 화면에 있다.
  assert.match(markup, /5분 전 수집/u);
  assert.match(markup, /3시간 전 수집/u);
  // 지연 표시는 낡은 모델 쪽 하나뿐이다 — 카드 전체를 지연으로 묶지 않는다.
  assert.equal((markup.match(/수집 지연/gu) || []).length, 1);
});

test('the card head follows the freshest group, not the oldest or the row time', () => {
  // 행 시각이 낡아도(수집기가 오래 전에 행을 갱신) 그룹이 더 신선하면 그룹이 이긴다.
  const markup = dashboard([claudeSnapshot({
    'claude-opus-5': { at: iso(2 * 60_000), buckets: { five_hour: { used_percentage: 44 } } },
    'claude-fable-5': { at: iso(4 * HOUR), buckets: { five_hour: { used_percentage: 12 } } },
  }, iso(4 * HOUR))]);
  const head = markup.match(/Claude 한도<\/h3>\s*<span class="us-card-meta">([^<]*)</u);
  assert.ok(head, '카드 머리의 수집 시각 메타를 찾지 못했다');
  assert.equal(head[1], '2분 전 수집');
});

test('every group is delayed only when even the freshest one is', () => {
  const markup = dashboard([claudeSnapshot({
    'claude-opus-5': { at: iso(40 * 60_000), buckets: { five_hour: { used_percentage: 44 } } },
    'claude-fable-5': { at: iso(3 * HOUR), buckets: { five_hour: { used_percentage: 12 } } },
  }, iso(40 * 60_000))]);
  // 카드 머리 + 모델 둘 = 세 곳 모두 지연.
  assert.equal((markup.match(/수집 지연/gu) || []).length, 3);
});

// codex payload는 계정이 하나뿐이라 그룹 시각을 싣지 않는다 — 행 시각이 곧 그 계정의
// 시각이므로 **카드 머리와 그룹 머리**에 같은 값을 두 번 적지 않는다.
// (게이지 줄의 수집 표기는 다른 사실이다: 낡은 값 옆에서 그 값의 출처와 나이를 밝히는
//  것이고, 사용자 지시 ②가 요구한 표기다. 아래 stale 테스트가 그쪽을 본다.)
test('a source without per-group times prints its capture time once in the heads', () => {
  const markup = dashboard([codexSnapshot({ primary: { used_percent: 5 } }, iso(3 * HOUR))]);
  assert.equal((markup.match(/us-card-meta">3시간 전 수집/gu) || []).length, 1);
  assert.doesNotMatch(markup, /list-group-head-row/u);
  assert.equal((markup.match(/수집 지연/gu) || []).length, 1);
});

test('Pro weekly limit is account-scoped and never named after the active model', () => {
  const markup = dashboard([codexSnapshot({
    primary: { used_percent: 26, window_minutes: 10_080 },
  })]);
  assert.match(markup, /ChatGPT Pro/u);
  assert.match(markup, />Codex 주간</u);
  assert.doesNotMatch(markup, /gpt-5\.6-codex/iu);
  assert.doesNotMatch(markup, /5시간/u);
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

// 워크트리는 **보고된 단계 + 실제 액터**를 그린다. 여덟 단계는 모두 같은 행 어휘로 서며,
// 판독 어휘(data-org-phase·data-phase-state)는 그대로다.
test('the session tree always renders every phase plus the reported actors', () => {
  const markup = createUsageRenderers().renderSessionView([harnessTask()], NOW, 'active');
  for (const expected of ['계약 · 증거 고정', '격리 구현 · 검증', '독립 반증 · 지적', 'Main Codex', '독립 검토', 'WebGPT 실행자', 'WebGPT PRO', 'HARNESS E2E: PASS']) {
    assert.match(markup, new RegExp(expected, 'u'));
  }
  // 모델과 추론은 고정 모델 열 한 칸에서 둘 다 온전히 읽혀야 한다.
  assert.match(markup, /class="wt-model h-node-fact-mono">gpt-5\.6-sol · xhigh<\/span>/u);
  // 측정이 없는 단계도 소요 자리를 `—`로 지킨다 — 한 장만 이 줄이 없으면 나란히 선
  // 형제 카드들의 끝이 들쭉날쭉해진다 (review-visual N13).
  assert.match(markup, /class="wt-cell wt-time h-node-time" role="cell">—<\/div>/u);
  // 여덟 단계가 하나도 빠지지 않는다 — 카드가 된 것과 rest 줄로 내려간 것을 합쳐서다.
  assert.deepEqual(
    [...markup.matchAll(/data-org-phase="([a-z]+)"/gu)].map((match) => match[1]).sort(),
    ['approve', 'done', 'gate', 'input', 'plan', 'review', 'revise', 'work'],
  );
  // 카드가 되는 것은 보고된 단계뿐이고, 그 순서는 여전히 사슬 순서다.
  assert.deepEqual(
    [...markup.matchAll(/data-org-phase="([a-z]+)" data-phase-state="(?:done|current)"/gu)]
      .map((match) => match[1]),
    ['plan', 'work', 'review'],
  );
  assert.match(markup, /data-org-phase="review" data-phase-state="current"/u);
  // 이벤트가 없는 세션이라 구 4단계 키만 완료로 접히고, 확장으로 생긴 gate·input은
  // 보고된 적이 없으므로 완료가 아니라 '기록 없음'이다.
  assert.match(markup, /data-org-phase="plan" data-phase-state="done"/u);
  assert.match(markup, /data-org-phase="gate" data-phase-state="skipped"/u);
  assert.match(markup, /data-org-phase="input" data-phase-state="skipped"/u);
  assert.match(markup, /data-org-phase="revise" data-phase-state="pending"/u);
  assert.match(markup, /data-org-phase="done" data-phase-state="pending"/u);
  // 뿌리(총괄) → 깊이 1의 단계 → 깊이 2 이상의 액터 행. 손계산 SVG 좌표는 쓰지 않는다.
  assert.match(markup, /class="wt-row is-lead[^"]*" role="row"\s*data-depth="0"/u);
  assert.equal((markup.match(/class="wt-row is-phase[^"]*" role="row"\s*data-depth="1"/gu) || []).length, 8);
  assert.match(markup, /class="wt-row is-agent[^"]*" role="row"\s*data-depth="2"/u);
  // 사용자 입력은 조직도 노드가 아니다 — 요청 원문은 상세 머리의 inset 하나가 정본이다
  // (review-visual M4 · DESIGN.md §1.1 "그 밖의 노드를 추측해 추가하지 않는다").
  assert.doesNotMatch(markup, /is-request/u);
  assert.doesNotMatch(markup, /<svg/u);
  // 보고된 액터 3명이 전부 자기 노드를 갖는다.
  assert.equal((markup.match(/data-actor-id=/gu) || []).length, 3);
  assert.match(markup, /class="wt-kind">WebGPT<\/span>/u);
  // 워크트리는 변환 없는 문서 흐름 표다 (계약 §C — 캔버스·배율 제거).
  assert.match(markup, /class="wt-grid" role="table" data-worktree/u);
});

// 단계 사슬을 8단계로 넓힌 뒤에도 **구 4단계 키만 보고한 세션**은 그대로 읽혀야 한다
// (plan §4). 구 키는 새 사슬의 부분집합이므로, 보고된 단계까지는 완료로 서고 보고된 적
// 없는 새 단계(gate·revise·approve)는 그냥 대기로 선다 — 없는 이벤트를 지어내지 않는다.
test('legacy four-key reports still place every stage, leaving unreported ones pending', () => {
  const legacy = harnessTask({
    phase: 'work',
    events: [
      { ts: iso(3 * HOUR), kind: 'phase-change', phase: 'plan', model: 'gpt-5.6-sol', reasoning: 'xhigh' },
      { ts: iso(2 * HOUR), kind: 'phase-change', phase: 'work', model: 'gpt-5.6-sol', reasoning: 'xhigh' },
    ],
  });
  const markup = createUsageRenderers().renderSessionView([legacy], NOW, 'active');
  const states = Object.fromEntries(
    [...markup.matchAll(/data-org-phase="([a-z]+)" data-phase-state="([a-z]+)"/gu)]
      .map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(states, {
    // input은 이벤트에 없다 — 이벤트가 있는 세션에서 등장하지 않은 앞 단계는 완료가
    // 아니라 '기록 없음'이다 (없던 단계를 지어내지 않는다).
    input: 'skipped',
    plan: 'done',
    work: 'current',
    gate: 'pending',
    review: 'pending',
    revise: 'pending',
    approve: 'pending',
    done: 'pending',
  });
  // 구 보고에도 단계 소요시간은 그대로 붙는다 (plan 1시간).
  assert.match(worktreeRow(markup, 'data-org-phase', 'plan'), /class="wt-cell wt-time h-node-time" role="cell">1시간<\/div>/u);
});

// 새 키를 보고한 세션은 그 단계가 현재로 서고, 보고된 앞 단계만 완료로 접힌다.
test('the new stage keys carry status, model, and duration like the original four', () => {
  const task = harnessTask({
    phase: 'approve',
    events: [
      { ts: iso(2 * HOUR), kind: 'phase-change', phase: 'gate', model: 'gpt-5.6-sol', reasoning: 'xhigh' },
      { ts: iso(HOUR), kind: 'phase-change', phase: 'revise', model: 'claude-opus-5', reasoning: 'high' },
      { ts: iso(0), kind: 'phase-change', phase: 'approve', model: 'claude-fable-5', reasoning: 'high' },
    ],
  });
  const markup = createUsageRenderers().renderSessionView([task], NOW, 'active');
  assert.match(markup, /data-org-phase="approve" data-phase-state="current"/u);
  assert.match(markup, /data-org-phase="revise" data-phase-state="done"/u);
  assert.match(markup, /data-org-phase="done" data-phase-state="pending"/u);
  assert.match(worktreeRow(markup, 'data-org-phase', 'revise'), /class="wt-model h-node-fact-mono">claude-opus-5 · high<\/span>/u);
  assert.match(worktreeRow(markup, 'data-org-phase', 'gate'), /class="wt-cell wt-time h-node-time" role="cell">1시간<\/div>/u);
  // gate보다 앞선 input·plan·work는 이 세션이 보고한 적이 없다 — 완료로 세지 않는다.
  for (const phase of ['input', 'plan', 'work']) {
    assert.match(markup, new RegExp(`data-org-phase="${phase}" data-phase-state="skipped"`, 'u'));
  }
});

// review major(커밋 ab8f82a): 인덱스만 보고 앞 단계를 접으면 **보고된 적 없는 단계가
// 완료로 날조된다**. 구 4단계 세션이 review를 보고하면 그 사이의 gate가, done을 보고하면
// input·gate·revise·approve까지 전부 "완료"가 됐다. 앞 단계의 완료는 보고 이력이 근거다.
test('unreported stages before the current one read as no-record, never as done', () => {
  const renderers = createUsageRenderers();

  // (1) 이벤트가 있는 구 4단계 세션: 등장한 plan·work·review만 완료다.
  const legacyReview = harnessTask({
    phase: 'review',
    events: [
      { ts: iso(3 * HOUR), kind: 'phase-change', phase: 'plan' },
      { ts: iso(2 * HOUR), kind: 'phase-change', phase: 'work' },
      { ts: iso(HOUR), kind: 'phase-change', phase: 'review' },
    ],
  });
  const reviewStates = Object.fromEntries(
    [...renderers.renderSessionView([legacyReview], NOW, 'active')
      .matchAll(/data-org-phase="([a-z]+)" data-phase-state="([a-z]+)"/gu)]
      .map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(reviewStates, {
    input: 'skipped',
    plan: 'done',
    work: 'done',
    gate: 'skipped',
    review: 'current',
    revise: 'pending',
    approve: 'pending',
    done: 'pending',
  });

  // (2) 완료 보고도 앞 단계를 지어내지 않는다. 완료 사실만 done이고 나머지는 보고 이력대로다.
  const legacyDone = harnessTask({
    phase: 'done',
    status: 'complete',
    progress: 100,
    events: [
      { ts: iso(2 * HOUR), kind: 'phase-change', phase: 'work' },
      { ts: iso(HOUR), kind: 'phase-change', phase: 'done' },
    ],
  });
  const doneMarkup = renderers.renderSessionView([legacyDone], NOW, 'complete');
  const doneStates = Object.fromEntries(
    [...doneMarkup.matchAll(/data-org-phase="([a-z]+)" data-phase-state="([a-z]+)"/gu)]
      .map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(doneStates, {
    input: 'skipped',
    plan: 'skipped',
    work: 'done',
    gate: 'skipped',
    review: 'skipped',
    revise: 'skipped',
    approve: 'skipped',
    done: 'done',
  });
  // 건너뛴 단계 여섯 행은 판정과 사유를 각각 직접 말한다.
  const skipped = (doneMarkup.match(/data-phase-state="skipped"/gu) || []).length;
  assert.equal(skipped, 6);
  assert.equal((doneMarkup.match(/class="wt-cell wt-state" role="cell">기록 없음<\/div>/gu) || []).length, 6);
  assert.equal((doneMarkup.match(/class="wt-note">이 단계는 보고가 전송되지 않았습니다<\/span>/gu) || []).length, 6);
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
  const renderers = createUsageRenderers();
  const tree = worktree(renderers, task);
  // 진행은 실제로 보고된 수치에만 붙는다: 총괄(64) + progress를 보고한 액터(37).
  assert.match(worktreeRow(tree, 'data-actor-id', 'usage-harness:main'), /class="wt-cell wt-pct" role="cell">64%<\/div>/u);
  assert.match(worktreeRow(tree, 'data-actor-id', 'usage-harness:reviewer'), /class="wt-cell wt-pct" role="cell">37%<\/div>/u);
  assert.match(worktreeRow(tree, 'data-actor-id', 'usage-harness:webgpt'), /class="wt-cell wt-pct" role="cell">—<\/div>/u);
  const markup = dashboard({ snapshots: [], tasks: [task] });
  for (const expected of ['검증 단계', '80%', 'CSS 구현', '88%']) {
    assert.match(markup, new RegExp(expected, 'u'));
  }
  assert.doesNotMatch(tree, /class="wt-cell wt-pct" role="cell">0%<\/div>/u);
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
  }, NOW);
  for (const category of ['지문한장 프로젝트', '자체 pipeline 개선 프로토콜', '파이프라인 시각화']) {
    assert.match(markup, new RegExp(category, 'u'));
  }
  assert.match(markup, /role="tablist" aria-label="작업 상태별 보기"/u);
  assert.match(markup, /role="tablist" aria-label="진행 중인 세션"/u);
  // 상위 탭은 상태 셋(진행 중·중단됨·완료)이고, 그중 하나만 보인다.
  assert.equal((markup.match(/data-session-view="/gu) || []).length, 3);
  assert.equal((markup.match(/data-session-view-panel="[^"]+" hidden/gu) || []).length, 2);
  assert.equal((markup.match(/data-task-tab="/gu) || []).length, 3);
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
      harnessTask({ id: 'active-two', name: '둘째 진행 세션' }),
      harnessTask({ id: 'done-one', name: '완료 세션', status: 'complete', phase: 'done', progress: 100 }),
    ],
  }, NOW);
  const tabs = markup.match(/<button class="h-session-tab[\s\S]*?<\/button>/gu) || [];
  assert.ok(tabs.length >= 2);
  for (const tab of tabs) assert.doesNotMatch(tab, /status-dot/u);
  // 점 자체는 계속 쓰인다(워크트리·액터 상태 등) — 전부 사라져서 통과하는 일은 막는다.
  assert.ok((markup.match(/status-dot/gu) || []).length > 0);
  const rows = markup.split(/(?=<div class="wt-row )/u).filter((part) => /class="wt-row is-/u.test(part));
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.match(row, /class="status-dot is-(?:accent|idle|warn|danger)"/u);
    assert.match(row, /class="wt-cell wt-state" role="cell">[^<]*<\/div>/u);
  }
});

test('active, stale, and completed tabs separate session state while the worktree includes every reported actor', () => {
  const renderers = createUsageRenderers();
  const active = harnessTask({ id: 'active-one', name: '진행 세션' });
  // 서버(worker effectiveHarnessStatus)가 하트비트 끊긴 active를 stale로 파생해 보낸다.
  const stale = harnessTask({ id: 'stale-one', name: '중단 세션', status: 'stale' });
  const completed = harnessTask({
    id: 'complete-one', name: '완료 세션', status: 'complete', phase: 'done', progress: 100,
    actors: [],
  });
  const tasks = [active, stale, completed];
  const views = renderers.renderSessionViews(tasks, NOW);
  // 상위 탭은 **상태 셋**이며 진행 중 세션은 단일 워크트리를 쓴다.
  assert.match(views, /data-session-view="active"[^>]*>[\s\S]*?data-view-count="1"/u);
  assert.match(views, /data-session-view="stale"[^>]*>[\s\S]*?data-view-count="1"/u);
  assert.match(views, /data-session-view="complete"[^>]*>[\s\S]*?data-view-count="1"/u);
  assert.equal((views.match(/data-session-view="/gu) || []).length, 3);
  assert.doesNotMatch(views, /data-session-view="org"/u);

  const activeMarkup = renderers.renderSessionView(tasks, NOW, 'active');
  assert.match(activeMarkup, /진행 세션/u);
  assert.doesNotMatch(activeMarkup, /완료 세션|중단 세션/u);

  // 중단은 완료와 같은 게시글 목록이다. 끝난 것과 멎은 것을 가르는 말은 **상위 탭**이
  // 낸다 — 목록이 한 상태로 고정돼 있으면 행마다 같은 배지를 되풀이하지 않는다
  // (review-visual M3: 완료 10건 목록에서 '완료'가 필터·행·요약 셋으로 열 번 넘게 반복됐다).
  const staleMarkup = renderers.renderSessionView(tasks, NOW, 'stale');
  assert.match(staleMarkup, /중단 세션/u);
  assert.doesNotMatch(staleMarkup, /status-dot is-warn[^>]*><\/span>중단됨/u);
  assert.match(views, /data-session-view="stale"[^>]*>\s*<span>중단됨<\/span>/u);
  assert.doesNotMatch(staleMarkup, /진행 세션|완료 세션/u);

  const completeMarkup = renderers.renderSessionView(tasks, NOW, 'complete');
  assert.match(completeMarkup, /완료 세션/u);
  assert.doesNotMatch(completeMarkup, /진행 세션|중단 세션/u);

  // 진행 중 워크트리는 **실제로 도는 세션**만 그린다. 하트비트가 끊긴 세션이 여기 서면 화면이
  // 거짓말을 한다 (조사 §d의 false positive가 정확히 그 증상이었다).
  assert.match(activeMarkup, /진행 세션/u);
  assert.doesNotMatch(activeMarkup, /완료 세션|중단 세션|data-active-mode/u);
  assert.equal((activeMarkup.match(/data-worktree/gu) || []).length, 1);
  assert.equal((activeMarkup.match(/data-actor-id=/gu) || []).length, active.actors.length);

  // 접힌 것이 아니라 다른 탭으로 옮겨 갔을 뿐이다: 완료 세션과 그 상태는 완료 탭에 있다.
  assert.match(completeMarkup, /완료 세션[\s\S]*에이전트 보고 없음/u);
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

// ---- 조직도: 확대·이동을 **없앤 것**이 계약이다 (계약 §C) --------------------
//
// 예전에는 이 자리에 배율·오프셋을 재는 검사가 여럿 있었다. 그 검사들은 "축소가 얼마나
// 잘 되는가"를 물었고, 사용자의 판정은 "그 기능을 없애라"였다. 그래서 검사도 바뀐다:
// 재는 것이 아니라 **없다는 것**을 잠근다. 조판이 조용히 캔버스로 되돌아가거나 어딘가에서
// transform: scale이 되살아나면 여기서 깨진다.
//
// 이 검사가 **못 보는 것**: 실제 브라우저에서의 가로 스크롤 감촉과 모바일 세로 스택의
//   시각 결과. 그것은 docs/_snapshots/usage.html과 실화면 스크린샷이 사람 눈에 보여 준다.
test('the worktree renders in document flow with no zoom, pan, or scale transform', () => {
  const markup = createUsageRenderers().renderSessionView([harnessTask()], NOW, 'active');
  // 워크트리는 문서 흐름의 표다 — 변환 캔버스도, 뷰포트도 없다.
  assert.match(markup, /class="wt-grid" role="table" data-worktree/u);
  assert.doesNotMatch(markup, /h-org-viewport|h-org-canvas|data-org-view=|data-org-canvas/u);
  // 배율·이동이 마크업 어디에도 없다: 글자는 어느 폭에서도 CSS가 정한 크기 그대로다.
  assert.doesNotMatch(markup, /transform|scale\(|translate\(/u);
  // 조작 장치(축소·확대·맞춤 버튼과 힌트)도 함께 사라졌다 — 조작할 것이 없기 때문이다.
  assert.doesNotMatch(markup, /data-org-action|data-org-hint|맞춤|휠 확대|끌어 이동/u);
});

// 위 검사는 **렌더된 마크업**만 본다. 배율 코드가 이벤트 핸들러 쪽에 남아 있으면
// 마크업은 깨끗한데 화면은 여전히 확대된다 — 그래서 소스와 공개 렌더러 목록도 함께 잠근다.
test('the usage source carries no zoom, pan, or fit machinery at all', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../usage/assets/js/usage.js', import.meta.url), 'utf8');
  for (const banned of ['transform: scale', 'ZOOM_', 'PAN_STEP', 'fitOrgView', 'zoomOrgView', 'orgViewState', 'wireOrgViews']) {
    assert.ok(!source.includes(banned), `usage.js에 확대·이동 잔재가 남아 있습니다: ${banned}`);
  }
  // export만 남아도 다음 라운드가 되살려 쓴다 — 렌더러 목록에서도 지워졌는지 본다.
  const renderers = createUsageRenderers();
  for (const banned of ['wireOrgViews', 'fitOrgView', 'zoomOrgView', 'fitPendingOrgViews', 'orgViewState']) {
    assert.equal(renderers[banned], undefined, `USAGE_RENDER에 ${banned}가 남아 있습니다.`);
  }
});

// 스냅샷은 실화면과 **같은 CSS**로 찍힌다. 예전 사본은 캔버스 변환을 우회하는 전용 규칙을
// 끼워 넣어 초기 배율 문제를 가렸고(직전 리뷰 major 1 후반부), 캔버스가 사라진 지금 그
// 우회는 존재 이유가 없다. 빈 값이어야 사본과 실화면이 갈라지지 않는다.
test('the usage snapshot injects no snapshot-only CSS', async () => {
  const { USAGE_SNAPSHOT_CSS } = await import('./snapshot.mjs');
  assert.equal(USAGE_SNAPSHOT_CSS, '',
    '스냅샷 전용 CSS가 생기면 사본이 실화면과 다른 규칙으로 그려진다 (리뷰가 지적한 사각지대).');
});

// ---- 단일 워크트리 조판 (계약 §A) -----------------------------------------
test('the active panel carries no board/org mode toggle', () => {
  const markup = createUsageRenderers().renderSessionView([harnessTask()], NOW, 'active');
  assert.equal((markup.match(/data-active-mode/gu) || []).length, 0);
  assert.equal((markup.match(/data-worktree/gu) || []).length, 1);
});

// ---- 관제탑 칩: 조직도의 사실을 그대로 싣는다 (계약 §B) ---------------------
// 요청 원문 1번이 "현 조직도가 가진 상세 내용·서브에이전트 기록을 관제탑 형식에도
// 적용한다"였다. 그러므로 칩은 요약이 아니라 **같은 사실의 다른 조판**이어야 한다.
test('a worktree actor row carries all six facts and keeps its delegation depth', () => {
  const renderers = createUsageRenderers();
  const markup = worktree(renderers, wp3Task());
  // 계층이 평탄화되지 않는다: 손자는 부모보다 한 단 깊은 행으로 남는다.
  const parent = worktreeRow(markup, 'data-actor-id', 'wp3:server');
  const child = worktreeRow(markup, 'data-actor-id', 'wp3:server-sub');
  assert.match(parent, /data-depth="2"/u);
  assert.match(child, /data-depth="3"/u);
  assert.match(child, /class="wt-guide"[^>]*>│\s+│\s+└─ /u);
  // 이름·역할·담당·모델+추론·상태·소요·진행률 값이 하나도 사라지지 않는다.
  assert.match(parent, /class="wt-name">서버 구현자</u);
  assert.match(parent, /class="wt-model h-node-fact-mono">gpt-5\.2-codex · xhigh</u);
  assert.match(parent, /class="wt-cell wt-state" role="cell">완료/u);
  assert.match(parent, /class="wt-cell wt-time h-node-time" role="cell">1시간/u);
  assert.match(parent, /class="wt-cell wt-pct" role="cell">100%/u);
  assert.match(parent, /class="wt-sub" role="cell">백엔드 구현 · worker 자동 스탬프/u);
  // 종료된 액터도 자기 단계의 행으로 남는다 — 사라지면 그 단계가 비어 보인다.
  assert.match(markup, /data-org-phase="gate"[\s\S]*?data-actor-id="wp3:gate"/u);
  // 보고가 없는 값은 0%로 지어내지 않고 명시적인 미측정 표식으로 남는다.
  assert.doesNotMatch(markup, /class="wt-cell wt-pct" role="cell">0%/u);
  assert.doesNotMatch(markup, /undefined|NaN/u);
});

// ---- major 3 후속: 방향키가 날짜 그룹 경계를 넘는다 --------------------------
// 렌더 시점의 tabindex는 직전 라운드가 고쳤다. 남은 절반은 **이동 범위**다: roving을
// tablist 안으로 묶으면 첫 그룹 끝에 닿은 사람이 둘째 그룹으로 갈 방법이 없다.
test('arrow keys move focus out of one date group into the next', () => {
  const { wireTaskTabs } = createUsageRenderers();
  const listeners = [];
  const makeTab = (index) => ({
    dataset: { taskTab: String(index), taskId: `t${index}`, taskStatus: 'complete' },
    tabIndex: index === 0 ? 0 : -1,
    attributes: {},
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
    closest() { return this; },
  });
  const tabs = [makeTab(0), makeTab(1)];
  const panels = tabs.map((tab, index) => ({ dataset: { taskPanel: String(index) }, hidden: index !== 0 }));
  let lists = [];
  const switcher = {
    querySelectorAll(selector) {
      if (selector === '[data-task-tab]') return tabs;
      if (selector === '[data-task-panel]') return panels;
      return lists;
    },
  };
  const makeList = (own) => ({
    addEventListener(type, handler) { listeners.push([this, type, handler]); },
    querySelectorAll() { return own; },
    contains(tab) { return own.includes(tab); },
    closest() { return switcher; },
  });
  // 날짜 그룹 둘 — 각 tablist에 탭 하나씩.
  lists = [makeList([tabs[0]]), makeList([tabs[1]])];
  const root = {
    querySelector() { return lists[0]; },
    querySelectorAll(selector) {
      if (selector === '[data-task-tablist]') return lists;
      if (selector === '[data-task-tab]') return tabs;
      return panels;
    },
  };

  wireTaskTabs(root);
  const keydown = listeners.find(([list, type]) => list === lists[0] && type === 'keydown')[2];
  keydown({ key: 'ArrowRight', target: tabs[0], preventDefault() {} });
  assert.equal(tabs[1].focused, true, '첫 그룹의 탭에서 오른쪽 키가 둘째 그룹으로 넘어가야 합니다.');
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, false]);
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
  // 워크트리의 세션 탭 선택이 재렌더 뒤에도 보존되어야 한다.
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
  // 사용자 지시 ②가 요구한 세 라벨 중 둘이 여기서 선다.
  assert.match(markup, />Claude 5시간</u);
  assert.match(markup, />Claude 주간</u);
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
  }, NOW);
  // 액터 종류 라벨은 제품 이름 그대로다 (사용자 지시 ③ — 화면이 만드는 약어 금지).
  assert.match(markup, />Claude</u);
  assert.doesNotMatch(markup, />CLAUDE</u);
  assert.match(markup, /Fable 5 오케스트레이터/u);
  assert.match(markup, /class="wt-model h-node-fact-mono">claude-fable-5 · high<\/span>/u);
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

// ---- 자동 갱신의 생존 (review WPA2 M2) ------------------------------------
// 계약: 성공·거절·**응답 없음** 셋 다 in-flight 잠금을 풀고 다음 주기를 예약한다.
// 이전 구현은 세 번째 경우에 finally가 영영 돌지 않아 화면이 조용히 멎었다.
test('a fetch that never settles times out and the automatic poll keeps running', async () => {
  const clock = createFakeClock();
  const sandbox = await createUsageAppSandbox(
    [HANGING_RESPONSE, { snapshots: [], tasks: [harnessTask()] }],
    { clock },
  );
  assert.equal(sandbox.requests.length, 1);

  // 제한 시간 전에는 재요청하지 않는다 — 요청을 겹치지 않는 성질은 그대로다.
  await clock.advance(14_000);
  assert.equal(sandbox.requests.length, 1);

  // 15초에서 시간초과 → 오류를 말하고 사본 요청 없이 다음 주기를 예약한다.
  await clock.advance(2_000);
  assert.equal(sandbox.requests.length, 1);
  assert.match(sandbox.store.get('usageError').textContent, /응답이 없어/u);

  // 유휴 주기(60초) 뒤 다음 피드 요청이 실제로 나가고 화면이 채워진다.
  await clock.advance(60_000);
  assert.equal(sandbox.requests.length, 2);
  assert.match(sandbox.store.get('usageBody').innerHTML, /data-worktree/u);
  assert.equal(sandbox.store.get('usageError').textContent, '');
});

// ---- 결측은 0이 아니다 (review WPA2 M1) -----------------------------------
test('null usage snapshots and a null actor percent stay unmeasured instead of becoming zero', () => {
  const renderers = createUsageRenderers();
  const task = harnessTask({
    id: 'null-events',
    events: [
      // 앞머리 null: 아직 스냅샷이 없던 시점. 뒤의 90 → 80만 소모다(10%p).
      { ts: iso(3 * HOUR), kind: 'phase-change', phase: 'plan', usage_codex: null, usage_claude: null },
      { ts: iso(2 * HOUR), kind: 'phase-change', phase: 'work', usage_codex: null, usage_claude: 90 },
      { ts: iso(HOUR), kind: 'report', phase: 'review', actor_id: 'usage-harness:reviewer', percent: 55, usage_claude: 80 },
      // 꼬리 null: 진행률을 싣지 않은 늦은 보고가 앞선 55%를 0%로 덮으면 안 된다.
      { ts: iso(0), kind: 'report', phase: 'review', actor_id: 'usage-harness:reviewer', percent: null, usage_claude: null },
    ],
  });
  const markup = renderers.renderTask(task, NOW);
  assert.match(markup, /이 세션 소모 · Claude 10\.0%p/u);
  // Codex는 측정값이 하나도 없다 — 0%p로 지어내지 않는다.
  assert.doesNotMatch(markup, /소모[^<]*Codex/u);
  assert.doesNotMatch(markup, /Claude 80\.0%p/u);
  assert.match(worktreeRow(markup, 'data-actor-id', 'usage-harness:reviewer'), /class="wt-cell wt-pct" role="cell">55%<\/div>/u);
});

// 한도 창이 초기화되면 잔여가 도로 오른다. 그 상승은 소모가 아니므로 더하지 않고,
// 초기화가 있었다는 사실만 따로 적는다.
test('a quota window reset is excluded from consumption and marked', () => {
  const renderers = createUsageRenderers();
  const task = harnessTask({
    id: 'reset-events',
    events: [
      { ts: iso(4 * HOUR), kind: 'phase-change', phase: 'plan', usage_codex: 30 },
      { ts: iso(3 * HOUR), kind: 'phase-change', phase: 'work', usage_codex: 12 },
      { ts: iso(2 * HOUR), kind: 'report', phase: 'work', usage_codex: 100 },
      { ts: iso(HOUR), kind: 'phase-change', phase: 'review', usage_codex: 93 },
    ],
  });
  const markup = renderers.renderTask(task, NOW);
  // 18 + 7 = 25%p. 12 → 100의 상승(+88)은 소모가 아니다.
  assert.match(markup, /이 세션 소모 · Codex 25\.0%p \(한도 초기화 1회\)/u);
});

// ---- Worker → 브라우저 경계 계약 (review WPA2 B1 / M5) ---------------------
// 여기서는 이벤트 fixture를 손으로 짓지 않는다. **실제 Worker**에 스냅샷과 하네스
// 보고를 넣고, Worker가 조립한 GET /api/usage 응답을 그대로 렌더러에 먹인다.
// usage_codex·usage_claude가 "잔여 한도"라는 뜻이 양쪽에서 같아야만 통과한다 —
// 손으로 지은 "증가하는 사용량" fixture는 이 어긋남을 볼 수 없었다.
function harnessReportBody(overrides = {}) {
  return {
    version: 1,
    task_id: 'usage-harness',
    occurred_at: '2026-08-27T09:00:00.000Z',
    task: {
      name: '사용량 하네스 시각화 (08-27)',
      phase: 'work',
      progress: 55,
      status: 'active',
      model: 'gpt-5.6-sol',
      reasoning: 'xhigh',
      category_key: 'pipeline-visualization',
      category: '파이프라인 시각화',
      current: 'Worker 연결',
      done: '계약 고정',
      next: '화면 렌더',
      deadline: '20:10 KST',
    },
    actors: [{
      id: 'usage-harness:main',
      parent_id: '',
      name: 'Main Codex',
      kind: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'xhigh',
      role: '기획 · 통합 · 최종 판정',
      status: 'working',
      assignment: 'Worker 연결',
      progress: 55,
    }],
    modules: [],
    artifacts: ['npm test'],
    ...overrides,
  };
}

function workerBoundaryEnv() {
  const state = { snapshots: new Map(), tasks: new Map(), events: [], eventId: 0 };
  const env = {
    ALLOWED_ORIGIN: 'https://example.test',
    OWNER_USERNAME: 'hvsdcm',
    USAGE_INGEST_TOKEN: 'usage-token',
    HARNESS_INGEST_TOKEN: 'harness-token',
    DB: {
      // D1 batch는 한 트랜잭션에서 순서대로 돈다. 이벤트 삽입은 바로 앞 upsert의
      // changes()를 보므로 그 연결도 그대로 흉내 낸다.
      async batch(statements) {
        let changes = 0;
        const results = [];
        for (const statement of statements) {
          const result = await statement.run(changes);
          changes = result?.meta?.changes || 0;
          results.push(result);
        }
        return results;
      },
      prepare(sql) {
        if (sql.includes('INSERT INTO usage_source_health') || sql.includes('UPDATE usage_source_health')) {
          return { bind() { return { async run() { return { success: true, meta: { changes: 1 } }; } }; } };
        }
        if (sql.includes('INSERT INTO usage_snapshots')) {
          return {
            bind(source, capturedAt, payload) {
              return {
                async run() {
                  state.snapshots.set(source, { source, captured_at: capturedAt, payload });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }
        if (sql.includes('FROM usage_snapshots')) {
          return {
            bind(...sources) {
              return {
                async all() {
                  return {
                    results: [...state.snapshots.values()].filter((row) => sources.includes(row.source)),
                  };
                },
              };
            },
          };
        }
        if (sql.includes('SELECT s.*, u.username')) {
          return {
            bind() {
              return {
                async first() {
                  return { token_hash: 'stored-user-hash', role: 'user', disabled: 0, username: 'hvsdcm' };
                },
              };
            },
          };
        }
        if (sql.includes('UPDATE sessions')) {
          return { bind() { return { async run() { return { success: true }; } }; } };
        }
        if (sql.includes('SELECT payload FROM harness_tasks')) {
          return { bind(taskId) { return { async first() { return state.tasks.get(taskId) || null; } }; } };
        }
        if (sql.includes('INSERT INTO harness_tasks')) {
          return {
            bind(taskId, status, updatedAt, payload) {
              return {
                async run() {
                  state.tasks.set(taskId, {
                    task_id: taskId, status, updated_at: updatedAt, payload,
                  });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }
        if (sql.includes('INSERT INTO harness_events')) {
          return {
            bind(taskId, ts, kind, actorId, phase, percent, model, reasoning, status, usageCodex, usageClaude) {
              return {
                async run(changes) {
                  if (changes === 0) return { success: true, meta: { changes: 0 } };
                  state.eventId += 1;
                  state.events.push({
                    task_id: taskId,
                    id: state.eventId,
                    ts,
                    kind,
                    actor_id: actorId,
                    phase,
                    percent,
                    model,
                    reasoning,
                    status,
                    usage_codex: usageCodex,
                    usage_claude: usageClaude,
                  });
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        }
        if (sql.includes('DELETE FROM harness_events')) {
          return { async run() { return { success: true, meta: { changes: 0 } }; } };
        }
        if (sql.includes('FROM harness_tasks')) {
          return { async all() { return { results: [...state.tasks.values()] }; } };
        }
        if (sql.includes('FROM harness_events')) {
          return { async all() { return { results: state.events }; } };
        }
        throw new Error(`Unexpected SQL in the worker boundary test: ${sql}`);
      },
    },
  };
  return { env, state };
}

test('consumption rendered in the browser matches what the Worker actually records', async () => {
  const { default: worker } = await import('../worker/src/index.js');
  const { env, state } = workerBoundaryEnv();
  const liveNow = Date.now();
  const postSnapshot = (usedPercent) => worker.fetch(new Request('https://api.test/api/usage/report', {
    method: 'POST',
    headers: { authorization: 'Bearer usage-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'codex',
      captured_at: '2026-08-27T09:00:00.000Z',
      payload: {
        model: 'gpt-5.6-codex',
        plan_type: 'pro',
        rate_limits: { secondary: { used_percent: usedPercent, window_minutes: 10_080 } },
      },
    }),
  }), env);
  const postReport = (occurredAt) => {
    const report = harnessReportBody({ occurred_at: occurredAt });
    report.task.heartbeat_at = new Date().toISOString();
    return worker.fetch(new Request('https://api.test/api/harness/report', {
      method: 'POST',
      headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
      body: JSON.stringify(report),
    }), env);
  };

  // 사용량 20% → 잔여 80, 이어서 사용량 40% → 잔여 60. 이 세션이 쓴 것은 20%p다.
  assert.equal((await postSnapshot(20)).status, 200);
  assert.equal((await postReport(new Date(liveNow - 60_000).toISOString())).status, 200);
  assert.equal((await postSnapshot(40)).status, 200);
  assert.equal((await postReport(new Date(liveNow).toISOString())).status, 200);

  // Worker가 적는 것은 **잔여**다 — 이 전제가 깨지면 아래 렌더 기대값도 함께 깨진다.
  assert.deepEqual(state.events.map((event) => event.usage_codex), [80, 60]);
  assert.deepEqual(state.events.map((event) => event.usage_claude), [null, null]);

  const response = await worker.fetch(new Request('https://api.test/api/usage', {
    headers: { authorization: 'Bearer user-token', 'cf-connecting-ip': '198.51.100.7' },
  }), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].events.length, 2);

  const markup = createUsageRenderers().renderTask(data.tasks[0], liveNow);
  assert.match(markup, /이 세션 소모 · Codex 20\.0%p/u);
  // Claude 스냅샷이 없어 두 이벤트 모두 null이다 — 0%p 소모를 지어내지 않는다.
  assert.doesNotMatch(markup, /소모[^<]*Claude/u);
});

// ---- 워크트리 조판 계약 ----------------------------------------------------
test('the worktree renders the approved vocabulary and names every stage state in text', () => {
  const renderers = createUsageRenderers();
  const markup = worktree(renderers, harnessTask());
  for (const vocabulary of ['wt-grid', 'wt-row is-lead', 'wt-row is-phase', 'wt-row is-agent', 'wt-cell wt-state', 'wt-cell wt-pct']) {
    assert.ok(markup.includes(`class="${vocabulary}`), `${vocabulary}가 조판에서 사라졌습니다.`);
  }
  // 워크트리 하나에 여덟 단계가 상시 선다 — 대기·기록 없음도 행을 차지한다.
  const stages = markup.match(/class="wt-row is-phase[^"]*"/gu) || [];
  assert.equal(stages.length, 8);
  const labels = { done: '완료', current: '진행 중', pending: '대기', skipped: '기록 없음' };
  for (const [state, label] of Object.entries(labels)) {
    const row = markup.split(/(?=<div class="wt-row )/u).find((part) => part.includes(`data-phase-state="${state}"`)) || '';
    assert.match(row, new RegExp(`class="wt-cell wt-state" role="cell">${label}<\\/div>`, 'u'));
  }
  // 옛 두 조판이 되살아나면(중복 UI) 여기서 잡힌다.
  assert.doesNotMatch(markup, /class="pl-|class="h-node\s|h-orgchart|data-org-canvas/u);
});

// ---- WP3: 상→하 축 · actor 고정 배치 · 개별 수치 (2026-08-28) --------------
//
// 계약(sessions/2026-08-28-usage-조직도-개선/plan.md §3.3)은 다섯이다:
//   ① 상세 조직도의 축은 **위→아래**이고, 서브에이전트만 축 노드의 오른쪽으로 갈라진다.
//   ② 위임된 서브에이전트는 손자까지 전부 보인다 (parent_id 계층 유지).
//   ③ 역할·담당·소요시간·한도 소비 추정이 **각각 별도 줄**로 나온다 (겹쳐 쓰지 않는다).
//   ④ actor 배치는 이벤트 추정이 아니라 **API가 준 actor.phase 고정 배치**다 —
//      그래야 종료된 단계에도 그 단계에 투입됐던 actor가 영구히 남는다.
//   ⑤ 신규 필드(phase·started_at·usage_at_*)가 하나도 없는 구 payload도 그대로 그려진다.
//
// 이 검사가 **못 보는 것**: 실제 CSS 조판(축이 정말 세로로 보이는지)은 docs/_snapshots가
//   사람 눈에 보여 준다. 여기서는 조판을 지탱하는 **마크업 구조**만 잠근다.

const wp3Task = () => harnessTask({
  id: 'wp3',
  phase: 'review',
  status: 'active',
  events: [],
  actors: [
    {
      id: 'wp3:main', parent_id: '', name: '오케스트레이터', kind: 'claude',
      model: 'claude-fable-5', reasoning: 'high', role: '기획 · 오케스트레이션',
      assignment: 'WP 배정과 계약 고정', status: 'working', phase: 'plan',
      started_at: iso(4 * HOUR),
    },
    {
      id: 'wp3:server', parent_id: 'wp3:main', name: '서버 구현자', kind: 'codex',
      model: 'gpt-5.2-codex', reasoning: 'xhigh', role: '백엔드 구현',
      assignment: 'worker 자동 스탬프', status: 'done', phase: 'work', progress: 100,
      started_at: iso(3 * HOUR), finished_at: iso(2 * HOUR),
      usage_at_start: { codex: 88, claude: 40 }, usage_at_end: { codex: 80.5, claude: 39 },
    },
    {
      id: 'wp3:server-sub', parent_id: 'wp3:server', name: '테스트 서브에이전트', kind: 'codex',
      model: 'gpt-5.2-codex', reasoning: 'high', role: '검증', assignment: '픽스처 도출',
      status: 'done', phase: 'work', started_at: iso(3 * HOUR), finished_at: iso(150 * 60_000),
    },
    {
      id: 'wp3:front', parent_id: 'wp3:main', name: '프론트 구현자', kind: 'claude',
      model: 'claude-opus-5', reasoning: 'high', role: '프론트 구현',
      assignment: '조직도 재작성', status: 'working', phase: 'work',
      started_at: iso(2 * HOUR), usage_at_start: { codex: 80, claude: 38 },
    },
    {
      id: 'wp3:gate', parent_id: 'wp3:main', name: '게이트 러너', kind: 'codex',
      model: 'gpt-5.2-codex', reasoning: 'medium', role: '기계 게이트',
      assignment: 'npm test', status: 'done', phase: 'gate',
      started_at: iso(90 * 60_000), finished_at: iso(80 * 60_000),
    },
  ],
});

test('the worktree places one root above eight phases and nests actors below them', () => {
  const markup = createUsageRenderers().renderSessionView([wp3Task()], NOW, 'active');
  assert.match(markup, /class="wt-grid" role="table" data-worktree/u);
  const leadRows = markup.match(/class="wt-row is-lead[^"]*" role="row"\s*data-depth="0"/gu) || [];
  assert.equal(leadRows.length, 1);
  const lead = worktreeRow(markup, 'data-actor-id', 'wp3:main');
  assert.match(lead, /class="wt-guide" aria-hidden="true"><\/span>/u);
  assert.equal((markup.match(/class="wt-row is-phase[^"]*" role="row"\s*data-depth="1"/gu) || []).length, 8);
  const actorDepths = [...markup.matchAll(/class="wt-row is-agent[^"]*" role="row"\s*data-depth="(\d+)"/gu)]
    .map((match) => Number(match[1]));
  assert.equal(actorDepths.length, 4);
  assert.ok(actorDepths.every((depth) => depth >= 2));
  assert.doesNotMatch(markup, /<svg/u);
});

test('a delegated grandchild agent is drawn nested under its parent, not dropped', () => {
  const markup = createUsageRenderers().renderSessionView([wp3Task()], NOW, 'active');
  // 보고된 액터 5명이 전부 자기 노드를 갖는다 (총괄 1 + 서브 4).
  assert.equal((markup.match(/data-actor-id=/gu) || []).length, 5);
  const parent = worktreeRow(markup, 'data-actor-id', 'wp3:server');
  const child = worktreeRow(markup, 'data-actor-id', 'wp3:server-sub');
  assert.match(parent, /data-depth="2"/u);
  assert.match(child, /data-depth="3"/u);
  assert.match(child, /class="wt-guide"[^>]*>[^<]*│[^<]*└─ /u);
  assert.ok(markup.indexOf('data-actor-id="wp3:server"') < markup.indexOf('data-actor-id="wp3:server-sub"'));
});

test('role, assignment, duration, and the quota estimate each get their own line', () => {
  const renderers = createUsageRenderers();
  const markup = renderers.renderSessionView([wp3Task()], NOW, 'active');
  const server = worktreeRow(markup, 'data-actor-id', 'wp3:server');
  const front = worktreeRow(markup, 'data-actor-id', 'wp3:front');
  // 역할·담당·한도 소비가 같은 보조 줄에서 모두 온전히 나온다. 줄 전체를 끝(`</p>`)까지
  // 못박아 값이 하나라도 빠지거나 순서가 바뀌면 깨지게 한다 — 이 계약이 헐거웠을 때
  // 워크트리가 한도 추정치를 통째로 잃은 채 초록불로 지나갔다(2026-08-30 이관 라운드).
  assert.match(server, /class="wt-sub" role="cell">백엔드 구현 · worker 자동 스탬프 · 한도 소비 Codex 7\.5%p 추정<\/p>/u);
  // 소요시간: 끝난 액터는 시작~종료, 진행 중인 액터는 시작~지금.
  assert.match(server, /class="wt-cell wt-time h-node-time" role="cell">1시간<\/div>/u);
  assert.match(front, /class="wt-cell wt-time h-node-time" role="cell">2시간<\/div>/u);
  // 한도 소비는 **추정**이다: 잔여의 감소분(88 → 80.5)이고, 라벨에 그렇게 적는다.
  assert.match(server, /Codex 7\.5%p 추정/u);
  // 종료 스냅샷이 없는 액터에는 소비 줄 자체가 없다 — 0%p로 지어내지 않는다.
  assert.doesNotMatch(front, /%p 추정/u);
  // 모델은 정확한 모델명 그대로, 같은 라벨-값 격자의 첫 줄로 낸다. 추론 단계는 **그 다음
  // 줄**이다 — 한 줄에 붙이면 노드 폭이 모자라 늘 추론 쪽이 잘렸다 (review-visual M7).
  assert.match(server, /class="wt-model h-node-fact-mono">gpt-5\.2-codex · xhigh<\/span>/u);
  // 진행 중 노드는 테두리만이 아니라 글자 라벨로도 구분된다 (색각 조건).
  assert.match(front, /class="wt-cell wt-state" role="cell">작업 중<\/div>/u);
});

test('actors stay in the phase the API assigned even when the task has moved on', () => {
  const renderers = createUsageRenderers();
  // 이벤트 로그가 아예 없는 세션이다(보존 기간이 지나 사라진 상태를 흉내 낸다).
  // 그래도 게이트 러너는 task의 현재 단계(review)로 끌려가지 않고 gate에 남아야 한다.
  const markup = renderers.renderSessionView([wp3Task()], NOW, 'active');
  const gateBlock = /data-org-phase="gate"[\s\S]*?data-org-phase="review"/u.exec(markup)[0];
  assert.match(gateBlock, /data-actor-id="wp3:gate"/u);
  const workBlock = /data-org-phase="work"[\s\S]*?data-org-phase="gate"/u.exec(markup)[0];
  assert.match(workBlock, /data-actor-id="wp3:server"/u);
  assert.match(workBlock, /data-actor-id="wp3:front"/u);
});

test('a payload without any of the new fields still renders through the old inference', () => {
  const renderers = createUsageRenderers();
  // phase·started_at·usage_at_* 가 하나도 없는 구 보고. 이벤트가 액터의 단계를 말한다.
  const legacy = harnessTask({
    id: 'legacy-actor',
    phase: 'review',
    events: [
      { ts: iso(3 * HOUR), kind: 'phase-change', phase: 'work' },
      { ts: iso(2 * HOUR), kind: 'report', phase: 'work', actor_id: 'usage-harness:webgpt', percent: 30 },
      { ts: iso(HOUR), kind: 'phase-change', phase: 'review' },
    ],
  });
  const markup = renderers.renderSessionView([legacy], NOW, 'active');
  // 이벤트가 말한 단계(work)에 그 액터가 선다 — 종전 추정 경로가 그대로 살아 있다.
  const workBlock = /data-org-phase="work"[\s\S]*?data-org-phase="gate"/u.exec(markup)[0];
  assert.match(workBlock, /data-actor-id="usage-harness:webgpt"/u);
  // 액터 카드에서는 잴 근거가 없는 값의 줄 자체가 없다: 소요·한도 소비를 지어내지 않는다.
  const webgptRow = worktreeRow(markup, 'data-actor-id', 'usage-harness:webgpt');
  assert.match(webgptRow, /class="wt-cell wt-time h-node-time" role="cell">—<\/div>/u);
  assert.doesNotMatch(markup, /%p 추정/u);
  // 단계 카드는 반대다 — 한 줄에 나란히 서는 고정 형제 집합이라, 측정이 없어도 `—`로
  // 자리를 지킨다 (review-visual N13: `완료`만 소요가 비어 형제 카드들의 끝이 들쭉날쭉
  // 했다). `—`는 값을 지어낸 것이 아니라 "측정 없음"의 표기라 숫자로 오독되지 않는다.
  // 단계 카드는 **하나도 빠짐없이** 이 줄을 갖는다 — 그래야 카드 끝이 가지런하다.
  const phaseRows = markup.split(/(?=<div class="wt-row )/u).filter((part) => /class="wt-row is-phase/u.test(part));
  assert.equal(phaseRows.length, 8);
  for (const row of phaseRows) assert.match(row, /class="wt-cell wt-time h-node-time" role="cell">/u);
  // 역할은 그대로 나온다 (구 payload에도 role은 있다).
  assert.match(webgptRow, /class="wt-sub" role="cell">위임 실행 · fixture 정리<\/p>/u);
  assert.doesNotMatch(markup, /undefined|NaN/u);
});

// ---- WP3 교차 리뷰 수정 (2026-08-28) --------------------------------------
//
// 리뷰가 반례로 쓴 시나리오를 그대로 잠근다. 각 테스트의 머리에 그 반례가 무엇이었는지
// 적어 둔다 — 수정이 지워져도 여기서 다시 실패해야 하기 때문이다.

// major 2 — 반례: 부모가 `work`인 액터의 자식이 API에서 `phase: 'review'`를 받아도
// 부모 밑(work)에 그려졌다. 즉 자식에서만 "API의 actor.phase 고정 배치" 계약이 깨졌고,
// 실제 review 단계는 텅 비어 보였다.
const crossPhaseTask = () => harnessTask({
  id: 'cross',
  phase: 'approve',
  status: 'active',
  events: [],
  actors: [
    {
      id: 'cross:main', parent_id: '', name: '오케스트레이터', kind: 'claude',
      model: 'claude-fable-5', reasoning: 'high', role: '총괄', status: 'working', phase: 'plan',
    },
    {
      id: 'cross:impl', parent_id: 'cross:main', name: '구현자', kind: 'codex',
      model: 'gpt-5.2-codex', reasoning: 'xhigh', role: '구현', status: 'done', phase: 'work',
    },
    {
      id: 'cross:reviewer', parent_id: 'cross:impl', name: '검토자', kind: 'codex',
      model: 'gpt-5.2-codex', reasoning: 'xhigh', role: '리뷰', status: 'reviewing', phase: 'review',
    },
    {
      id: 'cross:helper', parent_id: 'cross:impl', name: '보조 구현자', kind: 'codex',
      model: 'gpt-5.2-codex', reasoning: 'high', role: '구현 보조', status: 'done', phase: 'work',
    },
  ],
});

test('a child actor keeps the phase the API gave it, and still names its parent', () => {
  const renderers = createUsageRenderers();
  const markup = renderers.renderSessionView([crossPhaseTask()], NOW, 'active');

  // 검토자는 부모(work)를 따라가지 않고 자기 단계(review)에 선다. 경계는 **다음 단계
  // 노드**다 — 어느 단계가 카드가 되는지는 보고 이력에 달렸으므로 키를 고정하지 않는다.
  const workBlock = /data-org-phase="work"[\s\S]*?data-org-phase="/u.exec(markup)[0];
  assert.match(workBlock, /data-actor-id="cross:impl"/u);
  assert.doesNotMatch(workBlock, /data-actor-id="cross:reviewer"/u);
  const reviewBlock = /data-org-phase="review"[\s\S]*?data-org-phase="/u.exec(markup)[0];
  assert.match(reviewBlock, /data-actor-id="cross:reviewer"/u);

  // 배치가 옮겨져도 계층은 사라지지 않는다 — 부모를 이름으로 명시한다.
  const reviewerRow = worktreeRow(markup, 'data-actor-id', 'cross:reviewer');
  assert.match(reviewerRow, /class="wt-sub" role="cell">리뷰 · 상위 구현자<\/p>/u);
  // 부모와 단계가 같은 자식은 부모 다음의 한 단계 깊은 행이고, 별도 상위 문구가 없다.
  const implRow = worktreeRow(markup, 'data-actor-id', 'cross:impl');
  const helperRow = worktreeRow(markup, 'data-actor-id', 'cross:helper');
  assert.match(implRow, /data-depth="2"/u);
  assert.match(helperRow, /data-depth="3"/u);
  assert.doesNotMatch(helperRow, /상위 구현자/u);
  assert.ok(markup.indexOf('data-actor-id="cross:impl"') < markup.indexOf('data-actor-id="cross:helper"'));
});

// major 4 — 반례: task.progress=82 · main.progress=17을 넣으면 Main 카드가 82%로 렌더됐다.
// Main 노드는 data-actor-id가 붙은 액터 카드이므로 수치도 그 액터의 것이어야 한다.
test('the main node shows the orchestrator progress, not the whole session progress', () => {
  const renderers = createUsageRenderers();
  const task = harnessTask({
    id: 'main-progress',
    progress: 82,
    events: [],
    actors: [{
      id: 'mp:main', parent_id: '', name: '총괄', kind: 'claude',
      model: 'claude-fable-5', reasoning: 'high', role: '오케스트레이션',
      status: 'working', progress: 17,
    }],
  });
  const markup = renderers.renderSessionView([task], NOW, 'active');
  assert.match(worktreeRow(markup, 'data-actor-id', 'mp:main'), /class="wt-cell wt-pct" role="cell">17%<\/div>/u);
  assert.doesNotMatch(worktreeRow(markup, 'data-actor-id', 'mp:main'), />82%<\/div>/u);

  // 이벤트가 측정한 값이 있으면 그것이 payload보다 우선한다 (다른 액터와 같은 규칙).
  const measured = renderers.renderSessionView([{
    ...task,
    events: [{ ts: iso(HOUR), kind: 'report', phase: 'work', actor_id: 'mp:main', percent: 44 }],
  }], NOW, 'active');
  assert.match(worktreeRow(measured, 'data-actor-id', 'mp:main'), /class="wt-cell wt-pct" role="cell">44%<\/div>/u);

  // progress를 싣지 않는 구 보고에서만 세션 진행률로 떨어진다 — 총괄 카드가 수치를
  // 통째로 잃지 않게 남겨 둔 폴백이다.
  const legacy = renderers.renderSessionView([{
    ...task,
    actors: [{ ...task.actors[0], progress: undefined }],
  }], NOW, 'active');
  assert.match(worktreeRow(legacy, 'data-actor-id', 'mp:main'), /class="wt-cell wt-pct" role="cell">82%<\/div>/u);
});

// major 5 — 반례: 2026-08-27T15:30:00Z(= 한국 시간 08-28 00:30)에 끝난 세션이
// `2026.08.27` 그룹에 들어갔다. 한국어 서비스의 완료 기록이 자정 이후 아홉 시간 동안
// 전날로 밀리는 체계적 오분류다.
test('completed sessions are grouped by the Korean calendar day, not by UTC', () => {
  const renderers = createUsageRenderers();
  const afterMidnight = Date.parse('2026-08-27T15:30:00.000Z');   // KST 08-28 00:30
  const beforeMidnight = Date.parse('2026-08-27T14:30:00.000Z');  // KST 08-27 23:30
  const markup = renderers.renderSessionView([
    harnessTask({
      id: 'kst-late', name: '자정 이후 완료', status: 'complete', phase: 'done', progress: 100,
      completed_at: new Date(afterMidnight).toISOString(),
      updated_at: new Date(afterMidnight).toISOString(),
    }),
    harnessTask({
      id: 'kst-early', name: '자정 이전 완료', status: 'complete', phase: 'done', progress: 100,
      completed_at: new Date(beforeMidnight).toISOString(),
      updated_at: new Date(beforeMidnight).toISOString(),
    }),
  ], Date.parse('2026-08-28T03:00:00.000Z'), 'complete');

  assert.match(markup, /h-session-group-head">2026\.08\.28</u);
  assert.match(markup, /h-session-group-head">2026\.08\.27</u);
  // 자정 이후 세션은 08.28 그룹에 있고, 08.27 그룹에는 자정 이전 세션만 있다.
  const late = /2026\.08\.28<\/p>[\s\S]*?<\/section>/u.exec(markup)[0];
  assert.match(late, /자정 이후 완료/u);
  assert.doesNotMatch(late, /자정 이전 완료/u);
  // 행의 시각 표기도 같은 축을 쓴다 — 그러지 않으면 08.28 그룹 안에 08.27 행이 선다.
  // 게시글 행은 날짜만으로 같은 날 여러 세션을 가를 수 없어 시:분까지 적는다.
  assert.match(markup, /datetime="2026-08-28T00:30\+09:00">08\.28 00:30</u);
});

// 예전 완료 목록은 수평 tablist + 단일 visible panel이었다. 그 조판에서는 "그룹마다
// 초점 진입점이 하나씩 있는가"가 계약이었고, 그것을 지키느라 roving tabindex를 날짜
// 그룹 경계 너머까지 손으로 관리해야 했다.
//
// 게시글 목록은 그 문제 자체를 없앤다: 행은 네이티브 `<details>`이므로 모든 summary가
// 그냥 초점을 받고, 선택 상태를 화면이 들고 있지 않으니 되살릴 진입점도 없다.
// 그래서 검사도 바뀐다 — 진입점을 **세는** 대신 캐러셀 기계장치가 **없다는 것**을 잠근다.
test('the finished list is a vertical post list with no carousel machinery', () => {
  const completed = [0, 30, 60, 90].map((hours, index) => harnessTask({
    id: `kbd-${index}`,
    name: `완료 세션 ${index}`,
    status: 'complete',
    phase: 'done',
    progress: 100,
    completed_at: iso(hours * HOUR),
    updated_at: iso(hours * HOUR),
  }));
  const markup = createUsageRenderers().renderSessionView(completed, NOW, 'complete');
  // 날짜 그룹은 그대로 남는다 — 사라진 것은 그룹이 아니라 수평 탭이다.
  assert.ok((markup.match(/h-session-group-head/gu) || []).length >= 2);
  // 네 세션이 모두 **동시에** 서 있다. 하나만 보이는 패널도, 숨긴 패널도 없다.
  assert.equal((markup.match(/data-task-post="/gu) || []).length, 4);
  assert.doesNotMatch(markup, /h-session-tabs|data-task-tablist|data-task-tab=|data-task-panel=/u);
  assert.doesNotMatch(markup, /role="tablist"|role="tabpanel"|aria-selected=|tabindex="-1"/u);
  // 행은 네이티브 disclosure다 — 펼침은 브라우저가 맡고 화면은 선택 상태를 들지 않는다.
  assert.equal((markup.match(/<details class="disclosure h-post"/gu) || []).length, 4);
  assert.equal((markup.match(/<summary class="disclosure-head h-post-head">/gu) || []).length, 4);
});

test('activating a tab restores a keyboard entry point in the other tablists', () => {
  const { activateTaskTab } = createUsageRenderers();
  const makeTab = (index, tabbable) => ({
    dataset: { taskTab: String(index), taskId: `task-${index}`, taskStatus: 'complete' },
    tabIndex: tabbable ? 0 : -1,
    classList: { toggle() {} },
    setAttribute() {},
    focus() {},
    closest() { return null; },
  });
  // 두 그룹: [0,1] · [2,3]. 처음에는 0과 2가 진입점이고 선택은 0이다.
  const tabs = [makeTab(0, true), makeTab(1, false), makeTab(2, true), makeTab(3, false)];
  const lists = [
    { querySelectorAll: () => tabs.slice(0, 2) },
    { querySelectorAll: () => tabs.slice(2) },
  ];
  const panels = tabs.map((_, index) => ({ dataset: { taskPanel: String(index) }, hidden: index !== 0 }));
  const root = {
    querySelectorAll(selector) {
      if (selector === '[data-task-tab]') return tabs;
      if (selector === '[data-task-tablist]') return lists;
      return panels;
    },
  };

  activateTaskTab(root, tabs[1]);
  // 선택은 옮겨졌지만 두 번째 그룹은 진입점을 잃지 않는다.
  assert.deepEqual(tabs.map((tab) => tab.tabIndex), [-1, 0, 0, -1]);
});

// 사용자 지시 ① — '기록 없음'은 판정이지 사유가 아니다. 왜 비었는지를 화면이 말한다.
test('a stage with no report explains why it has no record', () => {
  const renderers = createUsageRenderers();
  const task = harnessTask({
    id: 'skip-reason',
    phase: 'review',
    events: [
      { ts: iso(3 * HOUR), kind: 'phase-change', phase: 'plan' },
      { ts: iso(HOUR), kind: 'phase-change', phase: 'review' },
    ],
  });
  const tree = renderers.renderSessionView([task], NOW, 'active');
  const reason = '이 단계는 보고가 전송되지 않았습니다';
  const skippedRow = tree.split(/(?=<div class="wt-row )/u)
    .find((part) => part.includes('data-phase-state="skipped"')) || '';
  assert.match(skippedRow, /class="wt-cell wt-state" role="cell">기록 없음<\/div>/u);
  assert.match(skippedRow, new RegExp(reason, 'u'));
  // 보고된 단계에는 사유를 붙이지 않는다 — 사유가 상태와 짝을 이룬다.
  const planBlock = worktreeRow(tree, 'data-org-phase', 'plan');
  assert.doesNotMatch(planBlock, new RegExp(reason, 'u'));
});

// 사용자 지시 ② — 낡은 수집값은 게이지 옆에서 수집원과 나이를 밝힌다.
test('a stale source names itself and its age next to every gauge', () => {
  const markup = dashboard([codexSnapshot({
    primary: { used_percent: 40, window_minutes: 10_080 },
    secondary: { used_percent: 12, window_minutes: 300 },
  }, iso(3 * HOUR))]);
  assert.match(markup, />Codex 주간<[\s\S]*?Codex 3시간 전 수집/u);
  assert.match(markup, />Codex 5시간<[\s\S]*?Codex 3시간 전 수집/u);

  // 신선하면 게이지 옆에 수집 문구를 붙이지 않는다 — 매 줄이 시각을 반복하면 읽기 비용만 는다.
  const fresh = dashboard([codexSnapshot({
    primary: { used_percent: 40, window_minutes: 10_080 },
  }, iso(60_000))]);
  assert.match(fresh, />Codex 주간</u);
  assert.doesNotMatch(fresh, /list-row-sub[^>]*>[^<]*수집/u);
});

// 사용자 지시 ③ — 화면에 축약어를 남기지 않는다. UI가 스스로 만드는 문구뿐 아니라
// 보고가 실어 온 이름의 약어(WP1 등)도 표시 계층에서 풀어 쓴다 (review R2-1).
test('abbreviations are spelled out, in the UI chrome and in reported names alike', () => {
  const markup = createUsageRenderers()
    .renderSessionView([harnessTask({ name: 'WP1 서버 (08-27)' })], NOW, 'active', 'org');
  for (const abbreviation of ['>REQUEST<', '>MAIN<', '>PHASE<', '>AGENT<', '>NODE<', 'ORG CHART', '>CODEX<', '>WEBGPT<', 'ARTIFACT']) {
    assert.ok(!markup.includes(abbreviation), `UI가 만든 약어가 남아 있습니다: ${abbreviation}`);
  }
  assert.match(markup, />총괄</u);
  assert.equal((markup.match(/class="wt-row is-phase[^"]*" role="row"\s*data-depth="1"/gu) || []).length, 8);
  assert.equal((markup.match(/class="wt-kind"><\/span>/gu) || []).length, 8);
  // 보고가 실어 온 약어는 풀어 쓴 형태로만 나온다 — 원문은 내부 필드에만 남는다.
  assert.doesNotMatch(markup, /WP1/iu);
  assert.match(markup, /작업 묶음 1 — 서버/u);
});

// 풀어쓰기는 축약어 사전이 아니라 규칙이다 — 목록에 없는 번호도 같은 모양으로 풀린다.
test('the spell-out rule is derived from the pattern, not from a per-abbreviation list', () => {
  const renderers = createUsageRenderers();
  const markup = renderers.renderSessionView([harnessTask({ name: 'WP7' })], NOW, 'active', 'org');
  assert.match(markup, /작업 묶음 7/u);
  assert.doesNotMatch(markup, /WP7/iu);
});

// 사용자 지시 ④ — 카드의 시각은 하네스의 **마지막 보고**이고, 화면 갱신 시계와 이름이
// 다르다. 같은 말('동기화')을 두 시계가 나눠 쓰면 값이 어긋난 것처럼 읽힌다.
test('the card clock is named after the report, not after the screen refresh', () => {
  const renderers = createUsageRenderers();
  const task = harnessTask({ id: 'clock', updated_at: iso(3 * HOUR) });
  const tree = renderers.renderSessionView([task], NOW, 'active');
  assert.match(tree, /마지막 보고 3시간 전/u);
  assert.doesNotMatch(tree, /동기화/u);
  // 보고 시각이 아예 없으면 그렇게 말한다 (0분 전으로 지어내지 않는다).
  const noTime = renderers.renderSessionView([harnessTask({ id: 'no-clock', updated_at: '' })], NOW, 'active');
  assert.match(noTime, /보고 시각 없음/u);
});

// 지시 ④의 다른 쪽 시계 — 머리말의 갱신 표기는 '화면 갱신'이라는 제 이름을 쓰고,
// 진행 중 세션이 없을 때의 폴링 주기(60초)를 그대로 밝힌다 (review R2-N1).
test('the header clock names itself the screen refresh and states the polling cadence', async () => {
  const sandbox = await createUsageAppSandbox([{ snapshots: [], tasks: [] }]);
  const freshness = sandbox.store.get('usageFreshness').textContent;
  assert.match(freshness, /화면 갱신/u);
  assert.doesNotMatch(freshness, /마지막 보고/u);
  assert.match(freshness, /60초마다 자동 갱신/u);
});

// ---- 완료 목록 정리 (요구 6) ----------------------------------------------
// 완료 세션은 영구 누적된다. 목록을 지우지 않으면서 화면을 읽히게 하는 방법은 **접기**다:
// 기본 최근 10개 + 날짜별 그룹 머리 + 남은 개수를 밝히는 '더 보기'.

test('the completed view shows the ten most recent sessions, grouped by date, with a more button', () => {
  const completed = Array.from({ length: 14 }, (_, index) => harnessTask({
    id: `done-${index}`,
    name: `완료 세션 ${index}`,
    status: 'complete',
    phase: 'done',
    progress: 100,
    // 이틀에 걸쳐 완료됐다. 최신 완료가 먼저 온다.
    completed_at: iso(index * 6 * HOUR),
    updated_at: iso(index * 6 * HOUR),
  }));
  const markup = createUsageRenderers().renderSessionView(completed, NOW, 'complete');
  assert.equal((markup.match(/data-task-post="/gu) || []).length, 10);
  assert.match(markup, /data-completed-more data-post-status="complete"/u);
  assert.match(markup, /남은 4개/u);
  // 날짜 그룹 머리가 목록 바깥에 서고, 그룹마다 자기 목록을 갖는다.
  assert.match(markup, /class="list-group-head h-session-group-head">2026\.08\.27</u);
  assert.ok((markup.match(/class="h-post-group"/gu) || []).length >= 2);
  // 최신이 위다 — 게시글 목록의 순서 계약.
  assert.ok(markup.indexOf('완료 세션 0') < markup.indexOf('완료 세션 9'));
  // 열 개 안에 들지 못한 세션은 행으로 서지 않는다 (지운 것이 아니라 접힌 것이다).
  assert.doesNotMatch(markup, /완료 세션 13/u);
});

// review-visual M3 — 상태 배지는 판단을 도울 때만 낸다. 한 상태로 고정된 목록에서는
// 사라지고(위 'active, stale, and completed tabs…'), 혼재 목록에서만 다시 나온다.
test('the post list shows a status badge only when the listed sessions differ in state', () => {
  const renderers = createUsageRenderers();
  const group = (tasks) => [{ label: '2026.08.27', ariaLabel: '테스트 목록', tasks }];
  const complete = harnessTask({ id: 'mix-done', name: '완료 하나', status: 'complete', phase: 'done' });
  const stale = harnessTask({ id: 'mix-stale', name: '중단 하나', status: 'stale' });

  const single = renderers.renderPostList(group([complete]), 'complete', NOW);
  assert.doesNotMatch(single, /class="h-post-state"/u);

  const mixed = renderers.renderPostList(group([complete, stale]), 'complete', NOW);
  assert.equal((mixed.match(/class="h-post-state"/gu) || []).length, 2);
  assert.match(mixed, /h-post-state[\s\S]*?완료</u);
  assert.match(mixed, /status-dot is-warn[^>]*><\/span>중단됨/u);
});

test('a completed list shorter than one page carries no more button', () => {
  const completed = [harnessTask({
    id: 'done-only', name: '하나뿐인 완료', status: 'complete', phase: 'done', progress: 100,
  })];
  const markup = createUsageRenderers().renderSessionView(completed, NOW, 'complete');
  assert.doesNotMatch(markup, /data-completed-more/u);
  assert.match(markup, /하나뿐인 완료/u);
});

// ---- 제목 · 요청 원문 계약 -------------------------------------------------
//
// 조사 §b·§c: 보고자가 요청 원문을 payload에 아예 싣지 않았고, 카드 제목은 세션 slug에서
// 파생됐다. 기능 A가 `title`·`input`을 계약에 넣었으므로 화면이 그것을 정본으로 읽는다.

test('a user-authored title is the card title, byte for byte', () => {
  const renderers = createUsageRenderers();
  const task = harnessTask({
    id: 'titled',
    // 저장 이름은 여전히 파생값이다 (notify.mjs taskNameFromSession).
    name: 'WP2 관제탑 (08-29)',
    title: '관제탑 UI 개선',
  });
  const markup = renderers.renderSessionView([task], NOW, 'active', 'org');
  assert.match(markup, /관제탑 UI 개선/u);
  // 사람이 고른 표기에는 약어 확장도, 날짜 꼬리 제거도 걸지 않는다 — 이미 최종 표기다.
  assert.doesNotMatch(markup, /작업 묶음 2/u);
  assert.equal(renderers.taskPresentation(task).name, '관제탑 UI 개선');
});

// review 기능 B M-2 — **반례: 지정한 제목이 마침 name과 같은 경우.**
// 값만으로는 "사람이 지었다"와 "하위 호환으로 name을 물려받았다"가 갈리지 않아, 화면이
// 지정 제목을 파생값으로 오판해 날짜 꼬리를 떼고 약어를 풀어 버렸다. 이제 Worker가
// `title_authored`로 출처를 말하고, 그 값이 참이면 화면은 한 글자도 손대지 않는다.
test('an authored title that happens to equal the name is still preserved byte for byte', () => {
  const renderers = createUsageRenderers();
  const task = harnessTask({
    id: 'authored-equals-name',
    name: 'WP2 관제탑 (08-29)',
    title: 'WP2 관제탑 (08-29)',
    title_authored: true,
  });
  assert.equal(renderers.taskPresentation(task).name, 'WP2 관제탑 (08-29)');
  const markup = renderers.renderSessionView([task], NOW, 'active', 'org');
  assert.match(markup, /WP2 관제탑 \(08-29\)/u);
  assert.doesNotMatch(markup, /작업 묶음 2/u);
});

// 같은 값이라도 출처가 거짓이면(구 행에서 name을 물려받은 title) 예전 손질이 그대로다 —
// 새 계약이 옛 화면의 결과를 바꾸지 않는다.
test('the same title with a false provenance flag still gets the legacy cleanup', () => {
  const renderers = createUsageRenderers();
  assert.equal(renderers.taskPresentation({
    name: 'WP2 관제탑 (08-29)', title: 'WP2 관제탑 (08-29)', title_authored: false,
  }).name, '작업 묶음 2 — 관제탑');
});

test('a legacy report whose title is just the derived name keeps the old cleanup', () => {
  const renderers = createUsageRenderers();
  // Worker는 하위 호환으로 title이 없는 payload에 name을 그대로 채워 준다
  // (router.js hydrated.title = payload.title || row.title || payload.name).
  // 그것을 "사람이 지은 제목"으로 오인하면 구 세션의 제목이 갑자기 날짜 꼬리를 달고 선다.
  const derived = 'WP2 관제탑 (08-29)';
  const presentation = renderers.taskPresentation(harnessTask({
    id: 'legacy-title', name: derived, title: derived,
  }));
  assert.equal(presentation.name, '작업 묶음 2 — 관제탑');
  assert.equal(presentation.dateLabel, '08.29');
});

// 요청 원문은 **한 면에서만** 난다 (review-visual M4). 예전에는 상단 inset과 조직도의
// '사용자 입력' 카드가 완전히 같은 문장을 한 화면에 두 번 출력했고, 그 카드는 §1.1이
// 만들지 말라고 한 "사람이 아닌 노드"이기도 했다. 남긴 쪽은 inset이다.
test('the reported request text is shown once, in the detail inset', () => {
  const renderers = createUsageRenderers();
  const input = '완료된 파이프라인 목록을 게시글형으로 바꾸고\n한도 신선도를 보여 줘';
  const markup = renderers.renderSessionView([harnessTask({
    id: 'with-input', title: '관제탑 UI 개선', input,
  })], NOW, 'active', 'org');
  assert.match(markup, /<section class="h-task-input"[\s\S]*?완료된 파이프라인 목록을 게시글형으로/u);
  assert.equal((markup.match(/완료된 파이프라인 목록을 게시글형으로/gu) || []).length, 1);
  assert.doesNotMatch(markup, /h-node is-request/u);
  assert.equal(renderers.taskInput({ input }), input);
});

test('a report with no request text says so instead of borrowing the title', () => {
  const markup = createUsageRenderers().renderSessionView([harnessTask({
    id: 'no-input', title: '관제탑 UI 개선',
  })], NOW, 'active', 'org');
  const reason = '이 세션은 요청 원문을 보고하지 않았습니다';
  assert.match(markup, new RegExp(`h-task-input-empty">기록 없음 · ${reason}`, 'u'));
  // 사유도 한 번만 난다 — 조직도가 같은 문장을 되풀이하지 않는다.
  assert.equal((markup.match(new RegExp(reason, 'gu')) || []).length, 1);
});

// ---- 수집 건강 상태 (조사 §f) ---------------------------------------------

test('each source names its last success, last attempt, and the reason it failed', () => {
  const markup = dashboard({
    snapshots: [{
      ...codexSnapshot({ primary: { used_percent: 40 } }, iso(2 * 60_000)),
      last_success_at: iso(2 * 60_000),
      last_attempt_at: iso(60_000),
      last_outcome: 'no-data',
    }],
    tasks: [],
  });
  assert.match(markup, /마지막 수집 성공<\/dt><dd>2분 전<\/dd>/u);
  // 실패 원인은 시도 시각 옆에서 읽힌다 — 다른 화면으로 찾아가지 않는다.
  assert.match(markup, /마지막 시도<\/dt><dd>1분 전 · 원본 없음<\/dd>/u);
  // 마지막 **성공**이 SLO 안이면 고장 판정을 붙이지 않는다.
  assert.doesNotMatch(markup, /us-health is-breached/u);
});

// review 기능 B M-1 — **필드 부재와 명시적 null은 다른 사실이다.**
// 예전에는 둘 다 parseTime(undefined|null) === null로 접혀, health를 아예 싣지 않는 구
// Worker 응답이 2분 전에 수집됐어도 곧장 '30분 넘게 수집 성공 없음'으로 고발됐다.
// 이 화면이 실제 배포보다 앞서 나갈 수 있는 한(정적 파일과 Worker의 배포 시점이 다르다)
// 이 분기는 가정이 아니라 상시 조건이다.
test('a snapshot from a Worker that predates health fields falls back to its row time', () => {
  const markup = dashboard({
    // health 세 필드가 **없다**. 구 Worker의 GET /api/usage가 정확히 이 모양이었다.
    snapshots: [codexSnapshot({ primary: { used_percent: 40 } }, iso(2 * 60_000))],
    tasks: [],
  });
  assert.doesNotMatch(markup, /us-health is-breached/u);
  assert.match(markup, /마지막 수집 성공<\/dt><dd>2분 전<\/dd>/u);
  // 결과 라벨은 지어내지 않는다 — 구 응답은 시도의 결과를 말한 적이 없다.
  assert.match(markup, /마지막 시도<\/dt><dd>2분 전<\/dd>/u);
});

// 반대 방향의 반례: 같은 행 시각이어도 서버가 **명시적으로** "성공 기록 없음"이라고
// 말했으면 그 판정을 화면이 행 시각으로 덮지 않는다.
test('an explicit null last success stays a breach even when the row time is fresh', () => {
  const markup = dashboard({
    snapshots: [{
      ...codexSnapshot({ primary: { used_percent: 40 } }, iso(2 * 60_000)),
      last_success_at: null,
      last_attempt_at: iso(60_000),
      last_outcome: 'no-data',
    }],
    tasks: [],
  });
  assert.match(markup, /us-health is-breached/u);
  assert.match(markup, /마지막 수집 성공<\/dt><dd>기록 없음<\/dd>/u);
});

test('a source whose last success breached the SLO is marked, not just reported', () => {
  const markup = dashboard({
    snapshots: [{
      ...codexSnapshot({ primary: { used_percent: 40 } }, iso(31 * 60_000)),
      last_success_at: iso(31 * 60_000),
      last_attempt_at: iso(60_000),
      last_outcome: 'failed',
    }],
    tasks: [],
  });
  assert.match(markup, /us-health is-breached/u);
  // 문턱 숫자는 상수에서 도출된다 — 화면이 옛 숫자를 말하지 않게.
  assert.match(markup, /30분 넘게 수집 성공 없음/u);
  assert.match(markup, /마지막 시도<\/dt><dd>1분 전 · 전송 실패<\/dd>/u);
  // 색만으로 말하지 않는다: 점 뒤에 반드시 문장이 온다 (DESIGN.md §7.3 status-dot).
  assert.match(markup, /status-dot is-warn" aria-hidden="true"><\/span>30분 넘게/u);
});

test('a source that has never reported a success is a breach, not a blank', () => {
  const markup = dashboard({
    snapshots: [{
      source: 'codex', captured_at: iso(HOUR), payload: null,
      last_success_at: null, last_attempt_at: iso(60_000), last_outcome: 'no-data',
    }],
    tasks: [],
  });
  assert.match(markup, /us-health is-breached/u);
  assert.match(markup, /마지막 수집 성공<\/dt><dd>기록 없음<\/dd>/u);
});

// ---- 피드 실패: 낡은 정적 사본을 만들지 않는다 -----------------------------
test('a failed feed says why without fetching or replacing a static copy', async () => {
  const empty = await createUsageAppSandbox([new Error('network down')]);
  assert.equal(empty.requests.length, 1);
  assert.equal(empty.store.get('usageBody').innerHTML, '');
  assert.equal(empty.store.get('usageError').textContent, 'network down');
});

test('a live dashboard is never replaced when a later feed request fails', async () => {
  const live = await createUsageAppSandbox([
    { snapshots: [], tasks: [harnessTask()] },
    new Error('refresh down'),
  ]);
  const before = live.store.get('usageBody').innerHTML;
  assert.match(before, /data-worktree/u);
  await live.store.get('reload').listeners.click();
  assert.equal(live.requests.length, 2, '실패 뒤 정적 사본을 위한 추가 fetch가 없어야 합니다.');
  assert.equal(live.store.get('usageBody').innerHTML, before);
  assert.equal(live.store.get('usageError').textContent, 'refresh down');
});

// ==========================================================================
// 모더 뷰 (plan.md §5 / DESIGN.md §1.1 v11)
//
// 여기서 보는 것은 **렌더 계약**이다. 서버의 승인 전 실행 금지(D1 batch·UNIQUE)는
// worker/test.mjs가 따로 증명한다 — 화면 검사가 그것을 대신했다고 적지 않는다.
// 이 검사가 **못 보는 것**: 네트워크 계층, DOM 이벤트 배선, 시각 조판.
// ==========================================================================

const moderatorItem = (overrides = {}) => ({
  item_id: 'item_aa01', kind: 'proposal', status: 'pending',
  issue_summary: '세션 세 개가 갱신 없이 진행 중으로 남아 있다.',
  action_summary: '좀비 실행자를 종료하고 같은 단계부터 다시 띄운다.',
  proposed_command: 'node scripts/moderator-daemon.mjs --restart-stalled',
  version: 1, brain_model: 'gpt-5.6-sol', brain_reasoning: 'xhigh',
  worker_model: 'gpt-5.6-luna', worker_reasoning: 'low',
  source_task_id: '2026-08-29-모더-시각화',
  created_at: iso(2 * HOUR), updated_at: iso(HOUR), decided_at: null, events: [],
  ...overrides,
});

const moderatorCommand = (overrides = {}) => ({
  command_id: 'cmd_bb02', source: 'direct', source_item_id: null,
  idempotency_key: 'direct-bb02', command_text: '멈춘 세션을 정리해라.',
  status: 'succeeded', attempts: 1,
  requested_model: 'gpt-5.6-sol', requested_reasoning: 'xhigh',
  actual_model: 'gpt-5.6-sol', actual_reasoning: 'xhigh',
  issue_summary: '세션 세 개가 멈춰 있었다.', action_summary: '좀비 셋을 종료하고 다시 띄웠다.',
  created_at: iso(2 * HOUR), updated_at: iso(HOUR), ...overrides,
});

const moderatorFeed = (overrides = {}) => ({
  brain: {
    model: 'gpt-5.6-sol', reasoning: 'xhigh',
    worker_model: 'gpt-5.6-luna', worker_reasoning: 'low', updated_at: iso(HOUR),
  },
  active_sessions: 2, active_commands: 1,
  counts: {
    important: { open: 1, resolved: 2 },
    proposal: { pending: 2, approved: 1 },
    review: { running: 1 },
  },
  items: [moderatorItem()], commands: [moderatorCommand()], next_cursor: null,
  ...overrides,
});

test('a pending proposal offers approve, edit, and reject and says nothing has run yet', () => {
  const renderers = createUsageRenderers();
  const markup = renderers.renderModeratorItems(moderatorFeed(), 'proposal', NOW);
  assert.match(markup, /data-mod-action="approve"[^>]*>승인</u);
  assert.match(markup, /data-mod-action="edit"[^>]*>수정</u);
  assert.match(markup, /data-mod-action="reject"[^>]*>거부</u);
  // 승인 전 실행 금지는 그룹 머리와 행 안에서 **두 번** 읽힌다. 목록만 훑는 사람도,
  // 한 행을 펼친 사람도 같은 사실을 본다.
  assert.match(markup, /승인하기 전까지 아무 명령도 실행되지 않습니다/u);
  assert.match(markup, /아직 실행되지 않았습니다/u);
  // 제안 자체는 명령이 아니다 — 명령 ID를 붙여 이미 대기열에 있는 것처럼 그리지 않는다.
  assert.doesNotMatch(markup, /md-item-id/u);
});

test('a decided proposal keeps its command visible but loses every decision button', () => {
  const renderers = createUsageRenderers();
  const feed = moderatorFeed({ items: [moderatorItem({ status: 'approved', decided_at: iso(HOUR) })] });
  const markup = renderers.renderModeratorItems(feed, 'proposal', NOW);
  assert.doesNotMatch(markup, /data-mod-action=/u);
  assert.match(markup, /이 제안의 명령/u);
  assert.doesNotMatch(markup, /아직 실행되지 않았습니다/u);
});

test('an important item can only be acknowledged — the screen never offers to run it', () => {
  const renderers = createUsageRenderers();
  const feed = moderatorFeed({
    items: [moderatorItem({
      item_id: 'item_cc03', kind: 'important', status: 'open', proposed_command: null,
    })],
  });
  const markup = renderers.renderModeratorItems(feed, 'important', NOW);
  assert.match(markup, /data-mod-action="acknowledge"/u);
  assert.doesNotMatch(markup, /data-mod-action="approve"/u);
});

test('the three classifications and their counts are all on screen at once', () => {
  const renderers = createUsageRenderers();
  const markup = renderers.renderModeratorFilter(moderatorFeed(), 'proposal');
  for (const [label, total] of [['중요', 3], ['제안', 3], ['검토', 1]]) {
    assert.match(markup, new RegExp(`>${label}</span><span class="md-filter-count">${total}<`, 'u'));
  }
  assert.match(markup, /data-mod-kind="proposal"[^>]*aria-pressed="true"/u);
  assert.match(markup, /data-mod-kind="important"[^>]*aria-pressed="false"/u);
});

test('the default classification is the first one that needs a hand, not an empty list', () => {
  const renderers = createUsageRenderers();
  assert.equal(renderers.moderatorDefaultKind(moderatorFeed()), 'important');
  assert.equal(renderers.moderatorDefaultKind(moderatorFeed({
    counts: { important: { resolved: 4 }, proposal: { pending: 1 }, review: {} },
  })), 'proposal');
  // 열린 것이 하나도 없으면 기록이 있는 첫 분류를 연다.
  assert.equal(renderers.moderatorDefaultKind(moderatorFeed({
    counts: { important: {}, proposal: { approved: 2 }, review: {} },
  })), 'proposal');
  assert.equal(renderers.moderatorDefaultKind({}), 'important');
});

test('a command row carries its own id, the model that actually ran, and the two-line summary', () => {
  const renderers = createUsageRenderers();
  const markup = renderers.renderModeratorCommands(moderatorFeed(), NOW);
  assert.match(markup, /<span class="md-item-id">cmd_bb02<\/span>/u);
  assert.match(markup, /세션 세 개가 멈춰 있었다\./u);
  assert.match(markup, /좀비 셋을 종료하고 다시 띄웠다\./u);
  assert.match(markup, /<dt>실행 모델<\/dt><dd class="md-fact-mono">gpt-5\.6-sol</u);
  assert.match(markup, /<dt>출처<\/dt><dd>직접 명령</u);
});

test('an unconfirmed execution model stays 미확인 instead of borrowing the requested one', () => {
  const renderers = createUsageRenderers();
  const feed = moderatorFeed({
    commands: [moderatorCommand({ status: 'running', actual_model: null, actual_reasoning: null })],
  });
  const markup = renderers.renderModeratorCommands(feed, NOW);
  assert.match(markup, /<dt>요청 모델<\/dt><dd class="md-fact-mono">gpt-5\.6-sol</u);
  assert.match(markup, /<dt>실행 모델<\/dt><dd class="md-fact-unknown">미확인</u);
  // 요청 모델이 실행 모델 자리로 새어 들어가지 않는다 — 확인값은 한 번만 나온다.
  assert.equal((markup.match(/md-fact-mono">gpt-5\.6-sol/gu) || []).length, 1);
});

test('a queued command says why it has no summary instead of inventing one', () => {
  const renderers = createUsageRenderers();
  const feed = moderatorFeed({
    commands: [moderatorCommand({
      status: 'queued', issue_summary: null, action_summary: null, actual_model: null,
    })],
  });
  const markup = renderers.renderModeratorCommands(feed, NOW);
  assert.match(markup, /대기열에 있습니다\. 아직 실행되지 않았습니다\./u);
  assert.match(markup, /멈춘 세션을 정리해라\./u);
});

test('the brain panel names the judging model and the summarising model apart', () => {
  const renderers = createUsageRenderers();
  const markup = renderers.renderModeratorBrain(moderatorFeed(), NOW);
  assert.match(markup, /<dt>뇌 모델<\/dt><dd class="md-fact-mono">gpt-5\.6-sol</u);
  assert.match(markup, /<dt>요약 모델<\/dt><dd class="md-fact-mono">gpt-5\.6-luna</u);
  assert.match(markup, /<dt>뇌 추론<\/dt><dd>xhigh</u);
  assert.match(markup, /<dt>요약 추론<\/dt><dd>low</u);
  // 결측은 빈칸이 아니라 판정이다.
  const unknown = renderers.renderModeratorBrain({ brain: {} }, NOW);
  assert.match(unknown, /<dt>뇌 모델<\/dt><dd class="md-fact-unknown">미확인</u);
});

test('an empty classification says so instead of rendering an empty box', () => {
  const renderers = createUsageRenderers();
  const feed = moderatorFeed({ items: [], counts: { important: {}, proposal: {}, review: {} } });
  assert.match(renderers.renderModeratorItems(feed, 'review', NOW), /기록된 자율 검토가 없습니다/u);
  assert.doesNotMatch(renderers.renderModeratorItems(feed, 'review', NOW), /class="md-list"/u);
  // '기록'은 사용자가 보낸 명령만이 아니라 승인된 제안·자율 검토가 실제로 돌린 것까지
  // 포함하므로 "보낸"이 아니라 "실행된"이다.
  assert.match(renderers.renderModeratorCommands({ commands: [] }, NOW), /아직 실행된 명령이 없습니다/u);
  assert.match(renderers.renderModeratorItems({ ...feed, commands: [] }, 'record', NOW), /아직 실행된 명령이 없습니다/u);
});

test('the moderator tab has exactly four classifications and only one is shown at a time', () => {
  // 2026-08-30 사용자 지시: 중요 / 제안 / 검토 / 기록.
  const renderers = createUsageRenderers();
  const feed = moderatorFeed({
    items: [],
    counts: { important: {}, proposal: {}, review: {} },
    commands: [{ command_id: 'cmd_1', source: 'direct', status: 'succeeded', command_text: '점검해라', issue_summary: '문제', action_summary: '조치' }],
  });
  const filter = renderers.renderModeratorFilter(feed, 'important');
  const keys = [...filter.matchAll(/data-mod-kind="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(keys, ['important', 'proposal', 'review', 'record']);
  for (const label of ['중요', '제안', '검토', '기록']) assert.ok(filter.includes(label), label);
  // 기록 개수는 서버 counts가 아니라 실제 명령 목록에서 나온다.
  assert.match(filter, /data-mod-kind="record"[\s\S]*?md-filter-count">1</u);
  // 한 번에 한 분류만 난다: 중요를 고르면 명령 기록이 함께 서지 않는다.
  const importantView = renderers.renderModeratorItems(feed, 'important', NOW);
  assert.doesNotMatch(importantView, /점검해라/u);
  // 기록을 고르면 그 명령이 난다.
  assert.match(renderers.renderModeratorItems(feed, 'record', NOW), /점검해라/u);
});

test('the record classification never becomes the default, because nothing there needs a hand', () => {
  const renderers = createUsageRenderers();
  // 손이 필요한 항목이 하나도 없고 기록만 있을 때에도 기본 선택은 기록이 아니다.
  const feed = moderatorFeed({
    items: [],
    counts: { important: {}, proposal: {}, review: {} },
    commands: [{ command_id: 'cmd_1', source: 'direct', status: 'succeeded', command_text: 'x' }],
  });
  assert.notEqual(renderers.moderatorDefaultKind(feed), 'record');
});

test('summaries and commands from the server are escaped, never injected as markup', () => {
  const renderers = createUsageRenderers();
  const feed = moderatorFeed({
    items: [moderatorItem({
      issue_summary: '<img src=x onerror=alert(1)>',
      proposed_command: '<script>alert(2)</script>',
    })],
  });
  const markup = renderers.renderModeratorItems(feed, 'proposal', NOW);
  assert.doesNotMatch(markup, /<img src=x/u);
  assert.doesNotMatch(markup, /<script>alert/u);
  assert.match(markup, /&lt;img src=x/u);
});

test('the moderator view is a sibling view, and only one view renders at a time', async () => {
  const { readSource } = await import('./render-sandbox.mjs');
  const html = readSource('usage/index.html');
  const views = [...html.matchAll(/<section id="(view\w+)" class="us-view"([^>]*)>/gu)];
  assert.equal(views.length, 2, '실행 현황과 모더 두 뷰가 있어야 한다');
  const visible = views.filter(([, , attributes]) => !/\shidden(?=[\s>]|$)/u.test(attributes));
  assert.equal(visible.length, 1, '문서 초기 상태에서 열려 있는 뷰는 하나뿐이다');
  // UA의 [hidden] { display: none }은 저자 규칙에 항상 진다 — 기본 display가 none이어야 한다.
  const css = readSource('usage/assets/css/usage.css');
  assert.match(css, /\.us-view \{\s*display: none;/u);
  // 사이드바 항목마다 짝이 되는 뷰가 있어야 한다.
  const tabs = [...html.matchAll(/data-usage-view="(\w+)"/gu)].map(([, name]) => name);
  assert.deepEqual(tabs, ['ops', 'moderator']);
  assert.ok(html.includes('aria-controls="viewOps"'));
  assert.ok(html.includes('aria-controls="viewModerator"'));
});

test('the command composer lives outside every polled container', async () => {
  const { readSource } = await import('./render-sandbox.mjs');
  const html = readSource('usage/index.html');
  const source = readSource('usage/assets/js/usage.js');
  // 폴링이 갈아 끼우는 컨테이너들. 입력 상자가 이 중 하나 안에 있으면 5초마다 글이 사라진다.
  for (const id of ['modBrain', 'modFilter', 'modItems']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*></div>`, 'u'), `#${id}는 렌더러가 채우는 빈 컨테이너여야 한다`);
  }
  assert.match(html, /<form id="modCommandForm"[\s\S]*?<textarea id="modCommandText"/u);
  assert.doesNotMatch(source, /setModeratorHtml\(modElements\.(form|commandText)/u);
});
