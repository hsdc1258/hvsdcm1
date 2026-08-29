import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  corpusEntryId,
  DEFAULT_AVAILABILITY,
  expectedCorpusEntries,
} from './availability.mjs';
import {
  canonicalFormForAnswer,
  canonicalFormFromProvenance,
  classifyAttachment,
  fetchKice,
  lastPageFromHtml,
  listUrl,
  parseListPage,
  validateAssignmentCoverage,
} from './fetch-kice.mjs';
import {
  buildManifest,
  deriveAnswerFormOrders,
  deriveAnswerMetadata,
  deriveQuestionFormMetadata,
  detectAnswerTableLayout,
  detectSectionStarts,
  parseSourceFilename,
  validateCorpusManifest,
  validateManifest,
} from './build-manifest.mjs';
import { uploadR2 } from './upload-r2.mjs';
import { verifyGichulReadiness } from './readiness.mjs';
import { inspectAnswerClip } from './output-contract.e2e.mjs';
import { createGichulRenderers } from '../render-sandbox.mjs';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hvsdcm-gichul-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const ZIP_CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
}));

function zipCrc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = ZIP_CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function unicodePathExtra(encodedName, unicodeName) {
  const unicodeBytes = Buffer.from(unicodeName, 'utf8');
  const extra = Buffer.alloc(9 + unicodeBytes.length);
  extra.writeUInt16LE(0x7075, 0);
  extra.writeUInt16LE(5 + unicodeBytes.length, 2);
  extra[4] = 1;
  extra.writeUInt32LE(zipCrc32(encodedName), 5);
  unicodeBytes.copy(extra, 9);
  return extra;
}

// The fixture writes a minimal standards-compliant ZIP so archive tests need no external process.
function zipFixture(entries, { dataDescriptor = false, deflate = false } = {}) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, content, nameOptions = {}] of entries) {
    const nameBytes = nameOptions.encodedNameHex
      ? Buffer.from(nameOptions.encodedNameHex, 'hex')
      : Buffer.from(name, 'utf8');
    const extra = nameOptions.unicodePath ? unicodePathExtra(nameBytes, name) : Buffer.alloc(0);
    const contentBytes = Buffer.from(content);
    const compressedBytes = deflate ? deflateRawSync(contentBytes) : contentBytes;
    const method = deflate ? 8 : 0;
    const flags = (nameOptions.encodedNameHex ? 0 : 0x0800) | (dataDescriptor ? 0x0008 : 0);
    const checksum = zipCrc32(contentBytes);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    if (!dataDescriptor) {
      localHeader.writeUInt32LE(checksum, 14);
      localHeader.writeUInt32LE(compressedBytes.length, 18);
      localHeader.writeUInt32LE(contentBytes.length, 22);
    }
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(extra.length, 28);
    const descriptor = dataDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (dataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressedBytes.length, 8);
      descriptor.writeUInt32LE(contentBytes.length, 12);
    }
    localParts.push(localHeader, nameBytes, extra, compressedBytes, descriptor);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedBytes.length, 20);
    centralHeader.writeUInt32LE(contentBytes.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(extra.length, 30);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBytes, extra);
    localOffset += localHeader.length + nameBytes.length + extra.length + compressedBytes.length + descriptor.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function completeCorpusFixtures(availability = DEFAULT_AVAILABILITY) {
  const entries = expectedCorpusEntries(availability);
  const attachments = new Map();
  for (const entry of entries) {
    const sharedTrack = ((entry.subject === 'korean' || entry.subject === 'math') && entry.gradeYear >= 2022)
      || (entry.subject === 'math' && entry.kind === 'answer');
    const attachment = { ...entry, track: sharedTrack ? null : entry.track };
    const key = `${attachment.gradeYear}-${attachment.round}-${attachment.subject}`
      + `${attachment.track ? `-${attachment.track}` : ''}-${attachment.kind}`;
    attachments.set(key, attachment);
  }
  return {
    attachments: [...attachments.values()],
    exams: entries.map((entry) => ({ id: corpusEntryId(entry) })),
  };
}

function extendedAvailability() {
  const availability = structuredClone(DEFAULT_AVAILABILITY);
  availability.rounds.push({
    id: '10', from: 2027, to: 2027, board_id: 'synthetic', query: '10월',
  });
  availability.subjects.find(({ id }) => id === 'math').tracks.push({
    id: 'vector', from: 2022, to: 2027, section_header: '벡터',
  });
  return availability;
}

test('KICE list parser derives filtered PDF assignments from attachment anchors', () => {
  const context = {
    academicYear: 2021,
    subject: 'social',
    round: '09',
  };
  const html = `
    <a onclick="fn_fileDown('0123456789abcdef0123456789abcdef')" title="사회탐구_법과 정치_문제지.pdf">문제</a>
    <a title="사회탐구_사회문화_정답표.pdf" onclick="fn_fileDown('fedcba9876543210fedcba9876543210')">정답</a>
    <a title="사회탐구_경제_문제지.pdf" onclick="fn_fileDown('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')">제외</a>
  `;
  assert.deepEqual(parseListPage(html, context).map(({ fileSeq, target }) => ({ fileSeq, target })), [
    {
      fileSeq: '0123456789abcdef0123456789abcdef',
      target: '2020-09-politics_law-question.pdf',
    },
    {
      fileSeq: 'fedcba9876543210fedcba9876543210',
      target: '2020-09-soc_culture-answer.pdf',
    },
  ]);
  assert.equal(classifyAttachment('수학영역_가형_문제지.pdf', {
    academicYear: 2021,
    subject: 'math',
    round: 'csat',
  }).target, '2020-csat-math-ga-question.pdf');
  assert.equal(classifyAttachment('수학영역_가형_나형_정답표.pdf', {
    academicYear: 2021,
    subject: 'math',
    round: 'csat',
  }).target, '2020-csat-math-answer.pdf');

  assert.deepEqual(parseListPage(`
    <a title='국어영역_문제지.pdf' onclick="fn_fileDown('c1f3da47c1f3da47c1f3da47c1f3da47')">문제</a>
  `, { academicYear: 2024, subject: 'korean', round: 'csat' }).map(({ fileSeq, target }) => ({
    fileSeq, target,
  })), [{
    fileSeq: 'c1f3da47c1f3da47c1f3da47c1f3da47',
    target: '2023-csat-korean-question.pdf',
  }]);
});

test('KICE list URLs encode the board-specific academic-year and area filters', () => {
  const csat = listUrl({
    boardID: '1500234', academicYear: 2027, area: '국어', subject: 'korean', round: 'csat',
  }, 3);
  assert.equal(csat.searchParams.get('C01'), '2027');
  assert.equal(csat.searchParams.get('C02'), '국어');
  assert.equal(csat.searchParams.get('C03'), null);
  assert.equal(csat.searchParams.get('page'), '3');

  const mock = listUrl({
    boardID: '1500236', academicYear: 2022, month: '6월', area: '수학', subject: 'math', round: '06',
  });
  assert.equal(mock.searchParams.get('C01'), '2022');
  assert.equal(mock.searchParams.get('C02'), '6월');
  assert.equal(mock.searchParams.get('C03'), '수학');
  assert.equal(lastPageFromHtml('<a href="?page=2">2</a><a onclick="fn_egov_link_page(7)">끝</a>'), 7);
});

