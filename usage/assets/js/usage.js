(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;
  const STALE_MS = 24 * 60 * 60 * 1000;
  const WARN_PERCENT = 75;
  const OVER_PERCENT = 95;
  const PHASES = [
    { key: 'plan', label: '구상' },
    { key: 'work', label: '작업' },
    { key: 'review', label: '검토' },
    { key: 'done', label: '완료' },
  ];
  const BUCKET_LABELS = { primary: '5시간', secondary: '주간' };
  const ACTOR_KIND_LABELS = { codex: 'CODEX', webgpt: 'WEBGPT' };
  const ACTOR_STATUS_LABELS = {
    working: '작업 중', reviewing: '검토 중', waiting: '대기',
    done: '완료', blocked: '막힘', unavailable: '사용 불가',
  };

  const elements = {
    body: document.getElementById('usageBody'),
    error: document.getElementById('usageError'),
    reload: document.getElementById('reload'),
  };
  let selectedTaskId = '';

  function loginPath() {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return `/?login=1&next=${next}`;
  }

  if (!localStorage.getItem('hvsdcm.token')) {
    location.replace(loginPath());
    return;
  }

  const escapeHtml = (value) => String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character],
  );

  async function api(path) {
    const response = await fetch(`${API_URL}${path}`, {
      headers: { authorization: `Bearer ${localStorage.getItem('hvsdcm.token') || ''}` },
    });
    if (response.status === 401) {
      localStorage.removeItem('hvsdcm.token');
      location.replace(loginPath());
      throw new Error('unauthorized');
    }
    if (response.status === 404 || response.status === 403) {
      location.replace('/');
      throw new Error('unauthorized');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '사용량을 불러오지 못했습니다.');
    return data;
  }

  function readPercent(bucket) {
    if (!bucket || typeof bucket !== 'object') return null;
    for (const [key, value] of Object.entries(bucket)) {
      if (/^used_percent/u.test(key) && Number.isFinite(value)) return value;
    }
    return null;
  }

  function clampPercent(value) {
    return Math.min(100, Math.max(0, value));
  }

  function formatDuration(milliseconds) {
    const minutes = Math.round(milliseconds / 60_000);
    if (minutes < 1) return '1분 미만';
    if (minutes < 60) return `${minutes}분`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      const restMinutes = minutes % 60;
      return restMinutes ? `${hours}시간 ${restMinutes}분` : `${hours}시간`;
    }
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours ? `${days}일 ${restHours}시간` : `${days}일`;
  }

  function parseTime(value) {
    const time = Date.parse(String(value ?? ''));
    return Number.isFinite(time) ? time : null;
  }

  function relativeTime(value, now) {
    const time = parseTime(value);
    if (time === null) return null;
    return time <= now ? `${formatDuration(now - time)} 전` : `${formatDuration(time - now)} 후`;
  }

  function groupsOf(payload) {
    if (!payload || typeof payload !== 'object') return [];
    if (!payload.rate_limits || typeof payload.rate_limits !== 'object') return [];
    return [{ label: payload.model || null, buckets: payload.rate_limits }];
  }

  function bucketsOf(group) {
    if (!group.buckets || typeof group.buckets !== 'object') return [];
    return Object.entries(group.buckets)
      .filter(([, bucket]) => bucket && typeof bucket === 'object')
      .map(([key, bucket]) => ({
        key,
        label: BUCKET_LABELS[key] || key,
        percent: readPercent(bucket),
        resetsAt: bucket.resets_at,
        windowMinutes: Number.isFinite(bucket.window_minutes) ? bucket.window_minutes : null,
      }));
  }

  function renderQuotaRow(bucket, now) {
    const hasPercent = bucket.percent !== null;
    const percent = hasPercent ? clampPercent(bucket.percent) : 0;
    const tone = percent >= OVER_PERCENT ? ' is-over' : percent >= WARN_PERCENT ? ' is-warn' : '';
    const reset = relativeTime(bucket.resetsAt, now);
    const sub = reset
      ? `${reset} 초기화`
      : bucket.windowMinutes
        ? `${formatDuration(bucket.windowMinutes * 60_000)} 창`
        : '';
    return `
      <div class="list-row">
        <span class="list-row-body">
          <span class="list-row-title">${escapeHtml(bucket.label)}</span>
          ${hasPercent
    ? `<span class="gauge-track" aria-hidden="true"><span class="gauge-fill${tone}" style="width: ${percent.toFixed(1)}%"></span></span>`
    : ''}
          ${sub ? `<span class="list-row-sub">${escapeHtml(sub)}</span>` : ''}
        </span>
        <span class="list-row-value">${hasPercent ? `${Math.round(percent)}%` : '기록 없음'}</span>
      </div>`;
  }

  function renderQuota(snapshot, now) {
    const capturedTime = parseTime(snapshot.captured_at);
    const captured = relativeTime(snapshot.captured_at, now);
    const stale = capturedTime !== null && now - capturedTime > STALE_MS;
    const groups = groupsOf(snapshot.payload).map((group) => {
      const buckets = bucketsOf(group);
      if (buckets.length === 0) return '';
      return `
        <div class="us-group">
          ${group.label ? `<p class="list-group-head">${escapeHtml(group.label)}</p>` : ''}
          <div class="list-group is-inset">${buckets.map((bucket) => renderQuotaRow(bucket, now)).join('')}</div>
        </div>`;
    }).join('');
    return `
      <article class="card us-quota-card">
        <header class="us-card-head">
          <div><p class="us-eyebrow">CODEX LIMIT</p><h3 class="title-3">Codex</h3></div>
          <span class="us-card-meta">${captured ? escapeHtml(`${captured} 수집`) : '수집 시각 없음'}${stale ? ' · 오래된 데이터' : ''}</span>
        </header>
        ${groups || '<p class="us-empty">읽을 수 있는 Codex 한도 정보가 없습니다.</p>'}
      </article>`;
  }

  function taskActors(task) {
    return Array.isArray(task?.actors)
      ? task.actors.filter((actor) => actor && typeof actor === 'object')
      : [];
  }

  function mainActorOf(task) {
    const actors = taskActors(task);
    return actors.find((actor) => !actor.parent_id) || actors[0] || {
      id: `${task.id || 'task'}:main`,
      name: 'Main Codex',
      kind: 'codex',
      model: task.model || '모델 미기록',
      reasoning: task.reasoning || '',
      role: '기획 · 통합 · 최종 판정',
      status: task.status === 'complete' ? 'done' : 'working',
      assignment: task.current || '',
    };
  }

  function actorStatus(actor) {
    return ACTOR_STATUS_LABELS[actor.status] || actor.status || '상태 미기록';
  }

  function modelAndReasoning(model, reasoning) {
    const modelLabel = model || '모델 미기록';
    return reasoning ? `${modelLabel} · ${reasoning}` : modelLabel;
  }

  function renderActor(actor, isMain = false) {
    const warn = ['blocked', 'unavailable', 'waiting'].includes(actor.status);
    return `
      <article class="h-actor${isMain ? ' is-main' : ''}${actor.kind === 'webgpt' ? ' is-webgpt' : ''}">
        <header class="h-actor-head">
          <span class="h-kind">${isMain ? 'MAIN' : escapeHtml(ACTOR_KIND_LABELS[actor.kind] || actor.kind || 'AGENT')}</span>
          <span class="h-actor-state"><span class="status-dot${warn ? ' is-warn' : ''}" aria-hidden="true"></span>${escapeHtml(actorStatus(actor))}</span>
        </header>
        <h4>${escapeHtml(actor.name || '이름 미기록')}</h4>
        <p class="h-model">${escapeHtml(modelAndReasoning(actor.model, actor.reasoning))}</p>
        ${actor.role ? `<p class="h-role">${escapeHtml(actor.role)}</p>` : ''}
        ${actor.assignment ? `<p class="h-assignment">${escapeHtml(actor.assignment)}</p>` : ''}
      </article>`;
  }

  function renderPhaseRail(task) {
    const foundIndex = PHASES.findIndex((phase) => phase.key === task.phase);
    const currentIndex = foundIndex < 0 ? 0 : foundIndex;
    return `
      <ol class="h-phase-rail" aria-label="파이프라인 gate">
        ${PHASES.map((phase, index) => {
    const state = index < currentIndex || task.status === 'complete'
      ? ' is-complete'
      : index === currentIndex
        ? ' is-current'
        : '';
    return `<li class="h-phase${state}"><span class="h-phase-index">${index + 1}</span><span>${phase.label}</span></li>`;
  }).join('')}
      </ol>`;
  }

  function renderGate(task) {
    const progress = clampPercent(Number(task.progress) || 0);
    const phase = PHASES.find((item) => item.key === task.phase)?.label || task.phase || '미기록';
    return `
      <section class="h-session-status" aria-label="선택한 세션 상태">
        <div class="h-session-progress">
          <div><p class="us-eyebrow">CURRENT GATE</p><strong>${escapeHtml(phase)} · ${Math.round(progress)}%</strong></div>
          <span class="gauge-track" aria-hidden="true"><span class="gauge-fill" style="width: ${progress.toFixed(1)}%"></span></span>
        </div>
        <div class="h-session-facts">
          <p><span>현재</span>${escapeHtml(task.current || '상태 보고 대기')}</p>
          <p><span>다음</span>${escapeHtml(task.next || '아직 없음')}</p>
          <p><span>완료</span>${escapeHtml(task.done || '아직 없음')}</p>
        </div>
      </section>`;
  }

  function renderArtifacts(task) {
    const artifacts = Array.isArray(task.artifacts) ? task.artifacts.filter(Boolean) : [];
    return `
      <footer class="h-evidence">
        <span class="h-evidence-label">검증 ARTIFACT</span>
        <div class="h-evidence-list">
          ${artifacts.length > 0
    ? artifacts.map((artifact) => `<span>${escapeHtml(artifact)}</span>`).join('')
    : '<span class="is-empty">아직 보고된 artifact가 없습니다.</span>'}
        </div>
      </footer>`;
  }

  function actorHierarchy(task, mainActor) {
    const actors = taskActors(task).filter((actor) => actor.id !== mainActor.id);
    const byId = new Map([[mainActor.id, mainActor], ...actors.map((actor) => [actor.id, actor])]);
    const children = new Map();
    for (const actor of actors) {
      let parentId = actor.parent_id;
      let cursor = parentId;
      let connected = false;
      const ancestry = new Set([actor.id]);
      while (cursor) {
        if (cursor === mainActor.id) {
          connected = true;
          break;
        }
        if (ancestry.has(cursor)) break;
        ancestry.add(cursor);
        cursor = byId.get(cursor)?.parent_id || '';
      }
      if (!connected) parentId = mainActor.id;
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(actor);
    }
    return children;
  }

  function renderActorBranch(actor, children, isMain = false, visited = new Set()) {
    if (visited.has(actor.id)) return '';
    const nextVisited = new Set(visited).add(actor.id);
    const descendants = (children.get(actor.id) || [])
      .map((child) => renderActorBranch(child, children, false, nextVisited))
      .filter(Boolean);
    return `
      <li class="h-org-node${isMain ? ' is-root' : ''}">
        ${renderActor(actor, isMain)}
        ${descendants.length > 0 ? `<ul>${descendants.join('')}</ul>` : ''}
      </li>`;
  }

  function renderActorTree(task, mainActor) {
    const children = actorHierarchy(task, mainActor);
    const actorCount = taskActors(task).length || 1;
    return `
      <section class="h-org-chart" aria-label="${escapeHtml(task.name || '작업')} 보고 조직도">
        <header class="h-org-chart-head">
          <div><p class="us-eyebrow">REPORTING LINE</p><h4>담당 조직도</h4></div>
          <span>${actorCount}명 투입</span>
        </header>
        <div class="h-org-scroll">
          <ul class="h-org-tree">${renderActorBranch(mainActor, children, true)}</ul>
        </div>
      </section>`;
  }

  function renderTask(task, now) {
    const mainActor = mainActorOf(task);
    const updated = relativeTime(task.updated_at, now);
    const complete = task.status === 'complete';
    const category = task.category || '기타 Codex 작업';
    return `
      <article class="card h-task${complete ? ' is-complete' : ''}">
        <header class="h-task-head">
          <div>
            <p class="us-eyebrow">${complete ? 'COMPLETED PIPELINE' : 'LIVE PIPELINE'}</p>
            <h3>${escapeHtml(task.name || '이름 없는 작업')}</h3>
            <p>${updated ? escapeHtml(`${updated} 동기화`) : '동기화 시각 없음'}${task.deadline ? ` · 마감 ${escapeHtml(task.deadline)}` : ''}</p>
          </div>
          <div class="h-task-badges">
            <span class="h-category-chip">${escapeHtml(category)}</span>
            <span class="h-task-state"><span class="status-dot${complete ? '' : ' is-warn'}" aria-hidden="true"></span>${complete ? '완료' : '진행 중'}</span>
          </div>
        </header>
        ${renderPhaseRail(task)}
        ${renderGate(task)}
        ${renderActorTree(task, mainActor)}
        ${renderArtifacts(task)}
      </article>`;
  }

  function taskCategory(task) {
    return {
      key: task.category_key || 'general',
      label: task.category || '기타 Codex 작업',
    };
  }

  function renderTaskTabs(tasks, now) {
    const selectedIndex = Math.max(0, tasks.findIndex((task) => task.id === selectedTaskId));
    return `
      <div class="h-session-switcher">
        <div class="h-session-tabs" role="tablist" aria-label="병렬 Codex 세션">
          ${tasks.map((task, index) => {
    const selected = index === selectedIndex;
    const category = taskCategory(task);
    const phase = PHASES.find((item) => item.key === task.phase)?.label || task.phase || '미기록';
    const progress = Math.round(clampPercent(Number(task.progress) || 0));
    return `
            <button class="h-session-tab${selected ? ' is-selected' : ''}" type="button" role="tab"
              id="hSessionTab${index}" aria-controls="hSessionPanel${index}" aria-selected="${selected}"
              tabindex="${selected ? '0' : '-1'}" data-task-tab="${index}" data-task-id="${escapeHtml(task.id || String(index))}">
              <span class="h-session-tab-state status-dot${task.status === 'complete' ? '' : ' is-warn'}" aria-hidden="true"></span>
              <span class="h-session-tab-copy">
                <strong>${escapeHtml(task.name || '이름 없는 세션')}</strong>
                <span>${escapeHtml(category.label)} · ${escapeHtml(phase)} ${progress}%</span>
              </span>
            </button>`;
  }).join('')}
        </div>
        <div class="h-session-panels">
          ${tasks.map((task, index) => {
    const selected = index === selectedIndex;
    return `
            <section class="h-session-panel" role="tabpanel" id="hSessionPanel${index}"
              aria-labelledby="hSessionTab${index}" data-task-panel="${index}"${selected ? '' : ' hidden'}>
              ${renderTask(task, now)}
            </section>`;
  }).join('')}
        </div>
      </div>`;
  }

  function renderSummary(snapshots, tasks, now) {
    const codexBuckets = snapshots.flatMap((snapshot) => groupsOf(snapshot.payload))
      .flatMap((group) => bucketsOf(group));
    const percents = codexBuckets.map((bucket) => bucket.percent).filter((value) => value !== null);
    const activeTasks = tasks.filter((task) => task.status !== 'complete');
    const categoryCount = new Set(tasks.map((task) => taskCategory(task).key)).size;
    const activeActors = activeTasks.flatMap((task) => taskActors(task))
      .filter((actor) => !['done', 'unavailable'].includes(actor.status));
    const currentTask = activeTasks[0] || tasks[0];
    const currentPhase = PHASES.find((phase) => phase.key === currentTask?.phase)?.label || '—';
    const latestTimes = [
      ...snapshots.map((snapshot) => parseTime(snapshot.captured_at)),
      ...tasks.map((task) => parseTime(task.updated_at)),
    ].filter((time) => time !== null);
    const latest = latestTimes.length > 0 ? Math.max(...latestTimes) : null;
    const cells = [
      ['동기화', `<span class="stat-state"><span class="status-dot" aria-hidden="true"></span>${latest === null ? '대기' : escapeHtml(relativeTime(new Date(latest).toISOString(), now))}</span>`],
      ['활성 작업', `<span class="stat-value">${activeTasks.length}</span>`],
      ['작업 카테고리', `<span class="stat-value">${categoryCount}</span>`],
      ['작업 중 AI', `<span class="stat-value">${activeActors.length}</span>`],
      ['현재 gate', `<span class="stat-value">${escapeHtml(currentPhase)}</span>`],
      ['Codex 최고 사용률', `<span class="stat-value">${percents.length === 0 ? '—' : `${Math.round(clampPercent(Math.max(...percents)))}%`}</span>`],
    ];
    return `<div class="summary-strip">${cells.map(([label, value]) => `
      <div class="summary-cell"><span class="stat-label">${escapeHtml(label)}</span>${value}</div>`).join('')}</div>`;
  }

  function buildDashboard(input, now) {
    const rawSnapshots = Array.isArray(input) ? input : input?.snapshots;
    const rawTasks = Array.isArray(input?.tasks) ? input.tasks : [];
    const snapshots = (Array.isArray(rawSnapshots) ? rawSnapshots : [])
      .filter((snapshot) => snapshot?.source === 'codex');
    const tasks = rawTasks.filter((task) => task && typeof task === 'object')
      .sort((left, right) => {
        if (left.status !== right.status) return left.status === 'active' ? -1 : 1;
        return (parseTime(right.updated_at) || 0) - (parseTime(left.updated_at) || 0);
      });
    return [
      renderSummary(snapshots, tasks, now),
      `<section class="us-section" aria-labelledby="harnessTitle">
        <header class="us-section-head">
          <div><p class="us-eyebrow">AI BUREAU</p><h2 id="harnessTitle" class="title-2">실행 조직도</h2></div>
          <p>Discord와 같은 보고 이벤트로 갱신됩니다.</p>
        </header>
        <div class="h-session-list">${tasks.length > 0
    ? renderTaskTabs(tasks, now)
    : '<p class="us-empty card">아직 동기화된 파이프라인이 없습니다.</p>'}</div>
      </section>`,
      `<section class="us-section" aria-labelledby="quotaTitle">
        <header class="us-section-head">
          <div><p class="us-eyebrow">ACCOUNT LIMIT</p><h2 id="quotaTitle" class="title-2">Codex 사용량</h2></div>
          <p>계정에서 수집된 실제 한도만 표시합니다.</p>
        </header>
        <div class="us-quota-list">${snapshots.length > 0
    ? snapshots.map((snapshot) => renderQuota(snapshot, now)).join('')
    : '<p class="us-empty card">아직 수집된 Codex 사용량 기록이 없습니다.</p>'}</div>
      </section>`,
    ].join('');
  }

  function activateTaskTab(root, tab, moveFocus = false) {
    if (!root || !tab) return;
    const tabs = [...root.querySelectorAll('[data-task-tab]')];
    const panels = [...root.querySelectorAll('[data-task-panel]')];
    for (const item of tabs) {
      const selected = item === tab;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.taskPanel !== tab.dataset.taskTab;
    selectedTaskId = tab.dataset.taskId || '';
    if (moveFocus) tab.focus();
  }

  function wireTaskTabs(root) {
    const tablist = root?.querySelector('[role="tablist"]');
    if (!tablist) return;
    tablist.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-task-tab]');
      if (tab && tablist.contains(tab)) activateTaskTab(root, tab);
    });
    tablist.addEventListener('keydown', (event) => {
      const tabs = [...tablist.querySelectorAll('[data-task-tab]')];
      const current = event.target.closest('[data-task-tab]');
      const index = tabs.indexOf(current);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activateTaskTab(root, tabs[next], true);
    });
  }

  async function load() {
    elements.error.textContent = '';
    elements.reload.disabled = true;
    try {
      const data = await api('/api/usage');
      elements.body.innerHTML = buildDashboard(data, Date.now());
      wireTaskTabs(elements.body);
    } catch (error) {
      if (error.message === 'unauthorized') return;
      elements.body.innerHTML = '';
      elements.error.textContent = error.message || '사용량을 불러오지 못했습니다.';
    } finally {
      elements.reload.disabled = false;
    }
  }

  elements.reload.addEventListener('click', load);
  load();
  window.USAGE_RENDER = { buildDashboard, activateTaskTab, wireTaskTabs };
})();
