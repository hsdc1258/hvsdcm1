(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;

  const elements = {
    account: document.getElementById('account'),
    closeLogin: document.getElementById('closeLogin'),
    drawer: document.getElementById('drawer'),
    drawerLogout: document.getElementById('drawerLogout'),
    drawerStudy: document.getElementById('drawerStudy'),
    loginButton: document.getElementById('loginBtn'),
    loginError: document.getElementById('loginError'),
    loginForm: document.getElementById('loginForm'),
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
    prefix.textContent = 'W3lc0m3,';
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
    elements.drawerStudy.setAttribute('aria-hidden', 'false');
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
      showUser(data.user.username);
      closeLogin();

      const nextPath = getSafeNextPath();
      if (nextPath) location.assign(nextPath);
    } catch (error) {
      elements.loginError.textContent = error.message || '로그인 실패';
    }
  }

  elements.menuButton.addEventListener('click', () => {
    setMenuOpen(!elements.drawer.classList.contains('open'));
  });
  elements.shade.addEventListener('click', () => setMenuOpen(false));
  elements.loginButton.addEventListener('click', openLogin);
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

  const savedUsername = localStorage.getItem('hvsdcm.user');
  const token = localStorage.getItem('hvsdcm.token');
  if (savedUsername && token) showUser(savedUsername);
  if (new URLSearchParams(location.search).get('login') === '1' && !token) openLogin();
})();
