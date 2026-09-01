(() => {
  'use strict';
  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;
  const ownerUsernames = new Set(['hvsdcm']);
  const elements = {
    wordmark: document.getElementById('wordmark'), drawer: document.getElementById('drawer'),
    shade: document.getElementById('shade'), closeDrawer: document.getElementById('closeDrawer'),
    drawerLogout: document.getElementById('drawerLogout'), studyLinks: document.getElementById('studyLinks'),
    ownerLinks: document.getElementById('ownerLinks'),
    modal: document.getElementById('loginModal'), loginForm: document.getElementById('loginForm'),
    closeLogin: document.getElementById('closeLogin'), loginError: document.getElementById('loginError'),
    username: document.getElementById('username'), password: document.getElementById('password'),
  };
  const token = localStorage.getItem('hvsdcm.token');
  const savedUsername = localStorage.getItem('hvsdcm.user');
  const signedIn = Boolean(token && savedUsername);
  let opener = null;

  function setDrawer(open) {
    elements.drawer.classList.toggle('open', open);
    elements.shade.classList.toggle('open', open);
    elements.drawer.setAttribute('aria-hidden', String(!open));
    elements.shade.setAttribute('aria-hidden', String(!open));
  }
  function setBackgroundInert(inert) {
    for (const child of document.body.children) if (child !== elements.modal && child.tagName !== 'SCRIPT') child.inert = inert;
  }
  function openLogin() {
    opener = document.activeElement;
    setDrawer(false);
    elements.loginError.textContent = '';
    setBackgroundInert(true);
    elements.modal.classList.add('open');
    elements.modal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => elements.username.focus());
  }
  function closeLogin() {
    if (!elements.modal.classList.contains('open')) return;
    elements.modal.classList.remove('open');
    elements.modal.setAttribute('aria-hidden', 'true');
    setBackgroundInert(false);
    requestAnimationFrame(() => opener?.focus());
  }
  function trapLoginFocus(event) {
    if (event.key !== 'Tab' || !elements.modal.classList.contains('open')) return;
    const controls = [...elements.loginForm.querySelectorAll('button, input, [href], [tabindex]:not([tabindex="-1"])')]
      .filter((control) => !control.disabled && control.offsetParent !== null);
    if (!controls.length) return;
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function safeNextPath() {
    const candidate = new URLSearchParams(location.search).get('next');
    if (!candidate) return null;
    try { const target = new URL(candidate, location.origin); return target.origin === location.origin ? `${target.pathname}${target.search}${target.hash}` : null; } catch { return null; }
  }
  async function login(event) {
    event.preventDefault();
    elements.loginError.textContent = '';
    try {
      const response = await fetch(`${API_URL}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: elements.username.value, password: elements.password.value }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '로그인 실패');
      localStorage.setItem('hvsdcm.token', data.token);
      localStorage.setItem('hvsdcm.user', data.user.username);
      location.assign(safeNextPath() || '/');
    } catch (error) { elements.loginError.textContent = error.message || '로그인 실패'; }
  }
  async function logout() {
    try { await fetch(`${API_URL}/api/logout`, { method: 'POST', headers: { authorization: `Bearer ${token || ''}` } }); } catch { /* 로컬 세션은 항상 지운다. */ }
    localStorage.removeItem('hvsdcm.token'); localStorage.removeItem('hvsdcm.user'); sessionStorage.clear(); location.reload();
  }
  function appendLinks(target, links) {
    for (const [href, title, description] of links) {
      const anchor = document.createElement('a'); anchor.href = href;
      const strong = document.createElement('strong'); strong.textContent = title;
      const span = document.createElement('span'); span.textContent = description;
      anchor.append(strong, span); target.append(anchor);
    }
  }
  function mountSignedInLinks() {
    appendLinks(elements.studyLinks, [
      ['/WordMaster/', 'WordMaster', '2,000단어'],
      ['/smstudy/', '사회·문화', '5단원 · 개념과 문제'],
      ['/plstudy/', '정치와 법', '6단원 · 개념과 문제'],
      ['/gichul/', '기출', '평가원 문제지'],
    ]);
    if (!ownerUsernames.has(String(savedUsername).toLowerCase())) return;
    appendLinks(elements.ownerLinks, [
      ['/behavior-lab/#paper', 'Behavior Lab', 'PAPER 모델'],
      ['/usage/', '사용량', 'Codex · AI'],
      ['/admin/', '관리자', '계정 · 접속 · 학습 데이터'],
    ]);
  }

  elements.wordmark.addEventListener('click', () => signedIn ? setDrawer(true) : openLogin());
  elements.closeDrawer.addEventListener('click', () => setDrawer(false));
  elements.shade.addEventListener('click', () => setDrawer(false));
  elements.drawerLogout.addEventListener('click', logout);
  elements.closeLogin.addEventListener('click', closeLogin);
  elements.loginForm.addEventListener('submit', login);
  elements.modal.addEventListener('click', (event) => { if (event.target === elements.modal) closeLogin(); });
  document.addEventListener('keydown', (event) => { trapLoginFocus(event); if (event.key === 'Escape') { setDrawer(false); closeLogin(); } });
  if (signedIn) mountSignedInLinks();
  if (new URLSearchParams(location.search).get('login') === '1' && !signedIn) openLogin();
})();
