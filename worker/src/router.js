import {
  DAY_MS,
  authenticate,
  clientIp,
  createToken,
  issueSession,
  json,
  logActivity,
  normalizeAnswer,
  now,
  passwordHash,
  readJson,
  sha256,
} from './lib.js';

const MAX_PROGRESS_BYTES = 800_000;
// 사용량 스냅샷은 rate_limits 몇 개짜리 객체다. 상한이 없으면 ingest 토큰이 새거나
// 수집기 버그 하나로 D1 행이 무제한으로 부푼다.
const MAX_USAGE_BYTES = 64_000;
const SESSION_HISTORY_MS = 90 * DAY_MS;
const VALID_APPS = new Set(['wordmaster', 'smstudy']);
const VALID_USAGE_SOURCES = new Set(['codex', 'claude']);
const usageTokenEncoder = new TextEncoder();

async function login(request, env) {
  const input = await readJson(request);
  const username = String(input.username || '').trim();
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .bind(username)
    .first();

  const suppliedHash = user
    ? await passwordHash(String(input.password || ''), user.password_salt)
    : null;
  if (!user || user.disabled || suppliedHash !== user.password_hash) {
    return json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
  }

  const rawToken = await issueSession(env, user.id, 'user', request);
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(now(), user.id)
    .run();
  await logActivity(env, user.id, 'login');
  return json({ token: rawToken, user: { id: user.id, username: user.username } });
}

async function adminLogin(request, env) {
  const input = await readJson(request);
  if (!env.ADMIN_PASSWORD || String(input.password || '') !== env.ADMIN_PASSWORD) {
    return json({ error: '비밀번호가 올바르지 않습니다.' }, 401);
  }
  return json({ token: await issueSession(env, null, 'admin', request) });
}

function fixedTimeEqual(left, right) {
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(left, right);
  }

  // Node's Web Crypto test runtime does not expose the Workers extension.
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function usageTokenMatches(request, env) {
  const authorization = request.headers.get('authorization') || '';
  const supplied = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const expected = String(env.USAGE_INGEST_TOKEN || '');
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', usageTokenEncoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', usageTokenEncoder.encode(expected)),
  ]);
  const matches = fixedTimeEqual(new Uint8Array(suppliedHash), new Uint8Array(expectedHash));
  return Boolean(supplied && expected && matches);
}

async function reportUsage(request, env) {
  if (!(await usageTokenMatches(request, env))) {
    return json({ error: '인증이 필요합니다.' }, 401);
  }

  const body = await readJson(request);
  const input = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const source = String(input.source || '');
  const capturedAt = typeof input.captured_at === 'string' ? input.captured_at : '';
  const payloadIsObject = input.payload !== null
    && typeof input.payload === 'object'
    && !Array.isArray(input.payload);
  if (!VALID_USAGE_SOURCES.has(source)
    || !capturedAt
    || !Number.isFinite(Date.parse(capturedAt))
    || !payloadIsObject) {
    return json({ error: '잘못된 사용량 보고입니다.' }, 400);
  }

  const serialized = JSON.stringify(input.payload);
  if (serialized.length > MAX_USAGE_BYTES) {
    return json({ error: '사용량 보고가 너무 큽니다.' }, 413);
  }

  await env.DB.prepare(`
    INSERT INTO usage_snapshots(source, captured_at, payload)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(source)
    DO UPDATE SET captured_at = excluded.captured_at, payload = excluded.payload
  `).bind(source, capturedAt, serialized).run();
  return json({ ok: true });
}

async function usage(request, env) {
  const session = await authenticate(request, env);
  if (!session) return json({ error: '로그인이 필요합니다.' }, 401);

  const rows = await env.DB.prepare(`
    SELECT source, captured_at, payload
    FROM usage_snapshots
    ORDER BY source
  `).all();
  return json({
    snapshots: rows.results.map((row) => {
      // 손상된 행 하나가 조회 전체를 500으로 만들지 않게 한다 — 그 행만 payload를 낮춘다.
      let payload = null;
      try { payload = JSON.parse(row.payload); } catch { payload = null; }
      return { source: row.source, captured_at: row.captured_at, payload };
    }),
  });
}

async function logout(request, env) {
  const rawToken = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (rawToken) {
    const timestamp = now();
    const ipAddress = clientIp(request);
    await env.DB.prepare(`
      UPDATE sessions
      SET expires_at = ?, last_seen_at = ?, ip_hash = ?, ip_address = ?, user_agent = ?
      WHERE token_hash = ?
    `)
      .bind(
        timestamp,
        timestamp,
        await sha256(ipAddress),
        ipAddress,
        (request.headers.get('user-agent') || '').slice(0, 240),
        await sha256(rawToken),
      )
      .run();
  }
  return json({ ok: true });
}

