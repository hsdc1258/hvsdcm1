import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const COMPETITION_SOURCE = fs.readFileSync('usage/assets/js/competition.js', 'utf8');
const USAGE_SOURCE = fs.readFileSync('usage/assets/js/usage.js', 'utf8');
const HTML = fs.readFileSync('usage/index.html', 'utf8');
const NOW = Date.parse('2026-08-31T03:00:00+09:00');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function element(id = '') {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: id === 'competitionSort' ? 'deadline-asc' : (id.startsWith('competition') && id !== 'competitionSearch' ? 'all' : ''),
    hidden: false,
    disabled: false,
    tabIndex: -1,
    dataset: {},
    attributes: {},
    listeners: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    removeEventListener(type) { delete this.listeners[type]; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    focus() { this.focused = true; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function competitionContext() {
  const store = new Map();
  const document = {
    getElementById(id) {
      if (!store.has(id)) store.set(id, element(id));
      return store.get(id);
    },
  };
  const context = {
    document,
    location: { href: 'https://hvsdcm1.xyz/usage/' },
    setTimeout() { return 1; },
    clearTimeout() {},
    URL,
    Intl,
    console: { log() {}, warn() {}, error() {} },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(COMPETITION_SOURCE, context, { filename: 'competition.js' });
  return { context, store, ui: context.COMPETITION_UI };
}

function fixture(overrides = {}) {
  return {
    summary: {
      latest_scan_at: '2026-08-30T17:30:00Z',
      today: { discovered: 3, eligible: 1, applied: 0 },
    },
    runs: [{ finished_at: '2026-08-30T17:30:00Z', outcome: 'success', found: 3, eligible: 1 }],
    sources: [
      { name: '공식 공고', status: 'success', checked_at: '2026-08-30T17:30:00Z', found: 2 },
      { name: '발견 피드', status: 'partial', checked_at: '2026-08-30T17:20:00Z', error: '두 번째 페이지 실패' },
    ],
    candidates: [{
      id: 'contest-1',
      title: '청소년 디자인 공모전',
      organizer: { name: '예시 재단', official_url: 'https://organizer.example/rules' },
      discovery: { name: '발견 피드', url: 'https://discovery.example/item' },
      deadline: '2026-09-05T14:59:00Z',
      status: 'ready',
      eligibility: { status: 'eligible', summary: '만 18세 이하 개인' },
      risk: { rights: '수상작 이용 범위 확인', submission: 'PDF 10MB 제한' },
    }],
    applications: [{
      competition_id: 'contest-1', state: 'watching', blockers: ['보호자 동의 확인'], next_action: '공식 요강 재확인',
    }],
    ...overrides,
  };
}

test('the adapter accepts wrapped object maps and canonicalizes variants', () => {
  const { ui } = competitionContext();
  const normalized = ui.normalizePayload({
    result: {
      latest_scan: { completed_at: '2026-08-30T17:30:00Z' },
      coverage: { official: { name: '공식', outcome: 'ok', count: '4' } },
      contests: {
        c1: {
          name: '지도 공모전', organizer_name: '지도원', rules_url: 'https://example.com/rules',
          closes_at: '2026-09-20', eligibility_status: true, eligibility_summary: '개인',
        },
      },
      application_states: { c1: { stage: 'submitted', next: '결과 발표 대기' } },
    },
  });
  assert.equal(normalized.sources[0].status, 'success');
  assert.equal(normalized.sources[0].found, 4);
  assert.equal(normalized.candidates[0].id, 'c1');
  assert.equal(normalized.candidates[0].eligibilityStatus, 'eligible');
  assert.equal(normalized.candidates[0].eligibility, '개인');
  assert.equal(normalized.candidates[0].status, 'applied');
  assert.equal(normalized.candidates[0].application.nextAction, '결과 발표 대기');
});

test('top-level canonical fields render human labels, safe source action, and bounded scores', () => {
  const { ui } = competitionContext();
  const normalized = ui.normalizePayload({
    summary: { latest_scan_at: '2026-08-30T17:30:00Z' },
    runs: [],
    sources: [{
      id: 'source-a', name: '전국 공식 공고 목록', kind: 'listing',
      reference_url: 'https://official.example/source', status: 'failed',
      failure_code: 'timeout', manual_check: true, candidate_count: 1,
    }],
    candidates: [{
      contest_id: 'joined', category: 'design', title: '연결 확인 공모전', organizer: '연결 재단',
      source_id: 'source-a', discovery_url: 'https://discover.example/contest',
      official_url: 'https://organizer.example/rules', official_verification: 'unverified',
      official_verified_at: '2026-08-30T14:00:00Z',
      eligibility: 'eligible', deadline_at: '2026-09-05', status: 'active', recency: 'new',
      fit_score: 87, effort_score: 4,
    }],
    applications: [],
  });
  assert.equal(normalized.sources[0].kind, '공고 목록');
  assert.equal(normalized.sources[0].referenceUrl, 'https://official.example/source');
  assert.equal(normalized.candidates[0].discoveryName, '전국 공식 공고 목록');
  assert.equal(normalized.candidates[0].eligibility, '');
  assert.equal(normalized.candidates[0].recency, '신규');
  assert.equal(normalized.candidates[0].fitScore, 87);
  assert.equal(normalized.candidates[0].effortScore, 4);
  assert.equal(normalized.candidates[0].officialVerification, 'unverified');
  assert.equal(normalized.candidates[0].officialVerifiedAt, '2026-08-30T14:00:00Z');
  const markup = ui.renderDashboard(normalized, {}, NOW);
  const card = markup.split('<article class="cp-candidate">')[1] || '';
  assert.match(card, /발견 경로 · 전국 공식 공고 목록/u);
  assert.match(card, /최신성<\/dt><dd>신규/u);
  assert.match(card, /적합도 점수<\/dt><dd>87/u);
  assert.match(card, /작업량 점수<\/dt><dd>4/u);
  assert.match(card, />공고 링크<\/a>/u);
  assert.doesNotMatch(card, />주최기관 공식 공고<\/a>/u);
  assert.match(card, /공식 공고 검증<\/dt><dd><span[^>]*>미검증<\/span> · 확인 기록/u);
  assert.doesNotMatch(card, /unverified/u);
  assert.doesNotMatch(markup, />listing</u);
  assert.doesNotMatch(markup, />new</u);
  assert.match(markup, /공고 목록/u);
  assert.match(markup, /class="cp-source-link" href="https:\/\/official\.example\/source"/u);
  assert.match(markup, /실패 코드<\/b> 시간 초과/u);
  assert.match(markup, /수동 확인<\/b> 필요/u);
  assert.equal((card.match(/지원 가능/gu) || []).length, 1);
});

test('unsafe source URLs stay unlinked and missing or invalid scores stay unknown', () => {
  const { ui } = competitionContext();
  const normalized = ui.normalizePayload({
    sources: [{
      id: 'source-b', name: '검색 출처', kind: 'search',
      reference_url: 'http://unsafe.example/source', status: 'ok',
    }],
    candidates: [{
      contest_id: 'unsafe', category: 'design', title: '안전 확인 공모전', source_id: 'source-b',
      recency: 'stale', fit_score: -1, effort_score: 101,
    }],
  });
  assert.equal(normalized.sources[0].kind, '검색 결과');
  assert.equal(normalized.sources[0].referenceUrl, '');
  assert.equal(normalized.candidates[0].recency, '오래됨');
  assert.equal(normalized.candidates[0].fitScore, null);
  assert.equal(normalized.candidates[0].effortScore, null);
  const markup = ui.renderDashboard(normalized, {}, NOW);
  assert.doesNotMatch(markup, /http:\/\/unsafe\.example/u);
  assert.doesNotMatch(markup, /href="[^"]*unsafe/u);
  assert.doesNotMatch(markup, />search</u);
  assert.doesNotMatch(markup, />stale</u);
  assert.match(markup, /검색 결과/u);
  assert.match(markup, /최신성<\/dt><dd>오래됨/u);
  assert.match(markup, /적합도 점수<\/dt><dd>미확인/u);
  assert.match(markup, /작업량 점수<\/dt><dd>미확인/u);
});

test('every exact official verification state is labeled and only verified links are affirmative', () => {
  const { ui } = competitionContext();
  const exactStates = ['verified', 'unverified', 'not_found', 'failed'];
  const titles = ['검증 후보', '미검증 후보', '미발견 후보', '실패 후보'];
  const normalized = ui.normalizePayload({
    candidates: exactStates.map((officialVerification, index) => ({
      contest_id: `official-${index}`,
      title: titles[index],
      official_url: `https://organizer.example/rules/${index}`,
      official_verification: officialVerification,
    })),
  });
  assert.deepEqual(
    Array.from(normalized.candidates, (candidate) => candidate.officialVerification),
    ['verified', 'unverified', 'not-found', 'failed'],
  );
  const markup = ui.renderDashboard(normalized, {}, NOW);
  for (const label of ['검증됨', '미검증', '공식 공고 미발견', '검증 실패']) {
    assert.match(markup, new RegExp(label, 'u'));
  }
  assert.equal((markup.match(/>주최기관 공식 공고<\/a>/gu) || []).length, 1);
  assert.equal((markup.match(/>공고 링크<\/a>/gu) || []).length, 3);
  const unverifiedCard = markup.split('<article class="cp-candidate">')
    .find((candidate) => candidate.includes('미검증 후보')) || '';
  assert.match(unverifiedCard, />공고 링크<\/a>/u);
  assert.doesNotMatch(unverifiedCard, />주최기관 공식 공고<\/a>/u);
  for (const raw of exactStates) {
    assert.doesNotMatch(markup, new RegExp(`>${raw}<`, 'u'));
  }
});

test('the adapter selects the newest report wrapper and correlates contest plus category', () => {
  const { ui } = competitionContext();
  const normalized = ui.normalizePayload({
    version: 1,
    runs: [
      {
        received_at: '2026-08-29T09:00:00Z',
        run: { id: 'old', finished_at: '2026-08-29T09:00:00Z', status: 'complete' },
        sources: [], candidates: [{ contest_id: 'old', title: '옛 후보' }], applications: [],
      },
      {
        received_at: '2026-08-30T17:30:00Z',
        run: {
          id: 'new', finished_at: '2026-08-30T17:30:00Z', status: 'complete',
          source_coverage: { expected: 3, checked: 3, succeeded: 2 },
        },
        sources: [
          { id: 'official', status: 'no_results', candidate_count: 0 },
          { id: 'feed', status: 'failed', failure_code: 'HTTP_403', manual_check: true },
          { id: 'queue', status: 'pending' },
        ],
        candidates: [
          {
            contest_id: 'same', category: 'ui', title: 'UI 공모전', organizer: 'UI 재단',
            source_id: 'official', discovery_url: 'https://discover.example/ui',
            official_url: 'https://organizer.example/ui', deadline_at: '2026-09-04',
            eligibility: 'eligible', status: 'active', rights_risk: '비독점 이용', submission_risk: 'PDF만 허용',
          },
          {
            contest_id: 'same', category: 'essay', title: '에세이 공모전', organizer: '글 재단',
            deadline_at: '2026-09-10', eligibility: 'ineligible', status: 'deferred',
          },
        ],
        applications: [
          { contest_id: 'same', category: 'ui', state: 'WAITING_APPROVAL', blocker: '보호자 확인', next_action: '승인 요청' },
          { contest_id: 'same', category: 'essay', state: 'AUTHORIZED', blockers: [], next_action: '원고 최종화' },
        ],
      },
    ],
  });
  assert.equal(normalized.candidates.length, 2);
  assert.equal(normalized.candidates[0].status, 'awaiting-approval');
  assert.deepEqual(Array.from(normalized.candidates[0].application.blockers), ['보호자 확인']);
  assert.equal(normalized.candidates[1].status, 'approved');
  assert.equal(normalized.candidates[0].deadline, '2026-09-04');
  assert.equal(normalized.candidates[0].eligibilityStatus, 'eligible');
  assert.equal(normalized.candidates[1].eligibilityStatus, 'ineligible');
  assert.deepEqual(Array.from(normalized.sources, (source) => source.status), ['success', 'failed', 'partial']);
  assert.equal(normalized.sources[0].found, 0);
  assert.equal(normalized.sources[1].failureCode, '접근 거부');
  assert.equal(normalized.sources[1].manualCheck, '필요');
  assert.equal(normalized.runs[0].id, 'new');
  assert.equal(normalized.candidates.some((candidate) => candidate.title === '옛 후보'), false);
  const markup = ui.renderDashboard(normalized, {}, NOW);
  assert.match(markup, /실패 코드<\/b> 접근 거부/u);
  assert.doesNotMatch(markup, /HTTP_403/u);
  assert.match(markup, /수동 확인<\/b> 필요/u);
  assert.match(markup, /권리 위험<\/dt><dd>비독점 이용/u);
  assert.match(markup, /제출 위험<\/dt><dd>PDF만 허용/u);
});

test('every exact backend application state maps without a broad waiting wildcard', () => {
  const { ui } = competitionContext();
  const states = [
    ['DISCOVERED', 'watching'],
    ['SOURCE_VERIFIED', 'verifying'],
    ['ELIGIBLE', 'preparing'],
    ['PREPARED', 'preparing'],
    ['VALIDATED', 'preparing'],
    ['WAITING_DEADLINE_CLARIFICATION', 'blocked'],
    ['WAITING_IDENTITY', 'blocked'],
    ['WAITING_ELIGIBILITY', 'blocked'],
    ['WAITING_CLARIFICATION', 'blocked'],
    ['WAITING_ARTIFACTS', 'preparing'],
    ['WAITING_LEGAL_CONSENT', 'blocked'],
    ['WAITING_RIGHTS_APPROVAL', 'blocked'],
    ['WAITING_FEE_APPROVAL', 'blocked'],
    ['WAITING_APPROVAL', 'awaiting-approval'],
    ['AUTHORIZED', 'approved'],
    ['SUBMITTING', 'preparing'],
    ['SUBMISSION_UNKNOWN', 'blocked'],
  ];
  const normalized = ui.normalizePayload({
    candidates: states.map(([state], index) => ({ id: `c${index}`, title: state })),
    applications: states.map(([state], index) => ({ competition_id: `c${index}`, state })),
  });
  assert.deepEqual(Array.from(normalized.applications, (application) => application.status), states.map(([, expected]) => expected));
  const markup = ui.renderDashboard(normalized, {}, NOW);
  assert.match(markup, /지원 상태 보드/u);
  assert.match(markup, /읽기 전용 · 17건/u);
  assert.match(markup, /승인 대기/u);
  assert.match(markup, /막힘/u);
  const unknownWaiting = ui.normalizePayload({
    candidates: [{ id: 'future', title: '새 대기 상태' }],
    applications: [{ competition_id: 'future', state: 'WAITING_SOMETHING_NEW' }],
  });
  assert.equal(unknownWaiting.applications[0].status, 'unknown');
});

test('risk, blocker, next-action, and source failure enums render only Korean labels', () => {
  const { ui } = competitionContext();
  const risks = ['unknown', 'low', 'medium', 'high', 'blocked'];
  const blockers = [
    'none', 'official_verification', 'eligibility', 'deadline', 'rights', 'submission', 'artifacts',
    'account', 'consent', 'payment', 'user_approval', 'other', 'NEW_BLOCKER_CODE',
  ];
  const nextActions = [
    'none', 'verify_official_source', 'verify_eligibility', 'review_rights', 'review_submission',
    'prepare_artifacts', 'draft_application', 'stage_form', 'request_approval', 'manual_check',
    'hold', 'NEW_NEXT_CODE',
  ];
  const failureCodes = [
    'none', 'timeout', 'http_403', 'http_404', 'rate_limited', 'network',
    'invalid_response', 'parse_error', 'unknown', 'NEW_FAILURE_CODE',
  ];
  const candidates = blockers.map((blocker, index) => ({
    contest_id: `enum-${index}`,
    category: 'enum',
    title: `열거형 후보 ${index + 1}`,
    rights_risk: risks[index % risks.length],
    submission_risk: risks[(index + 1) % risks.length],
  }));
  const applications = blockers.map((blocker, index) => ({
    contest_id: `enum-${index}`,
    category: 'enum',
    state: 'PREPARED',
    blocker,
    next_action: nextActions[index % nextActions.length],
  }));
  const normalized = ui.normalizePayload({
    sources: failureCodes.map((failureCode, index) => ({
      id: `source-${index}`, status: 'failed', failure_code: failureCode,
    })),
    candidates,
    applications,
  });
  assert.deepEqual(Array.from(normalized.sources, (source) => source.failureCode), [
    '', '시간 초과', '접근 거부', '찾을 수 없음', '요청 제한', '네트워크 오류',
    '잘못된 응답', '응답 해석 실패', '미확인', '미확인',
  ]);
  assert.deepEqual(Array.from(normalized.applications[0].blockers), []);
  assert.deepEqual(Array.from(normalized.applications.at(-1).blockers), ['미확인']);
  assert.equal(normalized.applications[11].nextAction, '미확인');
  const markup = ui.renderDashboard(normalized, {}, NOW);
  assert.match(markup, /기록된 차단 요인 없음/u);
  assert.match(markup, /제출물 준비 필요/u);
  assert.match(markup, /공식 공고 확인/u);
  assert.match(markup, /요청 제한/u);
  assert.match(markup, /권리 위험<\/dt><dd>낮음/u);
  assert.match(markup, /미확인/u, 'unrecognized enum-like values must fail unknown');
  for (const raw of [...risks, ...blockers, ...nextActions, ...failureCodes]) {
    assert.equal(markup.includes(raw), false, `raw enum code ${raw} must not reach the UI`);
  }
});

test('the horizontally scrollable application board is a named keyboard focus target', () => {
  const { ui } = competitionContext();
  const markup = ui.renderDashboard(ui.normalizePayload(fixture()), {}, NOW);
  assert.match(markup, /class="cp-board" role="region" aria-label="지원 상태 보드 가로 목록" tabindex="0"/u);
  const css = fs.readFileSync('usage/assets/css/usage.css', 'utf8');
  assert.match(css, /\.cp-board:focus-visible \{[^}]*outline: 2px solid var\(--accent\)/u);
});

test('the delegated board keyboard handler moves deterministically within overflow bounds', () => {
  const shell = competitionContext();
  shell.ui.createDashboard({ request: async () => ({}) });
  const board = { clientWidth: 309, scrollWidth: 452, scrollLeft: 0 };
  const keydown = shell.store.get('competitionBody').listeners.keydown;
  const press = (key, target = board) => {
    const event = {
      key,
      target: { closest(selector) { return selector === '.cp-board' ? target : null; } },
      prevented: false,
      preventDefault() { this.prevented = true; },
    };
    keydown(event);
    return event;
  };

  assert.equal(press('ArrowRight').prevented, true);
  assert.equal(board.scrollLeft, 143, 'right clamps to scrollWidth - clientWidth');
  assert.equal(press('ArrowLeft').prevented, true);
  assert.equal(board.scrollLeft, 0);
  assert.equal(press('End').prevented, true);
  assert.equal(board.scrollLeft, 143);
  assert.equal(press('Home').prevented, true);
  assert.equal(board.scrollLeft, 0);

  const noOverflow = { clientWidth: 309, scrollWidth: 309, scrollLeft: 0 };
  assert.equal(press('ArrowRight', noOverflow).prevented, false);
  assert.equal(noOverflow.scrollLeft, 0);
  assert.equal(press('Enter').prevented, false);
});

test('usage mobile touch targets keep 44px height without changing desktop density', () => {
  const css = fs.readFileSync('usage/assets/css/usage.css', 'utf8');
  const mobileStart = css.indexOf('@media (max-width: 480px)');
  assert.ok(mobileStart >= 0, 'the competition mobile breakpoint must exist');
  const mobile = css.slice(mobileStart);
  assert.match(
    mobile,
    /\.sidebar-item, #competitionReload, \.cp-filters \.field-input-sm \{\s*min-height: 44px;/u,
  );
  const desktop = css.slice(0, mobileStart);
  assert.doesNotMatch(desktop, /#competitionReload[^}]*min-height: 44px/u);
});

test('missing application safety fields stay unknown instead of implying no blockers', () => {
  const { ui } = competitionContext();
  const normalized = ui.normalizePayload({
    candidates: [{ contest_id: 'safe', category: 'design', title: '안전 확인', deadline_at: '2026-09-03' }],
  });
  const markup = ui.renderDashboard(normalized, {}, NOW);
  assert.match(markup, /차단 요인 미확인/u);
  assert.match(markup, /권리 조건 미확인/u);
  assert.match(markup, /제출 조건 미확인/u);
  assert.match(markup, /다음 행동 미확인/u);
  assert.doesNotMatch(markup, /기록된 차단 요인 없음/u);
});

test('rendering exposes stale, partial, coverage and view-only risk context safely', () => {
  const { ui } = competitionContext();
  const payload = fixture({
    summary: { latest_scan_at: '2026-08-29T10:00:00Z', today: { discovered: 3, eligible: 1 } },
    errors: ['원본 하나가 응답하지 않음'],
  });
  payload.candidates[0].title = '<img src=x onerror=alert(1)>';
  payload.candidates[0].official_url = 'http://organizer.example/insecure';
  const markup = ui.renderDashboard(ui.normalizePayload(payload), {}, NOW);
  assert.match(markup, /30시간 초과 · 오래됨/u);
  assert.match(markup, /일부 결과만 표시합니다/u);
  assert.match(markup, /성공 1 · 실패 0 · 부분 1/u);
  for (const count of ['오늘 발견', '오늘 검증', '오늘 지원준비', '오늘 승인대기', '오늘 마감임박']) {
    assert.match(markup, new RegExp(count, 'u'));
  }
  assert.match(markup, /권리 위험/u);
  assert.match(markup, /제출 위험/u);
  assert.match(markup, /차단 요인/u);
  assert.match(markup, /다음 행동/u);
  assert.match(markup, /지원 상태 보드/u);
  assert.match(markup, /공고 링크/u);
  assert.match(markup, /발견 경로 · 발견 피드/u);
  assert.doesNotMatch(markup, /<img src=x/u);
  assert.doesNotMatch(markup, /http:\/\/organizer\.example/u);
  assert.match(markup, /rel="noopener"/u);
  assert.doesNotMatch(markup, /제출하기|지원하기|동의하기/u);
});

test('missing latest scan time is unknown rather than stale', () => {
  const { ui } = competitionContext();
  const markup = ui.renderDashboard(ui.normalizePayload({
    summary: { latest_scan_at: null }, runs: [], sources: [], candidates: [], applications: [],
  }), {}, NOW);
  assert.match(markup, /스캔 시각 미확인/u);
  assert.doesNotMatch(markup, /30시간 초과 · 오래됨/u);
});

test('candidate search, status, eligibility, deadline and deadline sorting are deterministic', () => {
  const { ui } = competitionContext();
  const normalized = ui.normalizePayload(fixture({
    candidates: [
      { id: 'late', title: '후순위', organizer_name: '가', deadline: '2026-09-20', status: 'watching', eligibility_status: 'review' },
      { id: 'soon', title: '청소년 우선', organizer_name: '나', deadline: '2026-09-02', status: 'ready', eligibility_status: 'eligible' },
      { id: 'none', title: '마감 미정', organizer_name: '다', status: 'ready', eligibility_status: 'eligible' },
    ],
    applications: [],
    sources: [],
  }));
  const eligible = ui.filterCandidates(normalized.candidates, {
    search: '청소년', status: 'preparing', eligibility: 'eligible', deadline: '7d', sort: 'deadline-asc',
  }, NOW);
  assert.deepEqual(Array.from(eligible, (item) => item.id), ['soon']);
  assert.deepEqual(
    Array.from(ui.filterCandidates(normalized.candidates, { sort: 'deadline-desc' }, NOW), (item) => item.id),
    ['late', 'soon', 'none'],
  );
});

test('controller renders loading, empty, error/retry and manual refresh states', async () => {
  const success = competitionContext();
  const responses = [fixture(), fixture({ candidates: [] })];
  const delays = [];
  const controller = success.ui.createDashboard({
    request: async () => responses.shift(),
    now: () => NOW,
    setTimer(callback, delay) { void callback; delays.push(delay); return delays.length; },
    clearTimer() {},
  });
  controller.activate();
  assert.match(success.store.get('competitionBody').innerHTML, /불러오고 있습니다/u);
  await flush();
  assert.match(success.store.get('competitionBody').innerHTML, /청소년 디자인 공모전/u);
  assert.deepEqual(delays, [success.ui.AUTO_REFRESH_MS]);
  assert.equal(delays.includes(5_000), false);
  await success.store.get('competitionReload').listeners.click();
  await flush();
  assert.match(success.store.get('competitionBody').innerHTML, /조건에 맞는 후보가 없습니다/u);
  assert.equal(success.store.get('competitionRefreshStatus').textContent, '서버에서 방금 확인했습니다.');

  const refreshFailure = competitionContext();
  const refreshResponses = [fixture(), new Error('refresh failed')];
  const refreshController = refreshFailure.ui.createDashboard({
    request: async () => {
      const response = refreshResponses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    now: () => NOW,
    setTimer() { return 1; },
    clearTimer() {},
  });
  refreshController.activate();
  await flush();
  await refreshFailure.store.get('competitionReload').listeners.click();
  await flush();
  assert.equal(refreshFailure.store.get('competitionBody').getAttribute('aria-busy'), 'false');
  assert.match(refreshFailure.store.get('competitionBody').innerHTML, /청소년 디자인 공모전/u);
  assert.equal(refreshFailure.store.get('competitionError').textContent, 'refresh failed');
  assert.equal(
    refreshFailure.store.get('competitionRefreshStatus').textContent,
    '업데이트하지 못했습니다. 이전 결과를 표시합니다.',
  );

  const failure = competitionContext();
  const failedController = failure.ui.createDashboard({ request: async () => { throw new Error('network down'); } });
  failedController.activate();
  await flush();
  assert.equal(failure.store.get('competitionError').textContent, 'network down');
  assert.match(failure.store.get('competitionBody').innerHTML, /data-competition-retry/u);
});

function usageContext() {
  const store = new Map();
  const tabs = ['ops', 'moderator', 'competition', 'guide'].map((name, index) => {
    const tab = element(`tab-${name}`);
    tab.dataset.usageView = name;
    tab.tabIndex = index === 0 ? 0 : -1;
    return tab;
  });
  const document = {
    hidden: false,
    title: 'hvsdcm',
    getElementById(id) {
      if (!store.has(id)) store.set(id, element(id));
      return store.get(id);
    },
    querySelectorAll(selector) { return selector === '[data-usage-view]' ? tabs : []; },
    querySelector() { return null; },
    addEventListener() {},
    removeEventListener() {},
    createElement() { return element(); },
    activeElement: null,
  };
  const requests = [];
  const context = {
    document,
    location: {
      href: 'https://hvsdcm1.xyz/usage/', pathname: '/usage/', search: '',
      replace() { throw new Error('owner gate unexpectedly redirected'); },
    },
    localStorage: {
      values: new Map([['hvsdcm.token', 'gate-token']]),
      getItem(key) { return this.values.get(key) ?? null; },
      setItem(key, value) { this.values.set(key, String(value)); },
      removeItem(key) { this.values.delete(key); },
    },
    fetch: async (url) => {
      const href = String(url);
      requests.push(href);
      if (href.includes('/api/competitions')) return { ok: true, status: 200, json: async () => fixture() };
      if (href.includes('/api/moderator')) return {
        ok: true, status: 200, json: async () => ({ items: [], commands: [], counts: {}, unread_counts: {} }),
      };
      return { ok: true, status: 200, json: async () => ({ snapshots: [], tasks: [] }) };
    },
    setTimeout() { return 1; },
    clearTimeout() {},
    AbortController,
    URL,
    Intl,
    console: { log() {}, warn() {}, error() {} },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(COMPETITION_SOURCE, context, { filename: 'competition.js' });
  vm.runInContext(USAGE_SOURCE, context, { filename: 'usage.js' });
  return { context, store, tabs, requests };
}

test('the ARIA tab is wired and the API stays lazy through first activation', async () => {
  const shell = usageContext();
  await flush();
  assert.equal(shell.requests.filter((url) => url.includes('/api/competitions')).length, 0);

  shell.context.USAGE_RENDER.activateUsageView('competition');
  shell.context.USAGE_RENDER.activateUsageView('competition');
  await flush();
  assert.equal(shell.requests.filter((url) => url.includes('/api/competitions')).length, 1);
  assert.equal(shell.store.get('viewCompetition').hidden, false);
  assert.equal(shell.store.get('viewOps').hidden, true);
  assert.equal(shell.tabs[2].attributes['aria-selected'], 'true');
  assert.equal(shell.tabs[2].tabIndex, 0);
  assert.equal(shell.tabs[0].tabIndex, -1);

  shell.context.USAGE_RENDER.activateUsageView('moderator');
  const event = { key: 'ArrowDown', preventDefault() { this.prevented = true; } };
  shell.tabs[1].listeners.keydown(event);
  assert.equal(event.prevented, true);
  assert.equal(shell.tabs[2].focused, true);
  assert.equal(shell.tabs[2].attributes['aria-selected'], 'true');
});

test('static markup connects every tab to one hidden-aware panel and keeps owner details out of titles', () => {
  const tabs = [...HTML.matchAll(/<button id="(tab\w+)"[^>]*role="tab"[^>]*aria-controls="(view\w+)"[^>]*data-usage-view="(\w+)"/gu)];
  assert.deepEqual(Array.from(tabs, (match) => match[3]), ['ops', 'moderator', 'competition', 'guide']);
  for (const [, tabId, viewId] of tabs) {
    assert.match(HTML, new RegExp(`<section id="${viewId}"[^>]*role="tabpanel"[^>]*aria-labelledby="${tabId}"`, 'u'));
  }
  assert.match(HTML, /<title>hvsdcm<\/title>/u);
  assert.doesNotMatch(HTML.match(/<title>[\s\S]*?<\/title>/u)?.[0] || '', /공모전/u);
});
