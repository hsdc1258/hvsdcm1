import assert from 'node:assert/strict';
import test from 'node:test';

await import('../assets/js/study-utils.js');

const { SORT_MODES, sortStudyItems } = globalThis.HvsStudyUtils;
const items = [
  { id: 'unseen', order: 1, wrongRate: null, recentAt: null },
  { id: 'low', order: 2, wrongRate: 20, recentAt: 100 },
  { id: 'high-old', order: 3, wrongRate: 80, recentAt: 200 },
  { id: 'high-new', order: 4, wrongRate: 80, recentAt: 300 },
];
const metrics = {
  wrongRate: (item) => item.wrongRate,
  recentAt: (item) => item.recentAt,
  compareDefault: (left, right) => left.order - right.order,
};

test('wrong-rate sorting keeps unseen questions after measured records', () => {
  assert.deepEqual(
    sortStudyItems(items, SORT_MODES.WRONG_HIGH, metrics).map((item) => item.id),
    ['high-old', 'high-new', 'low', 'unseen'],
  );
  assert.deepEqual(
    sortStudyItems(items, SORT_MODES.WRONG_LOW, metrics).map((item) => item.id),
    ['low', 'high-old', 'high-new', 'unseen'],
  );
});

test('recent sorting is newest first with a deterministic fallback', () => {
  assert.deepEqual(
    sortStudyItems(items, SORT_MODES.RECENT, metrics).map((item) => item.id),
    ['high-new', 'high-old', 'low', 'unseen'],
  );
  assert.deepEqual(
    sortStudyItems([...items].reverse(), SORT_MODES.SEQUENTIAL, metrics).map((item) => item.id),
    ['unseen', 'low', 'high-old', 'high-new'],
  );
});
