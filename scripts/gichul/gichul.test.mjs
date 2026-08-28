import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyAttachment,
  fetchKice,
  lastPageFromHtml,
  listUrl,
  parseListPage,
  validateAssignmentCoverage,
} from './fetch-kice.mjs';
import {
  buildManifest,
  detectSectionStarts,
  parseSourceFilename,
  validateCorpusManifest,
  validateManifest,
} from './build-manifest.mjs';
import { uploadR2 } from './upload-r2.mjs';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hvsdcm-gichul-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function completeCorpusFixtures() {
  const attachments = [];
  const exams = [];
  for (let academicYear = 2020; academicYear <= 2027; academicYear += 1) {
    const rounds = academicYear === 2027 ? ['06'] : ['06', '09', 'csat'];
    for (const round of rounds) {
      for (const subject of ['korean', 'math', 'english', 'soc_culture', 'politics_law']) {
        const tracks = subject === 'korean' && academicYear >= 2022
          ? ['hwajak', 'eonmae']
          : subject === 'math' && academicYear >= 2022
            ? ['hwaktong', 'mijeok', 'giha']
            : subject === 'math' ? ['ga', 'na'] : [null];
        for (const kind of ['question', 'answer']) {
          if ((subject === 'korean' || subject === 'math') && academicYear >= 2022) {
            attachments.push({ gradeYear: academicYear, round, subject, track: null, kind });
          } else if (subject === 'math' && kind === 'answer') {
            attachments.push({ gradeYear: academicYear, round, subject, track: null, kind });
          } else {
            for (const track of tracks) {
              attachments.push({ gradeYear: academicYear, round, subject, track, kind });
            }
          }
          for (const track of tracks) {
            exams.push({
              id: `${academicYear - 1}-${round}-${subject}${track ? `-${track}` : ''}-${kind}`,
            });
          }
        }
      }
    }
  }
  return { attachments, exams };
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
      '표지', '공통 1', '공통 2', '화법과 작문', '화법과 작문 문항', '언어와 매체', '언어와 매체 문항',
    ],
    '2023-09-math-question.pdf': [
      '표지', '공통', '공통', '공통', '확률과 통계', '확률과 통계 문항', '미적분', '미적분 문항', '기하', '기하 문항',
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
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), { exams });
});

test('manifest overrides can correct one section while range overlap and bounds stay fatal', async (t) => {
  const sourceDirectory = await temporaryDirectory(t);
  const file = path.join(sourceDirectory, '2023-06-korean-question.pdf');
  await writeFile(file, 'fixture');
  const pageTexts = ['표지', '공통', '공통', '화법과 작문', '선택', '언어와 매체', '선택', '선택'];
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

test('section detection prefers a standalone header over an early contents mention', () => {
  const starts = detectSectionStarts([
    '화법과 작문 또는 언어와 매체를 선택하십시오.',
    '공통 문항',
    '화법과 작문\n35번',
    '언어와 매체\n35번',
  ], [
    { track: 'hwajak', header: '화법과 작문' },
    { track: 'eonmae', header: '언어와 매체' },
  ]);
  assert.deepEqual(Object.fromEntries(starts), { hwajak: 3, eonmae: 4 });
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
    files: [{ target, fileSeq: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
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
  const pageTexts = ['표지', '공통', '공통', '화법과 작문', '선택', '언어와 매체', '선택'];
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
      return new Response(`<a title="영어영역_문제지.pdf" onclick="fn_fileDown('${seq}')">문제</a>`);
    },
  }), /서로 다른 첨부가 같은 파일명/u);
});

test('collector default mode rejects an incomplete crawl before download or inventory write', async (t) => {
  const outputDirectory = await temporaryDirectory(t);
  const inventoryPath = path.join(outputDirectory, 'crawl-inventory.json');
  const context = {
    boardID: '1500236', academicYear: 2027, month: '6월', area: '영어', subject: 'english', round: '06',
  };
  let downloads = 0;
  await assert.rejects(fetchKice({
    outputDirectory,
    inventoryPath,
    contexts: [context],
    delayMs: 0,
    log() {},
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (!parsed.pathname.endsWith('/list.do')) {
        downloads += 1;
        return new Response('%PDF-should-not-download');
      }
      return new Response('<a title="영어영역_문제지.pdf" onclick="fn_fileDown(\'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\')">문제</a>');
    },
  }), /평가원 코퍼스가 불완전합니다/u);
  assert.equal(downloads, 0);
  await assert.rejects(readFile(inventoryPath, 'utf8'), /ENOENT/u);
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
