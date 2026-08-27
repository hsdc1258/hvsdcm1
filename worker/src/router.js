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
const MAX_HARNESS_BYTES = 64_000;
const SESSION_HISTORY_MS = 90 * DAY_MS;
const VALID_APPS = new Set(['wordmaster', 'smstudy']);
// 수집 원본. 이 집합이 ingest 허용 목록이자 조회 필터의 단일 원본이다 — 한쪽만 고치면
// 받아 놓고 못 읽는(또는 그 반대의) 상태가 생긴다.
const VALID_USAGE_SOURCES = new Set(['codex', 'claude']);
const VALID_HARNESS_PHASES = new Set(['plan', 'work', 'review', 'done']);
const VALID_HARNESS_TASK_STATES = new Set(['active', 'complete']);
const VALID_HARNESS_ACTOR_KINDS = new Set(['codex', 'webgpt', 'claude']);
const VALID_HARNESS_ACTOR_STATES = new Set([
  'working', 'reviewing', 'waiting', 'done', 'blocked', 'unavailable',
]);
const VALID_HARNESS_REASONING = new Set([
  '', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);
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

async function ingestTokenMatches(request, expectedValue) {
  const authorization = request.headers.get('authorization') || '';
  const supplied = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  const expected = String(expectedValue || '');
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', usageTokenEncoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', usageTokenEncoder.encode(expected)),
  ]);
  const matches = fixedTimeEqual(new Uint8Array(suppliedHash), new Uint8Array(expectedHash));
  return Boolean(supplied && expected && matches);
}

async function reportUsage(request, env) {
  if (!(await ingestTokenMatches(request, env.USAGE_INGEST_TOKEN))) {
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

function harnessText(value, maxLength, required = false) {
  if (typeof value !== 'string') return required ? null : '';
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if ((required && !normalized) || normalized.length > maxLength) return null;
  return normalized;
}

function normalizeHarnessReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.version !== 1) return null;
  const taskId = harnessText(input.task_id, 120, true);
  const occurredAt = harnessText(input.occurred_at, 40, true);
  const task = input.task;
  const actors = input.actors;
  const artifacts = input.artifacts;
  const modules = input.modules === undefined ? [] : input.modules;
  if (!taskId || !occurredAt || !Number.isFinite(Date.parse(occurredAt))) return null;
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
  if (!Array.isArray(actors) || actors.length < 1 || actors.length > 20) return null;
  if (!Array.isArray(modules) || modules.length > 20) return null;
  if (!Array.isArray(artifacts) || artifacts.length > 10) return null;

  const phase = harnessText(task.phase, 16, true);
  const status = harnessText(task.status, 16, true);
  const reasoning = harnessText(task.reasoning, 20);
  const categoryKey = task.category_key === undefined
    ? 'general'
    : harnessText(task.category_key, 60, true);
  const category = task.category === undefined
    ? '기타 Codex 작업'
    : harnessText(task.category, 80, true);
  const progress = Number(task.progress);
  const normalizedTask = {
    name: harnessText(task.name, 120, true),
    phase,
    progress,
    status,
    model: harnessText(task.model, 120, true),
    reasoning,
    category_key: categoryKey,
    category,
    current: harnessText(task.current, 240),
    done: harnessText(task.done, 240),
    next: harnessText(task.next, 240),
    deadline: harnessText(task.deadline, 80),
  };
  if (Object.values(normalizedTask).some((value) => value === null)
    || !VALID_HARNESS_PHASES.has(phase)
    || !VALID_HARNESS_TASK_STATES.has(status)
    || !VALID_HARNESS_REASONING.has(reasoning)
    || !/^[\p{L}\p{N}][\p{L}\p{N}-]*$/u.test(normalizedTask.category_key)
    || !Number.isFinite(progress)
    || progress < 0
    || progress > 100) return null;

  const normalizedActors = [];
  const ids = new Set();
  for (const actor of actors) {
    if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return null;
    const normalized = {
      id: harnessText(actor.id, 120, true),
      parent_id: harnessText(actor.parent_id, 120),
      name: harnessText(actor.name, 80, true),
      kind: harnessText(actor.kind, 16, true),
      model: harnessText(actor.model, 120, true),
      reasoning: harnessText(actor.reasoning, 20),
      role: harnessText(actor.role, 120),
      status: harnessText(actor.status, 20, true),
      assignment: harnessText(actor.assignment, 240),
      ...(actor.progress === undefined ? {} : { progress: Number(actor.progress) }),
    };
    if (Object.values(normalized).some((value) => value === null)
      || ids.has(normalized.id)
      || !VALID_HARNESS_ACTOR_KINDS.has(normalized.kind)
      || !VALID_HARNESS_REASONING.has(normalized.reasoning)
      || !VALID_HARNESS_ACTOR_STATES.has(normalized.status)
      || (normalized.progress !== undefined
        && (!Number.isFinite(normalized.progress) || normalized.progress < 0 || normalized.progress > 100))) return null;
    ids.add(normalized.id);
    normalizedActors.push(normalized);
  }

  const normalizedModules = [];
  const moduleIds = new Set();
  for (const module of modules) {
    if (!module || typeof module !== 'object' || Array.isArray(module)) return null;
    const normalized = {
      id: harnessText(module.id, 120, true),
      name: harnessText(module.name, 120, true),
      progress: Number(module.progress),
      status: harnessText(module.status, 20, true),
      owner: harnessText(module.owner, 80),
    };
    if (Object.values(normalized).some((value) => value === null)
      || moduleIds.has(normalized.id)
      || !Number.isFinite(normalized.progress)
      || normalized.progress < 0
      || normalized.progress > 100
      || !VALID_HARNESS_ACTOR_STATES.has(normalized.status)) return null;
    moduleIds.add(normalized.id);
    normalizedModules.push(normalized);
  }

  const normalizedArtifacts = artifacts.map((artifact) => harnessText(artifact, 180, true));
  if (normalizedArtifacts.some((artifact) => artifact === null)) return null;
  // resume은 terminal(complete) 태스크를 다시 여는 **명시적** 신호다. 빠뜨린 필드와
  // 오타를 구분하려고 boolean만 받는다 ('true' 같은 문자열은 400).
  if (input.resume !== undefined && typeof input.resume !== 'boolean') return null;
  return {
    version: 1,
    task_id: taskId,
    // 시각은 정규 ISO(UTC)로 통일한다. updated_at은 payload 비교(JS)와 D1 컬럼 비교(문자열)
    // 양쪽에서 순서 판정에 쓰이므로, 오프셋 표기가 섞이면 사전순 비교가 뒤집힌다.
    occurred_at: new Date(occurredAt).toISOString(),
    resume: input.resume === true,
    task: normalizedTask,
    actors: normalizedActors,
    modules: normalizedModules,
    artifacts: normalizedArtifacts,
  };
}

