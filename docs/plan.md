# plan.md — 사이클 #2: 프론트엔드 전면 재작성 (Apple Dark v2)

> 수행 모델 기록: 기획 = **Opus 5** (PIPELINE.md 지정은 Fable 5이나 본 세션 모델이 Opus 5여서 대체, 폴백 규칙에 따라 기록)
> 사람 게이트 ①(plan 승인) = **사용자 지시로 생략.** "나한테 물어보지 말고 니가 알아서 해. 배포부터 끝까지."
> 따라서 아래 판단(D1~D6)은 오케스트레이터가 결정하고 근거를 남긴 것이며, 승인 대기 없이 3단계로 진행한다.

## 1. 요구사항

사용자 요청 원문 요약: 기존 프론트를 "싹 날린다는 마인드로" Fable이 직접 다시 짠다. 다크테마 선호,
애플 디자인을 그대로 벤치마킹. **프론트만** 새로 짜고 **기존 기능은 전부 보존**. 레이아웃은 바뀌어도 무방.
"hvsdcm"은 고유명이므로 표기를 분리하지 않는다.

검증 가능한 문장으로 재진술:

- R-1. `index.html`, `WordMaster/index.html`, `smstudy/index.html`, `admin/index.html` 네 표면의
  **DOM 구조를 새로 작성한다.** 기존 마크업을 그대로 옮겨 붙이지 않는다.
- R-2. 시각 언어는 Apple을 기준으로 한다. 랜딩은 apple.com 제품 페이지 어법, 앱 3면은 macOS/iOS HIG 어법(D4).
- R-3. 다크 전용을 유지한다(D3).
- R-4. §3 인터페이스 계약에 나열된 기능·전역·저장 키·API가 **하나도 빠지지 않고** 동작한다.
- R-5. 브랜드 표기는 항상 `hvsdcm` 한 덩어리다. `HVS DCM`, `hvs-dcm`, 글자별 자간 분해(letter-spacing 연출로
  분리되어 보이는 것 포함) 금지. 대소문자는 소문자 `hvsdcm`으로 통일한다.
- R-6. `npm test`가 통과한다.

## 2. 파일 구조 / 변경 대상

### 신설

| 경로 | 책임 |
|---|---|
| `assets/css/system.css` | **디자인 시스템 단일 원본.** 색·타이포·간격·반경·그림자·모션 토큰, 리셋, 공통 프리미티브(버튼/필드/카드/시트/토스트/표/뱃지/세그먼티드 컨트롤). 모든 표면이 이 파일을 **먼저** 링크한다. |

### 전면 재작성

| 경로 | 비고 |
|---|---|
| `index.html` + `assets/css/home.css` + `assets/js/home.js` | 랜딩. home.js는 셀렉터·DOM 조작부만 새 구조에 맞게 수정(동작 로직은 보존). |
| `WordMaster/index.html` + `WordMaster/assets/css/style.css` | 앱 셸·화면 템플릿 |
| `smstudy/index.html` + `smstudy/assets/css/style.css` | 앱 셸·화면 템플릿. `@media print` 라이트 팔레트는 **유지**. |
| `admin/index.html` + `admin/assets/css/admin.css` | 대시보드 |
| `assets/css/site-nav.css` | system.css로 흡수하거나 새 상단바 컴포넌트로 재작성 |
| `scripts/validate.mjs` | UI 계약·디자인 토큰 검사를 새 구조로 **재타겟**(D2) |

### 수정 (렌더링 부분만)

`WordMaster/assets/js/app.js`, `smstudy/assets/js/app.js`, `admin/assets/js/admin.js` —
`innerHTML` 템플릿 문자열과 셀렉터를 새 마크업에 맞춘다. **상태 관리·채점·정렬·동기화 로직은 손대지 않는다.**

### 절대 수정 금지

`WordMaster/assets/js/words.js` (183KB 단일 라인, 열지 말 것), `smstudy/assets/js/data.js`,
`smstudy/assets/js/notebook-data.js`, `smstudy/assets/js/explanation-data.js`,
`assets/js/study-utils.js`, `account.js`, `worker/**`, `smstudy/assets/kice/*.webp`.

