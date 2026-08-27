(() => {
  'use strict';

  const SORT_MODES = Object.freeze({
    RANDOM: 'random',
    SEQUENTIAL: 'sequential',
    WRONG_HIGH: 'wrong-high',
    WRONG_LOW: 'wrong-low',
    RECENT: 'recent',
  });

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }

  function normalizeStudySearch(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/gu, '');
  }

  function matchesStudySearch(query, fields) {
    const normalizedQuery = normalizeStudySearch(query);
    if (!normalizedQuery) return true;
    const candidates = Array.isArray(fields) ? fields : [fields];
    return candidates.some((field) => normalizeStudySearch(field).includes(normalizedQuery));
  }

  function shuffle(items) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
    }
    return result;
  }

  // A missing metric means "not attempted". It always follows measured rows so
  // a zero-percent record is not confused with a question the learner never saw.
  function compareNullableNumbers(left, right, direction) {
    const leftKnown = Number.isFinite(left);
    const rightKnown = Number.isFinite(right);
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    if (!leftKnown) return 0;
    return (left - right) * direction;
  }

  function sortStudyItems(items, mode, metrics = {}) {
    if (mode === SORT_MODES.RANDOM) return shuffle(items);

    const wrongRate = metrics.wrongRate || (() => null);
    const wrongCount = metrics.wrongCount || (() => 0);
    const recentAt = metrics.recentAt || (() => null);
    const compareDefault = metrics.compareDefault || (() => 0);
    const indexed = items.map((item, index) => ({ item, index }));

    indexed.sort((left, right) => {
      let compared = 0;
      if (mode === SORT_MODES.WRONG_HIGH) {
        compared = compareNullableNumbers(wrongRate(left.item), wrongRate(right.item), -1);
      } else if (mode === SORT_MODES.WRONG_LOW) {
        compared = compareNullableNumbers(wrongRate(left.item), wrongRate(right.item), 1);
      } else if (mode === SORT_MODES.RECENT) {
        compared = compareNullableNumbers(recentAt(left.item), recentAt(right.item), -1);
      }

      // Equal wrong rates still need a useful weakest-first order. A learner who
      // missed the item more often should see it before an item missed once.
      if (!compared && (mode === SORT_MODES.WRONG_HIGH || mode === SORT_MODES.WRONG_LOW)) {
        compared = compareNullableNumbers(wrongCount(left.item), wrongCount(right.item), -1);
      }

      return compared || compareDefault(left.item, right.item) || left.index - right.index;
    });

    return indexed.map(({ item }) => item);
  }

  globalThis.HvsStudyUtils = Object.freeze({
    SORT_MODES,
    escapeHtml,
    matchesStudySearch,
    shuffle,
    sortStudyItems,
  });
})();
