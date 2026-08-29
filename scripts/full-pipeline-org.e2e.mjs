// 워크트리 계약 E2E — /usage 단일 조판 이관.
//
// 조판은 카드 조직도와 관제탑 보드에서 단일 워크트리로 바뀌었다. **계약은 바뀌지 않았다.**
// 그래서 이 파일은 마크업 표현만 워크트리 어휘로 옮기고,
// 검사하는 보장(전 단계 상시 표시 · 액터 누락 없음 · 없는 값 날조 없음)은 그대로 둔다.
// 상태 판정 어휘(data-phase-state)는 조판과 무관한 판독 원본이라 손대지 않는다.
//
// 무엇을 잠그는가
//   워크트리는 "지금 어디까지 왔나"가 아니라 **세션마다 전 단계를 상시 그리는 표**다.
//   그래서 검사도 "현재 단계가 보이는가"가 아니라 다음 셋을 본다:
//     (1) 세션마다 여덟 단계가 빠짐없이 노드로 서고, 보고된 지난 단계는 done·보고된 적
//         없는 지난 단계는 skipped·앞으로 올 단계는 pending으로 **상태만** 달라진다
//         (노드가 사라지지 않고, 없던 단계를 완료로 지어내지도 않는다),
//     (2) 보고된 액터가 하나도 빠지지 않고 자기 단계에서 갈라져 나온다,
//     (3) 이벤트 로그가 있으면 단계 소요시간과 세션 한도 소모가 붙고, **없으면 트리는
//         그대로인 채 그 두 줄만 사라진다** (구세션 하위호환).
//
// 이 검사가 못 보는 것: 확대·이동 같은 DOM 이벤트 배선(scripts/usage.test.mjs)과
//   실제 조판(docs/_snapshots/usage.html).

import assert from 'node:assert/strict';
import { createUsageRenderers } from './render-sandbox.mjs';

const NOW = Date.parse('2026-08-27T13:00:00.000Z');

const actor = (id, name, parentId = '') => ({
  id,
  parent_id: parentId,
  name,
  kind: 'codex',
  model: 'gpt-5.6-sol',
  reasoning: 'xhigh',
  role: parentId ? '서브에이전트' : '메인 오케스트레이터',
  status: 'working',
  assignment: '고정 fixture 작업',
  progress: 60,
});

const task = (id, name, phase, actors) => ({
  id,
  name,
  phase,
  progress: phase === 'done' ? 100 : 60,
  status: phase === 'done' ? 'complete' : 'active',
  category: '파이프라인 fixture',
  updated_at: '2026-08-27T12:00:00.000Z',
  actors,
});

// 계약이 요구하는 단계 사슬. 화면(usage.js PHASES)과 Worker(VALID_HARNESS_PHASES)가
// 이 순서로 같아야 하고, 그 **원본 대 원본** 대조는 scripts/validate.mjs가 한다.
// 여기서는 그 사슬이 실제 마크업으로 서는지를 본다.
const PHASE_CHAIN = ['input', 'plan', 'work', 'gate', 'review', 'revise', 'approve', 'done'];

// 구 4단계 키(plan/work/review/done)와 확장된 새 키(gate/approve)를 한 fixture에 섞는다 —
// 하위호환과 확장이 같은 렌더 경로를 지나는지 한 번에 본다.
const tasks = [
  task('plan-task', '기획 세션 (08-27)', 'plan', [actor('plan:main', '기획 Main')]),
  task('work-task', '구현 세션 (08-27)', 'work', [
    actor('work:main', '구현 Main'),
    actor('work:calc', '계산 서브에이전트', 'work:main'),
  ]),
  task('gate-task', '게이트 세션 (08-27)', 'gate', [actor('gate:main', '게이트 Main')]),
  task('review-task', '검토 세션 (08-27)', 'review', [
    actor('review:main', '검토 Main'),
    actor('review:critic', '반증 서브에이전트', 'review:main'),
  ]),
  task('approve-task', '승인 세션 (08-27)', 'approve', [actor('approve:main', '승인 Main')]),
  task('done-task', '완료 세션 (08-27)', 'done', [actor('done:main', '완료 Main')]),
];

const renderers = createUsageRenderers();
// 관제탑은 **진행 중인 세션만** 그린다 (계약 §A) — 완료는 완료 탭이 맡는다.
// 그래서 보드 쪽 계약(전 단계 상시 표시 · 액터 누락 없음)은 진행 중 세션 집합에서 보고,
// 완료 세션의 같은 계약은 아래 (1-b)에서 완료 탭의 조직도로 확인한다.
const activeTasks = tasks.filter((item) => item.status !== 'complete');
const org = renderers.renderSessionView(tasks, NOW, 'active');

