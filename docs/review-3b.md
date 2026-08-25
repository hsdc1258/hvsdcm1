# review-3b.md — 앱 3면(WordMaster·smstudy·admin) + validate.mjs 리뷰

> 리뷰어: Claude Fable 5 서브에이전트 (plan.md §6의 opus 지정은 세션 모델 폴백으로 대체, CLAUDE.md 폴백 규칙에 따라 기록)
> 대상 커밋: `54a3f61`, `4d0cb14`, `17f4288`, `9f89f47`, `779a547` (브랜치 `rebuild/apple-dark-v2`)
> 범위: `WordMaster/*`, `smstudy/*`, `admin/*`, `scripts/validate.mjs`, `assets/css/site-nav.css` 삭제.
> 랜딩·system.css 자체는 별도 리뷰어 담당 — 여기서는 앱 3면의 **소비 방식**만 본다.

## 1. C-2 — 구조 재작성 여부 (위장 리스타일 검사)

`git diff main..HEAD --numstat` 실측:

| 파일 | +줄 | −줄 | 판정 |
|---|---|---|---|
| WordMaster/index.html | 80 | 57 | 통과 (기준 +30/−30) |
| smstudy/index.html | 74 | 37 | 통과 |
| admin/index.html | 159 | 104 | 통과 |

수치만이 아니라 내용도 확인했다: 3면 모두 기존 마크업과 다른 골격이다 —
`skip-link → topbar(brand+crumb+nav) → topbar-spacer → container-wide > app-shell(aside.sidebar + main.app-main) → footer → #toast`.
사이드바가 화면 전환 컨트롤(`data-nav="home|stats"`)을 갖는 HIG 어법으로, 이전의 site-header/page 구조를 옮겨 붙인 흔적이 없다.
admin은 로그인 섹션·대시보드 패널·표 3종이 전부 새 프리미티브(`card`, `toolbar`, `table-wrap>table.table`, `badge`) 위에 재조립됐다.
**C-2 충족.**

## 2. C-3 / D5 — CSS 축소가 "삭제로 인한 파손"인지 "프리미티브 대체"인지

실측 줄 수: WordMaster style.css **194줄**, smstudy style.css **489줄**, admin admin.css **147줄**.
3면 모두 `:root` 블록 0개(주석 언급만 존재), 색 리터럴은 피드백 테두리의 `rgba(48,209,88,.45)`/`rgba(255,69,58,.45)` 등 알파 파생값 소수뿐이다.

"스타일이 그냥 사라졌는지"는 수작업 대조 대신 검사 스크립트로 확인했다
(3면의 index.html + app.js 템플릿 문자열에서 class 추출 → system.css + 앱 CSS의 셀렉터와 대조):

- **어디에도 스타일이 없는 구조 클래스: 0개.** 미매칭으로 나온 것들(`choice-option`, `unit-check`, `study-btn`,
  `delete-user`, `view-sessions` 등)은 전부 스타일 클래스와 병기된 순수 JS 훅이다
  (예: `class="choice-option sm-choice"`, `class="btn btn-danger btn-sm delete-user"`).
- **앱 CSS가 참조하는 `var(--…)` 중 system.css(+자기 파일)에 정의 없는 토큰: 0개.**
  (`--topbar-h`, `--font-mono`, `--ls-caps`, `--orange-soft`, `--ease-swift` 등 경계 토큰까지 전수 확인.)

즉 줄 수 감소는 토큰·프리미티브 이관의 결과이고, 참조 깨짐은 없다. **C-3 충족** (시각 확인은 §7).

