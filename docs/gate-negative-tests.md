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
- 기준선: 사본 초기 상태 `Validation passed (13204 checks)`.

## 결과 — 25/25 (리뷰가 제시한 반증 6건 전부 포함)

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
| N42 | M-6 | 스냅샷의 소제목 하나를 옛 제목으로 바꿔 데이터보다 낡게 만들었다 | (검사 없음) | 실패 | `docs/snapshots/diagrams.html: missing heading for I-01 — 현상 판별 3단계 (flow)` |
| N43 | M-6 | 스냅샷이 외부 스타일시트를 링크하게 만들었다 | (검사 없음) | 실패 | `snapshot must inline every stylesheet and carry no scripts so the file opens standalone` |
| N44 | 대조군 | 아무것도 바꾸지 않았다 | 통과 | **통과** | `Validation passed (13204 checks)` |

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

---

# 3라운드 추가 — 라운드 2가 통과시킨 우회 4종

라운드 2 재검토는 "값을 직접 지우는" 반증은 모두 실패시켰지만, **같은 결함을 다른 표현으로
다시 만든** 네 가지 변형을 통과시켰다(R2-B-1·B-2·B-3·M-1). 아래는 그 넷을 직접 재현해
**지금은 실패하는지** 확인한 기록이다.

## 수행 방법 (3라운드)

`git archive HEAD` 대신 **작업 트리 사본**을 썼다 — 이번 라운드의 수정이 아직 커밋 전이었고,
같은 저장소에서 다른 세션이 병렬 작업 중이라 작업 트리 자체를 훼손할 수 없었다.
`tar`로 `.git`·`node_modules`를 뺀 사본을 스크래치패드에 만들고, 케이스마다 사본을 원본에서
다시 복사한 뒤 위반시키고 `node scripts/validate.mjs`를 돌렸다.
기준선: 사본 초기 상태 `Validation passed (13279 checks)`.

## 결과 — 4/4가 이제 실패한다

| # | 라운드 2 판정 | 어떻게 위반시켰나 | 라운드 2 결과 | 지금 | 실패 메시지 |
|---|---|---|---|---|---|
| N45 | R2-B-1 | `renderNotebookHero()`에 `const noteAlias = note;`를 넣고 화면에 `${esc(noteAlias.gateGhost)}`를 추가했다 | **통과(13204 checks)** | 실패 3건 | `rendered concept markup holds an empty <p> slot — a template renders a field with no value` / `app.js renders note.gateGhost but NOTEBOOK_FIELD_CONTRACT ... does not declare it` / `concept-sample.html: snapshot is stale` |
| N46 | R2-B-2 | `layoutFlow()`의 `parts.push(svgIcon(node.icon, 76, middle - 11, 22));` 한 줄만 지웠다 | **통과(13204 checks)** | 실패 7건 | `layoutFlow() painted 0 canvas icons for 5 icon keys (expected 5) — the wide-screen SVG lost its icons` (+ flow를 쓰는 실데이터 5개가 각각 실패) |
| N47 | R2-B-3 | `renderQuestionMedia()` **앞**에 올바른 모양의 미사용 `<figure class="sm-media">` 문자열을 두고, 실제 `<img>`의 훅을 `data-question-image-broken`으로 바꿨다 | **통과(13204 checks)** | 실패 2건 | `app.js emits <figure class="sm-media"> outside renderQuestionMedia() — the image-fallback contract must have exactly one target` / `the question <img> inside <figure class="sm-media"> must carry the data-question-image attribute the binder selects on` |
| N48 | R2-M-1 | `docs/snapshots/concept-sample.html`의 키워드 `공유성`을 `낡은공유성`으로 바꿨다 | **통과(13204 checks)** | 실패 1건 | `concept-sample.html: snapshot is stale — it does not match what scripts/snapshot.mjs produces from the current sources (first difference at offset 51364 ...) — run: node scripts/snapshot.mjs` |

## 라운드 1 반증의 회귀 확인 (검사 방식을 바꿨으므로 다시 봤다)

| # | 어떻게 위반시켰나 | 결과 |
|---|---|---|
| N49 | `NOTEBOOKS['IV-01'].matrix.title`을 지웠다 | 실패 2건 — `IV-01.matrix.title is read by the renderer but missing (render contract)` / `rendered concept markup holds an empty <h3> slot` |
| N50 | `ICON_SET = {}`로 바꾸고 `void window.SM_ICONS`만 남겼다 | 실패 52건 — `renderIcon() did not emit the body injected through window.SM_ICONS` 외 kind 7종 × 두 렌더 경로 |

## 이번 라운드에서 검사 방식 자체가 바뀐 것 (3라운드)

- **렌더 필드 도출**: 소스 정규식(`note.x` 모양 매칭) → **렌더러를 실제 데이터로 실행하고
  데이터를 Proxy로 감싸 읽힌 키를 런타임에 수집**. 표현이 어떻든 `get` 트랩을 지난다.
  더해서 **출력 마크업**에 `undefined`·`null`·빈 슬롯이 있는지 본다 — 필드명을 몰라도 잡힌다.
  정규식 도출은 합집합의 **보조**로만 남겼다(실행되지 않는 경로를 덮는다).
- **아이콘 연결**: radial 하나 → **도출된 kind 전부**를 넓은 화면 SVG 캔버스와 좁은 화면
  폴백 목록 **양쪽**으로 렌더해 개수를 데이터와 맞춘다. kind 목록은 여전히 도출하고,
  캔버스가 아이콘을 그리는지 여부만 `DIAGRAM_SHAPE_BOUNDS`에 선언하게 했다.
