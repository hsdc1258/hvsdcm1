(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const SYNC_DELAY_MS = 350;
  const script = document.currentScript;
  const app = script?.dataset.app;
  const storageKey = script?.dataset.key;
  const apiUrl = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;

  if (!app || !storageKey) return;

  function loginPath() {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return `/?login=1&next=${next}`;
  }

  function authorizationHeaders() {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${localStorage.getItem('hvsdcm.token') || ''}`,
    };
  }

  async function api(path, options = {}) {
    const response = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers: {
        ...authorizationHeaders(),
        ...(options.headers || {}),
      },
    });

    if (response.status === 401) {
      localStorage.removeItem('hvsdcm.token');
      location.replace(loginPath());
      throw new Error('unauthorized');
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'sync failed');
    return data;
  }

  if (!localStorage.getItem('hvsdcm.token')) {
    location.replace(loginPath());
    return;
  }

  function collectAliases(data) {
    const aliases = [];
    for (const [questionId, values] of Object.entries(data?.customAliases || {})) {
      if (!Array.isArray(values)) continue;
      for (const answer of values) aliases.push({ questionId, answer });
    }
    return aliases;
  }

  let syncTimer = 0;

  async function pushProgress(rawData) {
    try {
      const data = JSON.parse(rawData);
      await api(`/api/progress/${app}`, {
        method: 'PUT',
        body: JSON.stringify({ data }),
      });

      // 사용자가 추가한 허용 답안은 계정 간에도 공유되므로 별도 테이블에 동기화한다.
      await Promise.all(collectAliases(data).map(({ questionId, answer }) => api('/api/answers/accept', {
        method: 'POST',
        body: JSON.stringify({ app, questionId, answer }),
      })));
    } catch (error) {
      if (error.message !== 'unauthorized') console.warn('Account sync delayed');
    }
  }

  function scheduleProgressSync(rawData) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => pushProgress(rawData), SYNC_DELAY_MS);
  }

  // 학습 앱이 저장을 마친 시점에만 명시적으로 호출한다. 브라우저 전체의
  // Storage 프로토타입을 변경하지 않아 다른 기능의 저장 동작과 격리된다.
  window.HvsAccount = { api, app, scheduleProgressSync };

  async function hydrateFromAccount() {
    try {
      const [remote, shared] = await Promise.all([
        api(`/api/progress/${app}`),
        api(`/api/answers/${app}`),
      ]);
      let data = remote.data;

      if (!data) {
        const local = localStorage.getItem(storageKey);
        data = local ? JSON.parse(local) : null;
        if (data) {
          await api(`/api/progress/${app}`, {
            method: 'PUT',
            body: JSON.stringify({ data }),
          });
        }
      }

      if (data) {
        data.customAliases ||= {};
        for (const row of shared.answers || []) {
          const aliases = data.customAliases[row.question_id] ||= [];
          if (!aliases.includes(row.display_answer)) aliases.push(row.display_answer);
        }

        const next = JSON.stringify(data);
        if (localStorage.getItem(storageKey) !== next) {
          localStorage.setItem(storageKey, next);
          const loadMarker = `hvsdcm.loaded.${app}`;
          if (!sessionStorage.getItem(loadMarker)) {
            sessionStorage.setItem(loadMarker, '1');
            location.reload();
          }
        }
      }

      document.documentElement.dataset.accountReady = 'true';
    } catch {
      console.warn('Using cached study data');
    }
  }

  hydrateFromAccount();
})();
