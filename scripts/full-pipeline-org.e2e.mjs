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

for (const phase of ['plan', 'work', 'review', 'done']) {
  assert.equal((org.match(new RegExp(`data-pipeline-phase="${phase}"`, 'gu')) || []).length, 1,
    `${phase} 단계는 전체 파이프라인에 한 번 있어야 합니다.`);
}
assert.match(org, /사용자 입력[\s\S]*메인 오케스트레이션[\s\S]*구상[\s\S]*작업[\s\S]*검토[\s\S]*완료/u);
assert.match(org, /data-pipeline-phase="work"[^>]*data-phase-active="true"/u);
assert.match(org, /data-portfolio-task="work-task"[^>]*data-current-work="true"/u);

for (const [phase, id] of [['plan', 'plan-task'], ['work', 'work-task'], ['review', 'review-task'], ['done', 'done-task']]) {
  assert.match(org, new RegExp(`data-pipeline-phase="${phase}"[\\s\\S]*data-portfolio-task="${id}"`, 'u'));
  assert.equal((org.match(new RegExp(`data-portfolio-task="${id}"`, 'gu')) || []).length, 1);
}

assert.equal((org.match(/data-actor-id=/gu) || []).length, 6);
assert.equal((org.match(/class="h-agent-mini(?: |")/gu) || []).length, 6);
assert.match(org, /class="h-agent-mini-tree"/u);
assert.doesNotMatch(org, /\(08-27\)/u);
assert.match(org, /작업 60%[\s\S]*<time class="h-task-date" datetime="2026-08-27">08\.27<\/time>/u);

const emptyPhaseOrg = renderers.renderPortfolioOrg([tasks[1]], NOW);
for (const phase of ['plan', 'review', 'done']) {
  assert.match(emptyPhaseOrg, new RegExp(`data-pipeline-phase="${phase}"[\\s\\S]*해당 단계 작업 없음`, 'u'));
}

const activeView = renderers.renderSessionView(tasks, NOW, 'active');
assert.doesNotMatch(activeView, /\(08-27\)/u);
assert.match(activeView, /작업 60%[\s\S]*<time class="h-task-date" datetime="2026-08-27">08\.27<\/time>/u);

console.log('FULL PIPELINE ORG E2E: PASS');