- **이미지 폴백 대상**: 소스 전체 첫 매칭 → **`renderQuestionMedia()` 함수 본문 안**으로 한정.
  같은 모양의 `<figure>`가 함수 밖에 또 있으면 그것 자체를 실패로 본다.
- **스냅샷**: 손으로 얼린 문서 → **`scripts/snapshot.mjs`의 생성물**. 게이트가 현재 소스로
  다시 만들어 커밋된 파일과 그대로 대조하므로, 데이터·렌더러·CSS 중 무엇이 바뀌어도
  재생성 전에는 실패한다.

## 여전히 못 보는 것 (3라운드 갱신)

`docs/plan.md` §13 D-13 "게이트 강화 중단선"에 무엇을 막고 무엇을 안 막기로 했는지 적었다.
요약하면 **막지 않는 것**은 (1) 계약 파일 자체를 고치는 커밋, (2) 오해를 부르도록 일부러 쓴 코드,
(3) 사람 눈이 필요한 판정(스크린샷·대비 인상·교과 정확성), (4) 이번 범위 밖 화면(퀴즈·통계)이다.
이들은 "실수로 회귀가 새는" 경로가 아니므로 1인 정적 사이트의 위협 모델 밖으로 둔다.

---

# 3라운드 추가 — 이식성(줄바꿈) 검증 항목: R3-M-1

게이트가 "이 저장소, 이 체크아웃"에서만 초록불이면 검사가 아니라 우연이다. 라운드 3 리뷰는
**아무것도 고치지 않은 정상 `HEAD`**를 윈도우 Git 기본값 `core.autocrlf=true`로 새로 체크아웃하면
`npm test`가 7/13279로 실패한다는 것을 찾아냈다. 그래서 아래를 **상설 검증 항목**으로 올린다.

## 검증 항목 N51 — CRLF 체크아웃에서 정상 `HEAD`가 통과하는가

**왜 필요한가.** 게이트의 신설 검사 중 소스를 문자열로 다루는 것(함수 경계 추출, 스냅샷
바이트 대조)은 LF를 전제했다. 줄바꿈은 코드의 의미가 아니라 체크아웃 설정의 산물이므로,
이 전제가 남아 있으면 다른 PC에서 클론하는 순간 결함이 없는데도 빨간불이 뜬다.
"검사가 못 보는 것"이 아니라 **검사가 잘못 보는 것**이라 더 나쁘다.

**어떻게 수행하나.** 작업 트리를 건드리지 말고 별도 사본에서 확인한다.

```
git clone -c core.autocrlf=true <repo> <임시경로>     # ① 저장소 쪽 고정이 먹는가
cd <임시경로> && npm test                              # → 통과해야 한다
# ② 검사 쪽 정규화가 먹는가 (.gitattributes가 없다고 가정한 최악의 경우)
#    사본의 모든 텍스트 파일을 강제로 CRLF로 바꾼 뒤 다시 npm test → 역시 통과해야 한다
```

**합격 기준.** ①과 ② 모두 `Validation passed (13279 checks)` + Node 14/14, `git diff --check` 0줄.
LF 체크아웃 결과와 검사 수가 **같아야** 한다 — 개수가 달라지면 어떤 검사가 조용히 건너뛰어진 것이다.

**결과.**

| # | 상황 | 수정 전 | 수정 후 |
|---|---|---|---|
| N51-① | `core.autocrlf=true`로 새로 클론한 사본에서 `npm test` | **실패 7/13279** (`renderQuestionMedia() body could not be located` 외 4건 + 스냅샷 2건이 offset 15에서 낡았다고 오판) | **통과 13279 checks / Node 14/14** |
| N51-② | 사본의 텍스트 파일을 전부 CRLF로 강제 변환한 뒤 `npm test` | **실패 7/13279** (동일) | **통과 13279 checks / Node 14/14** |

**무엇을 고쳤나 (두 겹으로 막았다 — 한쪽만 하면 재발한다).**

- **검사 쪽** — 텍스트를 읽는 지점에서 CRLF를 LF로 접는다.
  `scripts/validate.mjs`는 `readFileSync`를 인코딩 인자가 있는 호출에만 정규화를 얹은 얇은
  래퍼로 감쌌고(Buffer 읽기는 그대로 둔다 — `assets/og.png`의 SHA-256 잠금과 WebP 헤더 파싱은
  원본 바이트를 봐야 한다), `scripts/render-sandbox.mjs`의 `readSource()`와 `functionBody()`도
  각각 정규화한다. `functionBody()`는 호출자가 정규화를 빠뜨려도 안전하도록 자체적으로 한 번 더 접는다.
- **저장소 쪽** — `.gitattributes`에서 `*.mjs`·`*.js`·`*.css`·`*.html`·`*.md`(및 `*.json`·`*.sql`·
  `*.yml`·`*.yaml`·`*.toml`·`*.svg`)를 `text eol=lf`로 못 박고, 이미지·폰트는 `binary`로 잠근다.
  인덱스는 이미 전부 LF였으므로 이 파일을 추가해도 재정규화 diff는 생기지 않았다
  (`git ls-files --eol`의 `i/` 열이 변하지 않는다).

**사각지대.** 이 항목은 줄바꿈만 본다. 인코딩(BOM·EUC-KR), 파일명 대소문자 구분, 경로 구분자,
로케일에 따른 정렬은 여전히 검사하지 않는다. 셋 다 이 저장소의 CI(Linux)와 개발 PC(Windows)
양쪽에서 동일하게 재현되지 않을 수 있는 축이므로, 같은 부류의 거짓 실패가 다시 나오면
이 절에 항목을 늘린다.
