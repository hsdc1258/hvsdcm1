(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const SYNC_DELAY_MS = 350;
  const script = document.currentScript;
  const app = script?.dataset.app;
  const storageKey = script?.dataset.key;
  const apiUrl = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;

  // data-key가 없으면 **게이트 전용 모드**다: 로그인 리다이렉트와 인증 fetch만 제공하고
  // 진도 동기화는 하지 않는다. 기출(/gichul/)처럼 계정에 저장할 학습 진도가 없는 화면이
  // 여기에 해당한다 — 없는 진도를 /api/progress/<app>에 밀면 Worker의 VALID_APPS에 없는
  // 앱 이름이라 404가 나고, 화면은 매번 실패한 동기화를 콘솔에 남긴다.
  if (!app) return;
  const syncsProgress = Boolean(storageKey);

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

  // 인증 요청의 단일 원본. 401이면 로컬 세션을 버리고 랜딩으로 되돌린다.
  // 본문을 JSON으로 읽지 않고 Response를 그대로 돌려주므로 PDF 같은 바이너리도
  // 같은 세션 규칙을 지나갈 수 있다 (기출 병합이 이것을 쓴다).
  async function request(path, options = {}) {
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

    return response;
  }

  async function api(path, options = {}) {
    const response = await request(path, options);
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
  window.HvsAccount = { api, request, app, scheduleProgressSync };

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

  if (syncsProgress) hydrateFromAccount();
  else document.documentElement.dataset.accountReady = 'true';
})();
