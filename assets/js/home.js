(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;

  const elements = {
    account: document.getElementById('account'),
    closeLogin: document.getElementById('closeLogin'),
    drawer: document.getElementById('drawer'),
    drawerLogout: document.getElementById('drawerLogout'),
    loginError: document.getElementById('loginError'),
    loginForm: document.getElementById('loginForm'),
    loginTriggers: document.querySelectorAll('[data-login-trigger]'),
    menuButton: document.getElementById('menuButton'),
    modal: document.getElementById('loginModal'),
    password: document.getElementById('password'),
    shade: document.getElementById('shade'),
    title: document.getElementById('welcomeTitle'),
    username: document.getElementById('username'),
  };

  function setMenuOpen(open) {
    elements.drawer.classList.toggle('open', open);
    elements.shade.classList.toggle('open', open);
    elements.menuButton.classList.toggle('open', open);
    elements.menuButton.setAttribute('aria-expanded', String(open));
    elements.menuButton.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
  }

  function openLogin() {
    setMenuOpen(false);
    elements.loginError.textContent = '';
    elements.modal.classList.add('open');
    requestAnimationFrame(() => elements.username.focus());
  }

  function closeLogin() {
    elements.modal.classList.remove('open');
  }

  function showUser(username) {
    const prefix = document.createElement('span');
    const isAdmin = username.trim().toLowerCase() === 'hvsdcm';
    const user = document.createElement(isAdmin ? 'a' : 'span');
    prefix.className = 'welcome-prefix';
    prefix.textContent = 'Welcome,';
    user.className = isAdmin ? 'welcome-user welcome-admin' : 'welcome-user';
    user.textContent = isAdmin ? 'Admin' : username;
    if (isAdmin) {
      user.href = '/admin/';
      user.setAttribute('aria-label', '관리자 페이지로 이동');
      user.title = '관리자 페이지';
    }
    elements.title.replaceChildren(prefix, user);
    elements.title.dataset.user = username;
    elements.account.classList.add('logged');
    elements.drawer.classList.add('logged');
    document.body.classList.add('logged');
    document.title = 'hvsdcm — Study, distilled.';
  }

  // 이모지 리터럴은 마크업에 없다. 슬롯은 data-emoji="<키>"만 갖고 글자는 여기서
  // site-emoji.js의 매핑에서 채운다 (DESIGN.md §5 — 대상당 글리프 하나, 원본 한 곳).
  // 매핑이 없거나 키가 빠지면 슬롯은 빈 채로 남는다 — 이모지는 aria-hidden이고 의미를
  // 단독으로 지지 않으므로 화면은 그대로 읽힌다.
  function paintEmoji(root) {
    const map = window.SITE_EMOJI || {};
    for (const slot of root.querySelectorAll('[data-emoji]')) {
      slot.textContent = map[slot.dataset.emoji] || '';
    }
  }

  // 학습 콘텐츠는 <template data-study>로만 존재한다 — 미로그인 문서에는 아예 렌더되지
  // 않으므로 로그인 판정 전 깜빡임이 원천적으로 없다. 로그인 판정 후 한 번만 주입한다.
  function mountStudyContent() {
    for (const template of document.querySelectorAll('template[data-study]')) {
      template.parentNode.insertBefore(template.content.cloneNode(true), template);
    }
    // 템플릿 안의 슬롯은 주입되기 전까지 문서에 없다 — 주입 직후에 다시 칠한다.
    paintEmoji(document);
  }

  // 로그인 후 이동은 동일 출처의 내부 경로만 허용한다.
  function getSafeNextPath() {
    const candidate = new URLSearchParams(location.search).get('next');
    if (!candidate) return null;

    try {
      const target = new URL(candidate, location.origin);
      return target.origin === location.origin ? `${target.pathname}${target.search}${target.hash}` : null;
    } catch {
      return null;
    }
  }

  async function parseResponse(response) {
    return response.json().catch(() => ({}));
  }

  async function logout() {
    const token = localStorage.getItem('hvsdcm.token');
    try {
      await fetch(`${API_URL}/api/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token || ''}` },
      });
    } catch {
      // 네트워크와 무관하게 로컬 세션은 항상 종료한다.
    }

    localStorage.removeItem('hvsdcm.token');
    localStorage.removeItem('hvsdcm.user');
    sessionStorage.clear();
    location.reload();
  }

  async function login(event) {
    event.preventDefault();
    elements.loginError.textContent = '';

    try {
      const response = await fetch(`${API_URL}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: elements.username.value,
          password: elements.password.value,
        }),
      });
      const data = await parseResponse(response);
      if (!response.ok) throw new Error(data.error || '로그인 실패');

      localStorage.setItem('hvsdcm.token', data.token);
      localStorage.setItem('hvsdcm.user', data.user.username);

      // 학습 콘텐츠 복원은 로그인 문서의 로드 경로(mountStudyContent → showUser →
      // setupReveal) 하나로 통일한다 — 로그아웃의 location.reload()와 대칭.
      // 제자리 주입으로 갈라놓으면 reveal 관찰·타이틀 복원을 여기서 중복 구현해야 한다.
      const nextPath = getSafeNextPath();
      if (nextPath) {
        location.assign(nextPath);
        return;
      }
      location.reload();
    } catch (error) {
      elements.loginError.textContent = error.message || '로그인 실패';
    }
  }

  // 스크롤 등장 — prefers-reduced-motion 환경에서는 숨김 자체를 만들지 않는다
  // (system.css의 .js .reveal 규칙이 no-preference 미디어쿼리 안에만 존재).
  function setupReveal() {
    document.documentElement.classList.add('js');
    const reveals = document.querySelectorAll('.reveal');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || !('IntersectionObserver' in window)) {
      reveals.forEach((element) => element.classList.add('in'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      }
    }, { rootMargin: '0px 0px -12% 0px' });
    reveals.forEach((element) => observer.observe(element));
  }

  elements.menuButton.addEventListener('click', () => {
    setMenuOpen(!elements.drawer.classList.contains('open'));
  });
  elements.shade.addEventListener('click', () => setMenuOpen(false));
  elements.loginTriggers.forEach((trigger) => trigger.addEventListener('click', openLogin));
  elements.closeLogin.addEventListener('click', closeLogin);
  elements.drawerLogout.addEventListener('click', logout);
  elements.loginForm.addEventListener('submit', login);
  elements.modal.addEventListener('click', (event) => {
    if (event.target === elements.modal) closeLogin();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setMenuOpen(false);
      closeLogin();
    }
  });

  paintEmoji(document);

  const savedUsername = localStorage.getItem('hvsdcm.user');
  const token = localStorage.getItem('hvsdcm.token');
  if (savedUsername && token) {
    mountStudyContent();
    showUser(savedUsername);
  }
  // reveal 관찰은 학습 콘텐츠 주입 이후에 시작해야 주입된 섹션도 등장 처리가 된다.
  setupReveal();
  if (new URLSearchParams(location.search).get('login') === '1' && !token) openLogin();
})();
