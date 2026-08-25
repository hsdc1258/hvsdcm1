# plan.md — 전체 프론트 다크 테마 통일 (Apple 디자인 언어)

> 파이프라인 v3 사이클 #1 · 작성: Fable 5 (2026-08-25)

## 1. 요구사항
- 4개 프론트 표면(홈 `/`, `/WordMaster/`, `/smstudy/`, `/admin/`)의 디자인을 하나의
  다크 테마 디자인 시스템으로 통일한다. 깔끔·모던, Apple 디자인 철학 기준.
- Apple 디자인 철학의 구체 기준:
  - 순수 검정 배경(#000) 위 계층 표면(#161617/#1d1d1f/#242426), 큰 여백, 콘텐츠 우선
  - 시스템 컬러 액센트(Apple blue #2997ff 기본, green #30d158 = 성공, red = 위험)
  - 타이포: Pretendard/SF Pro 스택, 큰 제목 + tight letter-spacing, 명확한 위계
  - 글래스 내비게이션(blur+saturate), 부드러운 라운드(연속 곡률 느낌의 14~28px)
  - 과한 장식 금지: 그라디언트는 은은한 radial 1~2개까지, 애니메이션은 기능적 전환만
- 기존 기능·동작은 일절 변경하지 않는다 (CSS 중심 리스타일).

## 2. 파일 구조 / 변경 대상
| 파일 | 변경 내용 |
|---|---|
| `assets/css/home.css` | 기준 시스템(이미 Apple 스타일) — 토큰 정리·미세 다듬기만 |
| `assets/css/site-nav.css` | 공용 내비 토큰 정합성 확인 |
| `WordMaster/assets/css/style.css` | 초록/Inter 시스템 → 홈과 동일한 토큰·타이포·라운드로 교체 |
| `smstudy/assets/css/style.css` | 동상 (51KB, 최대 작업량) |
| `admin/assets/css/admin.css` | 하드코딩 색 제거 → 동일 토큰 체계로 재작성 |
| 각 `index.html` | 시각 마크업 한정 수정 허용 (아래 계약 준수) |

## 3. 인터페이스 계약 (구현·리뷰 공통 판정 기준)
- **JS가 참조하는 DOM id/class/구조는 변경 금지.** 각 앱의 JS(`home.js`, `app.js`,
  `admin.js`, `account.js`, `study-utils.js`)가 querySelector로 잡는 훅을 먼저 목록화하고
  그 목록 밖의 것만 손댄다.
- **파일명·스크립트 로드 순서는 배포 계약** (README 명시) — 파일 추가·이름 변경 금지.
  공유 토큰 파일 신설 대신, 동일한 `:root` 토큰 블록을 4개 CSS에 각각 심는다
  (현행 "각 앱 자립" 구조 유지).
- localStorage 키(`wordmaster2000.quiz.v1`, `samun2027.study.v1`, 계정 토큰 키) 불변.
- Worker/API, `scripts/`, `worker/`, 데이터 JS(`words.js`, `data.js` 등) 불변.

## 4. 완료 조건
- [x] `npm test` 통과 (validate 5057 checks + 단위 테스트 14/14 — 각 커밋마다 실행)
- [x] 4개 표면의 `:root` 토큰이 동일 팔레트 (기준: home.css; 앱 식별색 blue/purple은 홈 팔레트 내)
- [x] 로컬 서버 4페이지 computed style 검증 — bg #000 / Pretendard / 액센트·정답·위험 토큰 정상
      (브라우저 패널 비표시로 스크린샷 대신 getComputedStyle 검증; 육안 확인은 배포 전 사용자 몫)
- [x] 구팔레트 색상 잔존 0 (초록·핑크 계열 grep 확인; 중립 근검정 리터럴은 유지 — 부록 A 참조)

## 5. 관련 LESSONS 규칙
- (첫 사이클 — 축적된 규칙 없음. 예시 규칙의 취지에 따라 모바일 사파리 등
  모바일 뷰포트 확인을 완료 조건에 포함함)

## 6. 담당 지정 (기능 단위 단일 구현자 + 교차 리뷰)
- 구현자: **Fable 5** (Sol 역할 겸임 — Codex 한도 소진, 사용자 지시: GPT에 프론트 디자인 금지)
- 리뷰어: 교차 원칙상 Codex이나 **GPT 한도 소진 → 폴백 규칙에 따라 Opus 5** (기록: 2026-08-25)
  - 리뷰는 **별도 Opus 세션**에서 수행 (사용자 지정). 리뷰 세션은 이 파일과 커밋 diff만 보고
    docs/review.md를 작성한다 — 채팅 맥락 없이 판정 가능하도록 본 계약(3절)이 유일한 기준.
- 단순 반복 작업(토큰 블록 이식 등)은 필요 시 Sonnet 서브에이전트 위임 가능

## 7. 작업 순서 (커밋 단위)
1. JS DOM 훅 목록화 → 계약 확정 (docs/plan.md에 부록 추가)
2. 공통 토큰 블록 확정 (home.css 기준) → home.css/site-nav.css 정리
3. WordMaster 리스타일 → 기계 게이트
4. smstudy 리스타일 → 기계 게이트
5. admin 리스타일 → 기계 게이트
6. 전체 스크린샷 확인 → 리뷰(Opus) → 수정 → 승인
- 배포(push)는 승인 후 사용자 확인을 받고 진행 (GitHub Pages 즉시 반영이므로)

## 부록 A — DOM 계약 (JS 참조 훅 조사 결과, 2026-08-25)
- 모든 JS는 `getElementById`(약 60개 id) + 소수의 상태 클래스(`open`, `logged`, `show`,
  `hidden`, `image-failed`)와 JS 템플릿이 렌더하는 클래스(`choice-option`, `unit-check`,
  `feedback.correct/wrong` 등)를 참조한다.
- 따라서 **CSS 셀렉터명은 하나도 바꾸지 않고 값만 교체**하면 계약이 자동 충족된다.
  HTML 수정은 폰트 `<link>` 추가 등 비참조 마크업에 한정한다.
- 시맨틱 색 분리: 현행 WordMaster/smstudy는 브랜드색(--accent)을 정답 피드백에 겸용.
  통일 시스템에서는 --accent = Apple blue(브랜드·인터랙션), --green = 정답/성공,
  --danger/red = 오답/위험, --warning/yellow = 주의로 분리한다 (`.feedback.correct`
  계열 셀렉터만 green 토큰으로 재지정).
