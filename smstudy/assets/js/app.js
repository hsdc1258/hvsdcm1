(() => {
  'use strict';

  const STORAGE_KEY = 'samun2027.study.v1';
  const EXPECTED_QUESTION_COUNT = 78;
  const EXPECTED_SUBUNIT_COUNT = 13;
  const app = document.getElementById('app');
  const toast = document.getElementById('toast');
  const studyUtils = window.HvsStudyUtils;
  const {
    CHOICE_MARKS,
    QUESTIONS,
    UNITS
  } = window.SMSTUDY_DATA || {};
  const {
    LEARNING_DESIGN,
    NOTEBOOKS
  } = window.SMSTUDY_NOTEBOOK || {};

  // data.js가 먼저 로드되어야 한다. 불완전한 배포는 사용자에게 오류 화면으로 알린다.
  if (!studyUtils || !Array.isArray(CHOICE_MARKS) || !Array.isArray(QUESTIONS) || !Array.isArray(UNITS) || !LEARNING_DESIGN || !NOTEBOOKS) {
    app.innerHTML = '<div class="card"><h2>데이터 로드 오류</h2><p>사회·문화 학습 데이터를 불러오지 못했습니다.</p></div>';
    return;
  }

  const { SORT_MODES, escapeHtml: esc, sortStudyItems } = studyUtils;

  const SUBUNITS = UNITS.flatMap(unit => unit.subs.map(sub => ({
    ...sub,
    unitId: unit.id,
    unitTitle: unit.title
  })));
  const UNIT_BY_ID = new Map(UNITS.map(unit => [unit.id, unit]));
  const SUB_BY_ID = new Map(SUBUNITS.map(x => [x.id, x]));
  const Q_BY_ID = new Map(QUESTIONS.map(x => [x.id, x]));
  const QUESTION_ORDER = new Map(QUESTIONS.map((question, index) => [question.id, index]));
  const MISTAKE_REASONS = {
    concept: '개념을 혼동함',
    choice: '선지 비교를 놓침',
    data: '자료·도표 해석 실수',
    calculation: '계산·비율 실수',
    time: '시간 부족·성급한 판단'
  };
  const blankDb = () => ({
    version: 1,
    attempts: 0,
    correct: 0,
    sessions: 0,
    completed: {},
    qStats: {},
    wrongBank: {},
    customAliases: {}
  });
  function loadDb() {
    try {
      const v = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return v && typeof v === 'object' ? {
        ...blankDb(),
        ...v,
        completed: v.completed || {},
        qStats: v.qStats || {},
        wrongBank: v.wrongBank || {},
        customAliases: v.customAliases || {}
      } : blankDb();
    } catch {
      return blankDb();
    }
  }
  let db = loadDb();
  db.wrongBank = Object.fromEntries(Object.entries(db.wrongBank).filter(([id]) => Q_BY_ID.has(id)));
  db.customAliases = Object.fromEntries(Object.entries(db.customAliases).filter(([id]) => Q_BY_ID.has(id)));
  function saveDb() {
    const serialized = JSON.stringify(db);
    localStorage.setItem(STORAGE_KEY, serialized);
    window.HvsAccount?.scheduleProgressSync(serialized);
  }
  const state = {
    view: 'home',
    selected: new Set(),
    count: '20',
    order: 'random',
    wrongOrder: 'recent',
    session: null,
    concept: null
  };
  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1900);
  }
  function compareQuestions(left, right) {
    return QUESTION_ORDER.get(left.id) - QUESTION_ORDER.get(right.id);
  }

  function recentAttemptAt(question) {
    return db.qStats[question.id]?.lastAt || null;
  }

  function sortQuestions(questions, order) {
    return sortStudyItems(questions, order, {
      wrongRate: (question) => question.wrongRate,
      recentAt: recentAttemptAt,
      compareDefault: compareQuestions,
    });
  }

  function renderSortOptions(selected, sequentialLabel = '교재 순서') {
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
  function stats() {
    const accuracy = db.attempts ? Math.round(db.correct / db.attempts * 100) : 0;
    return {
      accuracy,
      wrong: Object.keys(db.wrongBank).length,
      done: Object.keys(db.completed).length
    };
  }
  function subStats(id) {
    const ids = QUESTIONS.filter(q => q.sub === id).map(q => q.id);
    let a = 0,
      c = 0;
    ids.forEach(qid => {
      const x = db.qStats[qid];
      if (x) {
        a += x.attempts || 0;
        c += x.correct || 0;
      }
    });
    return {
      attempts: a,
      accuracy: a ? Math.round(c / a * 100) : 0
    };
  }
  function aggregateQuestions(questions) {
    let attempts = 0,
      correct = 0,
      wrong = 0;
    for (const question of questions) {
      const row = db.qStats[question.id];
      if (!row) continue;
      attempts += row.attempts || 0;
      correct += row.correct || 0;
      wrong += row.wrong || 0;
    }
    return {
      attempts,
      correct,
      wrong,
      accuracy: attempts ? Math.round(correct / attempts * 100) : null
    };
  }
  function weaknessAnalysis() {
    const subRows = SUBUNITS.map(sub => ({
      id: sub.id,
      title: sub.title,
      unitId: sub.unitId,
      ...aggregateQuestions(QUESTIONS.filter(q => q.sub === sub.id))
    }));
    const unitRows = UNITS.map(unit => ({
      id: unit.id,
      title: unit.title,
      ...aggregateQuestions(QUESTIONS.filter(q => q.sub.startsWith(`${unit.id}-`)))
    }));
    const attemptedSubs = subRows.filter(row => row.attempts).sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts);
    const attemptedUnits = unitRows.filter(row => row.attempts).sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts);
    const reasonCounts = Object.values(db.wrongBank).reduce((counts, row) => {
      const reason = row.reason || 'unclassified';
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {});
    const dominantReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0];
    return {
      subRows,
      unitRows,
      weakestSub: attemptedSubs[0] || null,
      weakestUnit: attemptedUnits[0] || null,
      dominantReason: dominantReason ? {
        key: dominantReason[0],
        count: dominantReason[1],
        label: dominantReason[0] === 'unclassified' ? '원인 미분류' : MISTAKE_REASONS[dominantReason[0]]
      } : null
    };
  }
  function masteryLabel(row) {
    if (!row.attempts) return '미응시';
    if (row.attempts < 3) return '표본 부족';
    if (row.accuracy < 60) return '집중 보완';
    if (row.accuracy < 80) return '추가 복습';
    return '안정';
  }
  function shownAnswer(q, input) {
    const i = Number(input);
    return Number.isInteger(i) && CHOICE_MARKS[i] ? CHOICE_MARKS[i] : '(선택 없음)';
  }
  function check(q, input) {
    const ok = Number(input) === q.correct;
    return {
      correct: ok,
      partial: false,
      hits: ok ? 1 : 0,
      total: 1
    };
  }
  function record(q, input, judged) {
    db.attempts++;
    if (judged.correct) db.correct++;
    const s = db.qStats[q.id] || {
      attempts: 0,
      correct: 0,
      wrong: 0
    };
    s.attempts++;
    s.lastAt = Date.now();
    if (judged.correct) {
      s.correct++;
      delete db.wrongBank[q.id];
    } else {
      s.wrong++;
      const previous = db.wrongBank[q.id] || {};
      db.wrongBank[q.id] = {
        count: (previous.count || 0) + 1,
        lastAnswer: shownAnswer(q, input),
        lastInput: Number(input),
        lastWrongAt: Date.now(),
        sub: q.sub,
        reason: previous.reason || ''
      };
    }
    db.qStats[q.id] = s;
    saveDb();
  }
  function renderOverview(summary) {
    return `
      <div class="overview">
        <div class="stat"><span>개념 완료</span><strong>${summary.done}/${SUBUNITS.length}</strong></div>
        <div class="stat"><span>누적 정답률</span><strong>${summary.accuracy}%</strong></div>
        <div class="stat"><span>오답 노트</span><strong>${summary.wrong}</strong></div>
      </div>`;
  }

  function renderStartPanel(summary) {
    return `
      <div class="card start-panel">
        <h2>학습 시작</h2>
        <p class="muted">대단원 전체 또는 원하는 중단원만 골라 출제합니다.</p>
        ${renderOverview(summary)}
        <div class="setup-row">
          <div>
            <label for="qCount">문제 수</label>
            <select id="qCount">
              <option value="10" ${state.count === '10' ? 'selected' : ''}>10문제</option>
              <option value="20" ${state.count === '20' ? 'selected' : ''}>20문제</option>
              <option value="40" ${state.count === '40' ? 'selected' : ''}>40문제</option>
              <option value="all" ${state.count === 'all' ? 'selected' : ''}>선택 범위 전체</option>
            </select>
          </div>
          <div>
            <label for="qOrder">출제 순서</label>
            <select id="qOrder">${renderSortOptions(state.order)}</select>
          </div>
        </div>
        <p class="sort-note">오답률은 통사랑 집계, 최근 순은 내 풀이 기록을 기준으로 합니다.</p>
        <button id="startSelected" class="primary full" ${state.selected.size ? '' : 'disabled'}>
          선택 범위 퀴즈 (${state.selected.size}개 중단원)
        </button>
        <div class="button-row selection-actions">
          <button id="selectAll" class="ghost">전체 선택</button>
          <button id="clearAll" class="ghost">선택 해제</button>
        </div>
        <div class="review-card">
          <h3>고오답률 기출</h3>
          <p>통사랑 집계 오답률 35% 이상인 평가원 실기출만 모아 풉니다.</p>
          <button id="weakQuiz" class="secondary full">고오답률 기출 풀기</button>
        </div>
        <div class="review-card">
          <h3>오답 복습</h3>
          <p>문제·내 답·정답을 먼저 보며 외우거나 다시 시험칠 수 있습니다.</p>
          <div class="button-row">
            <button id="wrongStudy" class="ghost" ${summary.wrong ? '' : 'disabled'}>오답 보고 외우기</button>
            <button id="wrongQuiz" class="secondary" ${summary.wrong ? '' : 'disabled'}>오답 ${summary.wrong}문제 재시험</button>
          </div>
        </div>
        <div class="review-card">
          <h3>누적 복습</h3>
          <p>개념 완료한 중단원 전체에서 20문제를 다시 꺼냅니다.</p>
          <button id="cumulative" class="secondary full" ${summary.done ? '' : 'disabled'}>완료 범위 누적 복습</button>
        </div>
      </div>`;
  }

  function renderHome() {
    state.view = 'home';
    state.session = null;
    app.innerHTML = `
      <section class="hero">
        <p class="eyebrow">READ → SOLVE → RETEST</p>
        <h1>만든 문제가 아니라,<br>평가원 원문으로.</h1>
        <p>2022~2026학년도 평가원 6월·9월 모의평가와 수능을 분석해 1~4단원, 13개 중단원별 실기출 78문항을 배치했습니다. 모든 문항은 평가원 원문 이미지와 정답표를 대조했고, 주관식 없이 5지선다로만 풉니다.</p>
        <p class="copyright-note">문항 저작권: 한국교육과정평가원 · 비상업적 개인 학습용 발췌 · 오답률: 통사랑 문항별 정답률 데이터 기준</p>
      </section>
      <section class="grid two">
        <div class="unit-list">${UNITS.map(renderUnit).join('')}</div>
        <aside>${renderStartPanel(stats())}</aside>
      </section>`;
    bindHome();
  }

  function renderSubunit(sub) {
    const progress = subStats(sub.id);
    const completionLabel = db.completed[sub.id] ? '개념 완료' : '미완료';
    return `
      <div class="subunit-row">
        <label class="check-target">
          <input class="check sub-check" type="checkbox" data-id="${sub.id}"
            aria-label="${esc(sub.title)} 중단원 선택" ${state.selected.has(sub.id) ? 'checked' : ''}>
        </label>
        <div class="subunit-copy">
          <strong>${sub.id} · ${esc(sub.title)}</strong>
          <small>${esc(sub.keywords)}${progress.attempts ? ` · 정답률 ${progress.accuracy}%` : ''}</small>
        </div>
        <div class="sub-actions">
          <span class="done-dot ${db.completed[sub.id] ? 'on' : ''}" title="${completionLabel}"></span>
          <button class="ghost compact study-btn" data-id="${sub.id}">개념 학습</button>
        </div>
      </div>`;
  }

  function renderUnit(unit) {
    const completedCount = unit.subs.filter((sub) => db.completed[sub.id]).length;
    const selectedCount = unit.subs.filter((sub) => state.selected.has(sub.id)).length;
    const allSelected = selectedCount === unit.subs.length;
    return `
      <article class="unit-card">
        <div class="unit-head">
          <div class="unit-heading">
            <label class="unit-selector">
              <input class="check unit-check" type="checkbox" data-unit="${unit.id}"
                aria-label="${esc(unit.title)} 전체 선택" ${allSelected ? 'checked' : ''}>
              <span class="unit-index">${unit.id}단원</span>
            </label>
            <h3>${esc(unit.title)}</h3>
            <p>${esc(unit.desc)}</p>
          </div>
          <div class="unit-tools">
            <button class="ghost compact unit-toggle" data-unit="${unit.id}">
              ${allSelected ? '범위 해제' : '대단원 전체 선택'}
            </button>
            <div class="unit-progress">
              <strong>${selectedCount}/${unit.subs.length}</strong>
              <small>범위 선택 · 개념 완료 ${completedCount}/${unit.subs.length}</small>
            </div>
          </div>
        </div>
        <div class="subunit-list">${unit.subs.map(renderSubunit).join('')}</div>
      </article>`;
  }
  function bindHome() {
    const setUnitSelection = (unitId, selected) => {
      const unit = UNIT_BY_ID.get(unitId);
      if (!unit) return;
      for (const sub of unit.subs) selected ? state.selected.add(sub.id) : state.selected.delete(sub.id);
      renderHome();
    };
    document.querySelectorAll('.unit-check').forEach(el => {
      const unit = UNIT_BY_ID.get(el.dataset.unit);
      const selectedCount = unit?.subs.filter(sub => state.selected.has(sub.id)).length || 0;
      el.indeterminate = selectedCount > 0 && selectedCount < (unit?.subs.length || 0);
      el.addEventListener('change', () => setUnitSelection(el.dataset.unit, el.checked));
    });
    document.querySelectorAll('.unit-toggle').forEach(el => el.addEventListener('click', () => {
      const unit = UNIT_BY_ID.get(el.dataset.unit);
      const allSelected = unit?.subs.every(sub => state.selected.has(sub.id));
      setUnitSelection(el.dataset.unit, !allSelected);
    }));
    document.querySelectorAll('.sub-check').forEach(el => el.addEventListener('change', () => {
      el.checked ? state.selected.add(el.dataset.id) : state.selected.delete(el.dataset.id);
      renderHome();
    }));
    document.querySelectorAll('.study-btn').forEach(el => el.addEventListener('click', () => renderConcept(el.dataset.id)));
    document.getElementById('qCount').addEventListener('change', e => state.count = e.target.value);
    document.getElementById('qOrder').addEventListener('change', e => state.order = e.target.value);
    document.getElementById('startSelected').addEventListener('click', () => startQuiz(QUESTIONS.filter(q => state.selected.has(q.sub)), '선택 범위'));
    document.getElementById('selectAll').addEventListener('click', () => {
      state.selected = new Set(SUBUNITS.map(x => x.id));
      renderHome();
    });
    document.getElementById('clearAll').addEventListener('click', () => {
      state.selected.clear();
      renderHome();
    });
    document.getElementById('weakQuiz').addEventListener('click', () => startQuiz(QUESTIONS.filter(q => q.weak), '취약 개념'));
    document.getElementById('wrongStudy').addEventListener('click', renderStats);
    document.getElementById('wrongQuiz').addEventListener('click', () => startQuiz(Object.keys(db.wrongBank).map(id => Q_BY_ID.get(id)).filter(Boolean), '오답 재시험', 'all'));
    document.getElementById('cumulative').addEventListener('click', () => startQuiz(QUESTIONS.filter(q => db.completed[q.sub]), '누적 복습', '20'));
  }
  function renderConceptMap(sub) {
    const visual = sub.visual;
    if (!visual) return '';
    const flow = visual.flow.map((step, index) => `
      <div class="concept-flow-step"><span>${index + 1}</span><strong>${esc(step)}</strong></div>
      ${index < visual.flow.length - 1 ? '<span class="concept-arrow" aria-hidden="true">→</span>' : ''}
    `).join('');
    const checks = visual.checks.map((check, index) => `
      <div><span>CHECK ${index + 1}</span><p>${esc(check)}</p></div>
    `).join('');
    return `
      <article class="concept-visual">
        <div class="concept-visual-copy">
          <span class="badge green">개념 구조도</span>
          <h3>${esc(visual.question)}</h3>
          <p>글을 외우기 전에 아래 흐름과 판별 기준을 먼저 잡으세요.</p>
        </div>
        <div class="concept-flow">${flow}</div>
        <div class="concept-checks">${checks}</div>
      </article>`;
  }

  function renderConceptNavigation(id, index) {
    const jumps = SUBUNITS.map((subunit) => `
      <button class="ghost compact jump-concept" data-id="${subunit.id}" ${subunit.id === id ? 'disabled' : ''}>
        ${subunit.id}
      </button>
    `).join('');
    return `
      <nav class="concept-nav" aria-label="중단원 이동">
        <button id="prevConcept" class="ghost compact" ${index === 0 ? 'disabled' : ''}>← 이전</button>
        ${jumps}
        <button id="nextConcept" class="ghost compact" ${index === SUBUNITS.length - 1 ? 'disabled' : ''}>다음 →</button>
      </nav>`;
  }

  function renderConceptSection(section, index) {
    return `
      <article class="card concept-section">
        <span class="badge green">개념 ${index + 1}</span>
        <h3>${esc(section.title)}</h3>
        <ul>${section.points.map((point) => `<li>${esc(point)}</li>`).join('')}</ul>
        <div class="trap"><strong>함정 체크</strong><br>${esc(section.trap)}</div>
      </article>`;
  }

  function renderNotebookMenu() {
    return `
      <nav class="notebook-menu" aria-label="단권화 노트 목차">
        <span>이 노트의 순서</span>
        <a href="#exam-analysis">기출 분석</a>
        <a href="#concept-compare">비교표</a>
        <a href="#concept-flow">판별 순서</a>
        <a href="#concept-detail">개념 상세</a>
        <a href="#recall-lab">회상 점검</a>
      </nav>`;
  }

  function renderNotebookHero(note) {
    return `
      <article class="notebook-hero">
        <div>
          <span class="badge green">단권화 한 줄</span>
          <h3>${esc(note.oneLine)}</h3>
        </div>
        <p><strong>암기 코드</strong>${esc(note.memoryCode)}</p>
      </article>`;
  }

  function renderExamAnalysis(id, note) {
    const questions = QUESTIONS.filter((question) => question.sub === id);
    const averageWrongRate = Math.round(questions.reduce((sum, question) => sum + question.wrongRate, 0) / questions.length);
    const hardest = questions.reduce((current, question) => question.wrongRate > current.wrongRate ? question : current);
    const highWrongCount = questions.filter((question) => question.wrongRate >= 35).length;
    const patterns = note.patterns.map((pattern) => `
      <li>
        <div class="frequency-label"><strong>${esc(pattern.label)}</strong><span>${pattern.count}/6</span></div>
        <div class="frequency-track" role="img" aria-label="수록 6문항 중 ${pattern.count}문항에 등장">
          <span style="--frequency:${pattern.count / 6 * 100}%"></span>
        </div>
        <p>${esc(pattern.note)}</p>
      </li>`).join('');
    return `
      <section id="exam-analysis" class="notebook-section exam-analysis" aria-labelledby="exam-analysis-title">
        <div class="notebook-heading">
          <div>
            <p class="eyebrow">사이트 수록 기출 6문항 분석</p>
            <h3 id="exam-analysis-title">무엇이 반복 출제됐나</h3>
          </div>
          <span class="analysis-scope">대표 문항 표본 · 전수 기출 통계 아님</span>
        </div>
        <div class="exam-stat-grid">
          <div><small>평균 오답률</small><strong>${averageWrongRate}%</strong><span>${averageWrongRate >= 35 ? '고난도 단원' : averageWrongRate >= 25 ? '주의 단원' : '확보할 단원'}</span></div>
          <div><small>고오답 문항</small><strong>${highWrongCount}<em>/6</em></strong><span>오답률 35% 이상</span></div>
          <div><small>최고 오답률</small><strong>${hardest.wrongRate}%</strong><span>${hardest.year}학년도 ${hardest.session} ${hardest.number}번</span></div>
        </div>
        <p class="exam-insight">${esc(note.examInsight)}</p>
        <ol class="frequency-list">${patterns}</ol>
      </section>`;
  }

  function renderComparisonMatrix(note) {
    const headerCells = note.matrix.headers.map((header) => `<th scope="col">${esc(header)}</th>`).join('');
    const bodyRows = note.matrix.rows.map((row) => `<tr>${row.map((cell, index) => index === 0 ? `<th scope="row">${esc(cell)}</th>` : `<td>${esc(cell)}</td>`).join('')}</tr>`).join('');
    return `
      <section id="concept-compare" class="notebook-section comparison-section" aria-labelledby="comparison-title">
        <div class="notebook-heading">
          <div><p class="eyebrow">헷갈리는 개념은 같은 기준으로</p><h3 id="comparison-title">${esc(note.matrix.title)}</h3></div>
          <span class="swipe-hint">좌우로 밀어 전체 보기 →</span>
        </div>
        <div class="comparison-scroll" tabindex="0">
          <table class="comparison-table">
            <thead><tr>${headerCells}</tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
      </section>`;
  }

  function renderDecisionFlow(note) {
    return `
      <section id="concept-flow" class="notebook-section decision-section" aria-labelledby="decision-title">
        <div class="notebook-heading"><div><p class="eyebrow">시험장에서 이 순서대로</p><h3 id="decision-title">판별 알고리즘</h3></div></div>
        <ol class="decision-list">${note.decision.map((step, index) => `<li><span>${index + 1}</span><p>${esc(step)}</p></li>`).join('')}</ol>
      </section>`;
  }

  function renderDeepDive(note) {
    return `
      <section class="notebook-section deep-dive" aria-labelledby="deep-dive-title">
        <div class="notebook-heading"><div><p class="eyebrow">선지 판단에 필요한 세부 내용</p><h3 id="deep-dive-title">심화 메모</h3></div></div>
        <div class="deep-dive-grid">${note.deepDive.map((item) => `<article><h4>${esc(item.term)}</h4><p>${esc(item.body)}</p></article>`).join('')}</div>
      </section>`;
  }

  function renderRecallLab(note) {
    const recallItems = note.recall.map((item, index) => `
      <details class="recall-item">
        <summary><span>Q${index + 1}</span>${esc(item.question)}</summary>
        <div><strong>정답</strong><p>${esc(item.answer)}</p></div>
      </details>`).join('');
    return `
      <section id="recall-lab" class="notebook-section recall-lab" aria-labelledby="recall-title">
        <div class="notebook-heading">
          <div><p class="eyebrow">답을 말한 뒤 펼치기</p><h3 id="recall-title">덮고 답하는 회상 점검</h3></div>
          <span class="recall-rule">생각하기 → 말하기 → 확인하기</span>
        </div>
        <div class="recall-grid">${recallItems}</div>
        <div class="review-schedule" aria-label="권장 복습 간격">
          <strong>복습 간격</strong>
          <span>오늘 · 첫 회상</span><i aria-hidden="true">→</i><span>+1일</span><i aria-hidden="true">→</i><span>+3일</span><i aria-hidden="true">→</i><span>+7일</span>
        </div>
      </section>`;
  }

  function renderLearningDesign() {
    return `
      <details class="learning-design">
        <summary><span class="badge blue">학습과학 기반</span><strong>${esc(LEARNING_DESIGN.title)}</strong><span>설계 근거 보기</span></summary>
        <div class="learning-design-body">
          <p>${esc(LEARNING_DESIGN.summary)}</p>
          <div class="learning-steps">${LEARNING_DESIGN.steps.map((step) => `<div><strong>${esc(step.label)}</strong><p>${esc(step.text)}</p></div>`).join('')}</div>
          <div class="evidence-links">${LEARNING_DESIGN.evidence.map((item) => `<a href="${item.href}" target="_blank" rel="noopener noreferrer"><strong>${esc(item.label)}</strong><span>${esc(item.text)}</span></a>`).join('')}</div>
          <p class="evidence-caution">연구 결과는 학습 조건과 개인에 따라 달라질 수 있습니다. 이 노트는 다시 읽기만 하기보다 회상과 분산 복습을 쉽게 실행하도록 구성했습니다.</p>
        </div>
      </details>`;
  }

  function renderConcept(id) {
    const sub = SUB_BY_ID.get(id);
    if (!sub) return renderHome();
    const note = NOTEBOOKS[id];
    if (!note) return renderHome();
    state.view = 'concept';
    state.concept = id;
    const index = SUBUNITS.findIndex((subunit) => subunit.id === id);
    const questionCount = QUESTIONS.filter((question) => question.sub === id).length;
    app.innerHTML = `
      <section>
        <div class="page-head">
          <div>
            <p class="eyebrow">${sub.unitId}단원 · 약 ${sub.time}분</p>
            <h2>${esc(sub.title)}</h2>
            <p>${esc(sub.keywords)}</p>
          </div>
          <button id="conceptHome" class="ghost compact">단원 목록</button>
        </div>
        ${renderConceptNavigation(id, index)}
        ${renderNotebookMenu()}
        ${renderNotebookHero(note)}
        ${renderExamAnalysis(id, note)}
        ${renderComparisonMatrix(note)}
        ${renderDecisionFlow(note)}
        ${renderConceptMap(sub)}
        <section id="concept-detail" aria-labelledby="concept-detail-title">
          <div class="notebook-heading concept-detail-heading"><div><p class="eyebrow">교과 개념을 선지 언어로</p><h3 id="concept-detail-title">개념 상세</h3></div></div>
          <div class="concept-grid">${sub.sections.map(renderConceptSection).join('')}</div>
        </section>
        ${renderDeepDive(note)}
        ${renderRecallLab(note)}
        ${renderLearningDesign()}
        <div class="concept-finish">
          <button id="markDone" class="secondary">
            ${db.completed[id] ? '✓ 개념 확인 완료됨' : '개념 확인 완료로 표시'}
          </button>
          <button id="subQuiz" class="primary">이 중단원 퀴즈 ${questionCount}문제</button>
        </div>
        <p class="source-note">개념 검토: 2027 불후의 명강 사회·문화 개념 완성·정답과 바른 해설, 2027 EBS 수능특강·해설. 빈출 표시는 이 사이트에 선별 수록된 2022~2026학년도 평가원 6월·9월·수능 실기출 78문항(중단원별 6문항)을 분석한 결과이며 전체 기출 전수 빈도를 뜻하지 않습니다. 문항·정답은 원문 PDF와 정답표를 대조했으며 문항 저작권은 한국교육과정평가원에 있습니다.</p>
      </section>`;
    document.getElementById('conceptHome').addEventListener('click', renderHome);
    document.getElementById('prevConcept').addEventListener('click', () => renderConcept(SUBUNITS[index - 1]?.id));
    document.getElementById('nextConcept').addEventListener('click', () => renderConcept(SUBUNITS[index + 1]?.id));
    document.querySelectorAll('.jump-concept').forEach(b => b.addEventListener('click', () => renderConcept(b.dataset.id)));
    document.getElementById('markDone').addEventListener('click', () => {
      db.completed[id] = Date.now();
      saveDb();
      renderConcept(id);
      showToast('개념 완료를 저장했습니다.');
    });
    document.getElementById('subQuiz').addEventListener('click', () => startQuiz(QUESTIONS.filter(q => q.sub === id), `${id} 중단원`, 'all'));
  }
  function startQuiz(pool, label, countOverride, orderOverride = state.order) {
    if (!pool.length) return showToast('출제할 문제가 없습니다.');
    let qs = sortQuestions(pool, orderOverride);
    const count = countOverride || state.count;
    if (count !== 'all') qs = qs.slice(0, Math.min(Number(count), qs.length));
    state.session = {
      label,
      questions: qs,
      index: 0,
      answered: false,
      last: null,
      correct: 0,
      wrong: 0,
      results: [],
      startedAt: Date.now()
    };
    state.view = 'quiz';
    db.sessions++;
    saveDb();
    renderQuiz();
  }
  function submitAnswer(forcedInput) {
    const ss = state.session;
    if (!ss || ss.answered) return nextQuestion();
    const q = ss.questions[ss.index],
      input = forcedInput ?? document.getElementById('answerInput')?.value.trim() ?? '',
      judged = check(q, input);
    ss.answered = true;
    ss.last = {
      input,
      ...judged,
      overridden: false
    };
    if (judged.correct) ss.correct++;else ss.wrong++;
    ss.results.push({
      id: q.id,
      input,
      correct: judged.correct,
      overridden: false
    });
    record(q, input, judged);
    renderQuiz();
  }
  function nextQuestion() {
    const ss = state.session;
    if (!ss || !ss.answered) return;
    if (ss.index >= ss.questions.length - 1) {
      renderResult();
      return;
    }
    ss.index++;
    ss.answered = false;
    ss.last = null;
    renderQuiz();
  }
  function renderQuestionMedia(question, options = {}) {
    const { className = '', loading = 'eager' } = options;
    return `
      <figure class="question-media ${esc(className)}">
        <a class="kice-paper-link" href="${esc(question.source.question)}" target="_blank"
          rel="noopener" title="원문 PDF 열기">
          <img class="question-image" data-question-image src="${esc(question.image)}"
            alt="${esc(question.prompt)}의 제시문·보기·선지 전체 원문"
            loading="${loading}" decoding="async">
        </a>
        <figcaption>${question.year}학년도 ${esc(question.session)} ${question.number}번 · 제시문·보기·선지 전체를 원문 이미지로 제공합니다.</figcaption>
        <div class="question-image-fallback" hidden>
          <strong>문제 이미지를 불러오지 못했습니다.</strong>
          <p>배포 지연이나 네트워크 오류일 수 있습니다. 평가원 원문 PDF에서 ${question.number}번을 확인해 주세요.</p>
          <a class="ghost compact source-link" href="${esc(question.source.question)}" target="_blank" rel="noopener">원문 PDF 열기</a>
        </div>
      </figure>`;
  }
  function bindQuestionImages(root = document) {
    root.querySelectorAll('[data-question-image]').forEach(image => {
      const markFailed = () => {
        image.closest('.kice-paper-link')?.classList.add('image-failed');
        const fallback = image.closest('.question-media')?.querySelector('.question-image-fallback');
        if (fallback) fallback.hidden = false;
      };
      image.addEventListener('error', markFailed, { once: true });
      if (image.complete && image.naturalWidth === 0) markFailed();
    });
  }
  function renderAnswerChoices(question, session, current, total) {
    const choices = CHOICE_MARKS.map((mark, index) => {
      const selected = session.answered && Number(session.last.input) === index;
      const className = session.answered && index === question.correct
        ? 'correct-option'
        : selected ? 'wrong-option' : '';
      return `
        <button class="choice-option kice-choice ${className}" data-index="${index}"
          aria-label="${index + 1}번" ${session.answered ? 'disabled' : ''}>
          <span>${mark}</span>
        </button>`;
    }).join('');

    const nextAction = session.answered
      ? `<button id="submitAnswer" class="primary full choice-next">${current === total ? '결과 보기' : '다음 문제'}</button>`
      : '<div class="key-hint">번호를 누르면 바로 채점됩니다.</div>';
    return `
      <div class="answer-prompt">정답을 선택하세요.</div>
      <div class="kice-answer-grid">${choices}</div>
      ${nextAction}`;
  }

  function bindQuizEvents(question, session) {
    document.querySelectorAll('.choice-option').forEach((button) => {
      button.addEventListener('click', () => submitAnswer(button.dataset.index));
    });
    document.querySelectorAll('.reason-option').forEach((button) => {
      button.addEventListener('click', () => {
        const row = db.wrongBank[question.id];
        if (!row) return;
        row.reason = button.dataset.reason;
        saveDb();
        renderQuiz();
        showToast('오답 원인을 분석에 반영했습니다.');
      });
    });
    const submit = document.getElementById('submitAnswer');
    if (submit) submit.addEventListener('click', session.answered ? nextQuestion : () => submitAnswer());
    if (session.answered) requestAnimationFrame(() => submit?.focus());
  }

  function renderQuiz() {
    const session = state.session;
    if (!session) return renderHome();
    state.view = 'quiz';
    const question = session.questions[session.index];
    const subunit = SUB_BY_ID.get(question.sub);
    const current = session.index + 1;
    const total = session.questions.length;
    const sourceLabel = `${question.year}학년도 ${question.session} 기출 · 평가원`;
    app.innerHTML = `
      <section class="quiz-wrap">
        <div class="quiz-head">
          <div class="quiz-meta">
            <span>${esc(session.label)} · ${question.sub}</span>
            <span>${current}/${total} · 정답 ${session.correct}</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width:${Math.round((current / total) * 100)}%"></div>
          </div>
        </div>
        <article class="question-card">
          <div class="question-top">
            <span class="question-kicker">평가원 원문 · ${esc(subunit.title)}</span>
            <div class="source-meta">
              <span>${esc(sourceLabel)} · ${question.number}번</span>
              <strong>오답률 ${question.wrongRate}% <small>· 통사랑 집계</small></strong>
            </div>
          </div>
          ${renderQuestionMedia(question)}
          ${renderAnswerChoices(question, session, current, total)}
          ${session.answered ? renderFeedback(question, session.last) : ''}
        </article>
      </section>`;
    bindQuestionImages(app);
    bindQuizEvents(question, session);
  }
  function renderWrongDiagnosis(question, result) {
    const subunit = SUB_BY_ID.get(question.sub);
    const savedReason = db.wrongBank[question.id]?.reason || '';
    const reasonButtons = Object.entries(MISTAKE_REASONS).map(([key, label]) => `
      <button class="reason-option ${savedReason === key ? 'selected' : ''}"
        data-reason="${key}" type="button">${esc(label)}</button>
    `).join('');
    return `
      <div class="wrong-diagnosis">
        <strong>${esc(question.sub)} · ${esc(subunit.title)}에서 틀렸습니다.</strong>
        <p>내 답 ${esc(shownAnswer(question, result.input))}과 정답 ${esc(question.answer)}을 가른 표현을 원문 선지에서 찾은 뒤, 아래에서 실제 실수 원인을 남기세요. 번호가 아니라 판단 기준을 복습 기록에 저장합니다.</p>
        <div class="reason-options" role="group" aria-label="오답 원인 선택">${reasonButtons}</div>
      </div>`;
  }

  function renderFeedback(question, result) {
    const className = result.correct ? 'correct' : 'wrong';
    const title = result.correct ? '✓ 정답' : '✕ 오답';
    return `
      <div class="feedback ${className}">
        <div class="feedback-title">${title}</div>
        <div class="feedback-grid">
          <div class="feedback-item"><small>평가원 정답</small><strong>${esc(question.answer)}</strong></div>
          <div class="feedback-item"><small>내 답</small><strong>${esc(shownAnswer(question, result.input))}</strong></div>
        </div>
        <p class="explain">평가원 원문 정답표와 대조한 답입니다. 오답률 ${question.wrongRate}%는 통사랑 문항별 정답률 ${question.correctRate}%를 기준으로 계산했습니다.</p>
        ${result.correct ? '' : renderWrongDiagnosis(question, result)}
        <div class="feedback-actions">
          <a class="ghost compact source-link" href="${esc(question.source.question)}" target="_blank" rel="noopener">문제 원문 PDF</a>
          <a class="ghost compact source-link" href="${esc(question.source.answer)}" target="_blank" rel="noopener">정답표 확인</a>
          <a class="ghost compact source-link" href="https://tongsarang.kr/" target="_blank" rel="noopener">오답률 출처</a>
        </div>
      </div>`;
  }

  function renderMistakeCard(question, info = {}, input) {
    const subunit = SUB_BY_ID.get(question.sub);
    const selected = input === undefined || input === null
      ? info.lastAnswer || '(선택 없음)'
      : shownAnswer(question, input);
    const reason = MISTAKE_REASONS[info.reason] || '원인 미분류';
    const repeatCopy = (info.count || 1) >= 2
      ? '같은 문항을 반복해서 틀렸습니다. 정답 번호보다 선지를 가르는 개념 기준부터 다시 확인하세요.'
      : '첫 오답입니다. 내 답과 정답 선지의 표현 차이를 표시한 뒤 개념 지도로 돌아가세요.';
    return `
      <article class="mistake-card">
        <div class="mistake-card-head">
          <div>
            <span class="badge red">누적 오답 ${info.count || 1}회 · 출제 오답률 ${question.wrongRate}%</span>
            <h3>${question.sub} · ${esc(subunit.title)}</h3>
            <p>${question.year}학년도 ${esc(question.session)} ${question.number}번 · 평가원</p>
          </div>
          <span class="reason-badge">${esc(reason)}</span>
        </div>
        ${renderQuestionMedia(question, { className: 'review-question-media', loading: 'lazy' })}
        <div class="answer-comparison">
          <div><small>최근 내 답</small><strong class="answer-wrong">${esc(selected)}</strong></div>
          <span aria-hidden="true">→</span>
          <div><small>평가원 정답</small><strong class="answer-correct">${esc(question.answer)}</strong></div>
        </div>
        <div class="mistake-diagnosis">
          <strong>${esc(subunit.unitId)}단원 · ${esc(subunit.title)} 취약 신호</strong>
          <p>${esc(repeatCopy)}</p>
          <small>핵심 판별어: ${esc(subunit.keywords)}</small>
        </div>
        <div class="mistake-actions">
          <button class="ghost compact mistake-concept" data-sub="${question.sub}">개념 지도 다시 보기</button>
          <button class="secondary compact mistake-retry" data-id="${question.id}">이 문제 재시험</button>
          <a class="ghost compact source-link" href="${esc(question.source.answer)}" target="_blank" rel="noopener">정답표</a>
        </div>
      </article>`;
  }
  function bindMistakeActions() {
    bindQuestionImages(app);
    document.querySelectorAll('.mistake-concept').forEach(button => button.addEventListener('click', () => renderConcept(button.dataset.sub)));
    document.querySelectorAll('.mistake-retry').forEach(button => button.addEventListener('click', () => {
      const q = Q_BY_ID.get(button.dataset.id);
      if (q) startQuiz([q], '오답 1문제 재시험', 'all');
    }));
  }
  function renderResult() {
    const session = state.session;
    if (!session) return renderHome();
    state.view = 'result';
    const total = session.questions.length;
    const accuracy = Math.round((session.correct / total) * 100);
    const wrongResults = session.results.filter((result) => !result.correct);
    const mistakeCards = wrongResults.map((result) => {
      const question = Q_BY_ID.get(result.id);
      return renderMistakeCard(question, db.wrongBank[question.id], result.input);
    }).join('');
    app.innerHTML = `
      <section class="card result-card">
        <p class="eyebrow result-eyebrow">${esc(session.label)} 완료</p>
        <div class="result-score">${accuracy}%</div>
        <p class="result-copy">${total}문제 중 ${session.correct}개 정답 · 오답 ${session.wrong}개</p>
        <div class="button-row result-actions">
          <button id="resultHome" class="secondary">단원 목록</button>
          <button id="retryResult" class="primary" ${wrongResults.length ? '' : 'disabled'}>이번 오답 다시 풀기</button>
        </div>
        ${wrongResults.length ? `
          <div class="result-mistakes">
            <h3>이번 오답 ${wrongResults.length}문제</h3>
            <p>문제 원문과 선지 전체를 다시 보고, 내 답과 정답을 가른 기준을 확인하세요.</p>
            <div class="mistake-list">${mistakeCards}</div>
          </div>
        ` : '<div class="empty">완벽합니다. 이 범위의 오답은 모두 정리됐습니다.</div>'}
      </section>`;
    document.getElementById('resultHome').addEventListener('click', renderHome);
    document.getElementById('retryResult').addEventListener('click', () => {
      const retryQuestions = wrongResults.map((result) => Q_BY_ID.get(result.id)).filter(Boolean);
      startQuiz(retryQuestions, '이번 오답 재시험', 'all');
    });
    bindMistakeActions();
  }
  function renderAnalysisMeter(accuracy, label = '') {
    const value = accuracy ?? 0;
    return `
      <div class="analysis-meter" aria-label="${esc(label || `${value}%`)}">
        <span style="width:${value}%"></span>
      </div>`;
  }

  function renderWeaknessPanel(analysis) {
    const weakestUnit = analysis.weakestUnit
      ? `${analysis.weakestUnit.id} · ${analysis.weakestUnit.accuracy}%`
      : '풀이 기록 필요';
    const weakestSubunit = analysis.weakestSub
      ? `${analysis.weakestSub.id} · ${analysis.weakestSub.accuracy}%`
      : '풀이 기록 필요';
    const reasonSummary = analysis.dominantReason
      ? `${analysis.dominantReason.label} · ${analysis.dominantReason.count}문제`
      : '오답 원인 없음';
    const unitRows = analysis.unitRows.map((row) => `
      <div class="unit-analysis-row">
        <div>
          <strong>${row.id} · ${esc(row.title)}</strong>
          <small>${row.attempts ? `${row.attempts}회 풀이 · ${masteryLabel(row)}` : '아직 풀이 없음'}</small>
        </div>
        ${renderAnalysisMeter(row.accuracy)}
        <b>${row.accuracy === null ? '-' : `${row.accuracy}%`}</b>
      </div>
    `).join('');
    return `
      <article class="card weakness-panel">
        <div class="page-head">
          <div>
            <span class="badge green">무료 자동 분석</span>
            <h2>내 약점 한눈에</h2>
            <p>외부 AI나 유료 토큰 없이 실제 풀이·오답 기록만으로 계산합니다.</p>
          </div>
        </div>
        <div class="weakness-insights">
          <div><small>가장 취약한 대단원</small><strong>${esc(weakestUnit)}</strong></div>
          <div><small>가장 취약한 중단원</small><strong>${esc(weakestSubunit)}</strong></div>
          <div><small>가장 많은 실수 원인</small><strong>${esc(reasonSummary)}</strong></div>
        </div>
        <div class="unit-analysis">${unitRows}</div>
        <p class="analysis-note">3회 미만 기록은 ‘표본 부족’으로 표시합니다. 풀이가 쌓일수록 대단원·중단원 취약도와 실수 원인 분류가 정확해집니다.</p>
      </article>`;
  }

  function renderSubunitStats(analysis) {
    const rows = analysis.subRows.map((row) => `
      <div class="stats-row">
        <div>
          <span>${row.id} · ${esc(row.title)}</span>
          <small>${db.completed[row.id] ? '개념 완료' : '개념 미완료'} · ${masteryLabel(row)}</small>
        </div>
        ${renderAnalysisMeter(row.accuracy)}
        <b>${row.accuracy === null ? '-' : `${row.accuracy}%`}</b>
      </div>
    `).join('');
    return `
      <div class="card stats-section">
        <h2>중단원별 현황</h2>
        <div class="stats-table">${rows}</div>
      </div>`;
  }

  function getWrongEntries(order = state.wrongOrder) {
    const questions = Object.keys(db.wrongBank)
      .map((id) => Q_BY_ID.get(id))
      .filter(Boolean);
    return sortQuestions(questions, order)
      .map((question) => ({ question, info: db.wrongBank[question.id] }));
  }

  function renderWrongNote(wrongEntries) {
    const cards = wrongEntries.map(({ question, info }) => (
      renderMistakeCard(question, info, info.lastInput)
    )).join('');
    return `
      <div class="card wrong-note stats-section">
        <div class="page-head wrong-note-head">
          <div>
            <h2>오답 원문 분석 노트</h2>
            <p>${wrongEntries.length}문제 · 출제 오답률이나 내 최근 풀이 기록으로 정렬해 복습합니다.</p>
          </div>
          <div class="wrong-note-actions">
            <label for="wrongSortMode">오답 정렬</label>
            <select id="wrongSortMode">${renderSortOptions(state.wrongOrder)}</select>
            <button id="statsReview" class="primary compact" ${wrongEntries.length ? '' : 'disabled'}>전체 재시험</button>
          </div>
        </div>
        ${wrongEntries.length ? `<div class="mistake-list">${cards}</div>` : '<div class="empty">아직 오답이 없습니다.</div>'}
      </div>`;
  }

  function renderStats() {
    state.view = 'stats';
    state.session = null;
    const summary = stats();
    const analysis = weaknessAnalysis();
    const wrongEntries = getWrongEntries();
    app.innerHTML = `
      <section>
        <div class="page-head">
          <div>
            <p class="eyebrow">ACCOUNT STUDY DATA</p>
            <h2>학습 기록·취약도 분석</h2>
            <p>정답 번호가 아니라 문제 원문, 오답 원인, 대단원·중단원별 정확도를 함께 봅니다.</p>
          </div>
          <button id="statsHome" class="ghost compact">단원 목록</button>
        </div>
        <div class="card">
          <div class="overview">
            <div class="stat"><span>총 풀이</span><strong>${db.attempts}</strong></div>
            <div class="stat"><span>정답률</span><strong>${summary.accuracy}%</strong></div>
            <div class="stat"><span>현재 오답</span><strong>${summary.wrong}</strong></div>
          </div>
          <div class="button-row data-actions">
            <button id="exportData" class="secondary">기록 백업</button>
            <label class="ghost file-button" for="importData" role="button">기록 복원</label>
            <input id="importData" class="file-input" type="file" accept="application/json,.json">
            <button id="resetData" class="danger">기록 초기화</button>
          </div>
        </div>
        ${renderWeaknessPanel(analysis)}
        ${renderSubunitStats(analysis)}
        ${renderWrongNote(wrongEntries)}
      </section>`;
    document.getElementById('statsHome').addEventListener('click', renderHome);
    document.getElementById('wrongSortMode').addEventListener('change', (event) => {
      state.wrongOrder = event.target.value;
      renderStats();
    });
    document.getElementById('statsReview').addEventListener('click', () => {
      startQuiz(wrongEntries.map(({ question }) => question), '오답 재시험', 'all', state.wrongOrder);
    });
    document.getElementById('exportData').addEventListener('click', exportData);
    document.getElementById('importData').addEventListener('change', importData);
    document.getElementById('resetData').addEventListener('click', resetData);
    bindMistakeActions();
  }
  function exportData() {
    const blob = new Blob([JSON.stringify({
        app: 'samun2027-study',
        ...db
      }, null, 2)], {
        type: 'application/json;charset=utf-8'
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = `samun-2027-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('학습 기록을 백업했습니다.');
  }
  async function importData(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const p = JSON.parse(await file.text());
      if (p.app !== 'samun2027-study' || p.version !== 1) throw new Error();
      db = {
        ...blankDb(),
        ...p,
        completed: p.completed || {},
        qStats: p.qStats || {},
        wrongBank: p.wrongBank || {},
        customAliases: p.customAliases || {}
      };
      saveDb();
      renderStats();
      showToast('기록을 복원했습니다.');
    } catch {
      showToast('이 앱의 올바른 백업 파일이 아닙니다.');
    } finally {
      e.target.value = '';
    }
  }
  function resetData() {
    if (!confirm('사회·문화 개념 완료, 정답률과 오답 기록을 모두 삭제할까요?')) return;
    db = blankDb();
    saveDb();
    renderStats();
    showToast('사회·문화 학습 기록을 초기화했습니다.');
  }
  function goHome() {
    if (state.view === 'quiz' && state.session?.index > 0 && !confirm('진행 중인 퀴즈를 끝내고 단원 목록으로 갈까요?')) return;
    renderHome();
  }
  document.getElementById('homeLogo').addEventListener('click', goHome);
  document.getElementById('openStats').addEventListener('click', () => {
    if (state.view === 'quiz' && !confirm('진행 중인 퀴즈를 끝내고 기록을 볼까요?')) return;
    renderStats();
  });
  document.addEventListener('keydown', e => {
    if (/^[1-5]$/.test(e.key) && state.view === 'quiz' && !state.session?.answered) {
      e.preventDefault();
      submitAnswer(Number(e.key) - 1);
      return;
    }
    if (e.key === 'Enter' && state.view === 'quiz' && state.session?.answered) {
      if (document.activeElement?.tagName === 'BUTTON') return;
      e.preventDefault();
      nextQuestion();
    }
  });
  if (SUBUNITS.length !== EXPECTED_SUBUNIT_COUNT || QUESTIONS.length !== EXPECTED_QUESTION_COUNT) {
    app.innerHTML = `<div class="card"><h2>데이터 검증 오류</h2><p>소단원 ${SUBUNITS.length}개, 문제 ${QUESTIONS.length}개가 로드되었습니다.</p></div>`;
  } else renderHome();
})();