test('manifest builder injects PDF text extraction and derives modern selection ranges', async (t) => {
  const sourceDirectory = await temporaryDirectory(t);
  const files = [
    '2023-06-korean-question.pdf',
    '2023-09-math-question.pdf',
    '2020-csat-math-ga-question.pdf',
    '2026-06-english-answer.pdf',
  ];
  await Promise.all(files.map((file) => writeFile(path.join(sourceDirectory, file), 'fixture')));
  const pageTextByFile = {
    '2023-06-korean-question.pdf': [
      '표지', '공통 1', '공통 2', '화법과 작문 35.', '화법과 작문 문항', '언어와 매체 35.', '언어와 매체 문항',
    ],
    '2023-09-math-question.pdf': [
      '표지', '공통', '공통', '공통', '확률과 통계 23.', '확률과 통계 문항', '미적분 23.', '미적분 문항', '기하 23.', '기하 문항',
    ],
    '2020-csat-math-ga-question.pdf': ['가형 문제', '가형 문제'],
    '2026-06-english-answer.pdf': ['정답'],
  };
  const calls = [];
  const outputPath = path.join(sourceDirectory, 'manifest.json');
  const { exams } = await buildManifest({
    sourceDirectory,
    outputPath,
    overridesPath: path.join(sourceDirectory, 'missing-overrides.json'),
    allowPartial: true,
    extractText: async (file) => {
      calls.push(path.basename(file));
      const pageTexts = pageTextByFile[path.basename(file)];
      return { pageCount: pageTexts.length, pageTexts };
    },
  });

  assert.deepEqual(calls.sort(), files.sort());
  assert.deepEqual(exams.find((exam) => exam.id === '2023-06-korean-hwajak-question').sections, {
    common: [1, 3], selection: [4, 5],
  });
  assert.deepEqual(exams.find((exam) => exam.id === '2023-06-korean-eonmae-question').sections, {
    common: [1, 3], selection: [6, 7],
  });
  assert.deepEqual(exams.find((exam) => exam.id === '2023-09-math-mijeok-question').sections, {
    common: [1, 4], selection: [7, 8],
  });
  assert.equal(exams.find((exam) => exam.id === '2020-csat-math-ga-question').track, 'ga');
  assert.equal(exams.find((exam) => exam.id === '2026-06-english-answer').track, null);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), {
    availability: DEFAULT_AVAILABILITY,
    exams,
  });
});

test('one availability descriptor carries a new round and fourth math track through build and UI facets', async (t) => {
  const availability = extendedAvailability();
  const sourceDirectory = await temporaryDirectory(t);
  const source = '2026-10-math-question.pdf';
  await writeFile(path.join(sourceDirectory, source), 'fixture');
  const pageTexts = [
    '표지', '공통', '확률과 통계 23.', '확률과 통계 문항', '미적분 23.', '미적분 문항',
    '기하 23.', '기하 문항', '벡터 23.', '벡터 문항',
  ];
  const outputPath = path.join(sourceDirectory, 'manifest.json');
  const manifest = await buildManifest({
    sourceDirectory,
    outputPath,
    overridesPath: path.join(sourceDirectory, 'missing-overrides.json'),
    availability,
    allowPartial: true,
    extractText: async () => ({ pageCount: pageTexts.length, pageTexts }),
  });
  assert.ok(manifest.exams.some(({ id }) => id === '2026-10-math-vector-question'));
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')).availability, availability);

  const complete = completeCorpusFixtures(availability);
  assert.equal(validateAssignmentCoverage(complete.attachments, availability), complete.attachments);
  assert.equal(validateCorpusManifest(complete.exams, availability), complete.exams);

  const withUnknown = {
    ...manifest,
    exams: [...manifest.exams, {
      ...manifest.exams.at(-1), id: 'synthetic-unknown', round: '11', track: 'mystery',
    }],
  };
  const facets = createGichulRenderers().facetsOf(withUnknown, 'math');
  assert.deepEqual(JSON.parse(JSON.stringify(facets.rounds)), ['10', '11']);
  assert.deepEqual(JSON.parse(JSON.stringify(facets.tracks)), ['hwaktong', 'mijeok', 'giha', 'vector', 'mystery']);
});

test('manifest overrides can correct one section while range overlap and bounds stay fatal', async (t) => {
  const sourceDirectory = await temporaryDirectory(t);
  const file = path.join(sourceDirectory, '2023-06-korean-question.pdf');
  await writeFile(file, 'fixture');
  const pageTexts = ['표지', '공통', '공통', '화법과 작문 35.', '선택', '언어와 매체 35.', '선택', '선택'];
  const extractText = async () => ({ pageCount: pageTexts.length, pageTexts });
  const overridesPath = path.join(sourceDirectory, 'overrides.json');
  await writeFile(overridesPath, JSON.stringify({
    sections: {
      '2023-06-korean-eonmae-question': { common: [1, 3], selection: [7, 8] },
    },
  }));
  const { exams } = await buildManifest({ sourceDirectory, overridesPath, extractText, allowPartial: true });
  assert.deepEqual(exams.find((exam) => exam.track === 'hwajak').sections.selection, [4, 6]);
  assert.deepEqual(exams.find((exam) => exam.track === 'eonmae').sections.selection, [7, 8]);

  assert.throws(() => validateManifest([
    {
      id: 'one', r2_key: 'one.pdf', kind: 'question', pages: 3,
      sections: { common: [1, 2], selection: [2, 3] },
    },
  ]), /구간이 겹칩니다/u);
  assert.throws(() => validateManifest([
    {
      id: 'one', r2_key: 'one.pdf', kind: 'question', pages: 3,
      sections: { common: [1, 1], selection: [2, 4] },
    },
  ]), /1\.\.3 안/u);
});

test('section detection requires the track first question on the same physical page', () => {
  const starts = detectSectionStarts([
    '화법과 작문 또는 언어와 매체를 선택하십시오.',
    '공통 문항',
    '화법과 작문\n35번',
    '언어와 매체\n35번',
  ], [
    { track: 'hwajak', header: '화법과 작문', firstQuestion: 35 },
    { track: 'eonmae', header: '언어와 매체', firstQuestion: 35 },
  ]);
  assert.deepEqual(Object.fromEntries(starts), { hwajak: 3, eonmae: 4 });
});

test('section detection keeps the title plus copyright first page over a cleaner running header', () => {
  const starts = detectSectionStarts([
    '공통 22.',
    '이 문제지에 관한 저작권은 평가원에 있습니다. (확률과 통계) 23. 첫 문항',
    '(확률과 통계) 25. 반복 머리말',
    '이 문제지에 관한 저작권은 평가원에 있습니다. (미적분) 23. 첫 문항',
    '(미적분) 25. 반복 머리말',
    '이 문제지에 관한 저작권은 평가원에 있습니다. (기하) 23. 첫 문항',
  ], [
    { track: 'hwaktong', header: '확률과 통계', firstQuestion: 23 },
    { track: 'mijeok', header: '미적분', firstQuestion: 23 },
    { track: 'giha', header: '기하', firstQuestion: 23 },
  ]);
  assert.deepEqual(Object.fromEntries(starts), { hwaktong: 2, mijeok: 4, giha: 6 });
});

test('internal odd-even question blocks select odd and unresolved single publication is rejected', () => {
  const metadata = deriveQuestionFormMetadata([
    ...Array.from({ length: 20 }, () => '홀수형 문제지'),
    ...Array.from({ length: 20 }, () => '짝수형 문제지'),
  ], 'single', 'combined.pdf');
  assert.deepEqual(metadata, {
    canonical_form: 'odd', canonical_pages: [1, 20], source_forms: ['odd', 'even'],
  });
  assert.throws(() => validateManifest([{
    id: '2022-csat-korean-hwajak-question', r2_key: 'combined.pdf', kind: 'question',
    subject: 'korean', grade_year: 2023, track: 'hwajak', pages: 40,
    canonical_form: 'single', canonical_pages: [1, 40], source_forms: ['odd', 'even'],
    sections: { common: [1, 12], selection: [13, 16] },
  }]), /PDF 내부 형과 canonical_form이 충돌합니다/u);
});

