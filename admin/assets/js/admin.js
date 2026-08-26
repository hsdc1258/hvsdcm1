(() => {
  'use strict';

  const DEFAULT_API_URL = 'https://hvsdcm-api.hvsdcm1.workers.dev';
  const API_URL = localStorage.getItem('hvsdcm.api') || DEFAULT_API_URL;
  let adminToken = sessionStorage.getItem('hvsdcm.admin') || '';

  const elements = {
    addUserForm: document.getElementById('addUser'),
    adminLoginForm: document.getElementById('adminLogin'),
    adminPassword: document.getElementById('adminPassword'),
    answers: document.getElementById('answers'),
    login: document.getElementById('login'),
    loginError: document.getElementById('loginError'),
    newPassword: document.getElementById('newPassword'),
    newUsername: document.getElementById('newUsername'),
    panel: document.getElementById('panel'),
    sessionCard: document.getElementById('sessionCard'),
    sessionCount: document.getElementById('sessionCount'),
    sessions: document.getElementById('sessions'),
    sessionUserFilter: document.getElementById('sessionUserFilter'),
    stats: document.getElementById('stats'),
    userError: document.getElementById('userError'),
    users: document.getElementById('users'),
  };
  let sessionRows = [];

  const escapeHtml = (value) => String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character],
  );

  // 표는 시각 열이 6개다. ko-KR 로케일 문자열("2026. 8. 26. 오후 3:24:15")은 열마다
  // 20자를 넘겨 표 전체를 가로로 밀어냈다. 정렬 가능한 고정폭 표기로 줄인다.
  const pad2 = (value) => String(value).padStart(2, '0');
  const formatDate = (timestamp) => {
    if (!timestamp) return '-';
    const at = new Date(timestamp);
    if (Number.isNaN(at.getTime())) return '-';
    return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  };

  function describeUserAgent(userAgent) {
    const value = String(userAgent || '');
    let os = '알 수 없는 OS';
    let browser = '알 수 없는 브라우저';
    let device = /Mobile|Android|iPhone|iPod/i.test(value) ? '모바일' : 'PC';

    if (/iPad/i.test(value)) device = '태블릿';
    if (/Windows NT/i.test(value)) os = 'Windows';
    else if (/Android/i.test(value)) os = 'Android';
    else if (/iPhone|iPad|iPod/i.test(value)) os = 'iOS/iPadOS';
    else if (/Mac OS X|Macintosh/i.test(value)) os = 'macOS';
    else if (/Linux/i.test(value)) os = 'Linux';

    if (/Edg\//i.test(value)) browser = 'Edge';
    else if (/SamsungBrowser\//i.test(value)) browser = 'Samsung Internet';
    else if (/OPR\//i.test(value)) browser = 'Opera';
    else if (/CriOS|Chrome\//i.test(value)) browser = 'Chrome';
    else if (/FxiOS|Firefox\//i.test(value)) browser = 'Firefox';
    else if (/Safari\//i.test(value)) browser = 'Safari';

    return { browser, device: `${device} · ${os}` };
  }

  async function request(path, options = {}) {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminToken}`,
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '요청 실패');
    return data;
  }

  function renderStats(totals) {
    // 설명은 한 줄로 줄인다 — 타일 5장에 두 줄짜리 설명이 붙어 요약 줄이 본문만큼 컸다.
    const cards = [
      ['사용자', totals.users, '등록된 일반 계정'],
      ['활성 세션', totals.active_sessions, '만료 전 로그인 토큰'],
      ['24시간 이벤트', totals.events_24h, '로그인·동기화·정답 등록'],
      ['30일 IP', totals.known_ips_30d, '확인된 고유 IP'],
      ['공용 정답', totals.shared_answers, '전 계정에 적용된 답안'],
    ];

    elements.stats.innerHTML = cards.map(([label, value, description]) => `
      <article class="ad-stat">
        <span class="stat-label">${escapeHtml(label)}</span>
        <span class="stat-value">${Number(value).toLocaleString()}</span>
        <p class="ad-stat-note">${escapeHtml(description)}</p>
      </article>
    `).join('');
  }

  function renderUsers(users) {
    elements.users.innerHTML = users.map((user) => `
      <tr>
        <td>${escapeHtml(user.username)}</td>
        <td>${formatDate(user.created_at)}</td>
        <td>${formatDate(user.last_login_at)}</td>
        <td>${formatDate(user.last_activity_at)}</td>
        <td class="ad-n">${Number(user.active_devices).toLocaleString()}</td>
        <td class="ad-ip">${escapeHtml(user.recent_ip || '-')}</td>
        <td class="ad-n">${Number(user.logins).toLocaleString()}</td>
        <td class="ad-n">${Number(user.word_events).toLocaleString()}</td>
        <td class="ad-n">${Number(user.sm_events).toLocaleString()}</td>
        <td>
          <div class="ad-row-actions">
            <button type="button" class="btn btn-secondary btn-sm view-sessions" data-id="${Number(user.id)}">접속</button>
            <button
              type="button"
              class="btn btn-danger btn-sm delete-user"
              data-id="${Number(user.id)}"
              data-name="${escapeHtml(user.username)}"
            >삭제</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  function renderSessionFilter(users) {
    const previousValue = elements.sessionUserFilter.value;
    elements.sessionUserFilter.innerHTML = [
      '<option value="all">전체 사용자</option>',
      ...users.map((user) => `<option value="${Number(user.id)}">${escapeHtml(user.username)}</option>`),
    ].join('');
    if ([...elements.sessionUserFilter.options].some((option) => option.value === previousValue)) {
      elements.sessionUserFilter.value = previousValue;
    }
  }

  function renderSessions() {
    const selectedUserId = elements.sessionUserFilter.value;
    const filtered = selectedUserId === 'all'
      ? sessionRows
      : sessionRows.filter((session) => String(session.user_id) === selectedUserId);
    const activeCount = filtered.filter((session) => session.active).length;
    elements.sessionCount.textContent = `${filtered.length.toLocaleString()}개 세션 · 활성 ${activeCount.toLocaleString()}개`;

    if (filtered.length === 0) {
      elements.sessions.innerHTML = '<tr><td colspan="8" class="ad-empty">조건에 맞는 접속 기록이 없습니다.</td></tr>';
      return;
    }

    elements.sessions.innerHTML = filtered.map((session) => {
      const userAgent = describeUserAgent(session.user_agent);
      const ip = session.ip_address && session.ip_address !== 'unknown'
        ? session.ip_address
        : session.ip_fingerprint
          ? `기존 해시 ${session.ip_fingerprint}`
          : '-';
      return `
        <tr>
          <td><span class="badge ${session.active ? 'badge-green' : ''}">${session.active ? '활성' : '만료'}</span></td>
          <td>${escapeHtml(session.username)}</td>
          <td><div class="ad-device"><strong>${escapeHtml(userAgent.device)}</strong><small title="${escapeHtml(session.user_agent || '')}">${escapeHtml(session.user_agent || 'User-Agent 없음')}</small></div></td>
          <td>${escapeHtml(userAgent.browser)}</td>
          <td class="ad-ip">${escapeHtml(ip)}</td>
          <td>${formatDate(session.created_at)}</td>
          <td>${formatDate(session.last_seen_at)}</td>
          <td>${formatDate(session.expires_at)}</td>
        </tr>
      `;
    }).join('');
  }

  function renderAnswers(answers) {
    if (answers.length === 0) {
      elements.answers.innerHTML = '<tr><td colspan="6" class="ad-empty">아직 추가된 공용 정답이 없습니다.</td></tr>';
      return;
    }

    elements.answers.innerHTML = answers.map((answer) => `
      <tr>
        <td>${answer.app === 'wordmaster' ? '영단어' : '사회문화'}</td>
        <td>${escapeHtml(answer.question_label || answer.question_id)}</td>
        <td>${escapeHtml(answer.username || '삭제된 사용자')}</td>
        <td>${escapeHtml(answer.base_answer || '-')}</td>
        <td>${escapeHtml(answer.display_answer)}</td>
        <td>${formatDate(answer.created_at)}</td>
      </tr>
    `).join('');
  }

  async function loadDashboard() {
    const [userData, statsData, answerData, sessionData] = await Promise.all([
      request('/api/admin/users'),
      request('/api/admin/stats'),
      request('/api/admin/answers'),
      request('/api/admin/sessions'),
    ]);

    elements.login.classList.add('hidden');
    elements.panel.classList.remove('hidden');
    renderStats(statsData.totals);
    renderUsers(userData.users);
    sessionRows = sessionData.sessions;
    renderSessionFilter(userData.users);
    renderSessions();
    renderAnswers(answerData.answers);
  }

  elements.adminLoginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.loginError.textContent = '';
    try {
      const data = await request('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: elements.adminPassword.value }),
      });
      adminToken = data.token;
      sessionStorage.setItem('hvsdcm.admin', adminToken);
      await loadDashboard();
    } catch (error) {
      elements.loginError.textContent = error.message || '로그인 실패';
    }
  });

  elements.addUserForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.userError.textContent = '';
    try {
      await request('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: elements.newUsername.value,
          password: elements.newPassword.value,
        }),
      });
      event.currentTarget.reset();
      await loadDashboard();
    } catch (error) {
      elements.userError.textContent = error.message || '사용자 생성 실패';
    }
  });

  elements.users.addEventListener('click', async (event) => {
    const sessionButton = event.target.closest('.view-sessions');
    if (sessionButton) {
      elements.sessionUserFilter.value = sessionButton.dataset.id;
      renderSessions();
      elements.sessionCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const button = event.target.closest('.delete-user');
    if (!button) return;

    const { id, name } = button.dataset;
    if (!/^\d+$/.test(id) || !confirm(`${name} 계정과 모든 학습 기록을 삭제할까요?`)) return;

    button.disabled = true;
    elements.userError.textContent = '';
    try {
      await request(`/api/admin/users/${id}`, { method: 'DELETE' });
      await loadDashboard();
    } catch (error) {
      button.disabled = false;
      elements.userError.textContent = `삭제 실패: ${error.message}`;
    }
  });

  elements.sessionUserFilter.addEventListener('change', renderSessions);

  if (adminToken) {
    loadDashboard().catch(() => {
      adminToken = '';
      sessionStorage.removeItem('hvsdcm.admin');
    });
  }
})();
