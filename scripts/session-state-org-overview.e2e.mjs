import assert from 'node:assert/strict';
import { createUsageRenderers } from './render-sandbox.mjs';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');

function task(id, name, status, actors = []) {
  return {
    version: 1,
    id,
    name,
    phase: status === 'complete' ? 'done' : 'work',
    progress: status === 'complete' ? 100 : 55,
    status,
    category: status === 'complete' ? '완료 fixture' : '진행 fixture',
    current: status === 'complete' ? '배포 완료' : '구현 중',
    done: status === 'complete' ? '검증 통과' : '계약 고정',
    next: status === 'complete' ? '없음' : '독립 검토',
    updated_at: status === 'complete' ? '2026-08-27T10:00:00Z' : '2026-08-27T11:00:00Z',
    actors,
  };
}

const actor = (id, name, parentId = '') => ({
  id,
  parent_id: parentId,
  name,
  kind: 'codex',
  model: 'gpt-5.6-sol',
  reasoning: 'xhigh',
  role: parentId ? '서브에이전트' : '오케스트레이터',
  status: 'done',
  assignment: 'fixture 검증',
});

const tasks = [
  task('active-alpha', '진행 Alpha', 'active', [
    actor('active-alpha:main', 'Alpha Main'),
    actor('active-alpha:calc', 'Alpha 계산 서브에이전트', 'active-alpha:main'),
  ]),
  task('active-beta', '진행 Beta', 'active', [
    actor('active-beta:main', 'Beta Main'),
  ]),
  task('complete-gamma', '완료 Gamma', 'complete', [
    actor('complete-gamma:main', 'Gamma Main'),
    actor('complete-gamma:review', 'Gamma 검토 서브에이전트', 'complete-gamma:main'),
    { ...actor('complete-gamma:webgpt', 'Gamma WebGPT', 'complete-gamma:main'), kind: 'webgpt', model: 'WebGPT PRO' },
  ]),
  task('complete-delta', '완료 Delta', 'complete', []),
];

const renderers = createUsageRenderers();
assert.equal(typeof renderers.renderSessionViews, 'function', '상태 탭 renderer가 공개되어야 합니다.');
assert.equal(typeof renderers.renderSessionView, 'function', '상태별 세션 renderer가 공개되어야 합니다.');
assert.equal(typeof renderers.renderPortfolioOrg, 'function', '전체 조직도 renderer가 공개되어야 합니다.');

const views = renderers.renderSessionViews(tasks, NOW);
assert.match(views, /data-session-view="active"[^>]*>[\s\S]*?data-view-count="2"/u);
assert.match(views, /data-session-view="complete"[^>]*>[\s\S]*?data-view-count="2"/u);
assert.match(views, /data-session-view="org"[^>]*>[\s\S]*?data-view-count="4"/u);

const active = renderers.renderSessionView(tasks, NOW, 'active');
assert.match(active, /진행 Alpha/u);
assert.match(active, /진행 Beta/u);
assert.doesNotMatch(active, /완료 Gamma|완료 Delta/u);

const complete = renderers.renderSessionView(tasks, NOW, 'complete');
assert.match(complete, /완료 Gamma/u);
assert.match(complete, /완료 Delta/u);
assert.doesNotMatch(complete, /진행 Alpha|진행 Beta/u);

const org = renderers.renderPortfolioOrg(tasks, NOW);
for (const expected of [
  '진행 Alpha', '진행 Beta', '완료 Gamma', '완료 Delta',
  'Alpha Main', 'Alpha 계산 서브에이전트', 'Beta Main',
  'Gamma Main', 'Gamma 검토 서브에이전트', 'Gamma WebGPT',
]) {
  assert.equal((org.match(new RegExp(expected, 'gu')) || []).length, 1, `${expected}는 전체 조직도에 한 번만 있어야 합니다.`);
}
assert.equal((org.match(/data-portfolio-task=/gu) || []).length, 4);
assert.equal((org.match(/data-actor-id=/gu) || []).length, 6);
assert.match(org, /완료 Delta[\s\S]*?에이전트 보고 없음/u);
assert.match(org, /세션 4개[\s\S]*?실제 에이전트 6명/u);

console.log('SESSION STATE + PORTFOLIO ORG E2E: PASS');
