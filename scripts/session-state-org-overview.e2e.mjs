import assert from 'node:assert/strict';
import { createUsageRenderers } from './render-sandbox.mjs';
import worker from '../worker/src/index.js';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const ACTIVE_UPDATED_AT = new Date().toISOString();

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
    updated_at: status === 'complete' ? '2026-08-27T10:00:00Z' : ACTIVE_UPDATED_AT,
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
assert.equal(typeof renderers.sessionWorktree, 'function', '워크트리 행 생성기가 공개되어야 합니다.');
assert.equal(typeof renderers.renderWorktree, 'function', '워크트리 renderer가 공개되어야 합니다.');

const views = renderers.renderSessionViews(tasks, NOW);
// 상위 탭은 세션 상태 셋(진행 중 · 중단됨 · 완료)이다. 진행 중 패널의 각 세션은 같은
// 워크트리 조판을 쓰며 별도 보기 모드는 없다.
assert.match(views, /data-session-view="active"[^>]*>[\s\S]*?data-view-count="2"/u);
assert.match(views, /data-session-view="stale"[^>]*>[\s\S]*?data-view-count="0"/u);
assert.match(views, /data-session-view="complete"[^>]*>[\s\S]*?data-view-count="2"/u);
assert.equal((views.match(/data-session-view="/gu) || []).length, 3);

const active = renderers.renderSessionView(tasks, NOW, 'active');
assert.match(active, /진행 Alpha/u);
assert.match(active, /진행 Beta/u);
assert.doesNotMatch(active, /완료 Gamma|완료 Delta/u);

const complete = renderers.renderSessionView(tasks, NOW, 'complete');
assert.match(complete, /완료 Gamma/u);
assert.match(complete, /완료 Delta/u);
assert.doesNotMatch(complete, /진행 Alpha|진행 Beta/u);

// 진행 중 패널은 **진행 중인 세션만** 그린다. 완료 세션은 사라진 것이 아니라 완료 탭으로
// 옮겨 갔을 뿐이므로, "데이터가 없어지지 않는다"는 계약은 두 화면을 합쳐 본다.
assert.equal((active.match(/data-worktree/gu) || []).length, 2,
  '진행 중 세션 2개가 각각 워크트리 하나를 가져야 합니다.');
assert.equal((active.match(/data-task-panel=/gu) || []).length, 2);
assert.doesNotMatch(active, /완료 Gamma|완료 Delta|data-active-mode/u);

// 진행 중·완료 세션의 액터는 각 상태 패널의 워크트리 행으로 나온다.
for (const expected of ['진행 Alpha', '진행 Beta']) {
  assert.match(active, new RegExp(expected, 'u'), `${expected}는 진행 중 패널에 있어야 합니다.`);
}
for (const expected of ['Alpha Main', 'Alpha 계산 서브에이전트', 'Beta Main']) {
  assert.equal((active.match(new RegExp(expected, 'gu')) || []).length, 1, `${expected} 액터 행은 한 번만 있어야 합니다.`);
}
assert.equal((active.match(/data-actor-id=/gu) || []).length, 3);

for (const expected of [
  '완료 Gamma', '완료 Delta',
  'Gamma Main', 'Gamma 검토 서브에이전트', 'Gamma WebGPT',
]) {
  assert.ok(complete.includes(expected), `${expected}는 완료 탭에 있어야 합니다.`);
}
assert.equal((complete.match(/data-actor-id=/gu) || []).length, 3);
assert.match(complete, /완료 Delta[\s\S]*?에이전트 보고 없음/u);

// 실제 owner API가 12개에서 자르지 않고 보존된 전체 task를 renderer까지 넘기는지 확인한다.
const API_NOW = Date.now();
const retainedTasks = Array.from({ length: 13 }, (_, index) => {
  const number = String(index + 1).padStart(2, '0');
  const id = `retained-${number}`;
  const retained = task(id, `보존 세션 ${number}`, index < 2 ? 'active' : 'complete', [
    actor(`${id}:main`, `보존 Main ${number}`),
  ]);
  if (retained.status !== 'active') return retained;
  const heartbeatAt = new Date(API_NOW).toISOString();
  return { ...retained, updated_at: heartbeatAt, heartbeat_at: heartbeatAt };
});
const apiEnv = {
  ALLOWED_ORIGIN: 'https://example.test',
  OWNER_USERNAME: 'hvsdcm',
  DB: {
    prepare(sql) {
      if (sql.includes('SELECT s.*, u.username')) {
        return {
          bind() {
            return { async first() { return { token_hash: 'stored-user-hash', role: 'user', disabled: 0, username: 'hvsdcm' }; } };
          },
        };
      }
      if (sql.includes('UPDATE sessions')) {
        return { bind() { return { async run() { return { success: true }; } }; } };
      }
      if (sql.includes('FROM usage_snapshots')) {
        return { bind() { return { async all() { return { results: [] }; } }; } };
      }
      // WP-A1이 붙인 이벤트 로그. 이 fixture의 task들은 구세션(이벤트 이전 payload)을
      // 흉내 내므로 빈 결과를 준다 — 프런트가 이벤트 없이도 트리를 그리는지 함께 본다.
      if (sql.includes('FROM harness_events')) {
        return { async all() { return { results: [] }; } };
      }
      if (sql.includes('FROM harness_tasks')) {
        assert.doesNotMatch(sql, /LIMIT\s+12/iu, 'owner API가 전체 조직을 12개로 잘라서는 안 됩니다.');
        return {
          async all() {
            return {
              results: retainedTasks.map((item) => ({
                task_id: item.id, status: item.status, updated_at: item.updated_at, payload: JSON.stringify(item),
              })),
            };
          },
        };
      }
      throw new Error(`Unexpected SQL in session-state E2E: ${sql}`);
    },
  },
};
const apiResponse = await worker.fetch(new Request('https://api.test/api/usage', {
  headers: { authorization: 'Bearer owner-token' },
}), apiEnv);
assert.equal(apiResponse.status, 200);
const apiPayload = await apiResponse.json();
assert.equal(apiPayload.tasks.length, 13);
// 진행 2 + 완료 11이 두 화면에 나뉘어 서고, **어느 쪽에서도 잘리지 않는다.**
// 완료 탭은 기본 10개만 펴므로(요구 6) 남은 1개는 '더 보기'가 개수로 밝힌다 —
// 접힌 것과 사라진 것을 구별하는 것이 이 검사의 요지다.
const retainedActive = renderers.renderSessionView(apiPayload.tasks, API_NOW, 'active');
assert.equal((retainedActive.match(/data-worktree/gu) || []).length, 2);
assert.equal((retainedActive.match(/data-task-panel=/gu) || []).length, 2);
assert.match(retainedActive, /보존 세션 01/u);

const retainedComplete = renderers.renderSessionView(apiPayload.tasks, API_NOW, 'complete');
assert.equal((retainedComplete.match(/data-task-post=/gu) || []).length, 10);
assert.match(retainedComplete, /남은 1개/u);
assert.match(retainedComplete, /보존 세션 03/u);

console.log('SESSION STATE + WORKTREE E2E: PASS');
