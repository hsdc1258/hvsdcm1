# review-3a.md — 단계 3a 리뷰: 랜딩과 디자인 시스템

> 리뷰어: **Opus 5** (서브에이전트) / 대상 커밋: `4ee698c`, `1c0533a`, `e521b58`, `771bbee` (+ `9f89f47`의 랜딩·토큰 검사 부분)
> 대상 파일: `assets/css/system.css`(신설 665줄), `index.html`, `assets/css/home.css`, `assets/js/home.js`, `scripts/validate.mjs`의 랜딩·토큰·브랜드·전역 검사
> 범위 밖: WordMaster / smstudy / admin 3면 (별도 리뷰어)
> 판정 기준: `docs/plan.md` §3 인터페이스 계약, §4 완료 조건 C-1~C-7, §7 판단 기록 D1~D6

검증 방법: `git diff main..HEAD`(커밋 메시지 아닌 코드), 대비값 직접 계산(WCAG 2.x 상대휘도 공식),
`npm test` 실행, `http-server`로 랜딩을 실제로 띄워 계산 스타일·DOM 상태·리다이렉트 로직 실측.

---

## 0. 먼저 — 검증해서 "통과"로 확인한 것 (지적 아님)

구현자 자기 보고를 받아쓰지 않고 직접 확인한 항목이다. 아래는 **문제 없음**.

- **next 리다이렉트 동일 출처 검증 (보안)** — `assets/js/home.js:79-90` `getSafeNextPath()`는
  `main`의 코드와 **바이트 단위로 동일**하다 (`git diff --ignore-cr-at-eol` 기준 이 함수는 무변경).
  브라우저에서 동일 로직에 오픈 리다이렉트 페이로드 14종을 실측했고 전부 차단됐다:
  `https://evil.example.com/pwn`, `//evil.example.com/pwn`, `///evil.example.com`, `/\evil.example.com`,
  `\evil.example.com`, `javascript:`, `data:`, `htTPs://EVIL...`, `https://localhost:4173.evil.com/` → 모두 `null`.
  `http:evil.example.com`은 `/evil.example.com`(자기 출처 경로)로 축약되어 외부 이탈이 없다. **퇴화 없음.**
- **home.js 실제 변경량은 +26/-2줄뿐** (`--ignore-cr-at-eol`). 로그인·로그아웃·저장 키·에러 처리 로직은
  손대지 않았고, 바뀐 것은 `loginBtn` 단일 참조 → `[data-login-trigger]` 다중 바인딩, `body.logged` 추가,
  `setupReveal()` 신설 셋뿐이다. 셀렉터 교체 과정의 조건 완화·null 가드 누락은 발견되지 않았다.
- **동작 실측** — 드로어 열기/닫기, `Escape`로 드로어·모달 동시 닫힘, shade 클릭 닫힘,
  `data-login-trigger` 2개(히어로·상단바) 모두 모달 오픈, `.drawer.logged`/`.account.logged` 상태 전환,
  로그아웃 시 `hvsdcm.token`·`hvsdcm.user` 제거 + `sessionStorage.clear()` + reload — 전부 정상.
  `hvsdcm` 계정일 때 h1이 `/admin/` 링크로 바뀌는 경로도 보존됐다(`home.js:52-62`).
- **system.css 상단 대비 주석은 정확하다.** 6개 수치를 전부 직접 계산했고 오차 ±0.02 이내다:
  `--text`/`--bg` 19.29(계산 19.285), `--text`/`--surface` 16.61(16.59), `--text-2`/`--bg` 8.16(8.165),
  `--text-2`/`--surface` 7.03(7.026), `--text-3` 5.80(5.797), `--text-4` 4.14(4.141),
  `#fff`/`--accent-strong` 4.70(4.696), `--accent`/`--bg` 6.96(6.964). **주석의 주장은 검증됨.**
