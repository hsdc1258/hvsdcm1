(() => {
  'use strict';

  // ==========================================================================
  // usage — AI 실행 현황 (WP-A2 전면 재작성)
  //
  // 화면 계약: sessions/2026-08-28-야간자율개편/plan.md §4
  //   1. 세션마다 "사용자 입력 → 총괄 → 단계 → 에이전트"의 **전체 트리를 항상** 그린다.
  //      현재 단계만 강조하는 것이 아니라 대기 중인 단계까지 노드로 세운다.
  //   2. 조직도 영역은 휠 = 확대(커서 중심), 끌기 = 이동. 조직도 밖 페이지 스크롤은 그대로다.
  //   3. 세션 한도 소모는 events의 usage 스냅샷으로 계산한다. 그 값은 **잔여 한도(%)**이므로
  //      소모는 "처음 − 끝"이고, 창 초기화(잔여 상승) 구간은 더하지 않는다.
  //   4. 활성 세션이 있고 탭이 보이면 5초, 아니면 60초 주기로 다시 읽는다.
  //
  // events는 WP-A1이 추가하는 필드다. **없어도 트리는 그대로 그리고** 단계 소요시간과
  // 한도 소모만 감춘다 — 구세션(이벤트 이전 payload) 하위호환이 계약이다.
  //
  // 조판 규칙(DESIGN.md §9): 노드 안 텍스트는 HTML+CSS 그리드다. 커넥터는 CSS 헤어라인
  // 의사요소가 그린다. 손계산 SVG 좌표는 쓰지 않는다.
  // ==========================================================================

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;
  const STALE_MS = 15 * 60 * 1000;
  const WARN_PERCENT = 75;
  const OVER_PERCENT = 95;
  // 자동 갱신 주기 — 활성 세션이 있을 때만 빠르게 본다.
  const POLL_ACTIVE_MS = 5_000;
  const POLL_IDLE_MS = 60_000;
  const FRESHNESS_TICK_MS = 1_000;
  // 응답이 오지 않는 요청의 최대 수명. 이것이 없으면 **영원히 대기하는 fetch 하나가
  // 자동 갱신을 통째로 멈춘다** — inFlight가 안 풀리고 다음 타이머도 걸리지 않기
  // 때문이다 (review WPA2 M2). 그래서 성공·거절·시간초과 셋 다 반드시 정착시킨다.
  const REQUEST_TIMEOUT_MS = 15_000;
  // 조직도 확대 범위 (계약 §4-3).
  // ZOOM_MIN은 **사람이 휠·버튼으로 축소할 때의 바닥**이다. 자동 "맞춤"은 이 바닥
  // 아래로 내려갈 수 있다 — 잘린 화면을 "맞춤"이라 부르지 않기 위해서다(review M3).
  const ZOOM_MIN = 0.3;
  const FIT_MIN = 0.12;
  const ZOOM_MAX = 2.5;
  const ZOOM_STEP = 1.2;
  const PAN_STEP = 48;

  // 단계는 제어면과 report schema가 함께 보장하는 여덟 개다 (DESIGN.md §1.1).
  // 이 배열이 화면의 단일 원본이다 — 트리·상태·소요시간 계산이 모두 여기서 도출된다.
  // **키와 순서는 worker/src/router.js의 VALID_HARNESS_PHASES와 같아야 한다** —
  // scripts/validate.mjs가 두 원본을 대조한다. 구 4단계(plan/work/review/done)는 이
  // 사슬의 부분집합이므로 옛 보고만 있는 세션도 그대로 그려지고, 보고된 적 없는
  // 단계는 그냥 '대기'로 서 있는다.
  const PHASES = [
    { key: 'input', label: '입력', detail: '요청 접수 · 범위 확인' },
    { key: 'plan', label: '기획', detail: '계약 · 증거 고정' },
    { key: 'work', label: '구현', detail: '격리 구현 · 검증' },
    { key: 'gate', label: '게이트', detail: '빌드 · 린트 · 테스트' },
    { key: 'review', label: '리뷰', detail: '독립 반증 · 지적' },
    { key: 'revise', label: '수정', detail: '지적 반영 · 재검증' },
    { key: 'approve', label: '승인', detail: '판정 · 릴리스 결정' },
    { key: 'done', label: '완료', detail: '배포 · 기록' },
  ];
  const PHASE_KEYS = new Set(PHASES.map((phase) => phase.key));
  // 8단계 확장 이전의 보고자가 쓰던 네 키. **이벤트 로그가 아예 없는 세션**에서만
  // 쓰인다 — 그런 세션은 이 네 단계 사슬을 따라 왔다고 볼 근거가 있지만, 확장으로
  // 새로 생긴 단계까지 지나왔다고 볼 근거는 없다 (review major: 날조 금지).
  const LEGACY_PHASE_KEYS = new Set(['plan', 'work', 'review', 'done']);
  const PHASE_STATE_LABELS = {
    done: '완료', current: '진행 중', pending: '대기', skipped: '기록 없음',
  };
  const ACTOR_KIND_LABELS = { codex: 'CODEX', webgpt: 'WEBGPT', claude: 'CLAUDE' };
  // 오른쪽 rail이 그리는 수집 원본. **키 순서가 곧 표시 순서**이고, 여기 없는 source는
  // 그리지 않는다 — 원본이 늘면 이 사전 한 줄만 고친다.
  const SOURCE_LABELS = { codex: 'Codex', claude: 'Claude' };
  // 세션 한도 소모가 읽는 이벤트 필드 ↔ 표시 라벨. 위 SOURCE_LABELS와 짝을 이룬다.
  const USAGE_DELTA_FIELDS = [['usage_codex', 'Codex'], ['usage_claude', 'Claude']];
  // 알려진 버킷 키의 한국어 라벨. 렌더 대상 목록이 아니라 사전이다 — payload에 실제로
  // 들어 있는 키를 전부 그리고, 여기 없는 키는 키 문자열 그대로 나간다.
  const BUCKET_LABELS = {
    primary: '기본 사용량',
    secondary: '추가 사용량',
    five_hour: '5시간 사용량',
    seven_day: '주간 사용량',
    seven_day_opus: '주간 사용량 (Opus)',
  };
  const ACTOR_STATUS_LABELS = {
    working: '작업 중', reviewing: '검토 중', waiting: '대기',
    done: '완료', blocked: '막힘', unavailable: '사용 불가',
  };

  const elements = {
    body: document.getElementById('usageBody'),
    error: document.getElementById('usageError'),
    reload: document.getElementById('reload'),
    refreshStatus: document.getElementById('usageRefreshStatus'),
    freshness: document.getElementById('usageFreshness'),
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

  // 어떤 프라미스든 제한 시간 안에 정착시킨다. fetch가 signal을 존중하지 않아도(또는
  // 본문 읽기가 멈춰도) 여기서 거절이 나가므로 호출자의 finally가 반드시 돈다.
  function withTimeout(promise, milliseconds, abort) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { abort?.(); } catch { /* abort 실패가 시간초과 처리를 막지 않는다. */ }
        reject(new Error('서버 응답이 없어 요청을 중단했습니다.'));
      }, milliseconds);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  async function requestUsage(path, signal) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(`${API_URL}${path}${separator}_=${Date.now()}`, {
      cache: 'no-store',
      signal,
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

  function api(path) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    return withTimeout(
      requestUsage(path, controller?.signal),
      REQUEST_TIMEOUT_MS,
      () => controller?.abort(),
    );
  }

  // ---- 공용 계산 -----------------------------------------------------------

  function clampPercent(value) {
    return Math.min(100, Math.max(0, value));
  }

  // 이벤트·payload의 수치는 **결측이 정상**이다(스냅샷이 없던 시점, 진행률을 보고하지
  // 않은 액터). `Number(null) === 0`이라 곧장 숫자로 바꾸면 "측정 안 됨"이 "0으로 측정됨"이
  // 되어 한도 소모와 진행도를 거짓으로 만든다 (review WPA2 M1). 그래서 숫자로 바꾸기
  // **전에** 결측을 걸러낸다. 숫자 값 하나를 얻는 경로는 전부 이 함수를 지난다.
  function finiteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
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

  function readPercent(bucket) {
    if (!bucket || typeof bucket !== 'object') return null;
    for (const [key, value] of Object.entries(bucket)) {
      if (/^used_percent/u.test(key) && Number.isFinite(value)) return value;
    }
    return null;
  }

  // ---- 한도 rail -----------------------------------------------------------

  // 수집 원본마다 payload 모양이 다르다: codex는 rate_limits 하나, claude는 모델별
  // models[<id>].rate_limits다. 어느 쪽인지는 **모양으로** 판정한다 — source 이름으로
  // 분기하면 세 번째 원본이 생길 때 UI가 조용히 빈 화면을 낸다.
  function groupsOf(payload) {
    if (!payload || typeof payload !== 'object') return [];
    if (payload.models && typeof payload.models === 'object') {
      return Object.entries(payload.models)
        .filter(([, model]) => model && typeof model === 'object')
        .map(([id, model]) => ({ label: id, buckets: model.rate_limits }));
    }
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
    return BUCKET_LABELS[key] || key;
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
    const label = SOURCE_LABELS[snapshot.source] || snapshot.source;
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
          <div><p class="us-eyebrow">LIVE LIMIT</p><h3 class="title-3">${escapeHtml(label)} 한도</h3></div>
          <span class="us-card-meta">${captured ? escapeHtml(`${captured} 수집`) : '수집 시각 없음'}${stale ? ' · 수집 지연' : ''}</span>
        </header>
        ${groups || `<p class="us-empty">읽을 수 있는 ${escapeHtml(label)} 한도 정보가 없습니다.</p>`}
      </article>`;
  }

  // 원본 하나가 아직 한 번도 보고하지 않은 상태. 카드를 통째로 빼면 rail에서 그 원본이
  // 사라져 "한도가 0"인지 "수집이 멈췄는지" 구분되지 않으므로, 같은 골격의 빈 상태로 둔다.
  function renderQuotaPlaceholder(source) {
    const label = SOURCE_LABELS[source] || source;
    return `
      <article class="us-limit-widget">
        <header class="us-card-head">
          <div><p class="us-eyebrow">LIVE LIMIT</p><h3 class="title-3">${escapeHtml(label)} 한도</h3></div>
          <span class="us-card-meta">수집 대기</span>
        </header>
        <p class="us-empty">아직 ${escapeHtml(label)} 스냅샷이 없습니다.</p>
      </article>`;
  }

  // ---- task / event 판독 ---------------------------------------------------

  function taskActors(task) {
    return Array.isArray(task?.actors)
      ? task.actors.filter((actor) => actor && typeof actor === 'object')
      : [];
  }

  function taskModules(task) {
    return Array.isArray(task?.modules)
      ? task.modules.filter((module) => module && typeof module === 'object')
      : [];
  }

  function mainActorOf(task) {
    const actors = taskActors(task);
    return actors.find((actor) => !actor.parent_id) || actors[0] || null;
  }

  function actorStatus(actor) {
    return ACTOR_STATUS_LABELS[actor.status] || actor.status || '상태 미기록';
  }

  // 상태색은 상태에만 쓴다 — 진행(작업·검토)=강조, 끝났거나 쉬는 것=중립, 막힘=경고.
  function statusDotClass(status) {
    if (status === 'blocked' || status === 'unavailable') return ' is-warn';
    if (status === 'working' || status === 'reviewing') return ' is-accent';
    return ' is-idle';
  }

  function modelAndReasoning(model, reasoning) {
    if (!model && !reasoning) return '';
    const modelLabel = model || '모델 미기록';
    return reasoning ? `${modelLabel} · ${reasoning}` : modelLabel;
  }

  // WP-A1이 붙이는 이벤트 로그. 없으면 빈 배열이고, 그때는 소요시간·한도 소모가 숨는다.
  function taskEvents(task) {
    const raw = Array.isArray(task?.events) ? task.events : [];
    return raw
      .filter((event) => event && typeof event === 'object')
      .map((event) => ({ ...event, time: parseTime(event.ts) }))
      .filter((event) => event.time !== null)
      .sort((left, right) => left.time - right.time);
  }

  // 단계별 누적 소요시간·모델을 이벤트 구간의 합으로 계산한다. 되돌아간 단계
  // (검토 → 작업 → 검토)도 각 구간을 더하므로 "그 단계에 쓴 시간"이 맞는다.
  function phaseTimeline(task, now) {
    const events = taskEvents(task);
    const phased = events.filter((event) => PHASE_KEYS.has(event.phase));
    const stats = new Map();
    if (phased.length === 0) return { stats, currentKey: '', hasEvents: events.length > 0 };
    const lastTime = phased[phased.length - 1].time;
    // 끝난 세션은 마지막 보고에서 시계를 멈춘다 — 살아 있는 세션만 지금까지 센다.
    const endTime = task.status === 'complete' ? lastTime : Math.max(now, lastTime);
    for (let index = 0; index < phased.length; index += 1) {
      const event = phased[index];
      const until = index + 1 < phased.length ? phased[index + 1].time : endTime;
      const entry = stats.get(event.phase) || { duration: 0, model: '', reasoning: '' };
      entry.duration += Math.max(0, until - event.time);
      if (event.model) entry.model = String(event.model);
      if (event.reasoning) entry.reasoning = String(event.reasoning);
      stats.set(event.phase, entry);
    }
    return { stats, currentKey: phased[phased.length - 1].phase, hasEvents: true };
  }

  // 하위호환: 구 4단계 키(plan/work/review/done)는 PHASE_KEYS의 부분집합이라 그대로
  // 통과한다. 키가 아예 없거나 모르는 값이면 '기획'으로 세운다 — 보고가 시작된 세션은
  // 최소한 입력 단계는 지났기 때문이다.
  function normalizedTaskPhase(task) {
    if (task.status === 'complete') return 'done';
    return PHASE_KEYS.has(task.phase) ? task.phase : 'plan';
  }

  // 탭 한 줄에 쓰는 현재 단계. 이벤트가 있으면 그 마지막 단계가 payload보다 우선한다.
  function currentPhaseLabel(task, now) {
    const key = phaseTimeline(task, now).currentKey || normalizedTaskPhase(task);
    return PHASES.find((phase) => phase.key === key)?.label || '미기록';
  }

  // 실제로 보고된 적이 있는 단계 키. 이벤트 로그의 phase와 payload의 현재 phase가
  // 근거이고, 그 밖의 단계는 "지나갔다"고 말할 근거가 없다.
  function reportedPhaseKeys(task) {
    const keys = new Set();
    for (const event of taskEvents(task)) {
      if (PHASE_KEYS.has(event.phase)) keys.add(event.phase);
    }
    if (PHASE_KEYS.has(task?.phase)) keys.add(task.phase);
    return keys;
  }

  // 이벤트가 있으면 그 마지막 단계가 현재 단계다. 없으면 payload의 phase를 쓴다.
  //
  // 앞선 단계를 무조건 '완료'로 칠하지 않는다 (review major). 인덱스만 보고 접으면
  // 구 4단계 세션이 review를 보고하는 순간 보고된 적 없는 gate가, done을 보고하는
  // 순간 input·gate·revise·approve까지 전부 완료로 **날조**된다. 그래서 앞선 단계는
  //   (a) 이벤트나 payload에 실제로 등장했으면 done,
  //   (b) 등장한 적이 없으면 skipped(= '기록 없음', 흐린 점선)로 구분해 그린다.
  // 이벤트가 아예 없는 구세션만 예외로, 구 4단계 키에 한해 종전 추론을 유지한다 —
  // 그 세션은 네 단계 사슬을 따라 왔다고 볼 근거가 있기 때문이다.
  function phaseStates(task, timeline) {
    const complete = task.status === 'complete';
    const currentKey = complete ? 'done' : (timeline.currentKey || normalizedTaskPhase(task));
    const currentIndex = Math.max(0, PHASES.findIndex((phase) => phase.key === currentKey));
    const reported = reportedPhaseKeys(task);
    const hasEvents = timeline.stats.size > 0;
    return new Map(PHASES.map((phase, index) => {
      if (index > currentIndex) return [phase.key, 'pending'];
      if (index === currentIndex) return [phase.key, complete ? 'done' : 'current'];
      if (hasEvents) return [phase.key, reported.has(phase.key) ? 'done' : 'skipped'];
      return [phase.key, LEGACY_PHASE_KEYS.has(phase.key) ? 'done' : 'skipped'];
    }));
  }

  // actor가 어느 단계에서 갈라져 나왔는지 — 그 actor를 마지막으로 언급한 이벤트의 단계.
  function actorPhaseMap(task) {
    const map = new Map();
    for (const event of taskEvents(task)) {
      if (event.actor_id && PHASE_KEYS.has(event.phase)) map.set(String(event.actor_id), event.phase);
    }
    return map;
  }

  // 서브에이전트 진행도는 이벤트의 **측정된** 최신 percent가 우선이고, 없으면 payload의
  // progress다. percent가 null인 늦은 보고가 앞선 측정값을 0%로 덮지 않는다 (M1).
  function actorProgressMap(task) {
    const map = new Map();
    for (const event of taskEvents(task)) {
      const percent = finiteNumber(event.percent);
      if (event.actor_id && percent !== null) map.set(String(event.actor_id), percent);
    }
    return map;
  }

  // 세션 한도 소모.
  //
  // **필드 계약**: events의 `usage_codex`·`usage_claude`는 그 시점의 **잔여 한도(%)**다.
  // worker/src/router.js의 remainingUsagePercent()가 `remaining_percent`를 그대로 쓰고,
  // 원본이 사용량만 주면 `100 - used`로 뒤집어 기록하기 때문이다. 따라서 소모는
  // `끝 - 처음`이 아니라 **처음 - 끝**이다 (review WPA2 B1: 부호가 뒤집혀 있었다).
  //
  // 한도 창이 초기화되면 잔여가 도로 올라간다. 그 상승을 "소모"로 둔갑시키지 않으려고
  // **감소 구간만** 더하고(초기화 지점에서 끊는다), 초기화가 있었다는 사실은 따로 적는다.
  function sessionUsageDeltas(task) {
    const events = taskEvents(task);
    const deltas = [];
    for (const [field, label] of USAGE_DELTA_FIELDS) {
      const values = events
        .map((event) => finiteNumber(event[field]))
        .filter((value) => value !== null);
      if (values.length < 2) continue;
      let consumed = 0;
      let resets = 0;
      for (let index = 1; index < values.length; index += 1) {
        const drop = values[index - 1] - values[index];
        if (drop > 0) consumed += drop;
        else if (drop < 0) resets += 1;
      }
      if (!(consumed >= 0.1)) continue;
      const reset = resets > 0 ? ` (한도 초기화 ${resets}회)` : '';
      deltas.push(`${label} ${consumed.toFixed(1)}%p${reset}`);
    }
    return deltas;
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

  function taskCategory(task) {
    return {
      key: task.category_key || 'general',
      label: task.category || '기타 Codex 작업',
    };
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

  // ---- 조직도 노드 ---------------------------------------------------------
  //
  // 노드 하나의 표시 계약은 아래 한 형태뿐이고, 세션 트리와 전체 조직도가 같은
  // 렌더러를 공유한다. 종류마다 다른 마크업을 만들면 두 화면의 톤이 갈라진다.
  //   { kind, kindLabel, name, detail, model, note, status, tone, time, progress, attributes, children }
  // model은 한 줄 고정(모노·말줄임)이고, note는 길어지면 줄바꿈하는 자유 문장이다.

  function renderNodeAttributes(attributes) {
    return Object.entries(attributes || {})
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
      .join('');
  }

  function renderNode(node) {
    const progress = Number.isFinite(node.progress) ? clampPercent(node.progress) : null;
    return `
      <article class="h-node is-${escapeHtml(node.kind)}${node.current ? ' is-current' : ''}"${renderNodeAttributes(node.attributes)}>
        <p class="h-node-kind">${escapeHtml(node.kindLabel || 'NODE')}</p>
        <h5 class="h-node-name">${escapeHtml(node.name || '이름 미기록')}</h5>
        ${node.detail ? `<p class="h-node-detail">${escapeHtml(node.detail)}</p>` : ''}
        ${node.model ? `<p class="h-node-model">${escapeHtml(node.model)}</p>` : ''}
        ${node.note ? `<p class="h-node-note">${escapeHtml(node.note)}</p>` : ''}
        ${node.status
    ? `<p class="h-node-state"><span class="status-dot${node.tone || ' is-idle'}" aria-hidden="true"></span>${escapeHtml(node.status)}${node.time ? `<span class="h-node-time">${escapeHtml(node.time)}</span>` : ''}</p>`
    : ''}
        ${progress === null
    ? ''
    : `<p class="h-node-progress"><span>진행도</span><strong>${Math.round(progress)}%</strong></p>
        <span class="gauge-track" aria-hidden="true"><span class="gauge-fill" style="width: ${progress.toFixed(1)}%"></span></span>`}
      </article>`;
  }

  function renderBranch(node) {
    const children = (node.children || []).filter(Boolean);
    return `<li class="h-node-slot">${renderNode(node)}${children.length ? `<ul>${children.map(renderBranch).join('')}</ul>` : ''}</li>`;
  }

  function renderTree(nodes) {
    return `<ul class="h-tree">${nodes.map(renderBranch).join('')}</ul>`;
  }

  // ---- 트리 구성 -----------------------------------------------------------

  // 서브에이전트 숲: 부모가 다른 actor면 그 아래에, 아니면 자기 단계 노드 아래에 붙는다.
  // 순환 parent_id가 들어와도 visited로 끊는다 (보고자가 잘못 보내도 화면이 멈추지 않게).
  function actorNodes(task) {
    const actors = taskActors(task);
    const main = mainActorOf(task);
    const byId = new Map(actors.map((actor) => [actor.id, actor]));
    const phaseOf = actorPhaseMap(task);
    const progressOf = actorProgressMap(task);
    const fallbackPhase = normalizedTaskPhase(task);
    const childrenOf = new Map();
    const byPhase = new Map(PHASES.map((phase) => [phase.key, []]));

    for (const actor of actors) {
      if (main && actor.id === main.id) continue;
      const parentId = actor.parent_id && actor.parent_id !== main?.id && byId.has(actor.parent_id)
        ? actor.parent_id
        : '';
      if (parentId) {
        if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
        childrenOf.get(parentId).push(actor);
        continue;
      }
      const phaseKey = phaseOf.get(String(actor.id)) || fallbackPhase;
      (byPhase.get(phaseKey) || byPhase.get(fallbackPhase)).push(actor);
    }

    const toNode = (actor, visited) => {
      const nextVisited = new Set(visited).add(actor.id);
      const progress = progressOf.has(String(actor.id))
        ? progressOf.get(String(actor.id))
        : finiteNumber(actor.progress);
      return {
        kind: 'agent',
        kindLabel: ACTOR_KIND_LABELS[actor.kind] || actor.kind || 'AGENT',
        name: actor.name || '이름 미기록',
        detail: actor.role || actor.assignment || '',
        model: modelAndReasoning(actor.model, actor.reasoning),
        status: actorStatus(actor),
        tone: statusDotClass(actor.status),
        progress,
        current: actor.status === 'working' || actor.status === 'reviewing',
        attributes: { 'data-actor-id': actor.id || '' },
        children: (childrenOf.get(actor.id) || [])
          .filter((child) => !nextVisited.has(child.id))
          .map((child) => toNode(child, nextVisited)),
      };
    };

    return {
      main,
      byPhase: new Map([...byPhase].map(([key, list]) => [key, list.map((actor) => toNode(actor, new Set()))])),
    };
  }

  // 세션 하나의 단계 노드 전부(PHASES 순서). events가 없으면 소요시간·모델 줄이 빠진 채로 그려진다.
  function phaseNodesOf(task, now) {
    const timeline = phaseTimeline(task, now);
    const states = phaseStates(task, timeline);
    const { byPhase } = actorNodes(task);
    return PHASES.map((phase) => {
      const stat = timeline.stats.get(phase.key);
      const state = states.get(phase.key);
      const isCurrent = state === 'current';
      const model = modelAndReasoning(
        stat?.model || (isCurrent ? task.model : ''),
        stat?.reasoning || (isCurrent ? task.reasoning : ''),
      );
      return {
        kind: 'phase',
        kindLabel: 'PHASE',
        name: phase.label,
        detail: phase.detail,
        model,
        status: PHASE_STATE_LABELS[state],
        tone: isCurrent ? ' is-accent' : ' is-idle',
        time: stat && stat.duration > 0 ? formatDuration(stat.duration) : '',
        current: isCurrent,
        attributes: { 'data-org-phase': phase.key, 'data-phase-state': state },
        children: byPhase.get(phase.key) || [],
      };
    });
  }

  // 세션 하나의 아래쪽 절반 — 총괄 → 단계 전부 → 서브에이전트.
  // 세션 탭과 전체 조직도가 **같은 함수**를 쓴다. 두 화면이 각자 트리를 조립하면
  // 한쪽에서만 액터가 빠지는 일이 생긴다 (실제로 그렇게 총괄 노드가 빠졌다).
  function sessionSubtreeNodes(task, now, { leadProgress = true } = {}) {
    const phases = phaseNodesOf(task, now);
    const main = mainActorOf(task);
    // 액터를 하나도 보고하지 않은 세션도 자리를 비우지 않는다 — 트리 모양을 같게 두고
    // "보고가 없다"를 말한다. 노드를 지우면 단계만 남아 원인이 보이지 않는다.
    if (!main) {
      return [{
        kind: 'lead',
        kindLabel: 'MAIN',
        name: '에이전트 보고 없음',
        detail: '이 세션은 실행자를 보고하지 않았습니다',
        children: phases,
      }];
    }
    const progress = finiteNumber(task.progress);
    return [{
      kind: 'lead',
      kindLabel: 'MAIN',
      name: main.name || '이름 미기록',
      detail: main.role || '',
      model: modelAndReasoning(main.model, main.reasoning),
      status: actorStatus(main),
      tone: statusDotClass(main.status),
      // 전체 조직도에서는 바로 위 세션 노드가 같은 수치를 이미 들고 있다 — 두 번 그리지 않는다.
      progress: leadProgress ? progress : null,
      current: main.status === 'working' || main.status === 'reviewing',
      attributes: { 'data-actor-id': main.id || '' },
      children: phases,
    }];
  }

  // 세션 트리 — 사용자 입력 → 총괄 → 단계 전부 → 서브에이전트.
  function sessionTreeNodes(task, now) {
    return [{
      kind: 'request',
      kindLabel: 'REQUEST',
      name: '사용자 입력',
      detail: taskPresentation(task).name,
      children: sessionSubtreeNodes(task, now),
    }];
  }

  // 전체 조직도 — 사용자 입력 → 하네스 → 세션들 → 각 세션의 단계·에이전트.
  function portfolioTreeNodes(tasks, now) {
    const activeCount = tasks.filter((task) => task.status !== 'complete').length;
    const actorCount = tasks.reduce((total, task) => total + taskActors(task).length, 0);
    return [{
      kind: 'request',
      kindLabel: 'REQUEST',
      name: '사용자 입력',
      detail: '요청 · 목표 · 제약',
      children: [{
        kind: 'harness',
        kindLabel: 'HARNESS',
        name: '메인 오케스트레이션',
        detail: `세션 ${tasks.length}개 · 진행 ${activeCount}개 · 에이전트 ${actorCount}명`,
        children: tasks.map((task) => {
          const complete = task.status === 'complete';
          const presentation = taskPresentation(task);
          const deltas = sessionUsageDeltas(task);
          return {
            kind: 'session',
            kindLabel: 'SESSION',
            name: presentation.name,
            detail: [taskCategory(task).label, presentation.dateLabel].filter(Boolean).join(' · '),
            // 한 줄 모노 슬롯(model)에 넣으면 말줄임으로 잘린다 — 줄바꿈하는 note로 낸다.
            note: deltas.length ? `한도 소모 ${deltas.join(' · ')}` : '',
            status: complete ? '완료' : '진행 중',
            tone: complete ? ' is-idle' : ' is-accent',
            progress: finiteNumber(task.progress),
            current: !complete,
            attributes: {
              'data-portfolio-task': task.id || '',
              'data-session-active': String(!complete),
            },
            children: sessionSubtreeNodes(task, now, { leadProgress: false }),
          };
        }),
      }],
    }];
  }

  // ---- 조직도 캔버스(확대·이동) --------------------------------------------

  function renderOrgCanvas(key, label, treeMarkup) {
    return `
      <section class="h-org" aria-label="${escapeHtml(label)}">
        <header class="h-org-head">
          <div><p class="us-eyebrow">ORG CHART</p><h4>실행 조직도</h4></div>
          <div class="h-org-tools">
            <span class="h-org-hint">휠 확대 · 끌어 이동</span>
            <button class="btn btn-secondary btn-sm" type="button" data-org-action="out">축소</button>
            <button class="btn btn-secondary btn-sm" type="button" data-org-action="in">확대</button>
            <button class="btn btn-secondary btn-sm" type="button" data-org-action="fit">맞춤</button>
          </div>
        </header>
        <div class="h-org-viewport" data-org-view="${escapeHtml(key)}" tabindex="0" role="group"
          aria-label="조직도 확대·이동 영역. 방향키로 이동, +·- 로 확대, 0으로 맞춤">
          <div class="h-org-canvas" data-org-canvas>${treeMarkup}</div>
        </div>
      </section>`;
  }

  // 확대·이동 상태는 뷰 키마다 남긴다 — 자동 갱신으로 DOM을 다시 그려도 시점이 튀지 않는다.
  const orgViewState = new Map();
  let orgPanning = false;

  function orgCanvasOf(viewport) {
    return viewport?.querySelector?.('[data-org-canvas]') || null;
  }

  function applyOrgTransform(viewport, state) {
    const canvas = orgCanvasOf(viewport);
    if (!canvas || !canvas.style) return;
    canvas.style.transform = `translate(${Math.round(state.x)}px, ${Math.round(state.y)}px) scale(${state.scale.toFixed(3)})`;
  }

  // "맞춤"은 **두 축 모두** 들어가야 맞춤이다. 폭만 재면 세로로 긴 모바일 트리가
  // 잘린 채로 "맞췄다"고 말하게 된다 (review WPA2 M3 — 16노드 중 4개가 잘렸다).
  // 세로가 부족해 ZOOM_MIN(0.3) 아래로 내려가야 한다면 내려간다. 사람이 휠로 축소할 때의
  // 바닥은 그대로 0.3이고, 그 바닥은 zoomOrgView가 "지금 배율보다 위로 튀지 않게" 지킨다.
  function fitOrgView(viewport, state) {
    const canvas = orgCanvasOf(viewport);
    if (!canvas) return;
    const contentWidth = canvas.scrollWidth || canvas.offsetWidth || 0;
    const contentHeight = canvas.scrollHeight || canvas.offsetHeight || 0;
    const viewWidth = viewport.clientWidth || 0;
    const viewHeight = viewport.clientHeight || 0;
    const ratios = [];
    if (contentWidth > 0 && viewWidth > 0) ratios.push(viewWidth / contentWidth);
    if (contentHeight > 0 && viewHeight > 0) ratios.push(viewHeight / contentHeight);
    const scale = ratios.length ? Math.min(1, Math.max(FIT_MIN, Math.min(...ratios))) : 1;
    state.scale = scale;
    state.x = Math.max(0, (viewWidth - (contentWidth * scale)) / 2);
    state.y = Math.max(0, (viewHeight - (contentHeight * scale)) / 2);
    applyOrgTransform(viewport, state);
  }

  // 커서(또는 뷰포트 중앙)를 고정점으로 두고 확대한다 — 그래야 보고 있던 노드가 안 달아난다.
  function zoomOrgView(viewport, state, factor, originX, originY) {
    // 축소 바닥은 0.3이되, 맞춤이 이미 그 아래로 내려가 있으면 그 배율이 바닥이다 —
    // 축소 버튼이 화면을 도로 **확대**해 버리는 역전을 막는다.
    const floor = Math.min(ZOOM_MIN, state.scale);
    const next = Math.min(ZOOM_MAX, Math.max(floor, state.scale * factor));
    if (next === state.scale) return;
    const ratio = next / state.scale;
    state.x = originX - ((originX - state.x) * ratio);
    state.y = originY - ((originY - state.y) * ratio);
    state.scale = next;
    applyOrgTransform(viewport, state);
  }

  function orgStateFor(key) {
    if (!orgViewState.has(key)) orgViewState.set(key, { scale: 1, x: 0, y: 0, fitted: false });
    return orgViewState.get(key);
  }

  function wireOrgView(viewport) {
    if (!viewport || typeof viewport.addEventListener !== 'function') return;
    const key = viewport.dataset?.orgView || '';
    const state = orgStateFor(key);
    if (state.fitted) applyOrgTransform(viewport, state);
    else {
      fitOrgView(viewport, state);
      state.fitted = true;
    }

    const centerOf = () => [(viewport.clientWidth || 0) / 2, (viewport.clientHeight || 0) / 2];

    // 조직도 위의 휠은 확대에 쓴다. 컨테이너 밖 페이지 스크롤은 건드리지 않는다(계약 §4-3).
    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect?.() || { left: 0, top: 0 };
      const factor = Math.exp(-(event.deltaY || 0) * 0.0015);
      zoomOrgView(viewport, state, factor, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });

    let pointerId = null;
    let originX = 0;
    let originY = 0;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target?.closest?.('button')) return;
      pointerId = event.pointerId;
      originX = event.clientX - state.x;
      originY = event.clientY - state.y;
      orgPanning = true;
      viewport.classList?.add('is-panning');
      viewport.setPointerCapture?.(event.pointerId);
    });
    viewport.addEventListener('pointermove', (event) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      state.x = event.clientX - originX;
      state.y = event.clientY - originY;
      applyOrgTransform(viewport, state);
    });
    const endPan = (event) => {
      if (pointerId === null) return;
      viewport.releasePointerCapture?.(event.pointerId);
      pointerId = null;
      orgPanning = false;
      viewport.classList?.remove('is-panning');
    };
    viewport.addEventListener('pointerup', endPan);
    viewport.addEventListener('pointercancel', endPan);

    // 휠·드래그를 못 쓰는 입력(키보드)에도 같은 조작을 준다.
    viewport.addEventListener('keydown', (event) => {
      const [centerX, centerY] = centerOf();
      const moves = {
        ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0],
        ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP],
      };
      if (moves[event.key]) {
        event.preventDefault();
        state.x += moves[event.key][0];
        state.y += moves[event.key][1];
        applyOrgTransform(viewport, state);
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomOrgView(viewport, state, ZOOM_STEP, centerX, centerY);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomOrgView(viewport, state, 1 / ZOOM_STEP, centerX, centerY);
      } else if (event.key === '0') {
        event.preventDefault();
        fitOrgView(viewport, state);
      }
    });
  }

  function wireOrgViews(root) {
    for (const viewport of [...(root?.querySelectorAll?.('[data-org-view]') || [])]) {
      wireOrgView(viewport);
    }
    for (const button of [...(root?.querySelectorAll?.('[data-org-action]') || [])]) {
      if (typeof button.addEventListener !== 'function') continue;
      button.addEventListener('click', () => {
        const viewport = button.closest?.('.h-org')?.querySelector?.('[data-org-view]');
        if (!viewport) return;
        const state = orgStateFor(viewport.dataset?.orgView || '');
        const centerX = (viewport.clientWidth || 0) / 2;
        const centerY = (viewport.clientHeight || 0) / 2;
        if (button.dataset.orgAction === 'in') zoomOrgView(viewport, state, ZOOM_STEP, centerX, centerY);
        else if (button.dataset.orgAction === 'out') zoomOrgView(viewport, state, 1 / ZOOM_STEP, centerX, centerY);
        else fitOrgView(viewport, state);
      });
    }
  }

  // 탭을 바꾸면 그때 처음 보이는 조직도가 있다 — 아직 맞춰지지 않은 것만 화면에 맞춘다.
  function fitPendingOrgViews(root) {
    for (const viewport of [...(root?.querySelectorAll?.('[data-org-view]') || [])]) {
      const state = orgStateFor(viewport.dataset?.orgView || '');
      if (state.fitted && (viewport.clientWidth || 0) > 0 && state.scale > 0) continue;
      fitOrgView(viewport, state);
      state.fitted = true;
    }
  }

  // ---- 세션 본문 -----------------------------------------------------------

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

  function renderTaskFacts(task) {
    return `
      <dl class="h-task-facts">
        <div><dt>현재</dt><dd>${escapeHtml(task.current || '상태 보고 대기')}</dd></div>
        <div><dt>완료</dt><dd>${escapeHtml(task.done || '아직 없음')}</dd></div>
        <div><dt>다음</dt><dd>${escapeHtml(task.next || '아직 없음')}</dd></div>
      </dl>`;
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

  function renderTask(task, now) {
    const updated = relativeTime(task.updated_at, now);
    const complete = task.status === 'complete';
    const presentation = taskPresentation(task);
    const progress = Math.round(clampPercent(Number(task.progress) || 0));
    const deltas = sessionUsageDeltas(task);
    const meta = [
      updated ? `${updated} 동기화` : '동기화 시각 없음',
      `${taskCategory(task).label} · 진행 ${progress}%`,
      task.deadline ? `마감 ${task.deadline}` : '',
    ].filter(Boolean).join(' · ');
    return `
      <article class="h-task${complete ? ' is-complete' : ''}">
        <header class="h-task-head">
          <div>
            <p class="us-eyebrow">${complete ? 'COMPLETED SESSION' : 'SELECTED SESSION'}</p>
            <h3>${escapeHtml(presentation.name)}</h3>
            <p class="h-task-meta">${escapeHtml(meta)}</p>
            ${deltas.length ? `<p class="h-task-usage">이 세션 소모 · ${escapeHtml(deltas.join(' · '))}</p>` : ''}
          </div>
          <div class="h-task-badges">
            <span class="h-task-state"><span class="status-dot${complete ? ' is-idle' : ' is-accent'}" aria-hidden="true"></span>${complete ? '완료' : '진행 중'}</span>
          </div>
        </header>
        ${renderTaskFacts(task)}
        ${renderModules(task)}
        ${renderOrgCanvas(`session:${task.id || presentation.name}`, `${presentation.name} 실행 조직도`, renderTree(sessionTreeNodes(task, now)))}
        ${renderArtifacts(task)}
      </article>`;
  }

  function renderPortfolioOrg(inputTasks, now) {
    const tasks = sortTasks(Array.isArray(inputTasks) ? [...inputTasks] : []);
    if (tasks.length === 0) return '<p class="us-empty card">아직 동기화된 파이프라인이 없습니다.</p>';
    return `
      <div class="h-portfolio">
        ${renderOrgCanvas('portfolio', '전체 세션과 실제 에이전트 조직도', renderTree(portfolioTreeNodes(tasks, now)))}
      </div>`;
  }

  function renderTaskTabs(tasks, now, status) {
    const selectedIndex = Math.max(0, tasks.findIndex((task) => task.id === selectedTaskIds[status]));
    return `
      <div class="h-session-switcher" data-session-switcher="${status}">
        <div class="h-session-tabs" role="tablist" aria-label="${status === 'complete' ? '완료된' : '진행 중인'} Codex 세션" data-task-tablist>
          ${tasks.map((task, index) => {
    const selected = index === selectedIndex;
    const category = taskCategory(task);
    const progress = Math.round(clampPercent(Number(task.progress) || 0));
    const presentation = taskPresentation(task);
    return `
            <button class="h-session-tab${selected ? ' is-selected' : ''}" type="button" role="tab"
              id="hSessionTab-${status}-${index}" aria-controls="hSessionPanel-${status}-${index}" aria-selected="${selected}"
              tabindex="${selected ? '0' : '-1'}" data-task-tab="${index}" data-task-id="${escapeHtml(task.id || String(index))}" data-task-status="${status}">
              <span class="h-session-tab-copy">
                <strong>${escapeHtml(presentation.name)}</strong>
                <small class="h-session-tab-meta"><span>${escapeHtml(category.label)} · ${escapeHtml(currentPhaseLabel(task, now))} ${progress}%</span>${renderTaskDate(task)}</small>
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
        <div class="h-session-view-tabs segmented" role="tablist" aria-label="작업 상태별 보기" data-session-view-tablist>
          ${views.map((view) => {
    const selected = view.key === selectedSessionView;
    return `<button class="segmented-btn h-session-view-tab${selected ? ' is-selected' : ''}" type="button" role="tab"
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
    const bySource = new Map((Array.isArray(rawSnapshots) ? rawSnapshots : [])
      .filter((snapshot) => snapshot && SOURCE_LABELS[snapshot.source])
      .map((snapshot) => [snapshot.source, snapshot]));
    // 한 번도 수집된 적이 없으면 빈 카드를 두 장 세우지 않고 한 줄로 말한다.
    const quotas = bySource.size === 0
      ? '<p class="us-empty">아직 수집된 한도 기록이 없습니다.</p>'
      : Object.keys(SOURCE_LABELS).map((source) => (bySource.has(source)
        ? renderQuota(bySource.get(source), now)
        : renderQuotaPlaceholder(source))).join('');
    const tasks = sortTasks(rawTasks);
    return `
      <div class="us-command-layout">
        <section class="us-pipeline-workspace" aria-labelledby="harnessTitle">
          <h2 id="harnessTitle" class="sr-only">실행 파이프라인</h2>
          <div class="h-session-list">${renderSessionViews(tasks, now)}</div>
        </section>
        <aside class="us-quota-rail" aria-labelledby="quotaTitle">
          <header class="us-quota-head">
            <div><p class="us-eyebrow">ACCOUNT</p><h2 id="quotaTitle" class="title-3">Codex · Claude 한도</h2></div>
            <p>실제 계정 보고</p>
          </header>
          <div class="us-quota-list">${quotas}</div>
        </aside>
      </div>`;
  }

  // ---- 탭 배선 -------------------------------------------------------------

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
    fitPendingOrgViews(root);
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
    fitPendingOrgViews(root);
    if (moveFocus) tab.focus();
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
    wireOrgViews(root);
  }

  // ---- 자동 갱신 -----------------------------------------------------------

  let pollTimer = null;
  let freshnessTimer = null;
  let lastSyncAt = 0;
  let lastSignature = '';
  let activeSessionCount = 0;
  let inFlight = false;

  function isHidden() {
    return document.visibilityState === 'hidden' || document.hidden === true;
  }

  function pollDelay() {
    return activeSessionCount > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS;
  }

  function renderFreshness() {
    if (!elements.freshness) return;
    if (!lastSyncAt) {
      elements.freshness.textContent = '';
      return;
    }
    const seconds = Math.max(0, Math.round((Date.now() - lastSyncAt) / 1000));
    const elapsed = seconds < 60 ? `${seconds}초 전` : `${formatDuration(seconds * 1000)} 전`;
    const cadence = isHidden() ? '자동 갱신 멈춤' : `${Math.round(pollDelay() / 1000)}초 주기`;
    elements.freshness.textContent = `마지막 갱신 ${elapsed} · ${cadence}`;
  }

  function scheduleFreshnessTick() {
    clearTimeout(freshnessTimer);
    freshnessTimer = null;
    renderFreshness();
    if (isHidden()) return;
    freshnessTimer = setTimeout(scheduleFreshnessTick, FRESHNESS_TICK_MS);
  }

  function scheduleNextPoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    // 탭이 숨으면 폴링을 멈춘다 — 보이지 않는 화면 때문에 한도를 쓰지 않는다(계약 §4-4).
    if (isHidden()) return;
    pollTimer = setTimeout(() => { void load(); }, pollDelay());
  }

  function renderDashboard(data, { announce }) {
    const tasks = sortTasks(Array.isArray(data?.tasks) ? data.tasks : []);
    activeSessionCount = tasks.filter((task) => task.status !== 'complete').length;
    // 조직도를 끌고 있는 중이면 DOM을 갈아 끼우지 않는다 — 다음 주기에 반영된다.
    if (orgPanning && !announce) return;
    const signature = JSON.stringify(data ?? null);
    // 바뀐 것이 없으면 다시 그리지 않는다: 초점·선택·확대 상태를 흔들지 않기 위해서다.
    if (!announce && signature === lastSignature && elements.body.innerHTML) return;
    lastSignature = signature;
    elements.body.innerHTML = buildDashboard(data, Date.now());
    wireDashboard(elements.body);
  }

  async function load({ announce = false } = {}) {
    if (inFlight) return;
    inFlight = true;
    elements.error.textContent = '';
    if (announce) {
      elements.reload.disabled = true;
      elements.reload.textContent = '불러오는 중…';
      if (elements.refreshStatus) elements.refreshStatus.textContent = '최신 정보를 확인하고 있습니다.';
    }
    try {
      const data = await api('/api/usage');
      lastSyncAt = Date.now();
      renderDashboard(data, { announce });
      if (announce) {
        elements.reload.textContent = '업데이트됨';
        if (elements.refreshStatus) elements.refreshStatus.textContent = '서버에서 방금 확인했습니다.';
      }
    } catch (error) {
      if (error.message === 'unauthorized') return;
      if (!announce) elements.body.innerHTML = elements.body.innerHTML || '';
      elements.error.textContent = error.message || '사용량을 불러오지 못했습니다.';
      if (announce) {
        elements.reload.textContent = '새로고침';
        if (elements.refreshStatus) elements.refreshStatus.textContent = '업데이트하지 못했습니다.';
      }
    } finally {
      inFlight = false;
      if (announce) elements.reload.disabled = false;
      scheduleNextPoll();
      scheduleFreshnessTick();
    }
  }

  elements.reload.addEventListener('click', () => load({ announce: true }));
  document.addEventListener('visibilitychange', () => {
    if (isHidden()) {
      clearTimeout(pollTimer);
      clearTimeout(freshnessTimer);
      pollTimer = null;
      freshnessTimer = null;
      renderFreshness();
      return;
    }
    void load();
  });
  load();

  window.USAGE_RENDER = {
    buildDashboard, renderSessionViews, renderSessionView, renderPortfolioOrg, renderTask,
    sessionTreeNodes, portfolioTreeNodes, phaseTimeline, sessionUsageDeltas,
    activateTaskTab, wireTaskTabs, activateSessionView, wireSessionViews, wireDashboard,
    wireOrgViews, fitPendingOrgViews, fitOrgView, zoomOrgView, orgViewState, load,
  };
})();
