# review.md — 사이클4: 사이트 전면 재설계

- 대상 커밋: c79d01a..ff04237 (구현 d80ade3~ccf2f57)
- 구현: Opus 5 / 리뷰: Codex(GPT, --sandbox read-only) — 교차 검토
- 기계 게이트(리뷰 시점): npm test 14/14 통과
- 결과: **blocker 1 / major 10 / nit 0**
- 사람 게이트 ②: 사용자의 상시 지시(묻지 않고 실행)에 따라 오케스트레이터가 통과 처리, 수정은 원 구현자 Opus 5.

## 지적사항 (Codex 원문)
- **B-1** docs/snapshots/concept-sample.html:1861 — GitHub Pages 배포 루트 아래의 독립 HTML이 로그인 검사 없이 개념 본문·표·회상 문제를 그대로 렌더링하며, `scripts/validate.mjs:34`는 해당 디렉터리를 배포면이 아니라는 잘못된 전제로 검사에서 제외한다. 미로그인 학습 내용 비노출 계약의 직접 위반이다 → 스냅샷을 Pages가 게시하지 않는 위치·형식으로 옮기거나 인증 게이트를 적용하고, 실제 게시되는 모든 HTML을 로그인 게이트 검사 대상으로 포함하라.
- **M-1** scripts/validate.mjs:1669 — 완료 조건은 랜딩·WordMaster·사회·관리자 네 화면의 스냅샷 재생성을 요구하지만 게이트는 `diagrams.html`과 `concept-sample.html` 두 파일만 확인하므로 화면 두 개가 전혀 없어도 통과한다 → 네 화면 각각의 스냅샷 존재 여부와 320/768/1280 검증 산출물을 강제하되, 공개 배포 루트 밖에 보관하라.
- **M-2** sessions/2026-08-26-site-rebuild/log.md:3 — 완료 조건에 명시된 동일 뷰포트·동일 상태의 개념 화면 `documentHeight` 전후 수치가 기록되지 않아 정보 밀도 개선을 검증할 실제 artifact가 없다 → 기준 커밋과 HEAD의 측정 폭·상태·높이(px) 및 증감률을 기록하고 자동 재현 명령을 남겨라.
- **M-3** WordMaster/assets/js/app.js:446 — `rangeHead`를 비롯해 `sessionMistakes`와 `wrongNoteTitle`이 `h2`에서 시각용 `p`로 바뀌어 섹션은 남았지만 스크린리더의 제목 탐색점과 문서 위계가 사라졌다 → 시각 스타일은 유지하되 해당 레이블을 의미론적 `h2`로 복구하고 각 영역의 `aria-labelledby` 연결을 유지하라.
- **M-4** index.html:53 — `📗`, `📘`, `💾`, `🔁`, `📱`가 여러 마크업 위치에 직접 하드코딩되어 화면별 단일 이모지 매핑 소스와 “직접 리터럴 금지” 계약을 위반한다 → 홈 화면의 대상별 이모지를 하나의 데이터 맵에서 공급하고 마크업은 키 기반 슬롯만 참조하게 하라.
- **M-5** scripts/validate.mjs:1389 — 앱 간 이모지 검사가 `markupGlyphs.has(map.app)`라는 집합 포함 여부만 확인하므로 WordMaster와 사회 아이콘을 서로 바꿔도 두 글리프가 집합에 남아 게이트를 통과한다 → 마크업에서 대상 레이블과 글리프의 대응을 추출해 공통 맵의 `대상→글리프`와 정확히 비교하라.
- **M-6** scripts/validate.mjs:1338 — 한 행 한 이모지 검사가 정규식으로 같은 태그의 첫 닫힘만 잡아, 중첩된 `div` 뒤에 있는 두 번째 이모지를 행 바깥으로 오인한다. 따라서 실제 위반 행도 통과할 수 있다 → DOM/HTML AST 또는 중첩 깊이를 추적하는 파서로 각 행의 전체 자손을 검사하라.
- **M-7** assets/css/system.css:573 — 선택 화살표를 두 개의 `linear-gradient`로 그리며 `WordMaster/assets/css/style.css:67`에도 같은 구현을 중복해 그라디언트 금지와 공통 프리미티브 단일화 계약을 함께 위반한다 → 네이티브 화살표나 비그라디언트 아이콘으로 교체하고 WordMaster 선택 필드가 시스템 프리미티브를 직접 사용하게 하라.
- **M-8** assets/css/home.css:74 — 드로어에 `box-shadow: var(--shadow-2)`를 적용하면서 코드 주석만으로 “floating overlay exception”을 새로 만들었다. 디자인 헌장이 허용한 그림자 대상은 sheet/modal, toast, segmented selection indicator뿐이다 → 드로어 그림자를 제거하고 명도 차와 1px 경계선으로 분리하라.
- **M-9** assets/css/system.css:39 — soft 배경 대비 주석이 실제 알파 합성 계산과 소수 둘째 자리까지 일치하지 않는다. 예를 들어 accent/bg-alt는 `5.54`가 아니라 `5.56`, green/bg는 `8.73`이 아니라 `8.71`, red-bright/red-soft surface는 `5.49`가 아니라 `5.52`다 → 토큰과 알파 합성값에서 대비표를 다시 생성하고 주석의 수치를 파싱해 실제 계산값과 비교하는 게이트를 추가하라.
- **M-10** assets/css/system.css:502 — 작은 글자의 `.btn-danger:hover`가 `--red` 전경과 `--red-soft-strong` 배경을 사용해 surface 위 대비가 약 `3.94:1`에 불과하며 WCAG AA의 `4.5:1`을 충족하지 못한다 → hover 전경을 충분히 밝은 위험색으로 바꾸거나 배경을 조정하고 normal·hover·disabled 상태별 대비를 자동 검산하라.