- `nit` — `WordMaster/assets/css/style.css:109-110`, `smstudy/assets/css/style.css:320-321`:
  피드백 상태 테두리가 `rgba(48,209,88,.45)` 하드코딩이다. `--green`(#30d158) 값 변경 시 함께 틀어진다.
  system.css에 `--green-border` 류 알파 토큰을 두거나 `color-mix(in srgb, var(--green) 45%, transparent)`로 파생할 것.

## 3. smstudy `@media print` — 원본 대비 이관 검증

원본(main, style.css:2256~)의 숨김 목록과 신판(style.css:435~)의 대응을 전수 대조했다:

| 원본 숨김 | 신판 대응 | 판정 |
|---|---|---|
| `.site-header` | `.topbar` + `.topbar-spacer` | 이관됨 |
| `.site-footer` | `.sm-footer` | 이관됨 |
| `.concept-nav` | `.sm-concept-nav` | 이관됨 |
| `.notebook-menu` | `.sm-toc` | 이관됨 |
| `.concept-finish` | `.sm-concept-finish` | 이관됨 |
| `.page-head>button` | `.view-head .btn` | 이관됨 |
| `.swipe-hint` | **(없음)** | 누락 — 아래 지적 |
| (없음) | `.sidebar`, `.toast` 추가 숨김 | 개선 |

라이트 팔레트는 `:root`가 아닌 `html`에 재정의해 C-3 예외 규칙을 지켰고, 원본이 개별 규칙으로 덮던
배경·글자색(`.key-point-map` 등 6종 규칙)은 토큰 재정의 방식으로 흡수됐다 — 방식 변경이지 약화가 아니다.
`.sm-matrix` 인쇄 축소(9px·sticky 해제)도 이관됐다.

- `nit` — `smstudy/assets/css/style.css:470` 인쇄 숨김 목록에 `.sm-swipe`가 없다.
  기본값이 `display:none`이지만 `@media (max-width: 640px)`(줄 415)는 media type 무제한이라 **인쇄에도 적용**된다 —
  좁은 용지(모바일 PDF 저장 등)에서 "옆으로 밀어 보기" 칩이 인쇄물에 찍힌다. 원본은 `.swipe-hint`를 명시 숨김했다.
  수정: 인쇄 숨김 목록에 `.sm-swipe` 한 줄 추가. (재현 조건이 좁은 용지 한정이라 nit.)

## 4. D2 — validate.mjs 검사 실효성 (약화 여부)

### 폐기 ↔ 대체 대응

폐기된 것(main): 4개 표면 CSS의 `:root`에서 5개 토큰(`--bg/--surface/--text/--line/--green`) 값이
canonical과 일치하는지 + 표면별 레거시 팔레트 검사 (≈ 표면당 11건 × 4).

대체된 것(HEAD, `scripts/validate.mjs:312-386`):

1. system.css 단일 `:root` 강제 + canonical **9개** 토큰 값 고정(기존 5개에서 확대).
2. **전 CSS 파일 순회**: `:root` 블록 전면 금지 → 폐기된 검사가 잡던 결함 유형(표면별 토큰 값 표류)은
   이제 표류할 `:root` 자체가 존재할 수 없으므로 **원인 단계에서 차단**된다. 검사 강도는 동등 이상.
3. 색 토큰 9종의 비-`:root` 재정의도 금지(print 제외), 레거시 팔레트 검사는 전 CSS+HTML로 확대.
4. `var(--` 소비 강제 — 토큰을 안 쓰는 CSS 파일 신설을 막는다.

**판정: 검사 총량 부풀리기가 아니라 실질 대체다.** 단, 아래 두 건은 지적한다.

- `major` — `scripts/validate.mjs:363`: 재정의 금지 목록이 canonical 9종뿐이다.
  `--text-3`, `--text-4`, `--line-strong`, `--surface-3`, `--bg-alt`, `--accent-soft` 등 나머지 ~10종 토큰은
  임의 셀렉터에서 재정의해도(예: `.sidebar { --text-3: red }`) 통과한다. `:root` 금지가 주 경로를 막으므로
  구멍은 좁지만, D5 "단일 원본" 선언과 검사 범위가 불일치한다.
  수정: system.css `:root`에서 토큰 이름을 **파싱해** 그 전체 목록으로 재정의 금지를 돌릴 것 (목록 하드코딩 제거).
- `nit` — `scripts/validate.mjs:364` `stripPrint`: `\n}`(열 0의 닫는 중괄호)를 블록 종료로 가정한다.
  현재 포맷과 중첩 `@media`·다중 print 블록·CRLF에서 오동작하지 않음을 재현 테스트로 확인했다
  (실 파일에서 print 블록 완전 제거·화면 블록 보존 확인). 다만 들여쓰기 규약에 묶인 정규식이라
  `format:css` 규칙이 바뀌면 조용히 과소/과잉 제거될 수 있다 — 중괄호 깊이 카운트 방식이 안전하다.

### stripPrint 실측

`@media print { … }` 실 블록 제거 후 `--text:` 재정의 잔존 0건, 인접 화면 블록 보존, 중첩 미디어 케이스 정상 —
현재 코드베이스 기준 오작동 없음.

### 기계 게이트 실행

`npm test` 실행: **validate 통과 + worker 테스트 14/14 통과.** C-1 충족.

## 5. §3.1·§3.2·§3.3 — 인터페이스 계약

- 스크립트 로드 순서: 3면 모두 §3.1과 자구까지 일치 (`WordMaster/index.html:76-79`, `smstudy/index.html:77-82`, `admin/index.html:12`). `type="module"` 0건, `data-app`/`data-key` 문자열 보존.
- 저장 키: `wordmaster2000.quiz.v1`(WordMaster/assets/js/app.js:50,68), `samun2027.study.v1`(smstudy/assets/js/app.js:4), `hvsdcm.admin`(admin.js) 모두 보존. account.js·study-utils.js·데이터 파일은 diff 0줄 — 미수정 확약 이행.
- API 호출부: `/api/answers/accept` POST 시그니처 보존 (WordMaster/assets/js/app.js:235). admin.js diff는 innerHTML 템플릿·클래스명 교체뿐, fetch·상태 로직 무변경을 diff로 확인.

## 6. §3.4 — 기능 보존 (브라우저 실사, 항목별)

로컬 http-server + 위조 토큰(죽은 API 주소로 동기화 격리)으로 3면을 실제 구동해 판정했다.

**WordMaster** — 전 항목 동작:

| 항목 | 판정 | 근거 |
|---|---|---|
| DAY 범위·프리셋·문항 수·정렬 5종 | 동작 | 옵션 값이 main과 동일함을 diff로 확인, 랜덤 시작 실사 |
| 주관식 채점 + 오답 피드백 | 동작 | 오답 제출 → `.wm-feedback.is-wrong` + `role="status"` |
| 내 답 정답 인정 | 동작 | 클릭 → `customAliases` 저장, `wrongBank` 2→1 되돌림, 피드백 is-correct 전환, 토스트 |
| 채점 후 Enter 다음 (버튼 포커스 시 무시) | 동작 | 본문 포커스 Enter → 진행 / 버튼 포커스 Enter → 유지, 실사 재현 |
| 홈·기록 이동 시 진행 중 confirm | 동작 | confirm 문구까지 원본과 동일 (가드 조건 `index > 0` 원본 그대로) |
| 통계·오답노트·정렬 / export·import·reset | 동작 | statsIds 전 훅 렌더 확인, 파일 입력은 시각적 숨김 + label 연결(779a547) |
| 사이드바 상태 동기화 | 동작 | `is-active` + `aria-current="page"` 전환 확인 |

**smstudy** — 전 항목 동작:

| 항목 | 판정 | 근거 |
|---|---|---|
| 대단원·중단원 체크 + 전체선택·해제 | 동작 | 단위 체크 → 하위 3개 선택·리렌더, selectAll → 13/13 |
| 범위별 5지선다 + 키보드 1~5·Enter | 동작 | `keydown '3'` 즉시 채점, Enter 다음(버튼 포커스 가드 동일) |
| 취약·오답·누적 복습의 문항 소스 분리 | 동작 | `app.js:435-438` — `q.weak` / `wrongBank` / `db.completed` 각각 다른 필터 |
| KICE 이미지 + 로드 실패 폴백 | **동작 (미검증이던 실패 경로 직접 재현)** | src를 깨뜨려 `error` 발화 → `.sm-media-link.is-failed`(display:none) + 폴백 패널 표시 + 원문 PDF 버튼. `{ once: true }` 바인딩과 `complete && naturalWidth===0` 경로 모두 §3.4대로 존재 (`app.js:761-770`) |
| 채점 후 해설 (정답 근거·오답 원인·체크리스트) | 동작 | `.sm-reason.is-correct/.is-wrong` + 체크 3건 렌더 |
| 오답 원인 선택 저장 | 동작 | reason-option 클릭 → `wrongBank[].reason = "concept"` 저장 |
| 결과·오답만 재시험 | 동작 | 20문항 완주 → 점수·오답 18건·retryResult·문항별 재시험/개념 링크 |
| 개념 노트 + 이전·다음 이동 | 동작 | 핵심요약·기출분석·비교표·판별순서·심화·회상 3건 렌더, prev/next로 중단원 왕복, 경계에서 disabled, 점프 13개 |
| 통계·취약점 패널 / export·import·reset | 동작 | 약점 6지표 + 중단원별 정답률 17행 + 오답노트 정렬 |

**admin** — 로그인 게이트·레이아웃 동작 (백엔드 없는 환경이라 API 왕복은 코드 diff로 판정):

| 항목 | 판정 | 근거 |
|---|---|---|
| 로그인 화면 기본 / 패널 hidden | 동작 | computed display로 확인, `#panel.hidden` + `.hidden` 유틸 |
| 표 3종·통계 카드 렌더 | 동작 | admin.js 템플릿과 동일 마크업의 행을 주입해 스타일 적용 확인 |
| UA 파싱·필터·삭제 확인창 | 코드 판정 | admin.js diff가 렌더 마크업 교체뿐임을 전량 확인 — 로직 무변경 |
| noindex,nofollow | 동작 | `admin/index.html:8` |

**구현자 유보 사항 재검증 (모바일 admin 가로 스크롤)** — 375px에서 실측:
`documentElement.scrollWidth` 811 vs `clientWidth` 375로 부풀지만 `body.scrollWidth === clientWidth === 375`,
`window.scrollTo(500,0)` 후에도 `scrollX === 0` — **실제 가로 스크롤 불가, 표는 `.table-wrap` 내부 스크롤(sw 932/cw 341)로 격리됨.
유보 판단은 옳다. 회귀 아님.**

## 7. 시각·접근성·대비

- 계산 스타일 실사: body #000/#f5f5f7, 카드 #161617 radius 18px, 버튼 pill(980px), topbar fixed + backdrop blur,
  데스크톱 1280px에서 사이드바 280px + 본문 2열, 375px에서 1열 스택 — 토큰이 전부 실값으로 해석되고 레이아웃이 살아 있다.
  §2의 커버리지 검사와 합쳐 "CSS 축소 = 화면 파손" 리스크는 **기각**.
- 대비: `--text-3`(#86868b, 5.8:1)는 3면 모두 캡션·마이크로 텍스트 전용(`dt`, `figcaption`, side-note, footer, `.ad-caption`).
  본문·수치는 `--text`/`--text-2`. `--text-4`는 앱 3면 CSS에서 미사용. 위반 없음.
- 키보드: 사이드바는 실제 `<button>`/`<a>`, skip-link 3면 존재, 전역 `:focus-visible` 링은 system.css가 제공하고
  앱 CSS는 프로그램적 포커스 대상(`.app-main:focus`)만 outline 제거 — 올바른 소비.
- R-5: `.brand` 텍스트 "hvsdcm" 한 덩어리, computed letter-spacing `normal`. 통과.

지적사항:

- `nit` — `smstudy/assets/js/app.js:463`: `.jump-concept` 버튼에 `aria-selected`를 쓰지만 상위에 `role="tablist"`/자신에 `role="tab"`이 없어
  무효 ARIA다(aria-selected는 tab·option·gridcell 등에서만 유효). 수정: `aria-current="true"`로 바꾸거나 role을 부여.
- `nit` — `admin/index.html:94,124,143` `.table-wrap`(overflow-x:auto)에 `tabindex="0"`·`role="region"`·aria-label이 없다.
  Chrome은 포커스 가능 자식이 없는 스크롤 영역을 자동 포커스 대상으로 만들지만 Firefox·Safari의 키보드 사용자는
  세션 표(행 내 포커스 요소 없음)를 가로 스크롤할 수 없다. 수정: `tabindex="0" role="region" aria-label="…"` 부여.
- `nit` — `admin/index.html:23`: `<span class="topbar-link">private · secure</span>` — 링크 스타일의 비상호작용 span.
  장식 문구면 `.topbar-crumb` 계열로 구분하는 편이 어법에 맞다.
- `nit` — `smstudy/assets/css/style.css:104`: `.sm-concept-nav` 배경 `rgba(22,22,23,.86)` — `--surface`(#161617)의 알파 파생 하드코딩.
  §2의 rgba 피드백 테두리와 같은 계열 — 토큰 파생 방식으로 통일 권장.

## 8. 결론

### 지적사항 집계

| 심각도 | 건수 |
|---|---|
| blocker | 0 |
| major | 1 (§4 validate 재정의 금지 목록이 canonical 9종에 한정) |
| nit | 7 (§2 rgba 리터럴, §3 인쇄 .sm-swipe, §4 stripPrint 취약성, §7 aria-selected·table-wrap 키보드·admin span·sm-concept-nav 리터럴) |

### 완료 조건 판정 (내 범위 항목)

| 조건 | 판정 | 비고 |
|---|---|---|
| C-1 `npm test` | **충족** | validate + worker 14/14 직접 실행 통과 |
| C-2 구조 재작성 (앱 3면) | **충족** | numstat 3면 모두 +30/−30 초과, 골격 자체가 신규 |
| C-3 토큰 단일화 (앱 3면 CSS) | **충족** | `:root` 0개, 미정의 토큰 참조 0건, print는 html 재정의 예외 준수 |
| C-4 §3.4 체크리스트 (앱 3면) | **충족** | §6 항목별 실사 — 이미지 실패 폴백 포함 전 항목 동작 |
| C-5 브랜드 표기 (앱 3면 + validate) | **충족** | 소문자 한 덩어리, letter-spacing normal, validateBrandName 신설 확인 |
| C-6 전역·키·순서 (validate) | **충족** | validateGlobalsAndOrder가 §3.1 순서·module 금지·키 존재를 실검사 |
| C-7 main 병합·배포 | 범위 외 | 리뷰 통과 후 단계 |

### 판정

**blocker 0건 — 3b는 배포 가능. major 1건(validate 토큰 목록)은 배포 전 수정 권장이나 배포를 막지 않는다.**
