(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;
  const STALE_MS = 15 * 60 * 1000;
  const WARN_PERCENT = 75;
  const OVER_PERCENT = 95;
  const PHASES = [
    { key: 'plan', label: '구상', detail: '계약 · 증거 고정' },
    { key: 'work', label: '작업', detail: '격리 구현 · 검증' },
    { key: 'review', label: '검토', detail: '독립 반증 · 수정' },
    { key: 'done', label: '완료', detail: '배포 · 기록' },
  ];
  const ACTOR_KIND_LABELS = { codex: 'CODEX', webgpt: 'WEBGPT' };
  const ACTOR_STATUS_LABELS = {
    working: '작업 중', reviewing: '검토 중', waiting: '대기',
    done: '완료', blocked: '막힘', unavailable: '사용 불가',
  };

  const elements = {
    body: document.getElementById('usageBody'),
    error: document.getElementById('usageError'),
    reload: document.getElementById('reload'),
    refreshStatus: document.getElementById('usageRefreshStatus'),
  };
  let selectedSessionView = 'active';
  const selectedTaskIds = { active: '', complete: '' };

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
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(`${API_URL}${path}${separator}_=${Date.now()}`, {
      cache: 'no-store',
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
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 10_000_000_000 ? value * 1000 : value;
    }
    if (/^\d+(?:\.\d+)?$/u.test(String(value ?? '').trim())) {
      const numeric = Number(value);
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
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
    const plan = String(payload.plan_type || '').trim().toLowerCase();
    const planLabels = {
      pro: 'ChatGPT Pro', plus: 'ChatGPT Plus', business: 'ChatGPT Business',
      team: 'ChatGPT Team', enterprise: 'ChatGPT Enterprise', free: 'ChatGPT Free',
    };
    return [{ label: planLabels[plan] || 'Codex 계정', buckets: payload.rate_limits }];
  }

  function bucketLabel(key, windowMinutes) {
    if (windowMinutes === 300) return '5시간 사용량';
    if (windowMinutes === 10_080) return '주간 사용량';
    if (Number.isFinite(windowMinutes) && windowMinutes > 0) {
      return `${formatDuration(windowMinutes * 60_000)} 사용량`;
    }
    if (key === 'primary') return '기본 사용량';
    if (key === 'secondary') return '추가 사용량';
    return key;
  }

  function bucketsOf(group) {
    if (!group.buckets || typeof group.buckets !== 'object') return [];
    return Object.entries(group.buckets)
      .filter(([, bucket]) => bucket && typeof bucket === 'object')
      .map(([key, bucket]) => {
        const windowMinutes = Number(bucket.window_minutes);
        return {
          key,
          label: bucketLabel(key, Number.isFinite(windowMinutes) ? windowMinutes : null),
          percent: readPercent(bucket),
          resetsAt: bucket.resets_at,
          windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
        };
      });
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
      <article class="us-limit-widget">
        <header class="us-card-head">
          <div><p class="us-eyebrow">LIVE LIMIT</p><h3 class="title-3">Codex 한도</h3></div>
          <span class="us-card-meta">${captured ? escapeHtml(`${captured} 수집`) : '수집 시각 없음'}${stale ? ' · 수집 지연' : ''}</span>
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
    return actors.find((actor) => !actor.parent_id) || actors[0] || null;
  }

  function actorStatus(actor) {
    return ACTOR_STATUS_LABELS[actor.status] || actor.status || '상태 미기록';
  }

  function modelAndReasoning(model, reasoning) {
    const modelLabel = model || '모델 미기록';
    return reasoning ? `${modelLabel} · ${reasoning}` : modelLabel;
  }

  function taskPresentation(task) {
    const rawName = String(task?.name || '').trim();
    const suffix = rawName.match(/\s*\((\d{2})-(\d{2})\)\s*$/u);
    const name = (suffix ? rawName.slice(0, suffix.index).trim() : rawName) || '이름 없는 작업';
    const time = parseTime(task?.updated_at);
    const dateTime = time === null ? '' : new Date(time).toISOString().slice(0, 10);
    const dateLabel = suffix
      ? `${suffix[1]}.${suffix[2]}`
      : dateTime
        ? `${dateTime.slice(5, 7)}.${dateTime.slice(8, 10)}`
        : '';
    return { name, dateTime, dateLabel };
  }

  function renderTaskDate(task) {
    const { dateTime, dateLabel } = taskPresentation(task);
    if (!dateLabel) return '';
    return dateTime
      ? `<time class="h-task-date" datetime="${escapeHtml(dateTime)}">${escapeHtml(dateLabel)}</time>`
      : `<span class="h-task-date">${escapeHtml(dateLabel)}</span>`;
  }

  function renderActor(actor, isMain = false) {
    const warn = ['blocked', 'unavailable', 'waiting'].includes(actor.status);
    const details = [
      ['모델', modelAndReasoning(actor.model, actor.reasoning)],
      actor.role ? ['역할', actor.role] : null,
      actor.assignment ? ['현재 작업', actor.assignment] : null,
    ].filter(Boolean);
    const progress = actor.progress;
    const hasProgress = Number.isFinite(progress);
    const safeProgress = clampPercent(hasProgress ? progress : 0);
    return `
      <article class="h-actor${isMain ? ' is-main' : ''}${actor.kind === 'webgpt' ? ' is-webgpt' : ''}" data-actor-id="${escapeHtml(actor.id || '')}">
        <header class="h-actor-head">
          <span class="h-kind">${isMain ? 'MAIN' : escapeHtml(ACTOR_KIND_LABELS[actor.kind] || actor.kind || 'AGENT')}</span>
          <span class="h-actor-state"><span class="status-dot${warn ? ' is-warn' : ''}" aria-hidden="true"></span>${escapeHtml(actorStatus(actor))}</span>
        </header>
        <h4>${escapeHtml(actor.name || '이름 미기록')}</h4>
        <dl class="h-actor-details">
          ${details.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
        </dl>
        ${hasProgress ? `<div class="h-actor-progress"><span><span>진행도</span><strong>${Math.round(safeProgress)}%</strong></span><span class="gauge-track" aria-hidden="true"><span class="gauge-fill" style="width: ${safeProgress.toFixed(1)}%"></span></span></div>` : ''}
      </article>`;
  }

  function renderPhaseRail(task) {
    const foundIndex = PHASES.findIndex((phase) => phase.key === task.phase);
    const currentIndex = foundIndex < 0 ? 0 : foundIndex;
    return `
      <section class="h-flow" aria-label="실제 하네스 작업 흐름">
        <header class="h-flow-head">
          <div><p class="us-eyebrow">OVERALL</p><h4>전체 진행률</h4></div>
          <strong>${Math.round(clampPercent(Number(task.progress) || 0))}%</strong>
        </header>
        <ol class="h-phase-rail">
        ${PHASES.map((phase, index) => {
    const state = index < currentIndex || task.status === 'complete'
      ? ' is-complete'
      : index === currentIndex
        ? ' is-current'
        : '';
    return `<li class="h-phase${state}"><span class="h-phase-index">${index + 1}</span><span class="h-phase-copy"><strong>${phase.label}</strong><small>${phase.detail}</small></span></li>`;
  }).join('')}
        </ol>
      </section>`;
  }

  function taskModules(task) {
    return Array.isArray(task?.modules)
      ? task.modules.filter((module) => module && typeof module === 'object')
      : [];
  }

  function renderModules(task) {
    const modules = taskModules(task);
    if (modules.length === 0) return '';
    return `
      <section class="h-modules" aria-label="모듈별 진행도">
        <header class="h-modules-head">
          <div><p class="us-eyebrow">MODULES</p><h4>모듈별 진행도</h4></div>
          <span>보고된 작업 ${modules.length}개</span>
        </header>
        <div class="h-module-list">
          ${modules.map((module) => {
    const progress = clampPercent(Number(module.progress) || 0);
    return `<article class="h-module">
            <div class="h-module-copy"><strong>${escapeHtml(module.name || '이름 미기록')}</strong><span>${escapeHtml(module.owner || actorStatus(module))}</span></div>
            <strong class="h-module-value">${Math.round(progress)}%</strong>
            <span class="gauge-track h-module-track" aria-hidden="true"><span class="gauge-fill" style="width: ${progress.toFixed(1)}%"></span></span>
          </article>`;
  }).join('')}
        </div>
      </section>`;
  }

  function renderGate(task) {
    const progress = clampPercent(Number(task.progress) || 0);
    const phase = PHASES.find((item) => item.key === task.phase)?.label || task.phase || '미기록';
    return `
      <section class="h-session-status" aria-label="선택한 세션의 현재 gate">
        <div class="h-session-progress">
          <div><p class="us-eyebrow">CURRENT GATE</p><strong>${escapeHtml(phase)}</strong></div>
          <span class="gauge-track" aria-hidden="true"><span class="gauge-fill" style="width: ${progress.toFixed(1)}%"></span></span>
        </div>
        <div class="h-session-facts">
          <p><span>현재</span>${escapeHtml(task.current || '상태 보고 대기')}</p>
          <p><span>완료</span>${escapeHtml(task.done || '아직 없음')}</p>
          <p><span>다음</span>${escapeHtml(task.next || '아직 없음')}</p>
        </div>
      </section>`;
  }

  function renderArtifacts(task) {
    const artifacts = Array.isArray(task.artifacts) ? task.artifacts.filter(Boolean) : [];
    if (artifacts.length === 0) return '';
    return `
      <footer class="h-evidence">
        <span class="h-evidence-label">검증 ARTIFACT</span>
        <div class="h-evidence-list">
          ${artifacts.map((artifact) => `<span>${escapeHtml(artifact)}</span>`).join('')}
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
    const actorCount = taskActors(task).length;
    const tree = mainActor
      ? `<ul class="h-org-tree">${renderActorBranch(mainActor, actorHierarchy(task, mainActor), true)}</ul>`
      : '<p class="h-org-empty">에이전트 보고 없음</p>';
    return `
      <section class="h-org-chart" aria-label="${escapeHtml(taskPresentation(task).name)} 보고 조직도">
        <header class="h-org-chart-head">
          <div><p class="us-eyebrow">ACTUAL TEAM</p><h4>실행 조직</h4></div>
          <span>실제 보고 ${actorCount}명</span>
        </header>
        <div class="h-org-scroll">
          ${tree}
        </div>
      </section>`;
  }

  function sortTasks(tasks) {
    return tasks.filter((task) => task && typeof task === 'object')
      .sort((left, right) => {
        const leftComplete = left.status === 'complete';
        const rightComplete = right.status === 'complete';
        if (leftComplete !== rightComplete) return leftComplete ? 1 : -1;
        return (parseTime(right.updated_at) || 0) - (parseTime(left.updated_at) || 0);
      });
  }

  function renderPortfolioTaskCard(task, now) {
    const complete = task.status === 'complete';
    const phase = PHASES.find((item) => item.key === task.phase)?.label || task.phase || '미기록';
    const progress = Math.round(clampPercent(Number(task.progress) || 0));
    const updated = relativeTime(task.updated_at, now);
    const presentation = taskPresentation(task);
    return `
      <article class="h-portfolio-task${complete ? ' is-complete' : ''}">
        <header>
          <span class="h-kind">${complete ? 'COMPLETED SESSION' : 'ACTIVE SESSION'}</span>
          <span class="h-task-state"><span class="status-dot${complete ? '' : ' is-warn'}" aria-hidden="true"></span>${complete ? '완료' : '진행 중'}</span>
        </header>
        <h4>${escapeHtml(presentation.name)}</h4>
        <p class="h-portfolio-task-meta"><span>${escapeHtml(taskCategory(task).label)} · ${escapeHtml(phase)} ${progress}%</span>${renderTaskDate(task)}</p>
        <span>${updated ? escapeHtml(`${updated} 동기화`) : '동기화 시각 없음'} · 실제 보고 ${taskActors(task).length}명</span>
      </article>`;
  }

  function renderMiniActor(actor, isMain = false) {
    const warn = ['blocked', 'unavailable', 'waiting'].includes(actor.status);
    return `
      <article class="h-agent-mini${isMain ? ' is-main' : ''}${actor.kind === 'webgpt' ? ' is-webgpt' : ''}" data-actor-id="${escapeHtml(actor.id || '')}">
        <header><span>${isMain ? 'MAIN' : escapeHtml(ACTOR_KIND_LABELS[actor.kind] || actor.kind || 'AGENT')}</span><span><i class="status-dot${warn ? ' is-warn' : ''}" aria-hidden="true"></i>${escapeHtml(actorStatus(actor))}</span></header>
        <strong>${escapeHtml(actor.name || '이름 미기록')}</strong>
        <span class="h-agent-mini-model">${escapeHtml(modelAndReasoning(actor.model, actor.reasoning))}</span>
        ${actor.role ? `<small>${escapeHtml(actor.role)}</small>` : ''}
        ${actor.assignment ? `<small>${escapeHtml(actor.assignment)}</small>` : ''}
      </article>`;
  }

  function renderMiniActorBranch(actor, children, isMain = false, visited = new Set()) {
    if (visited.has(actor.id)) return '';
    const nextVisited = new Set(visited).add(actor.id);
    const descendants = (children.get(actor.id) || [])
      .map((child) => renderMiniActorBranch(child, children, false, nextVisited))
      .filter(Boolean);
    return `<li class="h-agent-mini-node">${renderMiniActor(actor, isMain)}${descendants.length ? `<ul>${descendants.join('')}</ul>` : ''}</li>`;
  }

  function renderMiniActorTree(task) {
    const mainActor = mainActorOf(task);
    if (!mainActor) return '<p class="h-portfolio-empty">에이전트 보고 없음</p>';
    return `<div class="h-agent-mini-tree" aria-label="실제 에이전트 조직도"><ul class="h-agent-mini-list">${renderMiniActorBranch(mainActor, actorHierarchy(task, mainActor), true)}</ul></div>`;
  }

  function normalizedTaskPhase(task) {
    if (task.status === 'complete') return 'done';
    return PHASES.some((phase) => phase.key === task.phase) ? task.phase : 'plan';
  }

  function renderPortfolioTaskBranch(task, now) {
    const current = task.status !== 'complete';
    return `
      <article class="h-pipeline-task${current ? ' is-current' : ''}" data-portfolio-task="${escapeHtml(task.id || '')}" data-current-work="${current}">
        ${renderPortfolioTaskCard(task, now)}
        ${renderMiniActorTree(task)}
      </article>`;
  }

  function renderPipelineStage(phase, index, tasks, now) {
    const phaseTasks = tasks.filter((task) => normalizedTaskPhase(task) === phase.key);
    const active = phaseTasks.some((task) => task.status !== 'complete');
    return `
      <li class="h-pipeline-stage${active ? ' is-active' : ''}" data-pipeline-phase="${phase.key}" data-phase-active="${active}">
        <header class="h-pipeline-stage-head">
          <span class="h-pipeline-stage-index">${index + 1}</span>
          <span><strong>${phase.label}</strong><small>${phase.detail}</small></span>
          <b>${phaseTasks.length}</b>
        </header>
        <div class="h-pipeline-stage-tasks">
          ${phaseTasks.length ? phaseTasks.map((task) => renderPortfolioTaskBranch(task, now)).join('') : '<p class="h-pipeline-empty">해당 단계 작업 없음</p>'}
        </div>
      </li>`;
  }

  function renderPortfolioOrg(inputTasks, now) {
    const tasks = sortTasks(Array.isArray(inputTasks) ? [...inputTasks] : []);
    const activeCount = tasks.filter((task) => task.status !== 'complete').length;
    const completeCount = tasks.length - activeCount;
    const actorCount = tasks.reduce((total, task) => total + taskActors(task).length, 0);
    if (tasks.length === 0) return '<p class="us-empty card">아직 동기화된 파이프라인이 없습니다.</p>';
    return `
      <section class="h-org-chart h-portfolio-org" aria-label="전체 세션과 실제 에이전트 조직도">
        <header class="h-org-chart-head">
          <div><p class="us-eyebrow">FULL PIPELINE</p><h3>전체 파이프라인 조직도</h3></div>
          <span>세션 ${tasks.length}개 · 실제 에이전트 ${actorCount}명</span>
        </header>
        <div class="h-pipeline-org">
          <div class="h-pipeline-origin">
            <article class="h-input-node"><p class="h-kind">REQUEST</p><h4>사용자 입력</h4><span>요청 · 목표 · 제약</span></article>
            <article class="h-harness-root">
              <p class="h-kind">AI HARNESS</p>
              <h4>메인 오케스트레이션</h4>
              <dl><div><dt>진행 중</dt><dd>${activeCount}</dd></div><div><dt>완료</dt><dd>${completeCount}</dd></div><div><dt>실제 에이전트</dt><dd>${actorCount}</dd></div></dl>
            </article>
          </div>
          <ol class="h-pipeline-stages">
            ${PHASES.map((phase, index) => renderPipelineStage(phase, index, tasks, now)).join('')}
          </ol>
        </div>
      </section>`;
  }

  function renderTask(task, now) {
    const mainActor = mainActorOf(task);
    const updated = relativeTime(task.updated_at, now);
    const complete = task.status === 'complete';
    const presentation = taskPresentation(task);
    return `
      <article class="h-task${complete ? ' is-complete' : ''}">
        <header class="h-task-head">
          <div>
            <p class="us-eyebrow">${complete ? 'COMPLETED SESSION' : 'SELECTED SESSION'}</p>
            <h3>${escapeHtml(presentation.name)}</h3>
            <p>${updated ? escapeHtml(`${updated} 동기화`) : '동기화 시각 없음'}${task.deadline ? ` · 마감 ${escapeHtml(task.deadline)}` : ''}</p>
          </div>
          <div class="h-task-badges">
            <span class="h-task-state"><span class="status-dot${complete ? '' : ' is-warn'}" aria-hidden="true"></span>${complete ? '완료' : '진행 중'}</span>
          </div>
        </header>
        ${renderPhaseRail(task)}
        ${renderGate(task)}
        ${renderModules(task)}
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

  function renderTaskTabs(tasks, now, status) {
    const selectedIndex = Math.max(0, tasks.findIndex((task) => task.id === selectedTaskIds[status]));
    return `
      <div class="h-session-switcher" data-session-switcher="${status}">
        <div class="h-session-tabs" role="tablist" aria-label="${status === 'complete' ? '완료된' : '진행 중인'} Codex 세션" data-task-tablist>
          ${tasks.map((task, index) => {
    const selected = index === selectedIndex;
    const category = taskCategory(task);
    const phase = PHASES.find((item) => item.key === task.phase)?.label || task.phase || '미기록';
    const progress = Math.round(clampPercent(Number(task.progress) || 0));
    const presentation = taskPresentation(task);
    return `
            <button class="h-session-tab${selected ? ' is-selected' : ''}" type="button" role="tab"
              id="hSessionTab-${status}-${index}" aria-controls="hSessionPanel-${status}-${index}" aria-selected="${selected}"
              tabindex="${selected ? '0' : '-1'}" data-task-tab="${index}" data-task-id="${escapeHtml(task.id || String(index))}" data-task-status="${status}">
              <span class="h-session-tab-state status-dot${task.status === 'complete' ? '' : ' is-warn'}" aria-hidden="true"></span>
              <span class="h-session-tab-copy">
                <strong>${escapeHtml(presentation.name)}</strong>
                <small class="h-session-tab-meta"><span>${escapeHtml(category.label)} · ${escapeHtml(phase)} ${progress}%</span>${renderTaskDate(task)}</small>
              </span>
            </button>`;
  }).join('')}
        </div>
        <div class="h-session-panels">
          ${tasks.map((task, index) => {
    const selected = index === selectedIndex;
    return `
            <section class="h-session-panel" role="tabpanel" id="hSessionPanel-${status}-${index}"
              aria-labelledby="hSessionTab-${status}-${index}" data-task-panel="${index}"${selected ? '' : ' hidden'}>
              ${renderTask(task, now)}
            </section>`;
  }).join('')}
        </div>
      </div>`;
  }

  function renderSessionView(inputTasks, now, view) {
    const tasks = sortTasks(Array.isArray(inputTasks) ? [...inputTasks] : []);
    if (view === 'org') return renderPortfolioOrg(tasks, now);
    const status = view === 'complete' ? 'complete' : 'active';
    const filtered = tasks.filter((task) => (status === 'complete'
      ? task.status === 'complete'
      : task.status !== 'complete'));
    if (filtered.length === 0) {
      return `<p class="us-empty card">${status === 'complete' ? '완료된 작업이 없습니다.' : '현재 진행 중인 작업이 없습니다.'}</p>`;
    }
    return renderTaskTabs(filtered, now, status);
  }

  function renderSessionViews(inputTasks, now) {
    const tasks = sortTasks(Array.isArray(inputTasks) ? [...inputTasks] : []);
    const activeCount = tasks.filter((task) => task.status !== 'complete').length;
    const completeCount = tasks.length - activeCount;
    const views = [
      { key: 'active', label: '진행 중', count: activeCount },
      { key: 'complete', label: '완료', count: completeCount },
      { key: 'org', label: '전체 조직도', count: tasks.length },
    ];
    return `
      <div class="h-session-views">
        <div class="h-session-view-tabs" role="tablist" aria-label="작업 상태별 보기" data-session-view-tablist>
          ${views.map((view) => {
    const selected = view.key === selectedSessionView;
    return `<button class="h-session-view-tab${selected ? ' is-selected' : ''}" type="button" role="tab"
              id="hSessionViewTab-${view.key}" aria-controls="hSessionViewPanel-${view.key}" aria-selected="${selected}"
              tabindex="${selected ? '0' : '-1'}" data-session-view="${view.key}">
              <span>${view.label}</span><strong data-view-count="${view.count}">${view.count}</strong>
            </button>`;
  }).join('')}
        </div>
        <div class="h-session-view-panels">
          ${views.map((view) => `
            <section class="h-session-view-panel" role="tabpanel" id="hSessionViewPanel-${view.key}"
              aria-labelledby="hSessionViewTab-${view.key}" data-session-view-panel="${view.key}"${view.key === selectedSessionView ? '' : ' hidden'}>
              ${renderSessionView(tasks, now, view.key)}
            </section>`).join('')}
        </div>
      </div>`;
  }

  function buildDashboard(input, now) {
    const rawSnapshots = Array.isArray(input) ? input : input?.snapshots;
    const rawTasks = Array.isArray(input?.tasks) ? input.tasks : [];
    const snapshots = (Array.isArray(rawSnapshots) ? rawSnapshots : [])
      .filter((snapshot) => snapshot?.source === 'codex');
    const tasks = sortTasks(rawTasks);
    return `
      <div class="us-command-layout">
        <section class="us-pipeline-workspace" aria-labelledby="harnessTitle">
          <header class="us-workspace-head">
            <div><p class="us-eyebrow">LIVE HARNESS</p><h2 id="harnessTitle" class="title-2">실행 파이프라인</h2></div>
            <p>상태별 세션 · 전체 실제 보고 조직</p>
          </header>
          <div class="h-session-list">${renderSessionViews(tasks, now)}</div>
        </section>
        <aside class="us-quota-rail" aria-labelledby="quotaTitle">
          <header class="us-quota-head">
            <div><p class="us-eyebrow">ACCOUNT</p><h2 id="quotaTitle" class="title-2">Codex 사용 한도</h2></div>
            <p>실제 계정 보고</p>
          </header>
          <div class="us-quota-list">${snapshots.length > 0
    ? snapshots.map((snapshot) => renderQuota(snapshot, now)).join('')
    : '<p class="us-empty">아직 수집된 한도 기록이 없습니다.</p>'}</div>
        </aside>
      </div>`;
  }

  function activateTaskTab(root, tab, moveFocus = false) {
    if (!root || !tab) return;
    const switcher = tab.closest?.('[data-session-switcher]');
    const scope = switcher && typeof switcher.querySelectorAll === 'function' ? switcher : root;
    const tabs = [...scope.querySelectorAll('[data-task-tab]')];
    const panels = [...scope.querySelectorAll('[data-task-panel]')];
    for (const item of tabs) {
      const selected = item === tab;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.taskPanel !== tab.dataset.taskTab;
    const status = tab.dataset.taskStatus === 'complete' ? 'complete' : 'active';
    selectedTaskIds[status] = tab.dataset.taskId || '';
    if (moveFocus) tab.focus();
  }

  function wireTaskTabs(root) {
    const found = [...(root?.querySelectorAll?.('[data-task-tablist]') || [])]
      .filter((item) => typeof item.addEventListener === 'function');
    const legacy = found.length === 0 ? root?.querySelector?.('[role="tablist"]') : null;
    const tablists = found.length > 0 ? found : legacy ? [legacy] : [];
    for (const tablist of tablists) {
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
  }

  function activateSessionView(root, tab, moveFocus = false) {
    if (!root || !tab) return;
    const tabs = [...root.querySelectorAll('[data-session-view]')];
    const panels = [...root.querySelectorAll('[data-session-view-panel]')];
    for (const item of tabs) {
      const selected = item === tab;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.sessionViewPanel !== tab.dataset.sessionView;
    selectedSessionView = ['active', 'complete', 'org'].includes(tab.dataset.sessionView)
      ? tab.dataset.sessionView
      : 'active';
    if (selectedSessionView === 'org') centerPortfolioOrg(root);
    if (moveFocus) tab.focus();
  }

  function centerPortfolioOrg(root) {
    const panel = root?.querySelector?.('[data-session-view-panel="org"]');
    const scroll = panel?.querySelector?.('.h-org-scroll');
    if (!scroll) return;
    scroll.scrollLeft = Math.max(0, (scroll.scrollWidth - scroll.clientWidth) / 2);
  }

  function wireSessionViews(root) {
    const tablist = root?.querySelector?.('[data-session-view-tablist]');
    if (!tablist) return;
    tablist.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-session-view]');
      if (tab && tablist.contains(tab)) activateSessionView(root, tab);
    });
    tablist.addEventListener('keydown', (event) => {
      const tabs = [...tablist.querySelectorAll('[data-session-view]')];
      const current = event.target.closest('[data-session-view]');
      const index = tabs.indexOf(current);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activateSessionView(root, tabs[next], true);
    });
  }

  function wireDashboard(root) {
    wireSessionViews(root);
    wireTaskTabs(root);
    if (selectedSessionView === 'org') centerPortfolioOrg(root);
  }

  async function load({ announce = false } = {}) {
    elements.error.textContent = '';
    elements.reload.disabled = true;
    elements.reload.textContent = '불러오는 중…';
    if (announce && elements.refreshStatus) elements.refreshStatus.textContent = '최신 정보를 확인하고 있습니다.';
    try {
      const data = await api('/api/usage');
      elements.body.innerHTML = buildDashboard(data, Date.now());
      wireDashboard(elements.body);
      if (announce && elements.refreshStatus) elements.refreshStatus.textContent = '서버에서 방금 확인했습니다.';
      if (announce) elements.reload.textContent = '업데이트됨';
    } catch (error) {
      if (error.message === 'unauthorized') return;
      if (!announce) elements.body.innerHTML = '';
      elements.error.textContent = error.message || '사용량을 불러오지 못했습니다.';
      if (announce && elements.refreshStatus) elements.refreshStatus.textContent = '업데이트하지 못했습니다.';
      if (announce) elements.reload.textContent = '새로고침';
    } finally {
      elements.reload.disabled = false;
      if (!announce) elements.reload.textContent = '새로고침';
    }
  }

  elements.reload.addEventListener('click', () => load({ announce: true }));
  load();
  window.USAGE_RENDER = {
    buildDashboard, renderSessionViews, renderSessionView, renderPortfolioOrg,
    activateTaskTab, wireTaskTabs, activateSessionView, centerPortfolioOrg,
    wireSessionViews, wireDashboard, load,
  };
})();
