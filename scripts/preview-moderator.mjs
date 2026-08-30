// 모더 뷰의 **실제 렌더러를 돌려** 정적 미리보기 한 장을 만든다.
//
// 왜 있는가: `docs/_snapshots/usage.html`은 스크립트를 걷어내고 문서를 얼린다. 모더 뷰는
// 그 스크립트가 그리므로 스냅샷에서는 통째로 비어 있고, 그래서 조판을 눈으로 볼 수단이
// 없었다. 2026-08-30에 안읽음 축을 얹을 때 이 스크립트를 임시로 만들어 썼는데, 다음에
// 모더 뷰를 고치는 사람이 같은 것을 다시 만들어야 하므로 저장소에 남긴다.
//
// 산출물은 `.preview/`(gitignore)에 쓴다. 게이트가 아니라 눈으로 보기 위한 도구다.
//
//   node scripts/preview-moderator.mjs [출력경로]
import fs from 'node:fs';
import path from 'node:path';
import { createUsageRenderers } from './render-sandbox.mjs';

const NOW = Date.parse('2026-08-30T06:00:00.000Z');
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const renderers = createUsageRenderers();

const item = (over = {}) => ({
  item_id: 'item_a1', kind: 'important', status: 'open', version: 2, seen_version: 0, unread: true,
  issue_summary: '세션 2026-08-30-파이프라인-재구축이 18분째 로그를 갱신하지 않습니다.',
  action_summary: '정지로 판단해 보고합니다. 죽이거나 되살리는 판단은 사람이 합니다.',
  proposed_command: null,
  brain_model: 'gpt-5.6-sol', brain_reasoning: 'xhigh',
  worker_model: 'gpt-5.6-codex', worker_reasoning: 'high',
  source_task_id: 'task_0mtfe8fjz_xkiuwf',
  created_at: iso(40), updated_at: iso(18), decided_at: null, events: [], ...over,
});

const command = (over = {}) => ({
  command_id: 'cmd_7fq2', source: 'direct', source_item_id: null, idempotency_key: 'direct-1',
  command_text: '12시간 넘게 갱신이 없는 세션을 정리하고 무엇을 껐는지 보고해라.',
  status: 'failed', attempts: 2, unread: true, seen_at: null,
  requested_model: 'gpt-5.6-sol', requested_reasoning: 'xhigh',
  actual_model: null, actual_reasoning: null,
  issue_summary: '정리 명령이 두 번 모두 실패했습니다.',
  action_summary: 'WebGPT 워커가 응답하지 않아 중단했습니다.',
  created_at: iso(90), updated_at: iso(70), claimed_at: iso(88), started_at: iso(87),
  completed_at: iso(70), ...over,
});

const feed = {
  brain: {
    model: 'gpt-5.6-sol', reasoning: 'xhigh', worker_model: 'gpt-5.6-codex',
    worker_reasoning: 'high', updated_at: iso(18),
  },
  active_sessions: 1,
  active_commands: 0,
  counts: {
    important: { open: 1, acknowledged: 2, resolved: 8 },
    proposal: { pending: 1, approved: 3, rejected: 8 },
    review: { done: 1 },
  },
  unread_counts: { important: 1, proposal: 1, review: 1, record: 1 },
  items: [
    item(),
    item({
      item_id: 'item_b2', kind: 'proposal', status: 'pending', version: 1,
      issue_summary: '워커가 없는 채로 대기 중인 생성 작업이 한 건 있습니다.',
      action_summary: '큐 워커를 다시 띄우자고 제안합니다.',
      proposed_command: 'node --env-file=.env tools/webgpt-companion/queue-worker.mjs',
      updated_at: iso(52),
    }),
    item({
      item_id: 'item_c3', kind: 'review', status: 'done', version: 4,
      issue_summary: '아무 세션도 돌지 않는 동안 저장소 세 곳의 작업 트리를 점검했습니다.',
      action_summary: '깨끗함. 조치할 것이 없습니다.',
      proposed_command: null, updated_at: iso(120),
    }),
  ],
  commands: [command()],
  next_cursor: null,
};

const emptyFeed = {
  ...feed, items: [], commands: [],
  unread_counts: { important: 0, proposal: 0, review: 0, record: 0 },
};

const css = ['assets/css/system.css', 'usage/assets/css/usage.css']
  .map((file) => fs.readFileSync(file, 'utf8')).join('\n');

