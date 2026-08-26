/* ==========================================================================
   Lucide 아이콘 벤더링 (ISC) — 출처: npm lucide-static@1.34.0
   전문 고지: assets/vendor/lucide/LICENSE
   CDN 런타임 의존을 만들지 않기 위해 **실제로 화면에 나가는 키만** 골라 벤더링한다.
   현재 2개다 — 아이콘은 나란히 놓인 블록의 성격이 다를 때만 쓰기로 했다 (DESIGN.md §4).
   scripts/validate.mjs가 app.js의 icon('…') 호출 집합과 이 맵을 정확히 대조하므로,
   쓰지 않는 키가 남으면 게이트가 실패한다.
   생성물이므로 손으로 고치지 않는다. 키를 늘릴 때는 같은 패키지에서 다시 뽑는다.
   각 값은 24x24 viewBox 안의 자식 요소 마크업이며, 색은 부모 <svg>의 currentColor가 정한다.
   ========================================================================== */
(() => {
  'use strict';

  const ICONS = {
    'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    'trending-up': '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  };

  window.SM_ICONS = Object.freeze({ ICONS: Object.freeze(ICONS), source: 'lucide-static@1.34.0', license: 'ISC' });
})();