## 3. 인터페이스 계약 (재작성이 깨뜨리면 안 되는 경계면)

### 3.1 전역 심볼과 로드 순서 — classic script + `window` 전역 유지

`type="module"`로 바꾸면 전역 노출이 끊겨 전부 깨진다. **금지.** 페이지별 순서 그대로:

- smstudy: `account.js`(data-app="smstudy") → `data.js` → `notebook-data.js` → `explanation-data.js` → `/assets/js/study-utils.js` → `app.js`
- WordMaster: `account.js`(data-app="wordmaster") → `words.js` → `/assets/js/study-utils.js` → `app.js`
- 랜딩: `defer /assets/js/home.js` / admin: `defer /admin/assets/js/admin.js`

보존 전역: `window.HvsAccount`, `globalThis.HvsStudyUtils`(`Object.freeze`, `SORT_MODES`/`sortStudyItems` 포함),
`window.WORDMASTER_WORDS`, `window.SMSTUDY_DATA`, `window.SMSTUDY_NOTEBOOK`, `window.SMSTUDY_EXPLANATIONS`.

### 3.2 저장 키 — 이름 변경 금지

`hvsdcm.token`, `hvsdcm.user`, `hvsdcm.api`(localStorage) / `hvsdcm.admin`, `hvsdcm.loaded.<app>`(sessionStorage) /
`wordmaster2000.quiz.v1`, `samun2027.study.v1`(localStorage 학습 DB).

### 3.3 백엔드 API — 호출부 시그니처 유지

`/api/login`, `/api/logout`, `/api/me`, `/api/progress/:app`, `/api/answers/:app`, `/api/answers/accept`,
`/api/admin/login`, `/api/admin/users`, `/api/admin/users/:id`, `/api/admin/stats`, `/api/admin/sessions`, `/api/admin/answers`.
Bearer 토큰 방식, admin role 분리 유지.

### 3.4 보존 기능 체크리스트 (R-4의 판정 근거 — 리뷰어는 이 표로 반려한다)

**랜딩** — 로그인 모달 + `?login=1&next=` 동일 출처 리다이렉트 검증 / `hvsdcm` 계정일 때만 Admin 링크 노출 /
드로어 열기·닫기 + `Escape` / 로그인 상태에 따른 학습 링크 노출·숨김 / 로그아웃 시 토큰·사용자·sessionStorage 전체 클리어 /
Discord·Instagram 외부 링크.

**계정 동기화(account.js 호출 계약)** — 미로그인 시 즉시 리다이렉트 / progress PUT 350ms 디바운스 /
서버 데이터 없으면 로컬 업로드 / 공유 답안 병합 후 변경 시 **1회만** `location.reload()`(`hvsdcm.loaded.<app>` 마커).

**WordMaster** — DAY 1~50 범위 선택 / 문항 수·정렬(랜덤·순서·오답률↑↓·최근순) / 주관식 정규화 채점(NFKC, 공백·구두점 제거,
대괄호 변형 허용) / "내 답 정답 인정"(로컬 오답 되돌림 + 서버 공유 답안 등록) / 결과·오답만 재시험 /
통계(정답률·오답노트·정렬) / export·import·reset / 채점 후 `Enter`로 다음(포커스가 버튼이면 무시) /
홈 복귀·기록 보기 시 진행 중이면 `confirm`.

**smstudy** — 대단원·중단원 체크박스 + 전체선택·해제 / 범위별 5지선다 / 취약 개념 퀴즈·오답 재시험·누적 복습(각각 다른 문항 소스) /
KICE 이미지 표시 + 로드 실패 처리(`error` 1회성 바인딩) / 채점 후 해설(정답 근거·오답 원인·체크리스트) /
개념 노트(핵심요약·비교표·판별순서·심화메모·회상문제) + 이전·다음 중단원 이동 / 통계·취약점 패널 /
export·import·reset / 퀴즈 중 `1`~`5` 즉시 선택, `Enter`로 다음.