export function mergeHarnessReport(previous, incoming) {
  const current = previous && typeof previous === 'object' ? previous : {};
  const actorMap = new Map(
    Array.isArray(current.actors) ? current.actors.map((actor) => [actor.id, actor]) : [],
  );
  for (const actor of incoming.actors) {
    actorMap.set(actor.id, { ...actorMap.get(actor.id), ...actor, updated_at: incoming.occurred_at });
  }
  const moduleMap = new Map(
    Array.isArray(current.modules) ? current.modules.map((module) => [module.id, module]) : [],
  );
  for (const module of incoming.modules) {
    moduleMap.set(module.id, { ...moduleMap.get(module.id), ...module, updated_at: incoming.occurred_at });
  }
  let actors = [...actorMap.values()];
  let modules = [...moduleMap.values()];
  // terminal 보호 — 이미 complete로 잠긴 태스크는 늦게 도착한 진행 보고 하나로 되살아나지
  // 않는다. 되살리려면 보고가 resume:true를 명시해야 한다 (review M-A1).
  const terminalHold = current.status === 'complete'
    && incoming.task.status !== 'complete'
    && incoming.resume !== true;
  if (terminalHold || incoming.task.status === 'complete') {
    actors = actors.map((actor) => ({
      ...actor,
      status: actor.status === 'unavailable' ? actor.status : 'done',
      ...(actor.progress === undefined || actor.status === 'unavailable' ? {} : { progress: 100 }),
    }));
    modules = modules.map((module) => ({ ...module, status: 'done', progress: 100 }));
  }
  return {
    version: 1,
    ...current,
    ...incoming.task,
    // 잠긴 태스크의 머리글 수치(상태·단계·진행률)는 늦은 보고를 따라 뒤로 가지 않는다.
    ...(terminalHold ? {
      status: 'complete',
      phase: current.phase || incoming.task.phase,
      progress: Number.isFinite(current.progress) ? current.progress : incoming.task.progress,
    } : {}),
    id: incoming.task_id,
    created_at: current.created_at || incoming.occurred_at,
    updated_at: incoming.occurred_at,
    actors,
    modules,
    artifacts: [...new Set([...(current.artifacts || []), ...incoming.artifacts])].slice(-10),
  };
}

