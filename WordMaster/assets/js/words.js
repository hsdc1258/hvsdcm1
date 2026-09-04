(() => {
  'use strict';

  window.WORDMASTER_CONTENT_READY = (async () => {
    if (!window.HvsAccount) throw new Error('account gate unavailable');
    const payload = await window.HvsAccount.api('/api/learning/wordmaster');
    // 화면은 단어 목록만 읽는다. 페이로드의 emoji 필드는 원본에 남지만 아이콘은
    // 앱의 키→아이콘 상수가 그리므로(DESIGN.md §5.1) 부팅 조건도, 전역 설정도 두지 않는다.
    if (!Array.isArray(payload?.words)) throw new Error('invalid WordMaster content');
    window.WORDMASTER_WORDS = payload.words;
  })();
})();