async function progress(request, env, app) {
  const session = await authenticate(request, env);
  if (!session) return json({ error: '로그인이 필요합니다.' }, 401);

  if (request.method === 'GET') {
    const row = await env.DB.prepare(`
      SELECT data, updated_at
      FROM progress
      WHERE user_id = ? AND app = ?
    `).bind(session.user_id, app).first();
    return json({
      data: row ? JSON.parse(row.data) : null,
      updatedAt: row?.updated_at || 0,
    });
  }

  if (request.method === 'PUT') {
    const input = await readJson(request);
    const rawData = JSON.stringify(input.data ?? {});
    if (rawData.length > MAX_PROGRESS_BYTES) {
      return json({ error: '기록이 너무 큽니다.' }, 413);
    }

    await env.DB.prepare(`
      INSERT INTO progress(user_id, app, data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, app)
      DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).bind(session.user_id, app, rawData, now()).run();
    await logActivity(env, session.user_id, 'progress_sync', app);
    return json({ ok: true });
  }

  return null;
}

async function sharedAnswers(request, env, app) {
  const session = await authenticate(request, env);
  if (!session) return json({ error: '로그인이 필요합니다.' }, 401);

  const rows = await env.DB.prepare(`
    SELECT question_id, display_answer
    FROM shared_answers
    WHERE app = ?
    ORDER BY created_at
  `).bind(app).all();
  return json({ answers: rows.results });
}

async function acceptAnswer(request, env) {
  const session = await authenticate(request, env);
  if (!session) return json({ error: '로그인이 필요합니다.' }, 401);

  const input = await readJson(request);
  const app = String(input.app);
  const questionId = String(input.questionId || '');
  const answer = String(input.answer || '').trim();
  const questionLabel = String(input.questionLabel || '').trim().slice(0, 300);
  const baseAnswer = String(input.baseAnswer || '').trim().slice(0, 500);

  if (!VALID_APPS.has(app) || !questionId || !answer || answer.length > 200) {
    return json({ error: '잘못된 답안입니다.' }, 400);
  }

  await env.DB.prepare(`
    INSERT INTO shared_answers(
      app, question_id, normalized_answer, display_answer,
      created_by, created_at, question_label, base_answer
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(app, question_id, normalized_answer)
    DO UPDATE SET
      question_label = CASE
        WHEN excluded.question_label != '' THEN excluded.question_label
        ELSE shared_answers.question_label
      END,
      base_answer = CASE
        WHEN excluded.base_answer != '' THEN excluded.base_answer
        ELSE shared_answers.base_answer
      END
  `).bind(
    app,
    questionId,
    normalizeAnswer(answer),
    answer,
    session.user_id,
    now(),
    questionLabel,
    baseAnswer,
  ).run();

  await logActivity(env, session.user_id, 'shared_answer', app, questionId);
  return json({ ok: true });
}

async function listUsers(env) {
  const currentTime = now();
  const rows = await env.DB.prepare(`
    SELECT
      u.id,
      u.username,
      u.created_at,
      u.last_login_at,
      (
        SELECT MAX(activity_session.last_seen_at)
        FROM sessions activity_session
        WHERE activity_session.user_id = u.id
          AND activity_session.role = 'user'
      ) last_activity_at,
      u.disabled,
      COALESCE(SUM(CASE WHEN a.event = 'login' THEN 1 ELSE 0 END), 0) logins,
      COUNT(DISTINCT CASE WHEN a.app = 'wordmaster' THEN a.id END) word_events,
      COUNT(DISTINCT CASE WHEN a.app = 'smstudy' THEN a.id END) sm_events,
      (
        SELECT COUNT(DISTINCT
          COALESCE(active_session.user_agent, '') || '|' ||
          COALESCE(active_session.ip_address, active_session.ip_hash, '')
        )
        FROM sessions active_session
        WHERE active_session.user_id = u.id
          AND active_session.role = 'user'
          AND active_session.expires_at > ?
      ) active_devices,
      (
        SELECT recent_session.ip_address
        FROM sessions recent_session
        WHERE recent_session.user_id = u.id
          AND recent_session.role = 'user'
          AND recent_session.last_seen_at > ?
        ORDER BY recent_session.last_seen_at DESC
        LIMIT 1
      ) recent_ip
    FROM users u
    LEFT JOIN activity a ON a.user_id = u.id
    GROUP BY u.id
    ORDER BY u.id DESC
  `).bind(currentTime, currentTime - SESSION_HISTORY_MS).all();
  return json({ users: rows.results });
}

async function listSessions(env) {
  const currentTime = now();
  await env.DB.prepare('DELETE FROM sessions WHERE last_seen_at <= ?')
    .bind(currentTime - SESSION_HISTORY_MS)
    .run();
  const rows = await env.DB.prepare(`
    SELECT
      s.user_id,
      u.username,
      s.created_at,
      s.expires_at,
      s.last_seen_at,
      s.ip_address,
      SUBSTR(s.ip_hash, 1, 12) ip_fingerprint,
      s.user_agent
    FROM sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.role = 'user' AND s.last_seen_at > ?
    ORDER BY s.last_seen_at DESC
    LIMIT 500
  `).bind(currentTime - SESSION_HISTORY_MS).all();

  return json({
    sessions: rows.results.map((session) => ({
      ...session,
      active: session.expires_at > currentTime,
    })),
  });
}

async function createUser(request, env) {
  const input = await readJson(request);
  const username = String(input.username || '').trim();
  const password = String(input.password || '');
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || password.length < 6) {
    return json({ error: '아이디 형식 또는 비밀번호 길이를 확인하세요.' }, 400);
  }

  const salt = createToken();
  try {
    const result = await env.DB.prepare(`
      INSERT INTO users(username, password_hash, password_salt, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(username, await passwordHash(password, salt), salt, now()).run();
    return json({ ok: true, id: result.meta.last_row_id });
  } catch (error) {
    console.error('create_user', error);
    if (String(error?.message || error).includes('UNIQUE')) {
      return json({ error: '이미 존재하는 아이디입니다.' }, 409);
    }
    return json({ error: '사용자 생성에 실패했습니다.' }, 500);
  }
}

async function deleteUser(env, userId) {
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  return json({ ok: true });
}

async function adminStats(env) {
  const currentTime = now();
  const totals = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) users,
      (SELECT COUNT(*) FROM sessions WHERE expires_at > ${currentTime}) active_sessions,
      (SELECT COUNT(*) FROM activity WHERE created_at > ${currentTime - DAY_MS}) events_24h,
      (SELECT COUNT(*) FROM shared_answers) shared_answers,
      (
        SELECT COUNT(DISTINCT ip_address)
        FROM sessions
        WHERE role = 'user'
          AND ip_address IS NOT NULL
          AND ip_address != 'unknown'
          AND last_seen_at > ${currentTime - (30 * DAY_MS)}
      ) known_ips_30d
  `).first();
  const daily = await env.DB.prepare(`
    SELECT
      strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') day,
      COUNT(*) events,
      COUNT(DISTINCT user_id) users
    FROM activity
    WHERE created_at > ?
    GROUP BY day
    ORDER BY day
  `).bind(currentTime - (14 * DAY_MS)).all();
  return json({ totals, daily: daily.results });
}

async function adminAnswers(env) {
  const rows = await env.DB.prepare(`
    SELECT
      s.app,
      s.question_id,
      s.question_label,
      s.base_answer,
      s.display_answer,
      s.created_at,
      u.username
    FROM shared_answers s
    LEFT JOIN users u ON u.id = s.created_by
    ORDER BY s.created_at DESC
    LIMIT 500
  `).all();
  return json({ answers: rows.results });
}

async function adminRoute(request, env, path) {
  const session = await authenticate(request, env, 'admin');
  if (!session) return json({ error: '관리자 로그인이 필요합니다.' }, 401);

  if (request.method === 'GET' && path === '/api/admin/users') return listUsers(env);
  if (request.method === 'POST' && path === '/api/admin/users') return createUser(request, env);

  const userMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userMatch && request.method === 'DELETE') {
    return deleteUser(env, Number(userMatch[1]));
  }

  if (request.method === 'GET' && path === '/api/admin/stats') return adminStats(env);
  if (request.method === 'GET' && path === '/api/admin/sessions') return listSessions(env);
  if (request.method === 'GET' && path === '/api/admin/answers') return adminAnswers(env);
  return null;
}

export async function route(request, env) {
  const path = new URL(request.url).pathname;
  const { method } = request;

  if (method === 'POST' && path === '/api/login') return login(request, env);
  if (method === 'POST' && path === '/api/admin/login') return adminLogin(request, env);

  if (method === 'GET' && path === '/api/me') {
    const session = await authenticate(request, env);
    return session
      ? json({ user: { id: session.user_id, username: session.username } })
      : json({ error: '로그인이 필요합니다.' }, 401);
  }

  if (method === 'POST' && path === '/api/logout') return logout(request, env);
  if (method === 'POST' && path === '/api/usage/report') return reportUsage(request, env);
  if (method === 'GET' && path === '/api/usage') return usage(request, env);

  const progressMatch = path.match(/^\/api\/progress\/(wordmaster|smstudy)$/);
  if (progressMatch) {
    const response = await progress(request, env, progressMatch[1]);
    if (response) return response;
  }

  const answersMatch = path.match(/^\/api\/answers\/(wordmaster|smstudy)$/);
  if (answersMatch && method === 'GET') {
    return sharedAnswers(request, env, answersMatch[1]);
  }

  if (method === 'POST' && path === '/api/answers/accept') {
    return acceptAnswer(request, env);
  }

  if (path.startsWith('/api/admin/')) {
    const response = await adminRoute(request, env, path);
    if (response) return response;
  }

  return json({ error: 'Not found' }, 404);
}
