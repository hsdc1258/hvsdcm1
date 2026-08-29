const freezeDeep = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
};

// Collector provenance, generated manifest ordering, and completeness validation all consume this
// descriptor. Add a round or track here once; downstream inventory and manifest files carry it forward.
export const DEFAULT_AVAILABILITY = freezeDeep({
  version: 1,
  academic_years: { from: 2020, to: 2027 },
  rounds: [
    { id: '06', from: 2020, to: 2027, board_id: '1500236', query: '6월' },
    { id: '09', from: 2020, to: 2026, board_id: '1500236', query: '9월' },
    { id: 'csat', from: 2020, to: 2026, board_id: '1500234', query: null },
  ],
  subjects: [
    {
      id: 'korean',
      tracks: [
        { id: null, from: 2020, to: 2021 },
        { id: 'hwajak', from: 2022, to: 2027, section_header: '화법과 작문' },
        { id: 'eonmae', from: 2022, to: 2027, section_header: '언어와 매체' },
      ],
    },
    {
      id: 'math',
      tracks: [
        { id: 'hwaktong', from: 2022, to: 2027, section_header: '확률과 통계' },
        { id: 'mijeok', from: 2022, to: 2027, section_header: '미적분' },
        { id: 'giha', from: 2022, to: 2027, section_header: '기하' },
        { id: 'ga', from: 2020, to: 2021 },
        { id: 'na', from: 2020, to: 2021 },
      ],
    },
    { id: 'english', tracks: [{ id: null, from: 2020, to: 2027 }] },
    { id: 'soc_culture', tracks: [{ id: null, from: 2020, to: 2027 }] },
    { id: 'politics_law', tracks: [{ id: null, from: 2020, to: 2027 }] },
  ],
  kinds: ['question', 'answer'],
});

function assertIdentifier(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^[a-z0-9_]+$/u.test(value)) {
    throw new Error(`${label} 식별자가 잘못되었습니다.`);
  }
}

function assertYearSpan(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value?.from) || !Number.isSafeInteger(value?.to)
    || value.from < minimum || value.from > value.to || value.to > maximum) {
    throw new Error(`${label} 학년도 범위가 잘못되었습니다.`);
  }
}

export function validateAvailability(availability) {
  if (!availability || availability.version !== 1
    || !Number.isSafeInteger(availability.academic_years?.from)
    || !Number.isSafeInteger(availability.academic_years?.to)
    || availability.academic_years.from > availability.academic_years.to
    || !Array.isArray(availability.rounds) || !availability.rounds.length
    || !Array.isArray(availability.subjects) || !availability.subjects.length
    || !Array.isArray(availability.kinds) || !availability.kinds.length) {
    throw new Error('availability descriptor 형식이 잘못되었습니다.');
  }
  const { from: minimum, to: maximum } = availability.academic_years;
  const roundIds = new Set();
  for (const round of availability.rounds) {
    assertIdentifier(round?.id, 'round');
    assertYearSpan(round, `round ${round.id}`, minimum, maximum);
    if (roundIds.has(round.id)) throw new Error(`availability round 중복: ${round.id}`);
    roundIds.add(round.id);
  }
  const subjectIds = new Set();
  for (const subject of availability.subjects) {
    assertIdentifier(subject?.id, 'subject');
    if (subjectIds.has(subject.id)) throw new Error(`availability subject 중복: ${subject.id}`);
    if (!Array.isArray(subject.tracks) || !subject.tracks.length) {
      throw new Error(`availability ${subject.id} track 목록이 비어 있습니다.`);
    }
    subjectIds.add(subject.id);
    const trackIds = new Set();
    for (const track of subject.tracks) {
      assertIdentifier(track?.id, `${subject.id} track`, { nullable: true });
      assertYearSpan(track, `${subject.id}/${track.id ?? 'none'} track`, minimum, maximum);
      const key = track.id ?? '<none>';
      if (trackIds.has(key)) throw new Error(`availability track 중복: ${subject.id}/${key}`);
      trackIds.add(key);
    }
  }
  const kinds = new Set();
  for (const kind of availability.kinds) {
    assertIdentifier(kind, 'kind');
    if (kinds.has(kind)) throw new Error(`availability kind 중복: ${kind}`);
    kinds.add(kind);
  }
  return availability;
}

export function academicYears(availability = DEFAULT_AVAILABILITY) {
  validateAvailability(availability);
  const { from, to } = availability.academic_years;
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

export function roundDescriptorsFor(availability, academicYear) {
  validateAvailability(availability);
  return availability.rounds.filter(({ from, to }) => academicYear >= from && academicYear <= to);
}

export function subjectDescriptor(availability, subject) {
  validateAvailability(availability);
  return availability.subjects.find(({ id }) => id === subject) || null;
}

export function trackDescriptorsFor(availability, academicYear, subject) {
  const descriptor = subjectDescriptor(availability, subject);
  if (!descriptor) return [];
  return descriptor.tracks.filter(({ from, to }) => academicYear >= from && academicYear <= to);
}

export function expectedCorpusEntries(availability = DEFAULT_AVAILABILITY) {
  validateAvailability(availability);
  const entries = [];
  for (const gradeYear of academicYears(availability)) {
    for (const { id: round } of roundDescriptorsFor(availability, gradeYear)) {
      for (const { id: subject } of availability.subjects) {
        for (const { id: track } of trackDescriptorsFor(availability, gradeYear, subject)) {
          for (const kind of availability.kinds) {
            entries.push({ gradeYear, round, subject, track, kind });
          }
        }
      }
    }
  }
  return entries;
}

export function corpusEntryId({ gradeYear, round, subject, track, kind }) {
  return `${gradeYear - 1}-${round}-${subject}${track ? `-${track}` : ''}-${kind}`;
}