test('answer metadata selects the question canonical page and derives track crops from PDF headers', () => {
  const pageLayouts = [1, 2].map(() => ({
    width: 600,
    height: 800,
    items: [
      { text: '공통 과목', x: 140, y: 600, width: 40, height: 10 },
      { text: '화법과 작문', x: 340, y: 600, width: 20, height: 10 },
      { text: '언어와 매체', x: 440, y: 600, width: 20, height: 10 },
      { text: '1', x: 100, y: 500, width: 10, height: 10 },
      { text: '34', x: 200, y: 300, width: 10, height: 10 },
      { text: '35', x: 340, y: 500, width: 10, height: 10 },
      { text: '45', x: 340, y: 300, width: 10, height: 10 },
      { text: '35', x: 440, y: 500, width: 10, height: 10 },
      { text: '45', x: 440, y: 300, width: 10, height: 10 },
    ],
  }));
  const metadata = deriveAnswerMetadata({
    pageTexts: ['국어 정답표 (홀수) 형 화법과 작문 언어와 매체', '국어 정답표 (짝수) 형 화법과 작문 언어와 매체'],
    pageLayouts,
    tracks: ['hwajak', 'eonmae'],
    canonicalForm: 'odd',
    gradeYear: 2022,
    subject: 'korean',
  });
  assert.deepEqual(metadata.answer_pages, [1]);
  assert.deepEqual(metadata.common, [{
    page: 1, x: [0, 0.5], y: [0.36, 0.8075],
  }]);
  assert.deepEqual(metadata.selections.get('hwajak'), [{
    page: 1, x: [0.5, 0.666667], y: [0.36, 0.8075],
  }]);
  assert.deepEqual(metadata.selections.get('eonmae'), [{
    page: 1, x: [0.666667, 0.833333], y: [0.36, 0.8075],
  }]);
  assert.throws(() => deriveAnswerMetadata({
    pageTexts: ['형 표기 없는 답안'], pageLayouts: pageLayouts.slice(0, 1), tracks: [],
    canonicalForm: 'odd', gradeYear: 2022, subject: 'english',
  }), /답안 형 표기가 없습니다/u);
  assert.deepEqual(deriveAnswerMetadata({
    pageTexts: ['홀수형 답안', '짝수형 답안'], pageLayouts, tracks: [],
    canonicalForm: 'single', gradeYear: 2023, subject: 'english',
  }).answer_pages, [1, 2]);
  const formOrders = deriveAnswerFormOrders([
    { label: 'text answer', pageTexts: ['홀수형 답안', '짝수형 답안'] },
    { label: 'image answer', pageTexts: ['', ''] },
  ]);
  assert.deepEqual(formOrders.get(2), ['odd', 'even']);
  assert.deepEqual(deriveAnswerMetadata({
    pageTexts: ['', ''], pageLayouts, tracks: [], canonicalForm: 'odd',
    gradeYear: 2025, subject: 'english', answerFormOrder: formOrders.get(2),
  }).answer_pages, [1]);
  assert.throws(() => deriveAnswerFormOrders([
    { label: 'odd-first', pageTexts: ['홀수형', '짝수형'] },
    { label: 'even-first', pageTexts: ['짝수형', '홀수형'] },
  ]), /형 순서가 원본끼리 일치하지 않습니다/u);
});

test('a shared answer inherits one provenance-derived form from every matching question track', () => {
  const answer = {
    target: '2019-csat-math-answer.pdf', gradeYear: 2020, year: 2019,
    round: 'csat', subject: 'math', track: null,
  };
  const questions = ['ga', 'na'].map((track) => ({
    gradeYear: 2020, year: 2019, round: 'csat', subject: 'math', track,
    filename: `수학_${track}_홀수형.pdf`, canonical_form: 'odd',
  }));
  assert.equal(canonicalFormForAnswer(answer, questions), 'odd');
  assert.throws(() => canonicalFormForAnswer(answer, [
    questions[0], { ...questions[1], canonical_form: 'even' },
  ]), /문제지 정본 형이 일치하지 않습니다/u);
});

test('image-only answer table derives selection columns from original raster lines', () => {
  const width = 400;
  const height = 600;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const pixel = (x, y) => {
    const offset = (y * width + x) * 4;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
  };
  const horizontal = (y, from, to) => {
    for (let x = from; x <= to; x += 1) pixel(x, y);
  };
  const vertical = (x, from, to) => {
    for (let y = from; y <= to; y += 1) {
      pixel(x, y);
      pixel(x + 1, y);
    }
  };
  horizontal(100, 40, 360);
  horizontal(130, 200, 360);
  horizontal(160, 40, 360);
  vertical(40, 100, 500);
  vertical(200, 100, 500);
  vertical(280, 130, 360);
  vertical(359, 100, 360);
  const layout = detectAnswerTableLayout({ data, width, height });
  assert.equal(layout.selection_lines.length, 3);
  const metadata = deriveAnswerMetadata({
    pageTexts: [''], pageLayouts: [{ width, height, items: [] }], pageRasterLayouts: [layout],
    tracks: ['hwajak', 'eonmae'], canonicalForm: 'odd', answerFormOrder: ['odd'],
    gradeYear: 2025, subject: 'korean',
  });
  assert.deepEqual(metadata.common[0], {
    page: 1, x: [0.1025, 0.5025], y: [0.163667, 0.836333],
  });
  assert.deepEqual(metadata.selections.get('hwajak')[0].x, [0.5025, 0.7025]);
  assert.deepEqual(metadata.selections.get('eonmae')[0].x, [0.7025, 0.9]);
});

test('independent answer oracle requires the header and first/last selected rows inside both crop axes', () => {
  const layout = {
    width: 600,
    height: 800,
    items: [
      { text: '공통 과목', x: 100, y: 600, width: 40, height: 10 },
      { text: '화법과 작문', x: 340, y: 600, width: 20, height: 10 },
      { text: '언어와 매체', x: 440, y: 600, width: 20, height: 10 },
      { text: '1', x: 100, y: 500, width: 10, height: 10 },
      { text: '34', x: 200, y: 300, width: 10, height: 10 },
      { text: '35', x: 340, y: 500, width: 10, height: 10 },
      { text: '45', x: 340, y: 300, width: 10, height: 10 },
      { text: '35', x: 440, y: 500, width: 10, height: 10 },
      { text: '45', x: 440, y: 300, width: 10, height: 10 },
    ],
  };
  const definitions = [
    { track: 'hwajak', header: '화법과 작문', firstQuestion: 35 },
    { track: 'eonmae', header: '언어와 매체', firstQuestion: 35 },
  ];
  const correct = inspectAnswerClip({
    clip: { x: [0.5, 0.666667], y: [0.36, 0.8075] },
    layout,
    definitions,
  });
  assert.deepEqual(correct, {
    parts: ['hwajak'], partial_part_count: 0,
  });
  const empty = inspectAnswerClip({
    clip: { x: [0.5, 0.666667], y: [0, 0.01] },
    layout,
    definitions,
  });
  assert.deepEqual(empty.parts, []);
});

test('manifest filenames reject tracks from the wrong subject or academic-year system', () => {
  assert.throws(
    () => parseSourceFilename('2020-06-korean-hwajak-question.pdf'),
    /과목 체제와 맞지 않는 선택과목/u,
  );
  assert.throws(
    () => parseSourceFilename('2024-09-english-giha-answer.pdf'),
    /과목 체제와 맞지 않는 선택과목/u,
  );
});

test('range planner uses common once for full output and selection only for excerpts', () => {
  const renderers = createGichulRenderers();
  const exams = [
    {
      id: '2021-csat-korean-hwajak-question', subject: 'korean', year: 2021, grade_year: 2022,
      round: 'csat', track: 'hwajak', kind: 'question', r2_key: 'shared.pdf', pages: 20,
      sections: { common: [1, 8], selection: [9, 12] },
    },
    {
      id: '2021-csat-korean-eonmae-question', subject: 'korean', year: 2021, grade_year: 2022,
      round: 'csat', track: 'eonmae', kind: 'question', r2_key: 'shared.pdf', pages: 20,
      sections: { common: [1, 8], selection: [17, 20] },
    },
  ];
  const manifest = { exams };
  const full = renderers.planSegments(exams, manifest, {
    ...renderers.defaultState(), mode: 'full', includeCommon: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(full.segments.map(({ ranges }) => ranges))), [
    [[1, 8], [9, 12]],
    [[17, 20]],
  ]);
  const excerpt = renderers.planSegments([exams[0]], manifest, {
    ...renderers.defaultState(), mode: 'excerpt', includeCommon: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(excerpt.segments.map(({ ranges }) => ranges))), [[[9, 12]]]);

  const filters = renderers.renderFilters(manifest, { ...renderers.defaultState(), mode: 'excerpt' });
  const body = renderers.renderBody(manifest, { ...renderers.defaultState(), mode: 'excerpt', selected: [] });
  assert.doesNotMatch(filters, /includeCommon|공통 파트 포함/u);
  assert.match(body, /선택과목만 9–12쪽/u);
  assert.doesNotMatch(body, /공통 1–8쪽/u);
});