요약: blocker 1 / major 10 / nit 0



## 수정 결과 (6단계 — Opus 5, 원 구현자)

기계 게이트 최종: `npm test` = **validate 13270 checks 통과 + 단위 테스트 14/14 통과**
(리뷰 시점 13065 checks → 게이트 205개 증가). 반박 0건 / 보류 0건.

| 항목 | 처리 | 커밋 |
|---|---|---|
| B-1 | 수정 | `ab98441` |
| M-1 | 수정 | `ab98441`, `6521527` |
| M-2 | 수정(실측 완료) | 아래 표 |
| M-3 | 수정 | `ab98441` |
| M-4 | 수정 | `ab98441` |
| M-5 | 수정 | `ab98441` |
| M-6 | 수정 | `ab98441` |
| M-7 | 수정 | `33c0e31`(시스템) + `6d26db9`(WordMaster) |
| M-8 | 수정 | `6d26db9` |
| M-9 | 수정(수치 9곳 정정 + 게이트 신설) | `33c0e31`, `ab98441` |
| M-10 | 수정(지적보다 넓게) | `33c0e31`, `ab98441` |

### B-1 — 배포면 도출로 전제를 없앰

`docs/snapshots/`를 `docs/_snapshots/`로 옮겼다(Jekyll은 밑줄로 시작하는 경로 조각을
게시하지 않는다). 다만 위치 이동은 절반이고, 진짜 결함은 **"이 디렉터리는 배포면이
아니다"를 손으로 적어 둔 것**이었다. `validate.mjs`에 `publishedHtml()`을 두어
`.nojekyll` 유무와 밑줄·점 경로 규칙에서 게시 HTML 목록을 도출하고, 모든 HTML 검사가
그 목록을 쓰게 했다. 새 `validateStudyExposure()`는 게시되는 모든 HTML에 대해
"랜딩이거나 / account·admin 게이트를 싣거나 / 학습 문구가 없거나" 셋 중 하나를 강제한다.

음성 검사: `.nojekyll`을 추가하면 밑줄 디렉터리가 즉시 검사 대상이 되어 **49건 실패**한다.
옛 위치에 스냅샷을 복원하면 학습 키워드 노출로 실패한다.

### M-1 — 화면 목록도 소스에서 도출

스냅샷 게이트가 두 파일만 봤다. 이제 **게시되는 진입 HTML**(`index.html` + `*/index.html`)을
도출해 생성기의 `SNAPSHOT_BY_SCREEN`과 대조한다. 화면이 늘면 게이트가 스냅샷을 요구한다.
랜딩·WordMaster·admin 스냅샷을 새로 생성했다(랜딩은 로그인 상태, admin은 패널 상태를
정적으로 반영하고 무엇을 반영했는지 각 파일 주석 상자에 적었다).

이 과정에서 **내 새 스냅샷의 결함을 실측으로 잡았다**: 생성기가 인라인 CSS를 한 벌
(system+smstudy)로 갖고 있어 WordMaster 스냅샷에 `.wm-*` 규칙이 하나도 실리지 않았고
320px에서 문서 폭이 390px로 넘쳤다. 화면별 CSS 목록으로 분리했다(`6521527`).

### M-2 — 밀도 증거 (실측)

정적 서버 + 브라우저에서 `iframe` 폭으로 뷰포트를 고정해 계측했다. 대상은 개념 화면
III-01, 같은 스냅샷 래퍼(`.snap-wrap` max-width 900px), 같은 상태(닫힌 `<details>` 제외).
기준은 재설계 전 커밋 `c79d01a`의 `docs/snapshots/concept-sample.html`이다.

| 폭 | `.app-main` 높이 (전) | (후) | 증감 | 문서 높이 (전→후) |
|---|---|---|---|---|
| 320px | 7559px | 3540px | **−53.2%** | 8393 → 4468 (−46.8%) |
| 768px | 5173px | 2509px | **−51.5%** | 5623 → 2982 (−47.0%) |
| 1280px | 4666px | 2515px | **−46.1%** | 5092 → 2965 (−41.8%) |

