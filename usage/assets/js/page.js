(() => {
  'use strict';
  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;
  const token = localStorage.getItem('hvsdcm.token') || '';
  const REQUEST_TIMEOUT_MS = 15_000;

  function loginPath() {
    const root = location.pathname.startsWith('/hvsdcm1/') ? '/hvsdcm1/' : '/';
    return `${root}?login=1`;
  }
  if (!token) {
    location.replace(loginPath());
    return;
  }
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}${path}`, {
        ...options,
        headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) },
        signal: controller.signal,
      });
      if (response.status === 401) {
        localStorage.removeItem('hvsdcm.token');
        localStorage.removeItem('hvsdcm.user');
        location.replace(loginPath());
        throw new Error('unauthorized');
      }
      if (!response.ok) {
        const error = new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const data = await response.json();
      if (path === '/api/competitions') document.title = '공모전 — hvsdcm';
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('요청 시간이 초과되었습니다.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  const dashboard = window.COMPETITION_UI?.createDashboard?.({ request });
  dashboard?.activate();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) dashboard?.deactivate();
    else dashboard?.activate();
  });
  window.COMPETITION_PAGE = { request, dashboard };
})();
