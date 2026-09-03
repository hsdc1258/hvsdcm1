# `/usage` 워크트리 게이트 이관

## 증거와 경계

- 최소 E2E: 실제 Worker fixture 응답을 현재 `usage.js` 렌더러에 통과시킨 뒤 단일 워크트리의 여덟 단계, 액터 계층, 상태, 소요, 진행 값을 검사한다.
- 최종 명령: 저장소 루트에서 `npm test`와 `git diff --check`를 실행한다.
- deadline: 2026-08-30 06:23:45 KST.
- 비대상: `usage/assets/js/usage.js`, `usage/assets/css/usage.css`, `usage/index.html`, Worker와 기존 검증·스냅샷 코드는 수정하지 않는다.

## 테스트별 이관

- `the session tree always renders every phase plus the reported actors`: 카드·중첩 목록 선택자를 깊이 0 총괄, 깊이 1의 여덟 단계, 깊이 2 이상의 액터 워크트리 행 계약으로 옮겼다.
- `legacy four-key reports still place every stage, leaving unreported ones pending`: 단계 상태 판독은 유지하고 `plan` 소요를 `.wt-time.h-node-time`에서 검사한다.
- `the new stage keys carry status, model, and duration like the original four`: 새 단계의 상태, `모델 · 추론` 한 칸, 소요 열을 각 단계 행에서 검사한다.
- `unreported stages before the current one read as no-record, never as done`: 완료 세션의 미보고 단계 여섯 행이 각각 `기록 없음`과 사유를 직접 말하는지 검사한다.
- `overall, module, and actor progress render only from reported artifacts`: 총괄 64%, 보고 액터 37%, 미보고 액터 `—`를 `.wt-pct`에서 구분하고 모듈 진행은 그대로 검사한다.
- `parallel project, protocol, and visualization reports render as session tabs with one visible panel`: 현행 `진행 중인 세션` 탭 라벨과 기존 탭·패널 가시성 계약으로 이관했다.
- `session tabs carry no status dot and every remaining dot pairs with a text label`: 탭에는 점이 없고 각 워크트리 행의 점에는 `.wt-state` 글자 셀이 있는지 검사한다.
- `active, stale, and completed tabs separate session state while the worktree includes every reported actor`: 상태별 필터와 진행 중 워크트리의 전체 액터 보존을 함께 검사한다.
- `the worktree renders in document flow with no zoom, pan, or scale transform`: `[data-worktree]` 문서 흐름과 변환·캔버스·조작 장치 부재를 검사한다.
- `the active panel carries no board/org mode toggle`: 진행 중 패널의 `[data-active-mode]`가 정확히 0개이고 워크트리가 하나인지 검사한다.
- `a worktree actor row carries all six facts and keeps its delegation depth`: 이름, 역할·담당, 모델·추론, 상태, 소요, 진행과 부모보다 1 큰 손자 깊이·세로 가이드를 검사한다.
- `manual refresh bypasses cache, reports success, and preserves the selected session`: 삭제된 모드 저장 호출을 제거하고 단일 워크트리의 선택 세션 보존만 검사한다.
- `claude actors render in the reporting tree`: Claude 종류와 `claude-fable-5 · high` 결합 모델 셀을 검사한다.
- `a fetch that never settles times out and the automatic poll keeps running`: 시간초과 뒤 사본 fetch 없이 오류를 보이고 다음 주기에 워크트리가 회복되는지 검사한다.
- `null usage snapshots and a null actor percent stay unmeasured instead of becoming zero`: 세션 소모 문구와 액터 `.wt-pct` 55%를 검사하며 null을 0으로 읽지 않는 계약을 유지한다.
- `a quota window reset is excluded from consumption and marked`: 세션 머리의 소모 문구에서 초기화 상승분 제외와 초기화 횟수를 검사한다.
- `consumption rendered in the browser matches what the Worker actually records`: 실제 Worker 응답을 `renderTask`에 넣어 Codex 20.0%p와 Claude 미측정을 검사한다.
- `the worktree renders the approved vocabulary and names every stage state in text`: 워크트리 행·열 어휘와 `완료/진행 중/대기/기록 없음` 네 글자 상태를 검사한다.
- `the worktree places one root above eight phases and nests actors below them`: 가이드가 빈 뿌리 하나, 같은 깊이의 여덟 단계, 깊이 2 이상의 액터 행을 검사한다.
- `a delegated grandchild agent is drawn nested under its parent, not dropped`: 다섯 액터 보존, 부모 깊이 2, 손자 깊이 3, 이어지는 `│` 가이드를 검사한다.
- `role, assignment, duration, and the quota estimate each get their own line`: 역할·담당 값, 액터별 소요, 모델·추론, 상태와 한도 추정값이 워크트리 행에서 유실되지 않는지 검사한다.
- `actors stay in the phase the API assigned even when the task has moved on`: 단계 행 사이의 액터 위치로 API 고정 배치가 유지되는지 검사한다.
- `a payload without any of the new fields still renders through the old inference`: 이벤트 기반 단계 추론, 미측정 소요 `—`, 역할·담당 보존, 여덟 단계 소요 열을 검사한다.
- `a child actor keeps the phase the API gave it, and still names its parent`: 교차 단계 자식은 자기 단계와 `상위 구현자`를 표시하고 같은 단계 자식은 깊이 3으로 중첩되는지 검사한다.
- `the main node shows the orchestrator progress, not the whole session progress`: 총괄 행 `.wt-pct`에서 액터 보고, 이벤트 보고, 레거시 세션 폴백의 우선순위를 검사한다.
- `a stage with no report explains why it has no record`: skipped 단계 행의 상태와 사유, 보고된 단계의 사유 부재를 검사한다.
- `abbreviations are spelled out, in the UI chrome and in reported names alike`: 단계 종류 칸은 여덟 행 모두 비어 있고 보고 이름의 `WPn` 풀어쓰기는 유지되는지 검사한다.
- `the card clock is named after the report, not after the screen refresh`: 단일 세션 머리에서 마지막 보고 시각과 무기록 문구를 검사한다.
- `a failed feed says why without fetching or replacing a static copy`: 첫 피드 실패가 사유를 그대로 표시하고 fetch를 한 번만 하는지 검사한다.
- `a live dashboard is never replaced when a later feed request fails`: 이미 그린 워크트리를 후속 피드 실패가 지우지 않고 추가 사본 fetch도 만들지 않는지 검사한다.
- `session-state-org-overview.e2e.mjs`: 실제 owner API의 13개 응답을 상태별 세션 워크트리와 완료 게시글 목록까지 통과시켜 잘림과 액터 유실을 검사한다.
- `full-pipeline-org.e2e.mjs`: 실제 렌더러에서 세션별 여덟 단계, 구·신 단계 상태, 액터 행, 소요, 소모, 진행률을 검사한다.
- `usage-api-render.e2e.mjs`: 실제 Worker 응답을 현재 대시보드 렌더러에 통과시키는 기존 E2E 계약을 유지한다.

## 정적 사본 판정

- 실행 코드와 게이트에서 `usage/pipeline-state.json`, `buildFallbackBoard`, 정적 보드 변환 참조가 0개임을 `rg`로 확인했다.
- `usage.js`에는 제거 이유를 설명하는 주석 한 줄만 남아 있으며 실행 참조가 아니므로 낡은 `usage/pipeline-state.json`을 삭제하기로 결정했다.

## 현재 gate finding

- blocker: `actorNodes`가 계산한 `Codex 7.5%p 추정`은 현재 읽기 전용 `sessionWorktree` 행에 전달되지 않아 `role, assignment, duration, and the quota estimate each get their own line`이 실패한다. 게이트를 약화하거나 화면 파일을 수정하지 않았다.
