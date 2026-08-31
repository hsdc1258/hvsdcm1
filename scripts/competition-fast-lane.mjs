import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const RECENCY_RANK = new Map([['new', 0], ['recent', 1], ['stale', 2]]);

function candidateKey(candidate) {
  const contestId = typeof candidate?.contest_id === 'string' ? candidate.contest_id.trim() : '';
  const category = typeof candidate?.category === 'string' ? candidate.category.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(contestId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(category)) return '';
  return `${contestId}\u0000${category}`;
}

export function competitionBurdenTier(candidate) {
  const fee = candidate?.fee;
  const participation = candidate?.participation;
  if (fee === 'unknown' || participation === 'unknown') return 4;
  if (participation === 'on_site') return 3;
  if (fee === 'paid') return 2;
  if (fee === 'free' && participation === 'remote_live') return 1;
  if (fee === 'free' && participation === 'fully_online_async') return 0;
  return 4;
}

function safeNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function compareCandidates(left, right) {
  return competitionBurdenTier(left) - competitionBurdenTier(right)
    || (RECENCY_RANK.get(left.recency) ?? 3) - (RECENCY_RANK.get(right.recency) ?? 3)
    || safeNumber(left.effort_score, 101) - safeNumber(right.effort_score, 101)
    || safeNumber(right.fit_score, -1) - safeNumber(left.fit_score, -1)
    || (Date.parse(left.deadline_at || '') || Number.MAX_SAFE_INTEGER)
      - (Date.parse(right.deadline_at || '') || Number.MAX_SAFE_INTEGER)
    || candidateKey(left).localeCompare(candidateKey(right), 'en');
}

function eligibleForFastLane(candidate, now) {
  const deadline = Date.parse(candidate?.deadline_at || '');
  return candidateKey(candidate)
    && candidate.official_verification === 'verified'
    && candidate.acceptance === 'open'
    && candidate.eligibility === 'eligible'
    && candidate.status === 'active'
    && Number.isFinite(deadline)
    && deadline > now;
}

export function selectCompetitionFastLane({
  candidates = [],
  applications = [],
  now = Date.now(),
  wipLimit = 3,
} = {}) {
  if (!Array.isArray(candidates) || !Array.isArray(applications)
    || !Number.isInteger(wipLimit) || wipLimit < 0 || wipLimit > 3
    || !Number.isFinite(now)) {
    throw new Error('invalid competition fast-lane input');
  }
  const normalizedApplicationKeys = applications.map(candidateKey);
  if (normalizedApplicationKeys.some((key) => !key)) {
    throw new Error('existing competition WIP is invalid');
  }
  const applicationKeys = new Set(normalizedApplicationKeys);
  const wipCount = applicationKeys.size;
  if (wipCount > wipLimit) {
    throw new Error('existing competition WIP exceeds limit');
  }
  const availableSlots = Math.max(0, wipLimit - wipCount);
  const ranked = candidates.filter((candidate) => eligibleForFastLane(candidate, now)).sort(compareCandidates);
  const seen = new Set(applicationKeys);
  const deduplicated = [];
  for (const candidate of ranked) {
    const key = candidateKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(candidate);
  }
  const selected = deduplicated.slice(0, availableSlots);
  return {
    wip_limit: wipLimit,
    wip_count: wipCount,
    available_slots: availableSlots,
    selected,
    deferred: deduplicated.slice(availableSlots),
  };
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--input' || !argv[1]) {
    throw new Error('usage: competition-fast-lane.mjs --input <path>');
  }
  return { input: path.resolve(argv[1]) };
}

function main() {
  try {
    const { input } = parseArgs(process.argv.slice(2));
    const payload = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/u, ''));
    process.stdout.write(`${JSON.stringify(selectCompetitionFastLane(payload))}\n`);
  } catch (error) {
    process.stderr.write(`[competition-fast-lane] ${error?.message || 'invalid input'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) main();