- **`--text-3`(5.80:1)는 본문에 쓰이지 않는다.** 랜딩에서의 용처는 kicker·drawer-tagline·word-day·
  society-tag·stat-label·footer-copy·footer-nav 등 캡션/마이크로 전용이다. (단 §3의 M-2·M-4 참조 — 문제는 `--text-4`와 배경 조합 쪽이다.)
- **§3.1 준수** — `index.html`에 `type="module"` 없음, `<script src="/assets/js/home.js" defer>` 단일 classic script.
- **§3.2 준수** — `hvsdcm.token`·`hvsdcm.user`·`hvsdcm.api` 키 이름 그대로.
- **C-3 준수** — `home.css`에 `:root` 0개(주석 1회만 언급), `system.css`에 `:root` 정확히 1개.
- **레이아웃** — 375px 뷰포트에서 가로 오버플로 0px, 넘치는 자식 요소 0개.
- **`npm test`** — `Validation passed (5257 checks)` + 단위 테스트 14개 전부 통과 (실행 확인).

---

## 1. blocker

### B-1. 소셜 미리보기 이미지가 여전히 `HVS/DCM` — R-5 위반이 배포면에 남아 있다

`index.html:12` `<meta property="og:image" content="https://hvsdcm1.xyz/assets/og.png">`
`index.html:16` `<meta name="twitter:image" ...>` — 같은 파일을 가리킨다.

`assets/og.png`를 직접 열어 확인했다. 이미지 중앙에 **대문자 슬래시 분리 표기 `HVS/DCM`**이
그대로 렌더돼 있다. 이 파일의 마지막 변경 커밋은 사이클 #1의 `b6747fc`이고, 이번 사이클에서는 손대지 않았다.

왜 blocker인가:
- R-5는 "브랜드 표기는 **항상** `hvsdcm` 한 덩어리. `HVS DCM`, `hvs-dcm` … 금지. 대소문자는 소문자로 통일"이다.
  og:image는 링크가 공유될 때 **사용자에게 실제로 보이는 랜딩의 대표 이미지**이므로 "표기"의 핵심 표면이다.
- 그런데 C-5의 자동 검사(`validateBrandName()`, `scripts/validate.mjs:389-411`)는
  `.html`/`.css`/`.js` **텍스트만** 스캔한다. PNG 안의 글자는 볼 수 없어 `npm test`가 초록불로 통과한다.
  즉 C-5 게이트는 통과했지만 **R-5는 위반 상태**이며, 게이트가 이 구멍을 덮고 있다.
- 랜딩의 `<title>`·`og:title`·`twitter:title`은 전부 `hvsdcm`으로 고쳤으면서 그 옆 이미지만 옛 표기라
  일관성 결함이 외부에 그대로 노출된다.

고치는 법: `assets/og.png`를 소문자 `hvsdcm` 워드마크로 재생성하고,
`validateBrandName()`에 "og.png의 mtime/해시가 사이클 #2 이후인지" 또는 최소한
`assets/og.png`가 갱신됐다는 사실을 고정하는 체크를 한 줄 추가해 회귀를 막는다.

---

## 2. major

### M-1. 미로그인 상태에서도 학습 앱 링크가 상단바·푸터에 항상 노출 — §3.4 이탈

- `index.html:33-34` — `<a class="topbar-link" href="/WordMaster/">` / `href="/smstudy/"`
- `index.html:185-186` — `.footer-nav`의 같은 두 링크
- `assets/css/home.css:33-37` — 로그인 상태에 반응하는 규칙은 `body.logged .topbar-login { display: none; }` **하나뿐**이고,
  `.topbar-link`·`.footer-nav a`에는 상태 규칙이 없다.

브라우저 실측(미로그인, 1280px): 두 `.topbar-link` 모두 `display: block`. 641px 미만에서는
`@media (max-width: 640px)`가 `.topbar-link`를 숨기므로 **데스크톱 전용 문제**다. 푸터 링크는 폭과 무관하게 항상 보인다.