test('answer planner maps the exact included question parts to common and selected answer crops', () => {
  const renderers = createGichulRenderers();
  const questions = [
    {
      id: '2021-csat-korean-hwajak-question', subject: 'korean', year: 2021, grade_year: 2022,
      round: 'csat', track: 'hwajak', kind: 'question', r2_key: 'question.pdf', pages: 20,
      canonical_form: 'odd', sections: { common: [1, 12], selection: [13, 16] },
    },
    {
      id: '2021-csat-korean-eonmae-question', subject: 'korean', year: 2021, grade_year: 2022,
      round: 'csat', track: 'eonmae', kind: 'question', r2_key: 'question.pdf', pages: 20,
      canonical_form: 'odd', sections: { common: [1, 12], selection: [17, 20] },
    },
  ];
  const answers = [
    {
      ...questions[0], id: '2021-csat-korean-hwajak-answer', kind: 'answer', r2_key: 'answer.pdf', pages: 2,
      sections: undefined, answer_pages: [1],
      answer_common: [{ page: 1, x: [0, 0.48], y: [0.4, 0.8] }],
      answer_selection: [{ page: 1, x: [0.48, 0.66], y: [0.4, 0.8] }],
    },
    {
      ...questions[1], id: '2021-csat-korean-eonmae-answer', kind: 'answer', r2_key: 'answer.pdf', pages: 2,
      sections: undefined, answer_pages: [1],
      answer_common: [{ page: 1, x: [0, 0.48], y: [0.4, 0.8] }],
      answer_selection: [{ page: 1, x: [0.66, 0.84], y: [0.4, 0.8] }],
    },
  ];
  const manifest = { exams: [...questions, ...answers] };
  const full = renderers.planSegments(questions, manifest, {
    ...renderers.defaultState(), mode: 'full', includeAnswers: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(full.segments.at(-1))), {
    id: answers[0].id,
    key: 'answer.pdf',
    label: '2022학년도 수능 국어 (화법과 작문) 정답표',
    clips: [
      { page: 1, x: [0, 0.48], y: [0.4, 0.8] },
      { page: 1, x: [0.48, 0.66], y: [0.4, 0.8] },
      { page: 1, x: [0.66, 0.84], y: [0.4, 0.8] },
    ],
  });
  assert.equal(full.missingAnswers.length, 0);

  const fullOne = renderers.planSegments([questions[0]], manifest, {
    ...renderers.defaultState(), mode: 'full', includeAnswers: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(fullOne.segments.at(-1).clips)), [
    { page: 1, x: [0, 0.48], y: [0.4, 0.8] },
    { page: 1, x: [0.48, 0.66], y: [0.4, 0.8] },
  ]);

  const missingCommon = { exams: manifest.exams.map((exam) => (
    exam.id === answers[0].id ? { ...exam, answer_common: undefined } : exam
  )) };
  const partialFull = renderers.planSegments([questions[0]], missingCommon, {
    ...renderers.defaultState(), mode: 'full', includeAnswers: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(partialFull.segments.at(-1).clips)), [
    { page: 1, x: [0.48, 0.66], y: [0.4, 0.8] },
  ]);
  assert.equal(partialFull.missingAnswers.length, 1);

  const excerpt = renderers.planSegments([questions[0]], manifest, {
    ...renderers.defaultState(), mode: 'excerpt', includeAnswers: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(excerpt.segments.at(-1).clips)), [
    { page: 1, x: [0.48, 0.66], y: [0.4, 0.8] },
  ]);
  assert.equal(excerpt.missingAnswers.length, 0);

  const mismatched = { exams: manifest.exams.map((exam) => (
    exam.id === answers[0].id ? { ...exam, canonical_form: 'even' } : exam
  )) };
  const rejected = renderers.planSegments([questions[0]], mismatched, {
    ...renderers.defaultState(), mode: 'excerpt', includeAnswers: true,
  });
  assert.equal(rejected.segments.length, 1);
  assert.equal(rejected.missingAnswers.length, 1);

  const legacyQuestion = {
    id: '2020-06-english-question', subject: 'english', year: 2020, grade_year: 2021,
    round: '06', track: null, kind: 'question', r2_key: 'legacy-question.pdf', pages: 8,
    canonical_form: 'odd', canonical_pages: [1, 8], source_forms: ['odd'],
  };
  const legacyAnswer = {
    ...legacyQuestion, id: '2020-06-english-answer', kind: 'answer', r2_key: 'legacy-answer.pdf',
    pages: 2, canonical_pages: undefined, source_forms: undefined, answer_pages: [1],
  };
  const legacy = renderers.planSegments([legacyQuestion], { exams: [legacyQuestion, legacyAnswer] }, {
    ...renderers.defaultState(), mode: 'full', includeAnswers: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(legacy.segments.at(-1))), {
    id: legacyAnswer.id,
    key: legacyAnswer.r2_key,
    label: '2021학년도 6월 영어 정답표',
    ranges: [[1, 1]],
  });
  assert.equal(legacy.missingAnswers.length, 0);
});

test('full planner derives 0, 1 and N selected math tracks without foreign ranges', () => {
  const renderers = createGichulRenderers();
  const definitions = [
    ['hwaktong', [13, 15]],
    ['mijeok', [16, 18]],
    ['giha', [19, 20]],
  ];
  const exams = definitions.map(([track, selection]) => ({
    id: `2023-csat-math-${track}-question`, subject: 'math', year: 2023, grade_year: 2024,
    round: 'csat', track, kind: 'question', r2_key: 'math.pdf', pages: 20,
    sections: { common: [1, 12], selection },
  }));
  const manifest = { exams };
  for (const chosen of [[], exams.slice(0, 1), exams]) {
    const { segments } = renderers.planSegments(chosen, manifest, { ...renderers.defaultState(), mode: 'full' });
    const ranges = segments.flatMap((segment) => segment.ranges);
    assert.equal(ranges.filter(([from, to]) => from === 1 && to === 12).length, chosen.length ? 1 : 0);
    assert.deepEqual(JSON.parse(JSON.stringify(ranges.filter(([from]) => from > 12))),
      chosen.map((exam) => exam.sections.selection));
  }
});

test('production corpus validation rejects an incomplete manifest and crawl inventory', () => {
  assert.throws(() => validateCorpusManifest([{
    id: '2026-06-english-question',
  }]), /매니페스트 코퍼스가 불완전합니다/u);
  assert.throws(() => validateAssignmentCoverage([{
    gradeYear: 2027, round: '06', subject: 'english', track: null, kind: 'question',
  }]), /평가원 코퍼스가 불완전합니다/u);
});

test('production corpus validators accept the complete contracted availability matrix', () => {
  const { attachments, exams } = completeCorpusFixtures();
  assert.equal(validateAssignmentCoverage(attachments), attachments);
  assert.equal(validateCorpusManifest(exams), exams);
  for (let index = 0; index < attachments.length; index += 1) {
    assert.throws(
      () => validateAssignmentCoverage(attachments.toSpliced(index, 1)),
      /평가원 코퍼스가 불완전합니다/u,
    );
  }
  for (let index = 0; index < exams.length; index += 1) {
    assert.throws(() => validateCorpusManifest(exams.toSpliced(index, 1)),
      /매니페스트 코퍼스가 불완전합니다/u);
  }
});

test('production manifest build rejects an inventoried but incomplete source corpus before extraction', async (t) => {
  const sourceDirectory = await temporaryDirectory(t);
  const target = '2026-06-english-question.pdf';
  await writeFile(path.join(sourceDirectory, target), 'fixture');
  const inventoryPath = path.join(sourceDirectory, 'crawl-inventory.json');
  await writeFile(inventoryPath, JSON.stringify({
    version: 1,
    files: [{
      target,
      fileSeq: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sourceFilename: '영어영역_문제지.pdf',
      canonical_form: 'single',
      grade_year: 2027,
      year: 2026,
      round: '06',
      subject: 'english',
      track: null,
      kind: 'question',
    }],
  }));
  let extracted = false;
  await assert.rejects(buildManifest({
    sourceDirectory,
    inventoryPath,
    overridesPath: path.join(sourceDirectory, 'missing-overrides.json'),
    extractText: async () => {
      extracted = true;
      return { pageCount: 1, pageTexts: ['fixture'] };
    },
  }), /매니페스트 코퍼스가 불완전합니다/u);
  assert.equal(extracted, false);
});

