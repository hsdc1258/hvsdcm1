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
  // 진행 중 패널의 보기 모드. 관제탑이 기본이다 — "지금 무엇이 도는가"를 한눈에 보는
  // 것이 이 화면의 첫 질문이고, 세션 하나를 파고드는 조직도는 그 다음이다.
  const ACTIVE_MODES = [{ key: 'board', label: '관제탑' }, { key: 'org', label: '조직도' }];
  const ACTIVE_MODE_KEYS = new Set(ACTIVE_MODES.map((mode) => mode.key));
  // 모드는 새로고침을 넘어 유지된다 (계약 §A). 조직도를 골라 둔 사람에게 5초 폴링마다
  // 관제탑이 돌아오면 그 토글은 없는 것과 같다.
  const ACTIVE_MODE_KEY = 'hvsdcm.usage.activeMode';
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

  // 저장된 모드를 읽는다. localStorage는 사파리 프라이빗 모드처럼 **접근 자체가 던지는**
  // 환경이 있으므로 읽기·쓰기를 모두 감싼다 — 저장이 안 되는 브라우저에서 화면이 통째로
  // 죽는 것보다 모드가 기본값으로 돌아가는 편이 낫다.
  function readActiveMode() {
    try {
      const stored = localStorage.getItem(ACTIVE_MODE_KEY);
      return ACTIVE_MODE_KEYS.has(stored) ? stored : 'board';
    } catch {
      return 'board';
    }
  }

  function writeActiveMode(mode) {
    selectedActiveMode = ACTIVE_MODE_KEYS.has(mode) ? mode : 'board';
    try {
      localStorage.setItem(ACTIVE_MODE_KEY, selectedActiveMode);
    } catch { /* 저장 실패는 이번 세션의 모드만 잃는다 — 화면은 계속 돈다. */ }
    return selectedActiveMode;
  }

  let selectedActiveMode = readActiveMode();

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
  //   { kind, kindLabel, name, detail, model, note, status, tone, time,
  //     progress, facts, current, attributes, children }
  // model은 한 줄 고정(모노·말줄임)이고, facts는 라벨·값이 짝을 이루는 사실 목록이다.
  // **facts의 라벨은 NODE_FACT_LABELS에서만 나온다** — 마크업에 손으로 적지 않는다.

  function renderNodeAttributes(attributes) {
    return Object.entries(attributes || {})
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
      .join('');
  }

  // 라벨-값 한 줄씩. 값이 없는 항목은 줄 자체를 만들지 않는다 — 빈 값을 '없음'으로
  // 채우면 보고되지 않은 것과 보고된 빈 값이 구별되지 않는다.
  // 모델은 언제나 첫 줄이고 모노다(정확한 모델명이 한 줄에 고정되게).
  function renderNodeFacts(node) {
    const rows = [
      node.model ? { label: NODE_FACT_LABELS.model, value: node.model, mono: true } : null,
      ...(node.facts || []),
    ].filter((fact) => fact && fact.label && fact.value);
    if (rows.length === 0) return '';
    return `<dl class="h-node-facts">${rows.map((fact) => `<div><dt>${escapeHtml(fact.label)}</dt><dd${fact.mono ? ' class="h-node-fact-mono"' : ''}>${escapeHtml(fact.value)}</dd></div>`).join('')}</dl>`;
  }

  function renderNode(node) {
    const progress = Number.isFinite(node.progress) ? clampPercent(node.progress) : null;
    return `
      <article class="h-node is-${escapeHtml(node.kind)}${node.current ? ' is-current' : ''}"${renderNodeAttributes(node.attributes)}>
        <p class="h-node-kind">${escapeHtml(node.kindLabel || '노드')}${node.current ? '<span class="h-node-flag">작업중</span>' : ''}</p>
        <h5 class="h-node-name">${escapeHtml(node.name || '이름 미기록')}</h5>
        ${node.detail ? `<p class="h-node-detail">${escapeHtml(node.detail)}</p>` : ''}
        ${renderNodeFacts(node)}
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

  // 분기(서브에이전트) 가지. 부모 카드의 **오른쪽**으로 갈라지고, parent_id 자식은 그
  // 아래로 한 단 더 들어간다. 좌→우 연결선은 CSS 헤어라인이 그린다(DESIGN.md §10).
  function renderBranch(node) {
    const children = (node.children || []).filter(Boolean);
    return `<li class="h-node-slot">${renderNode(node)}${children.length ? `<ul>${children.map(renderBranch).join('')}</ul>` : ''}</li>`;
  }

  function renderBranchList(nodes) {
    const list = (nodes || []).filter(Boolean);
    if (list.length === 0) return '';
    return `<div class="h-branch"><ul class="h-tree">${list.map(renderBranch).join('')}</ul></div>`;
  }

  // 조직도의 뼈대는 **고전적인 조직도**다: 총괄이 최상단에 서고, 그 아래 수평 trunk에서
  // 단계마다 개별 stem이 내려온다 (DESIGN.md §1.1 v9 · review-visual B1).
  //
  // 예전에는 이 자리가 세로 1열 적층이었다. 데스크톱에서 조직도 컨테이너가 845px인데
  // 노드는 213px 한 열에만 쌓여 오른쪽 62%가 빈 검은 면이었고, 카드가 다섯 장 넘게
  // 세로로 이어져 §6의 "카드 3연속 스택" 금지에 걸렸다. 세로 직렬화는 **모바일에서만**
  // 허용되는 조판인데 그것이 데스크톱에 그대로 나와 있었다.
  //
  // 좌표는 여전히 손으로 계산하지 않는다 — 가로 배치도 브라우저의 flex가 잡고,
  // 커넥터는 CSS 헤어라인 의사요소가 그린다 (DESIGN.md §9·§10).
  const ORG_REST_STATES = ['skipped', 'pending'];

  // 카드가 되지 못한 단계는 **한 줄의 라벨-값**으로 남는다. 사실("이 단계는 보고가 없다")은
  // 그대로 남기면서, 빈 카드가 조직도의 세로 길이를 늘리는 것은 막는다 (review-visual B2 —
  // "고정 단계 골격을 먼저 그린 뒤 보고 없는 칸을 빈 카드로 채운다"). 판독용
  // data-org-phase·data-phase-state는 카드일 때와 같은 어휘로 남겨, 게이트가 여전히
  // "없던 단계를 완료로 지어내지 않는다"를 기계로 검사할 수 있게 한다.
  function renderOrgRest(rest) {
    if (rest.length === 0) return '';
    return `
        <dl class="h-orgchart-rest">
          ${rest.map((group) => `<div><dt>${escapeHtml(group.label)}</dt><dd>${group.phases
    .map((phase) => `<span data-org-phase="${escapeHtml(phase.key)}" data-phase-state="${escapeHtml(group.state)}">${escapeHtml(phase.label)}</span>`)
    .join('')}</dd></div>`).join('')}
        </dl>`;
  }

  function renderOrgTree(tree) {
    const branches = tree.branches.map((node) => `
          <div class="h-orgchart-branch">
            ${renderNode(node)}
            ${renderBranchList(node.children)}
          </div>`).join('');
    return `
      <div class="h-orgchart">
        <div class="h-orgchart-root">${renderNode(tree.lead)}</div>
        ${branches ? `<div class="h-orgchart-branches">${branches}</div>` : ''}
        ${renderOrgRest(tree.rest)}
      </div>`;
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
        model: modelAndReasoning(actor.model, actor.reasoning),
        // 역할·담당·소요·한도를 **각각** 낸다 (요구 2·4). 하나로 합치지 않는다.
        facts: [
          { label: NODE_FACT_LABELS.role, value: actor.role || '' },
          { label: NODE_FACT_LABELS.assignment, value: actor.assignment || '' },
          { label: NODE_FACT_LABELS.parent, value: detachedParent.get(actor.id) || '' },
          { label: NODE_FACT_LABELS.duration, value: duration },
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
      const model = modelAndReasoning(
        stat?.model || (isCurrent ? task.model : ''),
        stat?.reasoning || (isCurrent ? task.reasoning : ''),
      );
      return {
        kind: 'phase',
        kindLabel: NODE_KIND_LABELS.phase,
        name: phase.label,
        detail: phase.detail,
        model,
        // '기록 없음'이 왜 기록 없음인지 노드가 직접 말한다 (사용자 지시 ①).
        note: state === 'skipped' ? PHASE_SKIPPED_REASON : '',
        status: PHASE_STATE_LABELS[state],
        tone: isCurrent ? ' is-accent' : ' is-idle',
        time: stat && stat.duration > 0 ? formatDuration(stat.duration) : '',
        current: isCurrent,
        attributes: { 'data-org-phase': phase.key, 'data-phase-state': state },
        children: byPhase.get(phase.key) || [],
      };
    });
  }

  // 세션 하나의 조직도 모델 — **뿌리(총괄) + 단계 분기 + 카드가 되지 못한 단계**.
  //
  // 사용자 입력 노드는 없다 (review-visual M4 · DESIGN.md §1.1 "그 밖의 노드를 추측해
  // 추가하지 않는다"). 요청 원문은 이미 상세 머리의 `요청 원문` inset이 정본으로 내고
  // 있었고, 조직도가 같은 문장을 한 번 더 그리면 한 화면에 같은 문자열이 두 번 선다.
  // 남길 쪽은 사람이 아닌 노드를 만들지 않는 inset이다.
  function sessionOrgTree(task, now) {
    const phases = phaseNodesOf(task, now);
    const main = mainActorOf(task);
    // 단계는 **근거가 있을 때만 카드**가 된다: 보고된 단계(done·current)이거나, 보고는
    // 없어도 그 단계에 실제 액터가 붙어 있는 경우다. 나머지는 rest 줄로 내려간다.
    const branches = [];
    const restBy = new Map();
    for (const node of phases) {
      const state = node.attributes['data-phase-state'];
      if (state === 'done' || state === 'current' || (node.children || []).length > 0) {
        branches.push(node);
        continue;
      }
      const list = restBy.get(state) || [];
      list.push({ key: node.attributes['data-org-phase'], label: node.name });
      restBy.set(state, list);
    }
    const rest = ORG_REST_STATES
      .filter((state) => restBy.has(state))
      .map((state) => ({ state, label: PHASE_STATE_LABELS[state], phases: restBy.get(state) }));
    // 액터를 하나도 보고하지 않은 세션도 뿌리를 비우지 않는다 — 조직도 모양을 같게 두고
    // "보고가 없다"를 말한다. 뿌리를 지우면 단계만 남아 원인이 보이지 않는다.
    if (!main) {
      return {
        lead: {
          kind: 'lead',
          kindLabel: NODE_KIND_LABELS.lead,
          name: '에이전트 보고 없음',
          detail: '이 세션은 실행자를 보고하지 않았습니다',
        },
        branches,
        rest,
      };
    }
    // Main 노드는 `data-actor-id`가 붙은 **액터 카드**다. 그러므로 진행률도 그 액터의
    // 보고에서 와야 한다 (review WP3 major 4 — 예전에는 task.progress를 얹어서
    // 총괄이 17%를 보고해도 카드가 세션 전체의 82%로 렌더됐다).
    // 우선순위는 다른 액터와 같다: 이벤트가 측정한 값 → 액터 payload → (둘 다 없을 때만)
    // 세션 진행률. 마지막 폴백을 남기는 이유는 progress를 안 싣는 구 보고에서 총괄
    // 카드만 수치를 잃지 않게 하기 위해서다.
    const mainProgress = actorProgressMap(task).get(String(main.id));
    return {
      lead: {
        kind: 'lead',
        kindLabel: NODE_KIND_LABELS.lead,
        name: main.name || '이름 미기록',
        model: modelAndReasoning(main.model, main.reasoning),
        facts: [
          { label: NODE_FACT_LABELS.role, value: main.role || '' },
          { label: NODE_FACT_LABELS.assignment, value: main.assignment || '' },
          { label: NODE_FACT_LABELS.duration, value: actorDuration(main, task, now) },
          { label: NODE_FACT_LABELS.usage, value: actorUsageEstimate(main) },
        ],
        status: actorStatus(main),
        tone: statusDotClass(main.status),
        progress: mainProgress ?? finiteNumber(main.progress) ?? finiteNumber(task.progress),
        current: main.status === 'working' || main.status === 'reviewing',
        attributes: { 'data-actor-id': main.id || '' },
      },
      branches,
      rest,
    };
  }

  // ---- 조직도 껍데기 ------------------------------------------------------
  //
  // 예전에는 여기에 확대·이동 캔버스가 있었다. 지금은 **아무 변환도 하지 않는 컨테이너**
  // 하나뿐이다 (계약 §C). 트리는 일반 문서 흐름으로 원본 크기로 서고, 내용이 화면보다
  // 넓으면 이 컨테이너만 가로로 스크롤한다 — 페이지 본문이 좌우로 흔들리지 않는다.
  // 도구 줄(축소·확대·맞춤)과 힌트도 함께 사라졌다: 조작할 것이 없으므로 조작 UI도 없다.
  function renderOrgSection(label, treeMarkup) {
    return `
      <section class="h-org" aria-label="${escapeHtml(label)}">
        <header class="h-org-head">
          <div><p class="us-eyebrow">파이프라인</p><h4>실행 조직도</h4></div>
        </header>
        <div class="h-org-scroll" data-org-scroll tabindex="0" role="group"
          aria-label="실행 조직도. 내용이 넓으면 가로로 스크롤합니다">${treeMarkup}</div>
      </section>`;
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
        ${renderOrgSection(`${presentation.name} 실행 조직도`, renderOrgTree(sessionOrgTree(task, now)))}
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

  // ---- 관제탑 보드 ---------------------------------------------------------
  //
  // 전체 세션을 한눈에 보는 조판은 **하나뿐**이다: 사용자가 승인한 관제탑
  // (카드 = 파이프라인, 카드 안 세로 레일 = 단계, 마디 = 상태, 모노 라벨 = 담당 모델,
  // 칩 = 그 단계에 붙은 서브에이전트, 코스트 줄 = 그 단계에 쓴 시간).
  // 같은 정보를 두 번째 조판(전체 조직도 캔버스)으로도 그리던 것은 걷어냈다 — 세션 하나를
  // 파고드는 트리 캔버스는 세션 탭 안에 그대로 있고, 거기서만 확대·이동이 필요하다.
  //
  // **데이터는 그대로 하네스 피드다.** 단계 상태·소요시간·액터를 여기서 다시 계산하지 않고
  // phaseStates()·phaseTimeline()·actorNodes()가 낸 값을 조판 어휘로 옮기기만 한다.
  // 그래서 "보고된 적 없는 단계를 완료로 날조하지 않는다"는 계약이 이 조판에서도 그대로다:
  // skipped는 '기록 없음'으로, 색이 아니라 **점선 마디 + 글자 라벨**로 구분된다.

  const BOARD_STATE_LABELS = { ok: '완료', run: '진행 중', wait: '대기', skip: '기록 없음' };
  // 단계 상태(phaseStates) → 레일 마디 상태. 여기 없는 값은 대기로 떨어져 마디가 사라지지 않는다.
  const PHASE_RAIL_STATE = { done: 'ok', current: 'run', pending: 'wait', skipped: 'skip' };

  // 액터 노드 숲을 평평하게 편다 — 손자 액터까지 칩 하나씩 받는다. 트리에서 접혀 있던
  // 서브에이전트가 보드에서 사라지면 "누가 붙어 있는지"를 화면이 거짓말하게 된다.
  // 액터 노드 숲을 평평하게 편다 — 손자 액터까지 칩 하나씩 받는다. 다만 **계층은 버리지
  // 않는다**: 깊이를 함께 실어 칩이 들여쓰기로 부모-자식을 말한다 (요구 1·plan §3.3).
  function flattenAgentNodes(nodes, depth = 0) {
    return (nodes || []).flatMap((node) => [
      { node, depth },
      ...flattenAgentNodes(node.children, depth + 1),
    ]);
  }

  // 하네스 세션 하나 → 관제탑 카드 하나.
  function pipelineFromTask(task, now) {
    const timeline = phaseTimeline(task, now);
    const states = phaseStates(task, timeline);
    const { main, byPhase } = actorNodes(task, now);
    const presentation = taskPresentation(task);
    const complete = task.status === 'complete';
    const progress = finiteNumber(task.progress);
    const deltas = sessionUsageDeltas(task);
    const updated = relativeTime(task.updated_at, now);
    return {
      id: task.id || presentation.name,
      name: presentation.name,
      task: [taskCategory(task).label, presentation.dateLabel].filter(Boolean).join(' · '),
      state: complete ? 'ok' : 'run',
      // 총괄은 카드 머리의 한 줄이다. 액터를 하나도 보고하지 않은 세션은 자리를 비우지 않고
      // "보고 없음"이라고 말한다 — 줄을 지우면 원인이 보이지 않는다.
      orch: main
        ? {
          // 이름과 모델을 **둘 다** 낸다. 모델만 내면 같은 모델을 쓰는 총괄이 서로
          // 구분되지 않고, 보고된 액터가 화면에서 사라진 것처럼 보인다.
          label: main.name || '이름 미기록',
          model: modelAndReasoning(main.model, main.reasoning),
          actorId: main.id || '',
        }
        : null,
      meta: [
        // 이 시각은 **하네스가 마지막으로 보고한 때**이지 화면이 서버를 마지막으로 읽은
        // 때가 아니다. 예전 문구('N분 전 동기화')는 머리말의 '마지막 갱신 3초 전 ·
        // 60초 주기'와 나란히 놓여 두 시계가 어긋난 것처럼 보였다 (사용자 지시 ④).
        // 화면 갱신 시계는 머리말이, 보고 시계는 카드가 맡는다고 말이 갈라 준다.
        updated ? `마지막 보고 ${updated}` : '보고 시각 없음',
        progress === null ? '' : `진행 ${Math.round(clampPercent(progress))}%`,
        task.deadline ? `마감 ${task.deadline}` : '',
        deltas.length ? `한도 소모 ${deltas.join(' · ')}` : '',
      ].filter(Boolean),
      stages: PHASES.map((phase) => {
        const stat = timeline.stats.get(phase.key);
        const state = states.get(phase.key);
        const isCurrent = state === 'current';
        return {
          key: phase.key,
          // 마크업에는 조판 어휘(st)와 **판독 어휘(state)** 를 둘 다 싣는다. 상태 판정의
          // 단일 원본은 phaseStates()이고, 게이트는 그 원본 어휘(done/current/pending/
          // skipped)로 검사해야 조판을 바꿔도 "날조 금지" 계약이 계속 검사된다.
          state,
          n: phase.label,
          st: PHASE_RAIL_STATE[state] || 'wait',
          // 모노 라벨은 그 단계를 실제로 보고한 모델이다. 진행 중인 단계에 한해 payload의
          // 현재 모델로 메운다 — 지나간 단계를 현재 모델 이름으로 덮지 않는다.
          who: modelAndReasoning(
            stat?.model || (isCurrent ? task.model : ''),
            stat?.reasoning || (isCurrent ? task.reasoning : ''),
          ),
          note: phase.detail,
          // '기록 없음' 마디에는 사유를 함께 싣는다 (사용자 지시 ①). 상세 조직도의
          // 같은 노드와 **한 상수**를 공유하므로 두 화면이 다른 말을 하지 않는다.
          reason: state === 'skipped' ? PHASE_SKIPPED_REASON : '',
          cost: stat && stat.duration > 0 ? formatDuration(stat.duration) : '',
          // 칩은 조직도가 노드 카드로 내던 사실을 **그대로** 싣는다 (계약 §B):
          // 이름 · 역할 · 모델+추론강도 · 상태 · 진행률 · 소요시간. 각자 자기 슬롯을
          // 가지므로 `이름:역할`처럼 한 문자열로 이어 붙지 않고, 값이 없는 항목은 슬롯
          // 자체가 생기지 않는다(빈 값을 '없음'으로 채우면 미보고와 구별되지 않는다).
          // 모델을 칩에도 싣는 이유: 단계의 모노 라벨(who)은 **그 단계를 보고한 모델**이지
          // 이 서브에이전트의 모델이 아니다 — 둘이 다를 때 예전 칩은 아무 말도 못 했다.
          // assignment(지금 무슨 일을 하는가)은 칩을 3줄로 만들지 않도록 title에 담는다.
          chips: flattenAgentNodes(byPhase.get(phase.key)).map(({ node, depth }) => ({
            name: node.name,
            role: node.role || '',
            model: node.model || '',
            duration: node.duration || '',
            assignment: node.assignment || '',
            // 부모와 단계가 달라 중첩되지 못한 액터는 부모를 이름으로 밝힌다 —
            // 들여쓰기로 말하던 계층을 글자로 대신한다 (major 2).
            parent: node.parent || '',
            status: node.status || '',
            depth,
            actorId: node.attributes?.['data-actor-id'] || '',
            // 측정된 진행도만 싣는다. 보고가 없으면 칩에 수치가 아예 붙지 않는다 —
            // 없는 값을 0%로 그리면 "아직 시작 못 했다"는 거짓말이 된다.
            percent: Number.isFinite(node.progress) ? clampPercent(node.progress) : null,
          })),
        };
      }),
    };
  }

  // 칩 하나 = 그 단계에 붙은 액터 하나. 여섯 사실이 각자 자기 슬롯을 갖고,
  // parent_id 계층은 depth 들여쓰기로 남는다 (깊이는 3단에서 시각적으로 멈춘다).
  // 종료된 액터도 자기 단계의 칩으로 남는다 — 사라지면 "그 단계에 아무도 없었다"가 된다.
  function renderBoardChip(chip) {
    const depth = Math.min(3, Math.max(0, Number(chip.depth) || 0));
    const percent = finiteNumber(chip.percent);
    // 담당(assignment)은 줄을 더 만들지 않고 툴팁으로만 붙는다. 역할과 담당은 다른
    // 사실이므로 합치지 않되, 칩 한 줄의 밀도(DESIGN.md §6)를 지키기 위한 분리다.
    const title = chip.assignment
      ? ` title="${escapeHtml(`${NODE_FACT_LABELS.assignment} · ${chip.assignment}`)}"`
      : '';
    return `<span class="pl-chip" data-actor-id="${escapeHtml(chip.actorId || '')}" data-depth="${depth}"${title}>`
      + `<b class="pl-chip-name">${escapeHtml(chip.name || '이름 미기록')}</b>`
      + `${chip.role ? `<span class="pl-chip-role">${escapeHtml(chip.role)}</span>` : ''}`
      + `${chip.parent ? `<span class="pl-chip-role">${escapeHtml(`${NODE_FACT_LABELS.parent} ${chip.parent}`)}</span>` : ''}`
      + `${chip.model ? `<span class="pl-chip-model">${escapeHtml(chip.model)}</span>` : ''}`
      + `${chip.status ? `<span class="pl-chip-state">${escapeHtml(chip.status)}</span>` : ''}`
      + `${chip.duration ? `<span class="pl-chip-time">${escapeHtml(chip.duration)}</span>` : ''}`
      + `${percent === null ? '' : `<strong class="pl-chip-percent">${Math.round(clampPercent(percent))}%</strong>`}`
      + '</span>';
  }

  function renderBoardStage(stage) {
    const state = BOARD_STATE_LABELS[stage.st] ? stage.st : 'wait';
    const chips = Array.isArray(stage.chips) ? stage.chips : [];
    return `
      <div class="pl-stage is-${escapeHtml(state)}" data-org-phase="${escapeHtml(stage.key || '')}" data-phase-state="${escapeHtml(stage.state || 'pending')}">
        <div class="pl-stage-main">
          <div class="pl-stage-name">${escapeHtml(stage.n)}${stage.who ? `<span class="pl-who">${escapeHtml(stage.who)}</span>` : ''}</div>
          ${stage.note ? `<div class="pl-note">${escapeHtml(stage.note)}</div>` : ''}
          ${stage.reason ? `<div class="pl-note pl-reason">${escapeHtml(stage.reason)}</div>` : ''}
          ${stage.cost ? `<div class="pl-cost">${escapeHtml(stage.cost)}</div>` : ''}
          ${chips.length > 0 ? `<div class="pl-chips">${chips.map(renderBoardChip).join('')}</div>` : ''}
        </div>
        <span class="pl-state is-${escapeHtml(state)}">${escapeHtml(BOARD_STATE_LABELS[state])}</span>
      </div>`;
  }

  function renderBoardCard(pipeline) {
    const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
    const done = stages.filter((stage) => stage.st === 'ok').length;
    const state = BOARD_STATE_LABELS[pipeline.state] ? pipeline.state : 'wait';
    const meta = Array.isArray(pipeline.meta) ? pipeline.meta : [];
    const orchId = pipeline.orch?.actorId ? ` data-actor-id="${escapeHtml(pipeline.orch.actorId)}"` : '';
    return `
      <article class="pl-card" data-portfolio-task="${escapeHtml(pipeline.id || '')}" data-session-active="${String(state !== 'ok')}">
        <div class="pl-card-head">
          <div>
            <h3 class="pl-card-title">${escapeHtml(pipeline.name || '이름 없는 작업')}</h3>
            ${pipeline.task ? `<p class="pl-task">${escapeHtml(pipeline.task)}</p>` : ''}
          </div>
          <span class="pl-badge is-${escapeHtml(state)}">${escapeHtml(BOARD_STATE_LABELS[state])} ${done}/${stages.length}</span>
        </div>
        <div class="pl-orch"${orchId}>오케스트레이터 <b>${escapeHtml(pipeline.orch ? pipeline.orch.label : '에이전트 보고 없음')}</b>${pipeline.orch?.model ? `<span class="pl-who">${escapeHtml(pipeline.orch.model)}</span>` : ''}</div>
        ${stages.map(renderBoardStage).join('')}
        ${meta.length > 0 ? `<div class="pl-meta">${meta.map((line) => escapeHtml(line)).join('<br>')}</div>` : ''}
      </article>`;
  }

  // 보드 전체. 입력은 이미 정규화된 파이프라인 배열이라, 하네스 피드에서 왔든 정적 사본에서
  // 왔든 같은 조판이 나온다.
  function renderBoard(pipelines, meta = {}) {
    const cards = Array.isArray(pipelines) ? pipelines : [];
    if (cards.length === 0) {
      // 보드 안에서 범위를 넓힐 수단이 없어졌으므로(완료는 완료 탭이 맡는다), 빈 상태는
      // 한 줄이면 충분하다. 예전의 '전체를 누르면…' 안내는 가리킬 버튼이 없는 거짓말이 된다.
      return `<p class="pl-empty">${escapeHtml(meta.empty || '아직 동기화된 파이프라인이 없습니다.')}</p>`;
    }
    const sub = [meta.summary, meta.source].filter(Boolean).join(' · ');
    return `
      <div class="pl-board">
        <div class="pl-head">
          <h2 class="pl-title">파이프라인 관제탑</h2>
          ${meta.window ? `<span class="pl-window">${escapeHtml(meta.window)}</span>` : ''}
        </div>
        ${sub ? `<p class="pl-sub">${escapeHtml(sub)}</p>` : ''}
        <div class="pl-legend">
          <span><span class="pl-dot is-ok" aria-hidden="true"></span>완료</span>
          <span><span class="pl-dot is-run" aria-hidden="true"></span>진행 중</span>
          <span><span class="pl-dot" aria-hidden="true"></span>대기</span>
          <span><span class="pl-dot is-skip" aria-hidden="true"></span>기록 없음 (보고된 적 없는 단계)</span>
          <span>칩 = 단계에 붙은 서브에이전트 (이름 · 역할 · 모델 · 상태 · 진행률 · 소요)</span>
        </div>
        <div class="pl-grid">${cards.map(renderBoardCard).join('')}</div>
      </div>`;
  }

  // ---- 정적 폴백 -----------------------------------------------------------
  //
  // 하네스 피드(GET /api/usage)가 아직 배포되지 않았거나(404/403) 네트워크가 막혀 첫 화면을
  // 세우지 못하면, 저장소에 함께 배포되는 사본(usage/pipeline-state.json)으로 관제탑만이라도
  // 세운다. 빈 화면에 오류 한 줄만 남기는 것보다 "언제 찍힌 사본인지 밝힌 보드"가 낫다.
  //
  // 규칙 둘을 지킨다:
  //   1. **살아 있는 응답이 언제나 이긴다.** 이 경로는 화면이 비어 있을 때만 탄다 — 이미
  //      그려진 실시간 화면을 폴링 한 번 실패로 얼어붙은 사본이 덮지 않는다.
  //   2. **사본임을 화면이 말한다.** 출처 줄과 오류 줄에 사본이라고 적는다. 실시간처럼
  //      보이게 두면 이 화면이 하는 유일한 약속(지금 무엇이 도는가)이 거짓이 된다.
  const STATIC_STATE_PATH = '/usage/pipeline-state.json';

  async function staticBoardState() {
    try {
      // 배포면의 평범한 정적 파일이라 인증 헤더가 의미 없다. 캐시는 끈다 — 사본이 갱신돼도
      // 브라우저가 옛 사본을 물고 있으면 폴백이 두 번 낡는다.
      const response = await fetch(STATIC_STATE_PATH, { cache: 'no-store' });
      if (!response.ok) return null;
      const data = await response.json().catch(() => null);
      return Array.isArray(data?.pipelines) && data.pipelines.length > 0 ? data : null;
    } catch {
      return null;
    }
  }

  // 사본의 단계 상태(ok/run/wait)를 판독 어휘로 되돌린다. 사본에는 단계별 이벤트가 없어
  // '기록 없음'(skipped)을 판정할 근거가 없다 — 그래서 만들어내지 않고 대기로 떨어뜨린다.
  const STATIC_PHASE_STATE = { ok: 'done', run: 'current', wait: 'pending' };

  function pipelineFromStatic(entry) {
    const stages = Array.isArray(entry?.stages) ? entry.stages : [];
    const state = ['ok', 'run', 'wait'].includes(entry?.state) ? entry.state : 'run';
    return {
      id: entry?.id || entry?.name || '',
      name: [entry?.id, entry?.name].filter(Boolean).join(' · ') || '이름 없는 작업',
      task: entry?.task || '',
      state,
      // 사본의 orch는 모델 이름 한 줄이다. 액터 id가 없으므로 붙이지 않는다.
      orch: entry?.orch ? { label: String(entry.orch), model: '', actorId: '' } : null,
      meta: (Array.isArray(entry?.meta) ? entry.meta : []).map((line) => String(line)),
      stages: stages.map((stage) => ({
        key: '',
        state: STATIC_PHASE_STATE[stage?.st] || 'pending',
        n: stage?.n || '단계',
        st: BOARD_STATE_LABELS[stage?.st] ? stage.st : 'wait',
        who: stage?.who || '',
        note: stage?.note || '',
        // 사본에는 skipped 판정 자체가 없으므로 사유도 없다 (지어내지 않는다).
        reason: '',
        // t(소요)·tok(토큰)·pct는 전부 선택 필드다. 있는 것만 잇고, pct 0은 값이다.
        cost: [
          stage?.t,
          stage?.tok,
          stage?.pct === null || stage?.pct === undefined ? null : `${stage.pct}%`,
        ].filter(Boolean).join(' · '),
        // 사본의 chips는 예전부터 **문자열 배열**이다. 그 형식을 계속 읽으면서, 새로
        // 구조화된 객체({name, role, model, status, percent, duration})도 함께 받는다 —
        // 사본을 손보지 않아도 화면이 깨지지 않는 것이 이 폴백의 존재 이유다.
        // 사본에 없는 필드는 빈 문자열이고, 빈 슬롯은 렌더러가 아예 만들지 않는다.
        chips: (Array.isArray(stage?.chips) ? stage.chips : []).map((chip) => (
          chip && typeof chip === 'object'
            ? {
              name: String(chip.name || chip.label || '이름 미기록'),
              role: chip.role ? String(chip.role) : '',
              model: chip.model ? String(chip.model) : '',
              duration: chip.duration ? String(chip.duration) : '',
              assignment: chip.assignment ? String(chip.assignment) : '',
              status: chip.status ? String(chip.status) : '',
              percent: finiteNumber(chip.percent),
              depth: Number(chip.depth) || 0,
              parent: chip.parent ? String(chip.parent) : '',
              actorId: '',
            }
            : {
              name: String(chip),
              role: '',
              model: '',
              duration: '',
              assignment: '',
              status: '',
              percent: null,
              depth: 0,
              parent: '',
              actorId: '',
            })),
      })),
    };
  }

  function buildFallbackBoard(state, now) {
    const pipelines = (Array.isArray(state?.pipelines) ? state.pipelines : []).map(pipelineFromStatic);
    const updated = relativeTime(state?.updated, now) || state?.updated || '시각 없음';
    return renderBoard(pipelines, {
      window: state?.window || '',
      summary: `세션 ${pipelines.length}개 · 사본 갱신 ${updated}`,
      source: '정적 사본 — 실시간 피드에 닿지 못했습니다',
    });
  }

  // 관제탑은 **진행 중인 세션만** 그린다 (계약 §A). 예전에는 보드 안에 '진행 중 / 전체'
  // 범위 토글이 있었지만, 이제 완료는 완료 탭이 통째로 맡으므로 같은 선택지가 화면에
  // 두 곳(상위 탭 · 보드 토글)에 생기는 셈이었다. 축을 하나로 줄인다:
  // **무엇을 보는가 = 상위 탭 / 어떻게 보는가 = 모드 토글.**
  function renderPortfolioBoard(inputTasks, now) {
    const tasks = sortTasks(Array.isArray(inputTasks) ? [...inputTasks] : []);
    // 관제탑은 **살아 있는 세션의 현재면**이다. 하트비트가 끊긴 세션은 지금 무엇을 하고
    // 있지 않으므로 여기 서지 않고 '중단됨' 목록으로 간다.
    const shown = tasks.filter((task) => taskStatusKey(task) === 'active');
    const actorCount = shown.reduce((total, task) => total + taskActors(task).length, 0);
    return renderBoard(shown.map((task) => pipelineFromTask(task, now)), {
      empty: '진행 중인 파이프라인이 없습니다.',
      summary: `세션 ${shown.length}개 · 에이전트 ${actorCount}명`,
      source: '하네스 실시간 보고',
    });
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
  // 같은 패널을 두 어법으로 그리는 것이지 다른 패널로 가는 것이 아니므로, 탭이 아니라
  // 눌림 상태를 가진 버튼 묶음이다.
  function renderActiveModes(mode) {
    const current = ACTIVE_MODE_KEYS.has(mode) ? mode : 'board';
    return `
      <div class="segmented h-mode-toggle" role="group" aria-label="진행 중 세션을 보는 방식">
        ${ACTIVE_MODES.map((item) => `<button class="segmented-btn${item.key === current ? ' is-selected' : ''}" type="button"
          aria-pressed="${item.key === current}" data-active-mode="${item.key}">${item.label}</button>`).join('')}
      </div>`;
  }

  // view는 상위 탭('active' | 'complete')이고, mode는 진행 중 패널 안의 보기 방식이다.
  // mode를 인자로 받는 이유는 게이트가 두 모드를 **각각** 렌더해 검사할 수 있어야 하기
  // 때문이다 — 화면 상태(selectedActiveMode)에만 의존하면 검사가 기본값 하나만 본다.
  function renderSessionView(inputTasks, now, view, mode = selectedActiveMode) {
    const tasks = sortTasks(Array.isArray(inputTasks) ? [...inputTasks] : []);
    const status = SESSION_VIEW_KEYS.has(view) ? view : 'active';
    // 상태별 필터는 **정확히 그 상태**다. 예전의 `!== 'complete'`는 중단된 세션까지
    // 진행 중으로 끌어와 관제탑에 세웠다 (요구: 진행 중 표시는 실제 활성 세션만).
    const filtered = tasks.filter((task) => taskStatusKey(task) === status);
    if (status === 'active') {
      // 토글은 세션이 없어도 남는다 — 모드는 세션의 유무가 아니라 사람의 선택이고,
      // 빈 화면에서 토글이 사라지면 다음 세션이 뜰 때 모드가 어디로 갔는지 알 수 없다.
      const current = ACTIVE_MODE_KEYS.has(mode) ? mode : 'board';
      const body = current === 'org'
        ? (filtered.length === 0
          ? '<p class="us-empty card">현재 진행 중인 작업이 없습니다.</p>'
          : renderTaskTabs([{ label: '', ariaLabel: '진행 중인 Codex 세션', tasks: filtered }], now, status))
        : renderPortfolioBoard(tasks, now);
      return `${renderActiveModes(current)}${body}`;
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

  function renderSessionViews(inputTasks, now) {
    const tasks = sortTasks(Array.isArray(inputTasks) ? [...inputTasks] : []);
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
    for (const button of [...(root?.querySelectorAll?.('[data-active-mode]') || [])]) {
      if (typeof button.addEventListener !== 'function') continue;
      button.addEventListener('click', () => {
        writeActiveMode(button.dataset.activeMode);
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
    const tasks = sortTasks(Array.isArray(data?.tasks) ? data.tasks : []);
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
      // 화면이 아직 비어 있을 때만 사본으로 내려앉는다. 이미 실시간 화면이 있으면
      // 그것을 그대로 두는 편이 항상 더 정확하다.
      if (!elements.body.innerHTML) {
        const fallback = await staticBoardState();
        if (fallback) {
          elements.body.innerHTML = buildFallbackBoard(fallback, Date.now());
          wireDashboard(elements.body);
          elements.error.textContent = `${reason} 저장된 사본을 대신 보여줍니다.`;
          if (announce) {
            elements.reload.textContent = '새로고침';
            if (elements.refreshStatus) elements.refreshStatus.textContent = '저장된 사본을 보여주고 있습니다.';
          }
          return;
        }
      }
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
      renderFreshness();
      return;
    }
    void load();
  });
  load();

  window.USAGE_RENDER = {
    buildDashboard, renderSessionViews, renderSessionView, renderPortfolioBoard, renderTask,
    renderTaskBody, renderPostList, taskPresentation, taskStatusKey, taskInput,
    sessionOrgTree, renderOrgTree, pipelineFromTask, renderBoard, buildFallbackBoard,
    phaseTimeline, sessionUsageDeltas, actorNodes,
    activateTaskTab, wireTaskTabs, activateSessionView, wireSessionViews, wireDashboard,
    wireLocalControls, renderActiveModes, readActiveMode, writeActiveMode, load,
  };
})();
