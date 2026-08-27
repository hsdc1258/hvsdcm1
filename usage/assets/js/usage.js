(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;

  // captured_at이 이보다 오래되면 "오래된 데이터"로 표시한다 (plan.md §3.2).
  const STALE_MS = 24 * 60 * 60 * 1000;
  // 게이지 색 전환점. 색은 상태를 말하는 데만 쓴다 (DESIGN.md §3).
  const WARN_PERCENT = 75;
  const OVER_PERCENT = 95;

  // 알려진 키의 한국어 라벨. **이것은 "렌더할 목록"이 아니라 사전이다** — 렌더 대상은
  // payload에 실제로 들어 있는 키 전부이고, 여기 없는 키는 키 문자열 그대로 나간다
  // (plan.md §3.2 / LESSONS "파생 가능한 것을 손으로 적지 않는다").
  const BUCKET_LABELS = {
    primary: '5시간',
    secondary: '주간',
    five_hour: '5시간',
    seven_day: '주간',
    seven_day_opus: '주간 (Opus)',
  };
  const SOURCE_LABELS = { codex: 'Codex', claude: 'Claude' };

  const elements = {
    body: document.getElementById('usageBody'),
    error: document.getElementById('usageError'),
    reload: document.getElementById('reload'),
  };

  function loginPath() {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return `/?login=1&next=${next}`;
  }

  // 토큰이 없으면 문서를 그리기 전에 랜딩으로 되돌린다 (account.js와 같은 계약).
  if (!localStorage.getItem('hvsdcm.token')) {
    location.replace(loginPath());
    return;
  }

  const escapeHtml = (value) => String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
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
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '사용량을 불러오지 못했습니다.');
    return data;
  }

  // ---- 값 읽기 -------------------------------------------------------------
  // 수집기 두 곳이 필드 이름을 달리 쓴다: codex는 used_percent, claude는 used_percentage
  // (plan.md §3.2). 둘 중 하나를 고르는 대신 "used_percent로 시작하는 수치 필드"를
  // 버킷 객체에서 찾는다 — 세 번째 이름이 생겨도 UI가 먼저 깨지지 않는다.
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

  // ---- payload → 렌더 모델 --------------------------------------------------
  // 두 수집 원본의 payload 모양이 다르다: codex는 rate_limits 하나, claude는 모델별
  // models[<id>].rate_limits다. 어느 쪽인지는 **모양으로** 판정한다 — source 이름으로
  // 분기하면 세 번째 원본이 생길 때 UI가 조용히 빈 화면을 낸다.
  function groupsOf(payload) {
    if (!payload || typeof payload !== 'object') return [];
    if (payload.models && typeof payload.models === 'object') {
      return Object.entries(payload.models).map(([id, model]) => ({
        label: id,
        buckets: model?.rate_limits,
        capturedAt: model?.captured_at,
      }));
    }
    if (payload.rate_limits && typeof payload.rate_limits === 'object') {
      return [{ label: payload.model || null, buckets: payload.rate_limits, capturedAt: null }];
    }
    return [];
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

  // ---- 렌더 ----------------------------------------------------------------

  function renderRow(bucket, now) {
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
      </div>
    `;
  }

  function renderGroup(group, now) {
    const buckets = bucketsOf(group);
    if (buckets.length === 0) return '';
    const head = group.label
      ? `<p class="list-group-head">${escapeHtml(group.label)}</p>`
      : '';
    return `
      <div class="us-group">
        ${head}
        <div class="list-group is-inset">${buckets.map((bucket) => renderRow(bucket, now)).join('')}</div>
      </div>
    `;
  }

  function renderCard(snapshot, now) {
    const label = SOURCE_LABELS[snapshot.source] || snapshot.source;
    const capturedTime = parseTime(snapshot.captured_at);
    const captured = relativeTime(snapshot.captured_at, now);
    const stale = capturedTime !== null && now - capturedTime > STALE_MS;
    const groups = groupsOf(snapshot.payload).map((group) => renderGroup(group, now)).join('');

    return `
      <article class="card us-card">
        <header class="us-card-head">
          <h2 class="title-3">${escapeHtml(label)}</h2>
          <span class="us-card-meta">${captured ? escapeHtml(`${captured} 수집`) : '수집 시각 없음'}${stale ? ' · 오래된 데이터' : ''}</span>
        </header>
        ${groups || '<p class="us-empty">이 원본에는 읽을 수 있는 한도 정보가 없습니다.</p>'}
      </article>
    `;
  }

  function renderStrip(snapshots, now) {
    const buckets = snapshots
      .flatMap((snapshot) => groupsOf(snapshot.payload))
      .flatMap((group) => bucketsOf(group));
    const percents = buckets.map((bucket) => bucket.percent).filter((percent) => percent !== null);
    const times = snapshots.map((snapshot) => parseTime(snapshot.captured_at)).filter((time) => time !== null);
    const latest = times.length > 0 ? Math.max(...times) : null;
    const oldest = times.length > 0 ? Math.min(...times) : null;
    const stale = oldest !== null && now - oldest > STALE_MS;

    const cells = [
      ['데이터 상태', `<span class="stat-state"><span class="status-dot${stale ? ' is-warn' : ''}" aria-hidden="true"></span>${stale ? '오래됨' : '최신'}</span>`],
      ['최근 수집', `<span class="stat-value">${latest === null ? '—' : escapeHtml(relativeTime(new Date(latest).toISOString(), now))}</span>`],
      ['최고 사용률', `<span class="stat-value">${percents.length === 0 ? '—' : `${Math.round(clampPercent(Math.max(...percents)))}%`}</span>`],
      ['한도 버킷', `<span class="stat-value">${buckets.length}</span>`],
    ];

    return `<div class="summary-strip">${cells.map(([label, value]) => `
      <div class="summary-cell">
        <span class="stat-label">${escapeHtml(label)}</span>
        ${value}
      </div>
    `).join('')}</div>`;
  }

  // 화면 전체를 문자열 하나로 만든다. 부수효과가 없으므로 스냅샷 생성기가 같은 함수를
  // 고정 fixture로 불러 정적 사본을 만든다 (scripts/snapshot.mjs).
  function buildDashboard(snapshots, now) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      return '<p class="us-empty">아직 수집된 사용량 기록이 없습니다.</p>';
    }
    return [
      renderStrip(snapshots, now),
      `<div class="us-cards">${snapshots.map((snapshot) => renderCard(snapshot, now)).join('')}</div>`,
    ].join('');
  }

  async function load() {
    elements.error.textContent = '';
    elements.reload.disabled = true;
    try {
      const data = await api('/api/usage');
      elements.body.innerHTML = buildDashboard(data.snapshots, Date.now());
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

  // 스냅샷 생성기가 쓰는 순수 렌더 진입점. 브라우저에서는 아무도 읽지 않는다.
  window.USAGE_RENDER = { buildDashboard };
})();
