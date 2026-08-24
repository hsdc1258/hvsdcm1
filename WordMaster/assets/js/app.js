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

  function renderHome() {
    state.view = 'home';
    state.session = null;
    const s = summaryStats();
    app.innerHTML = `
      <section class="hero">
        <p class="eyebrow">KOREAN MEANING DRILL</p>
        <h1>영단어<br>테스트기</h1>
        <p>DAY를 하나만 고르거나 범위로 묶어서 시험을 시작할 수 있습니다. 틀린 단어는 자동으로 오답 노트에 쌓이고, 나중에 따로 재시험할 수 있습니다.</p>
      </section>

      <section class="grid two">
        <div class="card">
          <h2>시험 범위</h2>
          <p class="card-sub">시작과 끝을 같게 두면 단일 DAY 시험입니다.</p>

          <div class="range-row">
            <div class="field">
              <label for="startDay">시작 DAY</label>
              <input id="startDay" class="day-input" type="number" min="1" max="50" inputmode="numeric" value="${state.home.startDay}">
            </div>
            <div class="range-sep">→</div>
            <div class="field">
              <label for="endDay">끝 DAY</label>
              <input id="endDay" class="day-input" type="number" min="1" max="50" inputmode="numeric" value="${state.home.endDay}">
            </div>
          </div>

          <div class="preset-wrap">
            <span class="section-label">빠른 선택</span>
            <div class="chips">
              <button class="chip preset" data-start="1" data-end="1" type="button">DAY 1</button>
              <button class="chip preset" data-start="1" data-end="10" type="button">1–10</button>
              <button class="chip preset" data-start="1" data-end="25" type="button">1–25</button>
              <button class="chip preset" data-start="26" data-end="50" type="button">26–50</button>
              <button class="chip preset" data-start="1" data-end="50" type="button">1–50</button>
            </div>
          </div>

          <div class="options-row">
            <div class="select-wrap">
              <label for="questionCount">문제 수</label>
              <select id="questionCount">
                <option value="25" ${state.home.questionCount === '25' ? 'selected' : ''}>25개</option>
                <option value="50" ${state.home.questionCount === '50' ? 'selected' : ''}>50개</option>
                <option value="100" ${state.home.questionCount === '100' ? 'selected' : ''}>100개</option>
                <option value="all" ${state.home.questionCount === 'all' ? 'selected' : ''}>전체</option>
              </select>
            </div>
            <div class="select-wrap">
              <label for="orderMode">출제 순서</label>
              <select id="orderMode">
                ${renderSortOptions(state.home.order)}
              </select>
            </div>
          </div>

          <button id="startQuizBtn" class="primary-btn start-btn" type="button">시험 시작</button>
        </div>

        <aside class="card">
          <h2>누적 기록</h2>
          <p class="card-sub">계정 DB에 저장된 누적 기록입니다.</p>
          <div class="stat-list">
            <div class="stat-box"><span>총 풀이</span><strong>${s.attempts.toLocaleString()}</strong></div>
            <div class="stat-box"><span>정답률</span><strong>${s.accuracy}%</strong></div>
          </div>
          <div class="review-box">
            <span class="section-label">오답 노트</span>
            <div class="review-count">${s.wrongCount}</div>
            <p>틀린 단어와 정답을 먼저 보며 외우거나, 다시 시험칠 수 있습니다.</p>
            <div class="review-actions"><button id="wrongStudyBtn" class="ghost-btn" type="button" ${s.wrongCount ? '' : 'disabled'}>오답 보고 외우기</button><button id="reviewBtn" class="secondary-btn" type="button" ${s.wrongCount ? '' : 'disabled'}>오답 재시험</button></div>
          </div>
        </aside>
      </section>
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
    const item = session.questions[session.index];
    const answered = session.answered;
    const result = session.lastResult;
    const current = session.index + 1;
    const total = session.questions.length;
    const progress = Math.round((current / total) * 100);

    app.innerHTML = `
      <section class="quiz-wrap">
        <div class="quiz-head">
          <div class="quiz-meta">
            <span>${escapeHtml(sessionLabel(session))}</span>
            <span>${current} / ${total} · 정답 ${session.correct}</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
        </div>

        <div class="question-card">
          <div class="question-kicker">DAY ${String(item.day).padStart(2, '0')} · ${String(item.number).padStart(2, '0')}</div>
          <h2 class="word">${escapeHtml(item.word)}</h2>

          <label class="answer-label" for="answerInput">한국어 뜻</label>
          <div class="answer-row">
            <input id="answerInput" class="answer-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="뜻을 입력하세요" value="${answered ? escapeHtml(result.input) : ''}" ${answered ? 'disabled' : ''}>
            <button id="submitBtn" class="primary-btn" type="button">${answered ? (current === total ? '결과 보기' : '다음') : '정답 확인'}</button>
          </div>
          <div class="keyboard-hint">Enter로 정답 확인 · 확인 후 Enter로 다음 문제</div>

          ${answered ? renderFeedback(item, result) : ''}
        </div>
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

  function renderFeedback(item, result) {
    const isCorrect = result.correct;
    return `
      <div class="feedback ${isCorrect ? 'correct' : 'wrong'}">
        <div class="feedback-title">${isCorrect ? '✓ 정답' : '✕ 오답'}${result.overridden ? ' · 사용자 정답으로 저장됨' : ''}</div>
        <div class="feedback-grid">
          <div class="feedback-item">
            <small>정답</small>
            <strong>${escapeHtml(item.meaning)}</strong>
          </div>
          <div class="feedback-item">
            <small>내 답</small>
            <strong>${escapeHtml(result.input || '(빈 답)')}</strong>
          </div>
        </div>
        ${!isCorrect && result.input ? `
          <div class="feedback-actions">
            <button id="acceptMineBtn" class="ghost-btn" type="button">내 답도 정답으로 인정</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  function renderResult() {
    const session = state.session;
    if (!session) return renderHome();
    state.view = 'result';
    const total = session.questions.length;
    const accuracy = total ? Math.round((session.correct / total) * 100) : 0;
    const wrongRows = session.results.filter((row) => !row.correct);

    app.innerHTML = `
      <section class="result-card card">
        <div class="result-top">
          <p class="eyebrow">${escapeHtml(sessionLabel(session))}</p>
          <div class="result-score">${accuracy}%</div>
          <p>${total}문제 중 ${session.correct}개 정답</p>
        </div>

        <div class="result-stats">
          <div class="result-stat"><small>정답</small><strong>${session.correct}</strong></div>
          <div class="result-stat"><small>오답</small><strong>${session.wrong}</strong></div>
          <div class="result-stat"><small>문제</small><strong>${total}</strong></div>
        </div>

        <div class="result-actions">
          <button id="resultHomeBtn" class="secondary-btn" type="button">홈으로</button>
          <button id="retryWrongBtn" class="primary-btn" type="button" ${wrongRows.length ? '' : 'disabled'}>이번 오답만 재시험</button>
        </div>

        ${wrongRows.length ? `
          <div class="mistake-section">
            <h3>이번 시험 오답 ${wrongRows.length}개</h3>
            <div class="mistake-list">
              ${wrongRows.map((row) => {
                const item = WORD_BY_ID.get(row.id);
                return `
                  <div class="mistake-row">
                    <div class="mistake-word">${escapeHtml(item.word)}<small>DAY ${String(item.day).padStart(2,'0')} · ${String(item.number).padStart(2,'0')}</small></div>
                    <div class="mistake-meaning">
                      <div>${escapeHtml(item.meaning)}</div>
                      <div class="user-wrong">내 답: ${escapeHtml(row.input || '(빈 답)')}</div>
                    </div>
                  </div>`;
              }).join('')}
            </div>
          </div>
        ` : ''}
      </section>
    `;

    document.getElementById('resultHomeBtn').addEventListener('click', renderHome);
    document.getElementById('retryWrongBtn').addEventListener('click', () => startReviewQuiz(wrongRows.map((x) => x.id)));
  }

  function renderStatsPage() {
    state.view = 'stats';
    state.session = null;
    const s = summaryStats();
    const wrongItems = Object.keys(db.wrongBank)
      .map((id) => WORD_BY_ID.get(id))
      .filter(Boolean);
    const wrongEntries = sortWords(wrongItems, state.wrongOrder)
      .map((item) => ({ item, info: db.wrongBank[item.id] }));

    app.innerHTML = `
      <section class="modal-page">
        <div class="page-title-row">
          <div>
            <p class="eyebrow">ACCOUNT STUDY DATA</p>
            <h2>학습 기록</h2>
            <p>학습 기록은 계정 DB에 저장되며, 현재 브라우저에는 빠른 실행을 위한 사본만 보관됩니다.</p>
          </div>
          <button id="statsBackBtn" class="ghost-btn compact" type="button">홈</button>
        </div>

        <div class="card">
          <div class="stats-grid">
            <div class="stat-box"><span>총 풀이</span><strong>${s.attempts.toLocaleString()}</strong></div>
            <div class="stat-box"><span>정답률</span><strong>${s.accuracy}%</strong></div>
            <div class="stat-box"><span>오답 노트</span><strong>${s.wrongCount}</strong></div>
          </div>
          <div class="data-actions">
            <button id="exportBtn" class="secondary-btn" type="button">기록 백업</button>
            <label class="ghost-btn" for="importFile" role="button">기록 복원</label>
            <input id="importFile" class="file-input" type="file" accept="application/json,.json">
            <button id="resetBtn" class="danger-btn" type="button">기록 초기화</button>
          </div>
        </div>

        <div class="card wrong-note-card">
          <div class="page-title-row wrong-note-head">
            <div>
              <h2>오답 암기 노트</h2>
              <p>${wrongEntries.length}개 · 개인 풀이 기록 기준으로 정렬해 복습하세요.</p>
            </div>
            <div class="wrong-note-actions">
              <label for="wrongSortMode">오답 정렬</label>
              <select id="wrongSortMode">
                ${renderSortOptions(state.wrongOrder)}
              </select>
              <button id="statsReviewBtn" class="primary-btn" type="button" ${wrongEntries.length ? '' : 'disabled'}>재시험</button>
            </div>
          </div>
          ${wrongEntries.length ? `
            <div class="mistake-list">
              ${wrongEntries.slice(0, 200).map(({ item, info }) => `
                <div class="mistake-row">
                  <div class="mistake-word">${escapeHtml(item.word)}<small>DAY ${String(item.day).padStart(2,'0')} · 개인 오답률 ${Math.round(personalWrongRate(item) || 0)}% · 누적 ${info.count || 1}회</small></div>
                  <div class="mistake-meaning">${escapeHtml(item.meaning)}<div class="user-wrong">최근 답: ${escapeHtml(info.lastAnswer || '(빈 답)')}</div></div>
                </div>
              `).join('')}
            </div>
          ` : '<div class="empty-state">아직 오답이 없습니다.</div>'}
        </div>
      </section>
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
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1900);
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