**admin** — 관리자 비밀번호 로그인(sessionStorage, 탭 종료 시 소멸) / 통계 5종 카드 / 사용자 추가(아이디 3자+·비번 6자+)·목록·삭제(확인창) /
세션 테이블(사용자 필터, UA 파싱 OS·브라우저·기기, IP, 활성·만료) / 공용 정답 테이블(접기·펼치기) / `noindex,nofollow`.

**공통 알고리즘 불변식** — 취약 판정 `wrongRate >= 35` / 오답률 동률 시 누적 오답횟수 2차 정렬 /
미시도 항목은 항상 측정 항목 뒤로(`compareNullableNumbers`).

## 4. 완료 조건

- [ ] C-1. `npm test` 통과 (validate + study-utils + worker 테스트).
- [ ] C-2. **구조 재작성 증명**: `git diff --stat main..HEAD` 기준 4개 `index.html`이 각각
      **삭제 30줄 이상 + 추가 30줄 이상**. 토큰 값만 바꾼 리스타일은 이 조건에서 반려된다.
      (지난 사이클 `40f1d39`의 HTML 변경은 +2/-0줄이었다 — 같은 결과를 반복하지 않기 위한 게이트다.)
- [ ] C-3. **디자인 토큰 단일화 증명**: `assets/css/system.css` 외의 CSS 파일에 색 토큰을 정의하는
      `:root` 블록이 **0개**. `scripts/validate.mjs`가 이를 검사한다.
- [ ] C-4. §3.4 체크리스트 전 항목이 새 마크업에서 동작. 리뷰어가 항목별로 판정한다.
- [ ] C-5. `hvsdcm` 표기 분리 없음 — `validate.mjs`가 HTML·CSS 전체에서
      `HVS[\s\-_]?DCM`, `hvs[\s\-_]dcm` 패턴을 검사해 발견 시 실패.
- [ ] C-6. 전역 심볼·저장 키·스크립트 로드 순서 보존 — `validate.mjs`가 검사한다.
- [ ] C-7. `main` 브랜치에 병합 후 push 완료, GitHub Pages 배포 반영.

### C-1~C-6을 검증할 자동 검사 (LESSONS 규칙 준수 — 수작업 확인 금지)

`scripts/validate.mjs`를 다음과 같이 **재타겟한다. 검사를 줄이지 않는다.**

- `validateDesignTokens()` → `system.css` 단일 `:root`에서 토큰 정의를 읽고,
  **다른 CSS 파일에 색 토큰 `:root` 정의가 없음**을 검사(C-3). 레거시 팔레트 리터럴 금지 검사는 유지.
- `validateUiContracts()` → 기존 하드코딩 문자열(`id="drawerStudy"` 등)을 **새 구조의 훅으로 교체**하되
  검사 항목 수를 기존 이상으로 유지. 각 표면의 필수 랜드마크·상태 훅·접근성 속성을 검사.
- 신규 `validateBrandName()` → C-5.
- 신규 `validateGlobalsAndOrder()` → 각 HTML의 `<script src>` 순서가 §3.1과 일치하는지, `type="module"`이
  없는지 검사(C-6). 저장 키 문자열이 각 앱 JS에 존재하는지 검사.
- 데이터 불변식 검사(2,000단어 / 4단원·13중단원·78문항 / 이미지 78장·WebP 크기)는 **그대로 둔다.**

## 5. 관련 LESSONS 규칙 (docs/LESSONS.md 인용)

- *"CSS 파일 안에 같은 셀렉터 또는 `:root`가 두 번 이상 선언돼 있으면 …"* →
  현재 admin 2회·smstudy 3회·WordMaster 2회 중복 상태다. **D5(토큰 단일화)로 원인을 제거한다.** (C-3)
- *"색 토큰의 명도·밝기를 바꾸는 수정을 할 때는 그 토큰을 참조하는 다른 모든 규칙의 대비도 함께 점검한다"* →
  system.css 토큰 확정 시 본문·보조·비활성 텍스트의 대비를 각각 확인하고, 본문 텍스트는 배경 대비 **7:1 이상**을 목표로 한다.
