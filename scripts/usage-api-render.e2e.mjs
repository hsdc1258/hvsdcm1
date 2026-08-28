// 관제탑 통합 E2E — **실제 Worker `GET /api/usage` 응답을 실제 렌더러에 통과시킨다.**
//
// 왜 있는가 (review 기능 B, 테스트 실효성)
//   기능 B의 단위 테스트는 title·input·health·3상태를 fixture에 **직접 주입**한다. 그래서
//   Worker가 그 필드를 하나도 공급하지 않아도 전부 통과한다 — 리뷰가 잡은 그대로,
//   "화면은 맞고 서버는 안 보내는" 상태가 초록불로 지나간다. 실제로 그 상태가 한 번
//   있었다(기능 A worker 커밋이 main에 없던 구간).
//
//   여기서는 그 사슬을 끊는다. fixture는 **보고자가 보내는 입력**뿐이고, 화면이 읽는
//   값은 전부 다음 경로를 실제로 지나온 것이다:
//     실제 SQLite(마이그레이션 0001~0009 적용)
//       → worker POST /api/usage/report · POST /api/harness/report (실제 라우터)
//       → worker GET /api/usage (실제 조회·hydration·파생)
//       → usage.js 렌더러 (실제 마크업)
//   그래서 Worker가 필드를 빼거나 이름을 바꾸면 화면 검사가 즉시 빨간불이 된다.
//
// 무엇을 잠그는가
//   (1) title — 지정 제목이 name과 **글자까지 같아도** 카드 제목이 한 글자도 바뀌지 않는다
//       (review 기능 B M-2). 값이 아니라 Worker가 실은 출처 플래그가 근거다.
//   (2) input — 보고가 실은 요청 원문이 상세에 그대로 서고, 한 화면에 한 번만 난다.
//   (3) 3상태 — active / stale(하트비트 끊김, Worker가 파생) / complete가 각자 탭으로 갈린다.
//   (4) health — source별 마지막 성공·시도·결과가 조회 응답에 실리고 화면이 그것으로 판정한다.
//
// 이 검사가 **못 보는 것**: 실제 Cloudflare D1의 방언 차이와 인증 계층의 세부(여기서는
//   실제 sessions 행을 넣어 실제 authenticate()를 지난다), DOM 이벤트 배선, 시각 조판.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import worker from '../worker/src/index.js';
import { sha256 } from '../worker/src/lib.js';
import { createUsageRenderers } from './render-sandbox.mjs';

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, 'worker', 'migrations');
const OWNER_TOKEN = 'owner-integration-token';
const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW - offsetMs).toISOString();

// ---- D1 얇은 shim ---------------------------------------------------------
//
// D1의 계약 중 이 경로가 쓰는 것만 옮긴다: prepare→bind→(first|all|run)과 batch.
// batch는 **한 연결에서 순서대로** 실행돼야 한다 — harness_events의 `WHERE changes() > 0`이
// 바로 앞 UPSERT의 changes()를 읽기 때문이다(D1도 batch를 한 트랜잭션으로 순서 실행한다).
function d1(database) {
  const statement = (sql, values = []) => ({
    bind(...next) { return statement(sql, next); },
    async first() {
      const row = database.prepare(sql).get(...values);
      return row === undefined ? null : row;
    },
    async all() {
      return { results: database.prepare(sql).all(...values), success: true };
    },
    async run() {
      const result = database.prepare(sql).run(...values);
      return {
        success: true,
        meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
      };
    },
  });
  return {
    prepare(sql) { return statement(sql); },
    async batch(statements) {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
  };
}

function createEnv() {
  const database = new DatabaseSync(':memory:');
  // 스키마를 손으로 적지 않는다 — 실제 마이그레이션을 그대로 적용한다. 그래야 컬럼이
  // 하나 늘거나 이름이 바뀔 때 이 검사가 같이 움직인다 (LESSONS "단일 원본 자동 도출").
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    database.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }
  return {
    database,
    env: {
      ALLOWED_ORIGIN: 'https://example.test',
      OWNER_USERNAME: 'hvsdcm',
      HARNESS_INGEST_TOKEN: 'harness-token',
      USAGE_INGEST_TOKEN: 'usage-token',
      DB: d1(database),
    },
  };
}

