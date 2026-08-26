# 게이트 음성 테스트 — 사이클3 3b (렌더러 트랙)

`scripts/validate.mjs`에 신설한 구조 계약 검사(plan.md §5)가 **값을 위반시키면 실제로 실패하는지**
1건씩 확인한 기록이다. LESSONS 규칙 4("두 개의 독립된 존재 검사를 AND로 묶어 요소 하나를 검증한
것처럼 쓰지 않는다 — 값을 지우는 음성 테스트로 실제로 실패하는지 확인한다")에 따른다.

## 수행 방법

작업 트리를 직접 훼손하지 않았다. `git archive HEAD`로 저장소 스냅샷을 스크래치패드에 풀어
**샌드박스 사본**을 만들고, 케이스마다 사본을 원본으로 되돌린 뒤 값을 위반시키고
`node scripts/validate.mjs`를 그 사본에서 돌렸다. 케이스가 끝나면 사본을 다시 되돌려
**기준선이 다시 통과하는지**까지 확인했다(마지막 열).

- 사본을 쓴 이유: 이 작업 중 같은 작업 트리를 다른 에이전트가 동시에 편집하고 있었다.
  실데이터를 훼손했다가 되돌리는 방식은 그 편집분을 함께 날릴 위험이 있었다.
  `git checkout -- <file>` 원복을 쓰지 말라는 지시와 같은 취지다.
- 드라이버: 스크래치패드의 `negative.mjs` (일회용, 저장소에 남기지 않는다).
- 기준선: 샌드박스 초기 상태 `Validation passed (9572 checks)`.

## 결과 — 19/19 검사가 위반 시 실패했고, 19/19가 원복 후 다시 통과했다

| # | 검사 이름 | 어떻게 위반시켰나 | 실패 메시지 | 원복 확인 |
|---|---|---|---|---|
| 1 | 본문 길이 상한 (기본 60자) | summary[0]을 60자에서 75자로 늘렸다 | `smstudy: NOTEBOOKS.I-01.summary[0] is 75 characters, over the 60 limit — "인간의 의지가 개입했는지가 현상 구분의 첫 기준이며 이 문장은 60자 상한을 확실히 넘기려고 일부러 아주 길게 늘여 쓴 시험용 문장이다"` | 통과 |
| 2 | 필드별 길이 상한 (headline 30자) | headline을 14자에서 38자로 늘렸다 | `smstudy: NOTEBOOKS.I-01.headline is 38 characters, over the 30 limit — "현상을 가르고 관점을 고르는 순서를 통째로 설명하는 아주 긴 제목이다"` | 통과 |
| 3 | 필드별 길이 상한 (node label 12자) | 노드 라벨을 5자에서 13자로 늘렸다 | `smstudy: NOTEBOOKS.I-01.diagrams[0].nodes[0].label is 13 characters, over the 12 limit — "의지가 개입했는지를 본다"` | 통과 |
| 4 | 1문장 계약 | decision 항목에 두 번째 문장을 붙였다 | `smstudy: NOTEBOOKS.I-01.decision[0] must be a single sentence — "현상 자체를 본다. 그 다음에 관점을 고른다."` | 통과 |
| 5 | 평문 계약 (꺾쇠 금지) | keyPoints[0].text에 <b> 태그를 넣었다 | `smstudy: NOTEBOOKS.I-01.keyPoints[0].text must be plain text without angle brackets or line breaks — "인간의 <b>의지</b>가 개입하면 사회·문화 현상이다."` | 통과 |
| 6 | 다이어그램 보유 (단원마다 1개 이상) | I-03의 diagrams 키 이름을 바꿔 없앴다 | `smstudy: I-03 must carry at least one diagram` | 통과 |
| 7 | kind 허용 집합 (렌더러에서 자동 도출) | venn을 존재하지 않는 kind 'donut'으로 바꿨다 | `smstudy: II-03.diagrams[0] uses kind "donut" but smstudy/assets/js/diagram.js has no layout for it` | 통과 |
| 8 | nodes 개수 상·하한 (kind별) | matrix2x2에서 노드 1개를 지웠다 | `smstudy: I-03.diagrams[0] (matrix2x2) must hold 4-4 nodes, found 3` | 통과 |
| 9 | 형식 다양성 (4종 이상) | 모든 kind를 flow 하나로 통일했다 | `smstudy: diagrams must use at least 4 different kinds, found 1 (flow)` | 통과 |
| 10 | 아이콘 키 정합 (벤더 파일에서 자동 도출) | icon 값을 없는 키로 바꿨다 | `smstudy: NOTEBOOKS.I-01.diagrams[0].nodes[0].icon uses icon key "not-a-real-icon" that is not vendored in assets/vendor/lucide/icons.js` | 통과 |
| 11 | 옛 필드 부활 잠금 | I-01에 oneLine을 되살렸다 | `smstudy: I-01 still carries a removed field (oneLine / examInsight / patterns)` | 통과 |
| 12 | summary 개수 (2~3) | summary에 4번째 줄을 넣었다 | `smstudy: I-01 notebook needs 2-3 summary lines` | 통과 |
| 13 | deepDive points 개수 (2~4) | points를 5개로 늘렸다 | `smstudy: I-01 deep-dive entries must each carry 2-4 points` | 통과 |
| 14 | 태그 정합 정방향 (문항 → exam.tags) | 문항 태그를 선언되지 않은 값으로 바꿨다 | `smstudy: KICE-2026-CSAT-01 tag "선언되지 않은 태그" is not declared in NOTEBOOKS.I-01.exam.tags` | 통과 |
| 15 | 태그 정합 역방향 (죽은 태그 금지) | exam.tags에 아무 문항도 쓰지 않는 태그를 추가했다 | `smstudy: NOTEBOOKS.I-01.exam.tags "아무도 안 쓰는 태그" is never used by any question (dead tag)` | 통과 |
| 16 | 단원별 문항 수 (1문항 이상) | I-03 문항 2건의 sub를 I-02로 옮겨 단원을 비웠다 | `smstudy: I-03 must contain at least one question` | 통과 |
| 17 | LAYOUTS 등록부 교차 대조 | diagram.js의 LAYOUTS에서 venn 등록만 지웠다 | `smstudy: smstudy/assets/js/diagram.js defines layout venn but never registers it in LAYOUTS` | 통과 |
| 18 | 새 kind는 nodes 상·하한을 강제 | layoutDonut을 추가하고 LAYOUTS에 등록했다 | `smstudy: diagram kind donut has no node-count bound — add it to DIAGRAM_NODE_BOUNDS in scripts/validate.mjs` | 통과 |
| 19 | 게이트와 렌더러가 같은 아이콘 집합을 볼 것 | diagram.js가 읽는 전역 이름을 바꿨다 | `smstudy: smstudy/assets/js/diagram.js must read icons from window.SM_ICONS so the gate checks the set the renderer uses` | 통과 |

## 음성 테스트가 실제로 잡아낸 결함 1건

19번 "게이트와 렌더러가 같은 아이콘 집합을 볼 것"은 처음에
`diagramSource.includes('window.SM_ICONS')`로 썼는데, 전역 이름을 `window.SM_ICONS_RENAMED`로
바꿔도 **부분 문자열로 통과**했다. 즉 렌더러가 다른 전역을 읽기 시작해도 게이트는 계속
초록불이었을 것이다. `/window\.SM_ICONS(?![\w$])/u`로 고쳐 다시 확인했다.

`includes()` 기반 존재 검사는 이름이 접두사로 남는 한 무력하다는 것이 이번 회차의 교훈이다.

## 이 게이트가 여전히 못 보는 것 (사각지대 명시 — LESSONS 규칙 6)

기계 검사가 통과했다고 요구사항이 충족된 것은 아니다. 아래는 위 19건이 원리상 볼 수 없다.

- **다이어그램의 시각적 정합성**: 라벨 겹침·도형 밖 넘침·읽기 순서. 좌표 계산이 텍스트로는
  옳아 보여도 글꼴 폭이 다르면 깨진다. 이번 사이클에서는 실제 브라우저 DOM에서
  모든 `<text>`의 `getBBox()`를 재어 (a) viewBox 이탈 (b) 글자끼리 겹침 (c) 자기 도형 이탈을
  전수 검사하는 방식으로 메웠다(13단원 288개 텍스트, 위반 0건). 이 측정은 게이트에 상주하지
  않으므로 다음 사이클에서 다시 재야 한다.
- **문장의 자연스러움**: 길이·문장 수·평문 여부는 재지만 조사가 맞는지("반문화이" 같은 오류)는
  못 잰다. 실제로 캡션 생성 초안에서 이 결함이 나왔고 사람이 읽어서 잡았다.
- **다이어그램 형식이 그 단원 내용에 맞는지**: `kind`가 허용 집합에 있는지와 개수만 보고,
  그 형식이 개념 구조에 어울리는지는 판단하지 않는다. 근거는 데이터의 `why`가 사람에게 남긴다.
- **아이콘이 의미에 맞는지**: 키가 벤더 파일에 있는지만 본다. `users` 자리에 `wallet`을 넣어도 통과한다.

---

# 추가 — 사이클3 6단계(수정 라운드)

교차 리뷰(`docs/review.md`)가 blocker 4건을 "게이트가 초록인데 요구사항이 깨진다"로 판정하고,
그 근거로 **실제 반증에 성공한 변형 6개**를 제시했다. 게이트를 고친 뒤 **그 변형들을 그대로
재현해 이제 실패하는지** 확인하고, 신설 검사마다 변형을 추가했다.

- 수행 방법은 위와 같다: `git archive HEAD` 사본, 케이스마다 원복, 마지막에 대조군으로 기준선 재확인.
- 드라이버: 스크래치패드의 `negtests.mjs` (일회용, 저장소에 남기지 않는다).
- 기준선: 사본 초기 상태 `Validation passed (13173 checks)`.

## 결과 — 23/23 (리뷰가 제시한 반증 6건 전부 포함)

| # | 겨냥한 지적 | 어떻게 위반시켰나 | 리뷰 시점 | 지금 | 실패 메시지(첫 줄) |
|---|---|---|---|---|---|
| N20 | B-1 | `data.js`의 렌더되는 concept section 본문을 76자로 늘렸다 | **통과(반증 성공)** | 실패 | `UNITS.IV-02.sections[1].points[1] is 76 characters, over the 60 limit` |
| N21 | B-1 | `VISUAL_GUIDES`의 flow 항목을 60자 초과로 늘렸다 | 통과 | 실패 | `VISUAL_GUIDES.IV-02.flow[0] is … over the 60 limit` |
| N22 | B-1 | `evidence[].href`에 `'"><b>broken</b>`를 삽입했다 | **통과(반증 성공)** | 실패 | `LEARNING_DESIGN.evidence[0].href must be a plain https URL without quotes, spaces or angle brackets` |
| N23 | B-1 | `href` 속성 보간에서 `esc()`를 벗겼다 | (검사 없음) | 실패 | `URL attribute interpolation must be escaped — found href="${item.href}` |
| N24 | B-1 | 렌더러 고정 문구를 81자 한 문장으로 늘렸다 | (검사 없음) | 실패 | `app.js: rendered copy is 81 characters, over the 60 limit` |
| N25 | B-2 | `matrix.title`을 지웠다 | **통과(반증 성공)** | 실패 | `IV-01.matrix.title is read by the renderer but missing (render contract)` |
| N26 | B-2 | `deepDive[0].term`을 지웠다 | **통과(반증 성공)** | 실패 | `IV-02.deepDive[0].term is read by the renderer but missing` |
| N27 | B-2 | `deepDive[0].icon`을 지웠다 | **통과(반증 성공)** | 실패 | `IV-02.deepDive[0].icon is read by the renderer but missing` |
| N28 | B-2 | `recall[0].answer`를 지웠다 | **통과(반증 성공)** | 실패 | `IV-02.recall[0].answer is read by the renderer but missing` |
| N29 | B-2 | 계약에 없는 필드(`legacyCount`)를 데이터에 추가했다 | (검사 없음) | 실패 | `NOTEBOOKS.IV-02.legacyCount is not read by any renderer` |
| N30 | M-1 | 렌더되지 않는 `keyPoints[].icon`을 되살렸다 | (반대로 필수였음) | 실패 | `NOTEBOOKS.IV-02.keyPoints[].icon is not read by any renderer` |
| N31 | B-2 | 렌더러가 계약에 없는 필드를 읽게 만들었다 | (검사 없음) | 실패 | `app.js renders note.legacyCount but NOTEBOOK_FIELD_CONTRACT … does not declare it` |
| N32 | B-3 | `ICON_SET = {}` 로 바꾸고 `void window.SM_ICONS`만 남겼다 | **통과(반증 성공)** | 실패 | `renderIcon() did not emit the body injected through window.SM_ICONS` (연쇄 23건) |
| N33 | B-3 | `renderIcon()`이 아이콘 본문을 비우게 만들었다 | (검사 없음) | 실패 | `renderIcon() did not emit the body injected through window.SM_ICONS` |
| N34 | B-4 | 마크업의 `data-question-image` **속성만** 이름을 바꿨다 | **통과(반증 성공)** | 실패 | `the question <img> inside <figure class="sm-media"> must carry the data-question-image attribute the binder selects on` |
| N35 | B-4 | 마크업의 폴백 블록 **클래스만** 이름을 바꿨다 | 통과 | 실패 | `the same <figure> must hold a <div class="sm-media-fallback" hidden>` |
| N36 | B-4 | 폴백 블록의 `hidden` 속성을 지웠다 | 통과 | 실패 | 같은 메시지 |
| N37 | M-3 | `<figure>`에 `<figcaption>`을 하나 더 넣었다 | (검사 없음) | 실패 | `must render exactly one <figcaption> — a <figure> may hold only one caption` (21단원 전부) |
| N38 | M-2 | radial `center`를 공백 없는 한글 11자로 바꿨다 | **통과(레이아웃 파손)** | 실패 | `diagrams[0].center is 11 characters, over the 8 limit` |
| N39 | M-2 | 다이어그램 `label`을 9자로 늘렸다 | 통과(상한 12) | 실패 | `nodes[0].label is 9 characters, over the 8 limit` |
| N40 | M-2 | 다이어그램 `items`를 20자로 늘렸다 | 통과(상한 20) | 실패 | `nodes[0].items[0] is 20 characters, over the 16 limit` |
| N41 | M-2 | flow 노드의 `items`를 4개로 늘렸다 | 통과(개수 미검사) | 실패 | `(flow) must hold 0-2 items, found 4 — the SVG layout has no room for more` |
| N42 | 대조군 | 아무것도 바꾸지 않았다 | 통과 | **통과** | `Validation passed (13173 checks)` |

**리뷰가 제시한 반증 6건은 전부 재현해 지금은 실패한다.** 6번째("`keyPoints[0].icon` 제거가
실패했다")는 방향이 반대인 사례였고, D-3대로 선택 필드로 내린 뒤 데이터에서도 지웠으므로
N30이 그 자리를 대신한다(되살리면 실패).

## 이번 라운드에서 검사 방식 자체가 바뀐 것

- **아이콘 연결**: 소스에 전역명이 있는지(토큰 존재) → **렌더러를 격리 VM에서 평가**해 주입한
  아이콘 본문이 마크업으로 나오는지. N32·N33이 이 전환을 증명한다.
- **렌더 필수 필드**: 배열 길이 세기 → 계약표 + **렌더러 소스에서 읽는 필드를 도출해 양방향 대조**.
  표가 렌더러보다 뒤처지면 게이트가 실패한다(N29·N30·N31).
- **이미지 폴백**: 독립 존재 검사 2개의 AND(LESSONS 규칙 4 위반) → **바인더에서 선택자를 도출해
  마크업 한 덩어리에 적용**. 한쪽만 이름을 바꾸면 어긋나 실패한다(N34·N35).
- **문자열 계약 범위**: `NOTEBOOKS`·`LEARNING_DESIGN` → `data.js`의 개념 섹션·시각 가이드와
  **렌더러 고정 문구**까지(N20·N21·N24).

## 여전히 못 보는 것 (갱신)

위 "이 게이트가 여전히 못 보는 것" 4개 항목은 그대로 유효하다. 다만 다이어그램 시각 정합성은
이제 **계약 상한과 좌표 전제가 같은 숫자**라서 "스키마상 유효한데 겹치는" 구간은 없어졌다.
남은 사각지대는 글꼴 폭 차이와 실제 컨테이너 폭이며, 이번 라운드에서는 브라우저 DOM의
`getBBox()` 전수 계측과 `docs/snapshots/` 정적 스냅샷으로 메웠다(게이트에 상주하지 않는다).
