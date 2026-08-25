# 디자인 헌장 적용 감사 (docs/DESIGN.md → 프론트엔드)

기준: `docs/DESIGN.md` (커밋 790ab60). 심각도는 헌장 조항 위반의 시각적 파급으로 매겼다.
헌장에 적히지 않은 취향은 근거로 삼지 않았다. 표현 계층(HTML·CSS·렌더 JS)만 다뤘고
콘텐츠 데이터(`explanation-data.js`, `notebook-data.js`, `data.js`, `docs/kice-*.md`)는 손대지 않았다.

## high

- [high] assets/css/system.css:127 -- §2 "한국어 텍스트 컨테이너에 `word-break: keep-all` 필수" -> 전 사이트에서 keep-all이 smstudy `.sm-note-body`·`.sm-diagram` 두 곳뿐이었다. `body`에 `word-break: keep-all` + `overflow-wrap: break-word`를 기본값으로 부여해 랜딩·WordMaster·admin·smstudy 퀴즈/결과 전체를 덮는다. (keep-all은 비CJK에서 `normal`과 동일하게 동작하므로 전역 적용이 안전하다.)
- [high] index.html:82,83,100,125,153 -- §2 "억지 줄바꿈(`<br>`)으로 조판을 교정하지 않는다" -> 히어로 본문 2곳·피처 헤드라인 2곳·싱크 헤드라인 1곳의 `<br>`를 제거하고, 줄 수는 `max-width`(한글 기준 `em`)로 잡는다.
- [high] assets/css/home.css:132-148 -- §3 "금지: 그라디언트 장식" -> `.hero-title`이 `linear-gradient` + `background-clip: text`로 글자를 칠하고 있었다. 단색 `--text`로 되돌리고, 그 때문에 존재하던 `@media (forced-colors)` 우회 블록도 함께 제거한다.
- [high] smstudy/assets/js/app.js:1114-1118 -- §2 "디스플레이·타이틀급은 30자 이하 헤드라인 전용" -> `.stat-value`(`--fs-title-1`, 최대 2.75rem)에 "Ⅱ. 개인과 사회 구조 · 62%" 같은 문장형 값 3개를 조판했다. 게다가 감싼 `.sm-exam-stats`는 CSS에 규칙 자체가 없어 스타일이 아예 안 먹던 죽은 클래스였다. 같은 화면이 이미 쓰는 `dl.sm-facts-inline`(라벨-값 사실 나열)로 교체한다.
- [high] smstudy/assets/js/app.js:694-711 -- §4 "카드 3연속 스택이 나오면 설계를 의심하라" + §1 학습 화면 레퍼런스(문제집·참고서 조판) -> 개념 노트 본문이 동일한 `.card` 10연속 스택이었다. 카드를 걷어내고 `.sm-section`을 구분선 기반 조판으로 바꾼다. 학습 화면의 레퍼런스 어법(높은 밀도·조용한 위계)에 맞춘다.
- [high] smstudy/assets/js/app.js:456,483,515,636,1110 -- §3 "상태색은 상태 표시에만, 장식·구획 목적 금지" + "강조색은 뷰당 1색" -> 정적 라벨("개념 구조도", "개념 N", "이 단원에서 먼저 잡을 생각", "무료 자동 분석")에 `badge-green`, 회상 문항 번호에 `badge-purple`. 중립 `.badge`로 내리거나 뱃지 자체를 제거한다.
- [high] index.html:106,107,131,132 + assets/css/home.css:99,100,200,201 -- §3 "강조색은 뷰당 1색" -> 랜딩 한 화면에 파랑·초록·빨강·보라·주황 5색이 난립했다(피처 뱃지 4색 + 보라 kicker + 보라 글리프). 전부 중립/`--accent`로 수렴시킨다. 플래시카드 목업의 초록 `✓`만 성공 상태 표시로 남긴다(§3이 상태색에 허용한 용도).

## med

