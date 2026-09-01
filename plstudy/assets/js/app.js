(() => {
  'use strict';
  const app = document.getElementById('app');
  const storageKey = 'politicslaw2027.study.v1';
  let data;
  let activeSub = null;
  let session = null;
  const progress = (() => { try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; } })();
  const esc = (value) => String(value ?? '').replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(progress)); } catch { /* 학습은 계속한다. */ } };
  const subunits = () => data.UNITS.flatMap((unit) => unit.subs.map((sub) => ({ ...sub, unitId: unit.id, unitTitle: unit.title })));
  const subById = (id) => subunits().find((sub) => sub.id === id);
  function setNav(view) { document.querySelectorAll('.pl-nav').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view)); }
  function renderHome() {
    setNav('home'); activeSub = null; session = null;
    app.innerHTML = `<header class="pl-head"><div><span>POLITICS & LAW</span><h1>정치와 법</h1><p>개념을 읽고 바로 다섯 문항으로 확인하세요.</p></div><button class="btn btn-primary" type="button" data-random>전체 랜덤 20문항</button></header><div class="pl-units">${data.UNITS.map((unit) => `<section class="pl-unit"><header><span>${unit.id}</span><h2>${esc(unit.title)}</h2></header><div>${unit.subs.map((sub) => { const row = progress[sub.id] || {}; return `<button type="button" class="pl-sub" data-sub="${sub.id}"><span><strong>${esc(sub.title)}</strong><small>${esc(sub.summary)}</small></span><b>${row.correct || 0}/${row.answered || 0}</b></button>`; }).join('')}</div></section>`).join('')}</div>`;
    app.querySelectorAll('[data-sub]').forEach((button) => button.addEventListener('click', () => renderConcept(button.dataset.sub)));
    app.querySelector('[data-random]').addEventListener('click', () => startQuiz([...data.QUESTIONS].sort(() => Math.random() - .5).slice(0, 20), '전체 랜덤'));
  }
  function renderConcept(id) {
    const sub = subById(id); if (!sub) return renderHome(); activeSub = id; setNav('home');
    const questions = data.QUESTIONS.filter((question) => question.sub === id);
    app.innerHTML = `<button class="pl-back" type="button" data-home>← 단원 목록</button><header class="pl-head is-compact"><div><span>${sub.unitId} · ${esc(sub.unitTitle)}</span><h1>${esc(sub.title)}</h1><p>${esc(sub.summary)}</p></div><button class="btn btn-primary" type="button" data-start>5문항 풀기</button></header><section class="pl-concepts">${sub.concepts.map((concept, index) => `<article><span>${String(index + 1).padStart(2, '0')}</span><h2>${esc(concept.term)}</h2><p>${esc(concept.definition)}</p></article>`).join('')}</section><section class="pl-traps"><h2>선지 함정</h2><ul>${sub.traps.map((trap) => `<li>${esc(trap)}</li>`).join('')}</ul></section>`;
    app.querySelector('[data-home]').addEventListener('click', renderHome); app.querySelector('[data-start]').addEventListener('click', () => startQuiz(questions, sub.title));
  }
  function startQuiz(questions, label) { session = { questions, label, index: 0, correct: 0, answer: null }; renderQuiz(); }
  function choose(index) {
    if (!session || session.answer !== null) return; const question = session.questions[session.index]; session.answer = Number(index); const correct = session.answer === question.answer; if (correct) session.correct++;
    const row = progress[question.sub] || { answered: 0, correct: 0 }; row.answered++; if (correct) row.correct++; progress[question.sub] = row; save(); renderQuiz();
  }
  function next() { if (session.index === session.questions.length - 1) return renderResult(); session.index++; session.answer = null; renderQuiz(); }
  function renderQuiz() {
    setNav('home'); const question = session.questions[session.index]; const answered = session.answer !== null; const sub = subById(question.sub);
    app.innerHTML = `<header class="pl-quiz-head"><div><span>${esc(session.label)} · ${session.index + 1}/${session.questions.length}</span><h1>${esc(sub.title)}</h1></div><b>정답 ${session.correct}</b></header><article class="pl-question"><h2>${esc(question.prompt)}</h2><div class="pl-choices">${question.choices.map((choice, index) => `<button type="button" data-choice="${index}" class="${answered && index === question.answer ? 'is-correct' : answered && index === session.answer ? 'is-wrong' : ''}" ${answered ? 'disabled' : ''}><span>${index + 1}</span>${esc(choice)}</button>`).join('')}</div>${answered ? `<div class="pl-feedback"><strong>${session.answer === question.answer ? '정답' : '오답'}</strong><p>${esc(question.explanation)}</p><button class="btn btn-primary" type="button" data-next>${session.index === session.questions.length - 1 ? '결과 보기' : '다음 문제'}</button></div>` : ''}</article>`;
    app.querySelectorAll('[data-choice]').forEach((button) => button.addEventListener('click', () => choose(button.dataset.choice))); app.querySelector('[data-next]')?.addEventListener('click', next);
  }
  function renderResult() { const total = session.questions.length; app.innerHTML = `<section class="pl-result"><span>완료</span><h1>${session.correct}/${total}</h1><p>${Math.round(session.correct / total * 100)}% 정답</p><div><button class="btn btn-primary" type="button" data-again>다시 풀기</button><button class="btn btn-secondary" type="button" data-home>단원 목록</button></div></section>`; app.querySelector('[data-again]').addEventListener('click', () => startQuiz(session.questions, session.label)); app.querySelector('[data-home]').addEventListener('click', renderHome); }
  function renderProgress() { setNav('progress'); const rows = subunits(); app.innerHTML = `<header class="pl-head"><div><span>PROGRESS</span><h1>학습 기록</h1><p>중단원별 누적 정답을 이 기기에 저장합니다.</p></div></header><div class="pl-progress-list">${rows.map((sub) => { const row = progress[sub.id] || { answered: 0, correct: 0 }; const rate = row.answered ? Math.round(row.correct / row.answered * 100) : 0; return `<button type="button" data-sub="${sub.id}"><span><strong>${sub.id} · ${esc(sub.title)}</strong><small>${row.answered}문항 풀이</small></span><b>${rate}%</b></button>`; }).join('')}</div>`; app.querySelectorAll('[data-sub]').forEach((button) => button.addEventListener('click', () => renderConcept(button.dataset.sub))); }
  document.querySelectorAll('.pl-nav').forEach((button) => button.addEventListener('click', () => button.dataset.view === 'progress' ? renderProgress() : renderHome()));
  window.PLSTUDY_CONTENT_READY.then(() => { data = window.PLSTUDY_CONTENT; if (data.UNITS.length !== 6 || subunits().length !== 18 || data.QUESTIONS.length !== 90) throw new Error('정치와 법 데이터가 불완전합니다.'); renderHome(); }).catch((error) => { app.innerHTML = `<section class="pl-error"><h1>학습 데이터를 불러오지 못했습니다.</h1><p>${esc(error.message)}</p></section>`; });
})();
