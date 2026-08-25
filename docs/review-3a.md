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
