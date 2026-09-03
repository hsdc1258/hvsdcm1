import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { renderUsageDashboard } from './render-sandbox.mjs';

const NOW = Date.parse('2026-09-01T06:00:00.000Z');

function dashboard(input) {
  return renderUsageDashboard(input, NOW);
}

function task(overrides = {}) {
  return {
    version: 1,
    id: 'session-1',
    name: '대시보드 정리',
    title: '대시보드 정리',
    status: 'active',
    phase: 'work',
    progress: 64,
    current: '불필요한 화면 제거',
    done: '요구 범위 확인',
    next: '테스트와 배포',
    input: '운영 화면을 가볍게 정리해라.',
    updated_at: new Date(NOW - 60_000).toISOString(),
    modules: [{ name: 'UI', owner: '작업 중', progress: 64 }],
    artifacts: ['npm test'],
    ...overrides,
  };
}

test('운영 화면은 실행 세션의 핵심 정보만 보여 주고 조직 시각화를 만들지 않는다', () => {
  const markup = dashboard({ snapshots: [], tasks: [task()] });
  assert.match(markup, /대시보드 정리/u);
  assert.match(markup, /운영 화면을 가볍게 정리해라/u);
  assert.match(markup, /현재<\/dt><dd>불필요한 화면 제거/u);
  assert.match(markup, /완료<\/dt><dd>요구 범위 확인/u);
  assert.match(markup, /다음<\/dt><dd>테스트와 배포/u);
  assert.match(markup, /npm test/u);
  assert.doesNotMatch(markup, /실행 워크트리|data-worktree|data-org-phase|h-org|wt-row/u);
});

test('진행 중·중단·완료 상태는 기존처럼 분리된다', () => {
  const markup = dashboard({
    snapshots: [],
    tasks: [
      task(),
      task({ id: 'session-2', title: '중단 작업', name: '중단 작업', status: 'stale' }),
      task({ id: 'session-3', title: '완료 작업', name: '완료 작업', status: 'complete' }),
    ],
  });
  assert.match(markup, />진행 중<\/span><strong data-view-count="1">1/u);
  assert.match(markup, />중단됨<\/span><strong data-view-count="1">1/u);
  assert.match(markup, />완료<\/span><strong data-view-count="1">1/u);
});

test('계정 한도는 0과 100을 결측값으로 오해하지 않는다', () => {
  const markup = dashboard({
    snapshots: [{
      source: 'codex',
      captured_at: new Date(NOW - 60_000).toISOString(),
      payload: {
        model: 'gpt-5.6-sol',
        rate_limits: {
          primary: { used_percent: 0 },
          secondary: { used_percentage: 100, window_minutes: 300 },
        },
      },
    }],
    tasks: [],
  });
  assert.match(markup, /width: 0\.0%/u);
  assert.match(markup, /width: 100\.0%/u);
  assert.match(markup, />Codex 5시간</u);
});

test('퇴역한 화면과 API 표면은 정적 산출물에서 제거됐다', () => {
  const html = fs.readFileSync(new URL('../usage/index.html', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../usage/assets/js/usage.js', import.meta.url), 'utf8');
  const router = fs.readFileSync(new URL('../worker/src/router.js', import.meta.url), 'utf8');

  assert.doesNotMatch(html, /viewModerator|tabModerator|viewGuide|tabGuide|조직도|모더/u);
  assert.doesNotMatch(client, /\/api\/moderator|renderModerator|renderWorktree|sessionWorktree/u);
  assert.doesNotMatch(router, /\/api\/moderator|function moderator|MODERATOR_/u);
});

test('공모전 탭과 실행 현황 탭은 유지된다', () => {
  const html = fs.readFileSync(new URL('../usage/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-usage-view="ops"/u);
  assert.match(html, /data-usage-view="competition"/u);
  assert.match(html, /id="viewOps"/u);
  assert.match(html, /id="viewCompetition"/u);
});
