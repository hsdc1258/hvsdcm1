(() => {
  'use strict';

  window.WORDMASTER_CONTENT_READY = (async () => {
    if (!window.HvsAccount) throw new Error('account gate unavailable');
    const payload = await window.HvsAccount.api('/api/learning/wordmaster');
    if (!Array.isArray(payload?.words) || !payload?.emoji) throw new Error('invalid WordMaster content');
    window.WORDMASTER_WORDS = payload.words;
    window.WORDMASTER_EMOJI = payload.emoji;
  })();
})();
