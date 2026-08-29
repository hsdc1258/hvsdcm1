(() => {
  'use strict';

  window.SMSTUDY_CONTENT_READY = (async () => {
    if (!window.HvsAccount) throw new Error('account gate unavailable');
    const payload = await window.HvsAccount.api('/api/learning/smstudy');
    if (!payload?.data || !payload?.notebook || !payload?.explanations) throw new Error('invalid smstudy content');
    window.SMSTUDY_DATA = payload.data;
    window.SMSTUDY_NOTEBOOK = payload.notebook;
    window.SMSTUDY_EXPLANATIONS = payload.explanations;
  })();
})();