plan.md §3.4 랜딩 체크리스트는 "**로그인 상태에 따른 학습 링크 노출·숨김**"을 보존 대상으로 명시한다.
히어로 CTA(`.account .account-app`)와 드로어(`.drawer.logged .drawer-study`)는 이 규칙을 제대로 지키는데,
새로 추가된 상단바·푸터 진입점만 이 규칙 밖에 있다. 기능이 깨지지는 않는다 —
로그아웃 상태로 `/WordMaster/`에 가면 `account.js`가 `/?login=1&next=…`로 돌려보낸다.
문제는 **완료 조건 C-4가 요구하는 "체크리스트 전 항목 동작"이 부분 충족**이고,
이것이 의도적 설계 변경이라면 plan.md §7에 판단 기록(D7)이 남았어야 하는데 없다는 점이다.

고치는 법: `home.css`에 `body:not(.logged) .topbar-link, body:not(.logged) .footer-nav { display: none; }`을 추가하거나,
"로그아웃 상태에서도 앱 존재는 노출하되 진입 시 로그인으로 유도한다"는 결정을 plan.md에 D7로 기록한다(둘 중 하나는 필요).

> **[수정 라운드] 고치지 않음 — plan.md §7 D7로 기록.** `main`을 직접 확인한 결과 원래 랜딩의
> `.product-card` 2장(/WordMaster/·/smstudy/)이 로그인 여부와 무관하게 상시 노출돼 있었고(게이팅 규칙 없음),
> 게이팅됐던 표면(드로어·히어로 CTA)은 새 구현이 보존한다. 상단바·푸터 링크는 기존 상시 노출의 등가물이므로 회귀 아님.

### M-2. `.sidebar-label`이 "비활성 전용" 토큰 `--text-4`를 살아있는 라벨에 사용 — 실측 3.56:1, AA 미달

- `assets/css/system.css:573-580` — `.sidebar-label { … color: var(--text-4); }`
- `index.html:48` — `<p class="sidebar-label">학습</p>` (드로어 섹션 라벨)

`system.css:11` 주석은 `--text-4 #6e6e73`을 "**비활성 전용**"이라고 스스로 규정한다.
그런데 같은 파일이 이 토큰을 비활성 상태가 아닌 **정상 섹션 라벨**에 쓰고 있다.
드로어 배경은 `home.css:69` `background: var(--surface)`이고, 브라우저에서 계산 색을 확인했다
(`rgb(110,110,115)` on `rgb(22,22,23)`). 직접 계산한 대비는 **3.56:1** — WCAG AA 본문 기준 4.5:1 미달이며,
`--fs-micro`(12px) 굵은 글씨라 대형 텍스트 예외(3:1)에도 기대기 어렵다.
주석의 대비표는 `--text-4`를 `--bg` 조합(4.14:1)으로만 적어 두어 **실제 사용 조합(surface 위 3.56:1)이 문서화되지 않았다.**

고치는 법: `.sidebar-label`의 색을 `--text-3`(surface 위 4.99:1)로 올리고, 주석 대비표에 surface 조합 행을 추가한다.

### M-3. `.badge-red` 4.24:1 / `.badge-purple` 4.02:1 — 반투명 배경 합성 후 AA 미달

- `assets/css/system.css:491` `.badge-red { background: var(--red-soft); color: var(--red); }`
- `assets/css/system.css:493` `.badge-purple { background: var(--purple-soft); color: var(--purple); }`
- 사용처: `index.html:93` "오답만 재시험"(badge-red), `index.html:117` "개념 노트"(badge-purple)

`--red-soft`/`--purple-soft`는 알파 `.14`의 반투명이므로 실효 배경은 `.feature`의 밝은 끝인
`--surface-2 #1d1d1f`와 합성된다. 합성 후 직접 계산:

