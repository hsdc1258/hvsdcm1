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
import vm from 'node:vm';

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
      COMPETITION_INGEST_TOKEN: 'competition-token',
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

// (3-b) **플래그 도입 전에 저장된 행**을 그대로 심는다 — payload에 `title_authored`가 없고
//       사람이 지정한 title이 name과 다르다. 이 행에 title 없는 후속 보고가 들어와도
//       지정 제목이 살아남아야 한다 (review 기능 B M-2-R2). 승격이 없으면 화면 제목이
//       조용히 name으로 바뀐다.
const LEGACY_NAME = '레거시 세션 (08-20)';
const LEGACY_TITLE = '관제탑 UI 개선';
database.prepare(`
  INSERT INTO harness_tasks(task_id, status, updated_at, payload) VALUES (?, 'active', ?, ?)
`).run('legacy', iso(30 * 60 * 1000), JSON.stringify({
  version: 1,
  id: 'legacy',
  name: LEGACY_NAME,
  title: LEGACY_TITLE,
  phase: 'work',
  status: 'active',
  progress: 40,
  created_at: iso(60 * 60 * 1000),
  updated_at: iso(30 * 60 * 1000),
  heartbeat_at: iso(30 * 60 * 1000),
  actors: [],
  modules: [],
  artifacts: [],
}));
assert.equal((await post(env, '/api/harness/report', 'harness-token', report('legacy', {
  task: { name: LEGACY_NAME },
  actors: [actor('legacy:main', 'Main Codex')],
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
assert.equal(byId.size, 4, 'owner 조회가 네 세션을 모두 돌려줘야 한다');
assert.equal(byId.get('wp2').title, AUTHORED);
assert.equal(byId.get('wp2').title_authored, true, 'Worker가 제목의 출처를 실어야 화면이 구별할 수 있다');
assert.equal(byId.get('wp2').input, REQUEST_TEXT);
assert.equal(byId.get('legacy').title, LEGACY_TITLE, '플래그 없던 행의 지정 제목이 무제목 보고로 사라지면 안 된다');
assert.equal(byId.get('legacy').title_authored, true, '구 행의 명시 제목은 한 번 지정으로 승격돼야 한다');
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
// 구 행의 지정 제목도 실제 마크업까지 살아 나온다 — name으로 돌아가지 않는다.
assert.match(activeMarkup, /관제탑 UI 개선/u);
assert.doesNotMatch(activeMarkup, /레거시 세션 \(08-20\)/u);

// (2) input — 보고 원문이 상세에 그대로 서고, 한 화면에 한 번만 난다 (review-visual M4).
assert.match(activeMarkup, /<section class="h-task-input"[\s\S]*?완료된 파이프라인 목록을 게시글형으로/u);
assert.equal((activeMarkup.match(/완료된 파이프라인 목록을 게시글형으로/gu) || []).length, 1);

// (3) 3상태 — 세 세션이 각자 탭으로 갈리고, 개수도 같은 판정에서 나온다.
const views = renderers.renderSessionViews(payload.tasks, NOW);
for (const [view, count] of [['active', 2], ['stale', 1], ['complete', 1]]) {
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

// ---- 공모전 TOP 10 실제 Worker → 실제 렌더러 E2E -------------------------

const competitionReport = JSON.parse(readFileSync(
  path.join(ROOT, 'scripts', 'fixtures', 'competition-report.valid.json'),
  'utf8',
));
const observedAt = new Date(NOW - 60_000).toISOString();
const startedAt = new Date(NOW - 5 * 60_000).toISOString();
const discoveredAt = new Date(NOW - 4 * 60_000).toISOString();
const verifiedAt = new Date(NOW - 3 * 60_000).toISOString();
const updatedAt = new Date(NOW - 2 * 60_000).toISOString();
const expiresAt = new Date(NOW + 10 * 60_000).toISOString();
const kstDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(NOW));
competitionReport.idempotency_key = 'competition-top10-e2e';
competitionReport.run = {
  ...competitionReport.run,
  id: competitionReport.idempotency_key,
  date: kstDate,
  started_at: startedAt,
  finished_at: observedAt,
};
competitionReport.sources[0] = {
  ...competitionReport.sources[0], checked_at: discoveredAt, candidate_count: 10,
};
const baseCandidate = competitionReport.candidates[0];
const baseApplication = competitionReport.applications[0];
competitionReport.candidates = Array.from({ length: 10 }, (_, index) => ({
  ...baseCandidate,
  contest_id: `top10-${index + 1}`,
  title: `무료 비대면 공모전 ${index + 1}`,
  discovered_at: discoveredAt,
  official_url: `https://organizer.example/rules/${index + 1}`,
  official_verified_at: verifiedAt,
  deadline_at: new Date(NOW + (index + 2) * 86_400_000).toISOString(),
  participation_mode: index < 5 ? 'none' : 'online_only',
  fit_score: 90 - index,
  effort_score: 10 + index,
}));
competitionReport.applications = competitionReport.candidates.map((candidate, index) => ({
  ...baseApplication,
  contest_id: candidate.contest_id,
  state: index === 9 ? 'WAITING_APPROVAL' : 'WAITING_RIGHTS_APPROVAL',
  blocker: index === 9 ? 'user_approval' : 'rights',
  next_action: index === 9 ? 'request_approval' : 'review_rights',
  updated_at: updatedAt,
}));
competitionReport.approvals = competitionReport.candidates.map((candidate, index) => ({
  request_id: `top10-approval-${index + 1}`,
  contest_id: candidate.contest_id,
  category: candidate.category,
  kind: index === 9 ? 'final_submission' : 'preparation',
  action_sha256: index.toString(16).padStart(64, '0'),
  requested_at: updatedAt,
  expires_at: index === 9 ? expiresAt : null,
  read_summary: `공식 공고, 무료 조건, 참여 방식과 제출본 ${index + 1}을 확인했습니다.`,
  approval_text: index === 9
    ? '표시된 계정, 파일, 입력 항목으로 최종 제출 1회를 허용합니다.'
    : '작품 초안과 비식별 서류 준비만 허용합니다.',
}));

const competitionCreated = await post(
  env, '/api/competitions/report', 'competition-token', competitionReport,
);
assert.equal(competitionCreated.status, 201);
assert.equal((await competitionCreated.json()).counts.applications, 10);
const competitionReplay = await post(
  env, '/api/competitions/report', 'competition-token', structuredClone(competitionReport),
);
assert.equal(competitionReplay.status, 200);
assert.equal((await competitionReplay.json()).counts.applications, 10);

const competitionResponse = await worker.fetch(new Request('https://api.test/api/competitions', {
  headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'cf-connecting-ip': '198.51.100.1' },
}), env);
assert.equal(competitionResponse.status, 200);
const competitionPayload = await competitionResponse.json();
assert.equal(competitionPayload.candidates.length, 10);
assert.equal(competitionPayload.applications.length, 10);
assert.equal(competitionPayload.summary.today.ready, 10);
assert.equal(competitionPayload.summary.today.awaiting_approval, 10);

const competitionContext = {
  document: { getElementById() { return null; } },
  location: { href: 'https://hvsdcm1.xyz/usage/' },
  setTimeout, clearTimeout, URL, Intl, console,
};
competitionContext.window = competitionContext;
vm.createContext(competitionContext);
vm.runInContext(
  readFileSync(path.join(ROOT, 'usage', 'assets', 'js', 'competition.js'), 'utf8'),
  competitionContext,
  { filename: 'competition.js' },
);
const competitionUi = competitionContext.COMPETITION_UI;
const normalizedCompetitions = competitionUi.normalizePayload(competitionPayload);
const competitionMarkup = competitionUi.renderDashboard(
  normalizedCompetitions,
  { fee: 'free', participation: 'none', sort: 'priority' },
  NOW,
);
assert.match(competitionMarkup, /지원 상태 보드[\s\S]*10건/u);
assert.equal((competitionMarkup.match(/class="cp-approval-card is-pending"/gu) || []).length, 10);
assert.equal((competitionMarkup.match(/승인 종류<\/dt><dd>최종 제출 승인/gu) || []).length, 1);
assert.match(competitionMarkup, /지원 비용<\/dt><dd>무료/u);
assert.match(competitionMarkup, /추가 참여<\/dt><dd>추가 일정 없음/u);
assert.match(competitionMarkup, /후보 5개/u);
const finalApproval = competitionReport.approvals[9];
const wrongApproval = await post(
  env,
  `/api/competitions/approvals/${finalApproval.request_id}/decision`,
  OWNER_TOKEN,
  { decision: 'approved', action_sha256: 'f'.repeat(64) },
);
assert.equal(wrongApproval.status, 409);
const exactApproval = await post(
  env,
  `/api/competitions/approvals/${finalApproval.request_id}/decision`,
  OWNER_TOKEN,
  { decision: 'approved', action_sha256: finalApproval.action_sha256 },
);
assert.equal(exactApproval.status, 201);
const replayedApproval = await post(
  env,
  `/api/competitions/approvals/${finalApproval.request_id}/decision`,
  OWNER_TOKEN,
  { decision: 'approved', action_sha256: finalApproval.action_sha256 },
);
assert.equal(replayedApproval.status, 200);
assert.equal(Number(database.prepare(
  "SELECT COUNT(*) AS count FROM competition_applications WHERE idempotency_key = 'competition-top10-e2e'",
).get().count), 10);
assert.equal(Number(database.prepare(
  "SELECT COUNT(*) AS count FROM competition_report_approval_requests WHERE idempotency_key = 'competition-top10-e2e'",
).get().count), 10);
assert.equal(Number(database.prepare(
  'SELECT COUNT(*) AS count FROM competition_approval_decisions',
).get().count), 1);

database.close();
console.log('USAGE + COMPETITION TOP 10 API → RENDER E2E: PASS');