// 사이드바는 배지가 붙는 자리이므로 미리보기에도 함께 세운다. 배지만 따로 보면 선택된
// 항목 위에서 묻히는지, 라벨을 밀어내는지 알 수 없다.
function sidebar(source, active = 'moderator') {
  const badge = renderers.moderatorBadgeState(
    ['important', 'proposal', 'review', 'record']
      .reduce((sum, key) => sum + (renderers.moderatorUnreadCounts(source)[key] || 0), 0),
  );
  const item = (key, label) => `<button class="sidebar-item${key === active ? ' is-active' : ''}" type="button">`
    + `<span class="sidebar-item-text">${label}</span>`
    + (key === 'moderator' && !badge.hidden
      ? `<span class="sidebar-item-badge">${badge.text}</span>` : '')
    + '</button>';
  return `<aside class="sidebar" aria-label="운영 화면">
      <div class="sidebar-group">
        <p class="sidebar-label">운영</p>
        ${item('ops', '실행 현황')}${item('moderator', '모더')}${item('guide', '구조')}
      </div>
    </aside>`;
}

function view(source, mode, kind, body, activeTab = 'moderator') {
  return `<div class="app-shell">${sidebar(source, activeTab)}
    <main class="app-main"><section class="us-view us-preview">
      <header class="view-head"><div class="view-head-main"><div>
        <h1 class="title-1">모더</h1><p>직접 명령, 승인 대기 제안, 상시 감시 기록</p>
      </div></div>
      <div class="toolbar-group"><span class="us-freshness">화면 갱신 3초 전 · 60초마다 자동 갱신</span>
      <button class="btn btn-secondary btn-sm" type="button">새로고침</button></div></header>
      <div class="md-brain">${renderers.renderModeratorBrain(source, NOW)}</div>
      <div class="md-filter">${renderers.renderModeratorControls(source, mode, kind)}</div>
      <div class="md-items">${body}</div>
    </section></main></div>`;
}

// renderModeratorUnread는 moderatorJustRead(모듈 내부 상태)를 읽으므로 밖에서 채울 수 없다.
// 읽은 줄의 조판만 보려는 것이므로 행 렌더러를 직접 부른다.
const readRows = `<div class="md-group-head"><h2 class="list-group-head">안읽음</h2>
    <div class="md-group-aside"><p class="md-group-count">안읽음 1건 · 손이 필요한 것 1건</p></div></div>
  <p class="md-lead">아직 보지 않았거나 손이 필요한 것만 모았습니다.</p>
  <div class="md-list">${[
    renderers.renderModeratorItem(feed.items[0], NOW, { showKind: true, read: false }),
    renderers.renderModeratorItem(feed.items[2], NOW, { showKind: true, read: true }),
    renderers.renderModeratorCommand(feed.commands[0], NOW, { showKind: true, read: true }),
  ].join('')}</div>`;

const panels = [
  ['안읽음 — 기본 화면 (분류를 가로지른 한 목록, 사이드바에 배지)',
    view(feed, 'unread', 'important', renderers.renderModeratorUnread(feed, NOW))],
  ['안읽음 — 방금 읽은 줄(2·3번째)은 흐려지되 자리를 지킨다',
    view(feed, 'unread', 'important', readRows)],
  ['안읽음 — 비었을 때 (배지도 사라진다. 이것이 목표 상태다)',
    view(emptyFeed, 'unread', 'important', renderers.renderModeratorUnread(emptyFeed, NOW))],
  ['전체 — 분류 넷은 그대로 남는다',
    view(feed, 'all', 'important', renderers.renderModeratorItems(feed, 'important', NOW))],
  ['배지 — 실행 현황을 보는 중에도 선다 (선택 안 된 항목 위)',
    view(feed, 'unread', 'important', renderers.renderModeratorUnread(feed, NOW), 'ops')],
];

// PREVIEW_PANELS=2,4 처럼 골라 볼 수 있다. 정적 스냅샷 뷰어는 긴 페이지의 아래쪽을
// 그리지 못할 때가 있어, 확인하려는 상태만 뽑아야 할 때가 있다.
const picked = String(process.env.PREVIEW_PANELS || '').trim();
const shown = picked
  ? picked.split(',').map((index) => panels[Number(index)]).filter(Boolean)
  : panels;

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>모더 뷰 미리보기</title>
<style>${css}
.us-preview { display: block; }
.preview-note { max-width: 72ch; margin: var(--space-7) 0 var(--space-3); color: var(--text-2);
  font-size: var(--fs-caption); border-top: 1px solid var(--line-faint); padding-top: var(--space-3); }
</style></head><body><div class="container-wide us-wide app-page">
${shown.map(([note, markup]) => `<p class="preview-note">${note}</p>${markup}`).join('\n')}
</div></body></html>`;

const out = process.argv[2] || '.preview/moderator.html';
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes)`);
