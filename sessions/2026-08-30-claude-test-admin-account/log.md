# 2026-08-30 · 에이전트 전용 테스트 계정 발급

사용자 요청: "니 맘대로 할수있는 웹사이트 계정 하나 만들어. 어드민페이지 다 접근할수있게. 테스트용으로"

이 사이트의 인증 표면은 셋이고 서로 다른 열쇠를 쓴다.

1. 사용자 페이지 — `users` 테이블 + `localStorage['hvsdcm.token']`
2. `/admin` — 공유 비밀 `ADMIN_PASSWORD` + `sessionStorage['hvsdcm.admin']`, `role='admin'` 세션
3. `/usage`(모더 탭 포함) — 사용자 세션이되 username이 `vars.OWNER_USERNAME`과 같아야 함

따라서 계정 하나로 셋을 다 열려면 세 가지를 다 손봐야 한다.

- 요청 → `claude-test` 사용자를 원격 D1에 직접 삽입(worker와 동일한 PBKDF2-SHA-256/100k/솔트).
- 요청 → `/admin`용 `role='admin'` 세션을 D1에 직접 발급. `ADMIN_PASSWORD`는 Worker 시크릿이라
  읽을 수 없고, 덮어쓰면 사용자의 기존 관리자 비번이 깨지므로 건드리지 않는다.
- 요청 → `OWNER_USERNAME`을 쉼표 목록으로 읽게 고쳐 `claude-test`를 소유자에 추가. fail-closed는 유지.
- 실측 → `npm test`의 validate 단계가 `.claude/worktrees/`(에이전트 중첩 워크트리) 안의
  **다른 브랜치 사본**을 이 체크아웃의 위반으로 세고 있었다. 게이트가 내 변경과 무관하게
  빨간불이라 통과 판정을 할 수 없었다. → `scripts/validate.mjs`의 walk가 `.claude`를 건너뛴다.
- 실측 → 이 체크아웃에서 다른 세션이 `usage/assets/js/usage.js`와 `scripts/usage.test.mjs`를
  동시에 고치고 있다(15:41 타임스탬프). `scripts/usage.test.mjs`의 실패 5건은 그쪽 작업 중간
  상태다. **그 두 파일은 건드리지도 stage하지도 않았다.**
- 검증 → `node scripts/validate.mjs` 13,705 통과, `node --test worker/test.mjs` 79/79 통과,
  `usage-api-render.e2e.mjs` PASS.
- 배포 → `npx wrangler deploy` (Version 173f0cb2, `OWNER_USERNAME="hvsdcm,claude-test"`),
  main push로 Pages의 `assets/js/home.js` 갱신 확인.
- 공개 환경 실측 → `POST /api/login` 200(user_id 18) / `GET /api/usage` 200 /
  `GET /api/moderator` 200 / `GET /api/admin/stats` 200 / 토큰 없는 `GET /api/usage` 401.
  브라우저에서 `hvsdcm1.xyz/usage`(모더 탭 배지 10)와 `hvsdcm1.xyz/admin`(개요·사용자·접속
  기기·공용 답안) 렌더 확인.
- 자격증명은 워크스페이스 루트 `.credentials.json`(gitignore `**/.credentials.json`)에만 둔다.
  저장소에는 어디에도 적지 않았다.
- 요청("Codex에서도 쓰게해줘야지") → 자격증명의 단일 원본을 Claude 워크스페이스 루트에서
  `C:\Users\won\Desktop\Codex\config\credentials.json`으로 옮겼다(거기 .gitignore의
  `config/*.json`). Claude 쪽 사본은 지웠다 — 두 곳에 두면 갱신 때 갈라지고, 구독이 끊기면
  Claude 쪽은 사라진다.
- 요청 → `scripts/test-account.mjs` 추가. 경로를 코드에 박지 않고 이 체크아웃 기준 상대
  경로로 찾으며 `HVSDCM_CREDENTIALS`로 덮어쓴다. `--check` / `--user-token` /
  `--admin-token` / `--renew-admin`(30일 만료 재발급).
- 요청 → 가리키는 글을 셋에 남겼다: 이 저장소 `AGENTS.md`, `Codex/AGENTS.md`,
  `Claude/docs/products.md`. 값은 어디에도 적지 않고 경로와 명령만 적었다.
- 검증 → `node scripts/test-account.mjs --check` 로그인 200 · usage 200 · moderator 200 ·
  admin/stats 200. validate 13,707 통과, `worker/test.mjs` 79/79 통과.
