(() => {
  'use strict';

  const STORAGE_KEY = 'samun2027.study.v1';
  const EXPECTED_QUESTION_COUNT = 78;
  const EXPECTED_SUBUNIT_COUNT = 13;
  const app = document.getElementById('app');
  const toast = document.getElementById('toast');
  const {
    CHOICE_MARKS,
    QUESTIONS,
    UNITS
  } = window.SMSTUDY_DATA || {};

  // data.js가 먼저 로드되어야 한다. 불완전한 배포는 사용자에게 오류 화면으로 알린다.
  if (!Array.isArray(CHOICE_MARKS) || !Array.isArray(QUESTIONS) || !Array.isArray(UNITS)) {
    app.innerHTML = '<div class="card"><h2>데이터 로드 오류</h2><p>사회·문화 학습 데이터를 불러오지 못했습니다.</p></div>';
    return;
  }

  const SUBUNITS = UNITS.flatMap(unit => unit.subs.map(sub => ({
    ...sub,
    unitId: unit.id,
    unitTitle: unit.title
  })));
  const UNIT_BY_ID = new Map(UNITS.map(unit => [unit.id, unit]));
  const SUB_BY_ID = new Map(SUBUNITS.map(x => [x.id, x]));
  const Q_BY_ID = new Map(QUESTIONS.map(x => [x.id, x]));
  const MISTAKE_REASONS = {
    concept: '개념을 혼동함',
    choice: '선지 비교를 놓침',
    data: '자료·도표 해석 실수',
    calculation: '계산·비율 실수',
    time: '시간 부족·성급한 판단'
  };
  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[c]);
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
  const saveDb = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  const state = {
    view: 'home',
    selected: new Set(),
    count: '20',
    order: 'random',
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
  function shuffle(a) {
    const x = [...a];
    for (let i = x.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [x[i], x[j]] = [x[j], x[i]];
    }
    return x;
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
  function renderHome() {
    state.view = 'home';
    state.session = null;
    const s = stats();
    app.innerHTML = `
      <section class="hero"><p class="eyebrow">READ → SOLVE → RETEST</p><h1>만든 문제가 아니라,<br>평가원 원문으로.</h1><p>2022~2026학년도 평가원 6월·9월 모의평가와 수능을 분석해 1~4단원, 13개 중단원별 실기출 78문항을 배치했습니다. 모든 문항은 평가원 원문 이미지와 정답표를 대조했고, 주관식 없이 5지선다로만 풉니다.</p><p class="copyright-note">문항 저작권: 한국교육과정평가원 · 비상업적 개인 학습용 발췌 · 오답률: 통사랑 문항별 정답률 데이터 기준</p></section>
      <section class="grid two"><div>
        <div class="unit-list">${UNITS.map(renderUnit).join('')}</div>
      </div><aside>
        <div class="card"><h2>학습 시작</h2><p class="muted">대단원 전체 또는 원하는 중단원만 골라 출제합니다.</p>
          <div class="overview"><div class="stat"><span>개념 완료</span><strong>${s.done}/${SUBUNITS.length}</strong></div><div class="stat"><span>누적 정답률</span><strong>${s.accuracy}%</strong></div><div class="stat"><span>오답 노트</span><strong>${s.wrong}</strong></div></div>
          <div class="setup-row"><div><label for="qCount">문제 수</label><select id="qCount"><option value="10" ${state.count === '10' ? 'selected' : ''}>10문제</option><option value="20" ${state.count === '20' ? 'selected' : ''}>20문제</option><option value="40" ${state.count === '40' ? 'selected' : ''}>40문제</option><option value="all" ${state.count === 'all' ? 'selected' : ''}>선택 범위 전체</option></select></div><div><label for="qOrder">출제 순서</label><select id="qOrder"><option value="random" ${state.order === 'random' ? 'selected' : ''}>랜덤</option><option value="sequential" ${state.order === 'sequential' ? 'selected' : ''}>교재 순서</option></select></div></div>
          <button id="startSelected" class="primary full" ${state.selected.size ? '' : 'disabled'}>선택 범위 퀴즈 (${state.selected.size}개 중단원)</button>
          <div class="button-row" style="margin-top:9px"><button id="selectAll" class="ghost">전체 선택</button><button id="clearAll" class="ghost">선택 해제</button></div>
          <div class="review-card"><h3>고오답률 기출</h3><p>통사랑 집계 오답률 35% 이상인 평가원 실기출만 모아 풉니다.</p><button id="weakQuiz" class="secondary full">고오답률 기출 풀기</button></div>
          <div class="review-card"><h3>오답 복습</h3><p>문제·내 답·정답을 먼저 보며 외우거나 다시 시험칠 수 있습니다.</p><div class="button-row"><button id="wrongStudy" class="ghost" ${s.wrong ? '' : 'disabled'}>오답 보고 외우기</button><button id="wrongQuiz" class="secondary" ${s.wrong ? '' : 'disabled'}>오답 ${s.wrong}문제 재시험</button></div></div>
          <div class="review-card"><h3>누적 복습</h3><p>개념 완료한 중단원 전체에서 20문제를 다시 꺼냅니다.</p><button id="cumulative" class="secondary full" ${s.done ? '' : 'disabled'}>완료 범위 누적 복습</button></div>
        </div>
      </aside></section>`;
    bindHome();
  }
  function renderUnit(unit) {
    const done = unit.subs.filter(x => db.completed[x.id]).length;
    const selectedCount = unit.subs.filter(x => state.selected.has(x.id)).length;
    const allSelected = selectedCount === unit.subs.length;
    return `<article class="unit-card"><div class="unit-head"><div class="unit-heading"><label class="unit-selector"><input class="check unit-check" type="checkbox" data-unit="${unit.id}" aria-label="${esc(unit.title)} 전체 선택" ${allSelected ? 'checked' : ''}><span class="unit-index">${unit.id}단원</span></label><h3>${esc(unit.title)}</h3><p>${esc(unit.desc)}</p></div><div class="unit-tools"><button class="ghost compact unit-toggle" data-unit="${unit.id}">${allSelected ? '범위 해제' : '대단원 전체 선택'}</button><div class="unit-progress"><strong>${selectedCount}/${unit.subs.length}</strong><small>범위 선택 · 개념 완료 ${done}/${unit.subs.length}</small></div></div></div><div class="subunit-list">${unit.subs.map(sub => {
      const st = subStats(sub.id);
      return `<div class="subunit-row"><input class="check sub-check" type="checkbox" data-id="${sub.id}" aria-label="${esc(sub.title)} 중단원 선택" ${state.selected.has(sub.id) ? 'checked' : ''}><div class="subunit-copy"><strong>${sub.id} · ${esc(sub.title)}</strong><small>${esc(sub.keywords)}${st.attempts ? ` · 정답률 ${st.accuracy}%` : ''}</small></div><div class="sub-actions"><span class="done-dot ${db.completed[sub.id] ? 'on' : ''}" title="${db.completed[sub.id] ? '개념 완료' : '미완료'}"></span><button class="ghost compact study-btn" data-id="${sub.id}">개념 학습</button></div></div>`;
    }).join('')}</div></article>`;
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
    return `<article class="concept-visual"><div class="concept-visual-copy"><span class="badge green">개념 구조도</span><h3>${esc(visual.question)}</h3><p>글을 외우기 전에 아래 흐름과 판별 기준을 먼저 잡으세요.</p></div><div class="concept-flow">${visual.flow.map((step, index) => `<div class="concept-flow-step"><span>${index + 1}</span><strong>${esc(step)}</strong></div>${index < visual.flow.length - 1 ? '<span class="concept-arrow" aria-hidden="true">→</span>' : ''}`).join('')}</div><div class="concept-checks">${visual.checks.map((check, index) => `<div><span>CHECK ${index + 1}</span><p>${esc(check)}</p></div>`).join('')}</div></article>`;
  }
  function renderConcept(id) {
    const sub = SUB_BY_ID.get(id);
    if (!sub) return renderHome();
    state.view = 'concept';
    state.concept = id;
    const idx = SUBUNITS.findIndex(x => x.id === id);
    app.innerHTML = `<section><div class="page-head"><div><p class="eyebrow">${sub.unitId}단원 · 약 ${sub.time}분</p><h2>${esc(sub.title)}</h2><p>${esc(sub.keywords)}</p></div><button id="conceptHome" class="ghost compact">단원 목록</button></div><nav class="concept-nav" aria-label="중단원 이동"><button id="prevConcept" class="ghost compact" ${idx === 0 ? 'disabled' : ''}>← 이전</button>${SUBUNITS.map(x => `<button class="ghost compact jump-concept" data-id="${x.id}" ${x.id === id ? 'disabled' : ''}>${x.id}</button>`).join('')}<button id="nextConcept" class="ghost compact" ${idx === SUBUNITS.length - 1 ? 'disabled' : ''}>다음 →</button></nav>${renderConceptMap(sub)}<div class="concept-grid">${sub.sections.map((sec, i) => `<article class="card concept-section"><span class="badge green">개념 ${i + 1}</span><h3 style="margin-top:12px">${esc(sec.title)}</h3><ul>${sec.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul><div class="trap"><strong>함정 체크</strong><br>${esc(sec.trap)}</div></article>`).join('')}</div><div class="concept-finish"><button id="markDone" class="secondary">${db.completed[id] ? '✓ 개념 확인 완료됨' : '개념 확인 완료로 표시'}</button><button id="subQuiz" class="primary">이 중단원 퀴즈 ${QUESTIONS.filter(q => q.sub === id).length}문제</button></div><p class="source-note">개념 검토: 2027 불후의 명강 사회·문화 개념 완성·정답과 바른 해설, 2027 EBS 수능특강·해설. 퀴즈: 2022~2026학년도 평가원 6월·9월·수능 실기출 원문. 문항·정답은 원문 PDF와 정답표를 대조했으며 문항 저작권은 한국교육과정평가원에 있습니다.</p></section>`;
    document.getElementById('conceptHome').addEventListener('click', renderHome);
    document.getElementById('prevConcept').addEventListener('click', () => renderConcept(SUBUNITS[idx - 1]?.id));
    document.getElementById('nextConcept').addEventListener('click', () => renderConcept(SUBUNITS[idx + 1]?.id));
    document.querySelectorAll('.jump-concept').forEach(b => b.addEventListener('click', () => renderConcept(b.dataset.id)));
    document.getElementById('markDone').addEventListener('click', () => {
      db.completed[id] = Date.now();
      saveDb();
      renderConcept(id);
      showToast('개념 완료를 저장했습니다.');
    });
    document.getElementById('subQuiz').addEventListener('click', () => startQuiz(QUESTIONS.filter(q => q.sub === id), `${id} 중단원`, 'all'));
  }
  function startQuiz(pool, label, countOverride) {
    if (!pool.length) return showToast('출제할 문제가 없습니다.');
    let qs = state.order === 'random' ? shuffle(pool) : [...pool];
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
  function renderQuestionMedia(q, className = '') {
    return `<figure class="question-media ${esc(className)}"><a class="kice-paper-link" href="${esc(q.source.question)}" target="_blank" rel="noopener" title="원문 PDF 열기"><img class="question-image" data-question-image src="${esc(q.image)}" alt="${esc(q.prompt)}의 제시문·보기·선지 전체 원문" loading="eager" decoding="async"></a><figcaption>${q.year}학년도 ${esc(q.session)} ${q.number}번 · 제시문·보기·선지 전체를 원문 이미지로 제공합니다.</figcaption><div class="question-image-fallback" hidden><strong>문제 이미지를 불러오지 못했습니다.</strong><p>배포 지연이나 네트워크 오류일 수 있습니다. 평가원 원문 PDF에서 ${q.number}번을 확인해 주세요.</p><a class="ghost compact source-link" href="${esc(q.source.question)}" target="_blank" rel="noopener">원문 PDF 열기</a></div></figure>`;
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
  function renderQuiz() {
    const ss = state.session;
    if (!ss) return renderHome();
    state.view = 'quiz';
    const q = ss.questions[ss.index],
      sub = SUB_BY_ID.get(q.sub),
      r = ss.last,
      current = ss.index + 1,
      total = ss.questions.length;
    const sourceLabel = `${q.year}학년도 ${q.session} 기출 · 평가원`;
    const answerArea = `<div class="answer-prompt">정답을 선택하세요.</div><div class="kice-answer-grid">${CHOICE_MARKS.map((mark, i) => {
      const selected = ss.answered && Number(r.input) === i,
        cls = ss.answered && i === q.correct ? 'correct-option' : selected ? 'wrong-option' : '';
      return `<button class="choice-option kice-choice ${cls}" data-index="${i}" aria-label="${i + 1}번" ${ss.answered ? 'disabled' : ''}><span>${mark}</span></button>`;
    }).join('')}</div>${ss.answered ? `<button id="submitAnswer" class="primary full choice-next">${current === total ? '결과 보기' : '다음 문제'}</button>` : '<div class="key-hint">번호를 누르면 바로 채점됩니다.</div>'}`;
    app.innerHTML = `<section class="quiz-wrap"><div class="quiz-head"><div class="quiz-meta"><span>${esc(ss.label)} · ${q.sub}</span><span>${current}/${total} · 정답 ${ss.correct}</span></div><div class="progress-track"><div class="progress-fill" style="width:${Math.round(current / total * 100)}%"></div></div></div><article class="question-card"><div class="question-top"><span class="question-kicker">평가원 원문 · ${esc(sub.title)}</span><div class="source-meta"><span>${esc(sourceLabel)} · ${q.number}번</span><strong>오답률 ${q.wrongRate}% <small>· 통사랑 집계</small></strong></div></div>${renderQuestionMedia(q)}${answerArea}${ss.answered ? renderFeedback(q, r) : ''}</article></section>`;
    bindQuestionImages(app);
    document.querySelectorAll('.choice-option').forEach(b => b.addEventListener('click', () => submitAnswer(b.dataset.index)));
    document.querySelectorAll('.reason-option').forEach(b => b.addEventListener('click', () => {
      const row = db.wrongBank[q.id];
      if (!row) return;
      row.reason = b.dataset.reason;
      saveDb();
      renderQuiz();
      showToast('오답 원인을 분석에 반영했습니다.');
    }));
    const submit = document.getElementById('submitAnswer');
    if (submit) submit.addEventListener('click', ss.answered ? nextQuestion : () => submitAnswer());
    if (ss.answered) requestAnimationFrame(() => submit?.focus());
  }
  function renderFeedback(q, r) {
    const cls = r.correct ? 'correct' : 'wrong',
      title = r.correct ? '✓ 정답' : '✕ 오답',
      sub = SUB_BY_ID.get(q.sub),
      savedReason = db.wrongBank[q.id]?.reason || '';
    const diagnosis = r.correct ? '' : `<div class="wrong-diagnosis"><strong>${esc(q.sub)} · ${esc(sub.title)}에서 틀렸습니다.</strong><p>내 답 ${esc(shownAnswer(q, r.input))}과 정답 ${esc(q.answer)}을 가른 표현을 원문 선지에서 찾은 뒤, 아래에서 실제 실수 원인을 남기세요. 번호가 아니라 판단 기준을 복습 기록에 저장합니다.</p><div class="reason-options" role="group" aria-label="오답 원인 선택">${Object.entries(MISTAKE_REASONS).map(([key, label]) => `<button class="reason-option ${savedReason === key ? 'selected' : ''}" data-reason="${key}" type="button">${esc(label)}</button>`).join('')}</div></div>`;
    return `<div class="feedback ${cls}"><div class="feedback-title">${title}</div><div class="feedback-grid"><div class="feedback-item"><small>평가원 정답</small><strong>${esc(q.answer)}</strong></div><div class="feedback-item"><small>내 답</small><strong>${esc(shownAnswer(q, r.input))}</strong></div></div><p class="explain">평가원 원문 정답표와 대조한 답입니다. 오답률 ${q.wrongRate}%는 통사랑 문항별 정답률 ${q.correctRate}%를 기준으로 계산했습니다.</p>${diagnosis}<div class="feedback-actions"><a class="ghost compact source-link" href="${esc(q.source.question)}" target="_blank" rel="noopener">문제 원문 PDF</a><a class="ghost compact source-link" href="${esc(q.source.answer)}" target="_blank" rel="noopener">정답표 확인</a><a class="ghost compact source-link" href="https://tongsarang.kr/" target="_blank" rel="noopener">오답률 출처</a></div></div>`;
  }
  function renderMistakeCard(q, info = {}, input) {
    const sub = SUB_BY_ID.get(q.sub);
    const selected = input === undefined || input === null ? info.lastAnswer || '(선택 없음)' : shownAnswer(q, input);
    const reason = MISTAKE_REASONS[info.reason] || '원인 미분류';
    const repeatCopy = (info.count || 1) >= 2 ? '같은 문항을 반복해서 틀렸습니다. 정답 번호보다 선지를 가르는 개념 기준부터 다시 확인하세요.' : '첫 오답입니다. 내 답과 정답 선지의 표현 차이를 표시한 뒤 개념 지도로 돌아가세요.';
    return `<article class="mistake-card"><div class="mistake-card-head"><div><span class="badge red">누적 오답 ${info.count || 1}회</span><h3>${q.sub} · ${esc(sub.title)}</h3><p>${q.year}학년도 ${esc(q.session)} ${q.number}번 · 평가원</p></div><span class="reason-badge">${esc(reason)}</span></div>${renderQuestionMedia(q, 'review-question-media')}<div class="answer-comparison"><div><small>최근 내 답</small><strong class="answer-wrong">${esc(selected)}</strong></div><span aria-hidden="true">→</span><div><small>평가원 정답</small><strong class="answer-correct">${esc(q.answer)}</strong></div></div><div class="mistake-diagnosis"><strong>${esc(sub.unitId)}단원 · ${esc(sub.title)} 취약 신호</strong><p>${esc(repeatCopy)}</p><small>핵심 판별어: ${esc(sub.keywords)}</small></div><div class="mistake-actions"><button class="ghost compact mistake-concept" data-sub="${q.sub}">개념 지도 다시 보기</button><button class="secondary compact mistake-retry" data-id="${q.id}">이 문제 재시험</button><a class="ghost compact source-link" href="${esc(q.source.answer)}" target="_blank" rel="noopener">정답표</a></div></article>`;
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
    const ss = state.session;
    if (!ss) return renderHome();
    state.view = 'result';
    const total = ss.questions.length,
      accuracy = Math.round(ss.correct / total * 100),
      wrong = ss.results.filter(x => !x.correct);
    app.innerHTML = `<section class="card"><p class="eyebrow" style="text-align:center">${esc(ss.label)} 완료</p><div class="result-score">${accuracy}%</div><p class="result-copy">${total}문제 중 ${ss.correct}개 정답 · 오답 ${ss.wrong}개</p><div class="button-row" style="max-width:520px;margin:24px auto 0"><button id="resultHome" class="secondary">단원 목록</button><button id="retryResult" class="primary" ${wrong.length ? '' : 'disabled'}>이번 오답 다시 풀기</button></div>${wrong.length ? `<div class="result-mistakes"><h3>이번 오답 ${wrong.length}문제</h3><p>문제 원문과 선지 전체를 다시 보고, 내 답과 정답을 가른 기준을 확인하세요.</p><div class="mistake-list">${wrong.map(row => {
      const q = Q_BY_ID.get(row.id);
      return renderMistakeCard(q, db.wrongBank[q.id], row.input);
    }).join('')}</div></div>` : '<div class="empty">완벽합니다. 이 범위의 오답은 모두 정리됐습니다.</div>'}</section>`;
    document.getElementById('resultHome').addEventListener('click', renderHome);
    document.getElementById('retryResult').addEventListener('click', () => startQuiz(wrong.map(x => Q_BY_ID.get(x.id)).filter(Boolean), '이번 오답 재시험', 'all'));
    bindMistakeActions();
  }
  function renderStats() {
    state.view = 'stats';
    state.session = null;
    const s = stats(),
      analysis = weaknessAnalysis(),
      wrong = Object.entries(db.wrongBank).map(([id, info]) => ({
        q: Q_BY_ID.get(id),
        info
      })).filter(x => x.q).sort((a, b) => (b.info.lastWrongAt || 0) - (a.info.lastWrongAt || 0));
    const weakestUnit = analysis.weakestUnit ? `${analysis.weakestUnit.id} · ${analysis.weakestUnit.accuracy}%` : '풀이 기록 필요';
    const weakestSub = analysis.weakestSub ? `${analysis.weakestSub.id} · ${analysis.weakestSub.accuracy}%` : '풀이 기록 필요';
    const reasonSummary = analysis.dominantReason ? `${analysis.dominantReason.label} · ${analysis.dominantReason.count}문제` : '오답 원인 없음';
    app.innerHTML = `<section><div class="page-head"><div><p class="eyebrow">ACCOUNT STUDY DATA</p><h2>학습 기록·취약도 분석</h2><p>정답 번호가 아니라 문제 원문, 오답 원인, 대단원·중단원별 정확도를 함께 봅니다.</p></div><button id="statsHome" class="ghost compact">단원 목록</button></div><div class="card"><div class="overview"><div class="stat"><span>총 풀이</span><strong>${db.attempts}</strong></div><div class="stat"><span>정답률</span><strong>${s.accuracy}%</strong></div><div class="stat"><span>현재 오답</span><strong>${s.wrong}</strong></div></div><div class="button-row"><button id="exportData" class="secondary">기록 백업</button><label class="ghost" for="importData" role="button" style="display:grid;place-items:center">기록 복원</label><input id="importData" class="file-input" type="file" accept="application/json,.json"><button id="resetData" class="danger">기록 초기화</button></div></div><article class="card weakness-panel"><div class="page-head"><div><span class="badge green">무료 자동 분석</span><h2>내 약점 한눈에</h2><p>외부 AI나 유료 토큰 없이 실제 풀이·오답 기록만으로 계산합니다.</p></div></div><div class="weakness-insights"><div><small>가장 취약한 대단원</small><strong>${esc(weakestUnit)}</strong></div><div><small>가장 취약한 중단원</small><strong>${esc(weakestSub)}</strong></div><div><small>가장 많은 실수 원인</small><strong>${esc(reasonSummary)}</strong></div></div><div class="unit-analysis">${analysis.unitRows.map(row => `<div class="unit-analysis-row"><div><strong>${row.id} · ${esc(row.title)}</strong><small>${row.attempts ? `${row.attempts}회 풀이 · ${masteryLabel(row)}` : '아직 풀이 없음'}</small></div><div class="analysis-meter" aria-label="${row.accuracy ?? 0}%"><span style="width:${row.accuracy ?? 0}%"></span></div><b>${row.accuracy === null ? '-' : `${row.accuracy}%`}</b></div>`).join('')}</div><p class="analysis-note">3회 미만 기록은 ‘표본 부족’으로 표시합니다. 풀이가 쌓일수록 대단원·중단원 취약도와 실수 원인 분류가 정확해집니다.</p></article><div class="card" style="margin-top:14px"><h2>중단원별 현황</h2><div class="stats-table">${analysis.subRows.map(row => `<div class="stats-row"><div><span>${row.id} · ${esc(row.title)}</span><small>${db.completed[row.id] ? '개념 완료' : '개념 미완료'} · ${masteryLabel(row)}</small></div><div class="analysis-meter"><span style="width:${row.accuracy ?? 0}%"></span></div><b>${row.accuracy === null ? '-' : `${row.accuracy}%`}</b></div>`).join('')}</div></div><div class="card wrong-note" style="margin-top:14px"><div class="page-head" style="margin-bottom:0"><div><h2>오답 원문 분석 노트</h2><p>${wrong.length}문제 · 제시문·보기·선지 전체, 최근 내 답, 정답, 실수 원인을 함께 복습합니다.</p></div><button id="statsReview" class="primary compact" ${wrong.length ? '' : 'disabled'}>전체 재시험</button></div>${wrong.length ? `<div class="mistake-list">${wrong.map(({ q, info }) => renderMistakeCard(q, info, info.lastInput)).join('')}</div>` : '<div class="empty">아직 오답이 없습니다.</div>'}</div></section>`;
    document.getElementById('statsHome').addEventListener('click', renderHome);
    document.getElementById('statsReview').addEventListener('click', () => startQuiz(wrong.map(x => x.q), '오답 재시험', 'all'));
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
