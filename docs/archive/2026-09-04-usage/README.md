# 2026-09-04 usage/harness 보관 목록

사용자 결정 `usage 보관`, `실투 탭 유지`에 따라 Codex·Claude 사용량과 로컬 harness task/event 수집 계층을 활성 제품에서 분리했다. 이 폴더는 삭제본이 아니라 복구용 원본 보관소다.

## 보관한 파일

| 원래 경로 | 보관 경로 | 역할 |
|---|---|---|
| `usage/index.html` | `_source/page/index.html` | 사용량/실행 현황과 공모전이 함께 있던 이전 페이지 원본 |
| `usage/assets/css/usage.css` | `_source/page/usage.css` | 사용량·harness·공모전 통합 스타일 원본 |
| `usage/assets/js/usage.js` | `_source/page/usage.js` | owner gate, `/api/usage` 조회, 한도·task/event 렌더러와 polling |
| `worker/src/router.js` | `worker/router.js` | 보관 직전 Worker 전체 원본. usage/harness 상수, 정규화, ingest/read 함수와 route가 들어 있다 |
| `scripts/usage.test.mjs` | `tests/usage.test.mjs` | 사용량 화면 렌더·polling 단위 테스트 |
| `scripts/usage-api-render.e2e.mjs` | `tests/usage-api-render.e2e.mjs` | 실제 Worker 라우터와 사용량 렌더러 통합 E2E |
| `worker/test.mjs` | `tests/worker.test.mjs` | 보관 직전 Worker 테스트 원본. usage/harness 계약 테스트가 포함돼 있다 |
| `scripts/snapshot.mjs` | `tests/snapshot.mjs` | 사용량 fixture와 스냅샷 생성 로직을 포함한 생성기 원본 |
| `scripts/render-sandbox.mjs` | `tests/render-sandbox.mjs` | 사용량 렌더러 샌드박스 원본 |
| `docs/_snapshots/usage.html` | `_source/snapshots/usage.html` | 사용량·harness 화면의 마지막 고정 스냅샷 |
| `docs/usage-worktree-gate-migration.md` | `usage-worktree-gate-migration.md` | 이전 usage/harness 게이트 전환 기록 |

활성 `/usage/` 경로는 공모전 자동화가 사용하므로 삭제하지 않았다. 현재 페이지는 `usage/assets/js/competition.js`와 `usage/assets/js/page.js`만 로드하며 공모전 후보·승인 화면만 보여준다.

## Worker와 데이터 경계

- 활성 라우터에서 `GET /api/usage`, `POST /api/usage/report`, `POST /api/harness/report`를 제거했다. 세 경로는 역할과 무관하게 404다.
- `worker/migrations/0005_usage_snapshots.sql`, `0006_harness_tasks.sql`, `0007_harness_events.sql`, `0009_usage_harness_observability.sql`, `0010_harness_project_snapshots.sql`은 적용 이력이므로 옮기거나 고치지 않았다.
- D1의 기존 `usage_snapshots`, `usage_source_health`, `harness_tasks`, `harness_events` 행을 삭제하지 않았다.
- Behavior Lab의 paper/live report도 역사적으로 `usage_snapshots` 테이블을 사용한다. 그 source, API, UI, runner, 테스트는 그대로 유지했다.
- 공모전 API와 `/usage/`의 공모전 UI는 그대로 유지했다.

## 저장소 밖에서 발견한 생산자

다음 경로는 이 작업의 수정 허용 범위 밖이라 바꾸지 않았다.

- `C:\Users\won\Desktop\Codex\scripts\codex-usage-sync.mjs`
- `C:\Users\won\Desktop\Codex\scripts\codex-usage-sync.test.mjs`
- `C:\Users\won\Desktop\Codex\env\global-principles.md`
- `C:\Users\won\Desktop\Claude\env\statusline.js`의 로컬 Claude 사용량 파일 갱신 로직
- `C:\Users\won\Desktop\Claude\env\memory\dual-harness-codex-claude.md`

2026-09-04 확인 시 Windows 예약 작업과 `C:\Users\won\.codex\automations`에는 usage/harness API로 전송하는 활성 항목이 없었다.

## 되살리는 방법

1. `_source/page/index.html`, `_source/page/usage.css`, `_source/page/usage.js`에서 사용량 구역을 현재 공모전 페이지에 다시 병합한다. 단순히 폴더만 되돌리면 현재 공모전 변경을 덮으므로 안 된다.
2. `worker/router.js`의 usage/harness 전용 상수와 함수, 세 route를 현재 `worker/src/router.js`에 선택적으로 복원한다. 파일 전체 교체는 이후 Worker 변경을 잃으므로 금지한다.
3. 전용 테스트와 `package.json` test script, `scripts/snapshot.mjs`, `scripts/render-sandbox.mjs`, `docs/_snapshots/usage.html`을 함께 복원한다.
4. 필요하면 GitHub Actions와 Wrangler에 `USAGE_INGEST_TOKEN`, `HARNESS_INGEST_TOKEN` 설정을 다시 연결한다. 비밀값은 Git에 넣지 않는다.
5. 저장소 밖 생산자를 별도 소유자 승인 아래 재활성화한 뒤, 최신 snapshot/task/event가 실제로 전진하는지 확인한다.
6. `npm test`, `git diff --check`, `node scripts/snapshot.mjs`, Worker 배포와 owner 브라우저 E2E를 통과해야 복원이 끝난다.

보관 기준 커밋은 이 작업의 부모인 `3a011a5af54af6c623b3b3e232854524a96f256f`다. Git 기록에서도 원본 전체를 복구할 수 있다.