재현 명령:
```
node scripts/snapshot.mjs
git show c79d01a:docs/snapshots/concept-sample.html > /tmp/before.html
# 정적 서버로 두 파일을 열고, 폭 320/768/1280의 iframe 안에서
# document.querySelector('.app-main').getBoundingClientRect().height 를 읽는다
```

320/768/1280 가로 넘침 실측(네 화면 스냅샷, 스크롤 컨테이너 안쪽은 제외):
**전부 `scrollWidth <= viewport`, 뷰포트 밖 요소 0.**

DESIGN.md §10 고지: 이 세션은 백그라운드라 브라우저 pane이 표시되지 않아 **스크린샷은
찍지 못했다.** 대신 실제 레이아웃 엔진 위에서 DOM 기하(높이·가로 넘침·이탈 요소)를 쟀다.
취향 판정(슬롭 여부)은 사람이 `docs/_snapshots/`의 5개 파일을 열어 확인해야 한다.

### M-9 — 확인된 어긋남과 추가로 찾은 것

Codex가 든 셋(accent/bg-alt `5.54`→**5.56**, green/bg `8.73`→**8.71**,
red-bright/red-soft surface `5.49`→**5.52**)은 모두 사실이었다. 전 조합을 다시 계산해
어긋난 값 **9곳**을 고쳤다: 위 셋에 더해 accent-soft/surface-2 4.59→4.58,
green-soft/bg-alt 7.84→7.86·/surface 6.98→6.97·/surface-2 6.42→6.41,
red-soft/bg 6.64→6.65·/bg-alt 6.13→6.12·/surface-2 5.09→5.11·/surface-3 4.24→4.27·
/surface-4 3.53→3.56, orange-soft/bg-alt 7.72→7.73, 선택 영역 11.53→11.54·9.39→9.37,
`--line-strong` 상한 2.06→2.05, `--line-faint` 상한 1.21→1.20. 또한 `-soft`의 surface-4
값(4.39/4.30)은 본문 하한 미달인데 "(캡션 한정)"으로 적혀 있어 ✗로 정정했다.

게이트 `validateContrastTable()`은 주석 표를 파싱해 `:root` 토큰에서 재계산한 값과
소수 둘째 자리까지 대조하고(60개 이상 비교), **`:root`의 모든 색 토큰이 표에 등장하는지**도
확인한다. 음성 검사: 표의 숫자 하나를 6.96→6.99로 바꾸면 실패한다.

### M-10 — 지적보다 넓은 결함이었다

Codex의 계산(`--red` on `--red-soft-strong` over surface = 3.94)은 정확했다. 다만
원인을 더 파 보니 **normal 상태도 surface-2 위 4.23, surface-3 위 3.53으로 미달**이었고,
표 행 hover(`--line-faint` 합성)와 겹치면 hover가 **4.23**까지 내려갔다. 근본 원인은
"알파 면을 임의의 부모 표면 위에 올린 것"이다. 그래서 면을 불투명 토큰
(`--red-fill` #371d1c / `--red-fill-hover` #49201f)으로 굽고 전경을 `--red-bright`로
올려 **부모와 무관하게 5.49 / 4.93**으로 고정했다. `:disabled`는 opacity .45로
남기고 WCAG 1.4.3 비활성 예외임을 표에 적었다.

게이트는 표의 숫자가 아니라 **`.btn-danger` 규칙이 실제로 참조하는 토큰**에서 계산한다 —
값이 맞아도 규칙이 다른 토큰을 쓰면 화면은 미달이기 때문이다. 알파 면을 쓰면
"부모에 따라 대비가 흔들린다"며 실패한다.

### 게이트가 못 보는 것 (새로 추가한 검사들)

- `publishedHtml()` — GitHub Pages 설정이 브랜치 배포가 아니라 Actions 업로드로 바뀌면
  Jekyll 규칙이 적용되지 않는다. 그 경우 `.nojekyll`을 두어 게이트를 넓은 쪽으로 켜야 한다.
- `validateStudyExposure()` — 학습 여부를 키워드로 판정한다. 키워드가 없는 학습 콘텐츠는 못 본다.
- `htmlElementSlice()` — 따옴표 안의 `>`나 템플릿 보간이 여는 태그를 일찍 끝내면 조각이
  짧아진다. 그때는 **놓칠 뿐 거짓 실패는 내지 않는다**.
- `emojiSourceCount()` — 보간 하나가 `map()`으로 여러 조각을 만드는 경우를 1로 센다.
- `validateLabelledBy()` — 제목 레벨의 논리적 순서, 라벨 문구의 적절성, 런타임 조립 id,
  다른 파일에 정의된 id는 못 본다.
- `validateContrastTable()` — 표에 없는 조합, 글자 크기별 하한 분기(큰 글자 3:1),
  ✗ 표시의 타당성, opacity·filter 합성 상태, 그리고 그 토큰이 **올바른 곳에** 쓰였는지.
- 스냅샷 커버리지 — 스냅샷이 그 화면의 "대표 상태"를 담았는지는 사람이 주석 상자를 읽어야 한다.