async function reportHarness(request, env) {
  if (!(await ingestTokenMatches(request, env.HARNESS_INGEST_TOKEN))) {
    return json({ error: '인증이 필요합니다.' }, 401);
  }
  const rawBody = await request.text();
  if (usageTokenEncoder.encode(rawBody).byteLength > MAX_HARNESS_BYTES) {
    return json({ error: '하네스 보고가 너무 큽니다.' }, 413);
  }
  let body = {};
  try { body = JSON.parse(rawBody); } catch { body = {}; }
  const incoming = normalizeHarnessReport(body);
  if (!incoming) return json({ error: '잘못된 하네스 보고입니다.' }, 400);

  const row = await env.DB.prepare('SELECT payload FROM harness_tasks WHERE task_id = ?1')
    .bind(incoming.task_id)
    .first();
  let previous = null;
  try { previous = row?.payload ? JSON.parse(row.payload) : null; } catch { previous = null; }
  // 늦게 도착한 과거 보고는 저장하지 않는다 — SELECT→merge→UPSERT 사이에 더 새로운
  // 보고가 들어왔다면 그 위에 옛 상태를 덮어쓰는 셈이 된다 (review M-A1).
  // 같은 시각(재전송·동시 보고)은 통과시킨다: 병합이 멱등이라 손실이 없다.
  const storedAt = Date.parse(previous?.updated_at ?? '');
  if (Number.isFinite(storedAt) && Date.parse(incoming.occurred_at) < storedAt) {
    return json({ ok: true, task_id: incoming.task_id, stale: true });
  }
  const mergedActorIds = new Set([
    ...(Array.isArray(previous?.actors) ? previous.actors : []),
    ...incoming.actors,
  ].map((actor) => actor?.id).filter(Boolean));
  if (mergedActorIds.size > 20) {
    return json({ error: '하네스 실행자가 너무 많습니다.' }, 400);
  }
  const mergedModuleIds = new Set([
    ...(Array.isArray(previous?.modules) ? previous.modules : []),
    ...incoming.modules,
  ].map((module) => module?.id).filter(Boolean));
  if (mergedModuleIds.size > 20) {
    return json({ error: '하네스 모듈이 너무 많습니다.' }, 400);
  }
  const merged = mergeHarnessReport(previous, incoming);
  await env.DB.prepare(`
    INSERT INTO harness_tasks(task_id, status, updated_at, payload)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(task_id)
    DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload
    WHERE excluded.updated_at >= harness_tasks.updated_at
  `).bind(incoming.task_id, merged.status, merged.updated_at, JSON.stringify(merged)).run();
  return json({ ok: true, task_id: incoming.task_id });
}

// 사용량은 소유자 한 사람의 운영 데이터다. 소유자 이름은 wrangler.toml의
// vars.OWNER_USERNAME 하나가 원본이고 코드에 적지 않는다 — 값이 없으면 아무도 통과하지
// 못한다(fail-closed). 세션의 username은 users 테이블에서 조인된 값이다(lib.js).
function isOwnerSession(session, env) {
  const owner = String(env.OWNER_USERNAME || '').trim().toLowerCase();
  const username = String(session?.username || '').trim().toLowerCase();
  return owner.length > 0 && username === owner;
}

async function usage(request, env) {
  const session = await authenticate(request, env);
  if (!session) return json({ error: '로그인이 필요합니다.' }, 401);
  // 비소유자에게는 **존재를 숨긴다** — 라우트가 없을 때와 같은 404를 준다.
  // 403이면 "여기 뭔가 있다"는 사실이 새어 나간다 (review WP1 M-5).
  if (!isOwnerSession(session, env)) return json({ error: 'Not found' }, 404);

  // 필터 목록을 손으로 적지 않는다 — ingest 허용 집합에서 그대로 도출한다.
  const sources = [...VALID_USAGE_SOURCES];
  const rows = await env.DB.prepare(`
    SELECT source, captured_at, payload
    FROM usage_snapshots
    WHERE source IN (${sources.map(() => '?').join(', ')})
    ORDER BY source
  `).bind(...sources).all();
  const taskRows = await env.DB.prepare(`
    SELECT task_id, status, updated_at, payload
    FROM harness_tasks
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC
  `).all();
  return json({
    snapshots: rows.results.filter((row) => VALID_USAGE_SOURCES.has(row.source)).map((row) => {
      // 손상된 행 하나가 조회 전체를 500으로 만들지 않게 한다 — 그 행만 payload를 낮춘다.
      let payload = null;
      try { payload = JSON.parse(row.payload); } catch { payload = null; }
      return { source: row.source, captured_at: row.captured_at, payload };
    }),
    tasks: taskRows.results.flatMap((row) => {
      try {
        const payload = JSON.parse(row.payload);
        return payload && typeof payload === 'object' ? [payload] : [];
      } catch {
        return [];
      }
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
  if (method === 'POST' && path === '/api/harness/report') return reportHarness(request, env);
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