test('manifest overrides reject missing/extra ranges, inconsistent common pages, and unused IDs', async (t) => {
  const sourceDirectory = await temporaryDirectory(t);
  await writeFile(path.join(sourceDirectory, '2023-06-korean-question.pdf'), 'fixture');
  const pageTexts = ['표지', '공통', '공통', '화법과 작문 35.', '선택', '언어와 매체 35.', '선택'];
  const extractText = async () => ({ pageCount: pageTexts.length, pageTexts });
  const overridesPath = path.join(sourceDirectory, 'overrides.json');

  for (const sections of [
    { selection: [6, 7] },
    { common: [1, 3], selection: [6, 7], extra: [1, 1] },
  ]) {
    await writeFile(overridesPath, JSON.stringify({
      sections: { '2023-06-korean-eonmae-question': sections },
    }));
    await assert.rejects(
      buildManifest({ sourceDirectory, overridesPath, extractText, allowPartial: true }),
      /common과 selection/u,
    );
  }

  await writeFile(overridesPath, JSON.stringify({
    sections: {
      '2023-06-korean-eonmae-question': { common: [1, 3], selection: [3, 7] },
    },
  }));
  await assert.rejects(
    buildManifest({ sourceDirectory, overridesPath, extractText, allowPartial: true }),
    /구간이 겹칩니다/u,
  );

  await writeFile(overridesPath, JSON.stringify({
    sections: { '2099-06-korean-eonmae-question': { common: [1, 3], selection: [6, 7] } },
  }));
  await assert.rejects(
    buildManifest({ sourceDirectory, overridesPath, extractText, allowPartial: true }),
    /사용되지 않은 section override ID/u,
  );

  assert.throws(() => validateManifest([
    {
      id: 'a', subject: 'korean', grade_year: 2024, kind: 'question', r2_key: 'shared.pdf', pages: 8,
      sections: { common: [1, 3], selection: [4, 5] },
    },
    {
      id: 'b', subject: 'korean', grade_year: 2024, kind: 'question', r2_key: 'shared.pdf', pages: 8,
      sections: { common: [1, 4], selection: [6, 8] },
    },
  ]), /common 구간이 선택과목마다 다릅니다/u);
});

test('collector paginates, ignores unrelated files, and refreshes only a changed fileSeq', async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const inventoryPath = path.join(outputDirectory, 'crawl-inventory.json');
  const target = path.join(outputDirectory, '2023-06-english-question.pdf');
  const oldSeq = '11111111111111111111111111111111';
  const newSeq = '22222222222222222222222222222222';
  await writeFile(target, '%PDF-old');
  await writeFile(inventoryPath, JSON.stringify({
    version: 1,
    files: [{ target: path.basename(target), fileSeq: oldSeq }],
  }));
  const context = {
    boardID: '1500236', academicYear: 2024, month: '6월', area: '영어', subject: 'english', round: '06',
  };
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    if (parsed.pathname.endsWith('/list.do')) {
      if (parsed.searchParams.get('page') === '1') {
        return new Response('<a onclick="fn_egov_link_page(2)">2</a><a title="영어_듣기.mp3" onclick="fn_fileDown(\'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\')">오디오</a>');
      }
      return new Response(`<a title="영어영역_문제지.pdf" onclick="fn_fileDown('${newSeq}')">문제</a>`);
    }
    assert.equal(parsed.searchParams.get('fileSeq'), newSeq);
    return new Response('%PDF-new');
  };
  const first = await fetchKice({
    fetchImpl, outputDirectory, inventoryPath, contexts: [context], delayMs: 0, allowPartial: true, log() {},
  });
  assert.equal(first[0].status, 'downloaded');
  assert.equal(await readFile(target, 'utf8'), '%PDF-new');
  assert.equal(calls.filter((url) => url.pathname.endsWith('/list.do')).length, 2);
  assert.equal(JSON.parse(await readFile(inventoryPath, 'utf8')).files[0].fileSeq, newSeq);

  const second = await fetchKice({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/list.do')) {
        if (parsed.searchParams.get('page') === '1') return new Response('<a onclick="fn_egov_link_page(2)">2</a>');
        return new Response(`<a title="영어영역_문제지.pdf" onclick="fn_fileDown('${newSeq}')">문제</a>`);
      }
      throw new Error('unchanged cached PDF must not be downloaded');
    },
    outputDirectory,
    inventoryPath,
    contexts: [context],
    delayMs: 0,
    allowPartial: true,
    log() {},
  });
  assert.equal(second[0].status, 'skipped');
});

test('collector keeps the odd form, logs the even form and accessories, and accepts year-specific single papers', async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const contexts = [
    { boardID: '1500234', academicYear: 2025, area: '국어', subject: 'korean', round: 'csat' },
    { boardID: '1500234', academicYear: 2025, area: '영어', subject: 'english', round: 'csat' },
    { boardID: '1500234', academicYear: 2024, area: '국어', subject: 'korean', round: 'csat' },
    { boardID: '1500234', academicYear: 2024, area: '영어', subject: 'english', round: 'csat' },
  ];
  const listHtml = new Map([
    ['2025-국어', `
      <a title='국어영역_문제지_짝수형.pdf' onclick="fn_fileDown('11111111111111111111111111111111')">짝수</a>
      <a title='국어영역_문제지_홀수형.pdf' onclick="fn_fileDown('22222222222222222222222222222222')">홀수</a>
      <a title='국어영역_정답표.pdf' onclick="fn_fileDown('33333333333333333333333333333333')">정답</a>
    `],
    ['2025-영어', `
      <a title='영어영역_문제지_홀수형.pdf' onclick="fn_fileDown('44444444444444444444444444444444')">홀수</a>
      <a title='영어영역_문제지_짝수형.pdf' onclick="fn_fileDown('55555555555555555555555555555555')">짝수</a>
      <a title='영어영역_듣기평가음원.zip' onclick="fn_fileDown('66666666666666666666666666666666')">음원</a>
      <a title='영어영역_듣기평가대본.pdf' onclick="fn_fileDown('77777777777777777777777777777777')">대본</a>
      <a title='영어영역_정답표.pdf' onclick="fn_fileDown('88888888888888888888888888888888')">정답</a>
    `],
    ['2024-국어', `
      <a title='국어영역_문제지.pdf' onclick="fn_fileDown('99999999999999999999999999999999')">문제</a>
      <a title='국어영역_정답표.pdf' onclick="fn_fileDown('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')">정답</a>
    `],
    ['2024-영어', `
      <a title='영어영역_문제지_짝수형.pdf' onclick="fn_fileDown('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')">짝수</a>
      <a title='영어영역_정답표.pdf' onclick="fn_fileDown('cccccccccccccccccccccccccccccccc')">정답</a>
    `],
  ]);
  const downloads = [];
  const logs = [];
  const results = await fetchKice({
    outputDirectory,
    contexts,
    delayMs: 0,
    allowPartial: true,
    log: (message) => logs.push(message),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/list.do')) {
        return new Response(listHtml.get(`${parsed.searchParams.get('C01')}-${parsed.searchParams.get('C02')}`));
      }
      downloads.push(parsed.searchParams.get('fileSeq'));
      return new Response('%PDF-fixture');
    },
  });

  assert.equal(results.length, 8);
  assert.deepEqual(downloads.sort(), [
    '22222222222222222222222222222222',
    '33333333333333333333333333333333',
    '44444444444444444444444444444444',
    '88888888888888888888888888888888',
    '99999999999999999999999999999999',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'cccccccccccccccccccccccccccccccc',
  ].sort());
  assert.ok(logs.some((message) => message.includes('국어영역_문제지_짝수형.pdf')));
  assert.ok(logs.some((message) => message.includes('영어영역_문제지_짝수형.pdf')));
  assert.ok(logs.some((message) => message.includes('영어영역_듣기평가음원.zip')));
  assert.ok(logs.some((message) => message.includes('영어영역_듣기평가대본.pdf')));
  assert.equal(await readFile(path.join(outputDirectory, '2024-csat-korean-question.pdf'), 'utf8'), '%PDF-fixture');
  assert.equal(await readFile(path.join(outputDirectory, '2023-csat-korean-question.pdf'), 'utf8'), '%PDF-fixture');
  const inventory = JSON.parse(await readFile(path.join(outputDirectory, 'crawl-inventory.json'), 'utf8'));
  const odd = inventory.files.find(({ target }) => target === '2024-csat-korean-question.pdf');
  assert.equal(odd.sourceFilename, '국어영역_문제지_홀수형.pdf');
  assert.equal(odd.canonical_form, 'odd');
  assert.equal(inventory.files.find(({ target }) => target === '2024-csat-korean-answer.pdf').canonical_form,
    'odd');
  assert.equal(inventory.files.find(({ target }) => target === '2023-csat-korean-question.pdf').canonical_form,
    'single');
  assert.equal(inventory.files.find(({ target }) => target === '2023-csat-english-question.pdf').canonical_form,
    'even');
  assert.equal(inventory.files.find(({ target }) => target === '2023-csat-english-answer.pdf').canonical_form,
    'even');
  assert.equal(canonicalFormFromProvenance('국어영역.zip', '문제지_홀수형.pdf'), 'odd');
});