| 뱃지 | 전경 | 실효 배경 | 대비 | 판정 |
|---|---|---|---|---|
| `.badge-red` | `#ff453a` | ≈`#3d2323` | **4.24:1** | AA 미달 |
| `.badge-purple` | `#bf5af2` | ≈`#342638` | **4.02:1** | AA 미달 |
| `.badge-green` | `#30d158` | ≈`#203627` | 6.41:1 | 통과 |
| `.badge-orange` | `#ff9f0a` | ≈`#3d2f1c` | 6.30:1 | 통과 |

같은 계열 프리미티브 4개 중 2개만 통과한다 — 토큰을 정할 때 "이 토큰을 참조하는 다른 모든 규칙의 대비도
함께 점검한다"는 LESSONS 규칙(plan.md §5 인용)이 `-soft` 배경 합성 케이스에서 이행되지 않았다.

고치는 법: `--red-soft`/`--purple-soft`의 알파를 `.14` → `.22` 수준으로 올리거나,
뱃지 전경색을 각 색의 밝은 변형(`#ff6961`, `#d08cf5` 등)으로 분리한다. 4종을 한 번에 재계산할 것.

### M-4. 랜딩 본문 단락이 `.feature` 배경에서 6.54:1 — plan §5의 "본문 7:1" 목표 미달

- `assets/css/home.css:172-179` — `.feature { background: linear-gradient(160deg, var(--surface-2), var(--bg-alt) 70%); }`
- `assets/css/home.css:187` / `index.html:82,106` — `.feature-sub`는 `class="feature-sub text-secondary"`,
  즉 실제 제품 설명 **본문 단락**이 `--text-2`로 그려진다.

`--text-2 #a1a1a6` on `--surface-2 #1d1d1f` = **6.54:1**(직접 계산). plan.md §5는
"본문 텍스트는 배경 대비 **7:1 이상**을 목표로 한다"고 못박았다. 히어로(`--bg` 위 8.16:1)와
sync 카드(`--surface` 위 7.03:1)는 목표를 만족하는데, 그라디언트의 밝은 끝만 목표에서 빠진다.
system.css 상단 대비표에 **`--surface-2` 조합 행이 아예 없어서** 이 케이스가 검토된 흔적도 없다.

고치는 법: `.feature` 그라디언트의 시작점을 `--surface-2` → `--surface`로 낮추거나
`.feature-sub`를 `--text`로 올린다. 그리고 대비표에 `--surface-2` 행을 추가해 다음 사이클에서 재발을 막는다.

### M-5. `.hero-title`의 `-webkit-text-fill-color: transparent` — 고대비(forced-colors) 모드에서 h1이 사라진다

`assets/css/home.css:131-138`

```css
.hero-title {
  background: linear-gradient(180deg, var(--text) 62%, var(--text-2));
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}
```

브라우저 실측: `-webkit-text-fill-color`의 계산값이 `rgba(0,0,0,0)`이다. 즉 글자 픽셀은
**오직 부모의 background-image로만** 그려진다. Windows 고대비/`forced-colors: active`에서는 UA가
대부분의 요소에 `background-image: none`을 강제하는데, `-webkit-text-fill-color`는 강제 색상 목록에
포함되지 않는다. 결과적으로 배경이 사라지고 글자는 투명한 채로 남아 **페이지의 h1("Make it stick.",
로그인 후에는 사용자명/Admin 링크)이 통째로 보이지 않게 된다.** 로그인 후 Admin 진입 링크까지
이 h1 안에 있으므로(`home.js:52-62`) 영향 범위가 장식에 그치지 않는다.

고치는 법:
```css
@media (forced-colors: active) {
  .hero-title { background: none; -webkit-text-fill-color: currentColor; color: CanvasText; }
}
```
`.hero-title a.welcome-user`(home.css:143)는 이미 fill을 되돌리는 선례가 있으니 같은 방식이면 된다.

### M-6. validate.mjs의 드로어 검사가 실효성 없음 — 두 조건이 서로 다른 요소를 봐도 통과한다

`scripts/validate.mjs:81`

```js
check(homeHtml.includes('id="drawerStudy"') && homeHtml.includes('aria-hidden="true"'),
      'home: authenticated STUDY drawer with default hidden state is missing');
```

