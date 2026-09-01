(() => {
  'use strict';
  window.PLSTUDY_CONTENT_READY = (async () => {
    if (!window.HvsAccount) throw new Error('account gate unavailable');
    const payload = await window.HvsAccount.api('/api/learning/plstudy');
    if (!payload?.data?.UNITS || !payload?.data?.QUESTIONS) throw new Error('invalid plstudy content');
    window.PLSTUDY_CONTENT = payload.data;
  })();
})();