test('collector extracts live 2020-2022 CSAT subject ZIP naming variants in their area context', async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const contexts = [
    { boardID: '1500234', academicYear: 2020, area: '국어', subject: 'korean', round: 'csat' },
    { boardID: '1500234', academicYear: 2021, area: '국어', subject: 'korean', round: 'csat' },
    { boardID: '1500234', academicYear: 2022, area: '국어', subject: 'korean', round: 'csat' },
    { boardID: '1500234', academicYear: 2020, area: '수학', subject: 'math', round: 'csat' },
    { boardID: '1500234', academicYear: 2020, area: '영어', subject: 'english', round: 'csat' },
  ];
  const fixtures = new Map([
    ['2020-국어', {
      seq: '10101010101010101010101010101010', filename: '국어.zip', archive: zipFixture([
        ['국어_문제지_짝수형.pdf', '%PDF-2020-korean-even'],
        ['국어_문제지_홀수형.pdf', '%PDF-2020-korean-odd'],
      ]),
    }],
    ['2021-국어', {
      seq: '11111111111111111111111111111111', filename: '1교시_국어영역.zip', archive: zipFixture([
        ['1교시_국어영역_문제지_홀수형.pdf', '%PDF-2021-korean-odd'],
        ['1교시_국어영역_문제지_짝수형.pdf', '%PDF-2021-korean-even'],
      ]),
    }],
    ['2022-국어', {
      seq: '12121212121212121212121212121212', filename: '1교시_국어영역_문제지.zip', archive: zipFixture([
        ['국어영역_문제지_홀수형.pdf', '%PDF-2022-korean-odd'],
        ['국어영역_문제지_짝수형.pdf', '%PDF-2022-korean-even'],
      ]),
    }],
    ['2020-수학', {
      seq: '20202020202020202020202020202020', filename: '수학.zip', archive: zipFixture([
        ['수학_가형_문제지_짝수형.pdf', '%PDF-2020-math-ga-even'],
        ['수학_가형_문제지_홀수형.pdf', '%PDF-2020-math-ga-odd'],
        ['수학_나형_문제지_홀수형.pdf', '%PDF-2020-math-na-odd'],
        ['수학_나형_정답표.pdf', '%PDF-2020-math-answer'],
      ]),
    }],
    ['2020-영어', {
      seq: '30303030303030303030303030303030', filename: '영어.zip', archive: zipFixture([
        ['영어_짝.pdf', '%PDF-2020-english-even'],
        ['영어_홀.pdf', '%PDF-2020-english-odd'],
        ['영어_듣기대본.pdf', '%PDF-2020-english-script'],
      ]),
    }],
  ]);
  const downloads = [];
  const logs = [];
  const results = await fetchKice({
    outputDirectory,
    contexts,
    delayMs: 0,
    allowPartial: true,
    log: (message) => logs.push(message),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/list.do')) {
        const key = `${parsed.searchParams.get('C01')}-${parsed.searchParams.get('C02')}`;
        const fixture = fixtures.get(key);
        const accessory = key === '2020-영어'
          ? `<a title='듣기평가.zip' onclick="fn_fileDown('40404040404040404040404040404040')">듣기</a>`
          : '';
        return new Response(`<a title='${fixture.filename}' onclick="fn_fileDown('${fixture.seq}')">본편</a>${accessory}`);
      }
      const fixture = [...fixtures.values()].find(({ seq }) => seq === parsed.searchParams.get('fileSeq'));
      downloads.push(fixture.seq);
      return new Response(fixture.archive);
    },
  });

  assert.equal(results.length, 6);
  assert.equal(downloads.length, fixtures.size);
  assert.equal(await readFile(path.join(outputDirectory, '2019-csat-korean-question.pdf'), 'utf8'),
    '%PDF-2020-korean-odd');
  assert.equal(await readFile(path.join(outputDirectory, '2020-csat-korean-question.pdf'), 'utf8'),
    '%PDF-2021-korean-odd');
  assert.equal(await readFile(path.join(outputDirectory, '2021-csat-korean-question.pdf'), 'utf8'),
    '%PDF-2022-korean-odd');
  assert.equal(await readFile(path.join(outputDirectory, '2019-csat-math-ga-question.pdf'), 'utf8'),
    '%PDF-2020-math-ga-odd');
  assert.equal(await readFile(path.join(outputDirectory, '2019-csat-math-na-question.pdf'), 'utf8'),
    '%PDF-2020-math-na-odd');
  assert.equal(await readFile(path.join(outputDirectory, '2019-csat-english-question.pdf'), 'utf8'),
    '%PDF-2020-english-odd');
  assert.ok(logs.some((message) => message.includes('듣기평가.zip')));
  assert.ok(logs.some((message) => message.includes('영어_듣기대본.pdf')));
  assert.ok(logs.some((message) => message.includes('영어_짝.pdf')));
});

test('collector extracts Social and Culture plus Politics and Law PDFs from real-shape social ZIP bundles', async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const context = {
    boardID: '1500234', academicYear: 2025, area: '사회탐구', subject: 'social', round: 'csat',
  };
  const questionSeq = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const answerSeq = 'cccccccccccccccccccccccccccccccc';
  const questionZip = zipFixture([
    ['2025학년도/사회탐구영역_사회문화_문제지.pdf', '%PDF-social-question', {
      encodedNameHex: '32303235c7d0b3e2b5b52fbbe7c8b8c5bdb1b8bfb5bfaa5fbbe7c8b8b9aec8ad5fb9aec1a6c1f62e706466',
    }],
    ['2025학년도/사회탐구영역_정치와 법_문제지.pdf', '%PDF-politics-question', {
      encodedNameHex: '32303235c7d0b3e2b5b52fbbe7c8b8c5bdb1b8bfb5bfaa5fc1a4c4a1bfcdb9fd5fb9aec1a6c1f62e706466',
      unicodePath: true,
    }],
    ['2025학년도/사회탐구영역_경제_문제지.pdf', '%PDF-economics-question'],
  ], { dataDescriptor: true, deflate: true });
  const answerZip = zipFixture([
    ['사회탐구영역_사회문화_정답표.pdf', '%PDF-social-answer'],
    ['사회탐구영역_법과 정치_정답표.pdf', '%PDF-politics-answer'],
  ]);
  const logs = [];
  const results = await fetchKice({
    outputDirectory,
    contexts: [context],
    delayMs: 0,
    allowPartial: true,
    log: (message) => logs.push(message),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/list.do')) {
        return new Response(`
          <a title='사회탐구영역_문제지.zip' onclick="fn_fileDown('${questionSeq}')">문제</a>
          <a title='사회탐구영역_정답표.zip' onclick="fn_fileDown('${answerSeq}')">정답</a>
        `);
      }
      return new Response(parsed.searchParams.get('fileSeq') === questionSeq ? questionZip : answerZip);
    },
  });

  assert.equal(results.length, 4);
  assert.equal(await readFile(path.join(outputDirectory, '2024-csat-soc_culture-question.pdf'), 'utf8'),
    '%PDF-social-question');
  assert.equal(await readFile(path.join(outputDirectory, '2024-csat-politics_law-question.pdf'), 'utf8'),
    '%PDF-politics-question');
  assert.equal(await readFile(path.join(outputDirectory, '2024-csat-soc_culture-answer.pdf'), 'utf8'),
    '%PDF-social-answer');
  assert.equal(await readFile(path.join(outputDirectory, '2024-csat-politics_law-answer.pdf'), 'utf8'),
    '%PDF-politics-answer');
  assert.ok(logs.some((message) => message.includes('사회탐구영역_경제_문제지.pdf')));
  const inventory = JSON.parse(await readFile(path.join(outputDirectory, 'crawl-inventory.json'), 'utf8'));
  assert.equal(inventory.files.length, 4);
  assert.equal(inventory.files.find(({ target }) => target === '2024-csat-soc_culture-question.pdf').archiveEntry,
    '2025학년도/사회탐구영역_사회문화_문제지.pdf');
  assert.equal(inventory.files.find(({ target }) => target === '2024-csat-politics_law-question.pdf').archiveEntry,
    '2025학년도/사회탐구영역_정치와 법_문제지.pdf');
  assert.equal(inventory.files.find(({ target }) => target === '2024-csat-politics_law-answer.pdf').archiveEntry,
    '사회탐구영역_법과 정치_정답표.pdf');

  const cached = await fetchKice({
    outputDirectory,
    contexts: [context],
    delayMs: 0,
    allowPartial: true,
    log() {},
    fetchImpl: async (url) => {
      if (!new URL(url).pathname.endsWith('/list.do')) throw new Error('cached ZIP must not be downloaded');
      return new Response(`
        <a title='사회탐구영역_문제지.zip' onclick="fn_fileDown('${questionSeq}')">문제</a>
        <a title='사회탐구영역_정답표.zip' onclick="fn_fileDown('${answerSeq}')">정답</a>
      `);
    },
  });
  assert.equal(cached.length, 4);
  assert.ok(cached.every(({ status }) => status === 'skipped'));
});