메시지는 "drawerStudy가 기본 숨김 상태인지"를 검사한다고 주장하지만, 두 `includes`는
**같은 요소를 검사하지 않는다.** `index.html`에는 메뉴 버튼 내부 `<span aria-hidden="true">`(29행), `#shade`(40행) 등 8곳에도
`aria-hidden="true"`가 있으므로, `#drawerStudy`에서 `aria-hidden="true"`를 지워도 이 검사는 그대로 통과한다.
plan.md D2가 "검사를 약화하지 않는다"고 했는데, 겉보기엔 강화된 검사가 실제로는 기존 단순 존재 검사와 같은 강도다.

같은 패턴이 `scripts/validate.mjs:87`에도 있다 —
`homeHtml.includes('aria-expanded') && homeHtml.includes('aria-controls="drawer"')`도 요소가 분리돼 있다.

고치는 법: 단일 정규식으로 묶는다 — `/id="drawerStudy"[^>]*aria-hidden="true"/u`,
`/id="menuButton"[^>]*aria-expanded="false"[^>]*aria-controls="drawer"/u`.
(같은 파일 82행의 `loginModal` 검사는 이미 이 방식으로 올바르게 작성돼 있다 — 기준은 이미 파일 안에 있다.)

> **[수정 라운드] 보류 — 통합 수정 라운드에서 처리.** 다른 리뷰어가 validate.mjs를 읽고 있어 지금은
> B-1의 og 잠금 검사만 추가했다. 처리안: 81행을 `/id="drawerStudy"[^>]*aria-hidden="true"/u`로,
> 87행을 `/id="menuButton"[^>]*aria-expanded="false"[^>]*aria-controls="drawer"/u`로 교체(82행 loginModal 검사와 같은 단일 정규식 방식).

### M-7. C-3 게이트의 커버리지 구멍 — 색 토큰 25개 중 9개만 지킨다

`scripts/validate.mjs:363-380`

