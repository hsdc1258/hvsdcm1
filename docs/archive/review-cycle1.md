# review.md — 다크 테마 통일 (restyle/dark-apple) 리뷰

## 리뷰 대상
- 커밋 범위: `75f5b71..d780798` (main..restyle/dark-apple, 4 commits)
  - `6d4e125` docs: plan / `cf6b742` wordmaster / `c3a5b36` smstudy / `92d29be` admin / `d780798` docs
  - 변경: 7 files, +202 / -123 (CSS 3, HTML 3, docs 1)
- 구현 모델 / 리뷰 모델: **Fable 5 / Opus 5**
- 라운드: **1** / 2
- 판정 기준: `docs/plan.md` 3절(인터페이스 계약) + 부록 A(DOM 계약). 채팅 맥락 미참조.

### 계약(3절 / 부록 A) 준수 확인 — 전부 통과
| 계약 항목 | 결과 | 근거 |
|---|---|---|
| CSS 셀렉터명·DOM id/class 불변 | ✅ | diff의 모든 hunk가 property value만 교체. 셀렉터 추가/삭제/개명 0건 |
| JS/데이터 파일 불변 | ✅ | `git diff --stat`에 `.js` 파일 0개 (words.js, data.js, app.js, admin.js, account.js, study-utils.js 무변경) |
| localStorage 키 불변 | ✅ | JS 무변경이므로 자동 충족 |
| 파일명·스크립트 로드 순서 불변 | ✅ | 파일 추가·개명 0건. `<script defer>` 순서 무변경. HTML 변경은 폰트 `<link>` 1줄뿐 (부록 A가 명시 허용) |
| 공유 토큰 파일 신설 금지 / 앱 자립 유지 | ✅ | 각 CSS에 `:root` 블록 개별 유지 |
| 구팔레트 잔존 0 (완료 조건 #4) | ✅ | `grep -rniE "#87f5b0\|#86efac\|#6dff9a\|#5fe391\|#4ade80\|#ff7a7a\|#fb7185\|#7dd3fc\|#a8f5bf\|#8fffb0\|#facc15\|#fb923c\|135,245,176\|134,239,172\|95,227,145\|74,222,128\|255,122,122\|251,113,133\|109,255,154\|125,211,252\|250,204,21"` → **0 hits** (css/html/js 전체) |

**계약 위반은 한 건도 없다.** 아래 지적사항은 전부 디자인 정합성 · 접근성 · 프린트 · 테스트 실효성 영역이다.

### 기계 게이트 (재실행 확인)
```
Validation passed (5057 checks)
tests 14 / pass 14 / fail 0
```
→ 통과. 단, 이 게이트의 실효성 자체가 blocker-2 (아래).

## 테스트 실효성
- [ ] 테스트가 plan.md 완료 조건을 실제로 검증한다 (형식적·항상 통과하는 테스트는 blocker)

**미충족.** `scripts/validate.mjs`를 전수 확인한 결과, 이번 변경(=CSS 100% + `<link>` 3줄)에 대한
검증 신호가 **0**이다.
- CSS를 읽는 곳은 `validateUiContracts()` 단 한 곳이며, `home.css`에서 2개
  (`.drawer.logged .drawer-study`, `h1[data-user]`), `WordMaster/.../style.css`에서 2개
  (`#app:focus { outline: none; }`, `grid-template-columns: minmax(0, 1fr)`) — 총 4개의
  **색과 무관한** 부분문자열 검사뿐이다.
- `smstudy/assets/css/style.css`(2,712줄)와 `admin/assets/css/admin.css`(623줄)는 **한 번도 읽히지 않는다.**
  즉 이번 사이클 변경량의 대부분이 무검증 구간이다.
- `validateHtmlAssets()`는 58행에서 `^(?:https?:|data:|#)` 참조를 `continue`로 건너뛰므로
  새로 추가된 jsDelivr `<link>`도 검증 대상이 아니다.

**경험적 반증 (리뷰어 실행, 원복 완료):** smstudy의 `--accent`를 구팔레트 `#86efac`로 되돌리고
`--bg`를 `#ff00ff`로 바꾼 뒤 `node scripts/validate.mjs` 실행 → `Validation passed (5057 checks)`, exit 0.
**이번 작업의 결과물을 통째로 되돌려도 게이트는 초록불이다.**

따라서 plan.md 완료 조건 중 #2(`:root` 토큰 동일 팔레트), #3(computed style), #4(구팔레트 잔존 0)은
`npm test`가 아니라 전부 수작업 근거로 `[x]` 처리되었고, 회귀 방어는 존재하지 않는다.
PIPELINE.md의 "Fable 구현 + Opus 리뷰(동일 계열 폴백) 시 리뷰어는 테스트 실효성을 별도 검증한다"
규칙에 따라 blocker로 올린다. #4는 3줄짜리 grep 체크로, #2는 4개 CSS의 `:root` 파싱·비교로 즉시 자동화 가능하다.

## 지적사항

| # | 심각도 | 파일:위치 | 내용 | 수정 제안 |
|---|---|---|---|---|
| 1 | **blocker** | `smstudy/assets/css/style.css:2255-2273` (`@media print` 의 `:root`) | **프린트 스타일 회귀.** 부록 A에 따라 `.feedback.correct .feedback-title`을 `var(--accent)` → `var(--green)`으로 재지정(1229행)했는데, 프린트용 `:root`는 `--accent:#187341`만 오버라이드하고 `--green`은 정의하지 않는다. 결과적으로 인쇄 시 최상단 `:root`의 `--green:#30d158`이 그대로 내려와 **흰 종이 위 대비 5.89:1 → 2.02:1**로 붕괴(WCAG AA 4.5:1 미달). `--greenbg`(1213행), 그리고 애초에 프린트 `:root`에 없던 `--danger`(#ff453a, 3.34:1)·`--dangerbg`도 동일 구멍. 스크린 오버라이드는 `@media screen`으로 잘 격리해 놓고 프린트 토큰만 갱신을 빠뜨린 케이스 | `@media print`의 `:root`에 프린트 안전값 추가:<br>`--green:#187341; --greenbg:#eff9f3; --danger:#a3231b; --dangerbg:#fdeceb;`<br>(기존 `--accent:#187341` / `--accentbg:#eff9f3`와 동일 명도 계열) |
| 2 | **blocker** | `scripts/validate.mjs` / `package.json:test` | **기계 게이트가 이번 변경에 대해 항상 통과한다.** 위 "테스트 실효성" 절의 반증 실험 참조 — 팔레트를 구버전으로 되돌려도 5057/5057 통과. plan.md 완료 조건 #2·#4가 자동 검증되지 않아 회귀 방어가 0 | `validate.mjs`에 CSS 검사 2종 추가: ① 4개 CSS(+html)에 구팔레트 hex/rgb 리터럴 부재 검사(완료 조건 #4 자동화), ② `assets/css/home.css`의 `:root`를 파싱해 `--bg/--surface/--surface-2/--surface-3/--text/--muted/--line/--green` 값이 WordMaster·smstudy·admin의 **실효** `:root`와 일치하는지 비교(완료 조건 #2 자동화). 겸사겸사 `format:css` 대상에 WordMaster CSS 추가(nit 10) |
| 3 | major | `smstudy/assets/css/style.css:241-245` | **`.badge.green`이 자기모순 상태로 렌더된다.** `background:var(--accentbg)` + `color:var(--accent)`인데 `--accent`가 초록(#86efac) → **보라(#bf5af2)**로 바뀌었고, 테두리만 `rgba(48,209,88,.24)` 초록으로 교체되었다. 결과: 보라 배경 + 보라 글자 + 초록 테두리. `smstudy/assets/js/app.js:429,455,484,986` 4곳에서 실제로 렌더된다 | 이 배지는 성공 피드백이 아니라 장식 라벨이므로 브랜드색으로 통일: 테두리를 `rgba(191,90,242,.24)`로 되돌리거나, 클래스 의미를 살릴 거면 `background:var(--greenbg); color:var(--green)`로 3속성을 함께 초록으로 맞춘다 (셀렉터명은 계약상 그대로 유지) |
| 4 | major | `smstudy/assets/css/style.css:546, 556, 560, 874, 939, 1597, 1599` | **장식용 green이 시맨틱 green과 뒤섞였다.** 부록 A는 `--green`을 정답/성공 전용으로 규정하는데, 구버전에서 *브랜드색*이던 초록이 기계적으로 `#30d158`(성공색)에 매핑되면서 `.notebook-menu a:hover`(초록 테두리 + `var(--accent)` 보라 글자), `.notebook-hero`, `.recall-lab`, `.concept-visual`, 인출 힌트 dashed 박스 등 **성공과 무관한 장식 표면**이 성공색을 두르고 있다. 같은 파일 2604-2626행(`@media screen` 레이어)에서는 green을 `.correct-option`/`.feedback.correct`에만 올바로 쓰고 있어 규칙이 파일 내부에서 엇갈린다 | 구 브랜드-초록 → `--accent`(퍼플) 계열로 재매핑: 546/556/560/874/939/1597/1599의 `rgba(48,209,88,…)`를 `rgba(191,90,242,…)`로 교체. green은 `.correct-option`·`.feedback.correct`·`.badge`(#3 결정에 따름)에만 남긴다 |
| 5 | major | `WordMaster/assets/css/style.css:2-20` vs `438-458`, `smstudy/.../style.css:2-26` vs `2338-2360` | **한 파일 안에 `:root`가 둘이고 값이 서로 다르다.** 이번에 새로 쓴 최상단 블록의 상당수 값이 뒤쪽 "Apple layer" `:root`에 덮여 **실제로는 적용되지 않는다.** WordMaster 기준 불일치: `--danger` #ff453a→**#ff6961**, `--muted-2` #6e6e73→**#5f5f64**, `--accent-strong` #0a84ff→**#147ce5**, `--line-soft` .08→**.09**, `--accent-bg` .14→**.13**, `--danger-bg` .14→**.12**, `--radius-xl/lg/md` 28/20/14→**30/22/15**, `--shadow`도 상이. smstudy도 동일 패턴. 부작용: 같은 커밋에서 하드코딩한 `rgba(255,69,58,…)` 테두리(212, 239, 297행 등)가 **실효 `--danger`(#ff6961)와 색이 안 맞는다**. 또한 파일을 읽는 사람은 최상단 값을 진실로 오인한다 | 두 `:root`를 하나로 병합하거나(권장), 최상단 블록을 뒤쪽 실효값과 동일하게 맞춘다. 하드코딩 rgba 테두리도 실효 `--danger`에 맞춰 `rgba(255,105,97,…)`로 정렬하거나 `color-mix`/별도 `--danger-line` 토큰으로 빼낸다 |
| 6 | major | `admin/assets/css/admin.css:74, 90, 316, 326, 342, 362, 388, 402, 474, 482, 490` | **plan.md 2절의 admin 지시("하드코딩 색 제거 → 동일 토큰 체계로 재작성")가 미이행.** 하드코딩 그레이 11곳(`#555`×2, `#666`×4, `#707070`×2, `#777`×5)이 그대로 남았고, 다수가 대비 미달이다 — `#161617` 카드 위에서 `#555` ≈ **2.48:1** (388행 `.device-cell small` 9px, 482행 `.answer-fold summary span` 11px), `#666` ≈ **3.22:1** (402행 `.empty-row`), `#777` ≈ **4.13:1** (90행 `th`, 13px). 전부 본문급 소형 텍스트라 AA 4.5:1 미달 | 최소한 `#555`/`#666`을 `var(--muted)`(#86868b, 5.1:1)로, `#777`도 `var(--muted)`로 승격. 더 흐린 3차 텍스트가 필요하면 `--muted-2:#6e6e73`(≈3.8:1)를 admin `:root`에 추가하고 11~13px 이상에만 사용 |
| 7 | major | `WordMaster/assets/css/style.css:190, 580` (+ 기준선 `assets/css/home.css:611, 646`) | **`.primary-btn`의 흰 글자 대비 3.02:1로 AA 미달.** `background:var(--accent)`(#2997ff) + `color:#fff`. 버튼 라벨은 16px/800 → 18.66px "large text" 기준에 못 미치므로 4.5:1이 적용된다. hover의 `--accent-strong`(#147ce5)도 4.16:1로 여전히 미달. 홈(기준 팔레트)이 같은 조합을 쓰고 있어 **4개 표면 전체에 동일하게 걸린다** | CTA 배경만 Apple 실제 버튼 블루 `#0071e3`로 내리면 흰 글자 **4.70:1**로 AA 통과하고 팔레트 인상도 유지된다. `--accent`(텍스트·아이콘용 #2997ff)는 그대로 두고 `--accent-cta:#0071e3`를 별도 토큰으로 두는 편이 안전 |
| 8 | major | `admin/assets/css/admin.css:510-516`, `157`, `542` | **완료 조건 #2(4개 표면 `:root` 동일 팔레트)가 admin에서 부분 미충족.** admin의 실효 `:root`는 `--line/--muted/--blue/--green/--red` 5개뿐으로 `--bg/--surface/--surface-2/--surface-3/--text`가 아예 없고(해당 값은 전부 리터럴), 그마저도 `--blue:#2997ff`를 정의해 놓고 `.head small`(157행)·542행은 홈 팔레트에 없는 **`#64d2ff`(smstudy의 `--blue`)**를 쓴다. `--line` 알파도 4개 표면이 제각각(home `.12` / WordMaster `.14` / smstudy `.14` / admin `.1`) | admin `:root`에 `--bg:#000; --surface:#161617; --surface-2:#1d1d1f; --surface-3:#242426; --text:#f5f5f7`를 추가하고 리터럴을 토큰으로 치환. `.head small`은 `var(--blue)`(#2997ff)로 통일. `--line`은 4개 파일 모두 home 기준 `rgba(255,255,255,.12)`로 정렬 |
| 9 | nit | `WordMaster/index.html:18`, `smstudy/index.html:18`, `admin/index.html:9` | Pretendard jsDelivr `<link>` 관련 3점: ① `as="style"`은 `rel="preload"`에서만 유효하고 `rel="stylesheet"`에서는 무의미(공식 스니펫 그대로라 무해). ② 핀이 `gh/orioncactus/pretendard@v1.3.9` — git **태그는 가변**이므로 엄밀한 고정이 아니다. ③ 세션 IP·UA 같은 개인정보를 노출하는 `/admin/` 콘솔에까지 서드파티 CDN을 새로 물렸다(AGENTS.md의 admin 데이터 취급 방침 관점). 로컬 폴백(`Pretendard` → `-apple-system`) 스택은 정상이라 가용성 리스크는 낮다 | 최소 조치로 admin에서는 CDN 링크를 빼고 시스템 폰트 스택만 쓰거나, 4개 표면 모두 커밋 SHA 핀(`@<sha>`)으로 교체. 홈은 이미 main에 동일 링크가 있어 일관성 자체는 문제없음 |
| 10 | nit | `package.json:8` (`format:css`) | 포맷 대상이 `home.css`, `admin.css`, `smstudy/style.css` 3개뿐이고 **`WordMaster/assets/css/style.css`만 빠져 있다.** 실제로 이 파일만 한 줄 다중 선언·공백 스타일이 달라 diff에서도 서식이 튄다 | `format:css` 스크립트 인자에 `WordMaster/assets/css/style.css` 추가 |
| 11 | nit | `admin/assets/css/admin.css:284, 374, 378` | `:root`에 `--green:#30d158`을 정의해 두고 `.session-link`·`.status-badge.active`는 `#7ee49b`라는 팔레트 외 리터럴을 쓴다(`:before` 점만 `#30d158`). `--red:#ff6961`도 정의만 되고 `.danger`/`.error`는 리터럴 사용 | `color:var(--green)`(#30d158, `#161617` 위 9.1:1로 대비도 더 좋다) / `color:var(--red)`로 치환 |
| 12 | nit | `smstudy/assets/css/style.css:19-21` vs `2358-2360` | 두 `:root` 사이 알파값 미세 불일치 — `--warnbg` .11 vs **.1**, `--bluebg` .1 vs **.11**, `--accentbg` .13 vs .13(일치). #5의 하위 항목이며 시각 영향은 미미 | #5 병합 시 함께 정리 |

- blocker: 머지 불가 (버그, 보안, 계약 위반)
- major: 수정 강력 권장 (설계 문제, 엣지케이스 누락)
- nit: 선택 (스타일, 네이밍)

### 잘 된 점 (기록용)
- 인터페이스 계약(3절) 준수도가 높다. 셀렉터 개명 0건, JS 무변경으로 DOM 계약이 구조적으로 자동 충족됐고,
  부록 A가 예측한 "값만 교체" 전략이 그대로 지켜졌다.
- 구팔레트 잔존 0은 리뷰어 grep으로 **독립 재확인**되었다(완료 조건 #4는 실질 달성, 다만 자동화 부재 → blocker-2).
- smstudy에서 스크린 전용 오버라이드를 `@media screen`으로 격리해 프린트 레이어와 분리한 설계는 옳다
  (그래서 blocker-1은 구조 문제가 아니라 토큰 4개 누락이며, 수정 비용이 작다).
- `assets/css/site-nav.css`·`assets/css/home.css` 무변경은 타당하다 — 두 파일은 이미 Apple 팔레트·
  `#2997ff` 포커스 링·Pretendard 스택을 쓰고 있어 plan 2절의 "정합성 확인" 요건을 이미 충족한다.
  (다만 plan 7절 2단계에 대응하는 커밋이 없어 "확인했음"이 커밋 이력에 남지 않았다.)

## 판정 (라운드 1 시점 — 최종 판정은 아래 라운드 2 참조)
- [ ] 승인 (blocker 0 + 기계 게이트 통과)
- [x] **수정 후 재검토**
- [ ] 중단 — 사용자 판단 필요

**사유:** 기계 게이트는 통과하나 blocker 2건(프린트 대비 회귀 / 게이트 무효)이 남아 있다.
계약 위반은 없으므로 롤백은 불필요하며, 두 blocker 모두 국소 수정으로 해소된다.

**원 구현자(Fable 5) 권장 처리 순서**
1. **blocker-1**: `@media print` `:root`에 `--green/--greenbg/--danger/--dangerbg` 프린트 안전값 4줄 추가
2. **blocker-2**: `validate.mjs`에 구팔레트 grep 검사 + 4개 CSS `:root` 팔레트 대조 검사 추가
   → 추가 직후 팔레트를 일부러 깨뜨려 **실패하는지** 확인(형식적 테스트 방지)
3. **major 3·4**: smstudy 장식 green → 퍼플 재매핑, `.badge.green` 3속성 정합화
4. **major 5·8**: 이중 `:root` 병합, `--line` 4개 표면 `.12`로 정렬, admin 토큰 보강
5. **major 6·7**: admin 하드코딩 그레이 → `var(--muted)`, CTA 블루 `#0071e3`로 AA 확보
6. nit 9~12는 선택 (단, 10은 1줄이라 함께 처리 권장)
7. `npm test` 재실행 → 라운드 2 재검토

---

# 라운드 2 재검토

## 리뷰 대상
- 수정 커밋: **`f6979ab`** "fix: address review round 1 (2 blockers, 6 majors, 3 nits)"
  (9 files, +237 / -79). 누적 범위 `75f5b71..f6979ab`
- 구현 모델 / 리뷰 모델: **Fable 5 / Opus 5**
- 라운드: 1 / **2** (최대 라운드 도달)
- 판정 기준: 라운드 1과 동일 (`docs/plan.md` 3절 + 부록 A). 코디네이터 요약을 신뢰하지 않고
  `git show f6979ab` 전문과 파일 실측으로 독립 검증함.

### 계약 재확인
`f6979ab`는 라운드 1 범위 밖 파일 3개(`scripts/validate.mjs`, `package.json`, `assets/css/home.css`)를
건드린다. plan.md 3절은 원래 `scripts/` 불변을 규정했으나,
**같은 커밋에서 3절에 계약 변경 이력을 명시적으로 append**했다(검사 삭제·완화는 계속 금지 조건 부기).
blocker-2 대응에 필수적인 변경이고 절차(계약 변경을 계약서에 기록)를 지켰으므로 **적법한 계약 개정으로 인정**한다.
`home.css` 변경은 라운드 1 major-7이 홈을 기준선으로 지목했으므로 범위 내다.
DOM id/class·셀렉터명·JS·localStorage 키는 여전히 무변경(**`.js` 앱 파일 0건**) — 계약 위반 0건 유지.

## 테스트 실효성
- [x] 테스트가 plan.md 완료 조건을 실제로 검증한다 (형식적·항상 통과하는 테스트는 blocker)

**충족.** `validateDesignTokens()`를 코드로 읽고, **리뷰어가 직접 5회 파괴 실험**을 돌려 실패 동작을 확인했다
(전부 원복, `git status` clean):

| 실험 | 조작 | 결과 |
|---|---|---|
| A | smstudy `--accent`를 구팔레트 `#86efac`로 되돌림 | **exit 1** — `legacy palette literal found` |
| B | smstudy 실효 `--line` `.12`→`.14` (`@media screen` 블록) | **exit 1** — `--line is …,.14, expected …,.12` |
| C | `WordMaster/index.html`에 `#86efac` 삽입 | **exit 1** — `legacy palette literal found` |
| D | admin `:root`에서 `--text` 제거 | **exit 1** — `shared token --text is not defined` |
| E | WordMaster **비실효**(앞쪽) `:root`의 `--line`만 파괴 | exit 0 — 통과 (아래 nit-13) |

라운드 1의 반증 실험(“팔레트를 통째로 되돌려도 초록불”)이 이제 **재현되지 않는다.**
검사 수 5057 → **5105 (+48)** 도 4파일 × (리터럴 1 + 토큰 5×2) + HTML 4 = 48로 정확히 일치해,
숫자를 부풀린 형식적 검사가 아님이 확인된다. 구현 방식도 “home.css 파싱” 대신
공유 기대값 상수 + **실효 `:root`(마지막 선언 우선, print/light 블록 제외)** 비교로,
라운드 1 major-5가 지적한 이중 `:root` 문제를 정면으로 다룬 설계다.

### 기계 게이트 (리뷰어 재실행)
```
Validation passed (5105 checks)
tests 14 / pass 14 / fail 0
```

## 라운드 1 지적사항 처리 결과

| # | 심각도 | 상태 | 검증 근거 |
|---|---|---|---|
| 1 | blocker | ✅ **해소** | `smstudy/…/style.css:2269-2272` 프린트 `:root`에 `--green:#187341 / --greenbg:#eff9f3 / --danger:#a3231b / --dangerbg:#fdeceb` 추가. `.feedback.correct .feedback-title`이 인쇄 시 **2.02:1 → 5.89:1**로 복구 (단, 부수 효과 → major-15) |
| 2 | blocker | ✅ **해소** | 위 파괴 실험 A~D 참조. 게이트가 더 이상 무신호가 아님 |
| 3 | major | ✅ 해소 | `:241-245` `background:var(--greenbg)` / `color:var(--green)` / 초록 테두리 3속성 정합 (제시한 2안 중 “green 정합화” 채택) |
| 4 | major | ✅ 해소 | `:546,556,560,874,939,1597,1599` 7곳 전부 `rgba(191,90,242,…)` 퍼플로 재매핑. 잔존 장식 green 0건 (grep 확인) |
| 5 | major | ✅ 해소 | WordMaster·smstudy 이중 `:root` 값 통일 — `--danger` #ff453a, `--muted-2/2` #6e6e73, `--line-soft/soft` .08, `--accent-strong` #0077ed, radius 30/22/15·28, shadow/max 정렬 |
| 6 | major | ✅ 해소 | admin 하드코딩 그레이 12곳(`#555`×2·`#666`×4·`#707070`×2·`#777`×5, `#999` 포함) → `var(--muted)`(#86868b). 최악 **2.48:1 → 5.1:1** |
| 7 | major | ⚠️ **부분 미해소** | `--accent-cta:#0071e3` 신설 및 홈 2곳·admin `button.primary`는 정상 적용. **WordMaster만 실효 규칙이 누락** → major-14 |
| 8 | major | ✅ 해소 | admin `:root`에 `--bg/--surface/--surface-2/--surface-3/--text` 추가·리터럴 토큰화, `--line` 4개 표면 `.12` 정렬, `#64d2ff`→`var(--blue)` |
| 9 | nit | ✅ 해소(선택 수용) | admin에서 jsDelivr `<link>` 제거. WM/sm은 홈과 동일 핀 유지 — 일관성 근거 타당 |
| 10 | nit | ✅ 해소 | `format:css`에 WordMaster CSS 추가 |
| 11 | nit | ⚠️ 대부분 해소 | `.session-link`·`.status-badge.active`·`.danger`·`.error` → `var(--green)`/`var(--red)`. 잔여 리터럴 → nit-16 |
| 12 | nit | ✅ 해소 | `--warnbg` .11 / `--bluebg` .1로 두 블록 일치 |

**blocker 2/2 해소, major 5/6 해소, nit 3.5/4 해소.**

## 라운드 2 지적사항 (신규 · 잔여)

| # | 심각도 | 파일:위치 | 내용 | 수정 제안 |
|---|---|---|---|---|
| 13 | ~~blocker~~ **없음** | — | **blocker 0건.** 라운드 1의 두 blocker 모두 실측으로 해소 확인 | — |
| 14 | major | `WordMaster/assets/css/style.css:578-580` (vs 수정된 `:188-190`) | **major-7이 WordMaster에서 실효되지 않았다.** 190행은 `var(--accent-cta)`로 고쳤으나, 파일 뒤쪽 "Apple layer"의 **`.primary-btn { background:var(--accent) }`(578행)** 이 손대지 않은 채 남아 있다. 미디어 쿼리 밖 동일 특이도의 후행 규칙이므로 **이쪽이 이긴다.** 실제 렌더 색은 여전히 `#2997ff`이고 흰 글자 대비 **3.02:1로 AA 미달 그대로**다. 커밋 메시지·보고의 "WordMaster .primary-btn(양쪽 블록) 적용"은 사실과 다르다. 라운드 1 major-5가 경고한 **이중 블록 함정이 그대로 재현된 사례** | `:579`를 `background:var(--accent-cta)`로 변경(1줄). `:582` hover는 이미 `var(--accent-strong)`=#0077ed로 정렬돼 있어 추가 조치 불필요 |
| 15 | major | `smstudy/assets/css/style.css:2460-2462` (`@media screen`, 실효) | **smstudy 기본 버튼이 AA 미달** — `.primary { background:var(--accent)(#bf5af2); color:#fff }` → **3.52:1**. 라운드 1 major-7이 WordMaster·홈만 지목해 누락한 건으로, **리뷰어 측 라운드 1 커버리지 결함**임을 밝혀 둔다. 아이러니하게도 비실효 블록(`:182-185`)의 `color:#07140c`는 5.6:1로 통과하는데 실효 블록이 흰 글자로 덮어써 더 나쁘다 | 퍼플 CTA용 토큰 `--accent-cta:#9330d1`(흰 글자 4.6:1) 신설 후 `:2461`에 적용, 또는 `:2462`를 `color:#0f0417`(어두운 글자, 5.4:1)로 되돌린다. 후자가 1줄이고 첫 블록과도 일관됨 |
| 16 | major | `smstudy/assets/css/style.css:1191-1193, 1199-1201` (프린트 경로) | **blocker-1 수정의 부수 효과.** 프린트 `--green`/`--danger`가 어두운 값(#187341/#a3231b)으로 바뀌면서, 그 위에 **어두운 글자를 얹는** 선택지 번호 칩이 인쇄 시 어두운색 위 어두운색이 됐다 — `.correct-option span`(#07140c on #187341) **9.8:1 → 3.37:1**, `.wrong-option span`(#1b070b on #a3231b) **5.93:1 → 2.51:1**. 화면에서는 정상(밝은 칩)이라 눈에 안 띈다. 프린트 시트가 개념노트 뷰 중심이라 노출 빈도는 낮지만, 회귀 방향은 명확 | `@media print`에 2줄 추가: `.choice-option.correct-option span,.choice-option.wrong-option span{color:#fff}` → 각각 5.89:1 / 7.46:1로 복구 |
| 17 | nit | `scripts/validate.mjs` — `validateDesignTokens()`의 `expected` 상수 | 새 토큰 검사가 `--bg/--surface/--text/--line/--green` **5개만** 대조한다. 라운드 1에서 실제 드리프트가 났던 `--surface-2/-3`, `--muted`, `--danger`, 신설 `--accent-cta`는 미커버. 또 실험 E대로 **비실효 `:root`의 드리프트는 통과**한다(실효값 검사라 설계상 맞지만, major-5가 지적한 "읽는 사람이 오인하는" 상태는 계속 만들 수 있다) | `expected`에 `surface2:'#1d1d1f'`, `surface3:'#242426'`, `muted:'#86868b'`, `danger` 추가. 여유가 있으면 "같은 파일 내 모든 스크린 `:root`가 동일 토큰에 동일 값" 검사를 1줄 덧붙이면 실험 E 구멍과 major-14류가 함께 막힌다 |
| 18 | nit | `smstudy/assets/js/app.js:429,455,484,986` 렌더 지점 | major-3(green 정합)과 major-4(장식 → 퍼플)를 각각 다르게 처리한 결과, **장식 라벨인 `.badge.green`만 성공색 초록으로 남아** 퍼플로 바뀐 `.concept-visual`·`.notebook-hero` 패널 안에 초록 배지가 놓인다. 두 결정이 서로 반대 방향. (라운드 1 #3에서 리뷰어가 양자택일을 허용했으므로 계약 위반은 아님) | 장식 통일을 택한다면 `.badge.green` 3속성을 퍼플로. 현행 유지도 무방하나 **택일 근거를 plan.md나 LESSONS에 한 줄 남길 것** |
| 19 | nit | `admin/assets/css/admin.css:295, 345, 379, 397, 545`, `WordMaster …:17` vs `smstudy …:17` | 잔여 리터럴 — admin `#aaa`(295) `#ddd`(345) `#b7b7b7`(397), **`background:#30d158`(379, `var(--green)`로 바꿀 수 있음)**, `.head` 그라디언트 `#102a3e/#0b0b0d`(545)는 공유 팔레트 밖 색. 또 성공 배경 알파가 표면 간 불일치 — WordMaster `--green-bg` **.14** vs smstudy `--greenbg` **.13** | 379는 `var(--green)`으로(1줄), 그레이 3개는 `var(--muted)`/`var(--text)` 계열로. `--green-bg` 알파는 `.13`으로 통일하고 nit-17의 `expected`에 넣어 고정 |

- blocker: 머지 불가 (버그, 보안, 계약 위반)
- major: 수정 강력 권장 (설계 문제, 엣지케이스 누락)
- nit: 선택 (스타일, 네이밍)

**라운드 2 집계 — blocker 0 / major 3 / nit 3**
(major 3건 중 #14는 라운드 1 major-7의 잔여, #15는 리뷰어 라운드 1 누락분, #16은 blocker-1 수정의 부수 효과)

### 잘 된 점 (기록용)
- blocker-2 대응이 **형식적 통과 회피에 성공**했다. 검사 수 증가분이 산식과 정확히 일치하고,
  리뷰어의 독립 파괴 실험 4/5가 의도대로 실패했다. 특히 "실효 `:root`(마지막 선언 우선)" 개념을
  검사에 그대로 옮겨, 라운드 1 major-5의 구조적 지적을 코드로 고정한 점이 좋다.
- 계약(3절) 범위를 벗어나는 수정이 필요해지자 **같은 커밋에서 계약서를 개정하고 이력을 남겼다.**
  파이프라인 원칙("핸드오프 매개체는 채팅이 아니라 커밋과 docs")에 부합하는 처리다.
- nit-9(admin CDN 제외)처럼 **표면별로 다른 판단을 내리고 근거를 남긴** 항목이 있다 — 일괄 수용이 아니라
  개인정보 콘솔이라는 맥락을 반영했다.
- major-6은 지적한 11곳보다 많은 12곳(`#999` 추가 발견)을 고쳤다.

## 최종 판정 (라운드 2)
- [x] **승인** (blocker 0 + 기계 게이트 통과)
- [ ] 수정 후 재검토
- [ ] 중단 — 사용자 판단 필요

**사유:** PIPELINE.md 7단계 승인 조건(**blocker 0개 AND 기계 게이트 통과**)을 충족한다.
계약 위반 0건, blocker 0건, `Validation passed (5105 checks)` + `14/14`를 리뷰어가 재실행해 확인했다.
잔여 major 3건은 정의상 "수정 강력 권장"이며 머지를 막지 않는다.

**배포(push) 전 권고 — 잔여 major 3건은 총 4줄 수정으로 끝난다**
1. **#14** `WordMaster/assets/css/style.css:579` → `background:var(--accent-cta)` *(1줄. major-7이 실제로는 미적용 상태이므로 우선순위 최상)*
2. **#15** `smstudy/assets/css/style.css:2462` → `color:#0f0417` *(1줄)*
3. **#16** smstudy `@media print`에 선택지 칩 `color:#fff` 규칙 *(2줄)*
4. 위 3건 반영 후 `npm test` 재실행(회귀 없음 확인). nit 17~19는 다음 사이클로 미뤄도 무방
5. plan.md 완료 조건 #1의 "5057 checks"는 **5105**로 갱신 필요 (현재 수치가 낡음)

**`/retro`(8단계) 반영 제안 — LESSONS.md 후보 규칙 3건**
- CSS 한 파일에 같은 셀렉터 규칙이나 `:root`가 **두 번 이상 등장하면, 값을 고칠 때 전 블록을 함께 고치고
  "실효 블록"이 어디인지 확인한다** (근거: 사이클 #1 라운드 1 major-5, 라운드 2 major-14 — 동일 함정 2회 재발)
- 색 토큰의 **명도를 바꾸는 수정은 그 토큰을 배경으로 쓰는 규칙의 전경색도 함께 점검한다**
  (근거: 사이클 #1 blocker-1 수정이 프린트 칩 대비를 3.37:1/2.51:1로 떨어뜨림 → major-16)
- **완료 조건에 "grep으로 확인" 같은 수작업 검증을 쓰지 않는다.** 기계로 검증 가능한 조건은
  기획 단계에서 검사 코드까지 함께 지정한다 (근거: 사이클 #1 blocker-2)
