// 사이트 공통 이모지 매핑 — DESIGN.md §5.1의 단일 원본.
//
// 왜 파일로 빼는가 (R4-M-4)
//   index.html이 📗·📘·💾·🔁·📱를 마크업 여러 곳에 리터럴로 박고 있었다. 같은 대상의
//   글리프가 두 곳에 적히면 한쪽만 바뀌어도 아무도 모른다. 랜딩의 슬롯은 이제
//   data-emoji="<키>"만 갖고, home.js가 이 매핑에서 글자를 채운다.
//
// 키 규칙: 앱을 가리키는 키는 **앱 디렉터리 이름 그대로** 쓴다(WordMaster / smstudy).
//   그래야 scripts/validate.mjs가 앱별 매핑(WORDMASTER_EMOJI.app / SMSTUDY_DATA.EMOJI.app)과
//   "이름으로" 대조할 수 있다 — 글리프 집합 포함 여부만 보면 두 앱 것을 맞바꿔도 통과한다.
// 랜딩 본문에서 학습 콘텐츠를 걷어내면서(plan.md §1-1) 동기화 리스트가 사라졌다.
// 그 리스트만 쓰던 save/review/anywhere 키는 함께 지운다 — 아무도 안 읽는 매핑을 남기면
// 다음 사람이 "어딘가 쓰이겠거니" 하고 값을 고친다.
window.SITE_EMOJI = {
  behaviorLab: '🧭',
  WordMaster: '📗',
  smstudy: '📘',
  gichul: '📙',
  usage: '📶',
};
