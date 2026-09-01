(() => {
  'use strict';

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
  // 요청 원문이 없는 세션의 판정과 그 사유. 판정('기록 없음')만 적으면 화면의 고장인지
  // 보고가 안 온 것인지 구별되지 않으므로 사유를 짝지어 낸다(단계의 '기록 없음'과 같은 규칙).
  const TASK_INPUT_EMPTY_LABEL = '기록 없음';
  const TASK_INPUT_MISSING_REASON = '이 세션은 요청 원문을 보고하지 않았습니다';
  // 오른쪽 rail이 그리는 수집 원본. **키 순서가 곧 표시 순서**이고, 여기 없는 source는
  // 그리지 않는다 — 원본이 늘면 이 사전 한 줄만 고친다.
  const SOURCE_LABELS = { codex: 'Codex', claude: 'Claude' };
  // 세션 상태의 **단일 원본**. 서버는 `active|complete`만 저장하고, 조회 API가
  // heartbeat가 끊긴 active를 `stale`로 파생해 돌려준다(worker effectiveHarnessStatus).
  // 화면은 그 셋을 각각 다른 말로 부른다 — 예전에는 "complete가 아니면 전부 진행 중"이라
  // 이틀 전에 멈춘 세션도 진행 중으로 서 있었다(조사 §d의 false positive).
  const TASK_STATUS_LABELS = { active: '진행 중', stale: '중단됨', complete: '완료' };
  // 상태 점의 색. 상태색은 상태 표시에만 쓴다(DESIGN.md §3) — 중단은 경고, 진행은 강조,
  // 완료는 무채색이다.
  const TASK_STATUS_TONE = { active: ' is-accent', stale: ' is-warn', complete: ' is-idle' };
  // 커널 상태 보고는 사용자가 연 실행 세션이 아니므로 목록에서 제외한다.
  const RESIDENT_TASK_IDS = new Set(['kernel-state']);

  function isResidentTask(task) {
    return RESIDENT_TASK_IDS.has(String(task?.id ?? '').trim());
  }

  // 실행 현황이 보는 작업 집합. **탭 개수·목록·폴링 주기가 모두 이 한 함수를 지난다** —
  // 한 곳에서만 거르면 "탭은 1이라는데 목록은 비었다" 같은 어긋남이 생긴다.
  function sessionTasks(tasks) {
    return (Array.isArray(tasks) ? tasks : []).filter((task) => task && !isResidentTask(task));
  }
  // 수집 원본의 건강 상태. `outcome`이 가질 수 있는 값은 Worker가 닫아 둔 집합
  // (`success|no-data|failed`)과 Worker 자신이 붙이는 `stale`, 그리고 health 행이 없는
  // 구 스냅샷의 `legacy`뿐이다 — 여기 없는 값이 오면 서버 문자열을 그대로 보여 준다.
  const HEALTH_OUTCOME_LABELS = {
    success: '성공',
    'no-data': '원본 없음',
    failed: '전송 실패',
    stale: '이전 값보다 오래됨',
    legacy: '기록 이전',
  };
  // 수집 SLO. STALE_MS(15분)는 "값이 조금 낡았다"는 표시이고, 이쪽은 **수집이 멈췄다**는
  // 판정이다. 두 문턱을 하나로 합치면 잠깐 늦은 것과 반나절 멎은 것이 같은 말로 나온다.
  const HEALTH_SLO_MS = 30 * 60 * 1000;
  // 세션 한도 소모가 읽는 이벤트 필드 ↔ 표시 라벨. 위 SOURCE_LABELS와 짝을 이룬다.
  const USAGE_DELTA_FIELDS = [['usage_codex', 'Codex'], ['usage_claude', 'Claude']];
  // 알려진 버킷 키의 한국어 라벨. 렌더 대상 목록이 아니라 사전이다 — payload에 실제로
  // 들어 있는 키를 전부 그리고, 여기 없는 키는 키 문자열 그대로 나간다.
  const BUCKET_LABELS = {
    primary: '기본 사용량',
    secondary: '추가 사용량',
    five_hour: '5시간',
    seven_day: '주간',
    seven_day_opus: '주간 (Opus)',
  };
  const ACTOR_STATUS_LABELS = {
    working: '작업 중', reviewing: '검토 중', waiting: '대기',
    done: '완료', blocked: '막힘', unavailable: '사용 불가',
  };
  // 게시글 목록(완료·중단)은 기본 최근 10개만 세운다. 서버가 completed_limit로 잘라 주지
  // 않아도 화면이 스스로 접는다 — 클라이언트 접기가 1차 방어다.
  const POST_PAGE_SIZE = 10;
  // 상위 탭은 **진행 중 / 완료** 둘뿐이다 (계약 §A). '관제탑'은 상위 탭이 아니라
  // 진행 중 패널 안의 **보기 모드**가 됐다 — 같은 세션 집합을 두 어법으로 볼 뿐이고,
  // 세션의 상태(진행/완료)와는 다른 축이기 때문이다. 예전처럼 셋을 한 줄에 늘어놓으면
  // "관제탑에는 완료도 들어 있다"는 세 번째 범위가 생겨 축이 뒤섞인다.
  // 상위 탭은 **세션 상태 그 자체**다 — TASK_STATUS_LABELS에서 도출하므로 상태가 늘면
  // 탭도 함께 는다(LESSONS "파생 가능한 것을 손으로 적지 않는다"). '관제탑'은 상위 탭이
  // 아니라 진행 중 패널 안의 보기 모드다: 같은 세션 집합을 두 어법으로 볼 뿐이고,
  // 세션의 상태와는 다른 축이기 때문이다.
  const SESSION_VIEWS = Object.entries(TASK_STATUS_LABELS).map(([key, label]) => ({ key, label }));
  const SESSION_VIEW_KEYS = new Set(SESSION_VIEWS.map((view) => view.key));
  // 소유자 응답을 받은 뒤에만 세우는 문서 제목. 정지 HTML의 제목은 랜딩과 같은 값이라
  // 미로그인 방문자에게는 이 화면의 존재가 제목으로도 새지 않는다 (review-visual N7).
  const OWNER_TITLE = '사용량 — hvsdcm';

  const elements = {
    body: document.getElementById('usageBody'),
    error: document.getElementById('usageError'),
    reload: document.getElementById('reload'),
    refreshStatus: document.getElementById('usageRefreshStatus'),
    freshness: document.getElementById('usageFreshness'),
  };
  let selectedSessionView = 'active';
  const selectedTaskIds = { active: '', complete: '' };
  // 화면-로컬 상태. 폴링이 DOM을 갈아 끼워도 유지돼야 하므로 모듈 변수로 둔다.
  // 게시글 목록은 상태마다 따로 편다 — 하나의 카운터를 공유하면 완료에서 누른 '더 보기'가
  // 중단 목록까지 함께 펴 버린다.
  const postVisible = { stale: POST_PAGE_SIZE, complete: POST_PAGE_SIZE };

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

  async function requestUsage(path, signal, options = {}) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(`${API_URL}${path}${separator}_=${Date.now()}`, {
      ...options,
      cache: 'no-store',
      signal,
      headers: {
        ...options.headers,
        authorization: `Bearer ${localStorage.getItem('hvsdcm.token') || ''}`,
      },
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

  function api(path, options = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    return withTimeout(
      requestUsage(path, controller?.signal, options),
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
  //
  // capturedAt은 **그룹 자신의 수집 시각**이고, 없으면 null이다(아래 수집 시각 계약).
  function groupsOf(payload) {
    if (!payload || typeof payload !== 'object') return [];
    if (payload.models && typeof payload.models === 'object') {
      return Object.entries(payload.models)
        .filter(([, model]) => model && typeof model === 'object')
        .map(([id, model]) => ({
          label: id,
          buckets: model.rate_limits,
          capturedAt: model.captured_at ?? null,
        }));
    }
    if (!payload.rate_limits || typeof payload.rate_limits !== 'object') return [];
    const plan = String(payload.plan_type || '').trim().toLowerCase();
    const planLabels = {
      pro: 'ChatGPT Pro', plus: 'ChatGPT Plus', business: 'ChatGPT Business',
      team: 'ChatGPT Team', enterprise: 'ChatGPT Enterprise', free: 'ChatGPT Free',
    };
    // codex payload는 계정이 하나뿐이라 그룹별 시각을 싣지 않는다 — 행 시각이 곧 이 계정의 시각이다.
    return [{ label: planLabels[plan] || 'Codex 계정', buckets: payload.rate_limits, capturedAt: null }];
  }

  // 게이지 한 줄의 이름은 **창(window)의 이름**이고, 어느 계정의 창인지는 renderQuota가
  // 원본 이름을 앞에 붙여 완성한다 — 'Claude 주간' · 'Claude 5시간' · 'Codex 주간'
  // (사용자 지시 ②). 예전에는 '주간 사용량'만 적혀 있어서, 카드 머리를 놓치면 그 게이지가
  // 어느 계정 것인지 화면 어디에도 없었다.
  function bucketLabel(key, windowMinutes) {
    if (windowMinutes === 300) return '5시간';
    if (windowMinutes === 10_080) return '주간';
    if (Number.isFinite(windowMinutes) && windowMinutes > 0) {
      return formatDuration(windowMinutes * 60_000);
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

  // 게이지 한 줄. 제목은 `<원본> <창>`이고(사용자 지시 ②), 그 원본의 수집이 낡았으면
  // **그 줄 옆에서** 수집원과 경과 시간을 밝힌다 — 카드 머리의 '수집 지연' 한 줄만으로는
  // 어느 게이지가 낡은 값인지 게이지를 보는 눈높이에서 알 수 없다.
  function renderQuotaRow(bucket, now, sourceLabel = '', staleNote = '') {
    const hasPercent = bucket.percent !== null;
    const percent = hasPercent ? clampPercent(bucket.percent) : 0;
    const tone = percent >= OVER_PERCENT ? ' is-over' : percent >= WARN_PERCENT ? ' is-warn' : '';
    const reset = relativeTime(bucket.resetsAt, now);
    const sub = [
      reset
        ? `${reset} 초기화`
        : bucket.windowMinutes
          ? `${formatDuration(bucket.windowMinutes * 60_000)} 창`
          : '',
      staleNote,
    ].filter(Boolean).join(' · ');
    const title = [sourceLabel, bucket.label].filter(Boolean).join(' ');
    return `
      <div class="list-row">
        <span class="list-row-body">
          <span class="list-row-title">${escapeHtml(title)}</span>
          ${hasPercent
    ? `<span class="gauge-track" aria-hidden="true"><span class="gauge-fill${tone}" style="width: ${percent.toFixed(1)}%"></span></span>`
    : ''}
          ${sub ? `<span class="list-row-sub">${escapeHtml(sub)}</span>` : ''}
        </span>
        <span class="list-row-value">${hasPercent ? `${Math.round(percent)}%` : '기록 없음'}</span>
      </div>`;
  }

  // ---- 수집 시각 계약 (2026-08-28 정합 수정) --------------------------------
  //
  // 시각의 원본이 두 층이다.
  //   · **행 시각** `snapshot.captured_at` — D1 usage_snapshots 한 행의 시각.
  //     수집기가 그 원본 전체를 마지막으로 갱신한 시점이다.
  //   · **그룹 시각** payload 안의 계정·모델별 `captured_at` — claude payload의
  //     `models[<id>].captured_at`이 이것이다. codex payload에는 없다(계정이 하나뿐이라
  //     행 시각이 곧 그 계정의 시각이다).
  //
  // 표시는 **그룹이 기준**이다. 그룹마다 자기 시각으로 지연을 판정하고, 카드 머리에는
  // 그중 **가장 신선한** 시각을 쓴다. 낡은 그룹 하나를 카드 대표로 삼으면 분 단위로
  // 갱신되는 원본이 화면에서 "몇 시간 전 · 수집 지연"으로 보이고(실측된 결함),
  // 반대로 카드 머리 하나만 두면 실제로 멈춘 모델이 신선한 모델 뒤에 숨는다.
  // 그룹 시각이 아예 없는 원본(codex)은 그룹이 행 시각을 물려받고, 같은 값을 카드
  // 머리와 그룹에 두 번 적지 않는다.
  function quotaGroupOf(group, rowCapturedAt, now) {
    const ownTime = parseTime(group.capturedAt);
    const time = ownTime === null ? parseTime(rowCapturedAt) : ownTime;
    return {
      ...group,
      rows: bucketsOf(group),
      hasOwnTime: ownTime !== null,
      time,
      captured: time === null ? null : relativeTime(time, now),
      stale: time !== null && now - time > STALE_MS,
    };
  }

  function renderCaptureMeta(captured, stale) {
    return `<span class="us-card-meta">${captured ? escapeHtml(`${captured} 수집`) : '수집 시각 없음'}${stale ? ' · 수집 지연' : ''}</span>`;
  }

  // ---- 수집 건강 상태 (조사 §f) ---------------------------------------------
  //
  // 게이지의 숫자는 **원본이 살아 있을 때만** 참이다. 그런데 예전 화면에는 마지막 수집
  // 시각 하나뿐이라, 수집기가 며칠 멎어도 "3일 전 수집"이라는 사실 문장만 있고 그것이
  // 정상인지 고장인지 판정이 없었다. 이제 조회 API가 source마다 마지막 성공·마지막 시도·
  // 그 시도의 결과를 함께 준다(worker usage_source_health). 셋을 그대로 보여 주고,
  // 마지막 **성공**이 SLO를 넘기면 그것을 고장으로 판정해 눈에 띄게 가른다.
  //
  // 이 표시가 **못 보는 것**: 수집기가 아예 실행되지 않아 시도조차 기록되지 않은 경우와
  // 성공했지만 값이 틀린 경우. 앞의 것은 '마지막 시도'가 함께 늙는 것으로만 드러난다.
  function healthOutcomeLabel(outcome) {
    const key = String(outcome ?? '').trim();
    if (!key) return '';
    return HEALTH_OUTCOME_LABELS[key] || key;
  }

  // **필드 부재와 명시적 null은 다른 사실이다** (review 기능 B M-1).
  //   · `undefined` — health를 아예 싣지 않는 **구 응답**이다. 그 응답에서 이 화면이
  //     아는 유일한 성공 근거는 행 시각(captured_at)뿐이므로 거기로 떨어진다. 그러지
  //     않으면 2분 전에 수집된 스냅샷이 곧장 '30분 넘게 수집 성공 없음'으로 고발된다.
  //   · `null` — 서버가 health를 싣고 "성공 기록이 없다"고 **말한** 것이다. 이때
  //     captured_at으로 덮으면 서버의 판정을 화면이 지운다.
  function healthTime(value, fallback) {
    return value === undefined ? parseTime(fallback) : parseTime(value);
  }

  function renderQuotaHealth(snapshot, now) {
    const success = healthTime(snapshot?.last_success_at, snapshot?.captured_at);
    const attempt = healthTime(snapshot?.last_attempt_at, snapshot?.captured_at);
    const outcome = healthOutcomeLabel(snapshot?.last_outcome);
    // 성공 기록이 아예 없는 것도 SLO 위반이다 — "한 번도 못 받았다"가 "오래 못 받았다"보다
    // 나은 상태일 수 없다.
    const breached = success === null || now - success > HEALTH_SLO_MS;
    const rows = [
      ['마지막 수집 성공', success === null ? '기록 없음' : relativeTime(success, now)],
      // 시도의 결과를 시각 옆에 붙인다. 실패 원인을 따로 찾아가지 않고 여기서 읽힌다.
      ['마지막 시도', attempt === null
        ? '기록 없음'
        : [relativeTime(attempt, now), outcome].filter(Boolean).join(' · ')],
    ];
    // 문턱 문구는 상수에서 도출한다 — 숫자를 문장에 손으로 적으면 상수를 고쳐도 화면은
    // 옛 숫자를 계속 말한다.
    const alert = `${formatDuration(HEALTH_SLO_MS)} 넘게 수집 성공 없음`;
    return `
      <dl class="us-health${breached ? ' is-breached' : ''}">
        ${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
        ${breached
    ? `<div class="us-health-alert"><dt>수집 상태</dt><dd><span class="status-dot is-warn" aria-hidden="true"></span>${escapeHtml(alert)}</dd></div>`
    : ''}
      </dl>`;
  }

  function renderQuota(snapshot, now) {
    const label = SOURCE_LABELS[snapshot.source] || snapshot.source;
    const groups = groupsOf(snapshot.payload)
      .map((group) => quotaGroupOf(group, snapshot.captured_at, now))
      .filter((group) => group.rows.length > 0);
    // 그릴 그룹이 하나도 없으면 남는 근거는 행 시각뿐이다.
    const times = groups.map((group) => group.time).filter((time) => time !== null);
    const headTime = times.length ? Math.max(...times) : parseTime(snapshot.captured_at);
    const headCaptured = headTime === null ? null : relativeTime(headTime, now);
    const headStale = headTime !== null && now - headTime > STALE_MS;
    const body = groups.map((group) => {
      const head = !group.label
        ? ''
        : group.hasOwnTime
          ? `<div class="list-group-head-row"><p class="list-group-head">${escapeHtml(group.label)}</p>${renderCaptureMeta(group.captured, group.stale)}</div>`
          : `<p class="list-group-head">${escapeHtml(group.label)}</p>`;
      // 낡은 그룹의 게이지에는 수집원과 나이를 함께 적는다 (사용자 지시 ②).
      const staleNote = group.stale && group.captured ? `${label} ${group.captured} 수집` : '';
      return `
        <div class="us-group">
          ${head}
          <div class="list-group is-inset">${group.rows.map((bucket) => renderQuotaRow(bucket, now, label, staleNote)).join('')}</div>
        </div>`;
    }).join('');
    return `
      <article class="us-limit-widget">
        <header class="us-card-head">
          <h3 class="title-3">${escapeHtml(label)} 한도</h3>
          ${renderCaptureMeta(headCaptured, headStale)}
        </header>
        ${renderQuotaHealth(snapshot, now)}
        ${body || `<p class="us-empty">읽을 수 있는 ${escapeHtml(label)} 한도 정보가 없습니다.</p>`}
      </article>`;
  }

  // 원본 하나가 아직 한 번도 보고하지 않은 상태. 카드를 통째로 빼면 rail에서 그 원본이
  // 사라져 "한도가 0"인지 "수집이 멈췄는지" 구분되지 않으므로, 같은 골격의 빈 상태로 둔다.
  function renderQuotaPlaceholder(source) {
    const label = SOURCE_LABELS[source] || source;
    return `
      <article class="us-limit-widget">
        <header class="us-card-head">
          <h3 class="title-3">${escapeHtml(label)} 한도</h3>
          <span class="us-card-meta">수집 대기</span>
        </header>
        <p class="us-empty">아직 ${escapeHtml(label)} 스냅샷이 없습니다.</p>
      </article>`;
  }

  // ---- task / event 판독 ---------------------------------------------------

  function taskModules(task) {
    return Array.isArray(task?.modules)
      ? task.modules.filter((module) => module && typeof module === 'object')
      : [];
  }

  function actorStatus(actor) {
    return ACTOR_STATUS_LABELS[actor.status] || actor.status || '상태 미기록';
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

  // 날짜는 **한국 시간(KST) 기준**이다 (review WP3 major 5).
  // toISOString()은 UTC라, 한국 시간 자정 직후(00:00~09:00)에 끝난 세션이 전날 날짜로
  // 묶였다 — 한국어 서비스의 완료 기록이 매일 아홉 시간씩 어제로 밀리는 체계적 오분류다.
  // 한국은 1988년 이후 서머타임이 없어 고정 +09:00이 곧 정확한 변환이고, 그래서
  // Intl 없이 오프셋 한 번으로 끝난다(브라우저 로캘·타임존 설정에 좌우되지 않는다).
  const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;

  function seoulDateKey(time) {
    return new Date(time + SEOUL_OFFSET_MS).toISOString().slice(0, 10);
  }

  // 화면에 서는 이름에는 축약어를 남기지 않는다 (사용자 지시 ③ / review R2-1).
  // 축약어마다 사전을 손으로 적으면 원본과 어긋나는 사본이 생기므로(LESSONS
  // "파생 가능한 것을 손으로 적지 않는다") **패턴 규칙**으로 도출한다 — WP 뒤의 숫자는
  // 그 숫자 그대로 '작업 묶음 N'이 되며, 새 번호가 생겨도 손댈 곳이 없다.
  // 원문(rawName)은 지우지 않고 내부 필드로 남아 식별자로 쓰인다.
  const NAME_EXPANSIONS = [
    // WP1 · WP-2 · wp 3 → '작업 묶음 1'. 풀어 쓴 머리말이 이름 맨 앞에 서면 나머지와
    // 층이 달라지므로 em dash로 가른다 ('작업 묶음 1 서버'는 한 덩어리로 읽힌다).
    {
      pattern: /\bWP[\s._-]*(\d+)(\s*)/giu,
      expand: (match, digits, gap, offset, whole) => {
        const rest = whole.slice(offset + match.length);
        if (!gap || !rest) return `작업 묶음 ${digits}`;
        return `작업 묶음 ${digits}${offset === 0 ? ' — ' : ' '}`;
      },
    },
  ];

  function expandAbbreviations(name) {
    let expanded = name;
    for (const rule of NAME_EXPANSIONS) expanded = expanded.replace(rule.pattern, rule.expand);
    return expanded.trim();
  }

  // 사람이 읽는 시각. 게시글 목록의 행은 날짜만으로는 같은 날 여러 세션을 가를 수 없어
  // **시:분까지** 적는다. 축은 taskPresentation·groupTasksByDate와 같은 한국 시간이다.
  function seoulStamp(time) {
    if (time === null || !Number.isFinite(time)) return null;
    const shifted = new Date(time + SEOUL_OFFSET_MS).toISOString();
    return {
      datetime: `${shifted.slice(0, 16)}+09:00`,
      label: `${shifted.slice(5, 7)}.${shifted.slice(8, 10)} ${shifted.slice(11, 16)}`,
    };
  }

  // 보고에 실린 요청 원문. 값이 없는 것과 빈 문자열을 같게 다룬다 — 어느 쪽이든 화면이
  // 아는 사실은 "요청 원문이 오지 않았다" 하나뿐이다.
  function taskInput(task) {
    return typeof task?.input === 'string' ? task.input.trim() : '';
  }

  // 카드 제목의 **정본은 보고의 title**이다 (계약: 사용자 지정 프로젝트 제목).
  //
  // 다만 Worker는 하위 호환을 위해 title이 없는 구 payload에 `name`을 그대로 채워 준다
  // (router.js hydrated.title = payload.title || row.title || payload.name). 그래서 title
  // 값 하나만으로는 사람이 지은 제목인지 세션 이름에서 파생된 것인지 갈리지 않는다.
  //
  // 이제 **출처를 서버가 말한다**: `title_authored === true`면 그 값이 곧 정본이므로
  // 어떤 손질도 하지 않는다 — 지정한 제목이 마침 name과 같아도 마찬가지다
  // (review 기능 B M-2: `name === title === 'WP2 관제탑 (08-29)'`가 '작업 묶음 2 — 관제탑'
  // 으로 바뀌던 결함). 플래그를 싣지 않는 구 응답만 예전 추정(`name과 다른가`)으로
  // 떨어진다 — 그 응답에는 다른 근거가 없고, 이 추정이 옛 화면과 같은 결과를 준다.
  function taskPresentation(task) {
    const rawName = String(task?.name || '').trim();
    const rawTitle = String(task?.title || '').trim();
    const authored = rawTitle && (task?.title_authored === true || rawTitle !== rawName)
      ? rawTitle
      : '';
    const suffix = rawName.match(/\s*\((\d{2})-(\d{2})\)\s*$/u);
    const trimmed = suffix ? rawName.slice(0, suffix.index).trim() : rawName;
    const name = authored || expandAbbreviations(trimmed) || '이름 없는 작업';
    const time = parseTime(task?.updated_at);
    const dateTime = time === null ? '' : seoulDateKey(time);
    const dateLabel = suffix
      ? `${suffix[1]}.${suffix[2]}`
      : dateTime
        ? `${dateTime.slice(5, 7)}.${dateTime.slice(8, 10)}`
        : '';
    // rawName은 화면에 쓰지 않는다 — 보고가 준 원문 그대로의 내부 식별자다.
    return { name, rawName, dateTime, dateLabel };
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

  // 세션 상태를 화면이 아는 셋 중 하나로 좁힌다. 조회 API가 이미 `active|stale|complete`로
  // 파생해 주므로 여기서 시간을 다시 재지 않는다 — 문턱을 두 곳에서 계산하면 서버가
  // 중단이라 부른 세션을 화면이 진행 중으로 그리는 어긋남이 생긴다. 모르는 값은
  // 진행 중으로 떨어뜨린다: 보고가 살아 있다는 사실 자체는 참이기 때문이다.
  function taskStatusKey(task) {
    const status = String(task?.status ?? '').trim();
    return Object.prototype.hasOwnProperty.call(TASK_STATUS_LABELS, status) ? status : 'active';
  }

  // 완료 시각. WP1이 붙이는 completed_at이 원본이고, 없으면 마지막 동기화 시각으로
  // 떨어진다 — 구 payload도 같은 축에서 정렬·묶기 된다.
  function completedTime(task) {
    return parseTime(task?.completed_at) ?? parseTime(task?.updated_at) ?? 0;
  }

  // 완료 목록을 날짜별로 묶는다. 키는 완료 시각의 **한국 시간** 날짜이고(seoulDateKey),
  // 순서는 최신 날짜부터다. 탭의 날짜 표기(taskPresentation)와 같은 변환을 쓴다 — 두
  // 표기가 다른 축을 쓰면 08.28 그룹 안에 08.27 탭이 서는 모순이 생긴다.
  function groupTasksByDate(tasks) {
    const groups = new Map();
    for (const task of tasks) {
      const time = completedTime(task);
      const key = time ? seoulDateKey(time) : '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    }
    return [...groups].map(([key, items]) => ({
      key,
      label: key ? `${key.slice(0, 4)}.${key.slice(5, 7)}.${key.slice(8, 10)}` : '날짜 기록 없음',
      tasks: items,
    }));
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

  // ---- 세션 본문 -----------------------------------------------------------

  function renderModules(task) {
    const modules = taskModules(task);
    if (modules.length === 0) return '';
    return `
      <section class="h-modules" aria-label="모듈별 진행도">
        <header class="h-modules-head">
          <div><p class="us-eyebrow">모듈</p><h4>모듈별 진행도</h4></div>
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

  // 요청 원문 블록. 상세를 여는 사람의 첫 질문은 "이 세션이 무슨 요청이었나"이므로 본문
  // 맨 위에 둔다. 원문은 줄바꿈이 의미를 갖는 사용자 글이라 그대로 접어 보여 준다(CSS
  // pre-wrap) — 한 줄로 눌러 붙이면 목록·문단이 뭉개진다.
  function renderTaskInput(task) {
    const input = taskInput(task);
    return `
      <section class="h-task-input" aria-label="요청 원문">
        <p class="us-eyebrow">요청 원문</p>
        ${input
    ? `<div class="inset h-task-input-body">${escapeHtml(input)}</div>`
    : `<p class="h-task-input-empty">${escapeHtml(TASK_INPUT_EMPTY_LABEL)} · ${escapeHtml(TASK_INPUT_MISSING_REASON)}</p>`}
      </section>`;
  }

  // 현재·완료·다음은 **라벨-값 세 줄**이지 요약 스트립이 아니다 (review-visual M3).
  // 예전에는 이 셋이 가로 3칸 타일이었고, 완료 목록에서 펴면 필터 칩('완료 10')·행
  // 배지('완료')·이 타일('완료 / 기계 게이트 통과')이 한 화면에서 같은 말을 세 번 했다.
  // DESIGN.md §1.1은 usage가 요약 스트립을 쓰지 않는다고 못 박았으므로 타일을 걷고
  // 헤어라인 없는 정의 목록으로 낮춘다 — 값은 하나도 잃지 않는다.
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
        <span class="h-evidence-label">검증 자료</span>
        <div class="h-evidence-list">
          ${artifacts.map((artifact) => `<span>${escapeHtml(artifact)}</span>`).join('')}
        </div>
      </footer>`;
  }

  // 세션 상세의 **본문**. 머리(제목·상태·시각)와 나눠 둔 이유는 게시글 목록에서 그
  // 머리가 이미 목록 행으로 서 있기 때문이다 — 펼친 자리에 같은 제목과 상태를 한 번 더
  // 그리면 한 화면에 같은 사실이 두 번 나온다.
  function renderTaskBody(task, now) {
    const presentation = taskPresentation(task);
    return `
        ${renderTaskInput(task)}
        ${renderTaskFacts(task)}
        ${renderModules(task)}
        ${renderArtifacts(task)}`;
  }

  function renderTask(task, now) {
    const updated = relativeTime(task.updated_at, now);
    const statusKey = taskStatusKey(task);
    const complete = statusKey === 'complete';
    const presentation = taskPresentation(task);
    const progress = Math.round(clampPercent(Number(task.progress) || 0));
    const deltas = sessionUsageDeltas(task);
    const meta = [
      // 카드가 말하는 시각은 하네스의 **마지막 보고**다 (사용자 지시 ④ — 머리말의
      // 화면 갱신 시계와 같은 말('동기화')을 쓰면 두 값이 어긋난 것처럼 읽힌다).
      updated ? `마지막 보고 ${updated}` : '보고 시각 없음',
      `${taskCategory(task).label} · 진행 ${progress}%`,
      task.deadline ? `마감 ${task.deadline}` : '',
    ].filter(Boolean).join(' · ');
    return `
      <article class="h-task${complete ? ' is-complete' : ''}">
        <header class="h-task-head">
          <div>
            <p class="us-eyebrow">${complete ? '완료한 세션' : '선택한 세션'}</p>
            <h3>${escapeHtml(presentation.name)}</h3>
            <p class="h-task-meta">${escapeHtml(meta)}</p>
            ${deltas.length ? `<p class="h-task-usage">이 세션 소모 · ${escapeHtml(deltas.join(' · '))}</p>` : ''}
          </div>
          <div class="h-task-badges">
            <span class="h-task-state"><span class="status-dot${TASK_STATUS_TONE[statusKey]}" aria-hidden="true"></span>${TASK_STATUS_LABELS[statusKey]}</span>
          </div>
        </header>
        ${renderTaskBody(task, now)}
      </article>`;
  }


  // tabbable은 aria-selected와 **다른 사실**이다. 선택은 화면 전체에 하나뿐이지만,
  // 초점을 받을 수 있는 탭은 tablist마다 하나씩 있어야 한다 (review WP3 major 3).
  function renderTaskTab(task, index, selected, status, now, tabbable = selected) {
    const category = taskCategory(task);
    const progress = Math.round(clampPercent(Number(task.progress) || 0));
    const presentation = taskPresentation(task);
    return `
            <button class="h-session-tab${selected ? ' is-selected' : ''}" type="button" role="tab"
              id="hSessionTab-${status}-${index}" aria-controls="hSessionPanel-${status}-${index}" aria-selected="${selected}"
              tabindex="${tabbable ? '0' : '-1'}" data-task-tab="${index}" data-task-id="${escapeHtml(task.id || String(index))}" data-task-status="${status}">
              <span class="h-session-tab-copy">
                <strong>${escapeHtml(presentation.name)}</strong>
                <small class="h-session-tab-meta"><span>${escapeHtml(category.label)} · ${escapeHtml(currentPhaseLabel(task, now))} ${progress}%</span>${renderTaskDate(task)}</small>
              </span>
            </button>`;
  }

  // 세션 탭 묶음. 진행 중은 한 줄이고, 완료는 **날짜별 그룹**이 각자 tablist를 갖는다
  // (요구 6). 그룹 머리를 tablist 안에 끼우면 tab이 아닌 자식이 생겨 역할 계약이 깨지므로,
  // 그룹마다 tablist를 하나씩 둔다 — 패널은 스위처 하나가 공유한다.
  //
  // **tablist마다 tabindex="0"인 탭이 하나씩 있어야 한다** (review WP3 major 3).
  // 예전에는 선택된 탭 하나만 0을 받아, 두 번째 날짜 그룹부터는 tablist 전체가 초점을
  // 받을 수 없었다 — 방향키 이동도 tablist 안으로 제한돼 있어서 키보드 사용자는 그
  // 그룹의 세션을 아예 열 수 없었다. 선택(aria-selected)은 여전히 화면에 하나뿐이고,
  // 초점 진입점(roving tabindex)만 그룹마다 둔다.
  function renderTaskTabs(groups, now, status, footer = '') {
    const flat = groups.flatMap((group) => group.tasks);
    const selectedIndex = Math.max(0, flat.findIndex((task) => task.id === selectedTaskIds[status]));
    let cursor = -1;
    return `
      <div class="h-session-switcher" data-session-switcher="${status}">
        ${groups.map((group) => {
    const first = cursor + 1;
    const hasSelected = selectedIndex >= first && selectedIndex < first + group.tasks.length;
    return `
          ${group.label ? `<p class="list-group-head h-session-group-head">${escapeHtml(group.label)}</p>` : ''}
          <div class="h-session-tabs" role="tablist" aria-label="${escapeHtml(group.ariaLabel)}" data-task-tablist>
            ${group.tasks.map((task) => {
    cursor += 1;
    return renderTaskTab(
      task, cursor, cursor === selectedIndex, status, now,
      hasSelected ? cursor === selectedIndex : cursor === first,
    );
  }).join('')}
          </div>`;
  }).join('')}
        ${footer}
        <div class="h-session-panels">
          ${flat.map((task, index) => `
            <section class="h-session-panel" role="tabpanel" id="hSessionPanel-${status}-${index}"
              aria-labelledby="hSessionTab-${status}-${index}" data-task-panel="${index}"${index === selectedIndex ? '' : ' hidden'}>
              ${renderTask(task, now)}
            </section>`).join('')}
        </div>
      </div>`;
  }

  // ---- 게시글형 목록 (완료 · 중단) -----------------------------------------
  //
  // 끝난 세션은 **읽을거리**이지 조작 대상이 아니다. 예전에는 완료 목록도 진행 중과 같은
  // 수평 tablist였고, CSS가 `overflow-x: auto`라 실질은 캐러셀이었다 — 스무 개가 쌓이면
  // 옆으로 밀어야 보이고, 한 번에 한 세션의 상세만 열려 있었다(조사 §e).
  //
  // 이제는 최신이 위인 **세로 게시글 리스트**다. 한 행에 제목·상태·시각이 있고, 행을 펼치면
  // 그 자리에서 요청 원문과 단계가 나온다. 접힘은 `<details>`이므로 선택 상태를 화면이
  // 따로 들고 있지 않고(roving tabindex도, hidden 패널도 없다), 여러 개를 동시에 펼 수 있다.
  // 모양은 system.css의 `.disclosure` 프리미티브를 그대로 소비한다(DESIGN.md §7.2).
  // 상태 배지는 **목록에 상태가 섞여 있을 때만** 낸다 (review-visual M3).
  // 상위 탭이 상태를 이미 고정한 목록에서 행마다 같은 배지를 반복하면 그 열은 어떤
  // 판단도 돕지 않는 노이즈다 — 완료 10건 목록에 '완료'가 열 번 서던 화면이 그랬다.
  // 판정은 렌더 시점의 실제 데이터에서 도출한다: 목록이 실제로 혼재하면 다시 나온다.
  function renderPostRow(task, now, showStatus) {
    const presentation = taskPresentation(task);
    const statusKey = taskStatusKey(task);
    const stamp = seoulStamp(completedTime(task) || null);
    return `
          <details class="disclosure h-post" data-task-post="${escapeHtml(task.id || '')}">
            <summary class="disclosure-head h-post-head">
              ${showStatus
    ? `<span class="h-post-state"><span class="status-dot${TASK_STATUS_TONE[statusKey]}" aria-hidden="true"></span>${TASK_STATUS_LABELS[statusKey]}</span>`
    : ''}
              <span class="disclosure-title h-post-title">${escapeHtml(presentation.name)}</span>
              <span class="disclosure-hint h-post-when">${stamp
    ? `<time datetime="${escapeHtml(stamp.datetime)}">${escapeHtml(stamp.label)}</time>`
    : '시각 기록 없음'}</span>
            </summary>
            <div class="disclosure-body">${renderTaskBody(task, now)}</div>
          </details>`;
  }

  function renderPostList(groups, status, now, footer = '') {
    const states = new Set(groups.flatMap((group) => group.tasks.map(taskStatusKey)));
    const showStatus = states.size > 1;
    return `
      <div class="h-post-board" data-post-list="${escapeHtml(status)}">
        ${groups.map((group) => `
        ${group.label ? `<p class="list-group-head h-session-group-head">${escapeHtml(group.label)}</p>` : ''}
        <section class="h-post-group" aria-label="${escapeHtml(group.ariaLabel)}">
          ${group.tasks.map((task) => renderPostRow(task, now, showStatus)).join('')}
        </section>`).join('')}
        ${footer}
      </div>`;
  }

  // 진행 중 패널의 보기 모드 토글. system.css의 `.segmented`가 모양을 그리고, 여기서는
  // 어느 모드가 눌려 있는지만 말한다. 상위 탭(tablist/tab)과 **다른 역할**을 쓴다 —
  // view는 상위 탭('active' | 'complete' | 'stale')이다. 보기 모드 토글은 없앴다 —
  // 조판이 워크트리 하나뿐이므로 "어떻게 보는가"라는 축 자체가 사라졌다
  // (사용자 지시 2026-08-30). 남은 축은 "무엇을 보는가"인 상위 탭 하나다.
  function renderSessionView(inputTasks, now, view) {
    const tasks = sortTasks(Array.isArray(inputTasks) ? [...inputTasks] : []);
    const status = SESSION_VIEW_KEYS.has(view) ? view : 'active';
    // 상태별 필터는 **정확히 그 상태**다. 예전의 `!== 'complete'`는 중단된 세션까지
    // 진행 중으로 끌어왔다 (요구: 진행 중 표시는 실제 활성 세션만).
    const filtered = tasks.filter((task) => taskStatusKey(task) === status);
    if (status === 'active') {
      return filtered.length === 0
        ? '<p class="us-empty card">현재 진행 중인 작업이 없습니다.</p>'
        : renderTaskTabs([{ label: '', ariaLabel: '진행 중인 세션', tasks: filtered }], now, status);
    }
    const label = TASK_STATUS_LABELS[status];
    if (filtered.length === 0) {
      return `<p class="us-empty card">${escapeHtml(label)} 상태인 작업이 없습니다.</p>`;
    }
    // 최근순으로 세우고 기본 10개만 편다. 나머지는 '더 보기'로 열린다 — 목록을 지우는
    // 것이 아니라 접는 것이므로 감춘 개수를 버튼이 그대로 말한다.
    const ordered = [...filtered].sort((left, right) => completedTime(right) - completedTime(left));
    const visible = ordered.slice(0, Math.max(POST_PAGE_SIZE, postVisible[status] || 0));
    const rest = ordered.length - visible.length;
    const groups = groupTasksByDate(visible).map((group) => ({
      label: group.label,
      ariaLabel: `${group.label} ${label} 세션`,
      tasks: group.tasks,
    }));
    const footer = rest > 0
      ? `<div class="h-session-more"><button class="btn btn-secondary btn-sm" type="button" data-completed-more data-post-status="${escapeHtml(status)}">${escapeHtml(label)} 세션 ${Math.min(POST_PAGE_SIZE, rest)}개 더 보기</button><span class="h-session-more-rest">남은 ${rest}개</span></div>`
      : '';
    return renderPostList(groups, status, now, footer);
  }

  function renderSessionViews(inputTasks, now, residentCount = 0) {
    const tasks = sortTasks(sessionTasks(inputTasks));
    // 개수도 상태 판정과 **같은 함수**에서 나온다. 탭의 숫자와 그 탭이 실제로 세우는
    // 세션 수가 다른 화면은 둘 중 하나가 반드시 거짓말이다.
    const counts = Object.fromEntries(SESSION_VIEWS.map((view) => [view.key, 0]));
    for (const task of tasks) counts[taskStatusKey(task)] += 1;
    // 탭 목록은 SESSION_VIEWS 하나에서 도출한다 — 라벨·키를 여기 다시 적으면 상위 탭이
    // 바뀔 때 두 곳이 어긋난다 (LESSONS "파생 가능한 것을 손으로 적지 않는다").
    const views = SESSION_VIEWS.map((view) => ({ ...view, count: counts[view.key] ?? 0 }));
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
        ${residentCount > 0 ? `<p class="h-session-resident">시스템 상태 보고 ${residentCount}건은 실행 세션 목록에서 제외됩니다.</p>` : ''}
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
    const allTasks = Array.isArray(input?.tasks) ? input.tasks : [];
    const rawTasks = sessionTasks(allTasks);
    const residentCount = allTasks.length - rawTasks.length;
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
          <h2 id="harnessTitle" class="sr-only">실행 현황</h2>
          <div class="h-session-list">${renderSessionViews(tasks, now, residentCount)}</div>
        </section>
        <aside class="us-quota-rail" aria-labelledby="quotaTitle">
          <header class="us-quota-head">
            <div><p class="us-eyebrow">계정</p><h2 id="quotaTitle" class="title-3">Codex · Claude 한도</h2></div>
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
    // 선택이 옮겨간 뒤에도 **모든 tablist가 초점 진입점을 갖는다** (major 3).
    // 위 루프는 선택된 탭 하나만 0으로 만들므로, 선택을 품지 않은 tablist는 여기서
    // 첫 탭을 다시 tabbable로 되돌린다 — 그러지 않으면 탭을 한 번 누르는 순간
    // 나머지 날짜 그룹이 렌더 시점에 갖고 있던 진입점을 잃는다.
    for (const list of [...(scope.querySelectorAll?.('[data-task-tablist]') || [])]) {
      if (typeof list?.querySelectorAll !== 'function') continue;
      const listTabs = [...list.querySelectorAll('[data-task-tab]')];
      if (listTabs.length > 0 && !listTabs.includes(tab)) listTabs[0].tabIndex = 0;
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
        // 방향키는 **그룹 경계를 넘는다** (review WP3 major 3). 완료 탭은 날짜마다
        // tablist가 하나씩이므로, 이동 범위를 tablist 안으로 묶으면 첫 날짜 그룹에서
        // 오른쪽 끝에 닿은 사람이 둘째 날짜로 갈 방법이 없다 — 스위처 전체가 한 줄의
        // roving 범위다. 스위처를 찾지 못하는 환경에서는 예전처럼 tablist로 떨어진다.
        const switcher = tablist.closest?.('[data-session-switcher]');
        const scope = switcher && typeof switcher.querySelectorAll === 'function' ? switcher : tablist;
        const tabs = [...scope.querySelectorAll('[data-task-tab]')];
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
    selectedSessionView = SESSION_VIEW_KEYS.has(tab.dataset.sessionView)
      ? tab.dataset.sessionView
      : 'active';
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

  // 화면-로컬 상태(완료 더 보기·보기 모드)를 바꾸는 컨트롤. 서버를 다시 부르지 않고
  // 마지막 응답으로 다시 그린다 — 접기/펴기와 모드 전환 때문에 한도를 쓰지 않는다.
  function wireLocalControls(root) {
    // '더 보기'는 상태마다 하나씩 있을 수 있다 (완료 · 중단). 버튼이 자기 상태를 데이터로
    // 들고 있으므로 카운터도 그 상태 것만 는다.
    for (const more of [...(root?.querySelectorAll?.('[data-completed-more]') || [])]) {
      if (typeof more.addEventListener !== 'function') continue;
      more.addEventListener('click', () => {
        const status = more.dataset?.postStatus;
        if (!Object.prototype.hasOwnProperty.call(postVisible, status)) return;
        postVisible[status] += POST_PAGE_SIZE;
        rerenderDashboard();
      });
    }
  }

  function wireDashboard(root) {
    wireSessionViews(root);
    wireTaskTabs(root);
    wireLocalControls(root);
  }

  // ---- 자동 갱신 -----------------------------------------------------------

  let pollTimer = null;
  let freshnessTimer = null;
  let lastSyncAt = 0;
  let lastSignature = '';
  let activeSessionCount = 0;
  let inFlight = false;
  // 마지막으로 받은 응답. 화면-로컬 컨트롤이 서버를 다시 부르지 않고 다시 그릴 때 쓴다.
  let lastData = null;

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
    const cadence = isHidden() ? '자동 갱신 멈춤' : `${Math.round(pollDelay() / 1000)}초마다 자동 갱신`;
    // '화면 갱신'이라고 못박는다 — 카드의 '마지막 보고'와 다른 시계임을 이름으로
    // 구분해야 두 값이 달라도 어긋난 것으로 읽히지 않는다 (사용자 지시 ④).
    elements.freshness.textContent = `화면 갱신 ${elapsed} · ${cadence}`;
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
    const tasks = sortTasks(sessionTasks(data?.tasks));
    // 빠른 폴링은 **실제로 도는 세션**이 있을 때만 한다. 중단된 세션을 진행 중으로 세면
    // 아무도 보고하지 않는 화면이 5초마다 API를 두드린다.
    activeSessionCount = tasks.filter((task) => taskStatusKey(task) === 'active').length;
    const signature = JSON.stringify(data ?? null);
    // 바뀐 것이 없으면 다시 그리지 않는다: 초점·선택 상태를 흔들지 않기 위해서다.
    if (!announce && signature === lastSignature && elements.body.innerHTML) return;
    lastSignature = signature;
    lastData = data;
    elements.body.innerHTML = buildDashboard(data, Date.now());
    wireDashboard(elements.body);
  }

  // 서버를 다시 부르지 않는 재렌더. 마지막 응답이 없으면(첫 화면이 정적 사본이었던 경우)
  // 아무것도 하지 않는다 — 사본 화면을 빈 대시보드로 갈아 끼우지 않기 위해서다.
  function rerenderDashboard() {
    if (!lastData || !elements.body) return;
    elements.body.innerHTML = buildDashboard(lastData, Date.now());
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
      // 소유자 응답을 실제로 받은 뒤에만 제목을 올린다 (review-visual N7).
      document.title = OWNER_TITLE;
      renderDashboard(data, { announce });
      if (announce) {
        elements.reload.textContent = '업데이트됨';
        if (elements.refreshStatus) elements.refreshStatus.textContent = '서버에서 방금 확인했습니다.';
      }
    } catch (error) {
      if (error.message === 'unauthorized') return;
      const reason = error.message || '사용량을 불러오지 못했습니다.';
      // 정적 사본 폴백은 걷어냈다. 손으로 유지하던 `usage/pipeline-state.json`은 마지막
      // 갱신이 며칠 전이라, 피드가 끊긴 화면에 낡은 실행을 실시간처럼 세웠다.
      // 오래된 사실을 그리느니 못 읽었다고 말하는 편이 정확하다.
      elements.error.textContent = reason;
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
      competitionDashboard?.deactivate();
      renderFreshness();
      return;
    }
    void load();
    if (selectedUsageView === 'competition') competitionDashboard?.activate();
  });
  load();

  const USAGE_VIEW_KEY = 'hvsdcm.usage.view';
  const USAGE_VIEW_KEYS = new Set(['ops', 'competition']);
  const viewElements = {
    ops: document.getElementById('viewOps'),
    competition: document.getElementById('viewCompetition'),
  };
  // 공모전 모듈은 후보 데이터와 느린 갱신 주기를 스스로 소유한다. 이 탭을 열지
  // 않은 방문은 API를 부르지 않는다.
  const competitionDashboard = window.COMPETITION_UI?.createDashboard?.({ request: api }) || null;

  function readUsageView() {
    try {
      const requested = new URL(location.href).searchParams.get('view');
      if (USAGE_VIEW_KEYS.has(requested)) return requested;
    } catch { /* 잘못된 URL이면 저장된 기본 뷰로 안전하게 돌아간다. */ }
    try {
      const stored = localStorage.getItem(USAGE_VIEW_KEY);
      if (USAGE_VIEW_KEYS.has(stored)) return stored;
    } catch { /* 저장소를 못 읽으면 기본 뷰로 연다. */ }
    return 'ops';
  }

  let selectedUsageView = readUsageView();

  // ---- 뷰 전환 -------------------------------------------------------------

  function usageViewTabs() {
    return [...(document.querySelectorAll?.('[data-usage-view]') || [])];
  }

  function activateUsageView(view, moveFocus = false) {
    const next = USAGE_VIEW_KEYS.has(view) ? view : 'ops';
    selectedUsageView = next;
    try {
      localStorage.setItem(USAGE_VIEW_KEY, next);
    } catch { /* 저장 실패는 이번 방문의 기억만 잃는다. */ }
    for (const tab of usageViewTabs()) {
      const selected = tab.dataset?.usageView === next;
      tab.classList?.toggle?.('is-active', selected);
      tab.setAttribute?.('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && moveFocus) tab.focus?.();
    }
    if (viewElements.ops) viewElements.ops.hidden = next !== 'ops';
    if (viewElements.competition) viewElements.competition.hidden = next !== 'competition';
    if (next === 'competition' && !isHidden()) competitionDashboard?.activate();
    else competitionDashboard?.deactivate();
  }

  function wireUsageViews() {
    const tabs = usageViewTabs();
    for (const tab of tabs) {
      tab.addEventListener?.('click', () => activateUsageView(tab.dataset?.usageView));
      tab.addEventListener?.('keydown', (event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = tabs.indexOf(tab);
        const target = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
        activateUsageView(tabs[target]?.dataset?.usageView, true);
      });
    }
  }

  wireUsageViews();
  activateUsageView(selectedUsageView);

  window.USAGE_RENDER = {
    buildDashboard, renderSessionViews, renderSessionView, renderTask,
    sessionTasks, isResidentTask,
    renderTaskBody, renderPostList, taskPresentation, taskStatusKey, taskInput,
    phaseTimeline, sessionUsageDeltas,
    activateTaskTab, wireTaskTabs, activateSessionView, wireSessionViews, wireDashboard,
    wireLocalControls, load, activateUsageView,
  };
})();
