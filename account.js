(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const SYNC_DELAY_MS = 350;
  const script = document.currentScript;
  const app = script?.dataset.app;
  const storageKey = script?.dataset.key;
  const apiUrl = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;
  const originalStorageSet = Storage.prototype.setItem;
  const originalStorageRemove = Storage.prototype.removeItem;

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

  // 두 학습 앱은 localStorage를 저장 인터페이스로 사용한다. 해당 키 변경만 감지해 서버에 보낸다.
  Storage.prototype.setItem = function setItem(key, value) {
    originalStorageSet.call(this, key, value);
    if (this === localStorage && key === storageKey) scheduleProgressSync(value);
  };

  Storage.prototype.removeItem = function removeItem(key) {
    originalStorageRemove.call(this, key);
    if (this === localStorage && key === storageKey) scheduleProgressSync('{}');
  };

  window.HvsAccount = { api, app };

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
          // 원격 데이터를 쓰는 동안 저장 감시기가 다시 서버에 올리지 않도록 원본 메서드를 쓴다.
          originalStorageSet.call(localStorage, storageKey, next);
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
