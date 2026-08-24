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
  const SUB_BY_ID = new Map(SUBUNITS.map(x => [x.id, x]));
  const Q_BY_ID = new Map(QUESTIONS.map(x => [x.id, x]));
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
      db.wrongBank[q.id] = {
        count: (db.wrongBank[q.id]?.count || 0) + 1,
        lastAnswer: shownAnswer(q, input),
        lastWrongAt: Date.now(),
        sub: q.sub
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
      <section class="hero"><p class="eyebrow">READ → SOLVE → RETEST</p><h1>만든 문제가 아니라,<br>평가원 원문으로.</h1><p>2022~2026학년도 평가원 6월·9월 모의평가와 수능을 분석해 1~4단원, 13개 소단원별 실기출 78문항을 배치했습니다. 모든 문항은 평가원 원문 이미지와 정답표를 대조했고, 주관식 없이 5지선다로만 풉니다.</p><p class="copyright-note">문항 저작권: 한국교육과정평가원 · 비상업적 개인 학습용 발췌 · 오답률: 통사랑 문항별 정답률 데이터 기준</p></section>
      <section class="grid two"><div>
        <div class="unit-list">${UNITS.map(renderUnit).join('')}</div>
      </div><aside>
        <div class="card"><h2>학습 시작</h2><p class="muted">체크한 소단원을 섞어 출제합니다.</p>
          <div class="overview"><div class="stat"><span>개념 완료</span><strong>${s.done}/${SUBUNITS.length}</strong></div><div class="stat"><span>누적 정답률</span><strong>${s.accuracy}%</strong></div><div class="stat"><span>오답 노트</span><strong>${s.wrong}</strong></div></div>
          <div class="setup-row"><div><label for="qCount">문제 수</label><select id="qCount"><option value="10" ${state.count === '10' ? 'selected' : ''}>10문제</option><option value="20" ${state.count === '20' ? 'selected' : ''}>20문제</option><option value="40" ${state.count === '40' ? 'selected' : ''}>40문제</option><option value="all" ${state.count === 'all' ? 'selected' : ''}>선택 범위 전체</option></select></div><div><label for="qOrder">출제 순서</label><select id="qOrder"><option value="random" ${state.order === 'random' ? 'selected' : ''}>랜덤</option><option value="sequential" ${state.order === 'sequential' ? 'selected' : ''}>교재 순서</option></select></div></div>
          <button id="startSelected" class="primary full" ${state.selected.size ? '' : 'disabled'}>선택 범위 퀴즈 (${state.selected.size}개 소단원)</button>
          <div class="button-row" style="margin-top:9px"><button id="selectAll" class="ghost">전체 선택</button><button id="clearAll" class="ghost">선택 해제</button></div>
          <div class="review-card"><h3>고오답률 기출</h3><p>통사랑 집계 오답률 35% 이상인 평가원 실기출만 모아 풉니다.</p><button id="weakQuiz" class="secondary full">고오답률 기출 풀기</button></div>
          <div class="review-card"><h3>오답 복습</h3><p>문제·내 답·정답을 먼저 보며 외우거나 다시 시험칠 수 있습니다.</p><div class="button-row"><button id="wrongStudy" class="ghost" ${s.wrong ? '' : 'disabled'}>오답 보고 외우기</button><button id="wrongQuiz" class="secondary" ${s.wrong ? '' : 'disabled'}>오답 ${s.wrong}문제 재시험</button></div></div>
          <div class="review-card"><h3>누적 복습</h3><p>개념 완료한 소단원 전체에서 20문제를 다시 꺼냅니다.</p><button id="cumulative" class="secondary full" ${s.done ? '' : 'disabled'}>완료 범위 누적 복습</button></div>
        </div>
      </aside></section>`;
    bindHome();
  }
  function renderUnit(unit) {
    const done = unit.subs.filter(x => db.completed[x.id]).length;
    return `<article class="unit-card"><div class="unit-head"><div><span class="unit-index">${unit.id}단원</span><h3>${esc(unit.title)}</h3><p>${esc(unit.desc)}</p></div><div class="unit-progress"><strong>${done}/${unit.subs.length}</strong><small>개념 완료</small></div></div><div class="subunit-list">${unit.subs.map(sub => {
      const st = subStats(sub.id);
      return `<div class="subunit-row"><input class="check sub-check" type="checkbox" data-id="${sub.id}" aria-label="${esc(sub.title)} 선택" ${state.selected.has(sub.id) ? 'checked' : ''}><div class="subunit-copy"><strong>${sub.id} · ${esc(sub.title)}</strong><small>${esc(sub.keywords)}${st.attempts ? ` · 정답률 ${st.accuracy}%` : ''}</small></div><div class="sub-actions"><span class="done-dot ${db.completed[sub.id] ? 'on' : ''}" title="${db.completed[sub.id] ? '개념 완료' : '미완료'}"></span><button class="ghost compact study-btn" data-id="${sub.id}">개념 학습</button></div></div>`;
    }).join('')}</div></article>`;
  }
  function bindHome() {
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
  function renderConcept(id) {
    const sub = SUB_BY_ID.get(id);
    if (!sub) return renderHome();
    state.view = 'concept';
    state.concept = id;
    const idx = SUBUNITS.findIndex(x => x.id === id);
    app.innerHTML = `<section><div class="page-head"><div><p class="eyebrow">${sub.unitId}단원 · 약 ${sub.time}분</p><h2>${esc(sub.title)}</h2><p>${esc(sub.keywords)}</p></div><button id="conceptHome" class="ghost compact">단원 목록</button></div><nav class="concept-nav" aria-label="소단원 이동"><button id="prevConcept" class="ghost compact" ${idx === 0 ? 'disabled' : ''}>← 이전</button>${SUBUNITS.map(x => `<button class="ghost compact jump-concept" data-id="${x.id}" ${x.id === id ? 'disabled' : ''}>${x.id}</button>`).join('')}<button id="nextConcept" class="ghost compact" ${idx === SUBUNITS.length - 1 ? 'disabled' : ''}>다음 →</button></nav><div class="concept-grid">${sub.sections.map((sec, i) => `<article class="card concept-section"><span class="badge green">개념 ${i + 1}</span><h3 style="margin-top:12px">${esc(sec.title)}</h3><ul>${sec.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul><div class="trap"><strong>함정 체크</strong><br>${esc(sec.trap)}</div></article>`).join('')}</div><div class="concept-finish"><button id="markDone" class="secondary">${db.completed[id] ? '✓ 개념 확인 완료됨' : '개념 확인 완료로 표시'}</button><button id="subQuiz" class="primary">이 소단원 퀴즈 ${QUESTIONS.filter(q => q.sub === id).length}문제</button></div><p class="source-note">개념 검토: 2027 불후의 명강 사회·문화 개념 완성·정답과 바른 해설, 2027 EBS 수능특강·해설. 퀴즈: 2022~2026학년도 평가원 6월·9월·수능 실기출 원문. 문항·정답은 원문 PDF와 정답표를 대조했으며 문항 저작권은 한국교육과정평가원에 있습니다.</p></section>`;
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
    document.getElementById('subQuiz').addEventListener('click', () => startQuiz(QUESTIONS.filter(q => q.sub === id), `${id} 소단원`, 'all'));
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
    app.innerHTML = `<section class="quiz-wrap"><div class="quiz-head"><div class="quiz-meta"><span>${esc(ss.label)} · ${q.sub}</span><span>${current}/${total} · 정답 ${ss.correct}</span></div><div class="progress-track"><div class="progress-fill" style="width:${Math.round(current / total * 100)}%"></div></div></div><article class="question-card"><div class="question-top"><span class="question-kicker">평가원 원문 · ${esc(sub.title)}</span><div class="source-meta"><span>${esc(sourceLabel)} · ${q.number}번</span><strong>오답률 ${q.wrongRate}% <small>· 통사랑 집계</small></strong></div></div><a class="kice-paper-link" href="${esc(q.source.question)}" target="_blank" rel="noopener" title="원문 PDF 열기"><img class="question-image" src="${esc(q.image)}" alt="${esc(q.prompt)} 원문" loading="eager"></a>${answerArea}${ss.answered ? renderFeedback(q, r) : ''}</article></section>`;
    document.querySelectorAll('.choice-option').forEach(b => b.addEventListener('click', () => submitAnswer(b.dataset.index)));
    const submit = document.getElementById('submitAnswer');
    if (submit) submit.addEventListener('click', ss.answered ? nextQuestion : () => submitAnswer());
    if (ss.answered) requestAnimationFrame(() => submit?.focus());
  }
  function renderFeedback(q, r) {
    const cls = r.correct ? 'correct' : 'wrong',
      title = r.correct ? '✓ 정답' : '✕ 오답';
    return `<div class="feedback ${cls}"><div class="feedback-title">${title}</div><div class="feedback-grid"><div class="feedback-item"><small>평가원 정답</small><strong>${esc(q.answer)}</strong></div><div class="feedback-item"><small>내 답</small><strong>${esc(shownAnswer(q, r.input))}</strong></div></div><p class="explain">평가원 원문 정답표와 대조한 답입니다. 오답률 ${q.wrongRate}%는 통사랑 문항별 정답률 ${q.correctRate}%를 기준으로 계산했습니다.</p><div class="feedback-actions"><a class="ghost compact source-link" href="${esc(q.source.question)}" target="_blank" rel="noopener">문제 원문 PDF</a><a class="ghost compact source-link" href="${esc(q.source.answer)}" target="_blank" rel="noopener">정답표 확인</a><a class="ghost compact source-link" href="https://tongsarang.kr/" target="_blank" rel="noopener">오답률 출처</a></div></div>`;
  }
  function renderResult() {
    const ss = state.session;
    if (!ss) return renderHome();
    state.view = 'result';
    const total = ss.questions.length,
      accuracy = Math.round(ss.correct / total * 100),
      wrong = ss.results.filter(x => !x.correct);
    app.innerHTML = `<section class="card"><p class="eyebrow" style="text-align:center">${esc(ss.label)} 완료</p><div class="result-score">${accuracy}%</div><p class="result-copy">${total}문제 중 ${ss.correct}개 정답 · 오답 ${ss.wrong}개</p><div class="button-row" style="max-width:520px;margin:24px auto 0"><button id="resultHome" class="secondary">단원 목록</button><button id="retryResult" class="primary" ${wrong.length ? '' : 'disabled'}>이번 오답 다시 풀기</button></div>${wrong.length ? `<div style="margin-top:28px"><h3>이번 오답 ${wrong.length}문제</h3><div class="mistake-list">${wrong.map(row => {
      const q = Q_BY_ID.get(row.id);
      return `<div class="mistake-row"><div><strong>${q.sub} · ${esc(q.prompt)}</strong><small>${q.year}학년도 ${q.session} ${q.number}번 · 평가원</small></div><div><strong>정답: ${esc(q.answer)}</strong><div class="user-answer">내 답: ${esc(shownAnswer(q, row.input))}</div></div></div>`;
    }).join('')}</div></div>` : '<div class="empty">완벽합니다. 이 범위의 오답은 모두 정리됐습니다.</div>'}</section>`;
    document.getElementById('resultHome').addEventListener('click', renderHome);
    document.getElementById('retryResult').addEventListener('click', () => startQuiz(wrong.map(x => Q_BY_ID.get(x.id)).filter(Boolean), '이번 오답 재시험', 'all'));
  }
  function renderStats() {
    state.view = 'stats';
    state.session = null;
    const s = stats(),
      wrong = Object.entries(db.wrongBank).map(([id, info]) => ({
        q: Q_BY_ID.get(id),
        info
      })).filter(x => x.q).sort((a, b) => (b.info.lastWrongAt || 0) - (a.info.lastWrongAt || 0));
    app.innerHTML = `<section><div class="page-head"><div><p class="eyebrow">ACCOUNT STUDY DATA</p><h2>학습 기록</h2><p>학습 기록은 계정 DB에 저장되며, 현재 브라우저에는 빠른 실행을 위한 사본만 보관됩니다.</p></div><button id="statsHome" class="ghost compact">단원 목록</button></div><div class="card"><div class="overview"><div class="stat"><span>총 풀이</span><strong>${db.attempts}</strong></div><div class="stat"><span>정답률</span><strong>${s.accuracy}%</strong></div><div class="stat"><span>오답</span><strong>${s.wrong}</strong></div></div><div class="button-row"><button id="exportData" class="secondary">기록 백업</button><label class="ghost" for="importData" role="button" style="display:grid;place-items:center">기록 복원</label><input id="importData" class="file-input" type="file" accept="application/json,.json"><button id="resetData" class="danger">기록 초기화</button></div></div><div class="card" style="margin-top:14px"><h2>소단원별 현황</h2><div class="stats-table">${SUBUNITS.map(sub => {
      const st = subStats(sub.id);
      return `<div class="stats-row"><span>${sub.id} · ${esc(sub.title)}</span><small>${db.completed[sub.id] ? '개념 완료' : '미완료'}</small><small>${st.attempts ? `${st.accuracy}%` : '미응시'}</small></div>`;
    }).join('')}</div></div><div class="card" style="margin-top:14px"><div class="page-head" style="margin-bottom:0"><div><h2>오답 암기 노트</h2><p>${wrong.length}문제 · 문제, 최근 내 답과 정답을 보며 외울 수 있습니다.</p></div><button id="statsReview" class="primary compact" ${wrong.length ? '' : 'disabled'}>재시험</button></div>${wrong.length ? `<div class="mistake-list">${wrong.map(({
      q,
      info
    }) => `<div class="mistake-row"><div><strong>${q.sub} · ${esc(q.prompt)}</strong><small>누적 오답 ${info.count || 1}회</small></div><div><strong>정답: ${esc(q.answer)}</strong><div class="user-answer">최근 내 답: ${esc(info.lastAnswer || '(빈 답)')}</div></div></div>`).join('')}</div>` : '<div class="empty">아직 오답이 없습니다.</div>'}</div></section>`;
    document.getElementById('statsHome').addEventListener('click', renderHome);
    document.getElementById('statsReview').addEventListener('click', () => startQuiz(wrong.map(x => x.q), '오답 재시험', 'all'));
    document.getElementById('exportData').addEventListener('click', exportData);
    document.getElementById('importData').addEventListener('change', importData);
    document.getElementById('resetData').addEventListener('click', resetData);
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