test('collector maps live legacy social ZIP names and one integrated answer PDF to both subjects', async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const contexts = [2020, 2021, 2022].map((academicYear) => ({
    boardID: '1500234', academicYear, area: '사회탐구', subject: 'social', round: 'csat',
  }));
  const fixtures = new Map([
    ['2020', {
      questionName: '사회탐구.zip',
      questionSeq: '50505050505050505050505050505050',
      answerName: '사회탐구_정답표.pdf',
      answerSeq: '51515151515151515151515151515151',
    }],
    ['2021', {
      questionName: '4교시_사회탐구영역.zip',
      questionSeq: '60606060606060606060606060606060',
      answerName: '4교시_사회탐구영역_정답표.pdf',
      answerSeq: '61616161616161616161616161616161',
    }],
    ['2022', {
      answerName: '4교시_사회탐구영역_정답표.pdf',
      answerSeq: '71717171717171717171717171717171',
    }],
  ]);
  const archives = new Map([
    ['50505050505050505050505050505050', zipFixture([
      ['사회탐구_사회문화_문제지.pdf', '%PDF-2020-social-question'],
      ['사회탐구_법과 정치_문제지.pdf', '%PDF-2020-politics-question'],
    ])],
    ['60606060606060606060606060606060', zipFixture([
      ['4교시_사회탐구영역_사회문화_문제지.pdf', '%PDF-2021-social-question'],
      ['4교시_사회탐구영역_법과 정치_문제지.pdf', '%PDF-2021-politics-question'],
    ])],
  ]);
  const results = await fetchKice({
    outputDirectory,
    contexts,
    delayMs: 0,
    allowPartial: true,
    log() {},
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/list.do')) {
        const fixture = fixtures.get(parsed.searchParams.get('C01'));
        return new Response(`
          ${fixture.questionName ? `<a title='${fixture.questionName}' onclick="fn_fileDown('${fixture.questionSeq}')">문제</a>` : ''}
          <a title='${fixture.answerName}' onclick="fn_fileDown('${fixture.answerSeq}')">정답</a>
        `);
      }
      const fileSeq = parsed.searchParams.get('fileSeq');
      return new Response(archives.get(fileSeq) || `%PDF-integrated-answer-${fileSeq.slice(0, 2)}`);
    },
  });

  assert.equal(results.length, 10);
  for (const [year, answerPrefix] of [[2019, '51'], [2020, '61'], [2021, '71']]) {
    const socialAnswer = await readFile(path.join(outputDirectory, `${year}-csat-soc_culture-answer.pdf`), 'utf8');
    const politicsAnswer = await readFile(path.join(outputDirectory, `${year}-csat-politics_law-answer.pdf`), 'utf8');
    assert.equal(socialAnswer, `%PDF-integrated-answer-${answerPrefix}`);
    assert.equal(politicsAnswer, socialAnswer);
  }
  assert.equal(await readFile(path.join(outputDirectory, '2019-csat-soc_culture-question.pdf'), 'utf8'),
    '%PDF-2020-social-question');
  assert.equal(await readFile(path.join(outputDirectory, '2020-csat-politics_law-question.pdf'), 'utf8'),
    '%PDF-2021-politics-question');
  const inventory = JSON.parse(await readFile(path.join(outputDirectory, 'crawl-inventory.json'), 'utf8'));
  const integrated = inventory.files.filter(({ sourceFilename }) => sourceFilename.includes('정답표'));
  assert.equal(integrated.length, 6);
  assert.ok(integrated.every(({ archiveEntry }) => archiveEntry === undefined));
});

test('collector reports a target subject missing from a social ZIP as a concrete corpus gap', async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const context = {
    boardID: '1500234', academicYear: 2025, area: '사회탐구', subject: 'social', round: 'csat',
  };
  const archive = zipFixture([
    ['사회탐구영역_사회문화_문제지.pdf', '%PDF-social-question'],
    ['사회탐구영역_경제_문제지.pdf', '%PDF-economics-question'],
  ]);

  await assert.rejects(fetchKice({
    outputDirectory,
    contexts: [context],
    delayMs: 0,
    allowPartial: true,
    log() {},
    fetchImpl: async (url) => new URL(url).pathname.endsWith('/list.do')
      ? new Response('<a title="사회탐구영역_문제지.zip" onclick="fn_fileDown(\'dddddddddddddddddddddddddddddddd\')">문제</a>')
      : new Response(archive),
  }), (error) => {
    assert.match(error.message, /탐구 ZIP 결측/u);
    assert.match(error.message, /2024-csat-politics_law-question/u);
    assert.match(error.message, /사회탐구영역_문제지\.zip/u);
    return true;
  });
});

test('collector rolls back every canonical PDF and temporary file when a social ZIP commit fails', async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const socialTarget = path.join(outputDirectory, '2024-csat-soc_culture-question.pdf');
  const politicsTarget = path.join(outputDirectory, '2024-csat-politics_law-question.pdf');
  await writeFile(socialTarget, '%PDF-old-social');
  await writeFile(politicsTarget, '%PDF-old-politics');
  const archive = zipFixture([
    ['사회탐구영역_사회문화_문제지.pdf', '%PDF-new-social'],
    ['사회탐구영역_정치와 법_문제지.pdf', '%PDF-new-politics'],
  ], { dataDescriptor: true, deflate: true });

  await assert.rejects(fetchKice({
    outputDirectory,
    contexts: [{
      boardID: '1500234', academicYear: 2025, area: '사회탐구', subject: 'social', round: 'csat',
    }],
    delayMs: 0,
    allowPartial: true,
    log() {},
    archiveFileOperations: {
      rename: async (source, target) => {
        if (source.endsWith('.tmp') && target === politicsTarget) {
          const error = new Error('injected second-target rename failure');
          error.code = 'EIO';
          throw error;
        }
        return rename(source, target);
      },
    },
    fetchImpl: async (url) => new URL(url).pathname.endsWith('/list.do')
      ? new Response('<a title="사회탐구영역_문제지.zip" onclick="fn_fileDown(\'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\')">문제</a>')
      : new Response(archive),
  }), /injected second-target rename failure/u);

  assert.equal(await readFile(socialTarget, 'utf8'), '%PDF-old-social');
  assert.equal(await readFile(politicsTarget, 'utf8'), '%PDF-old-politics');
  assert.deepEqual((await readdir(outputDirectory)).sort(), [
    '2024-csat-politics_law-question.pdf',
    '2024-csat-soc_culture-question.pdf',
  ]);
});

