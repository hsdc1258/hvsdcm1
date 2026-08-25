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
