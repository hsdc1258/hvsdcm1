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
function dashboard(input, now = NOW) {
  return renderUsageDashboard(input, now);
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
  const head = markup.match(/Claude 한도<\/h3><\/div>\s*<span class="us-card-meta">([^<]*)</u);
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

// 세션 트리는 "지금 어디"가 아니라 **전 단계 + 실제 액터**를 항상 그린다 (plan §4-1).
test('the session tree always renders every phase plus the reported actors', () => {
  const markup = createUsageRenderers().renderSessionView([harnessTask()], NOW, 'active');
  for (const expected of ['사용자 입력', '요청 접수 · 범위 확인', '계약 · 증거 고정', '격리 구현 · 검증', '빌드 · 린트 · 테스트', '독립 반증 · 지적', '지적 반영 · 재검증', '판정 · 릴리스 결정', '배포 · 기록', 'Main Codex', 'gpt-5.6-sol · xhigh', '독립 검토', 'WebGPT 실행자', 'WebGPT PRO', 'HARNESS E2E: PASS']) {
    assert.match(markup, new RegExp(expected, 'u'));
  }
  // 여덟 단계가 모두 노드로 서고, 진행 단계는 상태만 다르다.
  assert.deepEqual(
    [...markup.matchAll(/data-org-phase="([a-z]+)"/gu)].map((match) => match[1]),
    ['input', 'plan', 'work', 'gate', 'review', 'revise', 'approve', 'done'],
  );
  assert.match(markup, /data-org-phase="review" data-phase-state="current"/u);
  // 이벤트가 없는 세션이라 구 4단계 키만 완료로 접히고, 확장으로 생긴 gate·input은
  // 보고된 적이 없으므로 완료가 아니라 '기록 없음'이다.
  assert.match(markup, /data-org-phase="plan" data-phase-state="done"/u);
  assert.match(markup, /data-org-phase="gate" data-phase-state="skipped"/u);
  assert.match(markup, /data-org-phase="input" data-phase-state="skipped"/u);
  assert.match(markup, /data-org-phase="revise" data-phase-state="pending"/u);
  assert.match(markup, /data-org-phase="done" data-phase-state="pending"/u);
  // 뿌리 → 총괄 → 단계 → 액터의 중첩 목록. 손계산 SVG 좌표는 쓰지 않는다 (DESIGN.md §9).
  assert.match(markup, /<ul class="h-tree">/u);
  assert.match(markup, /class="h-node is-request"/u);
  assert.match(markup, /class="h-node is-lead/u);
  assert.doesNotMatch(markup, /<svg/u);
  // 보고된 액터 3명이 전부 자기 노드를 갖는다.
  assert.equal((markup.match(/data-actor-id=/gu) || []).length, 3);
  assert.match(markup, /h-node-kind">WebGPT</u);
  // 조직도는 확대·이동 캔버스 안에 있다.
  assert.match(markup, /class="h-org-viewport" data-org-view="session:usage-harness"/u);
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
  assert.match(markup, /data-org-phase="plan"[\s\S]*?h-node-time">1시간/u);
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
  assert.match(markup, /data-org-phase="revise"[\s\S]*?claude-opus-5 · high/u);
  assert.match(markup, /data-org-phase="gate"[\s\S]*?h-node-time">1시간/u);
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
  // 건너뛴 단계는 라벨로도 완료와 갈린다 — 노드는 그대로 서 있고 상태만 다르다.
  // 건너뛴 단계는 상태 라벨로도 완료와 갈린다 — 노드는 그대로 서 있고 상태만 다르다.
  assert.equal((doneMarkup.match(/기록 없음/gu) || []).length, 6);
  assert.match(doneMarkup, /data-phase-state="skipped"/u);
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
  // 나머지 액터는 수치가 없으므로 0% 바를 그리지 않는다. 세션 탭의 트리에 둘이다
  // (전체 보기는 2026-08-28 통합에서 관제탑 보드로 바뀌어 게이지 바 대신 수치를 낸다).
  assert.equal((markup.match(/진행도<\/span>/gu) || []).length, 2);
  assert.match(markup, /class="h-node is-lead[^"]*"[^>]*>[\s\S]*?<strong>64%<\/strong>/u);
  assert.match(markup, /계산 작업[\s\S]*?<strong>37%<\/strong>/u);
  // 관제탑 카드도 같은 두 수치만 낸다: 카드 메타의 총괄 진행도와, 진행도를 보고한
  // 액터의 칩 하나. 보고가 없는 액터의 칩에는 수치 자체가 붙지 않는다.
  assert.match(markup, /class="pl-meta">[\s\S]*?진행 64%/u);
  assert.equal((markup.match(/class="pl-chip-percent"/gu) || []).length, 1);
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

  // 관제탑 기본값은 '진행 중만'이다 (요구 6) — 완료 세션은 접히되 사라지지 않고,
  // 접힌 개수를 요약 줄이 밝힌다.
  const activeOnly = renderers.renderPortfolioBoard(tasks, NOW);
  assert.match(activeOnly, /진행 세션/u);
  assert.doesNotMatch(activeOnly, /완료 세션/u);
  assert.match(activeOnly, /완료 1개 접힘/u);
  assert.equal((activeOnly.match(/data-portfolio-task=/gu) || []).length, 1);
  assert.match(activeOnly, /data-board-scope="all"/u);

  // '전체'를 고르면 완료 세션과 그 액터가 전부 돌아온다.
  const org = renderers.renderPortfolioBoard(tasks, NOW, 'all');
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
// 높이를 반드시 함께 준다 — 폭만 주면 "맞춤"이 세로를 무시해도 검사가 못 본다
// (review WPA2 M3의 사각지대가 정확히 그것이었다).
function fakeOrgViewport(key, {
  clientWidth = 400, contentWidth = 1000, clientHeight = 300, contentHeight = 300,
} = {}) {
  const canvas = {
    style: {},
    scrollWidth: contentWidth,
    offsetWidth: contentWidth,
    scrollHeight: contentHeight,
    offsetHeight: contentHeight,
  };
  // 머리말 힌트. 맞춤이 트리를 다 담지 못했을 때 화면이 그 사실을 말하는 자리다
  // (review WP3 major 1 — 읽히지 않는 축소를 "맞춤"이라 부르지 않기 위한 짝).
  const hint = { textContent: '' };
  return {
    canvas,
    hint,
    listeners: {},
    dataset: { orgView: key },
    clientWidth,
    clientHeight,
    classList: { add() {}, remove() {} },
    querySelector(selector) { return selector === '[data-org-canvas]' ? canvas : null; },
    closest(selector) {
      return selector === '.h-org'
        ? { querySelector: (inner) => (inner === '[data-org-hint]' ? hint : null) }
        : null;
    },
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

  // 400px 창에 1000px 트리 → 0.4배로 줄여 전부 보인다. 남는 폭이 없으므로 x는 0이고,
  // 세로는 300px 창에 300 × 0.4 = 120px만 차지하므로 남는 180px의 절반이 y가 된다.
  assert.equal(scaleOf(viewport), 0.4);
  assert.deepEqual(offsetOf(viewport), [0, 90]);

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

// review WP3 major 1 — 실측 재현: 390×844 화면, 액터 10명 세션에서 내용 908×2065,
// 뷰포트 317×480.
//
// 이 케이스에서 종전 규칙("두 축 모두 넣는다", WPA2 M3)은 배율 0.232를 뽑았고 12px
// 노드 글자가 2.8px가 됐다 — 잘리지 않았을 뿐 아무것도 읽히지 않는 화면이다.
// 그래서 계약을 다시 세웠다: **가로는 반드시 들어가고, 세로는 판독 배율 위에서만 줄이며,
// 그래도 넘치면 넘친다고 말한다.** 이 기하는 세로가 압도적이라 가로 맞춤(0.349)이
// 그대로 바닥이 되고, 세로는 넘친 채로 남아 사용자가 끌어서 본다.
test('fit keeps the width but never shrinks below what can be read', () => {
  const { wireOrgViews, fitOrgView, orgViewState } = createUsageRenderers();
  const viewport = fakeOrgViewport('session:tall', {
    clientWidth: 317, clientHeight: 480, contentWidth: 908, contentHeight: 2065,
  });
  wireOrgViews({ querySelectorAll: (selector) => (selector === '[data-org-view]' ? [viewport] : []) });

  const fitted = scaleOf(viewport);
  // 두 축을 다 넣으려던 배율(480/2065 = 0.232)로는 내려가지 않는다 — 그 배율에서
  // 노드 글자는 2.8px다.
  assert.ok(fitted > 480 / 2065, `판독 불가 배율까지 내려갔습니다: ${fitted}`);
  // 가로는 언제나 들어간다. 좌우로 끌어야 첫 글자가 보이는 화면은 만들지 않는다.
  assert.ok(908 * fitted <= 317 + 0.5, `가로가 뷰포트를 넘습니다: ${908 * fitted}`);
  assert.equal(fitted, Number((317 / 908).toFixed(3)));
  // 세로는 넘친다. 그러면 화면이 그렇게 **말한다** — 조용히 잘라 두지 않는다.
  assert.ok(2065 * fitted > 480);
  assert.equal(viewport.dataset.orgOverflow, 'true');
  assert.match(viewport.hint.textContent, /끌어서 이동/u);

  // 확대해서 보다가 다시 "맞춤"을 눌러도 같은 배율로 돌아온다.
  viewport.listeners.wheel({ deltaY: -300, clientX: 0, clientY: 0, preventDefault() {} });
  assert.ok(scaleOf(viewport) > fitted);
  fitOrgView(viewport, orgViewState.get('session:tall'));
  assert.equal(scaleOf(viewport), fitted);

  // 맞춤이 0.3 언저리인 상태에서 축소 휠이 화면을 도로 **확대**하면 안 된다.
  viewport.listeners.wheel({ deltaY: 200, clientX: 0, clientY: 0, preventDefault() {} });
  assert.ok(scaleOf(viewport) <= fitted, '축소가 배율을 올려서는 안 됩니다.');
});

// 좁은 화면에서는 CSS가 분기를 축 아래로 내려 트리 폭을 화면 폭 수준으로 되돌린다
// (usage.css @media max-width: 700px). 그 배치에서 맞춤이 실제로 하는 일을 잠근다:
// 세로가 아무리 길어도 판독 바닥(0.75) 아래로는 내려가지 않는다.
test('a narrow-layout tree stops shrinking at the readable floor and says it overflows', () => {
  const { wireOrgViews } = createUsageRenderers();
  const viewport = fakeOrgViewport('session:narrow', {
    clientWidth: 317, clientHeight: 480, contentWidth: 288, contentHeight: 2600,
  });
  wireOrgViews({ querySelectorAll: (selector) => (selector === '[data-org-view]' ? [viewport] : []) });

  const fitted = scaleOf(viewport);
  assert.equal(fitted, 0.75, `판독 바닥이 아니라 ${fitted}로 맞춰졌습니다.`);
  // 12px 글자가 9px로 남는다. 두 축을 다 넣던 규칙이었다면 0.184(=2.2px)였다.
  assert.ok(12 * fitted >= 9);
  assert.ok(288 * fitted <= 317);
  assert.equal(viewport.dataset.orgOverflow, 'true');
  assert.match(viewport.hint.textContent, /화면보다 큼/u);
});

// 반대로 트리가 통째로 들어가면 넘침 표시를 켜지 않는다 — 넘치지 않는데 "끌어서
// 이동하라"고 말하면 그 문구가 거짓이 된다.
test('a tree that fits leaves the overflow hint alone', () => {
  const { wireOrgViews } = createUsageRenderers();
  const viewport = fakeOrgViewport('session:small', {
    clientWidth: 900, clientHeight: 600, contentWidth: 400, contentHeight: 300,
  });
  wireOrgViews({ querySelectorAll: (selector) => (selector === '[data-org-view]' ? [viewport] : []) });
  assert.equal(scaleOf(viewport), 1);
  assert.equal(viewport.dataset.orgOverflow, 'false');
  assert.match(viewport.hint.textContent, /휠 확대/u);
});

// 스냅샷이 실제 변환을 가리면 안 된다 (review WP3 major 1 후반부): 예전 스냅샷 전용
// 규칙은 `height: auto`로 캔버스를 펴서 "이 상자에 이 트리가 들어가는가"라는 물음
// 자체를 사본에서 지웠다. 높이는 실제 규칙 그대로 두고 스크롤만 허용해야 한다.
test('the snapshot override may not unfreeze the org viewport height', async () => {
  const { USAGE_SNAPSHOT_CSS } = await import('./snapshot.mjs');
  assert.match(USAGE_SNAPSHOT_CSS, /overflow:\s*auto/u);
  assert.doesNotMatch(USAGE_SNAPSHOT_CSS, /height/u,
    '스냅샷이 캔버스 높이를 풀면 모바일 맞춤 배율 문제가 사본에서 보이지 않는다.');
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
  });
  // 액터 종류 라벨은 제품 이름 그대로다 (사용자 지시 ③ — 화면이 만드는 약어 금지).
  assert.match(markup, />Claude</u);
  assert.doesNotMatch(markup, />CLAUDE</u);
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

// ---- 자동 갱신의 생존 (review WPA2 M2) ------------------------------------
// 계약: 성공·거절·**응답 없음** 셋 다 in-flight 잠금을 풀고 다음 주기를 예약한다.
// 이전 구현은 세 번째 경우에 finally가 영영 돌지 않아 화면이 조용히 멎었다.
test('a fetch that never settles times out and the automatic poll keeps running', async () => {
  const clock = createFakeClock();
  const sandbox = await createUsageAppSandbox(
    // 가운데 항목은 시간초과 뒤 화면이 비어 있을 때 읽는 정적 사본 요청의 응답이다.
    // 여기서는 사본도 없는 상황을 재현해(오류) 폴백이 폴링을 가로채지 않는지 함께 본다.
    [HANGING_RESPONSE, new Error('사본 없음'), { snapshots: [], tasks: [harnessTask()] }],
    { clock },
  );
  assert.equal(sandbox.requests.length, 1);

  // 제한 시간 전에는 재요청하지 않는다 — 요청을 겹치지 않는 성질은 그대로다.
  await clock.advance(14_000);
  assert.equal(sandbox.requests.length, 1);

  // 15초에서 시간초과 → 사본을 한 번 확인하고, 없으면 오류를 말한 뒤 다음 주기를 예약한다.
  await clock.advance(2_000);
  assert.equal(sandbox.requests.length, 2);
  assert.equal(sandbox.requests[1].url, '/usage/pipeline-state.json');
  assert.match(sandbox.store.get('usageError').textContent, /응답이 없어/u);

  // 유휴 주기(60초) 뒤 다음 피드 요청이 실제로 나가고 화면이 채워진다.
  await clock.advance(60_000);
  assert.equal(sandbox.requests.length, 3);
  assert.match(sandbox.store.get('usageBody').innerHTML, /h-tree/u);
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
  const markup = renderers.renderPortfolioBoard([task], NOW);
  assert.match(markup, /한도 소모 Claude 10\.0%p/u);
  // Codex는 측정값이 하나도 없다 — 0%p로 지어내지 않는다.
  assert.doesNotMatch(markup, /소모[^<]*Codex/u);
  assert.doesNotMatch(markup, /Claude 80\.0%p/u);
  assert.match(markup, /data-actor-id="usage-harness:reviewer"[\s\S]*?<strong class="pl-chip-percent">55%<\/strong>/u);
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
  const markup = renderers.renderPortfolioBoard([task], NOW);
  // 18 + 7 = 25%p. 12 → 100의 상승(+88)은 소모가 아니다.
  assert.match(markup, /한도 소모 Codex 25\.0%p \(한도 초기화 1회\)/u);
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
        if (sql.includes('INSERT INTO usage_snapshots')) {
          return {
            bind(source, capturedAt, payload) {
              return {
                async run() {
                  state.snapshots.set(source, { source, captured_at: capturedAt, payload });
                  return { success: true };
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
  const postReport = (occurredAt) => worker.fetch(new Request('https://api.test/api/harness/report', {
    method: 'POST',
    headers: { authorization: 'Bearer harness-token', 'content-type': 'application/json' },
    body: JSON.stringify(harnessReportBody({ occurred_at: occurredAt })),
  }), env);

  // 사용량 20% → 잔여 80, 이어서 사용량 40% → 잔여 60. 이 세션이 쓴 것은 20%p다.
  assert.equal((await postSnapshot(20)).status, 200);
  assert.equal((await postReport('2026-08-27T09:00:00.000Z')).status, 200);
  assert.equal((await postSnapshot(40)).status, 200);
  assert.equal((await postReport('2026-08-27T10:00:00.000Z')).status, 200);

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

  const markup = createUsageRenderers().renderPortfolioBoard(data.tasks, NOW);
  assert.match(markup, /한도 소모 Codex 20\.0%p/u);
  // Claude 스냅샷이 없어 두 이벤트 모두 null이다 — 0%p 소모를 지어내지 않는다.
  assert.doesNotMatch(markup, /소모[^<]*Claude/u);
});

// ---- 관제탑 보드 조판 계약 (2026-08-28 통합) -------------------------------
// 데이터 계약은 위 e2e·테스트가 잠근다. 여기서 보는 것은 **승인된 조판 어휘**가 실제
// 마크업으로 나오는지다: 카드 · 세로 단계 레일 · 상태 라벨 · 모노 담당 라벨 · 칩.
// 조판이 조용히 옛 트리로 되돌아가거나 상태 라벨이 사라지면 여기서 깨진다.
test('the board renders the approved vocabulary and names every stage state in text', () => {
  const markup = createUsageRenderers().renderPortfolioBoard([harnessTask()], NOW);
  for (const vocabulary of ['pl-card', 'pl-stage', 'pl-badge', 'pl-who', 'pl-chip', 'pl-orch']) {
    assert.ok(markup.includes(`class="${vocabulary}`), `${vocabulary}가 조판에서 사라졌습니다.`);
  }
  // 카드 하나에 여덟 단계가 상시 선다 — 대기·기록 없음도 마디를 차지한다.
  const stages = markup.match(/class="pl-stage /gu) || [];
  assert.equal(stages.length, 8);
  // 상태를 색으로만 말하지 않는다: 마디마다 글자 라벨이 짝을 이룬다.
  assert.equal((markup.match(/class="pl-state /gu) || []).length, stages.length);
  // 구 4단계만 보고한 세션이므로 신설 단계는 '기록 없음'이고, 완료로 날조되지 않는다.
  assert.match(markup, /기록 없음/u);
  assert.match(markup, /진행 중 2\/8/u);
  // 옛 트리 조판이 되살아나면(중복 UI) 여기서 잡힌다.
  assert.doesNotMatch(markup, /h-node|h-org|data-org-canvas/u);
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

test('the detail org chart runs top-down on one axis and branches subagents to the right', () => {
  const markup = createUsageRenderers().renderSessionView([wp3Task()], NOW, 'active');
  // 축은 입력 + 총괄 + 여덟 단계 = 열 단이다. 좌→우 트리(h-tree 뿌리)가 축을 대신하지 않는다.
  assert.match(markup, /<div class="h-flow">/u);
  assert.equal((markup.match(/class="h-flow-step"/gu) || []).length, 2 + 8);
  assert.deepEqual(
    [...markup.matchAll(/data-org-phase="([a-z]+)"/gu)].map((match) => match[1]),
    ['input', 'plan', 'work', 'gate', 'review', 'revise', 'approve', 'done'],
  );
  // 분기는 액터가 있는 단계에만 생긴다 (구현·게이트 둘).
  assert.equal((markup.match(/class="h-branch"/gu) || []).length, 2);
  // 손계산 좌표가 아니라 CSS 조판이다 (DESIGN.md §10).
  assert.doesNotMatch(markup, /<svg/u);
});

test('a delegated grandchild agent is drawn nested under its parent, not dropped', () => {
  const markup = createUsageRenderers().renderSessionView([wp3Task()], NOW, 'active');
  // 보고된 액터 5명이 전부 자기 노드를 갖는다 (총괄 1 + 서브 4).
  assert.equal((markup.match(/data-actor-id=/gu) || []).length, 5);
  // 손자(테스트 서브에이전트)는 부모 카드 아래 중첩 목록 안에 있다.
  assert.match(
    markup,
    /data-actor-id="wp3:server"[\s\S]*?<ul><li class="h-node-slot">[\s\S]*?data-actor-id="wp3:server-sub"/u,
  );
});

test('role, assignment, duration, and the quota estimate each get their own line', () => {
  const markup = createUsageRenderers().renderSessionView([wp3Task()], NOW, 'active');
  // 역할과 담당을 겹쳐 쓰지 않는다 — 둘 다 자기 라벨과 함께 나온다.
  assert.match(markup, /<dt>역할<\/dt><dd>백엔드 구현<\/dd>/u);
  assert.match(markup, /<dt>담당<\/dt><dd>worker 자동 스탬프<\/dd>/u);
  // 소요시간: 끝난 액터는 시작~종료, 진행 중인 액터는 시작~지금.
  assert.match(markup, /data-actor-id="wp3:server"[\s\S]*?<dt>소요<\/dt><dd>1시간<\/dd>/u);
  assert.match(markup, /data-actor-id="wp3:front"[\s\S]*?<dt>소요<\/dt><dd>2시간<\/dd>/u);
  // 한도 소비는 **추정**이다: 잔여의 감소분(88 → 80.5)이고, 라벨에 그렇게 적는다.
  assert.match(markup, /data-actor-id="wp3:server"[\s\S]*?<dt>한도 소비<\/dt><dd>Codex 7\.5%p 추정<\/dd>/u);
  // 종료 스냅샷이 없는 액터에는 소비 줄 자체가 없다 — 0%p로 지어내지 않는다.
  assert.doesNotMatch(markup, /data-actor-id="wp3:front"[\s\S]*?한도 소비/u);
  // 모델은 정확한 모델명 그대로, 같은 라벨-값 격자의 첫 줄로 낸다.
  assert.match(markup, /<dt>모델<\/dt><dd class="h-node-fact-mono">gpt-5\.2-codex · xhigh<\/dd>/u);
  // 진행 중 노드는 테두리만이 아니라 글자 라벨로도 구분된다 (색각 조건).
  assert.match(markup, /data-actor-id="wp3:front"[\s\S]*?class="h-node-flag">작업중</u);
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
  // 관제탑도 같은 배치를 쓴다 — 두 화면이 액터를 서로 다른 단계에 세우지 않는다.
  const board = renderers.renderPortfolioBoard([wp3Task()], NOW);
  assert.match(board, /data-org-phase="gate"[\s\S]*?data-actor-id="wp3:gate"/u);
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
  // 잴 근거가 없는 값은 줄 자체가 없다: 소요·한도 소비를 지어내지 않는다.
  assert.doesNotMatch(markup, /<dt>소요<\/dt>/u);
  assert.doesNotMatch(markup, /<dt>한도 소비<\/dt>/u);
  // 역할은 그대로 나온다 (구 payload에도 role은 있다).
  assert.match(markup, /<dt>역할<\/dt><dd>위임 실행<\/dd>/u);
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

  // 검토자는 부모(work)를 따라가지 않고 자기 단계(review)에 선다.
  const workBlock = /data-org-phase="work"[\s\S]*?data-org-phase="gate"/u.exec(markup)[0];
  assert.match(workBlock, /data-actor-id="cross:impl"/u);
  assert.doesNotMatch(workBlock, /data-actor-id="cross:reviewer"/u);
  const reviewBlock = /data-org-phase="review"[\s\S]*?data-org-phase="revise"/u.exec(markup)[0];
  assert.match(reviewBlock, /data-actor-id="cross:reviewer"/u);

  // 배치가 옮겨져도 계층은 사라지지 않는다 — 부모를 이름으로 명시한다.
  assert.match(markup, /data-actor-id="cross:reviewer"[\s\S]*?<dt>상위<\/dt><dd>구현자<\/dd>/u);
  // 부모와 단계가 같은 자식은 예전처럼 부모 카드 아래로 중첩되고, '상위' 줄이 붙지 않는다.
  assert.match(
    markup,
    /data-actor-id="cross:impl"[\s\S]*?<ul><li class="h-node-slot">[\s\S]*?data-actor-id="cross:helper"/u,
  );
  const helperNode = /data-actor-id="cross:helper"[\s\S]*?<\/article>/u.exec(markup)[0];
  assert.doesNotMatch(helperNode, /<dt>상위<\/dt>/u);

  // 관제탑도 같은 배치를 쓴다 — 두 화면이 액터를 서로 다른 단계에 세우지 않는다.
  const board = renderers.renderPortfolioBoard([crossPhaseTask()], NOW);
  assert.match(board, /data-org-phase="review"[\s\S]*?data-actor-id="cross:reviewer"/u);
  assert.match(board, /data-actor-id="cross:reviewer"[\s\S]*?상위 구현자/u);
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
  assert.match(markup, /data-actor-id="mp:main"[\s\S]*?<strong>17%<\/strong>/u);
  assert.doesNotMatch(markup, /data-actor-id="mp:main"[\s\S]*?<strong>82%<\/strong>/u);

  // 이벤트가 측정한 값이 있으면 그것이 payload보다 우선한다 (다른 액터와 같은 규칙).
  const measured = renderers.renderSessionView([{
    ...task,
    events: [{ ts: iso(HOUR), kind: 'report', phase: 'work', actor_id: 'mp:main', percent: 44 }],
  }], NOW, 'active');
  assert.match(measured, /data-actor-id="mp:main"[\s\S]*?<strong>44%<\/strong>/u);

  // progress를 싣지 않는 구 보고에서만 세션 진행률로 떨어진다 — 총괄 카드가 수치를
  // 통째로 잃지 않게 남겨 둔 폴백이다.
  const legacy = renderers.renderSessionView([{
    ...task,
    actors: [{ ...task.actors[0], progress: undefined }],
  }], NOW, 'active');
  assert.match(legacy, /data-actor-id="mp:main"[\s\S]*?<strong>82%<\/strong>/u);
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
  const late = /2026\.08\.28<\/p>[\s\S]*?<\/div>/u.exec(markup)[0];
  assert.match(late, /자정 이후 완료/u);
  assert.doesNotMatch(late, /자정 이전 완료/u);
  // 탭의 날짜 표기도 같은 축을 쓴다 — 그러지 않으면 08.28 그룹 안에 08.27 탭이 선다.
  assert.match(markup, /datetime="2026-08-28">08\.28</u);
});

// major 3 — 반례: 두 날짜 그룹에서 두 번째 tablist에는 tabindex="0"인 탭이 하나도 없어
// 키보드 사용자가 그 그룹의 세션을 열 수 없었다(방향키 이동도 tablist 안으로 제한된다).
const tabbableCounts = (markup) => [...markup.matchAll(/<div class="h-session-tabs"[\s\S]*?<\/div>/gu)]
  .map(([block]) => ({
    selected: (block.match(/aria-selected="true"/gu) || []).length,
    tabbable: (block.match(/tabindex="0"/gu) || []).length,
  }));

test('every date group keeps a keyboard entry point while selection stays unique', () => {
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
  const groups = tabbableCounts(markup);
  assert.ok(groups.length >= 2, `날짜 그룹이 둘 이상이어야 반례가 재현된다: ${groups.length}`);
  // 선택은 화면 전체에 하나뿐이고, 초점 진입점은 그룹마다 하나씩이다.
  assert.equal(groups.reduce((total, group) => total + group.selected, 0), 1);
  for (const group of groups) assert.equal(group.tabbable, 1);
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
  const board = renderers.renderPortfolioBoard([task], NOW);
  const reason = '이 단계는 보고가 전송되지 않았습니다';
  // 보고된 적 없는 앞 단계(input·work·gate)마다 사유가 붙는다.
  assert.match(tree, new RegExp(`data-phase-state="skipped"[\\s\\S]*?${reason}`, 'u'));
  assert.equal((tree.match(new RegExp(reason, 'gu')) || []).length,
    (tree.match(/data-phase-state="skipped"/gu) || []).length);
  assert.match(board, new RegExp(`data-phase-state="skipped"[\\s\\S]*?${reason}`, 'u'));
  // 보고된 단계에는 사유를 붙이지 않는다 — 사유가 상태와 짝을 이룬다.
  const planBlock = /data-org-phase="plan"[\s\S]*?data-org-phase="work"/u.exec(tree)[0];
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

// 사용자 지시 ③ — 화면이 **스스로 만드는** 문구에는 약어를 쓰지 않는다.
// 보고 데이터가 실어 오는 약어(작업 이름의 WP1 등)는 그 데이터의 사실이므로 손대지 않는다.
test('labels the UI writes itself are spelled out, while reported text is left alone', () => {
  const markup = createUsageRenderers()
    .renderSessionView([harnessTask({ name: 'WP1 서버 (08-27)' })], NOW, 'active');
  for (const abbreviation of ['>REQUEST<', '>MAIN<', '>PHASE<', '>AGENT<', '>NODE<', 'ORG CHART', '>CODEX<', '>WEBGPT<', 'ARTIFACT']) {
    assert.ok(!markup.includes(abbreviation), `UI가 만든 약어가 남아 있습니다: ${abbreviation}`);
  }
  assert.match(markup, />사용자 요청</u);
  assert.match(markup, />총괄</u);
  assert.match(markup, />단계</u);
  // 보고가 실어 온 이름은 그대로 나온다.
  assert.match(markup, /WP1 서버/u);
});

// 사용자 지시 ④ — 카드의 시각은 하네스의 **마지막 보고**이고, 화면 갱신 시계와 이름이
// 다르다. 같은 말('동기화')을 두 시계가 나눠 쓰면 값이 어긋난 것처럼 읽힌다.
test('the card clock is named after the report, not after the screen refresh', () => {
  const renderers = createUsageRenderers();
  const task = harnessTask({ id: 'clock', updated_at: iso(3 * HOUR) });
  const tree = renderers.renderSessionView([task], NOW, 'active');
  const board = renderers.renderPortfolioBoard([task], NOW);
  assert.match(tree, /마지막 보고 3시간 전/u);
  assert.match(board, /마지막 보고 3시간 전/u);
  assert.doesNotMatch(tree, /동기화/u);
  assert.doesNotMatch(board, /동기화/u);
  // 보고 시각이 아예 없으면 그렇게 말한다 (0분 전으로 지어내지 않는다).
  const noTime = renderers.renderSessionView([harnessTask({ id: 'no-clock', updated_at: '' })], NOW, 'active');
  assert.match(noTime, /보고 시각 없음/u);
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
  assert.equal((markup.match(/data-task-tab="/gu) || []).length, 10);
  assert.equal((markup.match(/data-task-panel="/gu) || []).length, 10);
  assert.match(markup, /data-completed-more/u);
  assert.match(markup, /남은 4개/u);
  // 날짜 그룹 머리가 tablist 밖에 서고, 그룹마다 자기 tablist를 갖는다 (역할 계약).
  assert.match(markup, /class="list-group-head h-session-group-head">2026\.08\.27</u);
  assert.ok((markup.match(/data-task-tablist/gu) || []).length >= 2);
  // 가장 최근 완료가 첫 탭이다.
  assert.ok(markup.indexOf('완료 세션 0') < markup.indexOf('완료 세션 9'));
  // 열 개 안에 들지 못한 세션은 탭으로 서지 않는다 (지운 것이 아니라 접힌 것이다).
  assert.doesNotMatch(markup, /완료 세션 13/u);
});

test('a completed list shorter than one page carries no more button', () => {
  const completed = [harnessTask({
    id: 'done-only', name: '하나뿐인 완료', status: 'complete', phase: 'done', progress: 100,
  })];
  const markup = createUsageRenderers().renderSessionView(completed, NOW, 'complete');
  assert.doesNotMatch(markup, /data-completed-more/u);
  assert.match(markup, /하나뿐인 완료/u);
});

// ---- 정적 폴백 (usage/pipeline-state.json) --------------------------------
//
// 하네스 피드에 닿지 못한 첫 화면은 빈 채로 두지 않고, 저장소에 함께 배포되는 사본으로
// 관제탑을 세운다. 계약 셋을 본다: ① 첫 화면 실패에서만 탄다 ② 사본임을 화면이 말한다
// ③ 사본에 없는 판정('기록 없음')을 지어내지 않는다.
// 이 테스트가 **못 보는 것**: 실제 HTTP 캐시 동작과 배포면에서의 파일 접근 권한.

const settle = async (times = 6) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
};

const staticCopy = {
  updated: '2026-08-27T11:00:00.000Z',
  window: '10:07 → 17:00',
  pipelines: [{
    id: 'P-C',
    name: '관제탑 이전',
    orch: 'Fable 5',
    task: '관제 페이지를 사이트에',
    state: 'run',
    meta: ['정본 = 사이트'],
    stages: [
      { n: '기획', who: 'Fable 5', st: 'ok', note: '계약 고정', t: '38m' },
      { n: '구현', who: 'GPT 5.6 Sol xhigh', st: 'run', chips: ['GPT 5.6 Sol:Worker'] },
      { n: '리뷰', who: 'Opus 5', st: 'wait' },
    ],
  }],
};

test('a first load that fails falls back to the shipped static copy and labels it as one', async () => {
  const sandbox = await createUsageAppSandbox([new Error('network down'), staticCopy]);
  await settle();

  assert.equal(sandbox.requests.length, 2, '피드가 실패하면 사본을 한 번 읽는다');
  assert.equal(sandbox.requests[1].url, '/usage/pipeline-state.json');
  assert.equal(sandbox.requests[1].options.cache, 'no-store');
  // 배포면의 정적 파일이라 인증 헤더를 붙이지 않는다.
  assert.equal(sandbox.requests[1].options.headers, undefined);

  const markup = sandbox.store.get('usageBody').innerHTML;
  assert.match(markup, /class="pl-board"/u);
  assert.match(markup, /P-C · 관제탑 이전/u);
  assert.match(markup, /진행 중 1\/3/u);
  // 사본의 chips는 문자열 배열이다 — 구조화된 칩 조판에서도 그 형식이 그대로 읽힌다.
  assert.match(markup, /class="pl-chip-name">GPT 5\.6 Sol:Worker/u);
  assert.match(markup, /class="pl-cost">38m/u);
  // 사본임을 화면이 말한다 — 실시간처럼 보이게 두지 않는다.
  assert.match(markup, /정적 사본/u);
  // 사본이 언제 찍혔는지 상대 시각으로 말한다 (벽시계에 의존하지 않게 모양만 본다).
  assert.match(markup, /사본 갱신 \d+[^<]*전/u);
  assert.doesNotMatch(markup, /NaN|Invalid/u);
  assert.match(sandbox.store.get('usageError').textContent, /저장된 사본을 대신 보여줍니다/u);
  // 사본에는 단계 이벤트가 없다 — 없는 판정('기록 없음')을 만들어내지 않는다.
  assert.doesNotMatch(markup, /class="pl-state is-skip"/u);
});

test('a live dashboard is never replaced by the static copy', async () => {
  const sandbox = await createUsageAppSandbox([
    { snapshots: [], tasks: [harnessTask()] },
    new Error('network down'),
  ]);
  const before = sandbox.store.get('usageBody').innerHTML;
  assert.match(before, /us-command-layout/u);

  await sandbox.store.get('reload').listeners.click();
  await settle();

  // 사본을 묻지도 않았다: 요청은 최초 로드와 실패한 새로고침 둘뿐이다.
  assert.equal(sandbox.requests.length, 2);
  assert.equal(sandbox.store.get('usageBody').innerHTML, before);
  assert.equal(sandbox.store.get('usageError').textContent, 'network down');
});

test('when the static copy is unreachable too, the screen says why instead of faking a board', async () => {
  const sandbox = await createUsageAppSandbox([new Error('network down'), new Error('offline')]);
  await settle();
  assert.equal(sandbox.requests.length, 2);
  assert.equal(sandbox.store.get('usageBody').innerHTML, '');
  assert.equal(sandbox.store.get('usageError').textContent, 'network down');
});

test('an empty or malformed static copy is treated as no copy at all', async () => {
  for (const body of [{}, { pipelines: [] }, { pipelines: 'nope' }, null]) {
    const sandbox = await createUsageAppSandbox([new Error('network down'), body]);
    await settle();
    assert.equal(sandbox.store.get('usageBody').innerHTML, '');
  }
});

test('the shipped static copy parses and actually renders a board', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const nodePath = await import('node:path');
  const root = nodePath.dirname(nodePath.dirname(fileURLToPath(import.meta.url)));
  const state = JSON.parse(readFileSync(nodePath.join(root, 'usage/pipeline-state.json'), 'utf8'));
  assert.ok(Array.isArray(state.pipelines) && state.pipelines.length > 0, '사본에 파이프라인이 있어야 한다');

  const markup = createUsageRenderers().buildFallbackBoard(state, NOW);
  assert.equal((markup.match(/class="pl-card"/gu) || []).length, state.pipelines.length);
  // 사본의 모든 단계가 마디를 차지한다 — 빈 보드가 배포되는 것을 막는다.
  const stageCount = state.pipelines.reduce((total, item) => total + (item.stages || []).length, 0);
  assert.equal((markup.match(/class="pl-stage /gu) || []).length, stageCount);
});
