(() => {
  'use strict';

  // words.js의 정적 데이터와 localStorage 기반 학습 상태를 연결하는 화면 컨트롤러다.
  // 데이터 불변식(50 DAY × 40개)은 루트 검증 스크립트에서 별도로 확인한다.
  const EXPECTED_WORD_COUNT = 2000;
  const MAX_DAY = 50;
  const WORDS = Array.isArray(window.WORDMASTER_WORDS) ? window.WORDMASTER_WORDS : [];
  const WORD_BY_ID = new Map(WORDS.map((item) => [item.id, item]));
  const STORAGE_KEY = 'wordmaster2000.quiz.v1';
  const app = document.getElementById('app');
  const toast = document.getElementById('toast');
  const studyUtils = window.HvsStudyUtils;

  if (!studyUtils) {
    app.innerHTML = '<div class="card"><h2>화면 로드 오류</h2><p>공통 학습 도구를 불러오지 못했습니다.</p></div>';
    return;
  }

  const { SORT_MODES, escapeHtml, sortStudyItems } = studyUtils;

  // 이모지는 words.js의 WORDMASTER_EMOJI 매핑에서만 나온다 (DESIGN.md §5).
  // 마크업에는 슬롯만 두고 글리프 리터럴을 박지 않는다. 키는 항상 리터럴로 넘긴다 —
  // scripts/validate.mjs가 이 호출에서 매핑 키를 도출해 죽은 항목·누락을 잡는다.
  const EMOJI = window.WORDMASTER_EMOJI || {};

  function emojiLead(key, variant) {
    const glyph = escapeHtml(EMOJI[key] || EMOJI.app || '');
    return variant === 'lg'
      ? `<span class="emoji emoji-lg" aria-hidden="true">${glyph}</span>`
      : `<span class="list-row-lead"><span class="emoji-box" aria-hidden="true">${glyph}</span></span>`;
  }

  const pad2 = (value) => String(value).padStart(2, '0');

  const state = {
    view: 'home',
    session: null,
    home: {
      startDay: 1,
      endDay: 1,
      questionCount: 'all',
      order: 'random',
    },
    wrongOrder: 'recent',
  };

  let db = loadDb();
  let toastTimer = null;

  function blankDb() {
    return {
      version: 1,
      stats: {},
      wrongBank: {},
      customAliases: {},
      sessions: 0,
      updatedAt: Date.now(),
    };
  }

  function loadDb() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return blankDb();
      const parsed = JSON.parse(raw);
      return {
        ...blankDb(),
        ...parsed,
        stats: parsed.stats || {},
        wrongBank: parsed.wrongBank || {},
        customAliases: parsed.customAliases || {},
      };
    } catch {
      return blankDb();
    }
  }

  function saveDb() {
    db.updatedAt = Date.now();
    const serialized = JSON.stringify(db);
    localStorage.setItem(STORAGE_KEY, serialized);
    window.HvsAccount?.scheduleProgressSync(serialized);
  }

  function clampDay(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX_DAY, Math.max(1, n));
  }

  function normalizeText(value) {
    return String(value ?? '')
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[\s\u00A0]+/g, '')
      .replace(/[.,;:!?"'`´“”‘’·•\/\\|<>《》〈〉「」『』【】()[\]{}~…―—–_-]/g, '');
  }

  function splitTopLevel(text) {
    const parts = [];
    let buf = '';
    let depth = 0;
    const open = new Set(['(', '[', '{', '〈', '《', '【']);
    const close = new Set([')', ']', '}', '〉', '》', '】']);
    for (const ch of String(text)) {
      if (open.has(ch)) depth += 1;
      if (close.has(ch)) depth = Math.max(0, depth - 1);
      if ((ch === ',' || ch === ';' || ch === '/') && depth === 0) {
        if (buf.trim()) parts.push(buf.trim());
        buf = '';
      } else {
        buf += ch;
      }
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
  }

  function expandSquareVariants(segment) {
    const match = segment.match(/^(.*?)\[([^\]]+)\](.*)$/);
    if (!match) return [segment];
    const [, before, inside, after] = match;
    const variants = [before + after, inside + after, before + inside + after];
    return [...new Set(variants.flatMap(expandSquareVariants))];
  }

  function cleanMeaningSegment(segment) {
    return String(segment)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[<>]/g, ' ')
      .replace(/^\s*~\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function acceptedAliases(item) {
    const source = item.meaning || '';
    const set = new Set();
    const push = (value) => {
      const normalized = normalizeText(value);
      if (normalized) set.add(normalized);
    };

    push(source);
    const segments = splitTopLevel(source);
    for (const segment of segments) {
      for (const expanded of expandSquareVariants(segment)) {
        const cleaned = cleanMeaningSegment(expanded);
        push(cleaned);
        // 일부 뜻은 '~을', '~에'처럼 자리표시자 조사로 시작한다. 그 조사만 뺀 표현도 허용한다.
        const particleStripped = cleaned.replace(/^(을|를|에|에게|에서|의|로|으로|와|과)\s+/, '');
        if (particleStripped !== cleaned) push(particleStripped);
      }
    }

    const custom = db.customAliases[item.id] || [];
    for (const alias of custom) push(alias);
    return set;
  }

  function parseUserAnswers(input) {
    const rawParts = splitTopLevel(input);
    const values = rawParts.length ? rawParts : [input];
    return values.map(normalizeText).filter(Boolean);
  }

  function checkAnswer(item, input) {
    const userAnswers = parseUserAnswers(input);
    if (!userAnswers.length) return false;
    const aliases = acceptedAliases(item);
    return userAnswers.some((answer) => aliases.has(answer));
  }

  function recordAttempt(item, input, isCorrect, mode) {
    const current = db.stats[item.id] || {
      attempts: 0,
      correct: 0,
      wrong: 0,
      streak: 0,
      lastAnswer: '',
      lastAt: 0,
    };
    current.attempts += 1;
    current.lastAnswer = input;
    current.lastAt = Date.now();
    if (isCorrect) {
      current.correct += 1;
      current.streak = Math.max(0, current.streak) + 1;
      if (mode === 'review') delete db.wrongBank[item.id];
    } else {
      current.wrong += 1;
      current.streak = 0;
      const wrong = db.wrongBank[item.id] || { count: 0, lastWrongAt: 0, lastAnswer: '' };
      wrong.count += 1;
      wrong.lastWrongAt = Date.now();
      wrong.lastAnswer = input;
      db.wrongBank[item.id] = wrong;
    }
    db.stats[item.id] = current;
    saveDb();
  }

  function addCustomAlias(item, input) {
    const cleaned = String(input || '').trim();
    if (!cleaned) return false;
    const list = db.customAliases[item.id] || [];
    const norm = normalizeText(cleaned);
    if (!list.some((x) => normalizeText(x) === norm)) list.push(cleaned);
    db.customAliases[item.id] = list;
    saveDb();
    return true;
  }

  function markCurrentAsAccepted() {
    const session = state.session;
    if (!session || !session.answered || session.lastResult?.correct) return;
    const item = session.questions[session.index];
    const input = session.lastResult.input;
    if (!addCustomAlias(item, input)) return;

    // 방금 오답으로 들어간 기록을 이번 1회에 한해 정답으로 되돌린다.
    const stats = db.stats[item.id];
    if (stats) {
      stats.wrong = Math.max(0, stats.wrong - 1);
      stats.correct += 1;
      stats.streak = Math.max(1, stats.streak || 0);
    }
    if (session.mode === 'review') delete db.wrongBank[item.id];
    else {
      const bank = db.wrongBank[item.id];
      if (bank) {
        bank.count = Math.max(0, bank.count - 1);
        if (bank.count === 0) delete db.wrongBank[item.id];
      }
    }
    saveDb();

    session.correct += 1;
    session.wrong = Math.max(0, session.wrong - 1);
    session.lastResult.correct = true;
    session.lastResult.overridden = true;
    const row = session.results[session.results.length - 1];
    if (row && row.id === item.id) {
      row.correct = true;
      row.overridden = true;
    }
    window.HvsAccount?.api('/api/answers/accept', {
      method: 'POST',
      body: JSON.stringify({ app: 'wordmaster', questionId: item.id, questionLabel: item.word, baseAnswer: item.meaning, answer: input }),
    }).catch(() => {});
    renderQuiz();
    showToast('이 답을 정답 표현으로 저장했습니다.');
  }

  function summaryStats() {
    const stats = Object.values(db.stats);
    const attempts = stats.reduce((sum, row) => sum + (row.attempts || 0), 0);
    const correct = stats.reduce((sum, row) => sum + (row.correct || 0), 0);
    return {
      attempts,
      correct,
      accuracy: attempts ? Math.round((correct / attempts) * 100) : 0,
      wrongCount: Object.keys(db.wrongBank).filter((id) => WORD_BY_ID.has(id)).length,
    };
  }

  function getRangeWords(start, end) {
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    return WORDS.filter((item) => item.day >= lo && item.day <= hi);
  }

  function compareWords(left, right) {
    return left.day - right.day || left.number - right.number;
  }

  function personalWrongRate(item) {
    const stats = db.stats[item.id];
    return stats?.attempts ? ((stats.wrong || 0) / stats.attempts) * 100 : null;
  }

  function cumulativeWrongCount(item) {
    return db.stats[item.id]?.wrong || 0;
  }

  function recentAttemptAt(item) {
    return db.stats[item.id]?.lastAt || null;
  }

  function sortWords(items, order) {
    return sortStudyItems(items, order, {
      wrongRate: personalWrongRate,
      wrongCount: cumulativeWrongCount,
      recentAt: recentAttemptAt,
      compareDefault: compareWords,
    });
  }

  function renderSortOptions(selected, sequentialLabel = 'DAY 순서') {
    const options = [
      [SORT_MODES.RANDOM, '랜덤'],
      [SORT_MODES.SEQUENTIAL, sequentialLabel],
      [SORT_MODES.WRONG_HIGH, '오답률 높은 순'],
      [SORT_MODES.WRONG_LOW, '오답률 낮은 순'],
      [SORT_MODES.RECENT, '최근 풀이 순'],
    ];
    return options.map(([value, label]) => (
      `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`
    )).join('');
  }

  function sessionLabel(session) {
    if (session.mode === 'review') return '오답 재시험';
    return session.startDay === session.endDay
      ? `DAY ${String(session.startDay).padStart(2, '0')}`
      : `DAY ${String(session.startDay).padStart(2, '0')}–${String(session.endDay).padStart(2, '0')}`;
  }

  function startRangeQuiz() {
    const startInput = document.getElementById('startDay');
    const endInput = document.getElementById('endDay');
    const countSelect = document.getElementById('questionCount');
    const orderSelect = document.getElementById('orderMode');
    let startDay = clampDay(startInput?.value ?? state.home.startDay);
    let endDay = clampDay(endInput?.value ?? state.home.endDay);
    if (startDay > endDay) [startDay, endDay] = [endDay, startDay];

    const countChoice = countSelect?.value || 'all';
    const order = orderSelect?.value || 'random';
    state.home = { startDay, endDay, questionCount: countChoice, order };

    let pool = sortWords(getRangeWords(startDay, endDay), order);
    if (countChoice !== 'all') {
      const limit = Math.max(1, Number.parseInt(countChoice, 10) || pool.length);
      pool = pool.slice(0, Math.min(limit, pool.length));
    }

    startSession(pool, { mode: 'range', startDay, endDay });
  }

  function startReviewQuiz(ids = null, order = SORT_MODES.RANDOM) {
    const sourceIds = ids || Object.keys(db.wrongBank);
    const questions = sortWords(sourceIds.map((id) => WORD_BY_ID.get(id)).filter(Boolean), order);
    if (!questions.length) {
      showToast('현재 오답 노트가 비어 있습니다.');
      renderHome();
      return;
    }
    startSession(questions, { mode: 'review', startDay: null, endDay: null });
  }

  function startSession(questions, meta) {
    if (!questions.length) {
      showToast('선택한 범위에 문제가 없습니다.');
      return;
    }
    state.session = {
      ...meta,
      questions,
      index: 0,
      correct: 0,
      wrong: 0,
      answered: false,
      lastResult: null,
      results: [],
      startedAt: Date.now(),
    };
    state.view = 'quiz';
    db.sessions += 1;
    saveDb();
    renderQuiz();
  }

  function submitAnswer() {
    const session = state.session;
    if (!session || session.answered) {
      if (session?.answered) nextQuestion();
      return;
    }
    const item = session.questions[session.index];
    const inputEl = document.getElementById('answerInput');
    const input = String(inputEl?.value || '').trim();
    if (input === '고준서') {
      showToast('준서야 공부해라');
      inputEl.value = '';
      inputEl.focus();
      return;
    }
    const correct = checkAnswer(item, input);

    session.answered = true;
    session.lastResult = { input, correct, overridden: false };
    if (correct) session.correct += 1;
    else session.wrong += 1;
    session.results.push({ id: item.id, input, correct, overridden: false });
    recordAttempt(item, input, correct, session.mode);
    renderQuiz();
  }

  function nextQuestion() {
    const session = state.session;
    if (!session || !session.answered) return;
    if (session.index >= session.questions.length - 1) {
      state.view = 'result';
      renderResult();
      return;
    }
    session.index += 1;
    session.answered = false;
    session.lastResult = null;
    renderQuiz();
  }

  function setNav(view) {
    const active = view === 'stats' ? 'stats' : 'home';
    document.querySelectorAll('.sidebar-item[data-nav]').forEach((item) => {
      const on = item.dataset.nav === active;
      item.classList.toggle('is-active', on);
      if (on) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
  }

  function renderHome() {
    state.view = 'home';
    state.session = null;
    setNav('home');
    const s = summaryStats();
    const poolSize = getRangeWords(state.home.startDay, state.home.endDay).length;
    app.innerHTML = `
      <header class="view-head">
        <div class="wm-head-main">
          ${emojiLead('app', 'lg')}
          <div>
            <h1>시험 설정</h1>
            <p>DAY 범위를 정하면 한국어 뜻 주관식 시험이 시작됩니다.</p>
          </div>
        </div>
        <span class="badge badge-accent">DAY ${pad2(state.home.startDay)}–${pad2(state.home.endDay)} · ${poolSize.toLocaleString()}단어</span>
      </header>

      <div class="wm-layout">
        <section class="wm-col" aria-labelledby="rangeHead">
          <p class="list-group-head" id="rangeHead">출제 범위</p>
          <div class="list-group">
            <div class="list-row">
              ${emojiLead('range')}
              <span class="list-row-body"><span class="list-row-title">DAY 범위</span></span>
              <span class="list-row-value wm-range">
                <input id="startDay" class="wm-num" type="number" min="1" max="50" inputmode="numeric" aria-label="시작 DAY" value="${state.home.startDay}">
                <span aria-hidden="true">–</span>
                <input id="endDay" class="wm-num" type="number" min="1" max="50" inputmode="numeric" aria-label="끝 DAY" value="${state.home.endDay}">
              </span>
            </div>
            <div class="list-row wm-row-wrap">
              ${emojiLead('preset')}
              <span class="list-row-body"><span class="list-row-title">빠른 선택</span></span>
              <span class="segmented wm-presets" role="group" aria-label="DAY 범위 빠른 선택">
                <button class="segmented-btn preset" type="button" data-start="1" data-end="1">1</button>
                <button class="segmented-btn preset" type="button" data-start="1" data-end="10">1–10</button>
                <button class="segmented-btn preset" type="button" data-start="1" data-end="25">1–25</button>
                <button class="segmented-btn preset" type="button" data-start="26" data-end="50">26–50</button>
                <button class="segmented-btn preset" type="button" data-start="1" data-end="50">전체</button>
              </span>
            </div>
            <div class="list-row">
              ${emojiLead('count')}
              <span class="list-row-body"><label class="list-row-title" for="questionCount">문제 수</label></span>
              <span class="list-row-value">
                <select id="questionCount" class="wm-select">
                  <option value="25" ${state.home.questionCount === '25' ? 'selected' : ''}>25개</option>
                  <option value="50" ${state.home.questionCount === '50' ? 'selected' : ''}>50개</option>
                  <option value="100" ${state.home.questionCount === '100' ? 'selected' : ''}>100개</option>
                  <option value="all" ${state.home.questionCount === 'all' ? 'selected' : ''}>전체</option>
                </select>
              </span>
            </div>
            <div class="list-row">
              ${emojiLead('order')}
              <span class="list-row-body"><label class="list-row-title" for="orderMode">출제 순서</label></span>
              <span class="list-row-value"><select id="orderMode" class="wm-select">${renderSortOptions(state.home.order)}</select></span>
            </div>
          </div>
          <button id="startQuizBtn" class="btn btn-primary btn-lg wm-start" type="button">시험 시작</button>
        </section>

        <aside class="wm-panel">
          <p class="list-group-head">학습 현황</p>
          <div class="list-group">
            <div class="list-row">
              ${emojiLead('attempts')}
              <span class="list-row-body"><span class="list-row-title">총 풀이</span></span>
              <span class="list-row-value">${s.attempts.toLocaleString()}</span>
            </div>
            <div class="list-row">
              ${emojiLead('accuracy')}
              <span class="list-row-body"><span class="list-row-title">정답률</span></span>
              <span class="list-row-value">${s.accuracy}%</span>
            </div>
            <div class="list-row">
              ${emojiLead('wrong')}
              <span class="list-row-body"><span class="list-row-title">오답 노트</span></span>
              <span class="list-row-value">${s.wrongCount.toLocaleString()}</span>
            </div>
          </div>

          <p class="list-group-head">오답 다루기</p>
          <div class="list-group">
            <button id="wrongStudyBtn" class="list-row list-row-nav" type="button" ${s.wrongCount ? '' : 'disabled'}>
              ${emojiLead('study')}
              <span class="list-row-body"><span class="list-row-title">오답 보고 외우기</span><span class="list-row-sub">뜻을 보면서 훑습니다</span></span>
            </button>
            <button id="reviewBtn" class="list-row list-row-nav" type="button" ${s.wrongCount ? '' : 'disabled'}>
              ${emojiLead('retest')}
              <span class="list-row-body"><span class="list-row-title">오답 재시험</span><span class="list-row-sub">맞히면 노트에서 빠집니다</span></span>
            </button>
          </div>
        </aside>
      </div>
    `;

    document.querySelectorAll('.preset').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('startDay').value = button.dataset.start;
        document.getElementById('endDay').value = button.dataset.end;
      });
    });
    document.getElementById('startQuizBtn').addEventListener('click', startRangeQuiz);
    document.getElementById('wrongStudyBtn').addEventListener('click', renderStatsPage);
    document.getElementById('reviewBtn').addEventListener('click', () => startReviewQuiz());
    requestAnimationFrame(() => app.focus({ preventScroll: true }));
  }

  function renderQuiz() {
    const session = state.session;
    if (!session) return renderHome();
    state.view = 'quiz';
    setNav('quiz');
    const item = session.questions[session.index];
    const answered = session.answered;
    const result = session.lastResult;
    const current = session.index + 1;
    const total = session.questions.length;
    const progress = Math.round((current / total) * 100);

    app.innerHTML = `
      <header class="view-head">
        <div class="wm-head-main">
          ${emojiLead('app', 'lg')}
          <div>
            <span class="kicker">${escapeHtml(sessionLabel(session))}</span>
            <h1>뜻 시험</h1>
          </div>
        </div>
        <span class="badge ${session.wrong ? 'badge-red' : 'badge-green'}">정답 ${session.correct} · 오답 ${session.wrong}</span>
      </header>

      <section class="wm-progress" aria-label="진행 상황">
        <div class="wm-progress-meta"><span>${current} / ${total}</span><span>${progress}%</span></div>
        <div class="wm-track"><div class="wm-fill" style="width:${progress}%"></div></div>
      </section>

      <section class="card wm-question">
        <div class="wm-word-line">
          <h2 class="wm-word">${escapeHtml(item.word)}</h2>
          <span class="badge">DAY ${pad2(item.day)} · ${pad2(item.number)}</span>
        </div>

        <div class="field">
          <label class="field-label" for="answerInput">한국어 뜻</label>
          <div class="wm-answer-row">
            <input id="answerInput" class="field-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="뜻을 입력하세요" value="${answered ? escapeHtml(result.input) : ''}" ${answered ? 'disabled' : ''}>
            <button id="submitBtn" class="btn btn-primary" type="button">${answered ? (current === total ? '결과 보기' : '다음') : '정답 확인'}</button>
          </div>
          <p class="wm-hint">Enter로 정답 확인 · 확인 후 Enter로 다음 문제</p>
        </div>

        ${answered ? renderFeedback(item, result) : ''}
      </section>
    `;

    document.getElementById('submitBtn').addEventListener('click', answered ? nextQuestion : submitAnswer);
    const input = document.getElementById('answerInput');
    if (!answered) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          submitAnswer();
        }
      });
      requestAnimationFrame(() => input.focus());
    } else {
      document.getElementById('acceptMineBtn')?.addEventListener('click', markCurrentAsAccepted);
      requestAnimationFrame(() => document.getElementById('submitBtn')?.focus());
    }
  }

  // 채점 결과는 색 패널이 아니라 인셋 그룹 리스트 3행이다 — 문장 하나에 상자 하나를
  // 두르지 않는다 (DESIGN.md §6). 상태는 행 선두 이모지와 판정 라벨 색이 낸다.
  function renderFeedback(item, result) {
    const isCorrect = result.correct;
    return `
      <div class="wm-feedback ${isCorrect ? 'is-correct' : 'is-wrong'}" role="status">
        <div class="list-group is-inset">
          <div class="list-row">
            ${isCorrect ? emojiLead('correct') : emojiLead('incorrect')}
            <span class="list-row-body"><span class="list-row-title wm-verdict">${isCorrect ? '정답' : '오답'}</span></span>
            ${result.overridden ? '<span class="list-row-value">내 답을 정답으로 저장함</span>' : ''}
          </div>
          <div class="list-row">
            <span class="list-row-body"><span class="list-row-title">교재 정답</span></span>
            <span class="list-row-value wm-gloss">${escapeHtml(item.meaning)}</span>
          </div>
          <div class="list-row">
            <span class="list-row-body"><span class="list-row-title">내 답</span></span>
            <span class="list-row-value wm-gloss">${escapeHtml(result.input || '(빈 답)')}</span>
          </div>
        </div>
        ${!isCorrect && result.input
          ? '<button id="acceptMineBtn" class="btn btn-secondary btn-sm" type="button">내 답도 정답으로 인정</button>'
          : ''}
      </div>
    `;
  }

  function renderResult() {
    const session = state.session;
    if (!session) return renderHome();
    state.view = 'result';
    setNav('result');
    const total = session.questions.length;
    const accuracy = total ? Math.round((session.correct / total) * 100) : 0;
    const wrongRows = session.results.filter((row) => !row.correct);

    app.innerHTML = `
      <header class="view-head">
        <div class="wm-head-main">
          ${emojiLead('app', 'lg')}
          <div>
            <span class="kicker">${escapeHtml(sessionLabel(session))} 완료</span>
            <h1>시험 결과</h1>
          </div>
        </div>
        <div class="wm-score">${accuracy}%</div>
      </header>

      <div class="list-group">
        <div class="list-row">
          ${emojiLead('correct')}
          <span class="list-row-body"><span class="list-row-title">정답</span></span>
          <span class="list-row-value">${session.correct}</span>
        </div>
        <div class="list-row">
          ${emojiLead('incorrect')}
          <span class="list-row-body"><span class="list-row-title">오답</span></span>
          <span class="list-row-value">${session.wrong}</span>
        </div>
        <div class="list-row">
          ${emojiLead('count')}
          <span class="list-row-body"><span class="list-row-title">문항</span></span>
          <span class="list-row-value">${total}</span>
        </div>
      </div>

      <div class="wm-actions-row">
        <button id="retryWrongBtn" class="btn btn-primary" type="button" ${wrongRows.length ? '' : 'disabled'}>이번 오답만 재시험</button>
        <button id="resultHomeBtn" class="btn btn-secondary" type="button">시험 설정으로</button>
      </div>

      ${wrongRows.length ? `
        <section aria-labelledby="sessionMistakes">
          <p class="list-group-head" id="sessionMistakes">이번 시험 오답 ${wrongRows.length}개</p>
          <div class="list-group">
            ${wrongRows.map((row) => {
              const item = WORD_BY_ID.get(row.id);
              return `
                <div class="list-row wm-mistake">
                  <span class="list-row-body">
                    <span class="list-row-title wm-term">${escapeHtml(item.word)}</span>
                    <span class="list-row-sub">${escapeHtml(item.meaning)}</span>
                  </span>
                  <span class="list-row-value wm-meta">
                    <span>DAY ${pad2(item.day)} · ${pad2(item.number)}</span>
                    <small>내 답 · ${escapeHtml(row.input || '(빈 답)')}</small>
                  </span>
                </div>`;
            }).join('')}
          </div>
        </section>
      ` : ''}
    `;

    document.getElementById('resultHomeBtn').addEventListener('click', renderHome);
    document.getElementById('retryWrongBtn').addEventListener('click', () => startReviewQuiz(wrongRows.map((x) => x.id)));
  }

  function renderStatsPage() {
    state.view = 'stats';
    state.session = null;
    setNav('stats');
    const s = summaryStats();
    const wrongItems = Object.keys(db.wrongBank)
      .map((id) => WORD_BY_ID.get(id))
      .filter(Boolean);
    const wrongEntries = sortWords(wrongItems, state.wrongOrder)
      .map((item) => ({ item, info: db.wrongBank[item.id] }));

    app.innerHTML = `
      <header class="view-head">
        <div class="wm-head-main">
          ${emojiLead('app', 'lg')}
          <div>
            <h1>학습 기록</h1>
            <p>계정 DB에 저장된 풀이 기록입니다. 이 브라우저에는 사본만 남습니다.</p>
          </div>
        </div>
        <button id="statsBackBtn" class="btn btn-secondary btn-sm" type="button">시험 설정</button>
      </header>

      <div class="wm-layout">
        <section class="wm-col" aria-labelledby="wrongNoteTitle">
          <div class="list-group-head-row">
            <p class="list-group-head" id="wrongNoteTitle">오답 암기 노트 · ${wrongEntries.length}개</p>
            <div class="wm-sort">
              <label class="wm-sort-label" for="wrongSortMode">정렬</label>
              <select id="wrongSortMode" class="wm-select">${renderSortOptions(state.wrongOrder)}</select>
              <button id="statsReviewBtn" class="btn btn-primary btn-sm" type="button" ${wrongEntries.length ? '' : 'disabled'}>재시험</button>
            </div>
          </div>
          <div class="list-group">
            ${wrongEntries.length ? wrongEntries.slice(0, 200).map(({ item, info }) => `
              <div class="list-row wm-mistake">
                <span class="list-row-body">
                  <span class="list-row-title wm-term">${escapeHtml(item.word)}</span>
                  <span class="list-row-sub">${escapeHtml(item.meaning)}</span>
                </span>
                <span class="list-row-value wm-meta">
                  <span>DAY ${pad2(item.day)} · 오답률 ${Math.round(personalWrongRate(item) || 0)}% · 누적 ${info.count || 1}회</span>
                  <small>최근 답 · ${escapeHtml(info.lastAnswer || '(빈 답)')}</small>
                </span>
              </div>
            `).join('') : '<p class="wm-empty">아직 오답이 없습니다.</p>'}
          </div>
        </section>

        <aside class="wm-panel">
          <p class="list-group-head">누적 지표</p>
          <div class="list-group">
            <div class="list-row">
              ${emojiLead('attempts')}
              <span class="list-row-body"><span class="list-row-title">총 풀이</span></span>
              <span class="list-row-value">${s.attempts.toLocaleString()}</span>
            </div>
            <div class="list-row">
              ${emojiLead('accuracy')}
              <span class="list-row-body"><span class="list-row-title">정답률</span></span>
              <span class="list-row-value">${s.accuracy}%</span>
            </div>
            <div class="list-row">
              ${emojiLead('wrong')}
              <span class="list-row-body"><span class="list-row-title">오답 노트</span></span>
              <span class="list-row-value">${s.wrongCount.toLocaleString()}</span>
            </div>
          </div>

          <p class="list-group-head">기록 데이터</p>
          <div class="list-group">
            <button id="exportBtn" class="list-row list-row-nav" type="button">
              ${emojiLead('backup')}
              <span class="list-row-body"><span class="list-row-title">기록 백업</span></span>
            </button>
            <label class="list-row list-row-nav" for="importFile">
              ${emojiLead('restore')}
              <span class="list-row-body"><span class="list-row-title">기록 복원</span></span>
            </label>
            <button id="resetBtn" class="list-row wm-row-danger" type="button">
              ${emojiLead('reset')}
              <span class="list-row-body"><span class="list-row-title">기록 초기화</span></span>
            </button>
          </div>
          <!-- 파일 입력은 그룹 밖에 둔다 — 행 사이에 끼우면 .list-row + .list-row 구분선이 끊긴다. -->
          <input id="importFile" class="wm-file" type="file" accept="application/json,.json">
        </aside>
      </div>
    `;

    document.getElementById('statsBackBtn').addEventListener('click', renderHome);
    document.getElementById('wrongSortMode').addEventListener('change', (event) => {
      state.wrongOrder = event.target.value;
      renderStatsPage();
    });
    document.getElementById('statsReviewBtn').addEventListener('click', () => (
      startReviewQuiz(wrongEntries.map(({ item }) => item.id), state.wrongOrder)
    ));
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('importFile').addEventListener('change', importData);
    document.getElementById('resetBtn').addEventListener('click', resetData);
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `wordmaster-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast('학습 기록을 백업했습니다.');
  }

  async function importData(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== 'object') throw new Error('bad format');
      db = {
        ...blankDb(),
        ...parsed,
        stats: parsed.stats || {},
        wrongBank: parsed.wrongBank || {},
        customAliases: parsed.customAliases || {},
      };
      saveDb();
      renderStatsPage();
      showToast('학습 기록을 복원했습니다.');
    } catch {
      showToast('올바른 백업 파일이 아닙니다.');
    } finally {
      event.target.value = '';
    }
  }

  function resetData() {
    const ok = window.confirm('오답, 정답률, 사용자 정답 표현을 전부 삭제할까요? 이 작업은 되돌릴 수 없습니다.');
    if (!ok) return;
    db = blankDb();
    saveDb();
    renderStatsPage();
    showToast('학습 기록을 초기화했습니다.');
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('open'), 1900);
  }

  function goHomeWithConfirm() {
    if (state.view === 'quiz' && state.session && state.session.index > 0) {
      if (!window.confirm('진행 중인 시험을 종료하고 홈으로 갈까요?')) return;
    }
    renderHome();
  }

  document.getElementById('homeLogo').addEventListener('click', goHomeWithConfirm);
  document.getElementById('openStatsBtn').addEventListener('click', () => {
    if (state.view === 'quiz' && !window.confirm('진행 중인 시험을 종료하고 기록을 볼까요?')) return;
    renderStatsPage();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && state.view === 'quiz' && state.session?.answered) {
      const active = document.activeElement;
      if (active?.id === 'acceptMineBtn' || active?.tagName === 'BUTTON') return;
      event.preventDefault();
      nextQuestion();
    }
  });

  if (WORDS.length !== EXPECTED_WORD_COUNT) {
    app.innerHTML = `<div class="card"><h2>데이터 로드 오류</h2><p>단어 데이터가 ${WORDS.length}개만 로드되었습니다.</p></div>`;
  } else {
    renderHome();
  }
})();
