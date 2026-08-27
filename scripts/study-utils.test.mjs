import assert from 'node:assert/strict';
import test from 'node:test';

await import('../assets/js/study-utils.js');

const { SORT_MODES, matchesStudySearch, sortStudyItems } = globalThis.HvsStudyUtils;
const items = [
  { id: 'unseen', order: 1, wrongRate: null, wrongCount: 0, recentAt: null },
  { id: 'low', order: 2, wrongRate: 20, wrongCount: 4, recentAt: 100 },
  { id: 'high-old', order: 3, wrongRate: 80, wrongCount: 2, recentAt: 200 },
  { id: 'high-new', order: 4, wrongRate: 80, wrongCount: 5, recentAt: 300 },
];
const metrics = {
  wrongRate: (item) => item.wrongRate,
  wrongCount: (item) => item.wrongCount,
  recentAt: (item) => item.recentAt,
  compareDefault: (left, right) => left.order - right.order,
};

test('wrong-rate sorting keeps unseen questions after measured records', () => {
  assert.deepEqual(
    sortStudyItems(items, SORT_MODES.WRONG_HIGH, metrics).map((item) => item.id),
    ['high-new', 'high-old', 'low', 'unseen'],
  );
  assert.deepEqual(
    sortStudyItems(items, SORT_MODES.WRONG_LOW, metrics).map((item) => item.id),
    ['low', 'high-new', 'high-old', 'unseen'],
  );
});

test('all 100-percent wrong rates put the highest cumulative mistake count first', () => {
  const allWrong = [
    { id: 'once', order: 1, wrongRate: 100, wrongCount: 1 },
    { id: 'seven-times', order: 2, wrongRate: 100, wrongCount: 7 },
    { id: 'three-times', order: 3, wrongRate: 100, wrongCount: 3 },
  ];

  for (const mode of [SORT_MODES.WRONG_HIGH, SORT_MODES.WRONG_LOW]) {
    assert.deepEqual(
      sortStudyItems(allWrong, mode, metrics).map((item) => item.id),
      ['seven-times', 'three-times', 'once'],
    );
  }
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

test('study search ignores English case and whitespace', () => {
  const fields = ['make up', '구성하다, 지어내다'];

  assert.equal(matchesStudySearch(' M A K E U P ', fields), true);
  assert.equal(matchesStudySearch('MAKEup', fields), true);
  assert.equal(matchesStudySearch('break down', fields), false);
});

test('study search ignores Korean whitespace and shows all for a blank query', () => {
  const fields = ['make up', '구성하다, 지어내다'];

  assert.equal(matchesStudySearch('구 성 하 다', fields), true);
  assert.equal(matchesStudySearch('지어 내다', fields), true);
  assert.equal(matchesStudySearch('   ', fields), true);
});
