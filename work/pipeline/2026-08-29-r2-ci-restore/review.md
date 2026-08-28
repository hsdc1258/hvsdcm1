# R2 CI 경로 1 독립 검토

## 1. 검토 범위와 증거

- active gate: 경로 1 workflow 구현, production `workflow_dispatch` 전.
- commit range: `265e7b632013b57e267ccd636e77df05f2c2eb0e..7faa51dc9cd26501122c46ecf0007347b0c531ed`.
- commit: `7faa51d fix(ci): R2 자동 프로비저닝 검증을 건너뛴다` 1개.
- exact diff: `.github/workflows/deploy-worker.yml:67`의 deploy 명령에 `--experimental-provision=false` 한 인자만 추가됐다(1 insertion, 1 deletion). D1 migration, secret 입력, 환경, concurrency와 실패 전파는 변경되지 않았다.
- `npm.cmd test`: reviewer 재실행 exit 0; validation 13,591, E2E 2개 PASS, Node tests 143/143 PASS.
- `git diff --check 265e7b632013b57e267ccd636e77df05f2c2eb0e..7faa51d`: exit 0.
- `worker/pnpm-lock.yaml`과 설치본 모두 Wrangler `4.125.0`이다.
- `node node_modules/wrangler/bin/wrangler.js deploy --experimental-provision=false --dry-run`: exit 0; 기존 `DB` D1 및 `GICHUL` R2 바인딩을 모두 출력했다.
- Cloudflare의 [Wrangler 명령 문서](https://developers.cloudflare.com/workers/wrangler/commands/workers/)는 `--experimental-provision`을 자동 리소스 프로비저닝 boolean 옵션으로 명시한다. Wrangler 4.125.0의 [공식 tagged deploy source](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.125.0/packages/wrangler/src/deploy/index.ts#L829-L842)는 이를 `RESOURCES_PROVISION`에 연결한다.
- 설치된 4.125.0 코드에서 `resourcesProvision=false`이면 `provisionBindings` 호출이 생략된다. 문제의 R2 bucket GET은 그 내부 `R2Handler.isConnectedToExistingResource()`에만 있고, 업로드 form은 원래의 D1/R2 bindings를 계속 받는다.
- dry-run은 인자 파싱과 바인딩 보존을 증명하지만 원격 API 호출 생략 자체는 실행하지 않으므로, 그 부분은 동일 버전 공식/설치 소스의 직접 분기 검사로 확인했다.
- trusted receipt: 저장소 밖 `C:\Users\won\AppData\Local\Temp\codex-pipeline-receipts\2026-08-29-r2-ci-restore\receipt.json`; schema v2, spawned context `/root/r2_ci_reviewer`, candidate HEAD 및 workflow SHA-256이 reviewer 재계산값과 일치한다.

## 2. 판정

`accept` — 현재 경로 1 구현 gate에는 blocker/major가 없으며, 공식 Wrangler 옵션이 문제의 provisioning 검증만 끄고 배포 바인딩과 기존 CI 보호 단계를 유지한다.

## 3. Findings

없음.

- blocker: 0
- major: 0
- nit: 0

## 4. 완료 기준 커버리지

| 기준 | 상태 | 직접 증거 |
| --- | --- | --- |
| 공식 수단으로 R2 자동 프로비저닝 검증 우회 | 충족 | Cloudflare 문서, Wrangler 4.125.0 tagged/installed source |
| workflow Deploy 단계에만 최소 적용 | 충족 | exact one-line diff at `.github/workflows/deploy-worker.yml:67` |
| D1/R2 바인딩 및 기존 CI 실패 전파 보존 | 충족 | complete workflow diff, dry-run binding output, `continue-on-error` 없음 |
| 저장소 deterministic gates | 충족 | `npm.cmd test`, commit-range `git diff --check` 모두 exit 0 |
| 새 production workflow 실행의 `success` | 미실행, 다음 gate | 현재 gate는 dispatch 전 구현 검토이며 plan의 최소 E2E는 아직 남음 |
| 보고서, push 및 최종 완료 판정 | 현재 gate 밖 | production dispatch 결과 뒤 orchestrator가 수행 |

## 5. 잔여 위험과 미완료 검사

- 전체 과업을 완료하려면 이 exact commit을 push한 뒤 새 `workflow_dispatch`를 실행해 최종 conclusion `success`를 확인해야 한다. 실패하면 실제 로그에 맞춘 최소 수정과 1회 재실행 규칙을 적용한다.
- 이 옵션은 experimental이다. 현재 frozen lock은 검토한 4.125.0을 고정하지만, Wrangler lockfile 갱신 시 같은 소스 분기와 production E2E를 다시 검증해야 한다.
- execution metrics와 review-evidence sidecar/receipt validator는 리뷰 후 orchestrator가 생성·검증할 bookkeeping 산출물이라 이 제품 gate 판정에는 포함하지 않았다.