// ---- (1) 세션마다 전 단계가 상시 선다 -------------------------------------
assert.match(org, /실행 워크트리[\s\S]*입력[\s\S]*기획[\s\S]*구현[\s\S]*게이트[\s\S]*리뷰[\s\S]*수정[\s\S]*승인[\s\S]*완료/u);
for (const phase of PHASE_CHAIN) {
  assert.equal((org.match(new RegExp(`data-org-phase="${phase}"`, 'gu')) || []).length, activeTasks.length,
    `${phase} 단계 노드는 세션마다 하나씩, 총 ${activeTasks.length}개여야 합니다.`);
}
assert.equal((org.match(/data-worktree/gu) || []).length, activeTasks.length);
for (const id of activeTasks.map((item) => item.id)) {
  assert.equal((org.match(new RegExp(`data-task-id="${id}"`, 'gu')) || []).length, 1);
}
// 완료 세션은 진행 중 패널에서 빠지되 **사라지지 않는다** — 완료 탭에 자기 글이 있다.
assert.doesNotMatch(org, /data-task-id="done-task"/u);

// 세션 하나를 떼어내 단계 상태의 진행 방향을 확인한다: 지난 단계 done → 현재 current
// → 남은 단계 pending. 이것이 "현 단계만 강조"와 갈리는 지점이다.
// **구 4단계 키만 보고한 세션**(work)이므로 이 검사가 곧 하위호환 검사다: 이벤트가 없는
// 구세션은 구 4단계 사슬만 완료로 접히고, 확장으로 생긴 단계(input)는 지나왔다는 근거가
// 없으므로 완료가 아니라 skipped('기록 없음')로, 아직 오지 않은 단계는 pending으로 선다.
const workOnly = renderers.renderWorktree(renderers.sessionWorktree(tasks[1], NOW), '구현 세션 실행 워크트리');
const expectedStates = { input: 'skipped', plan: 'done', work: 'current' };
for (const phase of PHASE_CHAIN) {
  const state = expectedStates[phase] || 'pending';
  assert.match(workOnly, new RegExp(`data-org-phase="${phase}" data-phase-state="${state}"`, 'u'),
    `${phase} 단계는 ${state} 상태여야 합니다.`);
}
// 새 키를 보고한 세션도 같은 규칙을 따른다 (approve가 current, done만 pending).
// 보고된 적 없는 앞 단계(revise 등)를 완료로 날조하지 않는 것이 이 검사의 핵심이다.
const approveOnly = renderers.renderWorktree(renderers.sessionWorktree(tasks[4], NOW), '승인 세션 실행 워크트리');
assert.match(approveOnly, /data-org-phase="approve" data-phase-state="current"/u);
assert.match(approveOnly, /data-org-phase="review" data-phase-state="done"/u);
assert.match(approveOnly, /data-org-phase="revise" data-phase-state="skipped"/u);
assert.match(approveOnly, /data-org-phase="done" data-phase-state="pending"/u);
// ---- (1-b) 완료 세션도 같은 판정을 받는다 (완료 탭의 조직도) ---------------
// 완료 세션은 pending으로 되돌아가는 단계가 없다. 다만 "완료"는 실제로 지나온 단계에만
// 붙고(구 4단계), 보고된 적 없는 신설 단계는 skipped로 남는다. 보드에서 빠졌다고 이
// 판정이 사라지면 안 되므로, 같은 상태 어휘를 완료 탭에서 그대로 확인한다.
const doneOnly = renderers.renderSessionView([tasks[5]], NOW, 'complete');
assert.equal((doneOnly.match(/data-phase-state="done"/gu) || []).length, 4);
assert.equal((doneOnly.match(/data-phase-state="skipped"/gu) || []).length, 4);
assert.doesNotMatch(doneOnly, /data-phase-state="(?:current|pending)"/u);
assert.match(doneOnly, /data-actor-id="done:main"/u);

