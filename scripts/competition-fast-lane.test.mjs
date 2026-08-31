import assert from 'node:assert/strict';
import test from 'node:test';

import {
  competitionBurdenTier,
  selectCompetitionFastLane,
} from './competition-fast-lane.mjs';

const NOW = Date.parse('2026-08-31T00:00:00.000Z');

function candidate(id, overrides = {}) {
  return {
    contest_id: id,
    category: 'idea',
    official_verification: 'verified',
    acceptance: 'open',
    eligibility: 'eligible',
    status: 'active',
    deadline_at: '2026-09-10T00:00:00.000Z',
    recency: 'recent',
    fee: 'free',
    participation: 'fully_online_async',
    fit_score: 80,
    effort_score: 20,
    ...overrides,
  };
}

test('free asynchronous work ranks before remote-live, paid, on-site and unknown burden', () => {
  const rows = [
    candidate('unknown', { fee: 'unknown', participation: 'unknown' }),
    candidate('onsite', { participation: 'on_site' }),
    candidate('paid', { fee: 'paid' }),
    candidate('remote', { participation: 'remote_live' }),
    candidate('async'),
  ];
  assert.deepEqual(rows.map(competitionBurdenTier), [4, 3, 2, 1, 0]);
  const result = selectCompetitionFastLane({ candidates: rows, now: NOW, wipLimit: 3 });
  assert.deepEqual(result.selected.map((row) => row.contest_id), ['async', 'remote', 'paid']);
  assert.deepEqual(result.deferred.map((row) => row.contest_id), ['onsite', 'unknown']);
  assert.equal(result.wip_count + result.selected.length, 3);
});

test('a new verified candidate preempts same-tier backlog without duplicate WIP or exceeding three', () => {
  const result = selectCompetitionFastLane({
    candidates: [
      candidate('already-active', { recency: 'new', effort_score: 1 }),
      candidate('backlog', { recency: 'stale', effort_score: 5 }),
      candidate('new-fast', { recency: 'new', effort_score: 30 }),
      candidate('new-fast', { recency: 'new', effort_score: 30 }),
    ],
    applications: [
      { contest_id: 'already-active', category: 'idea' },
      { contest_id: 'second-active', category: 'design' },
    ],
    now: NOW,
  });
  assert.equal(result.wip_count, 2);
  assert.equal(result.available_slots, 1);
  assert.deepEqual(result.selected.map((row) => row.contest_id), ['new-fast']);
  assert.deepEqual(result.deferred.map((row) => row.contest_id), ['backlog']);
  assert.equal(result.wip_count + result.selected.length, 3);
});

test('unverified, closed, ineligible, expired and inactive candidates never enter the lane', () => {
  const candidates = [
    candidate('ok'),
    candidate('unverified', { official_verification: 'unverified' }),
    candidate('closed', { acceptance: 'closed' }),
    candidate('ineligible', { eligibility: 'unknown' }),
    candidate('expired', { deadline_at: '2026-08-30T00:00:00.000Z' }),
    candidate('inactive', { status: 'deferred' }),
  ];
  const result = selectCompetitionFastLane({ candidates, now: NOW });
  assert.deepEqual(result.selected.map((row) => row.contest_id), ['ok']);
  assert.deepEqual(result.deferred, []);
});

test('existing work above the bounded WIP limit fails closed', () => {
  assert.throws(() => selectCompetitionFastLane({
    candidates: [candidate('next')],
    applications: [
      { contest_id: 'one', category: 'idea' },
      { contest_id: 'two', category: 'idea' },
      { contest_id: 'three', category: 'idea' },
      { contest_id: 'four', category: 'idea' },
    ],
    now: NOW,
  }), /WIP exceeds limit/u);
  assert.throws(() => selectCompetitionFastLane({
    candidates: [candidate('next')],
    applications: [{ contest_id: '', category: 'idea' }],
    now: NOW,
  }), /WIP is invalid/u);
});
