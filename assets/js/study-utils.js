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

  function normalizeMeaningAnswer(value) {
    return String(value ?? '')
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[\s\u00A0]+/gu, '')
      .replace(/[.,;:!?"'`´“”‘’·•\/\\|<>《》〈〉「」『』【】()[\]{}~…―—–_-]/gu, '');
  }

  function splitTopLevelAnswers(text) {
    const parts = [];
    let buffer = '';
    let depth = 0;
    const open = new Set(['(', '[', '{', '〈', '《', '【']);
    const close = new Set([')', ']', '}', '〉', '》', '】']);
    for (const character of String(text)) {
      if (open.has(character)) depth += 1;
      if (close.has(character)) depth = Math.max(0, depth - 1);
      if ([',', ';', '/'].includes(character) && depth === 0) {
        if (buffer.trim()) parts.push(buffer.trim());
        buffer = '';
      } else {
        buffer += character;
      }
    }
    if (buffer.trim()) parts.push(buffer.trim());
    return parts;
  }

  function expandSquareVariants(segment) {
    const match = segment.match(/^(.*?)\[([^\]]+)\](.*)$/u);
    if (!match) return [segment];
    const [, before, inside, after] = match;
    return [...new Set([
      before + after,
      inside + after,
      before + inside + after,
    ].flatMap(expandSquareVariants))];
  }

  function cleanMeaningSegment(segment) {
    return String(segment)
      .replace(/<[^>]*>/gu, ' ')
      .replace(/\([^)]*\)/gu, ' ')
      .replace(/[<>]/gu, ' ')
      .replace(/^\s*~\s*/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  function acceptedMeaningAliases(item, customAliases = []) {
    const source = item?.meaning || '';
    const aliases = new Set();
    const push = (value) => {
      const normalized = normalizeMeaningAnswer(value);
      if (normalized) aliases.add(normalized);
    };

    push(source);
    for (const segment of splitTopLevelAnswers(source)) {
      for (const expanded of expandSquareVariants(segment)) {
        const cleaned = cleanMeaningSegment(expanded);
        push(cleaned);
        const particleStripped = cleaned.replace(/^(을|를|에|에게|에서|의|로|으로|와|과)\s+/u, '');
        if (particleStripped !== cleaned) push(particleStripped);
      }
    }
    for (const alias of customAliases) push(alias);
    return aliases;
  }

  function matchesMeaningAnswer(item, input, customAliases = []) {
    const answers = splitTopLevelAnswers(input).map(normalizeMeaningAnswer).filter(Boolean);
    if (!answers.length) return false;
    const aliases = acceptedMeaningAliases(item, customAliases);
    return answers.some((answer) => aliases.has(answer));
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
    acceptedMeaningAliases,
    escapeHtml,
    matchesStudySearch,
    matchesMeaningAnswer,
    normalizeMeaningAnswer,
    shuffle,
    splitTopLevelAnswers,
    sortStudyItems,
  });
})();
