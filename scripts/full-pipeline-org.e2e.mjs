// 전체 조직도 계약 E2E — plan.md(2026-08-28 야간 자율 개편) §4-1.
//
// 무엇을 잠그는가
//   조직도는 "지금 어디까지 왔나"가 아니라 **세션마다 전 단계를 상시 그리는 트리**다.
//   그래서 검사도 "현재 단계가 보이는가"가 아니라 다음 셋을 본다:
//     (1) 세션마다 네 단계가 빠짐없이 노드로 서고, 지나간 단계는 done·앞으로 올 단계는
//         pending으로 **상태만** 달라진다 (노드가 사라지지 않는다),
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

const tasks = [
  task('plan-task', '기획 세션 (08-27)', 'plan', [actor('plan:main', '기획 Main')]),
  task('work-task', '구현 세션 (08-27)', 'work', [
    actor('work:main', '구현 Main'),
    actor('work:calc', '계산 서브에이전트', 'work:main'),
  ]),
  task('review-task', '검토 세션 (08-27)', 'review', [
    actor('review:main', '검토 Main'),
    actor('review:critic', '반증 서브에이전트', 'review:main'),
  ]),
  task('done-task', '완료 세션 (08-27)', 'done', [actor('done:main', '완료 Main')]),
];

const renderers = createUsageRenderers();
const org = renderers.renderPortfolioOrg(tasks, NOW);

// ---- (1) 세션마다 전 단계가 상시 선다 -------------------------------------
assert.match(org, /사용자 입력[\s\S]*메인 오케스트레이션[\s\S]*구상[\s\S]*작업[\s\S]*검토[\s\S]*완료/u);
for (const phase of ['plan', 'work', 'review', 'done']) {
  assert.equal((org.match(new RegExp(`data-org-phase="${phase}"`, 'gu')) || []).length, tasks.length,
    `${phase} 단계 노드는 세션마다 하나씩, 총 ${tasks.length}개여야 합니다.`);
}
for (const id of ['plan-task', 'work-task', 'review-task', 'done-task']) {
  assert.equal((org.match(new RegExp(`data-portfolio-task="${id}"`, 'gu')) || []).length, 1);
}

// 세션 하나를 떼어내 단계 상태의 진행 방향을 확인한다: 지난 단계 done → 현재 current
// → 남은 단계 pending. 이것이 "현 단계만 강조"와 갈리는 지점이다.
const workOnly = renderers.renderPortfolioOrg([tasks[1]], NOW);
for (const [phase, state] of [['plan', 'done'], ['work', 'current'], ['review', 'pending'], ['done', 'pending']]) {
  assert.match(workOnly, new RegExp(`data-org-phase="${phase}" data-phase-state="${state}"`, 'u'),
    `${phase} 단계는 ${state} 상태여야 합니다.`);
}
// 완료 세션은 네 단계가 모두 done이다 (되돌아간 단계를 pending으로 되돌리지 않는다).
const doneOnly = renderers.renderPortfolioOrg([tasks[3]], NOW);
assert.equal((doneOnly.match(/data-phase-state="done"/gu) || []).length, 4);
assert.doesNotMatch(doneOnly, /data-phase-state="(?:current|pending)"/u);

// ---- (2) 보고된 액터가 하나도 빠지지 않는다 --------------------------------
const allActors = tasks.flatMap((item) => item.actors);
assert.equal((org.match(/data-actor-id=/gu) || []).length, allActors.length);
for (const item of allActors) {
  assert.equal((org.match(new RegExp(item.name, 'gu')) || []).length, 1,
    `${item.name}는 전체 조직도에 한 번만 있어야 합니다.`);
}
// 서브에이전트는 자기 부모 아래에서 갈라진다 — 트리 중첩이 실제로 있는지 본다.
assert.match(org, /data-actor-id="work:main"[\s\S]*?data-actor-id="work:calc"/u);
assert.match(org, /class="h-node-slot">[\s\S]*?<ul>/u);
// 날짜 접미사는 노드 이름에서 떨어져 나온다.
assert.doesNotMatch(org, /\(08-27\)/u);

// ---- (3) 이벤트가 있으면 소요시간·한도 소모가 붙고, 없으면 사라진다 --------
assert.doesNotMatch(org, /이 세션 소모/u);
assert.doesNotMatch(org, /h-node-time/u, '이벤트가 없는 세션에는 단계 소요시간을 지어내지 않습니다.');

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
const timed = renderers.renderPortfolioOrg([eventTask], NOW);
// plan 09:00→10:30 = 1시간 30분, work 10:30→now(13:00) = 2시간 30분.
assert.match(timed, /data-org-phase="plan"[\s\S]*?h-node-time">1시간 30분/u);
assert.match(timed, /data-org-phase="work"[\s\S]*?h-node-time">2시간 30분/u);
// 현재 단계의 모델은 그 단계의 이벤트가 말한 것을 그대로 쓴다.
assert.match(timed, /data-org-phase="work"[\s\S]*?claude-opus-5 · high/u);
// 세션 한도 소모 = 잔여의 감소분(90 → 77.5 = 12.5%p). 변화가 없는 원본(Claude 4→4)은
// 적지 않고, null 이벤트는 0으로 세지 않는다.
assert.match(timed, /소모 Codex 12\.5%p/u);
assert.doesNotMatch(timed, /Claude \d/u);
assert.doesNotMatch(timed, /한도 초기화/u);
// 서브에이전트 진행도는 payload의 60%가 아니라 이벤트의 최신 41%다.
assert.match(timed, /data-actor-id="work:calc"[\s\S]*?<strong>41%<\/strong>/u);

// ---- 세션 탭 쪽 표기 ------------------------------------------------------
const activeView = renderers.renderSessionView(tasks, NOW, 'active');
assert.doesNotMatch(activeView, /\(08-27\)/u);
assert.match(activeView, /작업 60%[\s\S]*<time class="h-task-date" datetime="2026-08-27">08\.27<\/time>/u);

console.log('FULL PIPELINE ORG E2E: PASS');