// ---- (2) 보고된 액터가 하나도 빠지지 않는다 --------------------------------
const activeActors = activeTasks.flatMap((item) => item.actors);
assert.equal((org.match(/data-actor-id=/gu) || []).length, activeActors.length);
for (const item of activeActors) {
  assert.equal((org.match(new RegExp(item.name, 'gu')) || []).length, 1,
    `${item.name}는 관제탑에 한 번만 있어야 합니다.`);
}
// 서브에이전트는 총괄 뒤 자기 단계의 워크트리 행으로 붙는다 (총괄 줄이 먼저 온다).
assert.match(org, /data-actor-id="work:main"[\s\S]*?data-actor-id="work:calc"/u);
// 이름·역할·담당·모델+추론·상태가 빠지지 않고 각 워크트리 슬롯에 선다.
assert.match(org, /class="wt-row is-agent[^"]*" role="row"\s*data-depth="2" data-actor-id="work:calc"/u);
const calcRow = org.split(/(?=<div class="wt-row )/u)
  .find((part) => part.includes('data-actor-id="work:calc"'));
assert.ok(calcRow, '계산 서브에이전트 행이 있어야 합니다.');
assert.match(calcRow, /class="wt-name">계산 서브에이전트<\/span>/u);
assert.match(calcRow, /class="wt-kind">Codex<\/span>/u);
assert.match(calcRow, /class="wt-model h-node-fact-mono">gpt-5\.6-sol · xhigh<\/span>/u);
assert.match(calcRow, /class="wt-cell wt-state" role="cell">작업 중<\/div>/u);
assert.match(calcRow, /class="wt-sub" role="cell">서브에이전트 · 고정 fixture 작업<\/p>/u);
// 날짜 접미사는 카드 제목에서 떨어져 나온다.
assert.doesNotMatch(org, /\(08-27\)/u);

// ---- (3) 이벤트가 있으면 소요시간·한도 소모가 붙고, 없으면 사라진다 --------
assert.doesNotMatch(org, /한도 소모/u);
assert.doesNotMatch(org, /class="wt-cell wt-time h-node-time" role="cell">\d/u,
  '이벤트가 없는 세션에는 숫자 단계 소요시간을 지어내지 않습니다.');

// usage_codex·usage_claude는 그 시점의 **잔여 한도(%)**다 (worker/src/router.js의
// remainingUsagePercent). 그러므로 소모는 "처음 − 끝"이고, 값은 시간이 갈수록 **줄어든다**.
// 이 fixture가 늘어나는 값을 쓰면 화면의 부호 오류를 그대로 잠근다 (review WPA2 B1/M5).
const eventTask = {
  ...tasks[1],
  events: [
    { ts: '2026-08-27T09:00:00.000Z', kind: 'phase-change', phase: 'plan', model: 'gpt-5.6-sol', reasoning: 'xhigh', usage_codex: 90, usage_claude: 4 },
    { ts: '2026-08-27T10:30:00.000Z', kind: 'phase-change', phase: 'work', model: 'claude-opus-5', reasoning: 'high', usage_codex: 77.5, usage_claude: 4 },
    // 진행률만 실은 보고. 스냅샷이 없으면 usage는 null이고, 그 null은 0으로 읽히면 안 된다.
    { ts: '2026-08-27T11:00:00.000Z', kind: 'report', phase: 'work', actor_id: 'work:calc', percent: 41, usage_codex: null, usage_claude: null },
  ],
};
const timed = renderers.renderWorktree(renderers.sessionWorktree(eventTask, NOW), '이벤트 세션 실행 워크트리');
// plan 09:00→10:30 = 1시간 30분, work 10:30→now(13:00) = 2시간 30분.
assert.match(timed, /data-org-phase="plan"[\s\S]*?class="wt-cell wt-time h-node-time" role="cell">1시간 30분/u);
assert.match(timed, /data-org-phase="work"[\s\S]*?class="wt-cell wt-time h-node-time" role="cell">2시간 30분/u);
// 이벤트가 있으면 완료의 근거도 이벤트다 — plan·work만 등장했으므로 그 앞의 input은
// 완료가 아니라 '기록 없음'이다 (인덱스만 보고 접으면 없던 단계가 완료로 날조된다).
assert.match(timed, /data-org-phase="input" data-phase-state="skipped"/u);
assert.match(timed, /data-org-phase="plan" data-phase-state="done"/u);
// 현재 단계의 모델은 그 단계의 이벤트가 말한 것을 그대로 쓴다.
assert.match(timed, /data-org-phase="work"[\s\S]*?claude-opus-5 · high/u);
// 세션 한도 소모 = 잔여의 감소분(90 → 77.5 = 12.5%p). 변화가 없는 원본(Claude 4→4)은
// 적지 않고, null 이벤트는 0으로 세지 않는다.
const timedTask = renderers.renderTask(eventTask, NOW);
assert.match(timedTask, /이 세션 소모 · Codex 12\.5%p/u);
assert.doesNotMatch(timedTask, /Claude \d/u);
assert.doesNotMatch(timedTask, /한도 초기화/u);
// 서브에이전트 진행도는 payload의 60%가 아니라 이벤트의 최신 41%다.
assert.match(timed, /data-actor-id="work:calc"[\s\S]*?class="wt-cell wt-pct" role="cell">41%<\/div>/u);

// ---- 세션 탭 쪽 표기 ------------------------------------------------------
const activeView = renderers.renderSessionView(tasks, NOW, 'active');
assert.doesNotMatch(activeView, /\(08-27\)/u);
assert.match(activeView, /구현 60%[\s\S]*<time class="h-task-date" datetime="2026-08-27">08\.27<\/time>/u);

console.log('FULL PIPELINE WORKTREE E2E: PASS');