- [med] smstudy/assets/js/app.js:553-559 + smstudy/assets/css/style.css:208-215 -- §4 "프로그레스 바는 실제 진행 데이터에만 쓴다. 정적 콘텐츠의 비중 표현에 쓰지 않는다" -> 개념 태그별 출제 빈도를 `.sm-meter` 막대로 그렸다. 코드 주석이 "실측 집계값이라 예외"라고 주장했지만 헌장이 허용한 것은 사용자의 진행률·정답률뿐이다. 숫자 나열로 바꾼다. (사용자 정답률을 그리는 `renderAnalysisMeter`의 `.sm-meter`는 헌장이 허용한 용도라 유지한다.)
- [med] smstudy/assets/js/app.js:575-581 + smstudy/assets/css/style.css:176-192 -- 같은 조항 -> 단원 평균 정답률 게이지(`.sm-gauge`)도 정적 집계다. 바로 아래 `.sm-hint` 한 줄이 같은 정보를 이미 문장으로 전달하므로 트랙을 걷어내도 정보 손실이 없다. 이로써 개념 노트 뷰의 장식 프리미티브가 3종(번호 뱃지·프로그레스 바·색 배너) → 2종으로 내려가 §4 상한을 만족한다.
- [med] smstudy/assets/css/style.css:290-297 -- §3 상태색 장식 사용 금지 -> `.sm-trap`이 `--orange-soft` 배경 + `--orange` 라벨로 "함정 체크"를 칠했다. 같은 파일 205행은 이미 함정 칸을 "색을 바꾸지 않고 아이콘과 라벨로 구분한다"며 중립화해 놓아 파일 내부가 모순이었다. 중립 표면 + 라벨로 통일한다.
- [med] smstudy/assets/css/style.css:256 -- §3 같은 조항 -> 회상 점검의 정적 "정답" 라벨에 `--green`. 채점 결과가 아니라 펼침 라벨이므로 `--text-2`로 내린다.
- [med] index.html:157-170 + assets/css/home.css:314-319 -- §4 "카드는 정보의 경계가 필요할 때만 쓴다 … 대개 표, 리스트, 또는 구분선으로 충분하다" -> 싱크 섹션의 3카드 그리드. 카드 상자를 없애고 상단 구분선 리스트로 바꾼다.
- [med] smstudy/assets/js/app.js:277-333 -- §4 카드 연속 스택 -> 홈 우측 패널이 `.card` 4연속. 한 장의 카드 안에서 구분선으로 나눈 그룹 4개로 합친다.
- [med] smstudy/assets/js/app.js:506-519 -- §4 "리스트의 기본값은 일반 리스트다. 번호 뱃지·아이콘 리스트는 순서 자체가 학습 내용일 때만 쓴다" -> 노트 히어로의 핵심 개념 3가지가 `<ol>` + 원형 아이콘 칩 리스트인데 순서가 학습 내용이 아니다. 굵은 라벨 + 설명의 일반 리스트로 내린다. (순서가 곧 내용인 `.sm-steps`·`.sm-flow-step`의 번호는 헌장이 허용하므로 유지한다.)
- [med] smstudy/assets/js/app.js:480-488 -- 같은 조항 -> 개념 카드의 "개념 1/2/3" 뱃지도 순서가 학습 내용이 아니다. 제거한다.

## low

- [low] WordMaster/assets/css/style.css:94 -- §2 keep-all 전역화의 부수 처리 -> `.wm-word`가 비표준 별칭 `word-break: break-word`를 쓴다. 영단어 표제어는 전역 `keep-all`을 끊어야 하는 자리가 맞으므로 표준 `overflow-wrap: anywhere`로 바꾼다. (수정함)
- [low] index.html:117 / smstudy/assets/js/app.js:714 -- §4 장식 상한 -> `✓` 글리프 2곳. U+2713은 텍스트 표현 문자이고 각각 성공 상태·완료 상태를 가리키므로 헌장 위반은 아니다. 유지한다.
- [low] assets/css/home.css:327-344 `.stats-band` -- §4 장식 프리미티브 -> 랜딩의 통계 타일 1종. 랜딩 레퍼런스(apple.com 제품 페이지)의 어법 안이고 §4 상한(2종) 내이므로 유지한다. "2 학습 앱 / 1 동기화 계정"을 대형 숫자로 내는 것은 취향 문제라 헌장 근거가 없어 손대지 않는다.
- [low] assets/css/system.css:241,438,572 등 `backdrop-filter` -- §3 "유리 효과(blur/glass)" 금지 -> 해당 조항은 문맥상 장식면(배경 패널)을 겨눈다. 여기 쓰인 곳은 전부 고정 상단바·모달 백드롭·sticky 툴바로, 스크롤 콘텐츠와 겹치는 크롬 레이어의 가독성 장치이며 랜딩 레퍼런스(apple.com)의 어법 자체다. 장식면 유리 효과는 한 곳도 없어 유지한다.

## 판단 기록

- **시각 확인 미완료 (§6)**: 이 작업 환경에는 브라우저·스크린샷 수단이 없다. 헌장 §6이 요구하는
  "완성 화면 스크린샷을 레퍼런스와 나란히 대조"를 수행하지 못했다. 판단은 마크업·CSS 정독과
  computed 값 추론에 의존했으므로, 시각 확인은 **미완료**다.
- **새 색 토큰 없음**: 이번 수정은 색 토큰을 하나도 신설·변경하지 않는다. 기존 토큰의 *사용처*만
  줄였으므로 CLAUDE.md "토큰 대비 전수 검산"이 요구하는 새 계산 대상이 발생하지 않았다.
  사용한 조합은 전부 system.css 상단 대비 실측표에 이미 기재된 것이다.
- **기계 게이트 기준선**: 작업 시작 시점의 `npm run validate`는 이미 48건 실패(전부 smstudy
  콘텐츠 데이터 관련, 다른 미완 작업 소관)였고 `npm test`는 validate에서 단락된다.
  단위 테스트(`scripts/study-utils.test.mjs`, `worker/test.mjs`)는 14/14 통과가 기준선이다.