```js
const colorTokens = ['--bg','--surface','--surface-2','--text','--text-2','--line','--accent','--green','--red'];
...
check(!/:root\s*\{/u.test(source), `${name}: … (no :root block)`);
for (const token of colorTokens) { check(!new RegExp(`(^|[;{\s])${token}\s*:`,'u').test(screenOnly), …); }
```

C-3의 문장은 "`system.css` **외의 CSS 파일에 색 토큰을 정의하는 `:root` 블록이 0개**"이고
D5의 취지는 "디자인 토큰 **단일 원본**"이다. 그런데 실제 게이트는 두 겹 다 헐겁다:

1. **토큰 목록이 9개뿐이다.** `system.css`의 `:root`가 정의하는 색 토큰은 `--bg-alt`, `--surface-3`,
   `--line-strong`, `--line-faint`, `--text-3`, `--text-4`, `--accent-strong`, `--accent-soft`,
   `--green-soft`, `--red-soft`, `--orange`, `--orange-soft`, `--yellow`, `--purple`, `--purple-soft`, `--teal`
   등 16개가 더 있다. 이들은 어느 CSS 파일에서든 자유롭게 재정의해도 검사가 통과한다.
   하필 M-2·M-3에서 문제가 된 `--text-4`, `--purple-soft`, `--red-soft`가 전부 이 미보호 구간에 있다.
2. **`:root`만 금지하고 셀렉터는 안 본다.** 9개 목록 토큰조차 `@media print` 안에서는 검사 대상에서 빠지고
   (`stripPrint`, 364행), 목록 밖 토큰은 `html {}`·`body {}`·임의 셀렉터 어디서든 재정의 가능하다.
   실제로 `smstudy/assets/css/style.css:431`에는 "`:root`가 아니라 `html`에 재정의해
   토큰 단일 원본 규칙(C-3)을 유지한다"는 주석이 달려 있다 — 인쇄용 라이트 팔레트라 plan.md §2가 허용한
   정당한 케이스지만, **게이트가 셀렉터 이름으로 판정한다는 사실**이 주석에 그대로 드러나 있다.
   같은 우회로가 스크린 컨텍스트에도 열려 있다.

즉 C-3은 "형식상 통과"이고, D5의 실질(값이 다시 흩어지지 않음)은 **9개 토큰 범위에서만** 보장된다.

고치는 법: `colorTokens`를 하드코딩하는 대신 `system.css`의 `:root`에서 `--*: <색값>` 선언을 파싱해
토큰 목록을 **자동 생성**하고, 검사 대상을 `:root`가 아니라 "system.css 밖에서의 모든 커스텀 프로퍼티 정의"로 바꾼다.
`@media print` 예외는 파일·블록 단위 허용 목록으로 명시한다.

> **[수정 라운드] 보류 — 통합 수정 라운드에서 처리.** 같은 이유(validate.mjs 동시 열람)로 지금 손대지 않는다.
> 처리안: (1) `system.css`의 `:root` 블록에서 `--[\w-]+\s*:` 선언을 파싱해 colorTokens를 자동 생성,
> (2) 검사 대상을 ":root 블록"이 아니라 "system.css 밖 모든 CSS의 커스텀 프로퍼티 *정의*"로 확장
> (`(^|[;{\s])--[\w-]+\s*:` 전면 금지), (3) 예외는 `smstudy/assets/css/style.css`의 인쇄 라이트 팔레트 블록만
> 파일+토큰 화이트리스트로 명시. og 잠금 검사(validateOgImageLock)와 충돌 없음.

---

## 3. nit

- **N-1. `#apps` 앵커에 `scroll-margin-top`이 없다.** `assets/css/home.css:164` / `index.html:75`(`.hero-browse`).
  상단바가 `position: fixed; height: 52px`(`system.css:227-231`)인데 `.showcase`의 `scroll-margin-top`은 실측 `0px`이다.
  브라우저에서 `#apps` 위치로 스크롤해 재보니 첫 카드 상단 **24px이 상단바에 가린다**(kicker 텍스트 자체는 안 가림).
  → `.showcase { scroll-margin-top: calc(var(--topbar-h) + var(--space-4)); }`.
- **N-2. skip-link가 `:focus-visible`에만 반응한다.** `assets/css/system.css:175`.
  `top: -100%`로 화면 밖에 두고 `:focus-visible`에서만 끌어오므로, 프로그램적 `focus()`나
  `:focus-visible` 판정이 다른 경로에서는 포커스가 보이지 않는 곳에 갇힌다. → `:focus, :focus-visible` 둘 다 건다.
- **N-3. `#main`에 `tabindex="-1"`이 없다.** `index.html:67`. `scripts/validate.mjs:111`은 앱 3면에
  `<main class="app-main" tabindex="-1">`을 **요구**하는데 랜딩만 예외다. skip-link 목적지가
  포커스 가능해야 건너뛰기가 실제 포커스 이동으로 이어진다. 4면 일관성 차원에서도 맞추는 편이 낫다.
- **N-4. `.js` 클래스를 defer 스크립트가 붙인다.** `assets/js/home.js:120` + `system.css:653-661`.
  `.reveal`이 숨겨지는 시점이 파싱 완료 이후라 첫 페인트가 먼저 나가면 "보였다 사라졌다 다시 나타나는" 깜빡임이 가능하다.
  정석은 `<head>` 인라인 한 줄이지만 `validate.mjs:52`가 인라인 `<script>`를 금지하므로,
  대안으로 `.reveal`의 초기 상태를 CSS만으로 잡고 JS는 `.in`만 붙이도록 뒤집는 방법이 있다.
  (JS 실패 시 항상 보이는 폴백은 지금 구조가 더 안전하므로 우선순위는 낮다.) **[수정 라운드: 남김 — 리뷰 스스로 현 구조가 더 안전하다고 판단한 항목, 실익 대비 위험이 큼]**
- **N-5. `.link-arrow` 호버 시 `›` 글리프까지 밑줄이 그어진다.** `system.css:137`의 전역 `a:hover { text-decoration: underline; }`을
  `.link-arrow`(322행)가 상쇄하지 않는다. `.btn`·`.sidebar-item`·`.social-card`는 전부 `:hover`에서 상쇄해 두었으므로 누락으로 보인다.
- **N-6. 드로어·모달 열림 중 배경 스크롤 잠금과 포커스 트랩이 없다.** `home.js:23-31`, `system.css:406-419`.
  드로어가 열려도 뒤쪽 `.topbar-link`가 여전히 탭 도달 가능함을 실측 확인했다.
  **기존 사이클과 동일한 상태이므로 회귀는 아니다.** 다음 사이클 후보. **[수정 라운드: 남김 — 회귀 아님, 다음 사이클]**
- **N-7. `role="dialog" aria-modal="true"`가 백드롭 `div`에 붙어 있다.** `index.html:194`.
  대화상자 본체는 `.sheet`(`<form>`)이므로 의미상 그쪽이 맞다. 닫힘 상태에서 `visibility: hidden`으로
  접근성 트리에서 빠지는 것은 확인했으므로 실사용 영향은 작다. **[수정 라운드: 남김 — validate.mjs 82행이 `id="loginModal"…role="dialog"…aria-modal` 동일 태그를 요구해 지금 옮기면 검사가 깨짐. 검사 수정과 함께 통합 라운드에서]**
- **N-8. R-5의 "자간 분해 금지"는 자동 검사에 없다.** `system.css:214-220`이 `.brand { letter-spacing: normal; }`으로
  코드상 지키고 있지만, `validateBrandName()`은 문자열 패턴만 본다.
  → `.brand` 규칙에 `letter-spacing`을 늘리는 선언이 없는지 검사 한 줄 추가. **[수정 라운드: 남김 — validate.mjs 동시 열람 중, 통합 라운드에서]**
- **N-9. `home.js`가 CRLF→LF 정규화로 전체 재작성처럼 보인다.** 실제 변경은 +26/-2줄인데
  `git diff`는 +170/-146으로 나온다. plan.md §5가 인용한 LESSONS의 "CRLF/LF 혼재 고정" 이행 자체는 맞지만,
  줄바꿈 정규화를 **별도 커밋으로 분리**했다면 `1c0533a`의 리뷰 비용이 훨씬 낮았을 것이다. **[수정 라운드: 남김 — 커밋 이력 재작성은 하지 않음, 프로세스 교훈으로만 수용]**
- **N-10. `stripPrint` 정규식이 포맷 가정에 의존한다.** `scripts/validate.mjs:364`
  `/@media\s+print\s*\{[\s\S]*?\n\}/gu` — 닫는 `}`가 0열에 있다는 전제라, 들여쓰기가 바뀌면 조용히 오작동한다. **[수정 라운드: 남김 — validate.mjs 동시 열람 중, M-7 처리안에 포함해 통합 라운드에서]**
- **N-11. `check(/var\(--/u.test(source), …)`가 모든 CSS 파일에 적용된다.** `scripts/validate.mjs:374`.
  벤더/서드파티 CSS를 한 장이라도 추가하면 오탐으로 빌드가 깨진다. 자체 작성 CSS로 대상을 한정하는 편이 안전하다. **[수정 라운드: 남김 — validate.mjs 동시 열람 중, 통합 라운드에서]**
- **N-12. `.welcome-prefix`는 대응 CSS 규칙이 없는 데드 훅이다.** `index.html:71`, `home.js:49`.
  줄바꿈은 `.hero-title .welcome-user { display: block; }`(home.css:142)이 담당하므로 클래스 자체는 아무 일도 하지 않는다. **[수정 라운드: 남김 — 무해한 훅이고 제거하려면 home.js·index.html 두 파일을 건드려야 해 실익 없음]**

---

## 4. 완료 조건 판정 (3a 범위)

| 조건 | 내용 | 판정 | 근거 |
|---|---|---|---|
| **C-1** | `npm test` 통과 | ✅ 충족 | 실행 확인 — `Validation passed (5257 checks)` + 단위 테스트 14/14 통과 |
| **C-2** | 구조 재작성 증명 (index.html 추가·삭제 각 30줄↑) | ✅ 충족 | `git diff --numstat main..HEAD -- index.html` = **+160 / -87**. 클래스만 바꾼 위장이 아니라 topbar·showcase·sync·stats·socials·footer 섹션이 신설되고 product-grid·signal-strip이 제거된 **실제 DOM 구조 교체**임을 diff로 확인 |
| **C-3** | system.css 외 CSS에 색 토큰 `:root` 0개 | ⚠️ 조건부 충족 | `home.css` `:root` 0개, `system.css` `:root` 정확히 1개 — **문장 그대로는 충족**. 다만 이를 지키는 게이트가 색 토큰 25개 중 9개만 커버한다(**M-7**). D5의 "단일 원본" 실질 보장은 미완 |
| **C-4** | §3.4 체크리스트 전 항목 동작 (랜딩분) | ⚠️ 부분 충족 | 로그인 모달 ✅ / `next` 동일 출처 검증 ✅(페이로드 14종 실측) / `hvsdcm` Admin 링크 ✅ / 드로어 + `Escape` ✅ / 로그아웃 시 토큰·사용자·sessionStorage 클리어 ✅ / Discord·Instagram 외부 링크 ✅ / **로그인 상태에 따른 학습 링크 노출·숨김 ❌(M-1)** — 7항목 중 6항목 충족 |
| **C-5** | `hvsdcm` 표기 분리 없음 | ❌ 미충족 | `validateBrandName()` 자동 검사는 통과하나, 랜딩이 `og:image`/`twitter:image`로 내보내는 `assets/og.png`가 여전히 `HVS/DCM`(**B-1**). 게이트가 PNG를 못 봐서 통과했을 뿐 R-5는 위반 상태 |
| **C-6** | 전역·저장 키·스크립트 로드 순서 보존 | ✅ 충족 | `index.html`에 `type="module"` 없음, `<script src="/assets/js/home.js" defer>` 단일 classic script, `hvsdcm.token`·`hvsdcm.user`·`hvsdcm.api` 키 이름 보존. `validateGlobalsAndOrder()`가 이를 기계 검사로 고정 |
| **C-7** | main 병합·push·Pages 배포 | — 범위 밖 | 3a 리뷰 시점에는 미수행 (브랜치 `rebuild/apple-dark-v2`) |

---

## 5. 총평

`index.html`은 **리스타일이 아니라 실제 구조 재작성**이다(C-2 통과, D1의 목적 달성).
`system.css`는 `:root` 단 하나를 갖고 있고 상단 대비 주석의 수치는 전부 직접 계산해 정확함을 확인했다 —
이 부분에서 구현자의 자기 보고는 신뢰할 만하다. `home.js`는 셀렉터만 최소 침습으로 갈아끼웠고,
가장 걱정했던 **오픈 리다이렉트 방어는 바이트 단위로 그대로**다.

남은 문제는 두 갈래다. 하나는 **대비**(M-2·M-3·M-4) — 주석의 대비표가 `--surface-2`와
`-soft` 반투명 합성 케이스를 다루지 않아 세 곳에서 AA·목표치를 놓쳤다.
다른 하나는 **게이트의 실효성**(M-6·M-7, 그리고 B-1) — 검사가 초록불인데 요구사항은 위반인 구간이 있고,
B-1은 그 구멍으로 R-5 위반이 실제 배포면까지 나간 사례다.

**배포 가능 여부: 아직 아니다.** B-1(og.png)만 고치면 나머지는 배포를 막을 정도는 아니지만,
M-1은 C-4 판정에 직결되므로 코드 수정이든 plan.md 판단 기록이든 한 쪽은 반드시 정리하고 넘어가야 한다.
