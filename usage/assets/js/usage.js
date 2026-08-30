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
  // 조직도의 확대·이동(휠 줌·드래그 팬·"맞춤" 변환)은 **전부 걷어냈다** (계약 §C).
  // 사용자 판정: "현 조직도 UI가 불편하다 · 줌인아웃 등 기능은 제거해도 된다."
  // 직전 리뷰(major 1)도 같은 곳을 가리켰다 — 두 축을 맞추려는 배율이 0.23까지 떨어져
  // 12px 글자가 2.8px가 됐다. 배율을 손보는 대신 **배율 자체를 없앤다**: 트리는 일반
  // 문서 흐름으로 원본 크기로 서고, 넘치면 조직도 컨테이너만 가로로 스크롤한다.
  // 그래서 이 화면에는 배율 변환을 거는 코드가 한 줄도 없다 — 어떤 뷰포트에서도
  // 글자는 CSS가 정한 크기 그대로다. (게이트가 이 사실을 소스에서 직접 검사한다:
  // scripts/usage.test.mjs "the usage source carries no zoom, pan, or fit machinery".)

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
  // '기록 없음'만 적으면 사용자는 그것이 화면의 고장인지, 단계를 건너뛴 것인지, 보고가
  // 오지 않은 것인지 알 수 없다. 판정의 근거를 그대로 문장으로 낸다 (사용자 지시 ①).
  // 이 화면이 아는 사유는 하나뿐이다 — **보고가 오지 않았다**. 다른 사유(해당 없음·구형식)를
  // 지어내지 않는 이유는 그것을 판정할 근거가 payload에 없기 때문이다.
  const PHASE_SKIPPED_REASON = '이 단계는 보고가 전송되지 않았습니다';
  // 요청 원문이 없는 세션의 판정과 그 사유. 판정('기록 없음')만 적으면 화면의 고장인지
  // 보고가 안 온 것인지 구별되지 않으므로 사유를 짝지어 낸다(단계의 '기록 없음'과 같은 규칙).
  const TASK_INPUT_EMPTY_LABEL = '기록 없음';
  const TASK_INPUT_MISSING_REASON = '이 세션은 요청 원문을 보고하지 않았습니다';
  // 액터 종류 라벨은 **제품 이름**이다. 대문자로 소리치던 것을 원래 표기로 되돌린다
  // (사용자 지시 ③ — UI가 만드는 문구는 축약·약어 대신 그대로 읽히는 말).
  const ACTOR_KIND_LABELS = { codex: 'Codex', webgpt: 'WebGPT', claude: 'Claude' };
  // 축 노드의 종류 라벨. 예전에는 REQUEST·MAIN·PHASE·AGENT 같은 영문 약어였다 —
  // 화면이 스스로 만드는 문구에는 약어를 쓰지 않는다 (사용자 지시 ③). 보고 데이터가
  // 실어 오는 약어(작업 이름의 WP1 등)는 그 데이터의 사실이므로 손대지 않는다.
  // '사용자 요청'은 여기서 빠졌다 — 요청 원문은 상세 머리의 inset이 정본으로 내고,
  // 조직도는 사람이 아닌 노드를 만들지 않는다 (review-visual M4 · DESIGN.md §1.1 v9).
  const NODE_KIND_LABELS = { lead: '총괄', phase: '단계', agent: '에이전트' };
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
  // 24시간 상주하는 인프라는 **세션이 아니다.** 모더 데몬은 주기마다 heartbeat를 올리므로
  // 진행 중 목록에 영구히 서서 실제로 도는 세션 하나를 가린다. 커널 상태 보고도 마찬가지로
  // 사람이 여는 작업이 아니다. 그래서 실행 현황은 이 둘을 세지 않는다 (사용자 지시 2026-08-30).
  // **죽이는 것이 아니라 자리를 옮기는 것이다** — 모더의 표면은 왼쪽 모더 탭이고, 커널 상태는
  // 화면이 아니라 `.kernel/state.json`이 정본이다. 여기서 빼도 보고는 계속 들어온다.
  const RESIDENT_TASK_IDS = new Set(['moderator-daemon', 'kernel-state']);

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
  // 노드가 내는 표시 항목의 **단일 원본**. 상세 조직도와 관제탑이 같은 사전을 소비한다 —
  // 라벨을 마크업에 손으로 적으면 두 화면이 같은 값을 다른 이름으로 부르게 된다
  // (LESSONS "파생 가능한 것을 손으로 적지 않는다").
  //
  // role과 assignment는 **겹쳐 쓰지 않는다**: 역할(무엇을 맡은 사람인가)과 담당(지금 무슨
  // 일을 하는가)은 다른 사실이고, 예전처럼 `role || assignment`로 하나만 내면 둘 중 하나가
  // 조용히 사라진다 (조사-결론 C-2).
  const NODE_FACT_LABELS = {
    role: '역할',
    assignment: '담당',
    duration: '소요',
    usage: '한도 소비',
    model: '모델',
    reasoning: '추론',
    progress: '진행도',
    // 자기 단계가 부모와 달라 부모 카드 밖에 선 액터는 **부모를 이름으로** 밝힌다.
    // 계층을 잃지 않으면서 API가 고정한 단계 자리도 지키는 유일한 방법이다 (major 2).
    parent: '상위',
  };
  // actor.kind ↔ 그 actor가 갉아먹는 계정 한도. usage_at_start·usage_at_end는 그 시점
  // 계정의 **잔여(%)** 스냅샷이므로 소비는 `시작 − 종료`다(세션 소모와 같은 부호 계약).
  // 여러 세션이 같은 계정을 함께 쓰므로 이 값은 측정이 아니라 **추정**이고, 화면도 그렇게 말한다.
  const ACTOR_USAGE_SOURCE = { codex: 'codex', webgpt: 'codex', claude: 'claude' };
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

  // actor 하나가 어느 단계에 속하는가. **API가 준 actor.phase가 언제나 이긴다** —
  // 이벤트 추정은 최근 300개·14일 보존에 걸려 사라지고, 사라지는 순간 그 actor가 task의
  // 현재 단계(완료 세션이면 '완료')로 끌려가 **지나간 단계가 텅 비어 보인다**(조사-결론 C-5).
  // 고정 배치로 바꾸면 종료된 단계에도 그 단계에 투입됐던 actor가 영구히 남는다.
  // phase를 싣지 않는 구 보고는 종전 추정(이벤트 → task 단계)으로 그대로 떨어진다.
  //
  // 반환값은 `{ key, explicit }`이다. **explicit**은 "그 단계에 근거가 있다"는 뜻이고,
  // 근거가 없는 액터(구 보고)는 부모의 단계를 물려받는다 — 근거 없는 액터를 task의
  // 현재 단계로 떼어내면 부모 아래 있던 서브에이전트가 계층을 잃기 때문이다.
  function actorPhaseOf(actor, phaseFromEvents, fallbackPhase) {
    if (PHASE_KEYS.has(actor?.phase)) return { key: actor.phase, explicit: true };
    const inferred = phaseFromEvents.get(String(actor?.id));
    if (PHASE_KEYS.has(inferred)) return { key: inferred, explicit: true };
    return { key: fallbackPhase, explicit: false };
  }

  // actor 하나의 소요시간. started_at이 없는 구 보고는 잴 근거가 없으므로 빈 문자열이다
  // (0분으로 지어내지 않는다). 아직 끝나지 않았으면 지금까지를 세되, 세션이 이미 끝났으면
  // 그 세션의 마지막 시각에서 시계를 멈춘다 — 끝난 세션의 시간이 계속 자라면 거짓이 된다.
  function actorDuration(actor, task, now) {
    const start = parseTime(actor?.started_at);
    if (start === null) return '';
    const finished = parseTime(actor?.finished_at);
    const openEnd = task?.status === 'complete'
      ? (parseTime(task?.completed_at) ?? parseTime(task?.updated_at) ?? now)
      : now;
    const end = finished === null ? openEnd : finished;
    return formatDuration(Math.max(0, end - start));
  }

  // actor 하나가 쓴 **전체 한도 대비 소비 추정**. usage_at_start/usage_at_end는 그 actor가
  // 시작·종료하던 두 시점의 계정 잔여(%)라, 그 사이 다른 세션이 함께 쓴 몫이 섞인다.
  // 그래서 값이 아니라 추정이고, 화면도 '추정'이라고 적는다. 두 스냅샷 중 하나라도
  // 없으면 아무것도 내지 않는다 (결측은 0이 아니다).
  function actorUsageEstimate(actor) {
    const field = ACTOR_USAGE_SOURCE[actor?.kind] || 'codex';
    const start = finiteNumber(actor?.usage_at_start?.[field]);
    const end = finiteNumber(actor?.usage_at_end?.[field]);
    if (start === null || end === null) return '';
    const consumed = start - end;
    if (!(consumed >= 0.1)) return '';
    return `${SOURCE_LABELS[field] || field} ${consumed.toFixed(1)}%p 추정`;
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

  // ---- 조직도 노드 ---------------------------------------------------------
  //
  // 노드 하나의 표시 계약은 아래 한 형태뿐이고, 축 노드(입력·총괄·단계)와 분기 노드
  // (서브에이전트)가 같은 렌더러를 공유한다. 종류마다 다른 마크업을 만들면 톤이 갈라진다.
  //   { kind, kindLabel, name, detail, model, reasoning, note, status, tone,
  //     progress, facts, current, attributes, children }
  // model·reasoning은 각자 한 줄의 모노 값이고, facts는 라벨·값이 짝을 이루는 사실 목록이다.
  // **facts의 라벨은 NODE_FACT_LABELS에서만 나온다** — 마크업에 손으로 적지 않는다.

  function renderNodeAttributes(attributes) {
    return Object.entries(attributes || {})
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
      .join('');
  }

  // ---- 워크트리 ------------------------------------------------------------
  //
  // 조판은 **워크트리 한 장**이다 (사용자 지시 2026-08-30: "/usage를 워크트리 형식으로
  // 가볍고 가독성 좋게"). 예전에는 같은 사실을 두 조판이 각자 그렸다 — 카드가 가로로
  // 갈라지는 조직도와, 단계 레일에 칩을 붙이는 관제탑 보드. 둘 다 같은 파생값
  // (phaseStates·phaseTimeline·actorNodes)을 읽고 있었으므로 조판만 둘이었고, 그래서
  // 모드 토글이 필요했고, 토글이 있으니 두 조판을 모두 유지해야 했다.
  //
  // 워크트리는 그 셋을 한꺼번에 없앤다: 한 행 = 한 노드, 계층은 글자 가이드(│ ├─ └─)가
  // 말하고, 사실은 고정 열(상태 · 소요 · 진행)이 받는다. 커넥터를 그리는 CSS 의사요소도,
  // 폭 예산 계산도, 배율 변환도 필요 없다 — 행은 그냥 문서 흐름으로 쌓인다.
  //
  // 판독용 계약은 그대로다: 단계 행은 data-org-phase·data-phase-state를, 액터 행은
  // data-actor-id를 싣는다. 그래서 "보고된 적 없는 단계를 완료로 날조하지 않는다"를
  // 게이트가 조판과 무관하게 계속 검사한다.

  // 가이드 글리프. `ancestors`는 **뿌리를 뺀 조상들의 "형제 중 마지막이었나"** 목록이고,
  // true인 열에는 세로선을 잇지 않는다(그 가지는 이미 끝났으므로). 마지막 칸은 자기
  // 자신의 연결선이다. 마크업에 손으로 적지 않고 여기서만 만든다.
  const WT_GUIDE = { branch: '├─ ', last: '└─ ', trunk: '│  ', gap: '   ' };

  // 노드의 사실 목록에서 라벨로 값을 꺼낸다. actorNodes가 이미 계산해 둔 파생값을
  // 워크트리가 다시 계산하지 않기 위한 통로다(두 조판이 각자 계산하면 값이 갈린다).
  function factValue(node, label) {
    return (node.facts || []).find((fact) => fact && fact.label === label)?.value || '';
  }

  function worktreeGuide(ancestors, isLast, isRoot = false) {
    if (isRoot) return '';
    const stem = (Array.isArray(ancestors) ? ancestors : [])
      .map((ancestorWasLast) => (ancestorWasLast ? WT_GUIDE.gap : WT_GUIDE.trunk))
      .join('');
    return `${stem}${isLast ? WT_GUIDE.last : WT_GUIDE.branch}`;
  }

  // 노드 하나 → 행 하나. 값이 없는 열은 `—`로 자리를 지킨다. 행은 고정 격자에 서므로
  // 자리를 비우면 아래 행의 같은 열이 위로 붙어 읽는 눈이 열을 잃는다. `—`는 값을
  // 지어내는 것이 아니라 "측정 없음"을 명시하는 표기다(조직도 시절과 같은 규칙).
  function renderWorktreeRow(row) {
    const percent = Number.isFinite(row.progress) ? clampPercent(row.progress) : null;
    const guide = worktreeGuide(row.ancestors, row.isLast, row.kind === 'lead');
    // 한도 소비 추정치는 **보조 줄에** 실린다. 조직도 시절에는 노드 카드의 사실 목록에
    // 자기 줄이 있었고, 워크트리에는 고정 열이 넷(이름·상태·소요·진행)뿐이라 다섯 번째
    // 열을 만드는 대신 여기로 내렸다. 값 자체는 하나도 잃지 않는다 — 이 줄을 빠뜨렸을
    // 때 게이트가 잡았다(2026-08-30 이관 라운드).
    const secondary = [
      row.detail,
      row.role,
      row.assignment,
      row.usage ? `${NODE_FACT_LABELS.usage} ${row.usage}` : '',
      row.parent ? `${NODE_FACT_LABELS.parent} ${row.parent}` : '',
    ].filter(Boolean).join(' · ');
    return `
        <div class="wt-row is-${escapeHtml(row.kind)}${row.current ? ' is-current' : ''}" role="row"
          data-depth="${Math.max(0, Number(row.depth) || 0)}"${renderNodeAttributes(row.attributes)}>
          <div class="wt-cell wt-name-cell" role="cell">
            <span class="wt-guide" aria-hidden="true">${escapeHtml(guide)}</span>
            <span class="status-dot${row.tone || ' is-idle'}" aria-hidden="true"></span>
            <span class="wt-name">${escapeHtml(row.name || '이름 미기록')}</span>
            <span class="wt-kind">${escapeHtml(row.kindLabel || '')}</span>
            ${row.mono ? `<span class="wt-model h-node-fact-mono">${escapeHtml(row.mono)}</span>` : ''}
          </div>
          <div class="wt-cell wt-state" role="cell">${escapeHtml(row.status || '—')}</div>
          <div class="wt-cell wt-time h-node-time" role="cell">${escapeHtml(row.duration || '—')}</div>
          <div class="wt-cell wt-pct" role="cell">${percent === null ? '—' : `${Math.round(percent)}%`}</div>
          ${secondary || row.note
    ? `<p class="wt-sub" role="cell">${escapeHtml(secondary)}${secondary && row.note ? ' · ' : ''}${row.note ? `<span class="wt-note">${escapeHtml(row.note)}</span>` : ''}</p>`
    : ''}
        </div>`;
  }

  // 액터 노드 숲을 행으로 편다. 손자·증손자까지 한 명도 빠지지 않는다 — 깊이는
  // ancestors 배열이 그대로 들고 가므로 가이드가 계층을 말한다.
  function worktreeActorRows(nodes, ancestors) {
    const list = (nodes || []).filter(Boolean);
    return list.flatMap((node, index) => {
      const isLast = index === list.length - 1;
      const nextAncestors = [...ancestors, isLast];
      return [
        {
          kind: 'agent',
          kindLabel: node.kindLabel || '',
          name: node.name,
          mono: modelAndReasoning(node.model, node.reasoning),
          role: node.role || '',
          assignment: node.assignment || '',
          usage: factValue(node, NODE_FACT_LABELS.usage),
          parent: node.parent || '',
          status: node.status || '',
          tone: node.tone,
          duration: node.duration || '',
          progress: node.progress,
          current: node.current,
          attributes: node.attributes,
          depth: nextAncestors.length,
          ancestors,
          isLast,
        },
        ...worktreeActorRows(node.children, nextAncestors),
      ];
    });
  }

  // 세션 하나 → 워크트리 행 목록. 뿌리(총괄) → 여덟 단계 → 각 단계의 액터.
  //
  // **모든 단계가 행으로 선다.** 조직도 시절에는 보고 없는 단계를 rest 줄로 접었는데,
  // 그 이유는 빈 카드가 세로 길이를 늘렸기 때문이다. 행 하나는 카드가 아니라 한 줄이라
  // 그 비용이 없고, 여덟 단계가 항상 같은 자리에 서면 "지금 어디까지 왔나"를 눈이
  // 자리로 읽는다. 사용자 입력 노드는 여전히 만들지 않는다 — 요청 원문은 상세 머리의
  // inset이 정본이다 (review-visual M4 · DESIGN.md §1.1 v9).
  function sessionWorktree(task, now) {
    const phases = phaseNodesOf(task, now);
    const main = mainActorOf(task);
    const rows = [];
    if (main) {
      const mainProgress = actorProgressMap(task).get(String(main.id));
      rows.push({
        kind: 'lead',
        kindLabel: NODE_KIND_LABELS.lead,
        name: main.name || '이름 미기록',
        mono: modelAndReasoning(main.model, main.reasoning),
        role: main.role || '',
        assignment: main.assignment || '',
        usage: actorUsageEstimate(main),
        status: actorStatus(main),
        tone: statusDotClass(main.status),
        duration: actorDuration(main, task, now),
        progress: mainProgress ?? finiteNumber(main.progress) ?? finiteNumber(task.progress),
        current: main.status === 'working' || main.status === 'reviewing',
        attributes: { 'data-actor-id': main.id || '' },
        depth: 0,
        ancestors: [],
        isLast: false,
      });
    } else {
      rows.push({
        kind: 'lead',
        kindLabel: NODE_KIND_LABELS.lead,
        name: '에이전트 보고 없음',
        detail: '이 세션은 실행자를 보고하지 않았습니다',
        status: '',
        depth: 0,
        ancestors: [],
        isLast: false,
      });
    }
    phases.forEach((node, index) => {
      const isLast = index === phases.length - 1;
      rows.push({
        kind: 'phase',
        // 단계 행에는 종류 라벨을 붙이지 않는다. 여덟 줄이 모두 '단계'라고 말하면 그 열은
        // 어떤 판단도 돕지 않고, 자리(뿌리 바로 아래 여덟 형제)가 이미 그것을 말한다.
        kindLabel: '',
        name: node.name,
        detail: node.detail,
        mono: modelAndReasoning(node.model, node.reasoning),
        status: node.status,
        tone: node.tone,
        note: node.note,
        duration: (node.facts || []).find((fact) => fact.className === 'h-node-time')?.value || '',
        progress: null,
        current: node.current,
        attributes: node.attributes,
        depth: 1,
        ancestors: [],
        isLast,
      });
      rows.push(...worktreeActorRows(node.children, [isLast]));
    });
    return rows;
  }

  function renderWorktree(rows, label) {
    return `
      <section class="h-org wt" aria-label="${escapeHtml(label)}">
        <header class="h-org-head">
          <div><p class="us-eyebrow">파이프라인</p><h4>실행 워크트리</h4></div>
        </header>
        <div class="wt-grid" role="table" data-worktree>
          <div class="wt-row wt-head" role="row">
            <div class="wt-cell wt-name-cell" role="columnheader">노드</div>
            <div class="wt-cell wt-state" role="columnheader">상태</div>
            <div class="wt-cell wt-time" role="columnheader">소요</div>
            <div class="wt-cell wt-pct" role="columnheader">진행</div>
          </div>
          ${rows.map(renderWorktreeRow).join('')}
        </div>
      </section>`;
  }


  // ---- 트리 구성 -----------------------------------------------------------

  // 서브에이전트 숲: 부모가 다른 actor면 그 아래에, 아니면 자기 단계 노드 옆에 붙는다.
  // **위임된 서브에이전트는 한 명도 빠지지 않는다** — parent_id가 가리키는 부모가 실제로
  // 보고된 actor면 그 아래로 중첩되고(손자·증손자까지), 아니면 자기 단계로 올라온다.
  // 순환 parent_id가 들어와도 visited로 끊는다 (보고자가 잘못 보내도 화면이 멈추지 않게).
  function actorNodes(task, now = Date.now()) {
    const actors = taskActors(task);
    const main = mainActorOf(task);
    const byId = new Map(actors.map((actor) => [actor.id, actor]));
    const phaseOf = actorPhaseMap(task);
    const progressOf = actorProgressMap(task);
    const fallbackPhase = normalizedTaskPhase(task);
    const childrenOf = new Map();
    const byPhase = new Map(PHASES.map((phase) => [phase.key, []]));
    // 부모 아래로 접히지 못하고 자기 단계로 올라온 액터 ↔ 그 부모의 이름. 노드가
    // '상위' 줄로 계층을 되살린다.
    const detachedParent = new Map();

    // **단계를 먼저 정하고 계층은 그 다음이다** (review WP3 major 2).
    // 예전에는 parent_id가 있으면 곧장 부모 밑으로 넣었고, 그래서 부모가 `work`인
    // 검토자가 API의 `phase: 'review'`를 실은 채로 구현 단계에 서 있었다 — "API가 준
    // actor.phase 고정 배치"라는 계약이 자식에서만 조용히 깨졌다.
    // 이제 규칙은 둘뿐이다:
    //   · 자식의 단계가 부모와 **같으면** 부모 카드 아래로 중첩한다 (계층 유지).
    //   · **다르면** 자기 단계 자리에 서고, 부모는 '상위' 줄로 명시한다 (배치 유지).
    // 근거 없는(explicit이 아닌) 단계는 부모의 단계를 물려받으므로, 구 보고는 예전처럼
    // 통째로 부모 밑에 남는다.
    const phaseCache = new Map();
    const phaseKeyFor = (actor, seen = new Set()) => {
      const id = String(actor?.id ?? '');
      if (phaseCache.has(id)) return phaseCache.get(id);
      const own = actorPhaseOf(actor, phaseOf, fallbackPhase);
      let key = own.key;
      const parent = actor?.parent_id && actor.parent_id !== main?.id
        ? byId.get(actor.parent_id)
        : null;
      if (!own.explicit && parent && !seen.has(String(parent.id))) {
        key = phaseKeyFor(parent, new Set(seen).add(id));
      }
      const resolved = PHASE_KEYS.has(key) ? key : fallbackPhase;
      phaseCache.set(id, resolved);
      return resolved;
    };

    for (const actor of actors) {
      if (main && actor.id === main.id) continue;
      const parent = actor.parent_id && actor.parent_id !== main?.id && byId.has(actor.parent_id)
        ? byId.get(actor.parent_id)
        : null;
      const phaseKey = phaseKeyFor(actor);
      if (parent && parent.id !== actor.id && phaseKeyFor(parent) === phaseKey) {
        if (!childrenOf.has(parent.id)) childrenOf.set(parent.id, []);
        childrenOf.get(parent.id).push(actor);
        continue;
      }
      if (parent) detachedParent.set(actor.id, parent.name || '이름 미기록');
      (byPhase.get(phaseKey) || byPhase.get(fallbackPhase)).push(actor);
    }

    const toNode = (actor, visited) => {
      const nextVisited = new Set(visited).add(actor.id);
      const progress = progressOf.has(String(actor.id))
        ? progressOf.get(String(actor.id))
        : finiteNumber(actor.progress);
      // 파생값은 여기서 한 번만 계산하고, 조직도의 facts와 관제탑의 칩이 **같은 값**을
      // 나눠 쓴다. 두 조판이 각자 다시 계산하면 같은 액터의 소요시간이 화면마다
      // 달라진다 (LESSONS "파생 가능한 것을 손으로 적지 않는다").
      const duration = actorDuration(actor, task, now);
      return {
        kind: 'agent',
        kindLabel: ACTOR_KIND_LABELS[actor.kind] || actor.kind || NODE_KIND_LABELS.agent,
        name: actor.name || '이름 미기록',
        model: actor.model || (actor.reasoning ? '모델 미기록' : ''),
        reasoning: actor.reasoning || '',
        // 역할·담당·소요·한도를 **각각** 낸다 (요구 2·4). 하나로 합치지 않는다.
        facts: [
          { label: NODE_FACT_LABELS.role, value: actor.role || '' },
          { label: NODE_FACT_LABELS.assignment, value: actor.assignment || '' },
          { label: NODE_FACT_LABELS.parent, value: detachedParent.get(actor.id) || '' },
          // 액터의 소요는 **잴 근거가 있을 때만** 줄이 선다. 단계 카드와 달리(아래
          // phaseNodesOf의 `—`) 액터의 사실 목록은 길이가 제각각이라 자리를 지킬 격자가
          // 없고, 빈 줄을 세우면 "보고되지 않음"과 "0"이 구별되지 않는다.
          { label: NODE_FACT_LABELS.duration, value: duration, className: 'h-node-time' },
          { label: NODE_FACT_LABELS.usage, value: actorUsageEstimate(actor) },
        ],
        role: actor.role || '',
        assignment: actor.assignment || '',
        duration,
        parent: detachedParent.get(actor.id) || '',
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
    const { byPhase } = actorNodes(task, now);
    return PHASES.map((phase) => {
      const stat = timeline.stats.get(phase.key);
      const state = states.get(phase.key);
      const isCurrent = state === 'current';
      const model = stat?.model || (isCurrent ? task.model : '');
      const reasoning = stat?.reasoning || (isCurrent ? task.reasoning : '');
      // 소요는 다른 사실과 **같은 라벨-값 줄**로 낸다. 예전에는 이 값만 상태 줄 오른쪽에
      // 양끝 정렬로 붙어, 한 조직도 안에서 정렬 규칙이 둘로 갈렸다 (review-visual N12).
      //
      // 값이 없는 단계는 `—`로 자리를 지킨다 (N13: `완료`만 소요가 비어 형제 넷의 카드
      // 끝이 들쭉날쭉했다). 단계 카드는 **한 줄에 나란히 서는 고정 형제 집합**이라 자리를
      // 지킬 격자가 실제로 있고, `—`는 값을 지어내는 것이 아니라 "측정 없음"을 명시하는
      // 표기다. 길이가 제각각인 액터 카드에는 같은 이유가 없으므로 그쪽은 종전대로
      // 줄 자체를 만들지 않는다.
      return {
        kind: 'phase',
        kindLabel: NODE_KIND_LABELS.phase,
        name: phase.label,
        detail: phase.detail,
        model: model || (reasoning ? '모델 미기록' : ''),
        reasoning,
        facts: [{
          label: NODE_FACT_LABELS.duration,
          value: stat && stat.duration > 0 ? formatDuration(stat.duration) : '—',
          className: 'h-node-time',
        }],
        // '기록 없음'이 왜 기록 없음인지 노드가 직접 말한다 (사용자 지시 ①).
        note: state === 'skipped' ? PHASE_SKIPPED_REASON : '',
        status: PHASE_STATE_LABELS[state],
        tone: isCurrent ? ' is-accent' : ' is-idle',
        current: isCurrent,
        attributes: { 'data-org-phase': phase.key, 'data-phase-state': state },
        children: byPhase.get(phase.key) || [],
      };
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
        ${renderWorktree(sessionWorktree(task, now), `${presentation.name} 실행 워크트리`)}
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
        ${residentCount > 0 ? `<p class="h-session-resident">상주 프로세스 ${residentCount}건은 이 목록에서 빠집니다 — 모더는 왼쪽 <strong>모더</strong> 탭에서 봅니다.</p>` : ''}
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
          <h2 id="harnessTitle" class="sr-only">실행 파이프라인</h2>
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
    // 모더 뷰의 시계도 같은 1초 틱을 탄다 — 화면마다 타이머를 하나씩 더 걸지 않는다.
    renderModeratorFreshness();
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
    // (예전에는 여기에 "조직도를 끌고 있는 중이면 건너뛴다"는 예외가 있었다. 끌기가
    //  사라졌으므로 예외도 사라졌다 — 이제 스크롤은 브라우저가 알아서 보존한다.)
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
      // 갱신이 며칠 전이라, 피드가 끊긴 화면에 낡은 파이프라인을 실시간처럼 세웠다.
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
      clearTimeout(moderatorPollTimer);
      pollTimer = null;
      freshnessTimer = null;
      moderatorPollTimer = null;
      renderFreshness();
      renderModeratorFreshness();
      return;
    }
    void load();
    if (selectedUsageView === 'moderator') void loadModerator();
  });
  load();

  // ==========================================================================
  // 모더 뷰 — 직접 명령 · 중요/제안/검토 · 실제 사용 모델
  //
  // 화면 계약: Claude/sessions/2026-08-29-모더-시각화/plan.md §5
  //   1. 사용자가 모더에게 **직접 명령을 넣을 수 있다.** 그 입력은 정적 마크업이라
  //      5초 폴링이 목록을 갈아 끼워도 쓰던 글이 사라지지 않는다.
  //   2. 로그는 원시 로그가 아니라 **문제 한 줄 + 조치 한 줄**이다. 원문(명령·stdout)은
  //      로컬 런타임에만 있고 이 화면에는 오지 않는다.
  //   3. 모더의 **뇌 모델**과 하위 작업이 **실제로 쓴 모델**을 따로 낸다. 요청 모델과
  //      실행 모델을 한 값으로 합치지 않고, 서버가 null이면 지어내지 않고 '미확인'이다.
  //   4. 항목은 **중요 / 제안 / 검토** 셋으로 갈린다. 세 분류와 개수는 항상 함께 보이고,
  //      목록은 고른 분류 하나만 낸다.
  //   5. 제안에는 승인 / 거부 / 수정이 있고 **승인 전에는 아무것도 실행되지 않는다.**
  //      버튼은 낙관적으로 먼저 그리지 않는다 — 서버 응답을 받은 뒤에만 상태가 바뀐다.
  //      (실행 금지의 진짜 강제는 D1 쪽이다. 화면은 그 사실을 말하고 보여줄 뿐이다.)
  // ==========================================================================

  const MODERATOR_PATH = '/api/moderator?limit=50';
  const MODERATOR_POLL_ACTIVE_MS = 5_000;
  const MODERATOR_POLL_IDLE_MS = 60_000;
  // API가 null을 주면 그것은 "확인되지 않았다"는 사실이다. 빈칸으로 두거나 요청 모델을
  // 대신 적으면 실행 모델을 확인하지 못한 상태가 성공으로 꾸며진다 (plan.md §8).
  const MODERATOR_UNKNOWN = '미확인';
  // **개념이 없는 칸과 확인하지 못한 칸을 구별한다.** 둘 다 '미확인'으로 적으면 화면이
  // 매 줄 실패처럼 읽힌다 — 2026-08-30 실측: 라이브 항목 30건이 전부 '요약 모델 미확인 ·
  // 요약 추론 미확인'을 달고 있었는데, 그 항목들은 결정론적 커널이 만든 것이라 요약
  // 모델이라는 개념 자체가 없었다.
  const MODERATOR_NOT_APPLICABLE = '해당 없음';
  // 기계 슬러그를 한국어 화면에 그대로 세우지 않는다 (phrasing 계약과 같은 원칙).
  // 표에 없는 값은 실제 모델 이름이므로 그대로 둔다 — 이름을 지어내지 않는다.
  const MODERATOR_MODEL_LABELS = { 'deterministic-kernel': '결정론적 커널' };
  const MODERATOR_REASONING_LABELS = { none: '없음' };
  const MODERATOR_DETERMINISTIC_MODEL = 'deterministic-kernel';

  function moderatorModelName(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    return MODERATOR_MODEL_LABELS[text] || text;
  }

  function moderatorReasoningName(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    return MODERATOR_REASONING_LABELS[text] || text;
  }

  // 세션 이름은 사람이 읽는 이름이어야 한다. 하네스가 위임 실행자의 이름을 알아내지
  // 못하면 `pid-15960` 같은 값이 그대로 올라오는데, 그것은 사용자에게 아무 뜻도 없고
  // 프로세스가 끝나면 영영 되짚을 수도 없다. 값을 지어내지는 않되, 그것이 이름이 아니라
  // 프로세스 번호라는 사실은 화면이 말해 준다.
  const MODERATOR_PID_PATTERN = /^pid-(\d+)$/u;

  function moderatorSessionName(value) {
    const text = String(value ?? '').trim();
    const pid = MODERATOR_PID_PATTERN.exec(text);
    return pid ? `이름 없는 위임 실행 (프로세스 ${pid[1]})` : text;
  }

  // 항목 한 줄에 모델 사실 넷(뇌 모델·뇌 추론·요약 모델·요약 추론)을 세우면, 결정론적
  // 커널이 만든 항목에서는 넷 중 셋이 'none'과 '미확인'으로 채워진다. 사실은 하나뿐이다:
  // **누가 이 판단을 했는가.** 그 하나만 문장으로 적는다.
  function moderatorDecidedBy(source) {
    const brain = String(source?.brain_model ?? '').trim();
    const worker = String(source?.worker_model ?? '').trim();
    // 빈 문자열로 돌려 moderatorFact가 '미확인' 판정을 붙이게 한다 — 결측의 표기는
    // 그 한 곳에서만 정한다.
    if (!brain && !worker) return '';
    if (brain === MODERATOR_DETERMINISTIC_MODEL && !worker) {
      return `${MODERATOR_MODEL_LABELS[MODERATOR_DETERMINISTIC_MODEL]} · 모델을 부르지 않았습니다`;
    }
    const parts = [];
    if (brain) {
      const reasoning = moderatorReasoningName(source?.brain_reasoning);
      parts.push(reasoning ? `${moderatorModelName(brain)} · 추론 ${reasoning}` : moderatorModelName(brain));
    }
    if (worker) parts.push(`요약 ${moderatorModelName(worker)}`);
    return parts.join(' / ');
  }
  const USAGE_VIEW_KEY = 'hvsdcm.usage.view';
  const USAGE_VIEW_KEYS = new Set(['ops', 'moderator', 'guide']);

  // 분류는 **넷**이다 (2026-08-30 사용자 지시).
  //   중요 — 사용자가 반드시 알아야 할 내역
  //   제안 — 모더가 스스로 판단해 "이건 어때?" 하고 올린 것. 승인 전에는 실행되지 않는다
  //   검토 — 모더가 스스로 돌린 점검의 기록
  //   기록 — 그 셋을 뺀, 모더가 실제로 행한 모든 것
  //
  // 앞의 셋은 서버의 `moderator_items.kind`와 1:1이다. **'기록'만 다르다** — 그것은
  // 항목이 아니라 `moderator_commands`(직접 명령·승인된 제안·자율 검토가 실제로 돌린
  // 실행 이력)다. 그래서 kind에 네 번째 값을 만들지 않았다: D1의 CHECK 제약이라 라이브
  // 테이블을 재작성해야 하는데, 그 데이터는 이미 같은 응답에 실려 오고 화면 아래에
  // 별도 블록으로 붙어 있었을 뿐이다. 블록을 분류로 올린다.
  const MODERATOR_RECORD_KIND = 'record';
  const MODERATOR_KINDS = [
    {
      key: 'important', label: '중요', openLabel: '확인 필요',
      lead: '사용자가 반드시 알아야 할 내역입니다. 판단은 사람이 하고 모더는 여기에 손대지 않습니다.',
      empty: '지금 확인해야 할 중요 항목이 없습니다.',
    },
    {
      key: 'proposal', label: '제안', openLabel: '승인 대기',
      lead: '모더가 스스로 판단해 올린 제안입니다. 승인하기 전까지 아무 명령도 실행되지 않습니다.',
      empty: '승인을 기다리는 제안이 없습니다.',
    },
    {
      key: 'review', label: '검토', openLabel: '진행 중',
      lead: '아무 세션도 돌지 않는 동안 모더가 스스로 돌린 점검의 기록입니다.',
      empty: '기록된 자율 검토가 없습니다.',
    },
    {
      key: MODERATOR_RECORD_KIND, label: '기록', openLabel: '최근',
      lead: '위 셋을 뺀, 모더가 실제로 실행한 모든 기록입니다. 실행 모델은 실행자가 확인해 준 값이며, '
        + `확인되지 않으면 요청 모델로 대신 적지 않고 ${MODERATOR_UNKNOWN}으로 둡니다.`,
      empty: '아직 실행된 명령이 없습니다.',
    },
  ];
  const MODERATOR_KIND_KEYS = new Set(MODERATOR_KINDS.map((kind) => kind.key));
  // 분류마다 "아직 끝나지 않은" 상태가 다르다. 개수 줄이 이 집합에서 도출되므로
  // 상태를 늘릴 때 여기만 고치면 필터·머리글·기본 선택이 함께 따라온다.
  //
  // 기록에는 **열린 상태가 없다.** 손이 필요한 목록이 아니라 지나간 일의 기록이므로,
  // 기본 선택(손이 필요한 쪽을 먼저 연다)이 기록으로 떨어지지 않게 빈 집합으로 둔다.
  const MODERATOR_OPEN_STATUSES = {
    important: new Set(['open']),
    proposal: new Set(['pending']),
    review: new Set(['queued', 'running']),
    [MODERATOR_RECORD_KIND]: new Set(),
  };
  // 분류 넷 위에 축을 하나 더 얹는다: **읽음 / 안읽음**.
  //
  // 왜: 분류 넷은 *출처*의 분류지 "지금 나한테 필요한가"의 분류가 아니다. 2026-08-30
  // 실측으로 라이브 항목 22건이 **전부 닫힌 상태**(acknowledged·resolved·approved·
  // rejected·done)였는데 화면은 27줄을 그대로 세우고 있었다. 끝난 것이 나가지 않으니
  // 쌓인다. 그래서 기본 화면을 안읽음 **한 목록**으로 두고, 분류 넷은 '전체' 보기에
  // 그대로 남긴다(분류 넷은 2026-08-30 사용자 지시다). 안읽음에서까지 분류로 쪼개면
  // "확인할 것이 없다"는 사실을 알기 위해 탭을 넷 다 눌러야 해서 목적이 뒤집힌다.
  const MODERATOR_MODES = [
    { key: 'unread', label: '안읽음' },
    { key: 'all', label: '전체' },
  ];
  const MODERATOR_MODE_KEYS = new Set(MODERATOR_MODES.map((mode) => mode.key));
  const MODERATOR_UNREAD_LEAD = '분류를 가로질러, 아직 보지 않았거나 손이 필요한 것만 모았습니다. '
    + '펼쳐서 읽으면 읽음이 되고, 확인 · 승인 · 거부가 필요한 것은 그 행동을 해야 나갑니다.';
  const MODERATOR_UNREAD_EMPTY = '확인할 것이 없습니다. 새로 올라온 것도, 손이 필요한 것도 없습니다.';

  const MODERATOR_STATUS_LABELS = {
    open: '확인 필요', acknowledged: '확인함', resolved: '해결됨',
    pending: '승인 대기', approved: '승인함', rejected: '거부함',
    queued: '대기', claimed: '배정됨', running: '진행 중',
    done: '완료', failed: '실패', escalated: '중요로 올림', succeeded: '성공',
  };
  // 상태색은 상태에만 쓴다 (DESIGN.md §3). 이 뷰의 강조색은 --accent 하나이고,
  // accent 배지는 '지금 돌고 있음'이라는 상태 하나에만 붙는다.
  const MODERATOR_STATUS_TONES = {
    open: 'orange', pending: 'orange', escalated: 'orange',
    running: 'accent', claimed: 'accent',
    resolved: 'green', approved: 'green', done: 'green', succeeded: 'green',
    rejected: 'red', failed: 'red',
  };
  const MODERATOR_SOURCE_LABELS = {
    direct: '직접 명령', proposal: '제안 승인', review: '자율 검토',
  };
  // 실행이 끝나기 전에는 요약이 없다. 그 자리를 지어낸 문장으로 채우지 않고,
  // 왜 비어 있는지를 말한다 (기존 화면의 '기록 없음 + 사유' 규칙과 같은 원리).
  const MODERATOR_COMMAND_WAITING = {
    queued: '대기열에 있습니다. 아직 실행되지 않았습니다.',
    claimed: '실행자가 가져갔습니다. 곧 시작합니다.',
    running: '실행 중입니다. 요약은 끝난 뒤에 기록됩니다.',
  };
  // 서버가 돌려주는 안정적인 오류 키를 사람 말로 옮긴다. 키가 늘어도 원문이 그대로
  // 나가므로 화면이 조용히 비지 않는다.
  const MODERATOR_ERRORS = {
    invalid_command: '명령 형식이 올바르지 않습니다.',
    invalid_decision: '알 수 없는 결정입니다.',
    invalid_item: '항목을 찾지 못했습니다.',
    invalid_transition: '이미 처리된 항목입니다. 새로고침한 뒤 다시 확인해 주세요.',
    idempotency_conflict: '같은 키로 다른 명령이 이미 접수됐습니다.',
    invalid_json: '요청을 보내지 못했습니다.',
    invalid_pagination: '목록 조건이 올바르지 않습니다.',
    request_too_large: '명령이 너무 깁니다.',
    authentication_required: '로그인이 필요합니다.',
  };

  const modElements = {
    view: document.getElementById('viewModerator'),
    opsView: document.getElementById('viewOps'),
    guideView: document.getElementById('viewGuide'),
    brain: document.getElementById('modBrain'),
    filter: document.getElementById('modFilter'),
    items: document.getElementById('modItems'),
    error: document.getElementById('modError'),
    refreshStatus: document.getElementById('modRefreshStatus'),
    freshness: document.getElementById('modFreshness'),
    reload: document.getElementById('modReload'),
    form: document.getElementById('modCommandForm'),
    commandText: document.getElementById('modCommandText'),
    commandSubmit: document.getElementById('modCommandSubmit'),
    commandStatus: document.getElementById('modCommandStatus'),
    tab: document.getElementById('tabModerator'),
    tabBadge: document.getElementById('modTabBadge'),
  };

  function readUsageView() {
    try {
      const stored = localStorage.getItem(USAGE_VIEW_KEY);
      if (USAGE_VIEW_KEYS.has(stored)) return stored;
    } catch { /* 저장소를 못 읽으면 기본 뷰로 연다 — 화면은 계속 돈다. */ }
    return 'ops';
  }

  let selectedUsageView = readUsageView();
  let selectedModeratorKind = '';
  // 기본은 언제나 안읽음이다. 사람이 '전체'를 골랐어도 다음 방문은 다시 받은편지함에서
  // 시작한다 — 그 선택을 기억하면 다음 날 또 스물일곱 줄로 맞이하게 된다.
  let selectedModeratorMode = 'unread';
  // 이번 보기 동안 읽은 줄. 펼쳐 읽는 순간 목록에서 빠지면 다음 줄이 커서 밑으로 올라와
  // 엉뚱한 것을 누르게 된다. 자리는 지키되 무게를 낮추고, 새로고침 · 보기 전환에서 나간다.
  const moderatorJustRead = new Map();
  // 폴링이 목록을 다시 그려도 사람이 열어 둔 행과 편집 중인 글은 살아남아야 한다.
  const moderatorOpenItems = new Set();
  let moderatorEditingId = '';
  let moderatorEditDraft = null;
  let moderatorData = null;
  let moderatorPollTimer = null;
  // 사이드바 배지가 마지막으로 확인한 안읽음 수. null은 "아직 못 물어봤다"이고 0과 다르다 —
  // 0은 "확인할 것이 없다"는 사실이지만 null은 사실이 아니므로 배지를 세우지 않는다.
  let moderatorUnreadBadge = null;
  let moderatorBadgeTimer = null;
  let moderatorInFlight = false;
  let moderatorSyncedAt = 0;
  let moderatorBusy = false;
  // 같은 명령을 다시 보낼 때는 같은 idempotency key를 쓴다 — 실패 뒤 재시도가
  // 두 번째 명령을 만들면 안 된다. 글이 바뀌면 그때 새 키를 만든다.
  let moderatorPendingKey = '';
  let moderatorPendingText = '';

  function moderatorIdempotencyKey() {
    const random = typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/gu, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    return `direct-${random}`;
  }

  // quiet: 실패해도 화면을 옮기지 않는다. 배지처럼 화면의 본체가 아닌 요청에만 쓴다 —
  // 부가 정보 하나가 답하지 않는다고 사용자를 랜딩으로 내보내면 안 된다.
  async function requestModerator(path, { method = 'GET', body = null, signal, quiet = false } = {}) {
    const separator = path.includes('?') ? '&' : '?';
    const url = method === 'GET' ? `${API_URL}${path}${separator}_=${Date.now()}` : `${API_URL}${path}`;
    const response = await fetch(url, {
      method,
      cache: 'no-store',
      signal,
      headers: body
        ? { authorization: `Bearer ${localStorage.getItem('hvsdcm.token') || ''}`, 'content-type': 'application/json' }
        : { authorization: `Bearer ${localStorage.getItem('hvsdcm.token') || ''}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401) {
      if (quiet) throw new Error('unauthorized');
      localStorage.removeItem('hvsdcm.token');
      location.replace(loginPath());
      throw new Error('unauthorized');
    }
    // 소유자가 아니면 Worker가 라우트의 존재까지 숨긴다(404). 화면도 같은 판정을 따른다.
    if (response.status === 404 || response.status === 403) {
      if (!quiet) location.replace('/');
      throw new Error('unauthorized');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(MODERATOR_ERRORS[data.error] || data.error || '모더 상태를 불러오지 못했습니다.');
    }
    return data;
  }

  function moderatorApi(path, options) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    return withTimeout(
      requestModerator(path, { ...options, signal: controller?.signal }),
      REQUEST_TIMEOUT_MS,
      () => controller?.abort(),
    );
  }

  // ---- 모더 렌더 -----------------------------------------------------------

  function moderatorFact(label, value, mono = false) {
    const text = String(value ?? '').trim();
    const classes = text ? (mono ? ['md-fact-mono'] : []) : ['md-fact-unknown'];
    const attribute = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
    return `<div><dt>${escapeHtml(label)}</dt><dd${attribute}>${escapeHtml(text || MODERATOR_UNKNOWN)}</dd></div>`;
  }

  // 승인한 주체가 누구인지는 상태만으로 알 수 없다. 사용자가 누른 승인과 모더가 스스로
  // 내린 판정이 둘 다 'approved'로 앉기 때문이다. 서버가 남기는 moderator_approved
  // 이벤트가 그 둘을 가르는 유일한 사실이므로 배지 문구도 거기서 끌어온다.
  function moderatorSelfApproved(item) {
    const events = Array.isArray(item?.events) ? item.events : [];
    return events.some((event) => event?.event === 'moderator_approved');
  }

  function moderatorApprovalBasis(item) {
    const events = Array.isArray(item?.events) ? item.events : [];
    const found = events.find((event) => event?.event === 'moderator_approved');
    return String(found?.payload?.policy_basis || '').trim();
  }

  function moderatorStatusBadge(status, selfApproved = false) {
    const label = selfApproved && status === 'approved'
      ? '모더 승인'
      : MODERATOR_STATUS_LABELS[status] || status || MODERATOR_UNKNOWN;
    const tone = MODERATOR_STATUS_TONES[status];
    return `<span class="badge${tone ? ` badge-${tone}` : ''} disclosure-hint">${escapeHtml(label)}</span>`;
  }

  // 모더가 살아 있는지는 **데몬의 하트비트**로만 알 수 있다. 예전에는 이 자리에 마지막
  // 항목 시각(brain.updated_at)이 '모델 마지막 보고'라는 이름으로 서 있었다 — 데몬이
  // 죽어도 그 숫자는 마지막 항목 시각에 얼어붙어, 화면이 죽음을 생존처럼 보고했다.
  function moderatorLiveness(data, now) {
    const heartbeatAt = Date.parse(String(data?.daemon?.heartbeat_at || ''));
    if (!Number.isFinite(heartbeatAt)) {
      return { text: '보고된 적 없음', stale: true };
    }
    const staleAfter = finiteNumber(data?.daemon?.stale_after_ms) ?? 15 * 60 * 1000;
    const age = now - heartbeatAt;
    return {
      text: age > staleAfter
        ? `${relativeTime(data.daemon.heartbeat_at, now)} — 그 뒤로 점검이 없습니다`
        : relativeTime(data.daemon.heartbeat_at, now),
      stale: age > staleAfter,
    };
  }

  function renderModeratorBrain(data, now = Date.now()) {
    const brain = data?.brain && typeof data.brain === 'object' ? data.brain : {};
    const commands = finiteNumber(data?.active_commands) ?? 0;
    const sessions = finiteNumber(data?.active_sessions) ?? 0;
    const liveness = moderatorLiveness(data, now);
    const workerModel = String(brain.worker_model ?? '').trim();
    // 결정론적 커널은 요약 모델을 부르지 않는다. 그 칸을 '미확인'으로 두면 매번 확인에
    // 실패한 것처럼 읽히므로, 개념이 없다는 사실을 그대로 적는다.
    const summaryFallback = String(brain.model ?? '').trim() === MODERATOR_DETERMINISTIC_MODEL
      ? MODERATOR_NOT_APPLICABLE
      : '';
    return `<p class="us-eyebrow">모더가 쓰는 모델</p>
      <dl class="md-facts">
        ${moderatorFact('뇌 모델', moderatorModelName(brain.model), true)}
        ${moderatorFact('뇌 추론', moderatorReasoningName(brain.reasoning))}
        ${moderatorFact('요약 모델', workerModel ? moderatorModelName(workerModel) : summaryFallback, true)}
        ${moderatorFact('요약 추론', workerModel ? moderatorReasoningName(brain.worker_reasoning) : summaryFallback)}
        ${moderatorFact('대기 · 실행 중 명령', `${commands}건`)}
        ${moderatorFact('활성 세션', `${sessions}개`)}
        ${moderatorFact('모더 마지막 점검', liveness.text)}
        ${moderatorFact('마지막 항목', relativeTime(brain.updated_at, now))}
      </dl>`;
  }

  function moderatorCounts(data) {
    const counts = data?.counts && typeof data.counts === 'object' ? data.counts : {};
    const result = {};
    for (const kind of MODERATOR_KINDS) {
      // 기록의 개수는 서버의 `counts`가 아니라 **실제로 받은 명령 목록**에서 센다.
      // counts는 moderator_items만 집계하므로 기록에는 칸 자체가 없다.
      if (kind.key === MODERATOR_RECORD_KIND) {
        const commands = Array.isArray(data?.commands) ? data.commands : [];
        result[kind.key] = { total: commands.length, open: 0 };
        continue;
      }
      const bucket = counts[kind.key] && typeof counts[kind.key] === 'object' ? counts[kind.key] : {};
      let total = 0;
      let open = 0;
      for (const [status, value] of Object.entries(bucket)) {
        const number = finiteNumber(value) ?? 0;
        total += number;
        if (MODERATOR_OPEN_STATUSES[kind.key].has(status)) open += number;
      }
      result[kind.key] = { total, open };
    }
    return result;
  }

  // 손이 필요한 항목은 **보는 것만으로 읽음이 되지 않는다.** 눈으로 지워 버리면 할 일이
  // 조용히 사라진다 — '확인함 · 승인 · 거부'라는 행동으로만 목록에서 나간다. 서버가
  // 같은 규칙으로 unread를 판정하므로(worker/src/router.js) 여기서는 서버 값을 믿고,
  // 그 칸이 아직 없는 서버를 만나면 같은 규칙으로 직접 센다.
  function moderatorNeedsAction(item) {
    return (item?.kind === 'important' && item.status === 'open')
      || (item?.kind === 'proposal' && item.status === 'pending');
  }

  function moderatorItemUnread(item) {
    if (typeof item?.unread === 'boolean') return item.unread;
    if (moderatorNeedsAction(item)) return true;
    return (finiteNumber(item?.seen_version) ?? 0) < (finiteNumber(item?.version) ?? 0);
  }

  function moderatorCommandUnread(command) {
    if (typeof command?.unread === 'boolean') return command.unread;
    const seen = String(command?.seen_at || '');
    return seen === '' || seen < String(command?.updated_at || '');
  }

  function moderatorKindLabel(key) {
    return MODERATOR_KINDS.find((entry) => entry.key === key)?.label || MODERATOR_UNKNOWN;
  }

  // 개수는 서버의 unread_counts를 쓴다. 받은 목록에서 세면 페이지(limit 50) 밖의 안읽음을
  // 놓쳐 "확인할 것이 없다"는 거짓말을 화면이 하게 된다. 서버가 그 칸을 아직 주지 않으면
  // 받은 목록으로 대신 세되, 그때는 그 한계가 그대로 남는다.
  function moderatorUnreadCounts(data) {
    const server = data?.unread_counts && typeof data.unread_counts === 'object' ? data.unread_counts : null;
    const items = Array.isArray(data?.items) ? data.items : [];
    const commands = Array.isArray(data?.commands) ? data.commands : [];
    const result = {};
    for (const kind of MODERATOR_KINDS) {
      const reported = server ? finiteNumber(server[kind.key]) : null;
      result[kind.key] = reported ?? (kind.key === MODERATOR_RECORD_KIND
        ? commands.filter(moderatorCommandUnread).length
        : items.filter((item) => item?.kind === kind.key && moderatorItemUnread(item)).length);
    }
    return result;
  }

  function moderatorUnreadTotal(data) {
    const counts = moderatorUnreadCounts(data);
    return MODERATOR_KINDS.reduce((sum, kind) => sum + (counts[kind.key] || 0), 0);
  }

  // 안읽음 목록은 분류를 가로질러 한 줄로 선다. 정렬은 '손이 필요한 것 먼저, 그다음
  // 최근 순'이다 — 사용자가 물은 것이 "내가 필요한 것"이기 때문이다.
  function moderatorUnreadRows(data) {
    const seen = new Set();
    const rows = [];
    const push = (row) => {
      if (seen.has(row.key)) return;
      seen.add(row.key);
      rows.push(row);
    };
    for (const item of Array.isArray(data?.items) ? data.items : []) {
      if (!moderatorItemUnread(item)) continue;
      push({
        key: `item:${String(item?.item_id || '')}`,
        type: 'item',
        value: item,
        needsAction: moderatorNeedsAction(item),
        at: String(item?.updated_at || ''),
        read: false,
      });
    }
    for (const command of Array.isArray(data?.commands) ? data.commands : []) {
      if (!moderatorCommandUnread(command)) continue;
      push({
        key: `command:${String(command?.command_id || '')}`,
        type: 'command',
        value: command,
        needsAction: false,
        at: String(command?.updated_at || ''),
        read: false,
      });
    }
    for (const row of moderatorJustRead.values()) push({ ...row, read: true });
    rows.sort((left, right) => {
      if (left.needsAction !== right.needsAction) return left.needsAction ? -1 : 1;
      return right.at.localeCompare(left.at);
    });
    return rows;
  }

  // 기본 선택은 **손이 필요한 쪽**이다. 아무 분류도 열려 있지 않으면 기록이 있는 첫
  // 분류를 열고, 그것도 없으면 중요를 연다. 사람이 한 번 고르면 그 선택이 이긴다.
  function moderatorDefaultKind(data) {
    const counts = moderatorCounts(data);
    // 기록은 기본 선택 후보가 아니다. 손이 필요한 곳을 먼저 여는 것이 이 함수의 목적인데,
    // 기록에는 손이 필요한 상태가 없다. 후보에서 빼지 않으면 항목이 하나도 없고 명령
    // 이력만 있을 때 기록이 열려, 확인해야 할 것이 없다는 사실이 화면에서 사라진다.
    const candidates = MODERATOR_KINDS.filter((kind) => kind.key !== MODERATOR_RECORD_KIND);
    for (const kind of candidates) if (counts[kind.key].open > 0) return kind.key;
    for (const kind of candidates) if (counts[kind.key].total > 0) return kind.key;
    return 'important';
  }

  // 보기 전환과 분류 칩. 분류 칩은 '전체'에서만 선다 — 두 축을 같은 모양으로 나란히
  // 두면 컨트롤 넷과 컨트롤 둘이 한 벌로 읽혀, 무엇이 무엇을 거르는지 알 수 없다.
  // '전체'에는 개수를 적지 않는다: 안읽음 모드에서 서버가 안읽음만 돌려주므로 기록의
  // 전체 개수를 셀 수 없고, 셀 수 없는 값을 적으면 화면이 조용히 틀린 수를 말한다.
  function renderModeratorControls(data, mode, selected) {
    const unread = moderatorUnreadTotal(data);
    const modes = MODERATOR_MODES.map((entry) => {
      const count = entry.key === 'unread'
        ? `<span class="md-filter-count">${unread}</span>`
        : '';
      return `<button class="segmented-btn md-mode-btn" type="button" data-mod-mode="${entry.key}" aria-pressed="${entry.key === mode}">`
        + `<span class="md-mode-label">${entry.label}</span>${count}</button>`;
    }).join('');
    return `<div class="md-controls">
        <div class="segmented md-mode-set" role="group" aria-label="보기">${modes}</div>
        ${mode === 'all' ? renderModeratorFilter(data, selected) : ''}
      </div>`;
  }

  function renderModeratorFilter(data, selected) {
    const counts = moderatorCounts(data);
    const buttons = MODERATOR_KINDS.map((kind) => {
      const active = kind.key === selected;
      return `<button class="segmented-btn md-filter-btn" type="button" data-mod-kind="${kind.key}" aria-pressed="${active}">`
        + `<span class="md-filter-label">${kind.label}</span>`
        + `<span class="md-filter-count">${counts[kind.key].total}</span></button>`;
    }).join('');
    return `<div class="segmented md-filter-set">${buttons}</div>`;
  }

  function moderatorItemActions(item) {
    const id = escapeHtml(String(item?.item_id || ''));
    if (item?.kind === 'proposal' && item.status === 'pending') {
      if (moderatorEditingId === item.item_id) {
        const draft = moderatorEditDraft === null ? String(item.proposed_command || '') : moderatorEditDraft;
        return `<div class="md-edit">
            <label class="field-label" for="modEdit">고칠 명령</label>
            <textarea id="modEdit" class="field-input md-edit-input" rows="4" data-mod-edit="${id}">${escapeHtml(draft)}</textarea>
            <p class="field-hint">저장해도 실행되지 않습니다. 고친 제안은 다시 승인 대기로 남습니다.</p>
            <div class="md-actions">
              <button class="btn btn-primary btn-sm" type="button" data-mod-action="save" data-mod-item="${id}">고쳐서 저장</button>
              <button class="btn btn-ghost btn-sm" type="button" data-mod-action="cancel" data-mod-item="${id}">취소</button>
            </div>
          </div>`;
      }
      return `<div class="md-actions">
          <button class="btn btn-primary btn-sm" type="button" data-mod-action="approve" data-mod-item="${id}">승인</button>
          <button class="btn btn-secondary btn-sm" type="button" data-mod-action="edit" data-mod-item="${id}">수정</button>
          <button class="btn btn-danger btn-sm" type="button" data-mod-action="reject" data-mod-item="${id}">거부</button>
        </div>`;
    }
    if (item?.kind === 'important' && item.status === 'open') {
      return `<div class="md-actions">
          <button class="btn btn-secondary btn-sm" type="button" data-mod-action="acknowledge" data-mod-item="${id}">확인함으로 표시</button>
        </div>`;
    }
    return '';
  }

  // showKind: 안읽음 목록은 분류를 가로지르므로 각 줄이 자기 출처를 말해야 한다.
  // read: 이번 보기 동안 읽은 줄. 무게만 낮추고 자리는 지킨다.
  function renderModeratorItem(item, now, options = {}) {
    const id = String(item?.item_id || '');
    const pending = item?.kind === 'proposal' && item.status === 'pending';
    const selfApproved = moderatorSelfApproved(item);
    const basis = moderatorApprovalBasis(item);
    const command = String(item?.proposed_command || '').trim();
    const quoteLabel = pending
      ? '승인하면 실행할 명령'
      : selfApproved ? '모더가 스스로 승인해 실행한 명령' : '이 제안의 명령';
    const quoteNote = pending
      ? '<p class="md-quote-note">아직 실행되지 않았습니다. 승인해야 대기열에 들어갑니다.</p>'
      : selfApproved
        ? `<p class="md-quote-note">사용자 승인 대상이 아니라 바로 대기열에 들어갔습니다${basis ? ` — ${escapeHtml(basis)}` : ''}.</p>`
        : '';
    const quote = command
      ? `<div class="md-quote">
          <p class="md-quote-label">${quoteLabel}</p>
          <p class="md-quote-body">${escapeHtml(command)}</p>
          ${quoteNote}
        </div>`
      : '';
    return `<details class="disclosure md-item${options.read ? ' is-read' : ''}" data-mod-item-row="${escapeHtml(id)}"${moderatorOpenItems.has(id) ? ' open' : ''}>
        <summary class="disclosure-head md-item-head">
          <span class="md-item-body">
            <span class="disclosure-title md-item-issue">${escapeHtml(item?.issue_summary || MODERATOR_UNKNOWN)}</span>
            <span class="md-item-action">${escapeHtml(item?.action_summary || MODERATOR_UNKNOWN)}</span>
          </span>
          ${moderatorRowMarks(item?.kind, options)}
          ${moderatorStatusBadge(item?.status, selfApproved)}
        </summary>
        <div class="disclosure-body">
          ${quote}
          <dl class="md-facts">
            ${moderatorFact('판단 주체', moderatorDecidedBy(item))}
            ${moderatorFact('연결된 세션', moderatorSessionName(item?.source_task_id))}
            ${moderatorFact('마지막 갱신', relativeTime(item?.updated_at, now))}
          </dl>
          ${moderatorItemActions(item)}
        </div>
      </details>`;
  }

  function renderModeratorItems(data, selected, now) {
    const kind = MODERATOR_KINDS.find((entry) => entry.key === selected) || MODERATOR_KINDS[0];
    const counts = moderatorCounts(data)[kind.key];
    // 기록은 항목이 아니라 실행 이력이므로 본문을 다른 렌더러가 만든다. 머리·리드·개수
    // 조판은 네 분류가 똑같이 쓴다 — 한 분류만 다른 모양이면 필터가 분류가 아니라
    // 서로 다른 화면 넷을 여는 것이 된다.
    const rows = kind.key === MODERATOR_RECORD_KIND
      ? renderModeratorCommands(data, now)
      : (() => {
        const items = (Array.isArray(data?.items) ? data.items : []).filter((item) => item?.kind === kind.key);
        return items.length === 0
          ? `<p class="us-empty">${kind.empty}</p>`
          : `<div class="md-list">${items.map((item) => renderModeratorItem(item, now)).join('')}</div>`;
      })();
    const countLine = kind.key === MODERATOR_RECORD_KIND
      ? `${kind.openLabel} ${counts.total}건`
      : `${kind.openLabel} ${counts.open}건`;
    return `<div class="md-group-head">
        <h2 class="list-group-head">${kind.label}</h2>
        <p class="md-group-count">${countLine}</p>
      </div>
      <p class="md-lead">${kind.lead}</p>
      ${rows}`;
  }

  // 안읽음 한 목록. 분류 넷의 머리·리드·개수 조판을 그대로 쓴다 — 다섯 번째 화면이
  // 아니라 같은 목록을 다르게 거른 것이기 때문이다.
  function renderModeratorUnread(data, now) {
    const rows = moderatorUnreadRows(data);
    const total = moderatorUnreadTotal(data);
    const needsAction = rows.filter((row) => row.needsAction).length;
    // '모두 읽음'은 읽음으로 지울 수 있는 줄이 있을 때만 선다. 손이 필요한 줄만 남았는데
    // 버튼이 서 있으면, 눌러도 목록이 그대로여서 버튼이 고장 난 것처럼 보인다.
    const clearable = rows.some((row) => !row.read && !row.needsAction);
    const countLine = needsAction > 0
      ? `안읽음 ${total}건 · 손이 필요한 것 ${needsAction}건`
      : `안읽음 ${total}건`;
    const body = rows.length === 0
      ? `<p class="us-empty">${MODERATOR_UNREAD_EMPTY}</p>`
      : `<div class="md-list">${rows.map((row) => (row.type === 'item'
        ? renderModeratorItem(row.value, now, { showKind: true, read: row.read })
        : renderModeratorCommand(row.value, now, { showKind: true, read: row.read }))).join('')}</div>`;
    return `<div class="md-group-head">
        <h2 class="list-group-head">안읽음</h2>
        <div class="md-group-aside">
          <p class="md-group-count">${countLine}</p>
          ${clearable ? '<button class="btn btn-secondary btn-sm" type="button" data-mod-action="read-all">모두 읽음</button>' : ''}
        </div>
      </div>
      <p class="md-lead">${MODERATOR_UNREAD_LEAD}</p>
      ${body}`;
  }

  function moderatorCommandLines(command) {
    const issue = String(command?.issue_summary || '').trim();
    const action = String(command?.action_summary || '').trim();
    if (issue || action) return { issue: issue || MODERATOR_UNKNOWN, action: action || MODERATOR_UNKNOWN };
    return {
      issue: String(command?.command_text || '').trim().split('\n')[0] || MODERATOR_UNKNOWN,
      action: MODERATOR_COMMAND_WAITING[command?.status] || '요약이 기록되지 않았습니다.',
    };
  }

  // 읽음 표시와 분류 라벨. 색은 쓰지 않는다 — 이 화면에서 색은 상태의 것이다
  // (DESIGN.md §3). 읽음은 눈으로는 무게로, 보조기술에는 낱말로 전한다.
  function moderatorRowMarks(kind, options = {}) {
    const read = options.read ? '<span class="sr-only">읽음</span>' : '';
    const label = options.showKind
      ? `<span class="md-item-kind">${escapeHtml(moderatorKindLabel(kind))}</span>`
      : '';
    return `${read}${label}`;
  }

  function renderModeratorCommand(command, now, options = {}) {
    const lines = moderatorCommandLines(command);
    const id = String(command?.command_id || '');
    return `<details class="disclosure md-item${options.read ? ' is-read' : ''}" data-mod-command-row="${escapeHtml(id)}"${moderatorOpenItems.has(id) ? ' open' : ''}>
        <summary class="disclosure-head md-item-head">
          <span class="md-item-body">
            <span class="disclosure-title md-item-issue">${escapeHtml(lines.issue)}</span>
            <span class="md-item-action">${escapeHtml(lines.action)}</span>
          </span>
          <span class="md-item-id">${escapeHtml(id || MODERATOR_UNKNOWN)}</span>
          ${moderatorRowMarks(MODERATOR_RECORD_KIND, options)}
          ${moderatorStatusBadge(command?.status)}
        </summary>
        <div class="disclosure-body">
          <div class="md-quote">
            <p class="md-quote-label">보낸 명령</p>
            <p class="md-quote-body">${escapeHtml(String(command?.command_text || '').trim() || MODERATOR_UNKNOWN)}</p>
          </div>
          <dl class="md-facts">
            ${moderatorFact('명령 ID', id, true)}
            ${moderatorFact('출처', MODERATOR_SOURCE_LABELS[command?.source] || command?.source)}
            ${moderatorFact('요청 모델', moderatorModelName(command?.requested_model), true)}
            ${moderatorFact('실행 모델', moderatorModelName(command?.actual_model), true)}
            ${moderatorFact('실행 추론', moderatorReasoningName(command?.actual_reasoning))}
            ${moderatorFact('시도', `${finiteNumber(command?.attempts) ?? 0}회`)}
            ${moderatorFact('마지막 갱신', relativeTime(command?.updated_at, now))}
          </dl>
        </div>
      </details>`;
  }

  // '기록' 분류의 **본문만** 만든다. 머리·리드·개수는 renderModeratorItems가 네 분류에
  // 똑같이 붙인다 — 예전에는 이 함수가 자기 머리를 따로 그려 목록 아래 상시 블록으로
  // 섰고, 그래서 화면에 "분류 셋 + 그 아래 항상 보이는 명령 기록"이라는 축이 둘이었다.
  function renderModeratorCommands(data, now) {
    const commands = Array.isArray(data?.commands) ? data.commands : [];
    if (commands.length === 0) return '<p class="us-empty">아직 실행된 명령이 없습니다.</p>';
    return `<div class="md-list">${commands.map((command) => renderModeratorCommand(command, now)).join('')}</div>`;
  }

  // ---- 모더 배선 -----------------------------------------------------------

  function setModeratorHtml(element, markup) {
    if (element && typeof element.innerHTML === 'string') element.innerHTML = markup;
  }

  function renderModerator(data, now = Date.now()) {
    // 모더 뷰를 그릴 때마다 배지도 같은 숫자를 쓴다. 두 표면이 서로 다른 수를 말하면
    // 어느 쪽도 믿을 수 없게 된다.
    moderatorUnreadBadge = moderatorUnreadTotal(data);
    renderModeratorBadge();
    const mode = MODERATOR_MODE_KEYS.has(selectedModeratorMode) ? selectedModeratorMode : 'unread';
    const kind = MODERATOR_KIND_KEYS.has(selectedModeratorKind)
      ? selectedModeratorKind
      : moderatorDefaultKind(data);
    setModeratorHtml(modElements.brain, renderModeratorBrain(data, now));
    setModeratorHtml(modElements.filter, renderModeratorControls(data, mode, kind));
    setModeratorHtml(modElements.items, mode === 'unread'
      ? renderModeratorUnread(data, now)
      : renderModeratorItems(data, kind, now));
  }

  // 사이드바의 안읽음 배지. 이것이 없으면 확인할 것이 있는지 알기 위해 매번 모더 탭을
  // 열어야 하고, 그 수고가 "필요한 것만 딱 보이게 해달라"는 요구의 마지막 한 칸을 남긴다.
  //
  // 0이면 배지를 세우지 않는다. 0을 숫자로 적는 것은 "없다"를 굳이 표시해 두는 것이고,
  // 그러면 배지가 늘 떠 있어 '있다'는 신호가 죽는다.
  // 배지가 무엇을 말할지는 순수 함수로 정하고 DOM 적용과 나눈다. 나머지 렌더러가 마크업
  // 문자열을 돌려주는 것과 같은 결이며, 그래야 게이트가 이 판정을 실제로 실행해 볼 수 있다.
  function moderatorBadgeState(total) {
    if (!Number.isFinite(total) || total <= 0) return { hidden: true, text: '', label: '' };
    return {
      hidden: false,
      // 세 자리가 넘으면 사이드바 항목의 라벨을 밀어낸다. 정확한 수는 탭 안에서 말한다.
      text: total > 99 ? '99+' : String(total),
      // 숫자만 두면 보조기술에는 '3'으로만 읽혀 무엇의 3인지 알 수 없다.
      label: `모더, 안읽음 ${total}건`,
    };
  }

  function renderModeratorBadge(total = moderatorUnreadBadge) {
    const badge = modElements.tabBadge;
    if (!badge) return;
    const state = moderatorBadgeState(total);
    badge.hidden = state.hidden;
    badge.textContent = state.text;
    if (state.label) modElements.tab?.setAttribute?.('aria-label', state.label);
    else modElements.tab?.removeAttribute?.('aria-label');
  }

  function scheduleModeratorBadgePoll() {
    clearTimeout(moderatorBadgeTimer);
    moderatorBadgeTimer = null;
    // 모더 뷰가 열려 있으면 그쪽 폴링이 배지까지 갱신한다. 탭이 숨겨져 있으면 멈춘다.
    if (isHidden() || selectedUsageView === 'moderator') return;
    moderatorBadgeTimer = setTimeout(() => { void loadModeratorBadge(); }, MODERATOR_POLL_IDLE_MS);
  }

  // 배지는 부가 정보다. 모더 API가 무슨 이유로든 답하지 않아도 실행 현황 화면까지 끌고
  // 내려가서는 안 된다 — 그래서 이 경로만 리다이렉트와 오류 표시를 끄고 조용히 실패한다.
  // 개수만 필요하므로 limit=1로 부른다: unread_counts는 D1 전수 집계라 목록 길이와 무관하다.
  async function loadModeratorBadge() {
    try {
      const data = await moderatorApi('/api/moderator?limit=1&unread=1', { quiet: true });
      moderatorUnreadBadge = moderatorUnreadTotal(data);
    } catch {
      // 마지막으로 알던 수를 지우지 않는다. 한 번 실패했다고 배지를 없애면 확인할 것이
      // 있는데도 없는 것처럼 보인다.
    } finally {
      renderModeratorBadge();
      scheduleModeratorBadgePoll();
    }
  }

  function renderModeratorFreshness() {
    if (!modElements.freshness) return;
    if (!moderatorSyncedAt) {
      modElements.freshness.textContent = '';
      return;
    }
    const seconds = Math.max(0, Math.round((Date.now() - moderatorSyncedAt) / 1000));
    const elapsed = seconds < 60 ? `${seconds}초 전` : `${formatDuration(seconds * 1000)} 전`;
    const cadence = isHidden() || selectedUsageView !== 'moderator'
      ? '자동 갱신 멈춤'
      : `${Math.round(moderatorPollDelay() / 1000)}초마다 자동 갱신`;
    modElements.freshness.textContent = `화면 갱신 ${elapsed} · ${cadence}`;
  }

  function moderatorPollDelay() {
    const active = finiteNumber(moderatorData?.active_commands) ?? 0;
    return active > 0 ? MODERATOR_POLL_ACTIVE_MS : MODERATOR_POLL_IDLE_MS;
  }

  function scheduleModeratorPoll() {
    clearTimeout(moderatorPollTimer);
    moderatorPollTimer = null;
    if (isHidden() || selectedUsageView !== 'moderator') return;
    moderatorPollTimer = setTimeout(() => { void loadModerator(); }, moderatorPollDelay());
  }

  async function loadModerator({ announce = false } = {}) {
    if (moderatorInFlight) return;
    moderatorInFlight = true;
    if (modElements.error) modElements.error.textContent = '';
    if (announce && modElements.refreshStatus) {
      modElements.refreshStatus.textContent = '모더 상태를 확인하고 있습니다.';
    }
    try {
      // 안읽음 모드는 서버에서 거른다. 여기서 거르면 limit 50 페이지 밖의 안읽음이
      // 화면에 영영 오지 않는다 — 쌓임을 막으려는 화면이 쌓인 것을 숨기게 된다.
      const data = await moderatorApi(selectedModeratorMode === 'unread'
        ? `${MODERATOR_PATH}&unread=1`
        : MODERATOR_PATH);
      moderatorData = data;
      moderatorSyncedAt = Date.now();
      renderModerator(data);
      if (announce && modElements.refreshStatus) {
        modElements.refreshStatus.textContent = '서버에서 방금 확인했습니다.';
      }
    } catch (error) {
      if (error.message === 'unauthorized') return;
      if (modElements.error) modElements.error.textContent = error.message || '모더 상태를 불러오지 못했습니다.';
      if (announce && modElements.refreshStatus) modElements.refreshStatus.textContent = '업데이트하지 못했습니다.';
    } finally {
      moderatorInFlight = false;
      scheduleModeratorPoll();
      renderModeratorFreshness();
    }
  }

  function moderatorRowById(id) {
    for (const key of [`item:${id}`, `command:${id}`]) {
      const cached = moderatorJustRead.get(key);
      if (cached) return cached;
    }
    const item = (Array.isArray(moderatorData?.items) ? moderatorData.items : [])
      .find((entry) => String(entry?.item_id || '') === id);
    if (item) {
      return {
        key: `item:${id}`,
        type: 'item',
        value: item,
        needsAction: moderatorNeedsAction(item),
        at: String(item?.updated_at || ''),
        read: false,
      };
    }
    const command = (Array.isArray(moderatorData?.commands) ? moderatorData.commands : [])
      .find((entry) => String(entry?.command_id || '') === id);
    if (!command) return null;
    return {
      key: `command:${id}`,
      type: 'command',
      value: command,
      needsAction: false,
      at: String(command?.updated_at || ''),
      read: false,
    };
  }

  // 읽음은 **서버에** 남긴다. localStorage에 두면 브라우저 데이터를 지우거나 폰에서 열 때
  // 쌓임이 그대로 되살아난다 — 그러면 이 기능은 이 브라우저에서만 참인 위안이 된다.
  //
  // 본 version(항목) · updated_at(명령)을 그대로 되돌려 주므로, 읽는 사이에 바뀐 것을
  // 읽음으로 덮어쓰지 않는다. 서버는 그 값보다 낮게 내리지 않는다.
  async function markModeratorRead(rows) {
    const targets = rows.filter((row) => row && !row.read);
    const items = [];
    const commands = [];
    for (const row of targets) {
      if (row.type === 'item') {
        const version = finiteNumber(row.value?.version);
        const itemId = String(row.value?.item_id || '');
        if (itemId && version !== null) items.push({ item_id: itemId, version });
      } else {
        const commandId = String(row.value?.command_id || '');
        const updatedAt = String(row.value?.updated_at || '');
        if (commandId && updatedAt) commands.push({ command_id: commandId, updated_at: updatedAt });
      }
    }
    if (items.length === 0 && commands.length === 0) return;
    // 화면을 먼저 흐린다. 읽음은 되돌릴 수 있는 표시라 응답을 기다리며 손을 멈춰 세울
    // 이유가 없다. 실패하면 아래에서 되돌리고 다음 폴링이 원래 상태를 다시 그린다.
    for (const row of targets) moderatorJustRead.set(row.key, { ...row, read: true });
    if (moderatorData) renderModerator(moderatorData);
    try {
      // 서버가 한 번에 받는 상한은 **items와 commands를 합쳐** 200건이다
      // (worker/src/router.js MAX_MODERATOR_READ_ENTRIES). 둘을 따로 200씩 자르면
      // 한 번에 400건이 나가 413으로 되돌아온다. 그래서 이어 붙인 뒤 자른다.
      const queue = [
        ...items.map((entry) => ({ items: [entry], commands: [] })),
        ...commands.map((entry) => ({ items: [], commands: [entry] })),
      ];
      for (let offset = 0; offset < queue.length; offset += 200) {
        const chunk = queue.slice(offset, offset + 200);
        await moderatorApi('/api/moderator/read', {
          method: 'POST',
          body: {
            items: chunk.flatMap((entry) => entry.items),
            commands: chunk.flatMap((entry) => entry.commands),
          },
        });
      }
    } catch (error) {
      if (error.message === 'unauthorized') return;
      for (const row of targets) moderatorJustRead.delete(row.key);
      if (modElements.error) modElements.error.textContent = error.message || '읽음으로 표시하지 못했습니다.';
      if (moderatorData) renderModerator(moderatorData);
    }
  }

  function setModeratorBusy(busy) {
    moderatorBusy = busy;
    for (const button of [...(modElements.items?.querySelectorAll?.('[data-mod-action]') || [])]) {
      button.disabled = busy;
    }
  }

  // 버튼은 결과를 미리 그리지 않는다. 서버 응답을 받고, 그 응답으로 목록을 다시 읽은
  // 뒤에만 상태가 바뀐다 — 승인 전 실행 금지는 화면의 낙관적 표시로 흔들리면 안 된다.
  async function sendModeratorDecision(itemId, action, editedCommand) {
    if (moderatorBusy) return;
    setModeratorBusy(true);
    if (modElements.error) modElements.error.textContent = '';
    try {
      const path = action === 'acknowledge'
        ? `/api/moderator/items/${encodeURIComponent(itemId)}/acknowledge`
        : `/api/moderator/items/${encodeURIComponent(itemId)}/decision`;
      const body = action === 'acknowledge'
        ? {}
        : (action === 'edit' ? { action: 'edit', edited_command: editedCommand } : { action });
      await moderatorApi(path, { method: 'POST', body });
      moderatorEditingId = '';
      moderatorEditDraft = null;
      if (modElements.refreshStatus) {
        modElements.refreshStatus.textContent = action === 'approve'
          ? '승인했습니다. 이 제안의 명령이 대기열에 들어갔습니다.'
          : '처리했습니다.';
      }
      await loadModerator();
    } catch (error) {
      if (error.message === 'unauthorized') return;
      if (modElements.error) modElements.error.textContent = error.message || '처리하지 못했습니다.';
    } finally {
      setModeratorBusy(false);
    }
  }

  async function submitModeratorCommand(event) {
    event?.preventDefault?.();
    const text = String(modElements.commandText?.value ?? '').trim();
    if (!text) {
      if (modElements.commandStatus) modElements.commandStatus.textContent = '보낼 명령을 적어 주세요.';
      return;
    }
    if (moderatorBusy) return;
    if (text !== moderatorPendingText || !moderatorPendingKey) {
      moderatorPendingText = text;
      moderatorPendingKey = moderatorIdempotencyKey();
    }
    moderatorBusy = true;
    if (modElements.commandSubmit) {
      modElements.commandSubmit.disabled = true;
      modElements.commandSubmit.textContent = '보내는 중…';
    }
    if (modElements.commandStatus) modElements.commandStatus.textContent = '명령을 보내고 있습니다.';
    try {
      const data = await moderatorApi('/api/moderator/commands', {
        method: 'POST',
        body: { command: text, idempotency_key: moderatorPendingKey },
      });
      if (modElements.commandText) modElements.commandText.value = '';
      moderatorPendingKey = '';
      moderatorPendingText = '';
      if (modElements.commandStatus) {
        modElements.commandStatus.textContent = data?.duplicate
          ? '이미 접수된 명령입니다. 대기열에 하나만 있습니다.'
          : '대기열에 넣었습니다.';
      }
      await loadModerator();
    } catch (error) {
      if (error.message === 'unauthorized') return;
      if (modElements.commandStatus) {
        modElements.commandStatus.textContent = error.message || '명령을 보내지 못했습니다.';
      }
    } finally {
      moderatorBusy = false;
      if (modElements.commandSubmit) {
        modElements.commandSubmit.disabled = false;
        modElements.commandSubmit.textContent = '명령 보내기';
      }
    }
  }

  function wireModerator() {
    modElements.form?.addEventListener?.('submit', submitModeratorCommand);
    // 새로고침은 "다 봤다"는 뜻이기도 하다 — 이번 보기에서 읽은 줄은 여기서 목록을 뜬다.
    modElements.reload?.addEventListener?.('click', () => {
      moderatorJustRead.clear();
      void loadModerator({ announce: true });
    });
    modElements.filter?.addEventListener?.('click', (event) => {
      const modeButton = event.target?.closest?.('[data-mod-mode]');
      if (modeButton) {
        const mode = modeButton.dataset?.modMode || '';
        if (!MODERATOR_MODE_KEYS.has(mode) || mode === selectedModeratorMode) return;
        selectedModeratorMode = mode;
        moderatorJustRead.clear();
        // 질의 인자가 달라지므로 다시 받아야 한다. 그 전에 한 번 그려 전환이 즉시 보이게 한다.
        if (moderatorData) renderModerator(moderatorData);
        void loadModerator();
        return;
      }
      const button = event.target?.closest?.('[data-mod-kind]');
      if (!button) return;
      selectedModeratorKind = button.dataset?.modKind || selectedModeratorKind;
      if (moderatorData) renderModerator(moderatorData);
    });
    // 열고 접은 상태는 폴링을 넘어 살아남아야 한다 — 5초마다 손이 닫는 목록은 못 읽는다.
    modElements.items?.addEventListener?.('toggle', (event) => {
      const dataset = event.target?.dataset;
      const row = dataset?.modItemRow || dataset?.modCommandRow;
      if (!row) return;
      if (!event.target.open) {
        moderatorOpenItems.delete(row);
        return;
      }
      moderatorOpenItems.add(row);
      // **펼치는 것이 읽는 행위다.** 화면에 떴다는 이유로 읽음 처리하면, 자리를 비운 사이에
      // 올라온 것이 한 번도 눈에 걸리지 않고 지나간다.
      const target = moderatorRowById(row);
      if (target) void markModeratorRead([target]);
    }, true);
    modElements.items?.addEventListener?.('input', (event) => {
      if (event.target?.dataset?.modEdit) moderatorEditDraft = event.target.value;
    });
    modElements.items?.addEventListener?.('click', (event) => {
      const button = event.target?.closest?.('[data-mod-action]');
      if (!button) return;
      const action = button.dataset?.modAction;
      const itemId = button.dataset?.modItem || '';
      if (action === 'edit') {
        moderatorEditingId = itemId;
        moderatorEditDraft = null;
        moderatorOpenItems.add(itemId);
        if (moderatorData) renderModerator(moderatorData);
        return;
      }
      if (action === 'cancel') {
        moderatorEditingId = '';
        moderatorEditDraft = null;
        if (moderatorData) renderModerator(moderatorData);
        return;
      }
      if (action === 'save') {
        const draft = String(moderatorEditDraft ?? '').trim();
        if (!draft) {
          if (modElements.error) modElements.error.textContent = '고친 명령이 비어 있습니다.';
          return;
        }
        void sendModeratorDecision(itemId, 'edit', draft);
        return;
      }
      if (action === 'read-all') {
        void markModeratorRead(moderatorUnreadRows(moderatorData).filter((row) => !row.needsAction));
        return;
      }
      if (['approve', 'reject', 'acknowledge'].includes(action)) {
        void sendModeratorDecision(itemId, action);
      }
    });
  }

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
    if (modElements.opsView) modElements.opsView.hidden = next !== 'ops';
    if (modElements.view) modElements.view.hidden = next !== 'moderator';
    // 구조 뷰는 정지 마크업이다 — 열고 닫기만 하고 아무것도 가져오지 않는다.
    if (modElements.guideView) modElements.guideView.hidden = next !== 'guide';
    if (next === 'moderator') {
      clearTimeout(moderatorBadgeTimer);
      moderatorBadgeTimer = null;
      void loadModerator();
    } else {
      clearTimeout(moderatorPollTimer);
      moderatorPollTimer = null;
      // 실행 현황을 보는 동안에도 배지는 살아 있어야 한다. 모더 탭을 열어야만 확인할 것이
      // 있는지 알 수 있다면, 탭을 여는 수고가 그대로 남아 배지의 목적이 사라진다.
      void loadModeratorBadge();
    }
    renderModeratorFreshness();
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

  wireModerator();
  wireUsageViews();
  activateUsageView(selectedUsageView);

  window.USAGE_RENDER = {
    buildDashboard, renderSessionViews, renderSessionView, renderTask,
    sessionTasks, isResidentTask,
    renderTaskBody, renderPostList, taskPresentation, taskStatusKey, taskInput,
    sessionWorktree, renderWorktree, worktreeGuide,
    phaseTimeline, sessionUsageDeltas, actorNodes, phaseNodesOf,
    activateTaskTab, wireTaskTabs, activateSessionView, wireSessionViews, wireDashboard,
    wireLocalControls, load,
    // 모더 뷰 — 게이트가 렌더러를 실제로 실행해 계약을 본다 (scripts/usage.test.mjs).
    renderModeratorBrain, renderModeratorFilter, renderModeratorItems, renderModeratorCommands,
    moderatorCounts, moderatorDefaultKind, activateUsageView, loadModerator,
    renderModeratorControls, renderModeratorUnread, renderModeratorItem, renderModeratorCommand,
    moderatorUnreadRows, moderatorUnreadCounts,
    moderatorItemUnread, moderatorCommandUnread, moderatorNeedsAction,
    renderModeratorBadge, loadModeratorBadge, moderatorBadgeState,
  };
})();
