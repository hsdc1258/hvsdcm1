# R2 CI 복구 계획

- 요청 결과: `.github/workflows/deploy-worker.yml`의 Worker 배포를 지정된 경로 1→2→3 순서로 복구하고, 성공한 첫 경로에서 중단한다.
- 최소 E2E 증거: 새 `workflow_dispatch` 실행의 최종 conclusion이 `success`이다.
- 검증 명령: `gh workflow run deploy-worker.yml --repo hsdc1258/hvsdcm1`, 실행 ID 식별 후 `gh run watch <id> --repo hsdc1258/hvsdcm1 --exit-status`.
- deadline: 2026-08-29T02:23:53+09:00 (시작 2026-08-29T00:53:53+09:00, 90분).
- 순서: Wrangler 공식 R2 검증 우회 확인 → 유효한 상위 Cloudflare 자격증명이 있을 때만 최소 권한 토큰 발급·GitHub secret 교체 → 앞선 경로가 모두 불가할 때 CI 구조 변경.
- 실패 예산: 경로 1·2 검증 실패 로그를 읽고 최소 수정 후 1회만 재실행; 재실패 시 경로 3으로 전환한다.
- 영향 가능 경로: `.github/workflows/deploy-worker.yml`, `worker/README.md` 또는 동등한 Worker 문서, `work/r2-ci-restore-report.md`.
- 비목표: R2 버킷·D1 데이터·Worker API 계약·프런트엔드·기존 secret 값을 변경하거나 노출하지 않는다.
- 보안 경계: 토큰/상위 자격증명 값은 파일, stdout, 보고서, Git에 남기지 않는다. secret 값은 파이프로만 전달한다.
- 호환성 경계: GitHub Pages 정적 구조와 Wrangler ES module 배포 모델을 유지하고 `continue-on-error`는 사용하지 않는다.
- 기준선: `main`과 `origin/main`은 265e7b6에서 일치하고 시작 작업 트리는 깨끗하다.
- 구현: route.json의 Codex writer가 담당한다. 오케스트레이터는 통합·secret 취급·배포 최종 판정을 소유한다.
- 검토: deterministic gate 통과 후 fresh quality verifier 1명이 현재 gate 관련 blocker/major/nit을 분류한다.
- 필수 로컬 gate: `npm test`, `git diff --check`.
- 완료 기준: 첫 성공 경로의 변경/secret 설정이 적용되고 새 CI 실행이 success이며, 한국어 25줄 이하 보고서와 3줄 stdout 요약을 남기고 필요한 변경을 commit/push한다.
- 승인 필요 작업: 없음. 사용자가 네트워크·Git 쓰기·secret 교체·배포 검증을 이 과업에서 명시적으로 승인했다.