- *"완료 조건은 수작업 검증이 아니라 자동 검사 코드까지 함께 지정한다"* → §4의 자동 검사 재타겟이 이 규칙의 이행이다.
- *"CRLF/LF 혼재 — diff·커밋 전에 `core.autocrlf false`로 고정"* → 오케스트레이터가 이미 설정했다.
- *"파괴적 실험 전 커밋 또는 stash. 원복에 `git checkout -- <file>` 금지"* → 브랜치 작업 + 커밋 단위 진행으로 이행.

## 6. 담당 지정

- **구현자 모델: `fable`** — 선택 근거: 사용자가 "Fable이 직접 다시 짜도록"이라고 명시했다
  (CLAUDE.md 모델 배정의 "사용자가 명시 요청한 경우" 조항).
- **리뷰어: `opus`** — Codex 교차 리뷰가 1순위이나 본 사이클은 Opus 서브에이전트로 간다.
  같은 계열 리뷰의 한계 보완을 위해 리뷰어는 review-template의 "테스트 실효성" 항목과
  §3.4 체크리스트를 **항목별로** 별도 검증한다.
- **실행 위치**: 구현·리뷰·수정 모두 Agent 서브에이전트 (CLAUDE.md 토큰 규칙 "실행 격리").
- **브랜치**: `rebuild/apple-dark-v2`. 표면 단위 커밋. 승인 후 `main` 병합 → push(배포).

## 7. 오케스트레이터 판단 기록 (사람 게이트 ① 생략에 따른 근거)

- **D1. 재작성 범위 = HTML 구조부터 전면.** 근거: 지난 `40f1d39`의 HTML 변경이 +2/-0줄이었고 사용자가
  "변경성이 크게 없다"고 판정했다. CSS만 교체하면 같은 결과가 반복된다. C-2를 기계 게이트로 세운 이유다.
- **D2. `validate.mjs`는 재타겟하되 약화하지 않는다.** 근거: 기존 UI 계약 검사는 옛 마크업 문자열을
  하드코딩하므로 구조를 바꾸면 반드시 깨진다. 검사를 삭제하면 회귀 방어가 사라지므로(LESSONS 규칙 위반)
  같은 수 이상의 새 훅 검사로 교체한다.
- **D3. 다크 전용 유지, 라이트 토글 미추가.** 근거: 현재 라이트 경로가 아예 없고(`@media print` 예외),
  토글 추가는 "기존 기능 보존" 범위를 넘는 **신규 기능**이다. 사용자 요청은 "다크테마 선호"였다.
- **D4. 랜딩 = apple.com 제품 페이지 어법 / 앱 3면 = HIG 어법.** 근거: 랜딩은 소개 성격이라 여백·대형 타이포가
  맞고, 학습 앱은 정보 밀도와 반복 조작이 중요해 사이드바·툴바·그룹 리스트 어법이 맞다.
  두 어법은 system.css의 동일 토큰을 공유하므로 일관성은 유지된다.
- **D5. 디자인 토큰 단일 원본(`system.css`).** 근거: 현재 4개 파일이 토큰을 복제하고 그중 3개는 `:root`가
  2~3회 중복 선언돼 있다. LESSONS의 첫 규칙이 정확히 이 함정을 지목한다.
- **D6. classic script + `window` 전역 유지.** 근거: 4개 표면 모두 전역 공유에 의존하며
  `type="module"` 전환 시 전역 노출이 끊겨 전부 깨진다. 모듈화는 이번 범위 밖이다.
- **D7. (리뷰 M-1 대응, 수정 라운드에서 추가) 미로그인 상태의 상단바·푸터 학습 링크 상시 노출은
  기존 동작 보존이다.** 근거: `main`의 랜딩에서 `.product-card` 2장(/WordMaster/·/smstudy/)은
  로그인 여부와 무관하게 항상 노출됐고(`git show main:index.html` 84·93행, home.css에 게이팅 규칙 없음),
  게이팅됐던 표면은 드로어(`.drawer.logged .drawer-study`)와 히어로 CTA(`.account`)뿐이며 이 둘은
  새 구현이 그대로 보존한다. §3.4의 "로그인 상태에 따른 학습 링크 노출·숨김"은 이 게이팅 표면을
  가리키는 것으로 해석한다. 미로그인 진입 시 `account.js`가 `/?login=1&next=…`로 유도하므로 기능 누수도 없다.
