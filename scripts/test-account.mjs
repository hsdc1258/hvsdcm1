#!/usr/bin/env node
// 에이전트 전용 테스트 계정(claude-test)을 Claude·Codex 어느 쪽에서든 같은 방법으로 쓴다.
//
// 자격증명은 저장소에 없다. 단일 원본은 Codex 워크스페이스의 `config/credentials.json`이고
// 그 파일은 거기 .gitignore(`config/*.json`)에 걸려 있다. 경로를 코드에 박지 않는 이유는
// 기기마다 바탕화면 경로가 다르기 때문이다 — 이 체크아웃 기준 상대 경로로 찾고,
// 다르면 HVSDCM_CREDENTIALS 환경변수로 덮어쓴다.
//
//   node scripts/test-account.mjs               사용자 토큰을 새로 받아 출력
//   node scripts/test-account.mjs --admin-token  /admin용 관리자 토큰 출력
//   node scripts/test-account.mjs --check        세 표면(user·usage·admin)을 실제로 두드림
//   node scripts/test-account.mjs --renew-admin  만료된 관리자 세션 재발급 (wrangler 필요)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CREDENTIALS = path.resolve(repoRoot, '..', '..', 'config', 'credentials.json');
const credentialsPath = process.env.HVSDCM_CREDENTIALS || DEFAULT_CREDENTIALS;

function loadCredentials() {
  try {
    return JSON.parse(readFileSync(credentialsPath, 'utf8')).hvsdcm1;
  } catch (error) {
    console.error(`자격증명을 읽지 못했다: ${credentialsPath}`);
    console.error('HVSDCM_CREDENTIALS로 경로를 지정하거나 Codex 워크스페이스의 config/credentials.json을 확인하라.');
    console.error(String(error?.message || error));
    process.exit(2);
  }
}

const credentials = loadCredentials();

async function userToken() {
  const response = await fetch(`${credentials.api}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: credentials.user.username,
      password: credentials.user.password,
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.token) {
    throw new Error(`로그인 실패 ${response.status}: ${JSON.stringify(body)}`);
  }
  return body.token;
}

// 만료는 조용히 오지 않게 한다 — 남은 날짜를 늘 함께 보고한다.
function adminTokenDaysLeft() {
  return Math.floor((credentials.admin.expires_at - Date.now()) / 86_400_000);
}

async function check() {
  const token = await userToken();
  const probes = [
    ['GET /api/usage (보관됨)', '/api/usage', token, 404],
    ['GET /api/admin/stats (관리자)', '/api/admin/stats', credentials.admin.token, 200],
  ];
  let failed = 0;
  console.log(`POST /api/login → 200 (${credentials.user.username})`);
  for (const [label, route, bearer, expectedStatus] of probes) {
    const response = await fetch(`${credentials.api}${route}`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (response.status !== expectedStatus) failed += 1;
    console.log(`${label} → ${response.status}`);
  }
  console.log(`관리자 토큰 잔여 ${adminTokenDaysLeft()}일 (${credentials.admin.expires_at_iso})`);
  if (failed > 0) {
    console.error(`${failed}개 표면이 200이 아니다.`);
    process.exit(1);
  }
  console.log('사용자·비소유자 은닉·관리자 경계가 모두 정상이다.');
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

// /admin은 계정이 아니라 공유 비밀 ADMIN_PASSWORD로 연다. 그 시크릿은 읽을 수 없고
// 덮어쓰면 사용자의 관리자 비번이 깨지므로, 대신 role='admin' 세션을 D1에 직접 넣는다.
async function renewAdmin() {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = base64Url(raw);
  const tokenHash = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
  ).toString('hex');

  const issuedAt = Date.now();
  const expiresAt = issuedAt + 30 * 86_400_000;
  const sql = `INSERT INTO sessions(token_hash, user_id, role, created_at, expires_at, last_seen_at, ip_hash, ip_address, user_agent)`
    + ` VALUES ('${tokenHash}', ${credentials.user.user_id}, 'admin', ${issuedAt}, ${expiresAt}, ${issuedAt}, NULL, NULL, 'claude-agent-test-account');`;

  execFileSync('npx', ['wrangler', 'd1', 'execute', 'hvsdcm', '--remote', '--command', sql], {
    cwd: path.join(repoRoot, 'worker'),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const file = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  file.hvsdcm1.admin.token = token;
  file.hvsdcm1.admin.expires_at = expiresAt;
  file.hvsdcm1.admin.expires_at_iso = new Date(expiresAt).toISOString();
  writeFileSync(credentialsPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  console.log(`새 관리자 토큰: ${token}`);
  console.log(`만료: ${file.hvsdcm1.admin.expires_at_iso} (${credentialsPath}에 기록됨)`);
}

const mode = process.argv[2] || '--user-token';
if (mode === '--check') await check();
else if (mode === '--admin-token') {
  console.log(credentials.admin.token);
  console.error(`잔여 ${adminTokenDaysLeft()}일 · sessionStorage['hvsdcm.admin']에 넣는다`);
} else if (mode === '--renew-admin') await renewAdmin();
else if (mode === '--user-token') {
  console.log(await userToken());
  console.error(`localStorage['hvsdcm.token']에 넣는다 (${credentials.user.username})`);
} else {
  console.error(`알 수 없는 인자: ${mode}`);
  process.exit(2);
}