test('collector stops when KICE repeats the real 2024 CSAT Korean attachment page', async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const context = {
    boardID: '1500234', academicYear: 2024, area: '국어', subject: 'korean', round: 'csat',
  };
  // Reduced from the live C01=2024 Korean row: exactly one question and one answer attachment.
  const row = `
    <a title='국어영역_문제지.pdf' onclick="fn_fileDown('c1f3da47c1f3da47c1f3da47c1f3da47')">문제</a>
    <a title='국어영역_정답표.pdf' onclick="fn_fileDown('3186b86a3186b86a3186b86a3186b86a')">정답</a>
  `;
  let listCalls = 0;
  const downloads = [];
  const results = await fetchKice({
    outputDirectory,
    contexts: [context],
    delayMs: 0,
    allowPartial: true,
    log() {},
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/list.do')) {
        listCalls += 1;
        const page = parsed.searchParams.get('page');
        if (page === '1') return new Response(`<a onclick="fn_egov_link_page(3)">끝</a>${row}`);
        if (page === '2') return new Response(row);
        return new Response(`<a title='국어영역_문제지.pdf' onclick="fn_fileDown('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')">오래된 중복 행</a>`);
      }
      downloads.push(parsed.searchParams.get('fileSeq'));
      return new Response('%PDF-fixture');
    },
  });

  assert.equal(listCalls, 2);
  assert.deepEqual(downloads.sort(), [
    '3186b86a3186b86a3186b86a3186b86a',
    'c1f3da47c1f3da47c1f3da47c1f3da47',
  ].sort());
  assert.equal(results.length, 2);
});

test('collector deduplicates a revisited fileSeq across filter contexts', async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const fileSeq = 'c1f3da47c1f3da47c1f3da47c1f3da47';
  const contexts = [2024, 2025].map((academicYear) => ({
    boardID: '1500234', academicYear, area: '국어', subject: 'korean', round: 'csat',
  }));
  let downloads = 0;
  const results = await fetchKice({
    outputDirectory,
    contexts,
    delayMs: 0,
    allowPartial: true,
    log() {},
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/list.do')) {
        return new Response(`<a title='국어영역_문제지.pdf' onclick="fn_fileDown('${fileSeq}')">문제</a>`);
      }
      downloads += 1;
      return new Response('%PDF-fixture');
    },
  });

  assert.equal(results.length, 1);
  assert.equal(downloads, 1);
  assert.equal(JSON.parse(await readFile(path.join(outputDirectory, 'crawl-inventory.json'), 'utf8')).files[0].target,
    '2023-csat-korean-question.pdf');
});

test('collector stops on canonical target collisions before downloading', async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const contexts = [
    { boardID: '1500234', academicYear: 2024, area: '영어', subject: 'english', round: 'csat' },
    { boardID: '1500234', academicYear: 2024, area: '영어', subject: 'english', round: 'csat' },
  ];
  let call = 0;
  await assert.rejects(fetchKice({
    outputDirectory,
    contexts,
    delayMs: 0,
    allowPartial: true,
    log() {},
    fetchImpl: async (url) => {
      assert.ok(new URL(url).pathname.endsWith('/list.do'), 'collision must happen before download');
      call += 1;
      const seq = String(call).repeat(32);
      const filename = call === 1 ? '영어영역_문제지.pdf' : '영어영역_문제.pdf';
      return new Response(`<a title="${filename}" onclick="fn_fileDown('${seq}')">문제</a>`);
    },
  }), (error) => {
    assert.match(error.message, /서로 다른 첨부가 같은 파일명/u);
    assert.match(error.message, /영어영역_문제지\.pdf/u);
    assert.match(error.message, /영어영역_문제\.pdf/u);
    assert.match(error.message, /11111111111111111111111111111111/u);
    assert.match(error.message, /22222222222222222222222222222222/u);
    assert.match(error.message, /학년도 2024/u);
    assert.match(error.message, /회차 수능/u);
    assert.match(error.message, /영역 영어/u);
    assert.match(error.message, /boardID 1500234/u);
    return true;
  });
});

test('collector preserves atomic downloads and inventory when the completeness gate fails', async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const inventoryPath = path.join(outputDirectory, 'crawl-inventory.json');
  const context = {
    boardID: '1500236', academicYear: 2027, month: '6월', area: '영어', subject: 'english', round: '06',
  };
  let downloads = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/list.do')) {
      downloads += 1;
      return new Response('%PDF-preserved');
    }
    return new Response('<a title="영어영역_문제지.pdf" onclick="fn_fileDown(\'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\')">문제</a>');
  };
  await assert.rejects(fetchKice({
    outputDirectory,
    inventoryPath,
    contexts: [context],
    delayMs: 0,
    log() {},
    fetchImpl,
  }), /평가원 코퍼스가 불완전합니다/u);
  assert.equal(downloads, 1);
  assert.equal(await readFile(path.join(outputDirectory, '2026-06-english-question.pdf'), 'utf8'), '%PDF-preserved');
  assert.equal(JSON.parse(await readFile(inventoryPath, 'utf8')).files[0].fileSeq,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

  await assert.rejects(fetchKice({
    outputDirectory,
    inventoryPath,
    contexts: [context],
    delayMs: 0,
    log() {},
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith('/list.do')) return fetchImpl(url);
      throw new Error('preserved PDF must be skipped on retry');
    },
  }), /평가원 코퍼스가 불완전합니다/u);
  assert.equal(downloads, 1);
});

test('R2 uploader sends only changed manifest objects and persists a local hash checkpoint', async (t) => {
  const sourceDirectory = await temporaryDirectory(t);
  await mkdir(path.join(sourceDirectory, 'pdf'));
  await writeFile(path.join(sourceDirectory, 'pdf', 'paper.pdf'), '%PDF-fixture');
  const manifestPath = path.join(sourceDirectory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({ exams: [{ r2_key: 'pdf/paper.pdf' }] }));
  const statePath = path.join(sourceDirectory, '.state.json');
  const calls = [];
  const run = async (command, args) => calls.push({ command, args });

  const first = await uploadR2({
    sourceDirectory, manifestPath, statePath, bucket: 'test-bucket', executable: 'wrangler', run, log() {},
  });
  assert.deepEqual(first.uploaded, ['pdf/paper.pdf', 'manifest.json']);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ args }) => args.includes('--remote')));
  assert.ok(calls.some(({ args }) => args.includes('test-bucket/pdf/paper.pdf')));
  assert.ok(calls.at(-1).args.includes('test-bucket/manifest.json'));

  calls.length = 0;
  const second = await uploadR2({
    sourceDirectory, manifestPath, statePath, bucket: 'test-bucket', executable: 'wrangler', run, log() {},
  });
  assert.deepEqual(second.uploaded, []);
  assert.equal(calls.length, 0);

  await writeFile(manifestPath, `${await readFile(manifestPath, 'utf8')}\n`);
  const third = await uploadR2({
    sourceDirectory, manifestPath, statePath, bucket: 'test-bucket', executable: 'wrangler', run, log() {},
  });
  assert.deepEqual(third.uploaded, ['manifest.json']);
});

test('readiness accepts manifest entries that intentionally share one R2 object', async (t) => {
  const sourceDirectory = await temporaryDirectory(t);
  await writeFile(path.join(sourceDirectory, 'shared.pdf'), '%PDF-fixture');
  const manifestPath = path.join(sourceDirectory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({
    exams: [
      { id: 'shared-form-a', r2_key: 'shared.pdf' },
      { id: 'shared-form-b', r2_key: 'shared.pdf' },
    ],
  }));
  const evidencePath = path.join(sourceDirectory, 'readiness.json');

  const evidence = await verifyGichulReadiness({ manifestPath, evidencePath });

  assert.equal(evidence.exams, 2);
  assert.equal(evidence.objects, 2);
  assert.equal(Object.keys(evidence.referenced_sha256).length, 1);
  assert.equal(JSON.parse(await readFile(evidencePath, 'utf8')).objects, 2);
});

test('R2 uploader never publishes the manifest or checkpoint after a PDF upload failure', async (t) => {
  const sourceDirectory = await temporaryDirectory(t);
  await writeFile(path.join(sourceDirectory, 'paper.pdf'), '%PDF-fixture');
  const manifestPath = path.join(sourceDirectory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({ exams: [{ r2_key: 'paper.pdf' }] }));
  const statePath = path.join(sourceDirectory, '.state.json');
  const calls = [];
  await assert.rejects(uploadR2({
    sourceDirectory,
    manifestPath,
    statePath,
    executable: 'wrangler',
    log() {},
    run: async (command, args) => {
      calls.push({ command, args });
      throw new Error('injected PDF failure');
    },
  }), /injected PDF failure/u);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('hvsdcm-gichul/paper.pdf'));
  await assert.rejects(readFile(statePath, 'utf8'), /ENOENT/u);
});