// 실제 authenticate()를 지나게 한다 — 소유자 판정(isOwnerSession)까지 진짜 경로다.
async function seedOwnerSession(database) {
  // 시각 축은 lib.js의 now()와 같은 **밀리초**다. 초로 적으면 만료 비교가 조용히
  // 어긋나 401이 되고, 그 401은 계약 위반이 아니라 이 fixture의 버그다.
  database.prepare(`
    INSERT INTO users(id, username, password_hash, password_salt, created_at, disabled)
    VALUES (1, 'hvsdcm', 'x', 'y', ?, 0)
  `).run(NOW);
  database.prepare(`
    INSERT INTO sessions(token_hash, user_id, role, created_at, expires_at, last_seen_at)
    VALUES (?, 1, 'user', ?, ?, ?)
  `).run(await sha256(OWNER_TOKEN), NOW, NOW + 86_400_000, NOW);
}

const post = (env, path_, token, body) => worker.fetch(new Request(`https://api.test${path_}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}), env);

// ---- 보고자가 보내는 입력 (이 파일의 유일한 fixture) -----------------------

const actor = (id, name, status = 'working') => ({
  id, parent_id: '', name, kind: 'codex', model: 'gpt-5.6-sol', reasoning: 'xhigh',
  role: '기획 · 통합 · 최종 판정', status, assignment: '통합', progress: 60,
});

const report = (taskId, overrides = {}) => ({
  version: 1,
  task_id: taskId,
  occurred_at: iso(0),
  task: {
    name: taskId,
    phase: 'work',
    progress: 60,
    status: 'active',
    model: 'gpt-5.6-sol',
    reasoning: 'xhigh',
    category_key: 'pipeline-visualization',
    category: '파이프라인 시각화',
    current: '구현',
    done: '계약 고정',
    next: '리뷰',
    deadline: '',
    ...overrides.task,
  },
  actors: overrides.actors || [actor(`${taskId}:main`, 'Main Codex')],
  modules: [],
  artifacts: [],
  ...(overrides.occurred_at ? { occurred_at: overrides.occurred_at } : {}),
});

const { database, env } = createEnv();
await seedOwnerSession(database);

// (1) 지정 제목이 name과 **글자까지 같은** 세션. 값만으로는 파생 이름과 구별되지 않는다.
const AUTHORED = 'WP2 관제탑 (08-29)';
const REQUEST_TEXT = '완료된 파이프라인 목록을 게시글형으로 바꾸고\n한도 신선도를 보여 줘';
assert.equal((await post(env, '/api/harness/report', 'harness-token', report('wp2', {
  task: { name: AUTHORED, title: AUTHORED, input: REQUEST_TEXT },
  actors: [actor('wp2:main', 'Main Codex')],
}))).status, 200);

// (2) 하트비트가 끊긴 세션. **화면이 시간을 재지 않는다** — Worker가 stale로 파생해 준다.
assert.equal((await post(env, '/api/harness/report', 'harness-token', report('stalled', {
  task: { name: '멎은 세션', heartbeat_at: iso(60 * 60 * 1000) },
  actors: [actor('stalled:main', '멎은 Main')],
  occurred_at: iso(60 * 60 * 1000),
}))).status, 200);

// (3) 완료 세션.
assert.equal((await post(env, '/api/harness/report', 'harness-token', report('finished', {
  task: { name: '끝난 세션', status: 'complete', phase: 'done', progress: 100 },
  actors: [actor('finished:main', '끝난 Main', 'done')],
}))).status, 200);

// (4) 실제 한도 수집 보고 두 건 — usage_snapshots와 usage_source_health를 함께 채운다.
assert.equal((await post(env, '/api/usage/report', 'usage-token', {
  source: 'codex',
  captured_at: iso(2 * 60 * 1000),
  payload: { model: 'gpt-5.6-codex', plan_type: 'pro', rate_limits: { primary: { used_percent: 24 } } },
})).status, 200);
assert.equal((await post(env, '/api/usage/report', 'usage-token', {
  source: 'claude',
  captured_at: iso(3 * 60 * 1000),
  payload: { models: { 'claude-opus-5': { captured_at: iso(3 * 60 * 1000), rate_limits: { five_hour: { used_percentage: 35 } } } } },
})).status, 200);

// ---- 실제 조회 응답 -------------------------------------------------------

const response = await worker.fetch(new Request('https://api.test/api/usage', {
  headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'cf-connecting-ip': '198.51.100.1' },
}), env);
assert.equal(response.status, 200);
const payload = await response.json();

// 응답 자체가 계약을 싣고 있는지 먼저 본다 — 화면이 옳아도 서버가 안 보내면 이 줄이 잡는다.
const byId = new Map(payload.tasks.map((task) => [task.id, task]));
assert.equal(byId.size, 3, 'owner 조회가 세 세션을 모두 돌려줘야 한다');
assert.equal(byId.get('wp2').title, AUTHORED);
assert.equal(byId.get('wp2').title_authored, true, 'Worker가 제목의 출처를 실어야 화면이 구별할 수 있다');
assert.equal(byId.get('wp2').input, REQUEST_TEXT);
assert.equal(byId.get('wp2').status, 'active');
assert.equal(byId.get('stalled').status, 'stale', 'Worker가 하트비트 끊김을 stale로 파생해야 한다');
assert.equal(byId.get('finished').status, 'complete');
const health = Object.fromEntries(payload.snapshots.map((row) => [row.source, row]));
assert.equal(health.codex.last_outcome, 'success');
assert.ok(health.codex.last_success_at, 'health 행이 마지막 성공 시각을 실어야 한다');
assert.ok(health.claude.last_attempt_at);

// ---- 그 응답을 실제 렌더러에 통과시킨다 -----------------------------------

const renderers = createUsageRenderers();

// (1) title — 지정 제목이 name과 같아도 카드 제목은 그대로다. 약어 확장도, 날짜 꼬리
//     제거도 걸리지 않는다 (review 기능 B M-2의 반례가 실제 응답으로 재현된 것).
assert.equal(renderers.taskPresentation(byId.get('wp2')).name, AUTHORED);
const activeMarkup = renderers.renderSessionView(payload.tasks, NOW, 'active', 'org');
assert.match(activeMarkup, /WP2 관제탑 \(08-29\)/u);
assert.doesNotMatch(activeMarkup, /작업 묶음 2/u);

// (2) input — 보고 원문이 상세에 그대로 서고, 한 화면에 한 번만 난다 (review-visual M4).
assert.match(activeMarkup, /<section class="h-task-input"[\s\S]*?완료된 파이프라인 목록을 게시글형으로/u);
assert.equal((activeMarkup.match(/완료된 파이프라인 목록을 게시글형으로/gu) || []).length, 1);

// (3) 3상태 — 세 세션이 각자 탭으로 갈리고, 개수도 같은 판정에서 나온다.
const views = renderers.renderSessionViews(payload.tasks, NOW);
for (const [view, count] of [['active', 1], ['stale', 1], ['complete', 1]]) {
  assert.match(views, new RegExp(`data-session-view="${view}"[^>]*>[\\s\\S]*?data-view-count="${count}"`, 'u'));
}
assert.doesNotMatch(activeMarkup, /멎은 세션|끝난 세션/u);
assert.match(renderers.renderSessionView(payload.tasks, NOW, 'stale'), /멎은 세션/u);
assert.match(renderers.renderSessionView(payload.tasks, NOW, 'complete'), /끝난 세션/u);

// (4) health — 2분 전에 성공한 원본은 고장이 아니고, 그 판정이 화면에 그대로 선다.
const dashboard = renderers.buildDashboard(payload, NOW);
assert.match(dashboard, /Codex 한도/u);
assert.match(dashboard, /마지막 수집 성공<\/dt><dd>2분 전<\/dd>/u);
assert.match(dashboard, /마지막 시도<\/dt><dd>2분 전 · 성공<\/dd>/u);
assert.doesNotMatch(dashboard, /us-health is-breached/u);
assert.match(dashboard, /24%/u);
assert.match(dashboard, /35%/u);

database.close();
console.log('USAGE API → RENDER E2E: PASS');
